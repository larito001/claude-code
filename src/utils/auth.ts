import chalk from 'chalk'
import { exec } from 'child_process'
import { execa } from 'execa'
import { mkdir, stat } from 'fs/promises'
import memoize from 'lodash-es/memoize.js'
import { join } from 'path'
import { getModelStrings } from 'src/utils/model/modelStrings.js'
import { getAPIProvider } from 'src/utils/model/providers.js'
import {
  getIsNonInteractiveSession,
} from '../bootstrap/state.js'
import {
  checkStsCallerIdentity,
  clearAwsIniCache,
  isValidAwsStsOutput,
} from './aws.js'
import { AwsAuthStatusManager } from './awsAuthStatusManager.js'
import { clearBetasCaches } from './betas.js'
import {
  checkHasTrustDialogAccepted,
  getGlobalConfig,
  saveGlobalConfig,
} from './config.js'
import { logDebugError, logForDebugging } from './debug.js'
import {
  getClaudeConfigHomeDir,
  isBareMode,
  isEnvTruthy,
} from './envUtils.js'
import { errorMessage } from './errors.js'
import { execSyncWithDefaults_DEPRECATED } from './execFileNoThrow.js'
import * as lockfile from './lockfile.js'
import { logError } from './log.js'
import { memoizeWithTTLAsync } from './memoize.js'
import {
  getSettings_DEPRECATED,
  getSettingsForSource,
} from './settings/settings.js'
import { sleep } from './sleep.js'
import { jsonParse } from './slowOperations.js'
import { clearToolSchemaCache } from './toolSchemaCache.js'

/** API密钥助手缓存的默认TTL（毫秒），默认5分钟 */
const DEFAULT_API_KEY_HELPER_TTL = 5 * 60 * 1000

export type ApiKeySource = 'ANTHROPIC_API_KEY' | 'apiKeyHelper' | 'none'

/** 获取 get Anthropic Api Key 对应的数据或状态。 */
export function getAnthropicApiKey(): null | string {
  return getAnthropicApiKeyWithSource().key
}

/** 判断是否满足 has Anthropic Api Key Auth 对应的数据或状态。 */
export function hasAnthropicApiKeyAuth(): boolean {
  const { key, source } = getAnthropicApiKeyWithSource({
    skipRetrievingKeyFromApiKeyHelper: true,
  })
  return key !== null || source === 'apiKeyHelper'
}

/**
 * 按“环境变量优先、API Key 助手次之”的顺序读取密钥及来源。
 * 本方法绝不启动外部命令；API Key 助手只读取由异步预取链写入的缓存。
 */
export function getAnthropicApiKeyWithSource(
  options: { skipRetrievingKeyFromApiKeyHelper?: boolean } = {},
): {
  key: null | string
  source: ApiKeySource
} {
  const key = process.env.ANTHROPIC_API_KEY
  if (key) {
    return { key, source: 'ANTHROPIC_API_KEY' }
  }

  if (getConfiguredApiKeyHelper()) {
    return {
      key: options.skipRetrievingKeyFromApiKeyHelper
        ? null
        : getApiKeyFromApiKeyHelperCached(),
      source: 'apiKeyHelper',
    }
  }

  return { key: null, source: 'none' }
}
/** 获取 get Configured Api Key Helper 对应的数据或状态。 */
export function getConfiguredApiKeyHelper(): string | undefined {
  if (isBareMode()) {
    return getSettingsForSource('flagSettings')?.apiKeyHelper
  }
  const mergedSettings = getSettings_DEPRECATED() || {}
  return mergedSettings.apiKeyHelper
}

/** 检查配置的apiKeyHelper是否来自项目设置（projectSettings或localSettings） */
function isApiKeyHelperFromProjectOrLocalSettings(): boolean {
  const apiKeyHelper = getConfiguredApiKeyHelper()
  if (!apiKeyHelper) {
    return false
  }

  const projectSettings = getSettingsForSource('projectSettings')
  const localSettings = getSettingsForSource('localSettings')
  return (
    projectSettings?.apiKeyHelper === apiKeyHelper ||
    localSettings?.apiKeyHelper === apiKeyHelper
  )
}

