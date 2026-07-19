import { feature } from 'src/utils/features.js'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { randomUUID } from 'crypto'
import {
  getSessionId,
  isSessionPersistenceDisabled,
} from 'src/bootstrap/state.js'
import type {
  SDKCompactBoundaryMessage,
  SDKMessage,
  SDKPermissionDenial,
  SDKStatus,
  SDKUserMessageReplay,
} from 'src/entrypoints/agentSdkTypes.js'
import { toExternalPermissionMode } from './utils/permissions/PermissionMode.js'
import { accumulateUsage, updateUsage } from 'src/services/api/claude.js'
import type { NonNullableUsage } from 'src/services/api/logging.js'
import { EMPTY_USAGE } from 'src/services/api/logging.js'
import stripAnsi from 'strip-ansi'
import type { Command } from './commands.js'
import { getSlashCommandToolSkills } from './commands.js'
import {
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
} from './constants/xml.js'
import {
  getModelUsage,
  getTotalAPIDuration,
  getTotalCost,
} from './cost-tracker.js'
import type { CanUseToolFn } from './hooks/useCanUseTool.js'
import { loadMemoryPrompt } from './memdir/memdir.js'
import { hasAutoMemPathOverride } from './memdir/paths.js'
import { query } from './query.js'
import { categorizeRetryableAPIError } from './services/api/errors.js'
import type { MCPServerConnection } from './services/mcp/types.js'
import type { AppState } from './state/AppState.js'
import { type Tools, type ToolUseContext, toolMatchesName } from './Tool.js'
import type { AgentDefinition } from './tools/AgentTool/loadAgentsDir.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from './tools/SyntheticOutputTool/SyntheticOutputTool.js'
import type { Message } from './types/message.js'
import type { OrphanedPermission } from './types/textInputTypes.js'
import { createAbortController } from './utils/abortController.js'
import type { AttributionState } from './utils/commitAttribution.js'
import { getGlobalConfig } from './utils/config.js'
import { getCwd } from './utils/cwd.js'
import { isBareMode, isEnvTruthy } from './utils/envUtils.js'
import { getFastModeState } from './utils/fastMode.js'
import {
  type FileHistoryState,
  fileHistoryEnabled,
  fileHistoryMakeSnapshot,
} from './utils/fileHistory.js'
import {
  cloneFileStateCache,
  type FileStateCache,
} from './utils/fileStateCache.js'
import { headlessProfilerCheckpoint } from './utils/headlessProfiler.js'
import { registerStructuredOutputEnforcement } from './utils/hooks/hookHelpers.js'
import { getInMemoryErrors } from './utils/log.js'
import { countToolCalls, SYNTHETIC_MESSAGES } from './utils/messages.js'
import {
  getMainLoopModel,
  parseUserSpecifiedModel,
} from './utils/model/model.js'
import { loadAllPluginsCacheOnly } from './utils/plugins/pluginLoader.js'
import {
  type ProcessUserInputContext,
  processUserInput,
} from './utils/processUserInput/processUserInput.js'
import {
  fetchSystemPromptParts,
  relocateDynamicSystemPromptSections,
} from './utils/queryContext.js'
import { setCwd } from './utils/Shell.js'
import {
  flushSessionStorage,
  recordTranscript,
} from './utils/sessionStorage.js'
import { asSystemPrompt } from './utils/systemPromptType.js'
import { resolveThemeSetting } from './utils/systemTheme.js'
import {
  shouldEnableThinkingByDefault,
  type ThinkingConfig,
} from './utils/thinking.js'

type ResultCandidate = {
  type: string
  message?: { content?: unknown }
  isApiErrorMessage?: boolean
}

/** 读取未知内容块的类型标识，缺失时返回诊断占位值。 */
function getContentBlockType(content: unknown): string {
  return typeof content === 'object' &&
    content !== null &&
    'type' in content &&
    typeof content.type === 'string'
    ? content.type
    : 'none'
}

/** 判断未知内容是否为可输出的文本块。 */
function isTextContentBlock(
  content: unknown,
): content is { type: 'text'; text: string } {
  return (
    getContentBlockType(content) === 'text' &&
    typeof (content as { text?: unknown }).text === 'string'
  )
}

// 延迟加载：MessageSelector.tsx 会引入 React/Ink，仅在查询时过滤消息才需要
/* eslint-disable @typescript-eslint/no-require-imports */
/** 执行 message Selector 对应的业务处理。 */
const messageSelector =
  (): typeof import('src/components/MessageSelector.js') =>
    require('src/components/MessageSelector.js')

import {
  localCommandOutputToSDKAssistantMessage,
  toSDKCompactMetadata,
} from './utils/messages/mappers.js'
import { buildSystemInitMessage } from './utils/messages/systemInit.js'
import {
  getScratchpadDir,
  isScratchpadEnabled,
} from './utils/permissions/filesystem.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  handleOrphanedPermission,
  isResultSuccessful,
  normalizeMessage,
} from './utils/queryHelpers.js'

// 死代码消除：为协调器模式按条件导入
/* eslint-disable @typescript-eslint/no-require-imports */
const getCoordinatorUserContext: (
  mcpClients: ReadonlyArray<{ name: string }>,
  scratchpadDir?: string,
) => { [k: string]: string } = feature('COORDINATOR_MODE')
  ? require('./coordinator/coordinatorMode.js').getCoordinatorUserContext
  : () => ({})
/* eslint-enable @typescript-eslint/no-require-imports */

