import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getFlagSettingsInline,
  getOriginalCwd,
  getSessionTrustAccepted,
  setFlagSettingsInline,
  setOriginalCwd,
  setSessionTrustAccepted,
} from '../src/bootstrap/state.js'
import { getAnthropicClient } from '../src/services/api/client.js'
import {
  clearApiKeyHelperCache,
  getAnthropicApiKeyWithSource,
  getApiKeyFromApiKeyHelper,
} from '../src/utils/auth.js'
import {
  DEFAULT_GLOBAL_CONFIG,
  _setGlobalConfigCacheForTesting,
  enableConfigs,
  getCurrentProjectConfig,
  getGlobalConfig,
  getProjectPathForConfig,
  resetTrustDialogAcceptedCacheForTesting,
  type ProjectConfig,
} from '../src/utils/config.js'
import { runWithCwdOverride } from '../src/utils/cwd.js'
import { resetSettingsCache } from '../src/utils/settings/settingsCache.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function createBunCommand(source: string): string {
  const executable = `"${process.execPath.replaceAll('"', '\\"')}"`
  return `${executable} -e ${JSON.stringify(source)}`
}

const environmentNames = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_API_KEY_HELPER_TTL_MS',
  'CLAUDE_CODE_SIMPLE',
] as const
const originalEnvironment = new Map(
  environmentNames.map(name => [name, process.env[name]]),
)
enableConfigs()
const originalFlagSettings = getFlagSettingsInline()
const originalCwd = getOriginalCwd()
const originalSessionTrust = getSessionTrustAccepted()
const originalGlobalConfig = getGlobalConfig()
const temporaryRoot = await mkdtemp(join(tmpdir(), 'core-credentials-smoke-'))

try {
  for (const name of environmentNames) delete process.env[name]
  process.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS = '60000'

  const legacyProjectConfig = {
    allowedTools: '["Bash","Read"]',
    projectOnboardingSeenCount: 0,
  } as unknown as ProjectConfig
  _setGlobalConfigCacheForTesting({
    ...structuredClone(DEFAULT_GLOBAL_CONFIG),
    projects: { [getProjectPathForConfig()]: legacyProjectConfig },
  })
  const normalizedProjectConfig = getCurrentProjectConfig()
  assert(
    normalizedProjectConfig.allowedTools.join(',') === 'Bash,Read',
    '旧版 allowedTools 字符串未被规范化',
  )
  assert(
    typeof (legacyProjectConfig.allowedTools as unknown) === 'string',
    '读取旧版 allowedTools 时意外修改了全局配置缓存',
  )

  _setGlobalConfigCacheForTesting(structuredClone(DEFAULT_GLOBAL_CONFIG))
  const trustedHelperCommand = createBunCommand(
    "process.stdout.write('helper-smoke-key')",
  )
  setFlagSettingsInline({ apiKeyHelper: trustedHelperCommand })
  resetSettingsCache()
  clearApiKeyHelperCache()

  process.env.ANTHROPIC_API_KEY = 'environment-smoke-key'
  assert(
    getAnthropicApiKeyWithSource().source === 'ANTHROPIC_API_KEY',
    '环境变量 API Key 未取得最高优先级',
  )
  delete process.env.ANTHROPIC_API_KEY

  const skippedHelper = getAnthropicApiKeyWithSource({
    skipRetrievingKeyFromApiKeyHelper: true,
  })
  assert(
    skippedHelper.key === null && skippedHelper.source === 'apiKeyHelper',
    'API Key 助手的延迟读取来源识别失败',
  )

  const helperKey = await getApiKeyFromApiKeyHelper()
  assert(helperKey === 'helper-smoke-key', 'API Key 助手未返回标准输出中的密钥')
  assert(
    getAnthropicApiKeyWithSource().key === helperKey,
    'API Key 助手结果未进入同步缓存',
  )

  clearApiKeyHelperCache()
  const helperClient = await getAnthropicClient({ maxRetries: 0 })
  assert(
    Reflect.get(helperClient, 'apiKey') === 'helper-smoke-key',
    'API 客户端未等待 API Key 助手完成',
  )

  setFlagSettingsInline({
    apiKeyHelper: createBunCommand('process.exit(7)'),
  })
  resetSettingsCache()
  clearApiKeyHelperCache()
  const originalConsoleError = console.error
  let helperFailureWasReported = false
  console.error = () => {
    helperFailureWasReported = true
  }
  try {
    assert(
      (await getApiKeyFromApiKeyHelper()) === null,
      '失败的 API Key 助手返回了伪造密钥',
    )
    assert(
      (await getApiKeyFromApiKeyHelper()) === null,
      'API Key 助手失败缓存未阻止 TTL 内重复执行',
    )
    assert(helperFailureWasReported, 'API Key 助手失败未向用户报告')
  } finally {
    console.error = originalConsoleError
  }

  const projectRoot = join(temporaryRoot, 'project')
  const projectSettingsDirectory = join(projectRoot, '.claude')
  await mkdir(projectSettingsDirectory, { recursive: true })
  await Bun.write(
    join(projectSettingsDirectory, 'settings.json'),
    JSON.stringify({ apiKeyHelper: trustedHelperCommand }),
  )
  setOriginalCwd(projectRoot)
  setFlagSettingsInline(null)
  resetSettingsCache()
  clearApiKeyHelperCache()
  setSessionTrustAccepted(false)
  resetTrustDialogAcceptedCacheForTesting()

  await runWithCwdOverride(projectRoot, async () => {
    assert(
      (await getApiKeyFromApiKeyHelper()) === null,
      '未受信任项目执行了项目级 API Key 助手',
    )
    setSessionTrustAccepted(true)
    resetTrustDialogAcceptedCacheForTesting()
    clearApiKeyHelperCache()
    assert(
      (await getApiKeyFromApiKeyHelper()) === 'helper-smoke-key',
      '项目受信任后 API Key 助手仍被错误阻止',
    )
  })
} finally {
  clearApiKeyHelperCache()
  setFlagSettingsInline(originalFlagSettings)
  setOriginalCwd(originalCwd)
  setSessionTrustAccepted(originalSessionTrust)
  resetTrustDialogAcceptedCacheForTesting()
  resetSettingsCache()
  _setGlobalConfigCacheForTesting(originalGlobalConfig)
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await rm(temporaryRoot, { recursive: true, force: true })
}

console.log('API 凭据、设置与工作区信任冒烟测试：通过')
