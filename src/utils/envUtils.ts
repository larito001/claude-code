import memoize from 'lodash-es/memoize.js'
import { homedir } from 'os'
import { join } from 'path'

// 已记忆化：150+ 调用者，很多在热路径上。以 CLAUDE_CONFIG_DIR 为键，这样更改环境变量的测试无需显式 cache.clear 就能获得新值。
export const getClaudeConfigHomeDir = memoize(
  (): string => {
    return (
      process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
    ).normalize('NFC')
  },
  () => process.env.CLAUDE_CONFIG_DIR,
)

/** 获取 get Teams Dir 对应的数据或状态。 */
export function getTeamsDir(): string {
  return join(getClaudeConfigHomeDir(), 'teams')
}

/** 检查 NODE_OPTIONS 是否包含特定标志。按空白分割并精确匹配以避免误报。 */
export function hasNodeOption(flag: string): boolean {
  const nodeOptions = process.env.NODE_OPTIONS
  if (!nodeOptions) {
    return false
  }
  return nodeOptions.split(/\s+/).includes(flag)
}

/** 判断是否满足 is Env Truthy 对应的数据或状态。 */
export function isEnvTruthy(envVar: string | boolean | undefined): boolean {
  if (!envVar) return false
  if (typeof envVar === 'boolean') return envVar
  const normalizedValue = envVar.toLowerCase().trim()
  return ['1', 'true', 'yes', 'on'].includes(normalizedValue)
}

/** 判断是否满足 is Env Defined Falsy 对应的数据或状态。 */
export function isEnvDefinedFalsy(
  envVar: string | boolean | undefined,
): boolean {
  if (envVar === undefined) return false
  if (typeof envVar === 'boolean') return !envVar
  if (!envVar) return false
  const normalizedValue = envVar.toLowerCase().trim()
  return ['0', 'false', 'no', 'off'].includes(normalizedValue)
}

/**
 * --bare / CLAUDE_CODE_SIMPLE — 跳过 hooks、LSP、插件同步、skill 目录遍历、属性赋值、后台预取以及所有 keychain/证书读取。身份验证严格使用 ANTHROPIC_API_KEY 环境变量或来自 --settings 的 apiKeyHelper。显式 CLI 标志（--plugin-dir、--add-dir、--mcp-config）仍然有效。代码库中约 30 处开关。
 *
 * 直接检查 argv（除了环境变量外），因为多个开关在 main.tsx 的 action handler 根据 --bare 设置 CLAUDE_CODE_SIMPLE=1 之前运行——特别是 main.tsx 顶层执行的 startKeychainPrefetch()。
 */
export function isBareMode(): boolean {
  return (
    isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE) ||
    process.argv.includes('--bare')
  )
}

/**
 * 将环境变量字符串数组解析为键值对象
 * @param envVars 形式为 KEY=VALUE 的字符串数组
 * @returns 包含键值对的对象
 */
export function parseEnvVars(
  rawEnvArgs: string[] | undefined,
): Record<string, string> {
  const parsedEnv: Record<string, string> = {}

  // 解析单个环境变量
  if (rawEnvArgs) {
    for (const envStr of rawEnvArgs) {
      const [key, ...valueParts] = envStr.split('=')
      if (!key || valueParts.length === 0) {
        throw new Error(
          `Invalid environment variable format: ${envStr}, environment variables should be added as: -e KEY1=value1 -e KEY2=value2`,
        )
      }
      parsedEnv[key] = valueParts.join('=')
    }
  }
  return parsedEnv
}

/**
 * 获取 AWS 区域，回退到默认值
 * 匹配 Anthropic Bedrock SDK 的区域行为
 */
export function getAWSRegion(): string {
  return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1'
}

/** 获取默认的 Vertex AI 区域 */
export function getDefaultVertexRegion(): string {
  return process.env.CLOUD_ML_REGION || 'us-east5'
}

/**
 * 检查 bash 命令是否应维护项目工作目录（每条命令后重置为原始目录）
 * @returns 如果 CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR 设置为真值则返回 true
 */
export function shouldMaintainProjectWorkingDir(): boolean {
  return isEnvTruthy(process.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR)
}

// @[MODEL LAUNCH]: 为新模型添加一个用于 Vertex 区域覆盖的环境变量。
/** 模型前缀 → 用于 Vertex 区域覆盖的环境变量。顺序重要：更具体的前缀必须放在较不具体的前面（例如 'claude-opus-4-1' 在 'claude-opus-4' 之前）。 */
const VERTEX_REGION_OVERRIDES: ReadonlyArray<[string, string]> = [
  ['claude-haiku-4-5', 'VERTEX_REGION_CLAUDE_HAIKU_4_5'],
  ['claude-3-5-haiku', 'VERTEX_REGION_CLAUDE_3_5_HAIKU'],
  ['claude-3-5-sonnet', 'VERTEX_REGION_CLAUDE_3_5_SONNET'],
  ['claude-3-7-sonnet', 'VERTEX_REGION_CLAUDE_3_7_SONNET'],
  ['claude-opus-4-1', 'VERTEX_REGION_CLAUDE_4_1_OPUS'],
  ['claude-opus-4', 'VERTEX_REGION_CLAUDE_4_0_OPUS'],
  ['claude-sonnet-4-6', 'VERTEX_REGION_CLAUDE_4_6_SONNET'],
  ['claude-sonnet-4-5', 'VERTEX_REGION_CLAUDE_4_5_SONNET'],
  ['claude-sonnet-4', 'VERTEX_REGION_CLAUDE_4_0_SONNET'],
]

/** 获取特定模型的 Vertex AI 区域。不同模型可能在不同区域可用。 */
export function getVertexRegionForModel(
  model: string | undefined,
): string | undefined {
  if (model) {
    /** 执行 match 对应的业务处理。 */
    const match = VERTEX_REGION_OVERRIDES.find(([prefix]) =>
      model.startsWith(prefix),
    )
    if (match) {
      return process.env[match[1]] || getDefaultVertexRegion()
    }
  }
  return getDefaultVertexRegion()
}