export type QueryEngineConfig = {
  cwd: string
  tools: Tools
  commands: Command[]
  mcpClients: MCPServerConnection[]
  agents: AgentDefinition[]
  canUseTool: CanUseToolFn
  /** 获取 get App State 对应的数据或状态。 */
  getAppState: () => AppState
  /** 设置并保存 set App State 对应的数据或状态。 */
  setAppState: (f: (prev: AppState) => AppState) => void
  initialMessages?: Message[]
  readFileCache: FileStateCache
  customSystemPrompt?: string | string[]
  appendSystemPrompt?: string
  appendSubagentSystemPrompt?: string
  excludeDynamicSections?: boolean
  userSpecifiedModel?: string
  fallbackModel?: string
  thinkingConfig?: ThinkingConfig
  maxTurns?: number
  maxBudgetUsd?: number
  taskBudget?: { total: number }
  jsonSchema?: Record<string, unknown>
  verbose?: boolean
  replayUserMessages?: boolean
  /** 处理 MCP 工具 -32042 错误触发的 URL 请求。 */
  handleElicitation?: ToolUseContext['handleElicitation']
  includePartialMessages?: boolean
  /** 设置并保存 set SDK Status 对应的数据或状态。 */
  setSDKStatus?: (status: SDKStatus) => void
  abortController?: AbortController
  orphanedPermission?: OrphanedPermission
}

/**
 * QueryEngine 管理一次对话的查询生命周期和会话状态。
 * 它从 ask() 中提取核心逻辑，形成一个独立类，供无界面/SDK 路径
 * 以及（未来阶段的）REPL 共同使用。
 *
 * 每个对话对应一个 QueryEngine。每次调用 submitMessage() 都会在同一对话中
 * 开始新一轮交互。状态（消息、文件缓存、用量等）会跨轮次保留。
 */
export class QueryEngine {
  private config: QueryEngineConfig
  private mutableMessages: Message[]
  private abortController: AbortController
  private permissionDenials: SDKPermissionDenial[]
  private totalUsage: NonNullableUsage
  private hasHandledOrphanedPermission = false
  private readFileState: FileStateCache
  private loadedNestedMemoryPaths = new Set<string>()

  /** 初始化当前实例及其必要状态。 */
  constructor(config: QueryEngineConfig) {
    this.config = config
    this.mutableMessages = config.initialMessages ?? []
    this.abortController = config.abortController ?? createAbortController()
    this.permissionDenials = []
    this.readFileState = config.readFileCache
    this.totalUsage = EMPTY_USAGE
  }

