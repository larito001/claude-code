import type { NonNullableUsage } from '@anthropic-ai/claude-agent-sdk'

/**
 * 零初始化的用法对象。从 logging.ts 中提取，以便调用方无需通过导入链 api/errors.ts → utils/messages.ts → BashTool.tsx → 整个世界即可引入它。
 */
export const EMPTY_USAGE: Readonly<NonNullableUsage> = {
  input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 0,
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  service_tier: 'standard',
  cache_creation: {
    ephemeral_1h_input_tokens: 0,
    ephemeral_5m_input_tokens: 0,
  },
  inference_geo: '',
  iterations: [],
  speed: 'standard',
}
