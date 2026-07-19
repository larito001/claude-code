import type {
  ToolResultBlockParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/index.mjs'
import type { CanUseToolFn } from './hooks/useCanUseTool.js'
import { FallbackTriggeredError } from './services/api/withRetry.js'
import {
  calculateTokenWarningState,
  type AutoCompactTrackingState,
} from './services/compact/autoCompact.js'
import { buildPostCompactMessages } from './services/compact/compact.js'
import { ImageSizeError } from './utils/imageValidation.js'
import { ImageResizeError } from './utils/imageResizer.js'
import { findToolByName, type ToolUseContext } from './Tool.js'
import { asSystemPrompt, type SystemPrompt } from './utils/systemPromptType.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  RequestStartEvent,
  StreamEvent,
  ToolUseSummaryMessage,
  UserMessage,
  TombstoneMessage,
} from './types/message.js'
import { logError } from './utils/log.js'
import { PROMPT_TOO_LONG_ERROR_MESSAGE } from './services/api/errors.js'
import { logDebugError, logForDebugging } from './utils/debug.js'
import {
  createUserMessage,
  createUserInterruptionMessage,
  normalizeMessagesForAPI,
  createSystemMessage,
  createAssistantAPIErrorMessage,
  getMessagesAfterCompactBoundary,
  createToolUseSummaryMessage,
  stripSignatureBlocks,
} from './utils/messages.js'
import { generateToolUseSummary } from './services/toolUseSummary/toolUseSummaryGenerator.js'
import { prependUserContext, appendSystemContext } from './utils/api.js'
import {
  createAttachmentMessage,
  filterDuplicateMemoryAttachments,
  getAttachmentMessages,
  startRelevantMemoryPrefetch,
} from './utils/attachments.js'
import {
  remove as removeFromQueue,
  getCommandsByMaxPriority,
  isSlashCommand,
} from './utils/messageQueueManager.js'
import { notifyCommandLifecycle } from './utils/commandLifecycle.js'
import { headlessProfilerCheckpoint } from './utils/headlessProfiler.js'
import {
  getRuntimeMainLoopModel,
  renderModelName,
} from './utils/model/model.js'
import {
  doesMostRecentAssistantMessageExceed200k,
  finalContextTokensFromLastResponse,
  tokenCountWithEstimation,
} from './utils/tokens.js'
import { ESCALATED_MAX_TOKENS } from './utils/context.js'
import { getFeatureValue } from './services/featureConfig.js'
import { SLEEP_TOOL_NAME } from './tools/SleepTool/prompt.js'
import { executePostSamplingHooks } from './utils/hooks/postSamplingHooks.js'
import { executeStopFailureHooks } from './utils/hooks.js'
import type { QuerySource } from './constants/querySource.js'
import { StreamingToolExecutor } from './services/tools/StreamingToolExecutor.js'
import { queryCheckpoint } from './utils/queryProfiler.js'
import { runTools } from './services/tools/toolOrchestration.js'
import { applyToolResultBudget } from './utils/toolResultStorage.js'
import { recordContentReplacement } from './utils/sessionStorage.js'
import { handleStopHooks } from './query/stopHooks.js'
import { buildQueryConfig } from './query/config.js'
import { productionDeps, type QueryDeps } from './query/deps.js'
import type { Terminal, Continue } from './query/transitions.js'
import { feature } from 'src/utils/features.js'
import {
  getCurrentTurnTokenBudget,
  getTurnOutputTokens,
  incrementBudgetContinuationCount,
} from './bootstrap/state.js'
import { createBudgetTracker, checkTokenBudget } from './query/tokenBudget.js'
import { count } from './utils/array.js'

/** 判断未知内容是否为工具调用块。 */
function isToolUseBlock(content: unknown): content is ToolUseBlock {
  return (
    typeof content === 'object' &&
    content !== null &&
    'type' in content &&
    content.type === 'tool_use'
  )
}

/** 判断未知内容是否为带调用标识的工具结果块。 */
function isToolResultBlock(content: unknown): content is ToolResultBlockParam {
  return (
    typeof content === 'object' &&
    content !== null &&
    'type' in content &&
    content.type === 'tool_result' &&
    'tool_use_id' in content &&
    typeof content.tool_use_id === 'string'
  )
}

/** 判断未知内容是否为文本块。 */
function isTextBlock(content: unknown): content is { type: 'text'; text: string } {
  return (
    typeof content === 'object' &&
    content !== null &&
    'type' in content &&
    content.type === 'text' &&
    'text' in content &&
    typeof content.text === 'string'
  )
}

/** 执行 yield Missing Tool Result Blocks 对应的业务处理。 */
function* yieldMissingToolResultBlocks(
  assistantMessages: AssistantMessage[],
  errorMessage: string,
) {
  for (const assistantMessage of assistantMessages) {
    // 从此助手消息中提取所有工具使用块
    const toolUseBlocks = assistantMessage.message.content.filter(isToolUseBlock)

    // 每次使用工具时发出中断消息
    for (const toolUse of toolUseBlocks) {
      yield createUserMessage({
        content: [
          {
            type: 'tool_result',
            content: errorMessage,
            is_error: true,
            tool_use_id: toolUse.id,
          },
        ],
        toolUseResult: errorMessage,
        sourceToolAssistantUUID: assistantMessage.uuid,
      })
    }
  }
}