  /** 执行 submit Message 对应的业务处理。 */
  async *submitMessage(
    prompt: string | ContentBlockParam[],
    options?: { uuid?: string; isMeta?: boolean },
  ): AsyncGenerator<SDKMessage, void, unknown> {
    const {
      cwd,
      commands,
      tools,
      mcpClients,
      verbose = false,
      thinkingConfig,
      maxTurns,
      maxBudgetUsd,
      taskBudget,
      canUseTool,
      customSystemPrompt,
      appendSystemPrompt,
      appendSubagentSystemPrompt,
      excludeDynamicSections = false,
      userSpecifiedModel,
      fallbackModel,
      jsonSchema,
      getAppState,
      setAppState,
      replayUserMessages = false,
      includePartialMessages = false,
      agents = [],
      setSDKStatus,
      orphanedPermission,
    } = this.config

    setCwd(cwd)
    const persistSession = !isSessionPersistenceDisabled()
    const startTime = Date.now()

    // 包装 canUseTool，以跟踪权限拒绝情况
    const wrappedCanUseTool: CanUseToolFn = async (
      tool,
      input,
      toolUseContext,
      assistantMessage,
      toolUseID,
      forceDecision,
    ) => {
      const result = await canUseTool(
        tool,
        input,
        toolUseContext,
        assistantMessage,
        toolUseID,
        forceDecision,
      )

      // 记录拒绝情况，供 SDK 上报
      if (result.behavior !== 'allow') {
        this.permissionDenials.push({
          tool_name: tool.name,
          tool_use_id: toolUseID,
          tool_input: input,
        })
      }

      return result
    }

    const initialAppState = getAppState()
    const initialMainLoopModel = userSpecifiedModel
      ? parseUserSpecifiedModel(userSpecifiedModel)
      : getMainLoopModel()

    const initialThinkingConfig: ThinkingConfig = thinkingConfig
      ? thinkingConfig
      : shouldEnableThinkingByDefault() !== false
        ? { type: 'adaptive' }
        : { type: 'disabled' }

    headlessProfilerCheckpoint('before_getSystemPrompt')
    // 缩小一次，以便 TS 通过下面的条件跟踪类型。
    const customPromptParts =
      typeof customSystemPrompt === 'string'
        ? [customSystemPrompt]
        : customSystemPrompt
    const promptParts = await fetchSystemPromptParts({
      tools,
      mainLoopModel: initialMainLoopModel,
      additionalWorkingDirectories: Array.from(
        initialAppState.toolPermissionContext.additionalWorkingDirectories.keys(),
      ),
      mcpClients,
      customSystemPrompt,
    })
    headlessProfilerCheckpoint('after_getSystemPrompt')
    let defaultSystemPrompt = promptParts.defaultSystemPrompt
    let systemContext = promptParts.systemContext
    const userContext = {
      ...promptParts.userContext,
      ...getCoordinatorUserContext(
        mcpClients,
        isScratchpadEnabled() ? getScratchpadDir() : undefined,
      ),
    }

    // 默认提示词以边界常量分隔静态与会话动态部分。SDK 请求跨用户缓存时，
    // 将边界后的提示词和 systemContext 移到首条用户上下文消息；这样静态
    // 系统提示词保持字节稳定，同时模型仍能看到完整的工作目录和环境信息。
    if (excludeDynamicSections && customPromptParts === undefined) {
      const relocated = relocateDynamicSystemPromptSections(
        defaultSystemPrompt,
        systemContext,
      )
      defaultSystemPrompt = relocated.defaultSystemPrompt
      systemContext = relocated.systemContext
      if (relocated.relocatedContext) {
        userContext['Dynamic environment context'] = relocated.relocatedContext
      }
    }

    // 当 SDK 调用方提供自定义系统提示并已设置
    // CLAUDE_COWORK_MEMORY_PATH_OVERRIDE，注入内存机制提示。
    // 环境变量是一个显式的选择加入信号——调用者已连接
    // 一个内存目录，需要 Claude 知道如何使用它（其中
    // 编写/编辑要调用的工具、MEMORY.md 文件名、加载语义）。
    // 调用者可以通过appendSystemPrompt分层他们自己的策略文本。
    const memoryMechanicsPrompt =
      customPromptParts !== undefined && hasAutoMemPathOverride()
        ? await loadMemoryPrompt()
        : null

    const systemPrompt = asSystemPrompt([
      ...(customPromptParts ?? defaultSystemPrompt),
      ...(memoryMechanicsPrompt ? [memoryMechanicsPrompt] : []),
      ...(appendSystemPrompt ? [appendSystemPrompt] : []),
    ])

    // 注册函数钩子，以强制执行结构化输出
    const hasStructuredOutputTool = tools.some(t =>
      toolMatchesName(t, SYNTHETIC_OUTPUT_TOOL_NAME),
    )
    if (jsonSchema && hasStructuredOutputTool) {
      registerStructuredOutputEnforcement(setAppState, getSessionId())
    }

    let processUserInputContext: ProcessUserInputContext = {
      messages: this.mutableMessages,
      // 改变消息数组的斜线命令（例如 /force-snip）
      // 调用 setMessages(fn)。  在交互模式下，这会写回
      // 应用程序状态；在打印模式下，我们写回 mutableMessages，因此
      // 查询循环的其余部分（在 :389 处推送，在 :392 处快照）看到
      // 结果。  下面的第二个processUserInputContext（之后
      // 斜杠命令处理）保留无操作 - 没有其他调用
      // setMessages 超过该点。
      setMessages: fn => {
        this.mutableMessages = fn(this.mutableMessages)
      },
      /** 处理 on Change API Key 对应的数据或状态。 */
      onChangeAPIKey: () => {},
      handleElicitation: this.config.handleElicitation,
      options: {
        commands,
        debug: false, // 我们使用标准输出，所以不想破坏它
        tools,
        verbose,
        mainLoopModel: initialMainLoopModel,
        thinkingConfig: initialThinkingConfig,
        mcpClients,
        mcpResources: {},
        ideInstallationStatus: null,
        isNonInteractiveSession: true,
        customSystemPrompt: customPromptParts?.join('\n\n'),
        appendSystemPrompt,
        appendSubagentSystemPrompt,
        agentDefinitions: { activeAgents: agents, allAgents: [] },
        theme: resolveThemeSetting(getGlobalConfig().theme),
        maxBudgetUsd,
      },
      getAppState,
      setAppState,
      abortController: this.abortController,
      readFileState: this.readFileState,
      nestedMemoryAttachmentTriggers: new Set<string>(),
      loadedNestedMemoryPaths: this.loadedNestedMemoryPaths,
      dynamicSkillDirTriggers: new Set<string>(),
      /** 设置并保存 set In Progress Tool Use I Ds 对应的数据或状态。 */
      setInProgressToolUseIDs: () => {},
      /** 设置并保存 set Response Length 对应的数据或状态。 */
      setResponseLength: () => {},
      /** 更新 update File History State 对应的数据或状态。 */
      updateFileHistoryState: (
        updater: (prev: FileHistoryState) => FileHistoryState,
      ) => {
        setAppState(prev => {
          const updated = updater(prev.fileHistory)
          if (updated === prev.fileHistory) return prev
          return { ...prev, fileHistory: updated }
        })
      },
      /** 更新 update Attribution State 对应的数据或状态。 */
      updateAttributionState: (
        updater: (prev: AttributionState) => AttributionState,
      ) => {
        setAppState(prev => {
          const updated = updater(prev.attribution)
          if (updated === prev.attribution) return prev
          return { ...prev, attribution: updated }
        })
      },
      setSDKStatus,
    }

    // 处理孤立的权限请求（每个引擎生命周期仅处理一次）
    if (orphanedPermission && !this.hasHandledOrphanedPermission) {
      this.hasHandledOrphanedPermission = true
      for await (const message of handleOrphanedPermission(
        orphanedPermission,
        tools,
        this.mutableMessages,
        processUserInputContext,
      )) {
        yield message
      }
    }

    const {
      messages: messagesFromUserInput,
      shouldQuery,
      allowedTools,
      model: modelFromUserInput,
      resultText,
    } = await processUserInput({
      input: prompt,
      mode: 'prompt',
      /** 设置并保存 set Tool JSX 对应的数据或状态。 */
      setToolJSX: () => {},
      context: {
        ...processUserInputContext,
        messages: this.mutableMessages,
      },
      messages: this.mutableMessages,
      uuid: options?.uuid,
      isMeta: options?.isMeta,
      querySource: 'sdk',
    })

    // 加入新消息，包括用户输入和所有附件
    this.mutableMessages.push(...messagesFromUserInput)

    // 更新参数，以反映处理斜杠命令产生的变更
    const messages = [...this.mutableMessages]

    // 在输入查询之前保留用户的消息以转录
    // 环形。下面的 for-await 仅在 Ask() 产生时调用 recordTranscript
    // Assistant/user/compact_boundary 消息 — 直到
    // API 响应。如果进程在此之前被终止（例如用户单击
    // 发送后在 cowork 几秒钟内停止），记录仅留下
    // 队列操作条目； getLastSessionLog 过滤掉那些，返回
    // null，并且 --resume 失败并显示“未找到对话”。现在写作使
    // 文字记录可从接受用户消息时恢复，
    // 即使没有 API 响应到达。
    //
    // --bare / SIMPLE：一劳永逸。脚本调用不会 --resume after
    // 请求中终止。 SSD 上的等待时间约为 4 毫秒，磁盘争用情况下的等待时间约为 30 毫秒
    // — 模块评估后的单个最大可控关键路径成本。
    // 仍然编写成绩单（用于事后调试）；只是不阻塞。
    if (persistSession && messagesFromUserInput.length > 0) {
      const transcriptPromise = recordTranscript(messages)
      if (isBareMode()) {
        void transcriptPromise
      } else {
        await transcriptPromise
        if (
          isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
          isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
        ) {
          await flushSessionStorage()
        }
      }
    }

    // 筛选记录会话文本后应确认的消息
    const replayableMessages = messagesFromUserInput.filter(
      msg =>
        (msg.type === 'user' &&
          !msg.isMeta && // 跳过综合警告消息
          !msg.toolUseResult && // 跳过工具结果（它们将从查询中得到确认）
          messageSelector().selectableUserMessagesFilter(msg)) || // 跳过非用户编写的消息（任务通知等）
        (msg.type === 'system' && msg.subtype === 'compact_boundary'), // 始终确认紧凑边界
    )
    const messagesToAck = replayUserMessages ? replayableMessages : []

    // 根据用户输入的处理结果更新 ToolPermissionContext（如有必要）
    setAppState(prev => ({
      ...prev,
      toolPermissionContext: {
        ...prev.toolPermissionContext,
        alwaysAllowRules: {
          ...prev.toolPermissionContext.alwaysAllowRules,
          command: allowedTools,
        },
      },
    }))

    const mainLoopModel = modelFromUserInput ?? initialMainLoopModel

    // 处理提示词后重新创建，以获取更新后的消息和模型（可能由斜杠命令修改）。
    processUserInputContext = {
      messages,
      /** 设置并保存 set Messages 对应的数据或状态。 */
      setMessages: () => {},
      /** 处理 on Change API Key 对应的数据或状态。 */
      onChangeAPIKey: () => {},
      handleElicitation: this.config.handleElicitation,
      options: {
        commands,
        debug: false,
        tools,
        verbose,
        mainLoopModel,
        thinkingConfig: initialThinkingConfig,
        mcpClients,
        mcpResources: {},
        ideInstallationStatus: null,
        isNonInteractiveSession: true,
        customSystemPrompt: customPromptParts?.join('\n\n'),
        appendSystemPrompt,
        appendSubagentSystemPrompt,
        theme: resolveThemeSetting(getGlobalConfig().theme),
        agentDefinitions: { activeAgents: agents, allAgents: [] },
        maxBudgetUsd,
      },
      getAppState,
      setAppState,
      abortController: this.abortController,
      readFileState: this.readFileState,
      nestedMemoryAttachmentTriggers: new Set<string>(),
      loadedNestedMemoryPaths: this.loadedNestedMemoryPaths,
      dynamicSkillDirTriggers: new Set<string>(),
      /** 设置并保存 set In Progress Tool Use I Ds 对应的数据或状态。 */
      setInProgressToolUseIDs: () => {},
      /** 设置并保存 set Response Length 对应的数据或状态。 */
      setResponseLength: () => {},
      updateFileHistoryState: processUserInputContext.updateFileHistoryState,
      updateAttributionState: processUserInputContext.updateAttributionState,
      setSDKStatus,
    }

    headlessProfilerCheckpoint('before_skills_plugins')
    // 仅缓存：headless/SDK 启动不得在网络上阻塞。
    // 需要新源的 SDK 调用者可以调用 /reload-plugins。
    const [skills, { enabled: loadedPlugins }] = await Promise.all([
      getSlashCommandToolSkills(getCwd()),
      loadAllPluginsCacheOnly(),
    ])
    headlessProfilerCheckpoint('after_skills_plugins')

    yield buildSystemInitMessage({
      tools,
      mcpClients,
      model: mainLoopModel,
      permissionMode: toExternalPermissionMode(
        initialAppState.toolPermissionContext.mode,
      ),
      commands,
      agents,
      skills,
      plugins: loadedPlugins,
      fastMode: initialAppState.fastMode,
    })

    // 记录系统消息的产出时间，用于跟踪无界面模式的延迟
    headlessProfilerCheckpoint('system_message_yielded')

    if (!shouldQuery) {
      // 返回本地斜杠命令的结果。
      // 使用 messagesFromUserInput （不是 replayableMessages）作为命令输出
      // 因为 selectableUserMessagesFilter 排除 local-command-stdout 标签。
      for (const msg of messagesFromUserInput) {
        if (
          msg.type === 'user' &&
          typeof msg.message.content === 'string' &&
          (msg.message.content.includes(`<${LOCAL_COMMAND_STDOUT_TAG}>`) ||
            msg.message.content.includes(`<${LOCAL_COMMAND_STDERR_TAG}>`) ||
            msg.isCompactSummary)
        ) {
          yield {
            type: 'user',
            message: {
              ...msg.message,
              content: stripAnsi(msg.message.content),
            },
            session_id: getSessionId(),
            parent_tool_use_id: null,
            uuid: msg.uuid,
            timestamp: msg.timestamp,
            isReplay: !msg.isCompactSummary,
            isSynthetic: msg.isMeta || msg.isVisibleInTranscriptOnly,
          } as SDKUserMessageReplay
        }

        // 本地命令输出 — 作为合成助手消息产生，以便 RC 将其渲染为助手风格文本而非用户气泡。以助手形式（而非专用的 SDKLocalCommandOutputMessage 系统子类型）发出，以便移动客户端和 session-ingress 能够解析它。
        if (
          msg.type === 'system' &&
          msg.subtype === 'local_command' &&
          typeof msg.content === 'string' &&
          (msg.content.includes(`<${LOCAL_COMMAND_STDOUT_TAG}>`) ||
            msg.content.includes(`<${LOCAL_COMMAND_STDERR_TAG}>`))
        ) {
          yield localCommandOutputToSDKAssistantMessage(msg.content, msg.uuid)
        }

        if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
          yield {
            type: 'system',
            subtype: 'compact_boundary' as const,
            session_id: getSessionId(),
            uuid: msg.uuid,
            compact_metadata: toSDKCompactMetadata(msg.compactMetadata),
          } as SDKCompactBoundaryMessage
        }
      }

      if (persistSession) {
        await recordTranscript(messages)
        if (
          isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
          isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
        ) {
          await flushSessionStorage()
        }
      }

      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: Date.now() - startTime,
        duration_api_ms: getTotalAPIDuration(),
        num_turns: messages.length - 1,
        result: resultText ?? '',
        stop_reason: null,
        session_id: getSessionId(),
        total_cost_usd: getTotalCost(),
        usage: this.totalUsage,
        modelUsage: getModelUsage(),
        permission_denials: this.permissionDenials,
        fast_mode_state: getFastModeState(
          mainLoopModel,
          initialAppState.fastMode,
        ),
        uuid: randomUUID(),
      }
      return
    }

    if (fileHistoryEnabled() && persistSession) {
      messagesFromUserInput
        .filter(messageSelector().selectableUserMessagesFilter)
        .forEach(message => {
          void fileHistoryMakeSnapshot(
            (updater: (prev: FileHistoryState) => FileHistoryState) => {
              setAppState(prev => ({
                ...prev,
                fileHistory: updater(prev.fileHistory),
              }))
            },
            message.uuid,
          )
        })
    }

    // 跟踪当前消息的用量（每次 message_start 时重置）
    let currentMessageUsage: NonNullableUsage = EMPTY_USAGE
    let turnCount = 1
    let hasAcknowledgedInitialMessages = false
    // 跟踪 StructuredOutput 工具调用产生的结构化输出
    let structuredOutputFromTool: unknown
    // 跟踪助手消息中最后一次出现的 stop_reason
    let lastStopReason: string | null = null
    // 基于引用的水印，使得 error_during_execution 的 errors[] 是回合作用域的。基于长度的索引会在回合中 100 条目环形缓冲区执行 shift() 时失效 — 索引会滑动。如果此条目被轮换出去，lastIndexOf 返回 -1，我们包含所有内容（安全回退）。
    const errorLogWatermark = getInMemoryErrors().at(-1)
    // 此查询之前的快照计数，用于基于增量的重试限制。
    const initialStructuredOutputCalls = jsonSchema
      ? countToolCalls(this.mutableMessages, SYNTHETIC_OUTPUT_TOOL_NAME)
      : 0

    for await (const message of query({
      messages,
      systemPrompt,
      userContext,
      systemContext,
      canUseTool: wrappedCanUseTool,
      toolUseContext: processUserInputContext,
      fallbackModel,
      querySource: 'sdk',
      maxTurns,
      taskBudget,
    })) {
      // 记录助手消息、用户消息和压缩边界消息
      if (
        message.type === 'assistant' ||
        message.type === 'user' ||
        (message.type === 'system' && message.subtype === 'compact_boundary')
      ) {
        // 在写入紧凑边界之前，刷新所有仅存在于内存中的消息，直至 preservedSegment 尾部。附件和进度现在已内联记录（见下方它们的 switch 分支），但此刷新对于 preservedSegment 尾部遍历仍然重要。如果 SDK 子进程在那之前重启（claude-desktop 在回合之间终止），tailUuid 指向一个从未写入的消息 → applyPreservedSegmentRelinks 的 tail→head 遍历失败 → 无修剪返回 → 恢复时加载完整的压缩前历史。
        if (
          persistSession &&
          message.type === 'system' &&
          message.subtype === 'compact_boundary'
        ) {
          const tailUuid = message.compactMetadata?.preservedSegment?.tailUuid
          if (tailUuid) {
            /** 执行 tail Idx 对应的业务处理。 */
            const tailIdx = this.mutableMessages.findLastIndex(
              m => m.uuid === tailUuid,
            )
            if (tailIdx !== -1) {
              await recordTranscript(this.mutableMessages.slice(0, tailIdx + 1))
            }
          }
        }
        messages.push(message)
        if (persistSession) {
          // 对助手消息的即发即弃。claude.ts 每个内容块产生一条助手消息，然后在 message_delta 上修改最后一条消息的 message.usage/stop_reason — 依赖写入队列的 100ms 延迟 jsonStringify。此处等待会阻塞 ask() 的生成器，因此 message_delta 直到所有块被消费后才能运行；排水计时器（从块 1 开始）先到期。交互式 CC 不会遇到此问题，因为 useLogMessages.ts 是即发即弃的。enqueueWrite 保持顺序，因此此处即发即弃是安全的。
          if (message.type === 'assistant') {
            void recordTranscript(messages)
          } else {
            await recordTranscript(messages)
          }
        }

        // 首次记录会话文本后确认初始用户消息
        if (!hasAcknowledgedInitialMessages && messagesToAck.length > 0) {
          hasAcknowledgedInitialMessages = true
          for (const msgToAck of messagesToAck) {
            if (msgToAck.type === 'user') {
              yield {
                type: 'user',
                message: msgToAck.message,
                session_id: getSessionId(),
                parent_tool_use_id: null,
                uuid: msgToAck.uuid,
                timestamp: msgToAck.timestamp,
                isReplay: true,
              } as SDKUserMessageReplay
            }
          }
        }
      }

      if (message.type === 'user') {
        turnCount++
      }

      switch (message.type) {
        case 'tombstone':
          // 墓碑消息是删除消息的控制信号，应跳过
          break
        case 'assistant':
          // 如果已设置，捕获 stop_reason（合成消息）。对于流式响应，在 content_block_stop 时此值为 null；实际值通过 message_delta 到达（下方处理）。
          if (message.message.stop_reason != null) {
            lastStopReason = message.message.stop_reason
          }
          this.mutableMessages.push(message)
          yield* normalizeMessage(message)
          break
        case 'progress':
          this.mutableMessages.push(message)
          // 内联记录，以便下一次 ask() 调用中的去重循环将其视为已记录。如果没有这个，延迟的 progress 会与 mutableMessages 中已记录的 tool_results 交错，去重遍历会将 startingParentUuid 冻结在错误的消息上 — 导致链分叉，并在恢复时使对话成为孤儿。
          if (persistSession) {
            messages.push(message)
            void recordTranscript(messages)
          }
          yield* normalizeMessage(message)
          break
        case 'user':
          this.mutableMessages.push(message)
          yield* normalizeMessage(message)
          break
        case 'stream_event':
          if (message.event.type === 'message_start') {
            // 为新消息重置当前用量
            currentMessageUsage = EMPTY_USAGE
            currentMessageUsage = updateUsage(
              currentMessageUsage,
              message.event.message.usage,
            )
          }
          if (message.event.type === 'message_delta') {
            currentMessageUsage = updateUsage(
              currentMessageUsage,
              message.event.usage,
            )
            // 从 message_delta 捕获 stop_reason。助手消息在 content_block_stop 时以 stop_reason=null 产生；实际值仅在此到达（见 claude.ts 的 message_delta 处理函数）。如果没有这个，result.stop_reason 始终为 null。
            if (message.event.delta.stop_reason != null) {
              lastStopReason = message.event.delta.stop_reason
            }
          }
          if (message.event.type === 'message_stop') {
            // 将当前消息用量累加到总用量中
            this.totalUsage = accumulateUsage(
              this.totalUsage,
              currentMessageUsage,
            )
          }

          if (includePartialMessages) {
            yield {
              type: 'stream_event' as const,
              event: message.event,
              session_id: getSessionId(),
              parent_tool_use_id: null,
              uuid: randomUUID(),
            }
          }

          break
        case 'attachment':
          this.mutableMessages.push(message)
          // 内联记录（原因同上方的 progress）。
          if (persistSession) {
            messages.push(message)
            void recordTranscript(messages)
          }

          // 从 StructuredOutput 工具调用中提取结构化输出
          if (message.attachment.type === 'structured_output') {
            structuredOutputFromTool = message.attachment.data
          }
          // 处理 query.ts 发出的达到最大轮次信号
          else if (message.attachment.type === 'max_turns_reached') {
            if (persistSession) {
              if (
                isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
                isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
              ) {
                await flushSessionStorage()
              }
            }
            yield {
              type: 'result',
              subtype: 'error_max_turns',
              duration_ms: Date.now() - startTime,
              duration_api_ms: getTotalAPIDuration(),
              is_error: true,
              num_turns: message.attachment.turnCount,
              stop_reason: lastStopReason,
              session_id: getSessionId(),
              total_cost_usd: getTotalCost(),
              usage: this.totalUsage,
              modelUsage: getModelUsage(),
              permission_denials: this.permissionDenials,
              fast_mode_state: getFastModeState(
                mainLoopModel,
                initialAppState.fastMode,
              ),
              uuid: randomUUID(),
              errors: [
                `Reached maximum number of turns (${message.attachment.maxTurns})`,
              ],
            }
            return
          }
          // 将排队的命令附件作为SDK用户消息重放生成
          else if (
            replayUserMessages &&
            message.attachment.type === 'queued_command'
          ) {
            yield {
              type: 'user',
              message: {
                role: 'user' as const,
                content: message.attachment.prompt,
              },
              session_id: getSessionId(),
              parent_tool_use_id: null,
              uuid: message.attachment.source_uuid || message.uuid,
              timestamp: message.timestamp,
              isReplay: true,
            } as SDKUserMessageReplay
          }
          break
        case 'stream_request_start':
          // 不产出流式请求开始消息
          break
        case 'system': {
          this.mutableMessages.push(message)
          // 向 SDK 产生紧凑边界消息
          if (
            message.subtype === 'compact_boundary' &&
            message.compactMetadata
          ) {
            // 释放压缩前消息以供垃圾回收。边界刚被推送，因此它是最后一个元素。query.ts 内部已使用 getMessagesAfterCompactBoundary()，所以后续只需要边界后的消息。
            const mutableBoundaryIdx = this.mutableMessages.length - 1
            if (mutableBoundaryIdx > 0) {
              this.mutableMessages.splice(0, mutableBoundaryIdx)
            }
            const localBoundaryIdx = messages.length - 1
            if (localBoundaryIdx > 0) {
              messages.splice(0, localBoundaryIdx)
            }

            yield {
              type: 'system',
              subtype: 'compact_boundary' as const,
              session_id: getSessionId(),
              uuid: message.uuid,
              compact_metadata: toSDKCompactMetadata(message.compactMetadata),
            }
          }
          if (message.subtype === 'api_error') {
            yield {
              type: 'system',
              subtype: 'api_retry' as const,
              attempt: message.retryAttempt,
              max_retries: message.maxRetries,
              retry_delay_ms: message.retryInMs,
              error_status: message.error.status ?? null,
              error: categorizeRetryableAPIError(message.error),
              session_id: getSessionId(),
              uuid: message.uuid,
            }
          }
          // 在 headless 模式下不产生其他系统消息
          break
        }
        case 'tool_use_summary':
          // 向 SDK 产出工具使用摘要消息
          yield {
            type: 'tool_use_summary' as const,
            summary: message.summary,
            preceding_tool_use_ids: message.precedingToolUseIds,
            session_id: getSessionId(),
            uuid: message.uuid,
          }
          break
      }

      // 检查是否超过美元预算
      if (maxBudgetUsd !== undefined && getTotalCost() >= maxBudgetUsd) {
        if (persistSession) {
          if (
            isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
            isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
          ) {
            await flushSessionStorage()
          }
        }
        yield {
          type: 'result',
          subtype: 'error_max_budget_usd',
          duration_ms: Date.now() - startTime,
          duration_api_ms: getTotalAPIDuration(),
          is_error: true,
          num_turns: turnCount,
          stop_reason: lastStopReason,
          session_id: getSessionId(),
          total_cost_usd: getTotalCost(),
          usage: this.totalUsage,
          modelUsage: getModelUsage(),
          permission_denials: this.permissionDenials,
          fast_mode_state: getFastModeState(
            mainLoopModel,
            initialAppState.fastMode,
          ),
          uuid: randomUUID(),
          errors: [`Reached maximum budget ($${maxBudgetUsd})`],
        }
        return
      }

      // 检查是否超过结构化输出重试上限（仅针对用户消息）
      if (message.type === 'user' && jsonSchema) {
        const currentCalls = countToolCalls(
          this.mutableMessages,
          SYNTHETIC_OUTPUT_TOOL_NAME,
        )
        const callsThisQuery = currentCalls - initialStructuredOutputCalls
        const maxRetries = parseInt(
          process.env.MAX_STRUCTURED_OUTPUT_RETRIES || '5',
          10,
        )
        if (callsThisQuery >= maxRetries) {
          if (persistSession) {
            if (
              isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
              isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
            ) {
              await flushSessionStorage()
            }
          }
          yield {
            type: 'result',
            subtype: 'error_max_structured_output_retries',
            duration_ms: Date.now() - startTime,
            duration_api_ms: getTotalAPIDuration(),
            is_error: true,
            num_turns: turnCount,
            stop_reason: lastStopReason,
            session_id: getSessionId(),
            total_cost_usd: getTotalCost(),
            usage: this.totalUsage,
            modelUsage: getModelUsage(),
            permission_denials: this.permissionDenials,
            fast_mode_state: getFastModeState(
              mainLoopModel,
              initialAppState.fastMode,
            ),
            uuid: randomUUID(),
            errors: [
              `Failed to provide valid structured output after ${maxRetries} attempts`,
            ],
          }
          return
        }
      }
    }

    // 停止钩子会在助手响应之后产生进度/附件消息（通过 query.ts 中的 yield* handleStopHooks）。由于 #23537 将这些内联推送到 `messages`，last(messages) 可能是进度/附件而非助手消息 — 导致下方的 textResult 提取返回 ''，-p 模式输出空行。白名单只允许 assistant|user：isResultSuccessful 处理两者（带有全部 tool_result 块的 user 是有效的成功终端状态）。
    /** 执行 result 对应的业务处理。 */
    const result = messages.findLast(
      (message: Message) =>
        message.type === 'assistant' || message.type === 'user',
    ) as ResultCandidate | undefined
    // 为 error_during_execution 诊断捕获 — isResultSuccessful 是一个类型谓词（message is Message），因此在 false 分支内 `result` 收窄为 never，这些访问无法进行类型检查。
    const edeResultType = result?.type ?? 'undefined'
    const edeLastContent =
      result?.type === 'assistant' && Array.isArray(result.message?.content)
        ? result.message.content.at(-1)
        : undefined
    const edeLastContentType =
      result?.type === 'assistant' ? getContentBlockType(edeLastContent) : 'n/a'

    // 产出结果前刷新缓冲区中的会话记录写入。
    // 桌面应用收到结果消息后会立即终止 CLI 进程，因此必须避免丢失尚未刷盘的写入。
    if (persistSession) {
      if (
        isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
        isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
      ) {
        await flushSessionStorage()
      }
    }

    if (!isResultSuccessful(result, lastStopReason)) {
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        duration_ms: Date.now() - startTime,
        duration_api_ms: getTotalAPIDuration(),
        is_error: true,
        num_turns: turnCount,
        stop_reason: lastStopReason,
        session_id: getSessionId(),
        total_cost_usd: getTotalCost(),
        usage: this.totalUsage,
        modelUsage: getModelUsage(),
        permission_denials: this.permissionDenials,
        fast_mode_state: getFastModeState(
          mainLoopModel,
          initialAppState.fastMode,
        ),
        uuid: randomUUID(),
        // 诊断前缀：这些是 isResultSuccessful() 检查的内容 — 如果结果类型不是 assistant-with-text/thinking 或 user-with-tool_result，并且 stop_reason 不是 end_turn，这就是触发的原因。errors[] 通过水印是回合作用域的；之前它会转储整个进程的 logError 缓冲区（ripgrep 超时、ENOENT 等）。
        errors: (() => {
          const all = getInMemoryErrors()
          const start = errorLogWatermark
            ? all.lastIndexOf(errorLogWatermark) + 1
            : 0
          return [
            `[ede_diagnostic] result_type=${edeResultType} last_content_type=${edeLastContentType} stop_reason=${lastStopReason}`,
            ...all.slice(start).map(_ => _.error),
          ]
        })(),
      }
      return
    }

    // 根据消息类型提取文本结果
    let textResult = ''
    let isApiError = false

    if (result?.type === 'assistant') {
      const lastContent = Array.isArray(result.message?.content)
        ? result.message.content.at(-1)
        : undefined
      if (
        isTextContentBlock(lastContent) &&
        !SYNTHETIC_MESSAGES.has(lastContent.text)
      ) {
        textResult = lastContent.text
      }
      isApiError = Boolean(result.isApiErrorMessage)
    }

    yield {
      type: 'result',
      subtype: 'success',
      is_error: isApiError,
      duration_ms: Date.now() - startTime,
      duration_api_ms: getTotalAPIDuration(),
      num_turns: turnCount,
      result: textResult,
      stop_reason: lastStopReason,
      session_id: getSessionId(),
      total_cost_usd: getTotalCost(),
      usage: this.totalUsage,
      modelUsage: getModelUsage(),
      permission_denials: this.permissionDenials,
      structured_output: structuredOutputFromTool,
      fast_mode_state: getFastModeState(
        mainLoopModel,
        initialAppState.fastMode,
      ),
      uuid: randomUUID(),
    }
  }

  /** 执行 interrupt 对应的业务处理。 */
  interrupt(): void {
    this.abortController.abort()
  }

  /** 获取 get Messages 对应的数据或状态。 */
  getMessages(): readonly Message[] {
    return this.mutableMessages
  }

  /** 获取 get Read File State 对应的数据或状态。 */
  getReadFileState(): FileStateCache {
    return this.readFileState
  }

  /** 获取 get Session Id 对应的数据或状态。 */
  getSessionId(): string {
    return getSessionId()
  }

  /** 设置并保存 set Model 对应的数据或状态。 */
  setModel(model: string): void {
    this.config.userSpecifiedModel = model
  }
}