/** 从设置中获取配置的awsAuthRefresh */
function getConfiguredAwsAuthRefresh(): string | undefined {
  const mergedSettings = getSettings_DEPRECATED() || {}
  return mergedSettings.awsAuthRefresh
}

/** 检查配置的awsAuthRefresh是否来自项目设置 */
export function isAwsAuthRefreshFromProjectSettings(): boolean {
  const awsAuthRefresh = getConfiguredAwsAuthRefresh()
  if (!awsAuthRefresh) {
    return false
  }

  const projectSettings = getSettingsForSource('projectSettings')
  const localSettings = getSettingsForSource('localSettings')
  return (
    projectSettings?.awsAuthRefresh === awsAuthRefresh ||
    localSettings?.awsAuthRefresh === awsAuthRefresh
  )
}

/** 从设置中获取配置的awsCredentialExport */
function getConfiguredAwsCredentialExport(): string | undefined {
  const mergedSettings = getSettings_DEPRECATED() || {}
  return mergedSettings.awsCredentialExport
}

/** 检查配置的awsCredentialExport是否来自项目设置 */
export function isAwsCredentialExportFromProjectSettings(): boolean {
  const awsCredentialExport = getConfiguredAwsCredentialExport()
  if (!awsCredentialExport) {
    return false
  }

  const projectSettings = getSettingsForSource('projectSettings')
  const localSettings = getSettingsForSource('localSettings')
  return (
    projectSettings?.awsCredentialExport === awsCredentialExport ||
    localSettings?.awsCredentialExport === awsCredentialExport
  )
}

/**
 * 计算API密钥助手缓存的TTL（毫秒）
 * 如果设置了有效的CLAUDE_CODE_API_KEY_HELPER_TTL_MS环境变量则使用，否则默认为5分钟
 */
export function calculateApiKeyHelperTTL(): number {
  const envTtl = process.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS

  if (envTtl) {
    const parsed = parseInt(envTtl, 10)
    if (!Number.isNaN(parsed) && parsed >= 0) {
      return parsed
    }
    logForDebugging(
      `Found CLAUDE_CODE_API_KEY_HELPER_TTL_MS env var, but it was not a valid number. Got ${envTtl}`,
      { level: 'error' },
    )
  }

  return DEFAULT_API_KEY_HELPER_TTL
}

// 带有同步缓存的异步API密钥助手，用于非阻塞读取。
// clearApiKeyHelperCache()会增加epoch——孤立执行会先检查其捕获的epoch，再接触模块状态，从而避免设置更改或401重试中途覆盖较新的缓存/进行中的操作。
let _apiKeyHelperCache: { value: string; timestamp: number } | null = null
let _apiKeyHelperFailureTimestamp: number | null = null
let _apiKeyHelperInflight: {
  promise: Promise<string | null>
  // 仅在冷启动时设置（用户等待）；对于SWR后台刷新则为null。
  startedAt: number | null
} | null = null
let _apiKeyHelperEpoch = 0

/** 获取 get Api Key Helper Elapsed Ms 对应的数据或状态。 */
export function getApiKeyHelperElapsedMs(): number {
  const startedAt = _apiKeyHelperInflight?.startedAt
  return startedAt ? Date.now() - startedAt : 0
}

