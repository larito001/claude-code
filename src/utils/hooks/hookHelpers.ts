import { z } from 'zod/v4'
import type { Tool } from '../../Tool.js'
import {
  SYNTHETIC_OUTPUT_TOOL_NAME,
  SyntheticOutputTool,
} from '../../tools/SyntheticOutputTool/SyntheticOutputTool.js'
import { substituteArguments } from '../argumentSubstitution.js'
import { lazySchema } from '../lazySchema.js'
import type { SetAppState } from '../messageQueueManager.js'
import { hasSuccessfulToolCall } from '../messages.js'
import { addFunctionHook } from './sessionHooks.js'

/** 钩子响应的模式（由 prompt 和 agent 钩子共享） */
export const hookResponseSchema = lazySchema(() =>
  z.object({
    ok: z.boolean().describe('Whether the condition was met'),
    reason: z
      .string()
      .describe('Reason, if the condition was not met')
      .optional(),
  }),
)

/**
 * 将钩子输入 JSON 添加到 prompt，要么替换 $ARGUMENTS 占位符，要么追加。
 * 也支持索引参数，如 $ARGUMENTS[0]、$ARGUMENTS[1] 或简写 $0、$1 等。
 */
export function addArgumentsToPrompt(
  prompt: string,
  jsonInput: string,
): string {
  return substituteArguments(prompt, jsonInput)
}

/**
 * 创建一个为钩子响应配置的 StructuredOutput 工具。
 * 可被 agent 钩子和后台验证重用。
 */
export function createStructuredOutputTool(): Tool {
  return {
    ...SyntheticOutputTool,
    inputSchema: hookResponseSchema(),
    inputJSONSchema: {
      type: 'object',
      properties: {
        ok: {
          type: 'boolean',
          description: 'Whether the condition was met',
        },
        reason: {
          type: 'string',
          description: 'Reason, if the condition was not met',
        },
      },
      required: ['ok'],
      additionalProperties: false,
    },
    /** 执行 prompt 对应的业务处理。 */
    async prompt(): Promise<string> {
      return `Use this tool to return your verification result. You MUST call this tool exactly once at the end of your response.`
    },
  }
}

/**
 * 注册一个通过 SyntheticOutputTool 强制执行结构化输出的函数钩子。
 * 被 ask.tsx、execAgentHook.ts 和后台验证使用。
 */
export function registerStructuredOutputEnforcement(
  setAppState: SetAppState,
  sessionId: string,
): void {
  addFunctionHook(
    setAppState,
    sessionId,
    'Stop',
    '', // No matcher - applies to all stops
    messages => hasSuccessfulToolCall(messages, SYNTHETIC_OUTPUT_TOOL_NAME),
    `You MUST call the ${SYNTHETIC_OUTPUT_TOOL_NAME} tool to complete this request. Call this tool now.`,
    { timeout: 5000 },
  )
}