/**
 * 思维规则是漫长而偶然的。他们需要大量的思考
 * 对于巫师来说，这是最长的持续时间和最深入的冥想。
 *
 * 规则如下：
 * 1. 包含thinking或redacted_thinking块的消息必须是max_thinking_length > 0的查询的一部分
 * 2. 思考块可能不是块中的最后一条消息
 * 3. 思维块必须在辅助轨迹的持续时间内保留（单个转弯，或者如果该转弯包含 tool_use 块，则还包括其后续的 tool_result 和以下辅助消息）
 *
 * 好好遵守这些规则，年轻的巫师。因为它们是思维规则，并且
 * 思维的规则就是宇宙的规则。如果你们不注意这些
 * 按照规则，你将受到一整天的调试和拉头发的惩罚。
 */
const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3

/**
 * 这是 max_output_tokens 错误消息吗？如果是这样，流循环应该
 * 向 SDK 调用者保留它，直到我们知道恢复循环是否可以
 * 继续。产生早期泄漏会给 SDK 调用者带来中间错误（例如
 * cowork/desktop）在任何“错误”字段上终止会话 -
 * 恢复循环继续运行，但没有人在听。
 *
 * The message is withheld while the bounded recovery loop decides whether
 * the response can continue.
 */
function isWithheldMaxOutputTokens(
  msg: Message | StreamEvent | undefined,
): msg is AssistantMessage {
  return msg?.type === 'assistant' && msg.apiError === 'max_output_tokens'
}

export type QueryParams = {
  messages: Message[]
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  canUseTool: CanUseToolFn
  toolUseContext: ToolUseContext
  fallbackModel?: string
  querySource: QuerySource
  maxOutputTokensOverride?: number
  maxTurns?: number
  skipCacheWrite?: boolean
  // API task_budget（output_config.task_budget，测试版任务预算-2026-03-13）。
  // 与 tokenBudget +500k 自动继续功能不同。 “总计”是
  // 整个代理转向的预算；每次迭代都会计算“剩余”
  // 来自累计 API 使用情况。请参阅 claude.ts 中的 configureTaskBudgetParams。
  taskBudget?: { total: number }
  deps?: QueryDeps
}

// -- 查询循环状态

// 循环迭代之间携带的可变状态
type State = {
  messages: Message[]
  toolUseContext: ToolUseContext
  autoCompactTracking: AutoCompactTrackingState | undefined
  maxOutputTokensRecoveryCount: number
  maxOutputTokensOverride: number | undefined
  pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined
  stopHookActive: boolean | undefined
  turnCount: number
  // 为什么之前的迭代还要继续。第一次迭代时未定义。
  // 让测试断言已触发的恢复路径而不检查消息内容。
  transition: Continue | undefined
}

/** 执行 query 对应的业务处理。 */
export async function* query(
  params: QueryParams,
): AsyncGenerator<
  | StreamEvent
  | RequestStartEvent
  | Message
  | TombstoneMessage
  | ToolUseSummaryMessage,
  Terminal
> {
  const consumedCommandUuids: string[] = []
  const terminal = yield* queryLoop(params, consumedCommandUuids)
  // 仅当 queryLoop 正常返回时才到达。抛出时跳过（错误
  // 通过yield*) 和.return() 传播（返回完成关闭
  // 两个发电机）。这给出了相同的不对称开始-未完成
  // 当转向失败时，作为 print.ts 的排出命令队列发出信号。
  for (const uuid of consumedCommandUuids) {
    notifyCommandLifecycle(uuid, 'completed')
  }
  return terminal
}

/** 执行 query Loop 对应的业务处理。 */
async function* queryLoop(
  params: QueryParams,
  consumedCommandUuids: string[],
): AsyncGenerator<
  | StreamEvent
  | RequestStartEvent
  | Message
  | TombstoneMessage
  | ToolUseSummaryMessage,
  Terminal