/** 获取 get Api Key From Api Key Helper 对应的数据或状态。 */
export async function getApiKeyFromApiKeyHelper(): Promise<string | null> {
  if (!getConfiguredApiKeyHelper()) return null
  const ttl = calculateApiKeyHelperTTL()
  if (
    _apiKeyHelperFailureTimestamp !== null &&
    Date.now() - _apiKeyHelperFailureTimestamp < ttl
  ) {
    return null
  }
  if (_apiKeyHelperCache) {
    if (Date.now() - _apiKeyHelperCache.timestamp < ttl) {
      return _apiKeyHelperCache.value
    }
    // 过期——立即返回过期值，后台刷新。
    // 此处`??=`被eslint no-nullish-assign-object-call禁止（bun bug）。
    if (!_apiKeyHelperInflight) {
      _apiKeyHelperInflight = {
        promise: _runAndCache(false, _apiKeyHelperEpoch),
        startedAt: null,
      }
    }
    return _apiKeyHelperCache.value
  }
  // 冷缓存——去重并发调用
  if (_apiKeyHelperInflight) return _apiKeyHelperInflight.promise
  _apiKeyHelperInflight = {
    promise: _runAndCache(true, _apiKeyHelperEpoch),
    startedAt: Date.now(),
  }
  return _apiKeyHelperInflight.promise
}

/** 执行 run And Cache 对应的业务处理。 */
async function _runAndCache(
  isCold: boolean,
  epoch: number,
): Promise<string | null> {
  try {
    const value = await _executeApiKeyHelper()
    if (epoch !== _apiKeyHelperEpoch) return value
    if (value !== null) {
      _apiKeyHelperCache = { value, timestamp: Date.now() }
      _apiKeyHelperFailureTimestamp = null
    }
    return value
  } catch (e) {
    if (epoch !== _apiKeyHelperEpoch) return null
    const detail = e instanceof Error ? e.message : String(e)
    // biome-ignore lint/suspicious/noConsole: user-configured script failed; must be visible without --debug
    console.error(chalk.red(`apiKeyHelper failed: ${detail}`))
    logForDebugging(`Error getting API key from apiKeyHelper: ${detail}`, {
      level: 'error',
    })
    // SWR 路径：临时故障不应替换仍可用的旧密钥；更新时间戳以避免每次调用都重试。
    if (!isCold && _apiKeyHelperCache) {
      _apiKeyHelperCache = { ..._apiKeyHelperCache, timestamp: Date.now() }
      return _apiKeyHelperCache.value
    }
    // 冷启动失败只记录失败时间，不伪造密钥；TTL 到期后允许重新执行助手。
    _apiKeyHelperFailureTimestamp = Date.now()
    return null
  } finally {
    if (epoch === _apiKeyHelperEpoch) {
      _apiKeyHelperInflight = null
    }
  }
}

/** 执行 execute Api Key Helper 对应的业务处理。 */
async function _executeApiKeyHelper(): Promise<string | null> {
  const apiKeyHelper = getConfiguredApiKeyHelper()
  if (!apiKeyHelper) {
    return null
  }

  if (isApiKeyHelperFromProjectOrLocalSettings()) {
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust) {
      const error = new Error(
        'Security: apiKeyHelper was blocked because workspace trust is not confirmed.',
      )
      logDebugError('apiKeyHelper invoked before trust check', error)
      return null
    }
  }

  const result = await execa(apiKeyHelper, {
    shell: true,
    timeout: 10 * 60 * 1000,
    reject: false,
  })
  if (result.failed) {
    // reject:false — execa在退出码≠0或超时时解析，stderr在结果中
    const why = result.timedOut ? 'timed out' : `exited ${result.exitCode}`
    const stderr = result.stderr?.trim()
    throw new Error(stderr ? `${why}: ${stderr}` : why)
  }
  const stdout = result.stdout?.trim()
  if (!stdout) {
    throw new Error('did not return a value')
  }
  return stdout
}

/**
 * 同步缓存读取器——返回最近获取的apiKeyHelper值而不执行。
 * 返回过期值以匹配异步读取器的SWR语义。
 * 仅当异步获取尚未完成时返回null。
 */
export function getApiKeyFromApiKeyHelperCached(): string | null {
  return _apiKeyHelperCache?.value ?? null
}

