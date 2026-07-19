import type {
  BetaCompactionBlock,
  BetaMCPToolUseBlock,
  BetaTextBlock,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import {
  applyContentBlockDelta,
  stripExcessMediaItems,
  updateUsage,
} from '../src/services/api/claude.js'
import { getAnthropicClient } from '../src/services/api/client.js'
import { EMPTY_USAGE } from '../src/services/api/emptyUsage.js'
import { parsePromptTooLongTokenCounts } from '../src/services/api/errors.js'
import { normalizeModelStringForAPI } from '../src/utils/model/model.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const textBlock: BetaTextBlock = { type: 'text', text: '', citations: [] }
applyContentBlockDelta(textBlock, { type: 'text_delta', text: '结果' })
applyContentBlockDelta(textBlock, {
  type: 'citations_delta',
  citation: {
    type: 'char_location',
    cited_text: '来源',
    document_index: 0,
    document_title: '文档',
    file_id: null,
    start_char_index: 0,
    end_char_index: 2,
  },
})
assert(textBlock.text === '结果', '流式文本增量未正确累积')
assert(textBlock.citations?.length === 1, '流式引用增量被丢失')

const mcpToolBlock: BetaMCPToolUseBlock = {
  type: 'mcp_tool_use',
  id: 'tool-1',
  name: 'lookup',
  server_name: 'smoke',
  input: '',
}
applyContentBlockDelta(mcpToolBlock, {
  type: 'input_json_delta',
  partial_json: '{"value":',
})
applyContentBlockDelta(mcpToolBlock, {
  type: 'input_json_delta',
  partial_json: '1}',
})
assert(mcpToolBlock.input === '{"value":1}', 'MCP 工具输入增量未正确累积')

const compactionBlock: BetaCompactionBlock = {
  type: 'compaction',
  content: null,
}
applyContentBlockDelta(compactionBlock, {
  type: 'compaction_delta',
  content: '第一段',
})
applyContentBlockDelta(compactionBlock, {
  type: 'compaction_delta',
  content: '第二段',
})
assert(compactionBlock.content === '第一段第二段', '服务端压缩增量未正确累积')

const image = (data: string) => ({
  type: 'image' as const,
  source: {
    type: 'base64' as const,
    media_type: 'image/png' as const,
    data,
  },
})
const mediaMessages = [
  {
    type: 'user',
    uuid: 'old',
    message: { role: 'user', content: [image('old')] },
  },
  {
    type: 'user',
    uuid: 'nested',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result' as const,
          tool_use_id: 'tool-1',
          content: [image('nested'), { type: 'text' as const, text: '保留文本' }],
        },
      ],
    },
  },
  {
    type: 'user',
    uuid: 'new',
    message: { role: 'user', content: [image('new')] },
  },
]
const strippedMessages = stripExcessMediaItems(mediaMessages, 1)
assert(
  strippedMessages[0]?.message.content.length === 0,
  '媒体限额未移除最旧的顶层图片',
)
const nestedContent = strippedMessages[1]?.message.content[0]?.content
assert(
  Array.isArray(nestedContent) &&
    nestedContent.length === 1 &&
    nestedContent[0]?.type === 'text',
  '媒体限额未移除工具结果中的旧图片或误删了文本',
)
assert(
  strippedMessages[2]?.message.content[0]?.source.data === 'new',
  '媒体限额未保留最新图片',
)

const updatedUsage = updateUsage(
  { ...EMPTY_USAGE, input_tokens: 12, output_tokens: 1 },
  {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 9,
    server_tool_use: null,
  },
)
assert(updatedUsage.input_tokens === 12, '流式零值覆盖了已记录的输入令牌')
assert(updatedUsage.output_tokens === 9, '流式输出令牌未更新')

const promptCounts = parsePromptTooLongTokenCounts(
  'Prompt is too long: 137500 tokens > 135000 maximum',
)
assert(
  promptCounts.actualTokens === 137_500 && promptCounts.limitTokens === 135_000,
  '超长提示词令牌解析失败',
)

assert(
  normalizeModelStringForAPI('claude-opus-4-6[1m]') === 'claude-opus-4-6',
  '模型上下文标签未在 API 请求前移除',
)
const apiEnvironmentNames = [
  'ANTHROPIC_BASE_URL',
] as const
const originalEnvironment = new Map(
  apiEnvironmentNames.map(name => [name, process.env[name]]),
)

try {
  for (const name of apiEnvironmentNames) delete process.env[name]
  const directClient = await getAnthropicClient({
    apiKey: 'smoke-key',
    maxRetries: 0,
  })
  assert(
    Object.getPrototypeOf(directClient).constructor.name === 'Anthropic',
    '直接 API 客户端构造失败',
  )
} finally {
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

console.log('API 与模型执行链冒烟测试：通过')
