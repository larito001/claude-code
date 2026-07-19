import chalk from 'chalk'
import { execa } from 'execa'
import {
  checkHasTrustDialogAccepted,
} from './config.js'
import { logDebugError, logForDebugging } from './debug.js'
import {
  getFrameworkConfigHomeDir,
  isBareMode,
} from './envUtils.js'
import { errorMessage } from './errors.js'
import { execSyncWithDefaults_DEPRECATED } from './execFileNoThrow.js'
import { logError } from './log.js'
import {
  getSettings_DEPRECATED,
  getSettingsForSource,
} from './settings/settings.js'
import { jsonParse } from './slowOperations.js'

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
  const { key, source } = getAnthropicApiKeyWithSource()
  return key ? { apiKeySource: source } : {}
}