/** 删除或清理 clear Api Key Helper Cache 对应的数据或状态。 */
export function clearApiKeyHelperCache(): void {
  _apiKeyHelperEpoch++
  _apiKeyHelperCache = null
  _apiKeyHelperFailureTimestamp = null
  _apiKeyHelperInflight = null
}

/** 执行 prefetch Api Key From Api Key Helper If Safe 对应的业务处理。 */
export function prefetchApiKeyFromApiKeyHelperIfSafe(): void {
  // 如果信任尚未接受则跳过——内部的_executeApiKeyHelper检查也会捕获此情况，但会报告误导性的凭据冲突。
  if (
    isApiKeyHelperFromProjectOrLocalSettings() &&
    !checkHasTrustDialogAccepted()
  ) {
    return
  }
  void getApiKeyFromApiKeyHelper()
}

/** 默认STS凭据有效期为一小时。我们手动管理失效，因此不太担心准确性。 */
const DEFAULT_AWS_STS_TTL = 60 * 60 * 1000

/**
 * 运行awsAuthRefresh以执行交互式认证（例如aws sso login）
 * 实时流式输出以便用户查看
 */
async function runAwsAuthRefresh(): Promise<boolean> {
  const awsAuthRefresh = getConfiguredAwsAuthRefresh()

  if (!awsAuthRefresh) {
    return false // 未配置，视为成功
  }

  // 安全：检查awsAuthRefresh是否来自项目设置
  if (isAwsAuthRefreshFromProjectSettings()) {
    // 检查此项目的信任是否已建立
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust && !getIsNonInteractiveSession()) {
      const error = new Error(
        'Security: awsAuthRefresh was blocked because workspace trust is not confirmed.',
      )
      logDebugError('awsAuthRefresh invoked before trust check', error)
      return false
    }
  }

  try {
    logForDebugging('Fetching AWS caller identity for AWS auth refresh command')
    await checkStsCallerIdentity()
    logForDebugging(
      'Fetched AWS caller identity, skipping AWS auth refresh command',
    )
    return false
  } catch {
    // 仅在调用者身份调用时才实际执行刷新
    return refreshAwsAuth(awsAuthRefresh)
  }
}

// AWS认证刷新命令的超时时间（3分钟）。
// 足够长以支持基于浏览器的SSO流程，足够短以防止无限挂起。
const AWS_AUTH_REFRESH_TIMEOUT_MS = 3 * 60 * 1000

/** 更新 refresh Aws Auth 对应的数据或状态。 */
export function refreshAwsAuth(awsAuthRefresh: string): Promise<boolean> {
  logForDebugging('Running AWS auth refresh command')
  // 开始跟踪认证状态
  const authStatusManager = AwsAuthStatusManager.getInstance()
  authStatusManager.startAuthentication()

  return new Promise(resolve => {
    const refreshProc = exec(awsAuthRefresh, {
      timeout: AWS_AUTH_REFRESH_TIMEOUT_MS,
    })
    refreshProc.stdout!.on('data', data => {
      const output = data.toString().trim()
      if (output) {
        // 将输出添加到状态管理器以用于UI显示
        authStatusManager.addOutput(output)
        // 同时记录日志用于调试
        logForDebugging(output, { level: 'debug' })
      }
    })

    refreshProc.stderr!.on('data', data => {
      const error = data.toString().trim()
      if (error) {
        authStatusManager.setError(error)
        logForDebugging(error, { level: 'error' })
      }
    })

    refreshProc.on('close', (code, signal) => {
      if (code === 0) {
        logForDebugging('AWS auth refresh completed successfully')
        authStatusManager.endAuthentication(true)
        void resolve(true)
      } else {
        const timedOut = signal === 'SIGTERM'
        const message = timedOut
          ? chalk.red(
              'AWS auth refresh timed out after 3 minutes. Run your auth command manually in a separate terminal.',
            )
          : chalk.red(
              'Error running awsAuthRefresh (in settings or ~/.claude.json):',
            )
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(message)
        authStatusManager.endAuthentication(false)
        void resolve(false)
      }
    })
  })
}