/**
 * 向 Claude API 发送单条提示词并返回响应。
 * 假定 Claude 以非交互方式使用，不会向用户请求权限或更多输入。
 *
 * QueryEngine 的便捷封装，用于单次调用。
 */
export async function* ask({
  commands,
  prompt,
  promptUuid,
  isMeta,
  cwd,
  tools,
  mcpClients,
  verbose = false,
  thinkingConfig,
  maxTurns,
  maxBudgetUsd,
  taskBudget,
  canUseTool,
  mutableMessages = [],
  getReadFileCache,
  setReadFileCache,
  customSystemPrompt,
  appendSystemPrompt,
  appendSubagentSystemPrompt,
  excludeDynamicSections,
  userSpecifiedModel,
  fallbackModel,
  jsonSchema,
  getAppState,
  setAppState,
  abortController,
  replayUserMessages = false,
  includePartialMessages = false,
  handleElicitation,
  agents = [],
  setSDKStatus,
  orphanedPermission,
}: {
  commands: Command[]
  prompt: string | Array<ContentBlockParam>
  promptUuid?: string
  isMeta?: boolean
  cwd: string
  tools: Tools
  verbose?: boolean
  mcpClients: MCPServerConnection[]
  thinkingConfig?: ThinkingConfig
  maxTurns?: number
  maxBudgetUsd?: number
  taskBudget?: { total: number }
  canUseTool: CanUseToolFn
  mutableMessages?: Message[]
  customSystemPrompt?: string | string[]
  appendSystemPrompt?: string
  appendSubagentSystemPrompt?: string
  excludeDynamicSections?: boolean
  userSpecifiedModel?: string
  fallbackModel?: string
  jsonSchema?: Record<string, unknown>
  /** 获取 get App State 对应的数据或状态。 */
  getAppState: () => AppState
  /** 设置并保存 set App State 对应的数据或状态。 */
  setAppState: (f: (prev: AppState) => AppState) => void
  /** 获取 get Read File Cache 对应的数据或状态。 */
  getReadFileCache: () => FileStateCache
  /** 设置并保存 set Read File Cache 对应的数据或状态。 */
  setReadFileCache: (cache: FileStateCache) => void
  abortController?: AbortController
  replayUserMessages?: boolean
  includePartialMessages?: boolean
  handleElicitation?: ToolUseContext['handleElicitation']
  agents?: AgentDefinition[]
  /** 设置并保存 set SDK Status 对应的数据或状态。 */
  setSDKStatus?: (status: SDKStatus) => void
  orphanedPermission?: OrphanedPermission
}): AsyncGenerator<SDKMessage, void, unknown> {
  const engine = new QueryEngine({
    cwd,
    tools,
    commands,
    mcpClients,
    agents,
    canUseTool,
    getAppState,
    setAppState,
    initialMessages: mutableMessages,
    readFileCache: cloneFileStateCache(getReadFileCache()),
    customSystemPrompt,
    appendSystemPrompt,
    appendSubagentSystemPrompt,
    excludeDynamicSections,
    userSpecifiedModel,
    fallbackModel,
    thinkingConfig,
    maxTurns,
    maxBudgetUsd,
    taskBudget,
    jsonSchema,
    verbose,
    handleElicitation,
    replayUserMessages,
    includePartialMessages,
    setSDKStatus,
    abortController,
    orphanedPermission,
  })

  try {
    yield* engine.submitMessage(prompt, {
      uuid: promptUuid,
      isMeta,
    })
  } finally {
    setReadFileCache(engine.getReadFileState())
  }
}
