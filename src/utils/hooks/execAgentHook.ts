import { randomUUID } from 'crypto'
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import { query } from '../../query.js'
import type { ToolUseContext } from '../../Tool.js'
import { type Tool, toolMatchesName } from '../../Tool.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '../../tools/SyntheticOutputTool/SyntheticOutputTool.js'
import { ALL_AGENT_DISALLOWED_TOOLS } from '../../tools.js'
import { asAgentId } from '../../types/ids.js'
import type { Message } from '../../types/message.js'
import { createAbortController } from '../abortController.js'
import { createAttachmentMessage } from '../attachments.js'
import { createCombinedAbortSignal } from '../combinedAbortSignal.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import type { HookResult } from '../hooks.js'
import { createUserMessage, handleMessageFromStream } from '../messages.js'
import { getSmallFastModel } from '../model/model.js'
import { hasPermissionsToUseTool } from '../permissions/permissions.js'
import { getAgentTranscriptPath, getTranscriptPath } from '../sessionStorage.js'
import type { AgentHook } from '../settings/types.js'
import { jsonStringify } from '../slowOperations.js'
import { asSystemPrompt } from '../systemPromptType.js'
import {
  addArgumentsToPrompt,
  createStructuredOutputTool,
  hookResponseSchema,
  registerStructuredOutputEnforcement,
} from './hookHelpers.js'
import { clearSessionHooks } from './sessionHooks.js'

