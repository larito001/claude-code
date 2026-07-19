/**
 * 会话和代理 ID 的品牌类型。
 * 这些可以在编译时防止意外混淆会话 ID 和代理 ID。
 */

/**
 * 会话 ID 唯一标识一个 Claude Code 会话。
 * 由 getSessionId() 返回。
 */
export type SessionId = string & { readonly __brand: 'SessionId' }

/**
 * 代理 ID 唯一标识会话中的子代理。
 * 由 createAgentId() 返回。
 * 当存在时，表示上下文是一个子代理（不是主会话）。
 */
export type AgentId = string & { readonly __brand: 'AgentId' }

/**
 * 将原始字符串转换为 SessionId。
 * 谨慎使用——尽可能优先使用 getSessionId()。
 */
export function asSessionId(id: string): SessionId {
  return id as SessionId
}

/**
 * 将原始字符串转换为 AgentId。
 * 谨慎使用——尽可能优先使用 createAgentId()。
 */
export function asAgentId(id: string): AgentId {
  return id as AgentId
}

const AGENT_ID_PATTERN = /^a(?:.+-)?[0-9a-f]{16}$/

/**
 * 验证并标记字符串为 AgentId。
 * 匹配由 createAgentId() 生成的格式：`a` + 可选的 `<label>-` + 16 个十六进制字符。
 * 如果字符串不匹配（例如队友名称、团队寻址），则返回 null。
 */
export function toAgentId(s: string): AgentId | null {
  return AGENT_ID_PATTERN.test(s) ? (s as AgentId) : null
}
