// 提取关键系统常量以打破循环依赖

import { getFeatureValue } from '../services/featureConfig.js'
import { logForDebugging } from '../utils/debug.js'
import { isEnvDefinedFalsy } from '../utils/envUtils.js'
import { getAPIProvider } from '../utils/model/providers.js'
import { getWorkload } from '../utils/workloadContext.js'

const DEFAULT_PREFIX = `You are Claude Code, Anthropic's official CLI for Claude.`
const AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX = `You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.`
const AGENT_SDK_PREFIX = `You are a Claude agent, built on Anthropic's Claude Agent SDK.`

const CLI_SYSPROMPT_PREFIX_VALUES = [
  DEFAULT_PREFIX,
  AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX,
  AGENT_SDK_PREFIX,
] as const

export type CLISyspromptPrefix = (typeof CLI_SYSPROMPT_PREFIX_VALUES)[number]

/** 所有可能的CLI sysprompt前缀值，由splitSysPromptPrefix用于通过内容而非位置识别前缀块。 */
export const CLI_SYSPROMPT_PREFIXES: ReadonlySet<string> = new Set(
  CLI_SYSPROMPT_PREFIX_VALUES,
)

/** 获取 get CLI Sysprompt Prefix 对应的数据或状态。 */
export function getCLISyspromptPrefix(options?: {
  isNonInteractive: boolean
  hasAppendSystemPrompt: boolean
}): CLISyspromptPrefix {
  const apiProvider = getAPIProvider()
  if (apiProvider === 'vertex') {
    return DEFAULT_PREFIX
  }

  if (options?.isNonInteractive) {
    if (options.hasAppendSystemPrompt) {
      return AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX
    }
    return AGENT_SDK_PREFIX
  }
  return DEFAULT_PREFIX
}

/** 检查attribution header是否启用。默认启用，可通过环境变量或本地特性配置killswitch禁用。 */
function isAttributionHeaderEnabled(): boolean {
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_ATTRIBUTION_HEADER)) {
    return false
  }
  return getFeatureValue('tengu_attribution_header', true)
}

/**
 * 获取API请求的attribution header。返回包含cc_version（包括指纹）和cc_entrypoint的header字符串。默认启用，可通过环境变量或本地特性配置killswitch禁用。
 * 当NATIVE_CLIENT_ATTESTATION启用时，包含一个`cch=00000`占位符。在发送请求之前，Bun的原生HTTP堆栈会在请求体中找到此占位符，并用计算出的哈希覆盖零。服务器验证此令牌以确认请求来自真实的Claude Code客户端。实现见bun-anthropic/src/http/Attestation.zig。
 * 我们使用占位符（而不是从Zig注入）是因为相同长度的替换避免了Content-Length变化和缓冲区重新分配。
 */
export function getAttributionHeader(fingerprint: string): string {
  if (!isAttributionHeaderEnabled()) {
    return ''
  }

  const version = `${MACRO.VERSION}.${fingerprint}`
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? 'unknown'

  // cch=00000 占位符被 Bun 的 HTTP 栈用认证令牌覆盖
  // cc_workload: 轮次范围提示，以便 API 可以将例如 cron 发起的请求路由到较低 QoS 池。缺失时 = 交互式默认值。安全方面：指纹（仅从消息字符和版本计算，见上方第78行）和 cch 认证（在该字符串构建后，序列化主体字节中占位符被覆盖）。服务器 _parse_cc_header 容忍未知额外字段，因此旧 API 部署会静默忽略此项。
  const workload = getWorkload()
  const workloadPair = workload ? ` cc_workload=${workload};` : ''
  const header = `x-anthropic-billing-header: cc_version=${version}; cc_entrypoint=${entrypoint};${workloadPair}`

  logForDebugging(`attribution header ${header}`)
  return header
}