/**
 * 运行 awsCredentialExport 获取凭证并设置环境变量
 * 期望输出包含 AWS 凭证的 JSON
 */
async function getAwsCredsFromCredentialExport(): Promise<{
  accessKeyId: string
  secretAccessKey: string
  sessionToken: string
} | null> {
  const awsCredentialExport = getConfiguredAwsCredentialExport()

  if (!awsCredentialExport) {
    return null
  }

  // 安全：检查 awsCredentialExport 是否来自项目设置
  if (isAwsCredentialExportFromProjectSettings()) {
    // 检查是否已建立对此项目的信任
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust && !getIsNonInteractiveSession()) {
      const error = new Error(
        'Security: awsCredentialExport was blocked because workspace trust is not confirmed.',
      )
      logDebugError('awsCredentialExport invoked before trust check', error)
      return null
    }
  }

  try {
    logForDebugging(
      'Fetching AWS caller identity for credential export command',
    )
    await checkStsCallerIdentity()
    logForDebugging(
      'Fetched AWS caller identity, skipping AWS credential export command',
    )
    return null
  } catch {
    // 仅在 caller-identity 调用时实际执行导出
    try {
      logForDebugging('Running AWS credential export command')
      const result = await execa(awsCredentialExport, {
        shell: true,
        reject: false,
      })
      if (result.exitCode !== 0 || !result.stdout) {
        throw new Error('awsCredentialExport did not return a valid value')
      }

      // 解析来自 aws sts 命令的 JSON 输出
      const awsOutput = jsonParse(result.stdout.trim())

      if (!isValidAwsStsOutput(awsOutput)) {
        throw new Error(
          'awsCredentialExport did not return valid AWS STS output structure',
        )
      }

      logForDebugging('AWS credentials retrieved from awsCredentialExport')
      return {
        accessKeyId: awsOutput.Credentials.AccessKeyId,
        secretAccessKey: awsOutput.Credentials.SecretAccessKey,
        sessionToken: awsOutput.Credentials.SessionToken,
      }
    } catch (e) {
      const message = chalk.red(
        'Error getting AWS credentials from awsCredentialExport (in settings or ~/.claude.json):',
      )
      if (e instanceof Error) {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(message, e.message)
      } else {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(message, e)
      }
      return null
    }
  }
}

/**
 * 刷新 AWS 认证并获取凭证，同时清除缓存
 * 此操作结合了 runAwsAuthRefresh、getAwsCredsFromCredentialExport 和 clearAwsIniCache
 * 以确保始终使用新凭证
 */
export const refreshAndGetAwsCredentials = memoizeWithTTLAsync(
  async (): Promise<{
    accessKeyId: string
    secretAccessKey: string
    sessionToken: string
  } | null> => {
    // 首先根据需要运行认证刷新
    const refreshed = await runAwsAuthRefresh()

    // 从导出中获取凭证
    const credentials = await getAwsCredsFromCredentialExport()

    // 清除 AWS INI 缓存以确保使用新凭证
    if (refreshed || credentials) {
      await clearAwsIniCache()
    }

    return credentials
  },
  DEFAULT_AWS_STS_TTL,
)

/** 删除或清理 clear Aws Credentials Cache 对应的数据或状态。 */
export function clearAwsCredentialsCache(): void {
  refreshAndGetAwsCredentials.cache.clear()
}

/** 从设置中获取已配置的 gcpAuthRefresh */
function getConfiguredGcpAuthRefresh(): string | undefined {
  const mergedSettings = getSettings_DEPRECATED() || {}
  return mergedSettings.gcpAuthRefresh
}

/** 检查已配置的 gcpAuthRefresh 是否来自项目设置 */
export function isGcpAuthRefreshFromProjectSettings(): boolean {
  const gcpAuthRefresh = getConfiguredGcpAuthRefresh()
  if (!gcpAuthRefresh) {
    return false
  }

  const projectSettings = getSettingsForSource('projectSettings')
  const localSettings = getSettingsForSource('localSettings')
  return (
    projectSettings?.gcpAuthRefresh === gcpAuthRefresh ||
    localSettings?.gcpAuthRefresh === gcpAuthRefresh
  )
}

