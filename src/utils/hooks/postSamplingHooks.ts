import type { QuerySource } from '../../constants/querySource.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { toError } from '../errors.js'
import { logError } from '../log.js'
import type { SystemPrompt } from '../systemPromptType.js'

// 采样后钩子 - 尚未在 settings.json 配置中公开，仅以编程方式使用

// REPL 钩子的通用上下文（包括采样后钩子和停止钩子）
export type REPLHookContext = {
  messages: Message[] // 包括助手响应的完整消息历史
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  toolUseContext: ToolUseContext
  querySource?: QuerySource
}

export type PostSamplingHook = (
  context: REPLHookContext,
) => Promise<void> | void

// 采样后钩子的内部注册表
const postSamplingHooks: PostSamplingHook[] = []

/**
 * 注册一个将在模型采样完成后调用的采样后钩子
 * 这是一个内部 API，未通过设置公开
 */
export function registerPostSamplingHook(hook: PostSamplingHook): void {
  postSamplingHooks.push(hook)
}

/** 清除所有已注册的采样后钩子（用于测试） */
export function clearPostSamplingHooks(): void {
  postSamplingHooks.length = 0
}

/** 执行所有已注册的采样后钩子 */
export async function executePostSamplingHooks(
  messages: Message[],
  systemPrompt: SystemPrompt,
  userContext: { [k: string]: string },
  systemContext: { [k: string]: string },
  toolUseContext: ToolUseContext,
  querySource?: QuerySource,
): Promise<void> {
  const context: REPLHookContext = {
    messages,
    systemPrompt,
    userContext,
    systemContext,
    toolUseContext,
    querySource,
  }

  for (const hook of postSamplingHooks) {
    try {
      await hook(context)
    } catch (error) {
      // 记录钩子错误但不失败
      logError(toError(error))
    }
  }
}