> {
  // 不可变参数——在查询循环期间永远不会重新分配。
  const {
    systemPrompt,
    userContext,
    systemContext,
    canUseTool,
    fallbackModel,
    querySource,
    maxTurns,
    skipCacheWrite,
  } = params
  const deps = params.deps ?? productionDeps()

  // 可变的交叉迭代状态。循环体在顶部解构了它
  // 每次迭代的内容都保持裸名（“messages”、“toolUseContext”）。
  // 继续站点写入 `state = { ... }` 而不是 9 个单独的分配。
  let state: State = {
    messages: params.messages,
    toolUseContext: params.toolUseContext,
    maxOutputTokensOverride: params.maxOutputTokensOverride,
    autoCompactTracking: undefined,
    stopHookActive: undefined,
    maxOutputTokensRecoveryCount: 0,
    turnCount: 1,
    pendingToolUseSummary: undefined,
    transition: undefined,
  }
  const budgetTracker = feature('TOKEN_BUDGET') ? createBudgetTracker() : null

  // task_budget.remaining 跨越压缩边界的跟踪。不明确的
  // 直到第一次压缩触发——当上下文未压缩时，服务器可以
  // 查看完整的历史记录并处理 {total} 本身的倒计时（请参阅
  // api/api/sampling/prompt/renderer.py:292)。压缩后，服务器看到
  // 仅提供摘要，并且会少算支出；剩余告诉它
  // 预压缩的最终窗口已被总结。该值会跨多次压缩累计：
  // 每次都扣除当次压缩前的最终上下文触发点。
  // 使用本地循环而不写入状态，可避免修改 7 个续跑调用点。
  let taskBudgetRemaining: number | undefined = undefined

  // 进入查询时快照不可变的环境、功能配置和会话状态；具体内容及刻意排除 feature() 门控的原因见 queryConfig。
  const config = buildQueryConfig()

  // 每个用户回合触发一次 - 提示在循环迭代中保持不变，
  // 因此每次迭代都会向 sideQuery 询问相同的问题 N 次。
  // 消耗点民意调查已解决（从不阻塞）。 `using` 处理所有
  // 生成器退出路径 - 请参阅 MemoryPrefetch 了解处置/遥测语义。
  using pendingMemoryPrefetch = startRelevantMemoryPrefetch(
    state.messages,
    state.toolUseContext,
  )

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // 每次迭代顶部的解构状态。单独使用 toolUseContext
    // 在迭代中重新分配（查询跟踪、消息更新）；
    // 其余的在连续站点之间是只读的。
    let { toolUseContext } = state
    const {
      messages,
      autoCompactTracking,
      maxOutputTokensRecoveryCount,
      maxOutputTokensOverride,
      pendingToolUseSummary,
      stopHookActive,
      turnCount,
    } = state

    yield { type: 'stream_request_start' }

    queryCheckpoint('query_fn_entry')

    // 记录无头延迟跟踪的查询开始（跳过子代理）
    if (!toolUseContext.agentId) {
      headlessProfilerCheckpoint('query_started')
    }

    // 初始化或增加查询链跟踪
    const queryTracking = toolUseContext.queryTracking
      ? {
          chainId: toolUseContext.queryTracking.chainId,
          depth: toolUseContext.queryTracking.depth + 1,
        }
      : {
          chainId: deps.uuid(),
          depth: 0,
        }

    toolUseContext = {
      ...toolUseContext,
      queryTracking,
    }

    let messagesForQuery = [...getMessagesAfterCompactBoundary(messages)]

    let tracking = autoCompactTracking

    // 根据聚合工具结果大小强制执行每条消息的预算。之前运行
    // microcompact — 缓存的 MC 纯粹通过 tool_use_id 操作（从不检查
    // content），所以内容替换对它来说是不可见的，两者组成
    // 干净地。当 contentReplacementState 未定义时无操作（功能关闭）。
    // 仅保留在简历上读回记录的 querySource：agentId
    // 路由到侧链文件（AgentToolresume）或会话文件（/resume）。
    // 短暂的 runForkedAgent 调用者（agent_summary 等）不会持续存在。
    const persistReplacements =
      querySource.startsWith('agent:') ||
      querySource.startsWith('repl_main_thread')
    messagesForQuery = await applyToolResultBudget(
      messagesForQuery,
      toolUseContext.contentReplacementState,
      persistReplacements
        ? records =>
            void recordContentReplacement(
              records,
              toolUseContext.agentId,
            ).catch(logError)
        : undefined,
      new Set(
        toolUseContext.options.tools
          .filter(t => !Number.isFinite(t.maxResultSizeChars))
          .map(t => t.name),
      ),
    )

    // 在 autocompact 之前应用 microcompact
    queryCheckpoint('query_microcompact_start')
    const microcompactResult = await deps.microcompact(
      messagesForQuery,
      toolUseContext,
      querySource,
    )
    messagesForQuery = microcompactResult.messages
    queryCheckpoint('query_microcompact_end')

    const fullSystemPrompt = asSystemPrompt(
      appendSystemContext(systemPrompt, systemContext),
    )

    queryCheckpoint('query_autocompact_start')
    const { compactionResult, consecutiveFailures } = await deps.autocompact(
      messagesForQuery,
      toolUseContext,
      {
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext,
        forkContextMessages: messagesForQuery,
      },
      querySource,
      tracking,
    )
    queryCheckpoint('query_autocompact_end')

    if (compactionResult) {
      const {
        preCompactTokenCount,
        postCompactTokenCount,
        truePostCompactTokenCount,
        compactionUsage,
      } = compactionResult


      // task_budget：捕获之前的预压缩最终上下文窗口
      // messagesForQuery 被替换为下面的 postCompactMessages。
      // iterations[-1] 是权威的最终窗口（服务器后工具
      // 循环）；请参阅#304930。
      if (params.taskBudget) {
        const preCompactContext =
          finalContextTokensFromLastResponse(messagesForQuery)
        taskBudgetRemaining = Math.max(
          0,
          (taskBudgetRemaining ?? params.taskBudget.total) - preCompactContext,
        )
      }

      // 在每个紧凑型上重置，以便turnCounter/turnId反映最新的
      // 袖珍的。 recompactionInfo (autoCompact.ts:190) 已经捕获了
      // 之前的turnsSincePreviousCompact/previousCompactTurnId 的旧值
      // 呼叫，因此此重置不会丢失这些呼叫。
      tracking = {
        compacted: true,
        turnId: deps.uuid(),
        turnCounter: 0,
        consecutiveFailures: 0,
      }

      const postCompactMessages = buildPostCompactMessages(compactionResult)

      for (const message of postCompactMessages) {
        yield message
      }

      // 使用后紧凑消息继续当前查询调用
      messagesForQuery = postCompactMessages
    } else if (consecutiveFailures !== undefined) {
      // 自动压缩失败 - 传播失败计数，以便断路器
      // 可以在下一次迭代时停止重试。
      tracking = {
        ...(tracking ?? { compacted: false, turnId: '', turnCounter: 0 }),
        consecutiveFailures,
      }
    }

    //TODO：设置期间无需设置 toolUseContext.messages，因为它已在此处更新
    toolUseContext = {
      ...toolUseContext,
      messages: messagesForQuery,
    }

    const assistantMessages: AssistantMessage[] = []
    const toolResults: (UserMessage | AttachmentMessage)[] = []
    // 参见：https://docs.claude.com/en/docs/build-with-claude/tool-use
    // 注意：stop_reason === 'tool_use' 并不可靠，它不一定总能被正确设置。
    // 每当 tool_use 块到达时，在流式传输期间设置 — 唯一的
    // 循环退出信号。如果流式传输后为 false，我们就完成了（模停止挂钩重试）。
    const toolUseBlocks: ToolUseBlock[] = []
    let needsFollowUp = false

    queryCheckpoint('query_setup_start')
    const useStreamingToolExecution = config.gates.streamingToolExecution
    let streamingToolExecutor = useStreamingToolExecution
      ? new StreamingToolExecutor(
          toolUseContext.options.tools,
          canUseTool,
          toolUseContext,
        )
      : null

    const appState = toolUseContext.getAppState()
    const permissionMode = appState.toolPermissionContext.mode
    let currentModel = getRuntimeMainLoopModel({
      permissionMode,
      mainLoopModel: toolUseContext.options.mainLoopModel,
      exceeds200kTokens:
        permissionMode === 'plan' &&
        doesMostRecentAssistantMessageExceed200k(messagesForQuery),
    })

    queryCheckpoint('query_setup_end')

    // 如果达到硬阻止限制则阻止（仅适用于自动压缩关闭时）
    // 这会保留空间，以便用户仍然可以手动运行 /compact
    // 如果压缩刚刚发生，则跳过此检查 - 压缩结果已经是
    // 验证低于阈值，并且 tokenCountWithEstimation 将使用
    // 来自保留消息的陈旧 input_tokens 反映了预压缩上下文大小。
    // 还要跳过紧凑/会话内存查询——这些是分叉代理，
    // 继承完整的对话，如果在这里阻塞就会死锁（紧凑的
    // 代理需要运行以减少令牌计数）。
    if (
      !compactionResult &&
      querySource !== 'compact' &&
      querySource !== 'session_memory'
    ) {
      const { isAtBlockingLimit } = calculateTokenWarningState(
        tokenCountWithEstimation(messagesForQuery),
        toolUseContext.options.mainLoopModel,
      )
      if (isAtBlockingLimit) {
        yield createAssistantAPIErrorMessage({
          content: PROMPT_TOO_LONG_ERROR_MESSAGE,
          error: 'invalid_request',
        })
        return { reason: 'blocking_limit' }
      }
    }

    let attemptWithFallback = true

    queryCheckpoint('query_api_loop_start')
    try {
      while (attemptWithFallback) {
        attemptWithFallback = false
        try {
          let streamingFallbackOccured = false
          queryCheckpoint('query_api_streaming_start')
          for await (const message of deps.callModel({
            messages: prependUserContext(messagesForQuery, userContext),
            systemPrompt: fullSystemPrompt,
            thinkingConfig: toolUseContext.options.thinkingConfig,
            tools: toolUseContext.options.tools,
            signal: toolUseContext.abortController.signal,
            options: {
              /** 获取 get Tool Permission Context 对应的数据或状态。 */
              async getToolPermissionContext() {
                const appState = toolUseContext.getAppState()
                return appState.toolPermissionContext
              },
              model: currentModel,
              ...(config.gates.fastModeEnabled && {
                fastMode: appState.fastMode,
              }),
              toolChoice: undefined,
              isNonInteractiveSession:
                toolUseContext.options.isNonInteractiveSession,
              fallbackModel,
              /** 处理 on Streaming Fallback 对应的数据或状态。 */
              onStreamingFallback: () => {
                streamingFallbackOccured = true
              },
              querySource,
              agents: toolUseContext.options.agentDefinitions.activeAgents,
              allowedAgentTypes:
                toolUseContext.options.agentDefinitions.allowedAgentTypes,
              hasAppendSystemPrompt:
                !!toolUseContext.options.appendSystemPrompt,
              maxOutputTokensOverride,
              mcpTools: appState.mcp.tools,
              /** 判断是否满足 has Pending Mcp Servers 对应的数据或状态。 */
              hasPendingMcpServers: appState.mcp.clients.some(
                c => c.type === 'pending',
              ),
              queryTracking,
              effortValue: appState.effortValue,
              advisorModel: appState.advisorModel,
              skipCacheWrite,
              agentId: toolUseContext.agentId,
              addNotification: toolUseContext.addNotification,
              ...(params.taskBudget && {
                taskBudget: {
                  total: params.taskBudget.total,
                  ...(taskBudgetRemaining !== undefined && {
                    remaining: taskBudgetRemaining,
                  }),
                },
              }),
            },
          })) {
            // 我们不会在第一次尝试时使用 tool_calls
            // 我们可以..但是我们必须合并助理消息
            // 使用不同的 id 并将 tool_results 加倍
            if (streamingFallbackOccured) {
              // 生成孤立消息的墓碑，以便将它们从 UI 和记录中删除。
              // 这些部分消息（尤其是思维块）具有无效签名
              // 这会导致“思维块无法修改”API 错误。
              for (const msg of assistantMessages) {
                yield { type: 'tombstone' as const, message: msg }
              }

              assistantMessages.length = 0
              toolResults.length = 0
              toolUseBlocks.length = 0
              needsFollowUp = false

              // 放弃失败的流尝试的待处理结果并创建
              // 一个新的执行者。这可以防止孤立的 tool_results（使用旧的 tool_use_ids）
              // 后备响应到达后不会被屈服。
              if (streamingToolExecutor) {
                streamingToolExecutor.discard()
                streamingToolExecutor = new StreamingToolExecutor(
                  toolUseContext.options.tools,
                  canUseTool,
                  toolUseContext,
                )
              }
            }
            // 在屈服之前回填工具_使用克隆消息上的输入
            // SDK 流输出和转录序列化请参阅遗留/派生
            // 字段。原始的“消息”保持不变
            // 下面的 AssistantMessages.push — 它流回 API 并
            // 改变它会破坏提示缓存（字节不匹配）。
            let yieldMessage: typeof message = message
            if (message.type === 'assistant') {
              let clonedContent: typeof message.message.content | undefined
              for (let i = 0; i < message.message.content.length; i++) {
                const block = message.message.content[i]!
                if (
                  block.type === 'tool_use' &&
                  typeof block.input === 'object' &&
                  block.input !== null
                ) {
                  const tool = findToolByName(
                    toolUseContext.options.tools,
                    block.name,
                  )
                  if (tool?.backfillObservableInput) {
                    const originalInput = block.input as Record<string, unknown>
                    const inputCopy = { ...originalInput }
                    tool.backfillObservableInput(inputCopy)
                    // 仅在回填 ADDED 字段时生成克隆；跳过如果
                    // 它只会覆盖现有的（例如文件工具
                    // 扩展文件路径）。覆盖更改序列化
                    // 这会改变恢复记录并破坏 VCR 固定哈希，却不会为 SDK 流增加所需信息；Hook 会通过 toolExecution.ts 单独获得扩展路径。
                    const addedFields = Object.keys(inputCopy).some(
                      k => !(k in originalInput),
                    )
                    if (addedFields) {
                      clonedContent ??= [...message.message.content]
                      clonedContent[i] = { ...block, input: inputCopy }
                    }
                  }
                }
              }
              if (clonedContent) {
                yieldMessage = {
                  ...message,
                  message: { ...message.message, content: clonedContent },
                }
              }
            }
            // 保留可恢复的错误（提示太长、最大输出令牌）
            // 直到我们知道是否恢复（崩溃排水/反应
            // 紧凑/截断重试）可以成功。仍然被推到
            // AssistantMessages，以便下面的恢复检查找到它们。
            // 任一子系统的扣留就足够了——它们是
            // 独立，因此关闭一个不会破坏另一个
            // 恢复路径。
            //
            // 将实验性分类器隔离在运行时功能门控之后。
            // 树摇动约束），因此折叠检查是嵌套的
            // 而不是组成。
            const withheld = isWithheldMaxOutputTokens(message)
            if (!withheld) {
              yield yieldMessage
            }
            if (message.type === 'assistant') {
              assistantMessages.push(message)

              const msgToolUseBlocks = message.message.content.filter(isToolUseBlock)
              if (msgToolUseBlocks.length > 0) {
                toolUseBlocks.push(...msgToolUseBlocks)
                needsFollowUp = true
              }

              if (
                streamingToolExecutor &&
                !toolUseContext.abortController.signal.aborted
              ) {
                for (const toolBlock of msgToolUseBlocks) {
                  streamingToolExecutor.addTool(toolBlock, message)
                }
              }
            }

            if (
              streamingToolExecutor &&
              !toolUseContext.abortController.signal.aborted
            ) {
              for (const result of streamingToolExecutor.getCompletedResults()) {
                if (result.message) {
                  yield result.message
                  toolResults.push(
                    ...normalizeMessagesForAPI(
                      [result.message],
                      toolUseContext.options.tools,
                    ).filter(_ => _.type === 'user'),
                  )
                }
              }
            }
          }
          queryCheckpoint('query_api_streaming_end')

        } catch (innerError) {
          if (innerError instanceof FallbackTriggeredError && fallbackModel) {
            // 回退已触发 - 切换模型并重试
            currentModel = fallbackModel
            attemptWithFallback = true

            // 清除助理消息，因为我们将重试整个请求
            yield* yieldMissingToolResultBlocks(
              assistantMessages,
              'Model fallback triggered',
            )
            assistantMessages.length = 0
            toolResults.length = 0
            toolUseBlocks.length = 0
            needsFollowUp = false

            // 放弃失败尝试的待处理结果并创建
            // 新鲜的执行者。这可以防止孤立的 tool_results（旧的
            // tool_use_ids）以免泄漏到重试中。
            if (streamingToolExecutor) {
              streamingToolExecutor.discard()
              streamingToolExecutor = new StreamingToolExecutor(
                toolUseContext.options.tools,
                canUseTool,
                toolUseContext,
              )
            }

            // 使用新模型更新工具使用上下文
            toolUseContext.options.mainLoopModel = fallbackModel

            // 思维签名是模型绑定的：重放受保护的思维
            // 阻止（例如水豚）到不受保护的后备（例如 opus）400 秒。
            // 在重试之前剥离，以便后备模型获得干净的历史记录。
            messagesForQuery = stripSignatureBlocks(messagesForQuery)

            // 记录后备事件

            // 产生有关后备的系统消息 - 使用“警告”级别，以便
            // 用户无需详细模式即可看到通知
            yield createSystemMessage(
              `Switched to ${renderModelName(innerError.fallbackModel)} due to high demand for ${renderModelName(innerError.originalModel)}`,
              'warning',
            )

            continue
          }
          throw innerError
        }
      }
    } catch (error) {
      logError(error)
      const errorMessage =
        error instanceof Error ? error.message : String(error)

      // 用用户友好的消息处理图片尺寸/大小错误
      if (
        error instanceof ImageSizeError ||
        error instanceof ImageResizeError
      ) {
        yield createAssistantAPIErrorMessage({
          content: error.message,
        })
        return { reason: 'image_error' }
      }

      // 通常queryModelWithStreaming不应抛出错误，而是将其作为合成的助手消息产出。但如果因bug抛出，我们可能已经发出了tool_use块，但在发出tool_result之前停止。
      yield* yieldMissingToolResultBlocks(assistantMessages, errorMessage)

      // 展示真实错误而非误导性的"[用户中断请求]"——此路径是模型/运行时故障，非用户操作。SDK消费者曾看到虚假中断，例如Node 18缺失的Array.prototype.with()，掩盖了实际原因。
      yield createAssistantAPIErrorMessage({
        content: errorMessage,
      })

      // 为追踪bug，对ants进行大声日志记录
      logDebugError('Query error', error)
      return { reason: 'model_error', error }
    }

    // 模型响应完成后执行采样后钩子
    if (assistantMessages.length > 0) {
      void executePostSamplingHooks(
        [...messagesForQuery, ...assistantMessages],
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext,
        querySource,
      )
    }

    // 必须优先处理流式中断。使用 streamingToolExecutor 时需要消费 getRemainingResults()，使执行器能为排队中或执行中的工具生成合成 tool_result 块。
    // 如果没有这一步，tool_use 块将缺少与之匹配的 tool_result 块。
    if (toolUseContext.abortController.signal.aborted) {
      if (streamingToolExecutor) {
        // 消耗剩余结果 - 执行器为中断的工具生成合成tool_result，因为它在executeTool()中检查中断信号
        for await (const update of streamingToolExecutor.getRemainingResults()) {
          if (update.message) {
            yield update.message
          }
        }
      } else {
        yield* yieldMissingToolResultBlocks(
          assistantMessages,
          'Interrupted by user',
        )
      }
      // 跳过提交中断的中断消息——后续排队的用户消息已提供足够上下文。
      if (toolUseContext.abortController.signal.reason !== 'interrupt') {
        yield createUserInterruptionMessage({
          toolUse: false,
        })
      }
      return { reason: 'aborted_streaming' }
    }

    // 从上一轮产出工具使用摘要——Haiku（约1s）在模型流式传输期间解析（5-30s）
    if (pendingToolUseSummary) {
      const summary = await pendingToolUseSummary
      if (summary) {
        yield summary
      }
    }

    if (!needsFollowUp) {
      const lastMessage = assistantMessages.at(-1)

      // 检查max_output_tokens并注入恢复消息。该错误从流中保留，仅当恢复耗尽时才展示。
      if (isWithheldMaxOutputTokens(lastMessage)) {
        // 升级重试：如果使用上限8k默认值并达到限制，则使用64k重试相同请求——无元消息，无多轮舞蹈。每轮触发一次（由覆盖检查保护），如果64k也达到上限，则回退到多轮恢复。3P默认值：false（在Bedrock/Vertex上未验证）
        const capEnabled = getFeatureValue(
          'tengu_otk_slot_v1',
          false,
        )
        if (
          capEnabled &&
          maxOutputTokensOverride === undefined &&
          !process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
        ) {
          const next: State = {
            messages: messagesForQuery,
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount,
            maxOutputTokensOverride: ESCALATED_MAX_TOKENS,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            transition: { reason: 'max_output_tokens_escalate' },
          }
          state = next
          continue
        }

        if (maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
          const recoveryMessage = createUserMessage({
            content:
              `Output token limit hit. Resume directly — no apology, no recap of what you were doing. ` +
              `Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.`,
            isMeta: true,
          })

          const next: State = {
            messages: [
              ...messagesForQuery,
              ...assistantMessages,
              recoveryMessage,
            ],
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount: maxOutputTokensRecoveryCount + 1,
            maxOutputTokensOverride: undefined,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            transition: {
              reason: 'max_output_tokens_recovery',
              attempt: maxOutputTokensRecoveryCount + 1,
            },
          }
          state = next
          continue
        }

        // 恢复耗尽——现在展示保留的错误。
        yield lastMessage
      }

      // 当最后一条消息是API错误（速率限制、提示太长、认证失败等）时跳过停止钩子。模型从未产生真实响应——评估它的钩子会产生死亡螺旋：错误→钩子阻塞→重试→错误→……
      if (lastMessage?.isApiErrorMessage) {
        void executeStopFailureHooks(lastMessage, toolUseContext)
        return { reason: 'completed' }
      }

      const stopHookResult = yield* handleStopHooks(
        messagesForQuery,
        assistantMessages,
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext,
        querySource,
        stopHookActive,
      )

      if (stopHookResult.preventContinuation) {
        return { reason: 'stop_hook_prevented' }
      }

      if (stopHookResult.blockingErrors.length > 0) {
        const next: State = {
          messages: [
            ...messagesForQuery,
            ...assistantMessages,
            ...stopHookResult.blockingErrors,
          ],
          toolUseContext,
          autoCompactTracking: tracking,
          maxOutputTokensRecoveryCount: 0,
          maxOutputTokensOverride: undefined,
          pendingToolUseSummary: undefined,
          stopHookActive: true,
          turnCount,
          transition: { reason: 'stop_hook_blocking' },
        }
        state = next
        continue
      }

      if (feature('TOKEN_BUDGET')) {
        const decision = checkTokenBudget(
          budgetTracker!,
          toolUseContext.agentId,
          getCurrentTurnTokenBudget(),
          getTurnOutputTokens(),
        )

        if (decision.action === 'continue') {
          incrementBudgetContinuationCount()
          logForDebugging(
            `Token budget continuation #${decision.continuationCount}: ${decision.pct}% (${decision.turnTokens.toLocaleString()} / ${decision.budget.toLocaleString()})`,
          )
          state = {
            messages: [
              ...messagesForQuery,
              ...assistantMessages,
              createUserMessage({
                content: decision.nudgeMessage,
                isMeta: true,
              }),
            ],
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount: 0,
            maxOutputTokensOverride: undefined,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            transition: { reason: 'token_budget_continuation' },
          }
          continue
        }

        if (decision.completionEvent) {
          if (decision.completionEvent.diminishingReturns) {
            logForDebugging(
              `Token budget early stop: diminishing returns at ${decision.completionEvent.pct}%`,
            )
          }
        }
      }

      return { reason: 'completed' }
    }

    let shouldPreventContinuation = false
    let updatedToolUseContext = toolUseContext

    queryCheckpoint('query_tool_execution_start')


    const toolUpdates = streamingToolExecutor
      ? streamingToolExecutor.getRemainingResults()
      : runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext)

    for await (const update of toolUpdates) {
      if (update.message) {
        yield update.message

        if (
          update.message.type === 'attachment' &&
          update.message.attachment.type === 'hook_stopped_continuation'
        ) {
          shouldPreventContinuation = true
        }

        toolResults.push(
          ...normalizeMessagesForAPI(
            [update.message],
            toolUseContext.options.tools,
          ).filter(_ => _.type === 'user'),
        )
      }
      if (update.newContext) {
        updatedToolUseContext = {
          ...update.newContext,
          queryTracking,
        }
      }
    }
    queryCheckpoint('query_tool_execution_end')

    // 工具批次完成后生成工具使用摘要——传递给下一个递归调用
    let nextPendingToolUseSummary:
      | Promise<ToolUseSummaryMessage | null>
      | undefined
    if (
      config.gates.emitToolUseSummaries &&
      toolUseBlocks.length > 0 &&
      !toolUseContext.abortController.signal.aborted &&
      !toolUseContext.agentId // 子代理不在移动UI中展示——跳过Haiku调用
    ) {
      // 提取最后一条助手文本块作为上下文
      const lastAssistantMessage = assistantMessages.at(-1)
      let lastAssistantText: string | undefined
      if (lastAssistantMessage) {
        /** 执行 text Blocks 对应的业务处理。 */
        const textBlocks = lastAssistantMessage.message.content.filter(isTextBlock)
        if (textBlocks.length > 0) {
          const lastTextBlock = textBlocks.at(-1)
          if (lastTextBlock && 'text' in lastTextBlock) {
            lastAssistantText = lastTextBlock.text
          }
        }
      }

      // 收集摘要生成所需的工具信息
      /** 转换 tool Use Ids 对应的数据或状态。 */
      const toolUseIds = toolUseBlocks.map(block => block.id)
      /** 转换 tool Info For Summary 对应的数据或状态。 */
      const toolInfoForSummary = toolUseBlocks.map(block => {
        // 找到对应的工具结果
        /** 转换 tool Result 对应的数据或状态。 */
        const toolResult = toolResults.find(
          result =>
            result.type === 'user' &&
            Array.isArray(result.message.content) &&
            result.message.content.some(
              (content: unknown) =>
                isToolResultBlock(content) && content.tool_use_id === block.id,
            ),
        )
        const resultContent =
          toolResult?.type === 'user' &&
          Array.isArray(toolResult.message.content)
            ? toolResult.message.content.find(
                (content: unknown): content is ToolResultBlockParam =>
                  isToolResultBlock(content) && content.tool_use_id === block.id,
              )
            : undefined
        return {
          name: block.name,
          input: block.input,
          output:
            resultContent && 'content' in resultContent
              ? resultContent.content
              : null,
        }
      })

      // 启动摘要生成而不阻塞下一个API调用
      nextPendingToolUseSummary = generateToolUseSummary({
        tools: toolInfoForSummary,
        signal: toolUseContext.abortController.signal,
        isNonInteractiveSession: toolUseContext.options.isNonInteractiveSession,
        lastAssistantText,
      })
        .then(summary => {
          if (summary) {
            return createToolUseSummaryMessage(summary, toolUseIds)
          }
          return null
        })
        .catch(() => null)
    }

    // 我们在工具调用期间被中断
    if (toolUseContext.abortController.signal.aborted) {
      // 跳过提交中断的中断消息——后续排队的用户消息已提供足够上下文。
      if (toolUseContext.abortController.signal.reason !== 'interrupt') {
        yield createUserInterruptionMessage({
          toolUse: true,
        })
      }
      // 中断时在返回前检查maxTurns
      const nextTurnCountOnAbort = turnCount + 1
      if (maxTurns && nextTurnCountOnAbort > maxTurns) {
        yield createAttachmentMessage({
          type: 'max_turns_reached',
          maxTurns,
          turnCount: nextTurnCountOnAbort,
        })
      }
      return { reason: 'aborted_tools' }
    }

    // 如果钩子指示阻止继续，在此停止
    if (shouldPreventContinuation) {
      return { reason: 'hook_stopped' }
    }

    if (tracking?.compacted) {
      tracking.turnCounter++
    }

    // 注意在工具调用完成后执行此操作，因为如果交叉使用tool_result消息和普通用户消息，API会报错。

    // 检测：在附件前跟踪消息计数

    // 在处理附件之前获取排队的命令快照。这些将作为附件发送，以便Claude可以在当前轮次中响应它们。处理待处理的通知。Shell补全可以在当前轮次中传递；其他任务类型通过正常队列流程传递。斜杠命令被排除在轮次中间的处理之外——它们必须在轮次结束后通过processSlashCommand（通过useQueueProcessor）处理，而不是作为文本发送给模型。Bash模式命令已经被getQueuedCommandAttachments中的INLINE_NOTIFICATION_MODES排除。代理作用域：队列是一个进程全局单例，由协调器和所有进程内子代理共享。每个循环只处理发送给自己的内容——主线程处理agentId===undefined，子代理处理自己的agentId。用户提示（mode:'prompt'）仍然只发送给主线程；子代理永远不会看到提示流。eslint-disable-next-line custom-rules/require-tool-match-name -- ToolUseBlock.name没有别名
    /** 执行 sleep Ran 对应的业务处理。 */
    const sleepRan = toolUseBlocks.some(b => b.name === SLEEP_TOOL_NAME)
    const isMainThread =
      querySource.startsWith('repl_main_thread') || querySource === 'sdk'
    const currentAgentId = toolUseContext.agentId
    /** 执行 queued Commands Snapshot 对应的业务处理。 */
    const queuedCommandsSnapshot = getCommandsByMaxPriority(
      sleepRan ? 'later' : 'next',
    ).filter(cmd => {
      if (isSlashCommand(cmd)) return false
      if (isMainThread) return cmd.agentId === undefined
      // 子代理只处理发送给自己的任务通知——永远不会处理用户提示，即使有人在上面标记了agentId。
      return cmd.mode === 'task-notification' && cmd.agentId === currentAgentId
    })

    for await (const attachment of getAttachmentMessages(
      null,
      updatedToolUseContext,
      null,
      queuedCommandsSnapshot,
      [...messagesForQuery, ...assistantMessages, ...toolResults],
      querySource,
    )) {
      yield attachment
      toolResults.push(attachment)
    }

    // 内存预取消费：仅当已确定并且未在之前的迭代中已经消费过。如果尚未确定，则跳过（零等待）并在下一次迭代重试——预取在轮次结束前的循环迭代次数内获得同样多的机会。readFileState（跨迭代累积）过滤掉模型已经读取/写入/编辑过的内存——包括在早期迭代中，这是每次迭代的toolUseBlocks数组会遗漏的。
    if (
      pendingMemoryPrefetch &&
      pendingMemoryPrefetch.settledAt !== null &&
      pendingMemoryPrefetch.consumedOnIteration === -1
    ) {
      const memoryAttachments = filterDuplicateMemoryAttachments(
        await pendingMemoryPrefetch.promise,
        toolUseContext.readFileState,
      )
      for (const memAttachment of memoryAttachments) {
        const msg = createAttachmentMessage(memAttachment)
        yield msg
        toolResults.push(msg)
      }
      pendingMemoryPrefetch.consumedOnIteration = turnCount - 1
    }


    // 仅移除实际作为附件消费的命令。上面的提示和任务通知命令已转换为附件。
    /** 执行 consumed Commands 对应的业务处理。 */
    const consumedCommands = queuedCommandsSnapshot.filter(
      cmd => cmd.mode === 'prompt' || cmd.mode === 'task-notification',
    )
    if (consumedCommands.length > 0) {
      for (const cmd of consumedCommands) {
        if (cmd.uuid) {
          consumedCommandUuids.push(cmd.uuid)
          notifyCommandLifecycle(cmd.uuid, 'started')
        }
      }
      removeFromQueue(consumedCommands)
    }

    // 仪器化：在文件更改附件添加后跟踪它们
    /** 执行 file Change Attachment Count 对应的业务处理。 */
    const fileChangeAttachmentCount = count(
      toolResults,
      tr =>
        tr.type === 'attachment' && tr.attachment.type === 'edited_text_file',
    )


    // 在轮次之间刷新工具，以便新连接的MCP服务器可用
    if (updatedToolUseContext.options.refreshTools) {
      const refreshedTools = updatedToolUseContext.options.refreshTools()
      if (refreshedTools !== updatedToolUseContext.options.tools) {
        updatedToolUseContext = {
          ...updatedToolUseContext,
          options: {
            ...updatedToolUseContext.options,
            tools: refreshedTools,
          },
        }
      }
    }

    const toolUseContextWithQueryTracking = {
      ...updatedToolUseContext,
      queryTracking,
    }

    // 每次我们拥有工具结果并即将递归时，那就是一个轮次
    const nextTurnCount = turnCount + 1

    // 检查是否已达到最大轮次限制
    if (maxTurns && nextTurnCount > maxTurns) {
      yield createAttachmentMessage({
        type: 'max_turns_reached',
        maxTurns,
        turnCount: nextTurnCount,
      })
      return { reason: 'max_turns', turnCount: nextTurnCount }
    }

    queryCheckpoint('query_recursive_call')
    const next: State = {
      messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
      toolUseContext: toolUseContextWithQueryTracking,
      autoCompactTracking: tracking,
      turnCount: nextTurnCount,
      maxOutputTokensRecoveryCount: 0,
      pendingToolUseSummary: nextPendingToolUseSummary,
      maxOutputTokensOverride: undefined,
      stopHookActive,
      transition: { reason: 'next_turn' },
    }
    state = next
  } // 结束持续查询循环
}