/** 使用多轮LLM查询执行基于代理的钩子 */
export async function execAgentHook(
  hook: AgentHook,
  hookName: string,
  hookEvent: HookEvent,
  jsonInput: string,
  signal: AbortSignal,
  toolUseContext: ToolUseContext,
  toolUseID: string | undefined,
  // 为与其他exec*Hook函数的签名稳定性而保留。
  // 在代理钩子变为声明式之前，曾被 hook.prompt(messages) 使用。
  _messages: Message[],
  agentName?: string,
): Promise<HookResult> {
  const effectiveToolUseID = toolUseID || `hook-${randomUUID()}`

  // 从上下文中获取转录路径
  const transcriptPath = toolUseContext.agentId
    ? getAgentTranscriptPath(toolUseContext.agentId)
    : getTranscriptPath()
  const hookStartTime = Date.now()
  try {
    // 用JSON输入替换 $ARGUMENTS
    const processedPrompt = addArgumentsToPrompt(hook.prompt, jsonInput)
    logForDebugging(
      `Hooks: Processing agent hook with prompt: ${processedPrompt}`,
    )

    // 直接创建用户消息 - 无需使用 processUserInput，因为这会触发 UserPromptSubmit 钩子并导致无限递归
    const userMessage = createUserMessage({ content: processedPrompt })
    const agentMessages = [userMessage]

    logForDebugging(
      `Hooks: Starting agent query with ${agentMessages.length} messages`,
    )

    // 设置超时并与父信号合并
    const hookTimeoutMs = hook.timeout ? hook.timeout * 1000 : 60000
    const hookAbortController = createAbortController()

    // 将父信号与超时合并，并让其中止我们的控制器
    const { signal: parentTimeoutSignal, cleanup: cleanupCombinedSignal } =
      createCombinedAbortSignal(signal, { timeoutMs: hookTimeoutMs })
    /** 处理 on Parent Timeout 对应的数据或状态。 */
    const onParentTimeout = () => hookAbortController.abort()
    parentTimeoutSignal.addEventListener('abort', onParentTimeout)
    if (parentTimeoutSignal.aborted) {
      hookAbortController.abort()
    }

    // 合并后的信号现在只是我们控制器的信号
    const combinedSignal = hookAbortController.signal
    const hookAgentId = asAgentId(`hook-agent-${randomUUID()}`)
    let structuredOutputHookRegistered = false

    try {
      // 使用我们的模式创建 StructuredOutput 工具
      const structuredOutputTool = createStructuredOutputTool()

      // 过滤掉任何现有的 StructuredOutput 工具，以避免不同模式的重复
      // （例如，当父上下文有来自 --json-schema 标志的 StructuredOutput 工具时）
      const filteredTools = toolUseContext.options.tools.filter(
        tool => !toolMatchesName(tool, SYNTHETIC_OUTPUT_TOOL_NAME),
      )

      // 使用所有可用的工具加上我们的结构化输出工具
      // 过滤掉不允许的代理工具，以防止停止钩子代理产生子代理或进入计划模式，并过滤掉重复的 StructuredOutput 工具
      const tools: Tool[] = [
        ...filteredTools.filter(
          tool => !ALL_AGENT_DISALLOWED_TOOLS.has(tool.name),
        ),
        structuredOutputTool,
      ]

      const systemPrompt = asSystemPrompt([
        `You are verifying a stop condition in Claude Code. Your task is to verify that the agent completed the given plan. The conversation transcript is available at: ${transcriptPath}\nYou can read this file to analyze the conversation history if needed.

Use the available tools to inspect the codebase and verify the condition.
Use as few steps as possible - be efficient and direct.

When done, return your result using the ${SYNTHETIC_OUTPUT_TOOL_NAME} tool with:
- ok: true if the condition is met
- ok: false with reason if the condition is not met`,
      ])

      const model = hook.model ?? getSmallFastModel()
      const MAX_AGENT_TURNS = 50

      // 为代理创建一个修改后的 toolUseContext
      const agentToolUseContext: ToolUseContext = {
        ...toolUseContext,
        agentId: hookAgentId,
        abortController: hookAbortController,
        options: {
          ...toolUseContext.options,
          tools,
          mainLoopModel: model,
          isNonInteractiveSession: true,
          thinkingConfig: { type: 'disabled' as const },
        },
        /** 设置并保存 set In Progress Tool Use I Ds 对应的数据或状态。 */
        setInProgressToolUseIDs: () => {},
        /** 获取 get App State 对应的数据或状态。 */
        getAppState() {
          const appState = toolUseContext.getAppState()
          // 添加会话规则以允许读取转录文件
          const existingSessionRules =
            appState.toolPermissionContext.alwaysAllowRules.session ?? []
          return {
            ...appState,
            toolPermissionContext: {
              ...appState.toolPermissionContext,
              mode: 'dontAsk' as const,
              alwaysAllowRules: {
                ...appState.toolPermissionContext.alwaysAllowRules,
                session: [...existingSessionRules, `Read(/${transcriptPath})`],
              },
            },
          }
        },
      }

      // 注册一个会话级别的停止钩子以强制执行结构化输出
      registerStructuredOutputEnforcement(
        toolUseContext.setAppState,
        hookAgentId,
      )
      structuredOutputHookRegistered = true

      let structuredOutputResult: { ok: boolean; reason?: string } | null = null
      let turnCount = 0
      let hitMaxTurns = false

      // 对多轮执行使用 query()
      for await (const message of query({
        messages: agentMessages,
        systemPrompt,
        userContext: {},
        systemContext: {},
        canUseTool: hasPermissionsToUseTool,
        toolUseContext: agentToolUseContext,
        querySource: 'hook_agent',
      })) {
        // 处理流事件以更新旋转器中的响应长度
        handleMessageFromStream(
          message,
          () => {}, // onMessage - we handle messages below
          newContent =>
            toolUseContext.setResponseLength(
              length => length + newContent.length,
            ),
          toolUseContext.setStreamMode ?? (() => {}),
          () => {}, // onStreamingToolUses - not needed for hooks
        )

        // 跳过流事件以进行进一步处理
        if (
          message.type === 'stream_event' ||
          message.type === 'stream_request_start'
        ) {
          continue
        }

        // 计算助手轮次
        if (message.type === 'assistant') {
          turnCount++

          // 检查是否已达到轮次限制
          if (turnCount >= MAX_AGENT_TURNS) {
            hitMaxTurns = true
            logForDebugging(
              `Hooks: Agent turn ${turnCount} hit max turns, aborting`,
            )
            hookAbortController.abort()
            break
          }
        }

        // 检查附件中是否有结构化输出
        if (
          message.type === 'attachment' &&
          message.attachment.type === 'structured_output'
        ) {
          const parsed = hookResponseSchema().safeParse(message.attachment.data)
          if (parsed.success) {
            structuredOutputResult = parsed.data
            logForDebugging(
              `Hooks: Got structured output: ${jsonStringify(structuredOutputResult)}`,
            )
            // 获得结构化输出，中止并退出
            hookAbortController.abort()
            break
          }
        }
      }

      // 检查是否得到了结果
      if (!structuredOutputResult) {
        // 如果达到最大轮次，仅记录并返回已取消（无UI消息）
        if (hitMaxTurns) {
          logForDebugging(
            `Hooks: Agent hook did not complete within ${MAX_AGENT_TURNS} turns`,
          )
          return {
            hook,
            outcome: 'cancelled',
          }
        }

        // 对于其他情况（例如，代理完成而未调用结构化输出工具），
        // 仅记录并返回已取消（不向用户显示错误）
        logForDebugging(`Hooks: Agent hook did not return structured output`)
        return {
          hook,
          outcome: 'cancelled',
        }
      }

      // 根据结构化输出返回结果
      if (!structuredOutputResult.ok) {
        logForDebugging(
          `Hooks: Agent hook condition was not met: ${structuredOutputResult.reason}`,
        )
        return {
          hook,
          outcome: 'blocking',
          blockingError: {
            blockingError: `Agent hook condition was not met: ${structuredOutputResult.reason}`,
            command: hook.prompt,
          },
        }
      }

      // 条件已满足
      logForDebugging(`Hooks: Agent hook condition was met`)
      return {
        hook,
        outcome: 'success',
        message: createAttachmentMessage({
          type: 'hook_success',
          hookName,
          toolUseID: effectiveToolUseID,
          hookEvent,
          content: '',
        }),
      }
    } catch (error) {
      if (combinedSignal.aborted) {
        return {
          hook,
          outcome: 'cancelled',
        }
      }
      throw error
    } finally {
      parentTimeoutSignal.removeEventListener('abort', onParentTimeout)
      cleanupCombinedSignal()
      if (structuredOutputHookRegistered) {
        clearSessionHooks(toolUseContext.setAppState, hookAgentId)
      }
    }
  } catch (error) {
    const errorMsg = errorMessage(error)
    logForDebugging(`Hooks: Agent hook error: ${errorMsg}`)
    return {
      hook,
      outcome: 'non_blocking_error',
      message: createAttachmentMessage({
        type: 'hook_non_blocking_error',
        hookName,
        toolUseID: effectiveToolUseID,
        hookEvent,
        stderr: `Error executing agent hook: ${errorMsg}`,
        stdout: '',
        exitCode: 1,
      }),
    }
  }
}