/**
 * GCP 凭证探测的超时时间较短。如果没有此设置，当不存在本地凭证源（无 ADC 文件、无环境变量）时，google-auth-library 会回退到 GCE 元数据服务器，这会在 GCP 外部挂起约 12 秒。
 */
const GCP_CREDENTIALS_CHECK_TIMEOUT_MS = 5_000

/**
 * 通过尝试获取访问令牌来检查 GCP 凭证当前是否有效。
 * 此过程使用与 Vertex SDK 相同的认证链。
 */
export async function checkGcpCredentialsValid(): Promise<boolean> {
  try {
    // 动态导入以避免不必要地加载 google-auth-library
    const { GoogleAuth } = await import('google-auth-library')
    const auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    })
    const probe = (async () => {
      const client = await auth.getClient()
      await client.getAccessToken()
    })()
    /** 执行 timeout 对应的业务处理。 */
    const timeout = sleep(GCP_CREDENTIALS_CHECK_TIMEOUT_MS).then(() => {
      throw new GcpCredentialsTimeoutError('GCP credentials check timed out')
    })
    await Promise.race([probe, timeout])
    return true
  } catch {
    return false
  }
}

/** 默认 GCP 凭证 TTL - 1 小时，以匹配典型的 ADC 令牌生命周期 */
const DEFAULT_GCP_CREDENTIAL_TTL = 60 * 60 * 1000

/**
 * 运行 gcpAuthRefresh 以执行交互式认证（例如，gcloud auth application-default login）
 * 实时流式输出以便用户查看
 */
async function runGcpAuthRefresh(): Promise<boolean> {
  const gcpAuthRefresh = getConfiguredGcpAuthRefresh()

  if (!gcpAuthRefresh) {
    return false // 未配置，视为成功
  }

  // 安全：检查 gcpAuthRefresh 是否来自项目设置
  if (isGcpAuthRefreshFromProjectSettings()) {
    // 检查是否已建立对此项目的信任
    // 传递 true 以表明这是一个需要信任的危险功能
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust && !getIsNonInteractiveSession()) {
      const error = new Error(
        'Security: gcpAuthRefresh was blocked because workspace trust is not confirmed.',
      )
      logDebugError('gcpAuthRefresh invoked before trust check', error)
      return false
    }
  }

  try {
    logForDebugging('Checking GCP credentials validity for auth refresh')
    const isValid = await checkGcpCredentialsValid()
    if (isValid) {
      logForDebugging(
        'GCP credentials are valid, skipping auth refresh command',
      )
      return false
    }
  } catch {
    // 凭据检查失败，继续刷新
  }

  return refreshGcpAuth(gcpAuthRefresh)
}

// GCP 认证刷新命令的超时时间（3 分钟）。
// 足够长以支持基于浏览器的认证流程，足够短以防止无限期挂起。
const GCP_AUTH_REFRESH_TIMEOUT_MS = 3 * 60 * 1000

