/** HTTP 请求常量与辅助方法。 */

import { getAnthropicApiKey } from './auth.js'
import { getRuntimeVersion } from './runtimeVersion.js'
import { getClaudeCodeUserAgent } from './userAgent.js'
import { getWorkload } from './workloadContext.js'

// 警告：日志过滤依赖 User-Agent 中的 `claude-cli`，修改时必须同步日志规则。
/** 生成模型 API 请求使用的 User-Agent。 */
export function getUserAgent(): string {
  const agentSdkVersion = process.env.CLAUDE_AGENT_SDK_VERSION
    ? `, agent-sdk/${process.env.CLAUDE_AGENT_SDK_VERSION}`
    : ''
  // SDK 使用方可通过 CLAUDE_AGENT_SDK_CLIENT_APP 标识应用或库，
  // 例如 "my-app/1.0.0" 或 "my-library/2.1"。
  const clientApp = process.env.CLAUDE_AGENT_SDK_CLIENT_APP
    ? `, client-app/${process.env.CLAUDE_AGENT_SDK_CLIENT_APP}`
    : ''
  // 定时任务发起的请求使用轮次/进程级工作负载标签。
  // getAnthropicClient 会逐请求调用本方法以读取当前工作负载状态。
  const workload = getWorkload()
  const workloadSuffix = workload ? `, workload/${workload}` : ''
  return `claude-cli/${getRuntimeVersion()} (${process.env.CLAUDE_CODE_ENTRYPOINT ?? 'cli'}${agentSdkVersion}${clientApp}${workloadSuffix})`
}

/** 生成 MCP 连接使用的 User-Agent。 */
export function getMCPUserAgent(): string {
  const parts: string[] = []
  if (process.env.CLAUDE_CODE_ENTRYPOINT) {
    parts.push(process.env.CLAUDE_CODE_ENTRYPOINT)
  }
  if (process.env.CLAUDE_AGENT_SDK_VERSION) {
    parts.push(`agent-sdk/${process.env.CLAUDE_AGENT_SDK_VERSION}`)
  }
  if (process.env.CLAUDE_AGENT_SDK_CLIENT_APP) {
    parts.push(`client-app/${process.env.CLAUDE_AGENT_SDK_CLIENT_APP}`)
  }
  const suffix = parts.length > 0 ? ` (${parts.join(', ')})` : ''
  return `claude-code/${getRuntimeVersion()}${suffix}`
}

// WebFetch 访问任意网站时使用的 User-Agent。`Claude-User` 是公开声明的
// 用户发起型抓取代理名称，站点可在 robots.txt 中匹配；后缀用于标识本地 CLI 流量。
/** 生成 WebFetch 请求使用的 User-Agent。 */
export function getWebFetchUserAgent(): string {
  return `Claude-User (${getClaudeCodeUserAgent()})`
}

export type AuthHeaders = {
  headers: Record<string, string>
  error?: string
}

/** 获取 API Key 认证标头；未配置密钥时返回可操作的错误信息。 */
export function getAuthHeaders(): AuthHeaders {
  const apiKey = getAnthropicApiKey()
  if (!apiKey) {
    return {
      headers: {},
      error: 'No API key available',
    }
  }
  return {
    headers: {
      'x-api-key': apiKey,
    },
  }
}

/** 在已由调用方处理认证的请求外包裹统一异步接口。 */
export async function withAuthRequest<T>(
  request: () => Promise<T>,
): Promise<T> {
  return request()
}