/** 更新 refresh Gcp Auth 对应的数据或状态。 */
export function refreshGcpAuth(gcpAuthRefresh: string): Promise<boolean> {
  logForDebugging('Running GCP auth refresh command')
  // 开始跟踪认证状态。AwsAuthStatusManager 是云提供商无关的，尽管名称如此——print.ts 将其更新作为通用的 SDK 'auth_status' 消息发出。
  const authStatusManager = AwsAuthStatusManager.getInstance()
  authStatusManager.startAuthentication()

  return new Promise(resolve => {
    const refreshProc = exec(gcpAuthRefresh, {
      timeout: GCP_AUTH_REFRESH_TIMEOUT_MS,
    })
    refreshProc.stdout!.on('data', data => {
      const output = data.toString().trim()
      if (output) {
        // 将输出添加到状态管理器以用于UI显示
        authStatusManager.addOutput(output)
        // 同时记录以进行调试
        logForDebugging(output, { level: 'debug' })
      }
    })

    refreshProc.stderr!.on('data', data => {
      const error = data.toString().trim()
      if (error) {
        authStatusManager.setError(error)
        logForDebugging(error, { level: 'error' })
      }
    })

    refreshProc.on('close', (code, signal) => {
      if (code === 0) {
        logForDebugging('GCP auth refresh completed successfully')
        authStatusManager.endAuthentication(true)
        void resolve(true)
      } else {
        const timedOut = signal === 'SIGTERM'
        const message = timedOut
          ? chalk.red(
              'GCP auth refresh timed out after 3 minutes. Run your auth command manually in a separate terminal.',
            )
          : chalk.red(
              'Error running gcpAuthRefresh (in settings or ~/.claude.json):',
            )
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(message)
        authStatusManager.endAuthentication(false)
        void resolve(false)
      }
    })
  })
}

/**
 * 如果需要，刷新GCP身份验证。
 * 此函数检查凭据是否有效，若无效则运行刷新命令。
 * 使用TTL进行记忆化以避免过多刷新尝试。
 */
export const refreshGcpCredentialsIfNeeded = memoizeWithTTLAsync(
  async (): Promise<boolean> => {
    // 如果需要，运行身份验证刷新
    const refreshed = await runGcpAuthRefresh()
    return refreshed
  },
  DEFAULT_GCP_CREDENTIAL_TTL,
)

/** 删除或清理 clear Gcp Credentials Cache 对应的数据或状态。 */
export function clearGcpCredentialsCache(): void {
  refreshGcpCredentialsIfNeeded.cache.clear()
}

/**
 * 仅在已建立工作区信任的情况下预取GCP凭据。
 * 这使我们可以为受信任的工作区提前启动可能较慢的GCP命令，
 * 同时为不受信任的工作区保持安全。
 *
 * 返回void以防止误用——请使用refreshGcpCredentialsIfNeeded()实际刷新。
 */
export function prefetchGcpCredentialsIfSafe(): void {
  // 检查是否配置了gcpAuthRefresh
  const gcpAuthRefresh = getConfiguredGcpAuthRefresh()

  if (!gcpAuthRefresh) {
    return
  }

  // 检查gcpAuthRefresh是否来自项目设置
  if (isGcpAuthRefreshFromProjectSettings()) {
    // 仅在已建立信任的情况下预取
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust && !getIsNonInteractiveSession()) {
      // 不要预取——先等待建立信任
      return
    }
  }

  // 可以安全预取——要么不是来自项目设置，要么信任已建立
  void refreshGcpCredentialsIfNeeded()
}

/**
 * 仅在已建立工作区信任的情况下预取AWS凭据。
 * 这使我们可以为受信任的工作区提前启动可能较慢的AWS命令，
 * 同时为不受信任的工作区保持安全。
 *
 * 返回void以防止误用——请使用refreshAndGetAwsCredentials()实际检索凭据。
 */
export function prefetchAwsCredentialsAndBedRockInfoIfSafe(): void {
  // 检查是否配置了任意AWS命令
  const awsAuthRefresh = getConfiguredAwsAuthRefresh()
  const awsCredentialExport = getConfiguredAwsCredentialExport()

  if (!awsAuthRefresh && !awsCredentialExport) {
    return
  }

  // 检查任一命令是否来自项目设置
  if (
    isAwsAuthRefreshFromProjectSettings() ||
    isAwsCredentialExportFromProjectSettings()
  ) {
    // 仅在已建立信任的情况下预取
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust && !getIsNonInteractiveSession()) {
      // 不要预取——先等待建立信任
      return
    }
  }

  // 可以安全预取——要么不是来自项目设置，要么信任已建立
  void refreshAndGetAwsCredentials()
  getModelStrings()
}

/** 判断是否满足 is1 P Api Customer 对应的数据或状态。 */
export function is1PApiCustomer(): boolean {
  return !(
    isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)
  )
}

/** 检查是否使用第三方服务（Bedrock或Vertex或Foundry） */
export function isUsing3PServices(): boolean {
  return !!(
    isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)
  )
}

/** 从设置中获取已配置的otelHeadersHelper */
function getConfiguredOtelHeadersHelper(): string | undefined {
  const mergedSettings = getSettings_DEPRECATED() || {}
  return mergedSettings.otelHeadersHelper
}

/** 检查已配置的otelHeadersHelper是否来自项目设置（projectSettings或localSettings） */
export function isOtelHeadersHelperFromProjectOrLocalSettings(): boolean {
  const otelHeadersHelper = getConfiguredOtelHeadersHelper()
  if (!otelHeadersHelper) {
    return false
  }

  const projectSettings = getSettingsForSource('projectSettings')
  const localSettings = getSettingsForSource('localSettings')
  return (
    projectSettings?.otelHeadersHelper === otelHeadersHelper ||
    localSettings?.otelHeadersHelper === otelHeadersHelper
  )
}

// 用于防抖otelHeadersHelper调用的缓存
let cachedOtelHeaders: Record<string, string> | null = null
let cachedOtelHeadersTimestamp = 0
const DEFAULT_OTEL_HEADERS_DEBOUNCE_MS = 29 * 60 * 1000 // 29分钟

/** 获取 get Otel Headers From Helper 对应的数据或状态。 */
export function getOtelHeadersFromHelper(): Record<string, string> {
  const otelHeadersHelper = getConfiguredOtelHeadersHelper()

  if (!otelHeadersHelper) {
    return {}
  }

  // 如果仍然有效，返回缓存的headers（防抖）
  const debounceMs = parseInt(
    process.env.CLAUDE_CODE_OTEL_HEADERS_HELPER_DEBOUNCE_MS ||
      DEFAULT_OTEL_HEADERS_DEBOUNCE_MS.toString(),
  )
  if (
    cachedOtelHeaders &&
    Date.now() - cachedOtelHeadersTimestamp < debounceMs
  ) {
    return cachedOtelHeaders
  }

  if (isOtelHeadersHelperFromProjectOrLocalSettings()) {
    // 检查是否已为此项目建立信任
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust) {
      return {}
    }
  }

  try {
    const result = execSyncWithDefaults_DEPRECATED(otelHeadersHelper, {
      timeout: 30000, // 30 seconds - allows for auth service latency
    })
      ?.toString()
      .trim()
    if (!result) {
      throw new Error('otelHeadersHelper did not return a valid value')
    }

    const headers = jsonParse(result)
    if (
      typeof headers !== 'object' ||
      headers === null ||
      Array.isArray(headers)
    ) {
      throw new Error(
        'otelHeadersHelper must return a JSON object with string key-value pairs',
      )
    }

    // 验证所有值均为字符串
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value !== 'string') {
        throw new Error(
          `otelHeadersHelper returned non-string value for key "${key}": ${typeof value}`,
        )
      }
    }

    // 缓存结果
    cachedOtelHeaders = headers as Record<string, string>
    cachedOtelHeadersTimestamp = Date.now()

    return cachedOtelHeaders
  } catch (error) {
    logError(
      new Error(
        `Error getting OpenTelemetry headers from otelHeadersHelper (in settings): ${errorMessage(error)}`,
      ),
    )
    throw error
  }
}

export type ApiCredentialInfo = {
  apiKeySource?: ApiKeySource
}

/** 获取 get Api Credential Information 对应的数据或状态。 */
export function getApiCredentialInformation(): ApiCredentialInfo | undefined {
  if (getAPIProvider() !== 'firstParty') return undefined
  const { key, source } = getAnthropicApiKeyWithSource()
  return key ? { apiKeySource: source } : {}
}
class GcpCredentialsTimeoutError extends Error {}
