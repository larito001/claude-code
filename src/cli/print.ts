import { feature } from 'src/utils/features.js'
import { readFile, stat } from 'fs/promises'
import { dirname } from 'path'
import { StructuredIO } from 'src/cli/structuredIO.js'
import {
  type Command,
  formatDescriptionWithSource,
  getCommandName,
} from 'src/commands.js'
import { createStreamlinedTransformer } from 'src/utils/streamlinedTransform.js'
import { installStreamJsonStdoutGuard } from 'src/utils/streamJsonStdoutGuard.js'
import type { ToolPermissionContext } from 'src/Tool.js'
import type { ThinkingConfig } from 'src/utils/thinking.js'
import { assembleToolPool, filterToolsByDenyRules } from 'src/tools.js'
import uniqBy from 'lodash-es/uniqBy.js'
import { uniq } from 'src/utils/array.js'
import { mergeAndFilterTools } from 'src/utils/toolPool.js'
import { getFeatureValue } from 'src/services/featureConfig.js'
import { logForDebugging } from 'src/utils/debug.js'
import {
  logForDiagnosticsNoPII,
  withDiagnosticsTiming,
} from 'src/utils/diagLogs.js'
import { toolMatchesName, type Tool, type Tools } from 'src/Tool.js'
import {
  type AgentDefinition,
  isBuiltInAgent,
  parseAgentsFromJson,
} from 'src/tools/AgentTool/loadAgentsDir.js'
import type { Message, NormalizedUserMessage } from 'src/types/message.js'
import type { QueuedCommand } from 'src/types/textInputTypes.js'
import {
  dequeue,
  dequeueAllMatching,
  enqueue,
  hasCommandsInQueue,
  peek,
  subscribeToCommandQueue,
  getCommandsByMaxPriority,
} from 'src/utils/messageQueueManager.js'
import { notifyCommandLifecycle } from 'src/utils/commandLifecycle.js'
import {
  getSessionState,
  notifySessionStateChanged,
  notifySessionMetadataChanged,
  setPermissionModeChangedListener,
  type RequiresActionDetails,
} from 'src/utils/sessionState.js'
import { getInMemoryErrors, logError, logMCPDebug } from 'src/utils/log.js'
import {
  writeToStdout,
  registerProcessOutputErrorHandlers,
} from 'src/utils/process.js'
import type { Stream } from 'src/utils/stream.js'
import { EMPTY_USAGE } from 'src/services/api/logging.js'
import {
  loadConversationForResume,
  type TurnInterruptionState,
} from 'src/utils/conversationRecovery.js'
import type {
  MCPServerConnection,
  McpSdkServerConfig,
  ScopedMcpServerConfig,
} from 'src/services/mcp/types.js'
import {
  ChannelMessageNotificationSchema,
  gateChannelServer,
  wrapChannelMessage,
  findChannelEntry,
} from 'src/services/mcp/channelNotification.js'
import {
  isChannelAllowlisted,
  isChannelsEnabled,
} from 'src/services/mcp/channelAllowlist.js'
import { parsePluginIdentifier } from 'src/utils/plugins/pluginIdentifier.js'
import { validateUuid } from 'src/utils/uuid.js'
import { fromArray } from 'src/utils/generators.js'
import { ask } from 'src/QueryEngine.js'
import type { PermissionPromptTool } from 'src/utils/queryHelpers.js'
import {
  createFileStateCacheWithSizeLimit,
  mergeFileStateCaches,
  READ_FILE_STATE_CACHE_SIZE,
} from 'src/utils/fileStateCache.js'
import { expandPath } from 'src/utils/path.js'
import { extractReadFilesFromMessages } from 'src/utils/queryHelpers.js'
import { registerHookEventHandler } from 'src/utils/hooks/hookEvents.js'
import { finalizePendingAsyncHooks } from 'src/utils/hooks/AsyncHookRegistry.js'
import {
  gracefulShutdown,
  gracefulShutdownSync,
  isShuttingDown,
} from 'src/utils/gracefulShutdown.js'
import { registerCleanup } from 'src/utils/cleanupRegistry.js'
import { createIdleTimeoutManager } from 'src/utils/idleTimeout.js'
import type {
  SDKStatus,
  ModelInfo,
  SDKMessage,
  SDKUserMessage,
  SDKUserMessageReplay,
  PermissionResult,
  McpServerConfigForProcessTransport,
  McpServerStatus,
  RewindFilesResult,
} from 'src/entrypoints/agentSdkTypes.js'
import type {
  StdoutMessage,
  SDKControlInitializeRequest,
  SDKControlInitializeResponse,
  SDKControlRequest,
  SDKControlResponse,
  SDKControlMcpSetServersResponse,
  SDKControlReloadPluginsResponse,
} from 'src/entrypoints/sdk/controlTypes.js'
import { SDKControlInitializeRequestSchema } from 'src/entrypoints/sdk/controlSchemas.js'
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { PermissionMode as InternalPermissionMode } from 'src/types/permissions.js'
import { cwd } from 'process'
import { getCwd } from 'src/utils/cwd.js'
import omit from 'lodash-es/omit.js'
import reject from 'lodash-es/reject.js'
import type { CanUseToolFn } from 'src/hooks/useCanUseTool.js'
import { hasPermissionsToUseTool } from 'src/utils/permissions/permissions.js'
import { safeParseJSON } from 'src/utils/json.js'
import {
  outputSchema as permissionToolOutputSchema,
  permissionPromptToolResultToPermissionDecision,
} from 'src/utils/permissions/PermissionPromptToolResultSchema.js'
import { createAbortController } from 'src/utils/abortController.js'
import { createCombinedAbortSignal } from 'src/utils/combinedAbortSignal.js'
import { generateSessionTitle } from 'src/utils/sessionTitle.js'
import { buildSideQuestionFallbackParams } from 'src/utils/queryContext.js'
import { runSideQuestion } from 'src/utils/sideQuestion.js'
import {
  processSessionStartHooks,
  processSetupHooks,
  takeInitialUserMessage,
} from 'src/utils/sessionStart.js'
import {
  DEFAULT_OUTPUT_STYLE_NAME,
  getAllOutputStyles,
} from 'src/constants/outputStyles.js'
import { TEAMMATE_MESSAGE_TAG, TICK_TAG } from 'src/constants/xml.js'
import {
  getSettings_DEPRECATED,
  getSettingsWithSources,
} from 'src/utils/settings/settings.js'
import { settingsChangeDetector } from 'src/utils/settings/changeDetector.js'
import { applySettingsChange } from 'src/utils/settings/applySettingsChange.js'
import {
  isFastModeAvailable,
  isFastModeEnabled,
  isFastModeSupportedByModel,
  getFastModeState,
} from 'src/utils/fastMode.js'
import {
  isAutoModeGateEnabled,
  getAutoModeUnavailableNotification,
  getAutoModeUnavailableReason,
  isBypassPermissionsModeDisabled,
  transitionPermissionMode,
} from 'src/utils/permissions/permissionSetup.js'
import {
  tryGenerateSuggestion,
} from 'src/services/PromptSuggestion/promptSuggestion.js'
import { getLastCacheSafeParams } from 'src/utils/forkedAgent.js'
import { getApiCredentialInformation } from 'src/utils/auth.js'
import { getAPIProvider } from 'src/utils/model/providers.js'
import type { HookCallbackMatcher } from 'src/types/hooks.js'
import { AwsAuthStatusManager } from 'src/utils/awsAuthStatusManager.js'
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import {
  registerHookCallbacks,
  setInitJsonSchema,
  getInitJsonSchema,
  setSdkAgentProgressSummariesEnabled,
} from 'src/bootstrap/state.js'
import { createSyntheticOutputTool } from 'src/tools/SyntheticOutputTool/SyntheticOutputTool.js'
import { parseSessionIdentifier } from 'src/utils/sessionUrl.js'
import {  resetSessionFilePointer,
  doesMessageExistInSession,
  findUnresolvedToolUse,
  recordAttributionSnapshot,
  saveAgentSetting,
  saveMode,
  saveAiGeneratedTitle,
  restoreSessionMetadata,
} from 'src/utils/sessionStorage.js'
import { incrementPromptCount } from 'src/utils/commitAttribution.js'
import {
  setupSdkMcpClients,
  connectToServer,
  clearServerCache,
  fetchToolsForClient,
  areMcpConfigsEqual,
  reconnectMcpServerImpl,
} from 'src/services/mcp/client.js'
import {
  filterMcpServersByPolicy,
  getMcpConfigByName,
  isMcpServerDisabled,
  setMcpServerEnabled,
} from 'src/services/mcp/config.js'
import {
  performMCPOAuthFlow,
  revokeServerTokens,
} from 'src/services/mcp/auth.js'
import {
  runElicitationHooks,
  runElicitationResultHooks,
} from 'src/services/mcp/elicitationHandler.js'
import { executeNotificationHooks } from 'src/utils/hooks.js'
import {
  ElicitRequestSchema,
  ElicitationCompleteNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { getMcpPrefix } from 'src/services/mcp/mcpStringUtils.js'
import {
  commandBelongsToServer,
  filterToolsByServer,
} from 'src/services/mcp/utils.js'
import { setupVscodeSdkMcp } from 'src/services/mcp/vscodeSdkMcp.js'
import { getAllMcpConfigs } from 'src/services/mcp/config.js'
import {
  toInternalMessages,
} from 'src/utils/messages/mappers.js'
import { createModelSwitchBreadcrumbs } from 'src/utils/messages.js'
import { collectContextData } from 'src/commands/context/context-noninteractive.js'
import { LOCAL_COMMAND_STDOUT_TAG } from 'src/constants/xml.js'
import {
  getDefaultMainLoopModel,
  getMainLoopModel,
  modelDisplayString,
  parseUserSpecifiedModel,
} from 'src/utils/model/model.js'
import { getModelOptions } from 'src/utils/model/modelOptions.js'
import {
  modelSupportsEffort,
  modelSupportsMaxEffort,
  EFFORT_LEVELS,
  resolveAppliedEffort,
} from 'src/utils/effort.js'
import { modelSupportsAdaptiveThinking } from 'src/utils/thinking.js'
import { modelSupportsAutoMode } from 'src/utils/betas.js'
import { ensureModelStringsInitialized } from 'src/utils/model/modelStrings.js'
import {
  getSessionId,
  setMainLoopModelOverride,
  setMainThreadAgentType,
  switchSession,
  isSessionPersistenceDisabled,
  getFlagSettingsInline,
  setFlagSettingsInline,
  getMainThreadAgentType,
  getAllowedChannels,
  setAllowedChannels,
  type ChannelEntry,
} from 'src/bootstrap/state.js'
import { runWithWorkload, WORKLOAD_CRON } from 'src/utils/workloadContext.js'
import type { UUID } from 'crypto'
import { randomUUID } from 'crypto'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type { AppState } from 'src/state/AppStateStore.js'
import {
  fileHistoryRewind,
  fileHistoryCanRestore,
  fileHistoryEnabled,
  fileHistoryGetDiffStats,
} from 'src/utils/fileHistory.js'
import {
  restoreAgentFromSession,
  restoreSessionStateFromLog,
} from 'src/utils/sessionRestore.js'
import { SandboxManager } from 'src/utils/sandbox/sandbox-adapter.js'
import {
  headlessProfilerStartTurn,
  headlessProfilerCheckpoint,
  logHeadlessProfilerTurn,
} from 'src/utils/headlessProfiler.js'
import {
  startQueryProfile,
  logQueryProfileReport,
} from 'src/utils/queryProfiler.js'
import { asSessionId } from 'src/types/ids.js'
import { jsonStringify } from '../utils/slowOperations.js'
import { skillChangeDetector } from '../utils/skills/skillChangeDetector.js'
import { getCommands, clearCommandsCache } from '../commands.js'
import {
  isBareMode,
  isEnvTruthy,
  isEnvDefinedFalsy,
} from '../utils/envUtils.js'
import { installPluginsForHeadless } from '../utils/plugins/headlessPluginInstall.js'
import { refreshActivePlugins } from '../utils/plugins/refresh.js'
import { loadAllPluginsCacheOnly } from '../utils/plugins/pluginLoader.js'
import {
  isTeamLead,
  hasActiveInProcessTeammates,
  hasWorkingInProcessTeammates,
  waitForTeammatesToBecomeIdle,
} from '../utils/teammate.js'
import {
  readUnreadMessages,
  markMessagesAsRead,
  isShutdownApproved,
} from '../utils/teammateMailbox.js'
import { removeTeammateFromTeamFile } from '../utils/swarm/teamHelpers.js'
import { unassignTeammateTasks } from '../utils/tasks.js'
import { getRunningTasks } from '../utils/task/framework.js'
import { isBackgroundTask } from '../tasks/types.js'
import { stopTask } from '../tasks/stopTask.js'
import { drainSdkEvents } from '../utils/sdkEventQueue.js'
import { initializeFeatureConfig } from '../services/featureConfig.js'
import { drainPendingExtraction } from '../services/extractMemories/extractMemories.js'
import { errorMessage, toError } from '../utils/errors.js'
import { sleep } from '../utils/sleep.js'
import { isExtractModeActive } from '../memdir/paths.js'

// 死代码消除：条件导入
/* eslint-disable @typescript-eslint/no-require-imports */
const coordinatorModeModule = feature('COORDINATOR_MODE')
  ? (require('../coordinator/coordinatorMode.js') as typeof import('../coordinator/coordinatorMode.js'))
  : null
const proactiveModule =
  feature('PROACTIVE')
    ? (require('../proactive/index.js') as typeof import('../proactive/index.js'))
    : null
const cronSchedulerModule = feature('AGENT_TRIGGERS')
  ? (require('../utils/cronScheduler.js') as typeof import('../utils/cronScheduler.js'))
  : null
const cronJitterConfigModule = feature('AGENT_TRIGGERS')
  ? (require('../utils/cronJitterConfig.js') as typeof import('../utils/cronJitterConfig.js'))
  : null
const cronGate = feature('AGENT_TRIGGERS')
  ? (require('../tools/ScheduleCronTool/prompt.js') as typeof import('../tools/ScheduleCronTool/prompt.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

const SHUTDOWN_TEAM_PROMPT = `<system-reminder>
You are running in non-interactive mode and cannot return a response to the user until your team is shut down.

You MUST shut down your team before preparing your final response:
1. Use requestShutdown to ask each team member to shut down gracefully
2. Wait for shutdown approvals
3. Use the cleanup operation to clean up the team
4. Only then provide your final response to the user

The user cannot receive your response until the team is completely shut down.
</system-reminder>

Shut down your team and prepare your final response for the user.`

// 跟踪当前会话运行时期间收到的消息 UUID
const MAX_RECEIVED_UUIDS = 10_000
const receivedMessageUuids = new Set<UUID>()
const receivedMessageUuidsOrder: UUID[] = []

/** 执行 track Received Message Uuid 对应的业务处理。 */
function trackReceivedMessageUuid(uuid: UUID): boolean {
  if (receivedMessageUuids.has(uuid)) {
    return false // 重复
  }
  receivedMessageUuids.add(uuid)
  receivedMessageUuidsOrder.push(uuid)
  // 达到容量时驱逐最旧条目
  if (receivedMessageUuidsOrder.length > MAX_RECEIVED_UUIDS) {
    const toEvict = receivedMessageUuidsOrder.splice(
      0,
      receivedMessageUuidsOrder.length - MAX_RECEIVED_UUIDS,
    )
    for (const old of toEvict) {
      receivedMessageUuids.delete(old)
    }
  }
  return true // 新 UUID
}

type PromptValue = string | ContentBlockParam[]

/** 转换 to Blocks 对应的数据或状态。 */
function toBlocks(v: PromptValue): ContentBlockParam[] {
  return typeof v === 'string' ? [{ type: 'text', text: v }] : v
}

/** 将多个排队命令的提示值合并为一个。字符串按\n换行符连接；如果有任何值是块数组，则所有值将规范化为块并连接。 */
export function joinPromptValues(values: PromptValue[]): PromptValue {
  if (values.length === 1) return values[0]!
  if (values.every(v => typeof v === 'string')) {
    return values.join('\n')
  }
  return values.flatMap(toBlocks)
}

/**
 * `next` 是否可以与 `head` 一起批量处理到同一个 ask() 调用中。仅提示模式命令可以批量处理，并且仅当工作负载标签匹配（以便组合轮次正确归属）且 isMeta 标志匹配（这样主动滴答无法合并到用户提示中，并且在将 head 分布在合并的命令上时不会丢失其转录中的隐藏标记）时。
 */
export function canBatchWith(
  head: QueuedCommand,
  next: QueuedCommand | undefined,
): boolean {
  return (
    next !== undefined &&
    next.mode === 'prompt' &&
    next.workload === head.workload &&
    next.isMeta === head.isMeta
  )
}

/** 执行 run Headless 对应的数据或状态。 */
export async function runHeadless(
  inputPrompt: string | AsyncIterable<string>,
  getAppState: () => AppState,
  setAppState: (f: (prev: AppState) => AppState) => void,
  commands: Command[],
  tools: Tools,
  sdkMcpConfigs: Record<string, McpSdkServerConfig>,
  agents: AgentDefinition[],
  options: {
    continue: boolean | undefined
    resume: string | boolean | undefined
    resumeSessionAt: string | undefined
    verbose: boolean | undefined
    outputFormat: string | undefined
    jsonSchema: Record<string, unknown> | undefined
    permissionPromptToolName: string | undefined
    allowedTools: string[] | undefined
    thinkingConfig: ThinkingConfig | undefined
    maxTurns: number | undefined
    maxBudgetUsd: number | undefined
    taskBudget: { total: number } | undefined
    systemPrompt: string | undefined
    appendSystemPrompt: string | undefined
    userSpecifiedModel: string | undefined
    fallbackModel: string | undefined
    replayUserMessages: boolean | undefined
    includePartialMessages: boolean | undefined
    forkSession: boolean | undefined
    rewindFiles: string | undefined
    enableAuthStatus: boolean | undefined
    agent: string | undefined
    workload: string | undefined
    setupTrigger?: 'init' | 'maintenance' | undefined
    sessionStartHooksPromise?: ReturnType<typeof processSessionStartHooks>
    /** 设置并保存 set SDK Status 对应的数据或状态。 */
    setSDKStatus?: (status: SDKStatus) => void
  },
): Promise<void> {
  if (isEnvTruthy(process.env.CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER)) {
    process.stderr.write(
      `\nStartup time: ${Math.round(process.uptime() * 1000)}ms\n`,
    )
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(0)
  }

  // 在无头模式下没有 React 树，因此 useSettingsChange 钩子永远不会运行。直接订阅，以便设置更改（包括托管设置/策略更新）得到完全应用。
  settingsChangeDetector.subscribe(source => {
    applySettingsChange(source, setAppState)

    // 在无头模式下，还要从 settings 同步反规范化的 fastMode 字段。TUI 通过 UI 管理 fastMode，因此会跳过此操作。
    if (isFastModeEnabled()) {
      setAppState(prev => {
        const s = prev.settings as Record<string, unknown>
        const fastMode = s.fastMode === true && !s.fastModePerSessionOptIn
        return { ...prev, fastMode }
      })
    }
  })

  // 主动激活现在在 main.tsx 中的 getTools() 之前处理，因此 SleepTool 通过 isEnabled() 过滤。此回退覆盖了设置了 CLAUDE_CODE_PROACTIVE 但 main.tsx 的检查未触发的情况（例如 env 由 SDK transport 在 argv 解析后注入）。
  if (
    (feature('PROACTIVE')) &&
    proactiveModule &&
    !proactiveModule.isProactiveActive() &&
    isEnvTruthy(process.env.CLAUDE_CODE_PROACTIVE)
  ) {
    proactiveModule.activateProactive('command')
  }

  // 定期强制完整 GC 以控制内存使用
  if (typeof Bun !== 'undefined') {
    const gcTimer = setInterval(Bun.gc, 1000)
    gcTimer.unref()
  }

  // 为第一轮启动无头分析器
  headlessProfilerStartTurn()
  headlessProfilerCheckpoint('runHeadless_entry')

  // 初始化本地功能配置，以使功能标志在无头模式下生效。没有这个，磁盘缓存为空，所有标志都回退到默认值。
  void initializeFeatureConfig()

  if (options.resumeSessionAt && !options.resume) {
    process.stderr.write(`Error: --resume-session-at requires --resume\n`)
    gracefulShutdownSync(1)
    return
  }

  if (options.rewindFiles && !options.resume) {
    process.stderr.write(`Error: --rewind-files requires --resume\n`)
    gracefulShutdownSync(1)
    return
  }

  if (options.rewindFiles && inputPrompt) {
    process.stderr.write(
      `Error: --rewind-files is a standalone operation and cannot be used with a prompt\n`,
    )
    gracefulShutdownSync(1)
    return
  }

  const structuredIO = getStructuredIO(inputPrompt, options)

  // 当为 SDK 客户端发出 NDJSON 时，任何对 stdout 的散乱写入（调试打印、依赖项的 console.log、库横幅）都会破坏客户端的逐行 JSON 解析器。安装一个守卫，将非 JSON 行转移到 stderr，以便流保持干净。必须在下面的第一个 structuredIO.write 之前运行。
  if (options.outputFormat === 'stream-json') {
    installStreamJsonStdoutGuard()
  }

  // #34044：如果用户显式设置 sandbox.enabled=true 但依赖项缺失，isSandboxingEnabled() 会静默返回 false。公开原因，以便用户知道他们的安全配置未被强制执行。
  const sandboxUnavailableReason = SandboxManager.getSandboxUnavailableReason()
  if (sandboxUnavailableReason) {
    if (SandboxManager.isSandboxRequired()) {
      process.stderr.write(
        `\nError: sandbox required but unavailable: ${sandboxUnavailableReason}\n` +
          `  sandbox.failIfUnavailable is set — refusing to start without a working sandbox.\n\n`,
      )
      gracefulShutdownSync(1)
      return
    }
    process.stderr.write(
      `\n⚠ Sandbox disabled: ${sandboxUnavailableReason}\n` +
        `  Commands will run WITHOUT sandboxing. Network and filesystem restrictions will NOT be enforced.\n\n`,
    )
  } else if (SandboxManager.isSandboxingEnabled()) {
    // 使用回调初始化沙箱，该回调通过 can_use_tool control_request 协议将网络权限请求转发给 SDK 主机。这必须在 structuredIO 创建之后发生，以便我们可以发送请求。
    try {
      await SandboxManager.initialize(structuredIO.createSandboxAskCallback())
    } catch (err) {
      process.stderr.write(`\n❌ Sandbox Error: ${errorMessage(err)}\n`)
      gracefulShutdownSync(1, 'other')
      return
    }
  }

  if (options.outputFormat === 'stream-json' && options.verbose) {
    registerHookEventHandler(event => {
      const message: StdoutMessage = (() => {
        switch (event.type) {
          case 'started':
            return {
              type: 'system' as const,
              subtype: 'hook_started' as const,
              hook_id: event.hookId,
              hook_name: event.hookName,
              hook_event: event.hookEvent,
              uuid: randomUUID(),
              session_id: getSessionId(),
            }
          case 'progress':
            return {
              type: 'system' as const,
              subtype: 'hook_progress' as const,
              hook_id: event.hookId,
              hook_name: event.hookName,
              hook_event: event.hookEvent,
              stdout: event.stdout,
              stderr: event.stderr,
              output: event.output,
              uuid: randomUUID(),
              session_id: getSessionId(),
            }
          case 'response':
            return {
              type: 'system' as const,
              subtype: 'hook_response' as const,
              hook_id: event.hookId,
              hook_name: event.hookName,
              hook_event: event.hookEvent,
              output: event.output,
              stdout: event.stdout,
              stderr: event.stderr,
              exit_code: event.exitCode,
              outcome: event.outcome,
              uuid: randomUUID(),
              session_id: getSessionId(),
            }
        }
      })()
      void structuredIO.write(message)
    })
  }

  if (options.setupTrigger) {
    await processSetupHooks(options.setupTrigger)
  }

  headlessProfilerCheckpoint('before_loadInitialMessages')
  const appState = getAppState()
  const {
    messages: initialMessages,
    turnInterruptionState,
    agentSetting: resumedAgentSetting,
  } = await loadInitialMessages(setAppState, {
    continue: options.continue,
    resume: options.resume,
    resumeSessionAt: options.resumeSessionAt,
    forkSession: options.forkSession,
    outputFormat: options.outputFormat,
    sessionStartHooksPromise: options.sessionStartHooksPromise,
  })

  // SessionStart 钩子可以发出 initialUserMessage —— 无头编排器会话的第一个用户轮次，其中 stdin 为空且单独的 additionalContext（附件，而不是轮次）会使 REPL 无法响应。钩子 promise 在 loadInitialMessages 内部等待，因此模块级别的 pending 值在我们到达这里时已设置。
  const hookInitialUserMessage = takeInitialUserMessage()
  if (hookInitialUserMessage) {
    structuredIO.prependUserMessage(hookInitialUserMessage)
  }

  // 从恢复的会话中恢复代理设置（如果未被当前的 --agent 标志或基于设置的代理覆盖，这些代理已经在 main.tsx 中设置了 mainThreadAgentType）
  if (!options.agent && !getMainThreadAgentType() && resumedAgentSetting) {
    const { agentDefinition: restoredAgent } = restoreAgentFromSession(
      resumedAgentSetting,
      undefined,
      { activeAgents: agents, allAgents: agents },
    )
    if (restoredAgent) {
      setAppState(prev => ({ ...prev, agent: restoredAgent.agentType }))
      // 对非内置代理应用代理的系统提示（镜像 main.tsx 初始 --agent 路径）
      if (!options.systemPrompt && !isBuiltInAgent(restoredAgent)) {
        const agentSystemPrompt = restoredAgent.getSystemPrompt()
        if (agentSystemPrompt) {
          options.systemPrompt = agentSystemPrompt
        }
      }
      // 重新持久化代理设置，以便未来的恢复保持代理
      saveAgentSetting(restoredAgent.agentType)
    }
  }

  // gracefulShutdownSync 安排异步关闭并设置 process.exitCode。如果 loadInitialMessages 错误路径触发了它，则提前退出以避免在进程关闭时进行不必要的工作。
  if (initialMessages.length === 0 && process.exitCode !== undefined) {
    return
  }

  // 处理 --rewind-files：恢复文件系统并立即退出
  if (options.rewindFiles) {
    // 文件历史快照仅为用户消息创建，因此我们要求目标必须是用户消息
    const targetMessage = initialMessages.find(
      m => m.uuid === options.rewindFiles,
    )

    if (!targetMessage || targetMessage.type !== 'user') {
      process.stderr.write(
        `Error: --rewind-files requires a user message UUID, but ${options.rewindFiles} is not a user message in this session\n`,
      )
      gracefulShutdownSync(1)
      return
    }

    const currentAppState = getAppState()
    const result = await handleRewindFiles(
      options.rewindFiles as UUID,
      currentAppState,
      setAppState,
      false,
    )
    if (!result.canRewind) {
      process.stderr.write(`Error: ${result.error || 'Unexpected error'}\n`)
      gracefulShutdownSync(1)
      return
    }

    // 回滚完成 - 成功退出
    process.stdout.write(
      `Files rewound to state at message ${options.rewindFiles}\n`,
    )
    gracefulShutdownSync(0)
    return
  }

  // 检查是否需要输入提示——如果正在使用有效的会话ID/JSONL文件恢复，则跳过
  const hasValidResumeSessionId =
    typeof options.resume === 'string' &&
    (Boolean(validateUuid(options.resume)) || options.resume.endsWith('.jsonl'))
  if (!inputPrompt && !hasValidResumeSessionId) {
    process.stderr.write(
      `Error: Input must be provided either through stdin or as a prompt argument when using --print\n`,
    )
    gracefulShutdownSync(1)
    return
  }

  if (options.outputFormat === 'stream-json' && !options.verbose) {
    process.stderr.write(
      'Error: When using --print, --output-format=stream-json requires --verbose\n',
    )
    gracefulShutdownSync(1)
    return
  }

  // 过滤掉拒绝列表中的MCP工具
  const allowedMcpTools = filterToolsByDenyRules(
    appState.mcp.tools,
    appState.toolPermissionContext,
  )
  let filteredTools = [...tools, ...allowedMcpTools]

  const effectivePermissionPromptToolName = options.permissionPromptToolName

  // 权限提示显示时的回调
  const onPermissionPrompt = (details: RequiresActionDetails) => {
    if (feature('COMMIT_ATTRIBUTION')) {
      setAppState(prev => ({
        ...prev,
        attribution: {
          ...prev.attribution,
          permissionPromptCount: prev.attribution.permissionPromptCount + 1,
        },
      }))
    }
    notifySessionStateChanged('requires_action', details)
  }

  /** 判断是否满足 can Use Tool 对应的数据或状态。 */
  const canUseTool = getCanUseToolFn(
    effectivePermissionPromptToolName,
    structuredIO,
    () => getAppState().mcp.tools,
    onPermissionPrompt,
  )
  if (options.permissionPromptToolName) {
    // 从可用工具列表中移除权限提示工具。
    filteredTools = filteredTools.filter(
      tool => !toolMatchesName(tool, options.permissionPromptToolName!),
    )
  }

  // 安装错误处理程序以优雅地处理管道断裂（例如，当父进程终止时）
  registerProcessOutputErrorHandlers()

  headlessProfilerCheckpoint('after_loadInitialMessages')

  // 确保在生成模型选项之前初始化模型字符串。
  // 对于Bedrock用户，这会等待配置文件获取以获取正确的区域字符串。
  await ensureModelStringsInitialized()
  headlessProfilerCheckpoint('after_modelStrings')

  // UDS收件箱存储的注册延迟到`run`定义之后，
  // 以便我们可以将`run`作为onEnqueue回调传递（见下文）。

  // 只有`json`+`verbose`需要完整的数组（下面的jsonStringify(messages)）。
  // 读取退出代码/最终结果。避免为整个会话在内存中累积每条消息。
  const needsFullArray = options.outputFormat === 'json' && options.verbose
  const messages: SDKMessage[] = []
  let lastMessage: SDKMessage | undefined
  // 精简模式在CLAUDE_CODE_STREAMLINED_OUTPUT=true且使用stream-json时转换消息。
  // 本地功能标志和环境变量都需要。
  const transformToStreamlined =
    feature('STREAMLINED_OUTPUT') &&
    isEnvTruthy(process.env.CLAUDE_CODE_STREAMLINED_OUTPUT) &&
    options.outputFormat === 'stream-json'
      ? createStreamlinedTransformer()
      : null

  headlessProfilerCheckpoint('before_runHeadlessStreaming')
  for await (const message of runHeadlessStreaming(
    structuredIO,
    appState.mcp.clients,
    [...commands, ...appState.mcp.commands],
    filteredTools,
    initialMessages,
    canUseTool,
    sdkMcpConfigs,
    getAppState,
    setAppState,
    agents,
    options,
    turnInterruptionState,
  )) {
    if (transformToStreamlined) {
      // 精简模式：转换消息并立即流式传输
      const transformed = transformToStreamlined(message)
      if (transformed) {
        await structuredIO.write(transformed)
      }
    } else if (options.outputFormat === 'stream-json' && options.verbose) {
      await structuredIO.write(message)
    }
    // 在非流模式下不应收到控制消息或流事件。
    // 同时过滤掉精简类型，因为它们仅由转换器生成。
    // 排除仅SDK的系统事件，以使lastMessage保持在结果处
    // （session_state_changed(idle)和任何延迟的task_notification在finally块中的结果之后排出）。
    if (
      message.type !== 'control_response' &&
      message.type !== 'control_request' &&
      message.type !== 'control_cancel_request' &&
      !(
        message.type === 'system' &&
        (message.subtype === 'session_state_changed' ||
          message.subtype === 'task_notification' ||
          message.subtype === 'task_started' ||
          message.subtype === 'task_progress' ||
          message.subtype === 'post_turn_summary')
      ) &&
      message.type !== 'stream_event' &&
      message.type !== 'keep_alive' &&
      message.type !== 'streamlined_text' &&
      message.type !== 'streamlined_tool_use_summary' &&
      message.type !== 'prompt_suggestion'
    ) {
      if (needsFullArray) {
        messages.push(message)
      }
      lastMessage = message
    }
  }

  switch (options.outputFormat) {
    case 'json':
      if (!lastMessage || lastMessage.type !== 'result') {
        throw new Error('No messages returned')
      }
      if (options.verbose) {
        writeToStdout(jsonStringify(messages) + '\n')
        break
      }
      writeToStdout(jsonStringify(lastMessage) + '\n')
      break
    case 'stream-json':
      // 已在上面记录
      break
    default:
      if (!lastMessage || lastMessage.type !== 'result') {
        throw new Error('No messages returned')
      }
      switch (lastMessage.subtype) {
        case 'success':
          writeToStdout(
            lastMessage.result.endsWith('\n')
              ? lastMessage.result
              : lastMessage.result + '\n',
          )
          break
        case 'error_during_execution':
          writeToStdout(`Execution error`)
          break
        case 'error_max_turns':
          writeToStdout(`Error: Reached max turns (${options.maxTurns})`)
          break
        case 'error_max_budget_usd':
          writeToStdout(`Error: Exceeded USD budget (${options.maxBudgetUsd})`)
          break
        case 'error_max_structured_output_retries':
          writeToStdout(
            `Error: Failed to provide valid structured output after maximum retries`,
          )
      }
  }

  // 记录最后一轮的无头延迟指标
  logHeadlessProfilerTurn()

  // 在关闭前排出任何正在进行的内存提取。
  // 响应已在上面刷新，因此这不会增加用户可见的延迟——它只是延迟进程退出，以便gracefulShutdownSync的5秒故障安全不会在途中杀死分叉的代理。
  // 由isExtractModeActive控制，因此tengu_slate_thimble标志端到端地控制非交互式提取。
  if (feature('EXTRACT_MEMORIES') && isExtractModeActive()) {
    await drainPendingExtraction()
  }

  gracefulShutdownSync(
    lastMessage?.type === 'result' && lastMessage?.is_error ? 1 : 0,
  )
}

/** 执行 run Headless Streaming 对应的数据或状态。 */
function runHeadlessStreaming(
  structuredIO: StructuredIO,
  mcpClients: MCPServerConnection[],
  commands: Command[],
  tools: Tools,
  initialMessages: Message[],
  canUseTool: CanUseToolFn,
  sdkMcpConfigs: Record<string, McpSdkServerConfig>,
  getAppState: () => AppState,
  setAppState: (f: (prev: AppState) => AppState) => void,
  agents: AgentDefinition[],
  options: {
    verbose: boolean | undefined
    jsonSchema: Record<string, unknown> | undefined
    permissionPromptToolName: string | undefined
    allowedTools: string[] | undefined
    thinkingConfig: ThinkingConfig | undefined
    maxTurns: number | undefined
    maxBudgetUsd: number | undefined
    taskBudget: { total: number } | undefined
    systemPrompt: string | undefined
    appendSystemPrompt: string | undefined
    userSpecifiedModel: string | undefined
    fallbackModel: string | undefined
    replayUserMessages?: boolean | undefined
    includePartialMessages?: boolean | undefined
    enableAuthStatus?: boolean | undefined
    agent?: string | undefined
    /** 设置并保存 set SDK Status 对应的数据或状态。 */
    setSDKStatus?: (status: SDKStatus) => void
    promptSuggestions?: boolean | undefined
    workload?: string | undefined
  },
  turnInterruptionState?: TurnInterruptionState,
): AsyncIterable<StdoutMessage> {
  let running = false
  let runPhase:
    | 'draining_commands'
    | 'waiting_for_agents'
    | 'finally_flush'
    | 'finally_post_flush'
    | undefined
  let inputClosed = false
  let shutdownPromptInjected = false
  let heldBackResult: StdoutMessage | null = null
  let abortController: AbortController | undefined
  // 相同的队列sendRequest()入队——所有内容一个FIFO。
  const output = structuredIO.outbound

  // 在-p模式下按Ctrl+C：中止正在进行的查询，然后优雅关闭。
  // gracefulShutdown持久化会话状态并刷新可观测性数据，带有一个故障安全定时器，如果清理挂起则强制退出。
  const sigintHandler = () => {
    logForDiagnosticsNoPII('info', 'shutdown_signal', { signal: 'SIGINT' })
    if (abortController && !abortController.signal.aborted) {
      abortController.abort()
    }
    void gracefulShutdown(0)
  }
  process.on('SIGINT', sigintHandler)

  // 在SIGTERM时转储run()的状态，以便卡住会话的运行状况检查可以命名
  // do/while(waitingForAgents)轮询而无需读取转录。
  registerCleanup(async () => {
    const bg: Record<string, number> = {}
    for (const t of getRunningTasks(getAppState())) {
      if (isBackgroundTask(t)) bg[t.type] = (bg[t.type] ?? 0) + 1
    }
    logForDiagnosticsNoPII('info', 'run_state_at_shutdown', {
      run_active: running,
      run_phase: runPhase,
      worker_status: getSessionState(),
      bg_tasks: bg,
    })
  })

  // 将中央onChangeAppState模式差异钩子连接到SDK输出流。
  // 每当任何代码路径改变toolPermissionContext.mode时触发——
  // Shift+Tab、ExitPlanMode对话框、/plan斜杠命令、回退、bridge
  // set_permission_mode、查询循环、stop_task——而不是之前通过定制包装器的两个路径。
  // 该包装器的主体完全冗余（它在此处入队并调用
  // notifySessionMetadataChanged，这两个onChangeAppState现在都已覆盖）；
  // 保留它会双重发出状态消息。
  setPermissionModeChangedListener(newMode => {
    // 仅为SDK暴露的模式发出。
    if (
      newMode === 'default' ||
      newMode === 'acceptEdits' ||
      newMode === 'bypassPermissions' ||
      newMode === 'plan' ||
      newMode === (feature('TRANSCRIPT_CLASSIFIER') && 'auto') ||
      newMode === 'dontAsk'
    ) {
      output.enqueue({
        type: 'system',
        subtype: 'status',
        status: null,
        permissionMode: newMode as PermissionMode,
        uuid: randomUUID(),
        session_id: getSessionId(),
      })
    }
  })

  // 提示建议状态（推送模式）
  const suggestionState: {
    abortController: AbortController | null
    inflightPromise: Promise<void> | null
    pendingSuggestion: {
      type: 'prompt_suggestion'
      suggestion: string
      uuid: UUID
      session_id: string
    } | null
  } = {
    abortController: null,
    inflightPromise: null,
    pendingSuggestion: null,
  }

  // 如果启用，设置AWS认证状态监听器
  let unsubscribeAuthStatus: (() => void) | undefined
  if (options.enableAuthStatus) {
    const authStatusManager = AwsAuthStatusManager.getInstance()
    unsubscribeAuthStatus = authStatusManager.subscribe(status => {
      output.enqueue({
        type: 'auth_status',
        isAuthenticating: status.isAuthenticating,
        output: status.output,
        error: status.error,
        uuid: randomUUID(),
        session_id: getSessionId(),
      })
    })
  }

  // 用于内部跟踪的消息，由ask()直接修改。这些消息
  // 包括Assistant、User、Attachment和Progress消息。
  // ask() 会在运行期间追加消息，因此在此复制输入，避免修改调用方持有的初始数组。
  const mutableMessages: Message[] = [...initialMessages]

  // 从转录中种子化readFileState缓存（模型看到的内容，
  // 带有消息时间戳），以便getChangedFiles可以检测外部编辑。
  // 此缓存实例必须在ask()调用之间持久存在，因为编辑工具
  // 依赖它作为全局状态。
  let readFileState = extractReadFilesFromMessages(
    initialMessages,
    cwd(),
    READ_FILE_STATE_CACHE_SIZE,
  )

  // 客户端提供的readFileState种子（通过seed_read_state控制请求）。
  // stdin IIFE与ask()并发运行——如果直接在readFileState中写入，
  // 中途到达的种子会在ask()的克隆-替换（QueryEngine.ts的finally块）中丢失。
  // 相反，种子会落在这里，合并到getReadFileCache的视图（readFileState胜出：种子填充空缺），
  // 然后在setReadFileCache中重新应用然后清除。一次性：每个种子
  // 恰好存活一个克隆-替换周期，然后成为常规的readFileState条目，
  // 像其他所有内容一样受compact的清除影响。
  const pendingSeeds = createFileStateCacheWithSizeLimit(
    READ_FILE_STATE_CACHE_SIZE,
  )

  // 自动恢复中断的轮次，重启后 CC 从中断处继续执行，无需 SDK 重新发送提示。
  const resumeInterruptedTurnEnv =
    process.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN
  if (
    turnInterruptionState &&
    turnInterruptionState.kind !== 'none' &&
    resumeInterruptedTurnEnv
  ) {
    logForDebugging(
      `[print.ts] Auto-resuming interrupted turn (kind: ${turnInterruptionState.kind})`,
    )

    // 移除中断消息及其哨兵，然后重新排队，使模型仅看到一次。对于回合中中断，反序列化层通过附加合成消息“从你停下的地方继续”将其转换为 interrupted_prompt。
    removeInterruptedMessage(mutableMessages, turnInterruptionState.message)
    enqueue({
      mode: 'prompt',
      value: turnInterruptionState.message.message.content,
      uuid: randomUUID(),
    })
  }

  const modelOptions = getModelOptions()
  /** 执行 model Infos 对应的业务处理。 */
  const modelInfos = modelOptions.map(option => {
    const modelId = option.value === null ? 'default' : option.value
    const resolvedModel =
      modelId === 'default'
        ? getDefaultMainLoopModel()
        : parseUserSpecifiedModel(modelId)
    const hasEffort = modelSupportsEffort(resolvedModel)
    const hasAdaptiveThinking = modelSupportsAdaptiveThinking(resolvedModel)
    const hasFastMode = isFastModeSupportedByModel(option.value)
    const hasAutoMode = modelSupportsAutoMode(resolvedModel)
    return {
      value: modelId,
      displayName: option.label,
      description: option.description,
      ...(hasEffort && {
        supportsEffort: true,
        supportedEffortLevels: modelSupportsMaxEffort(resolvedModel)
          ? [...EFFORT_LEVELS]
          : EFFORT_LEVELS.filter(l => l !== 'max'),
      }),
      ...(hasAdaptiveThinking && { supportsAdaptiveThinking: true }),
      ...(hasFastMode && { supportsFastMode: true }),
      ...(hasAutoMode && { supportsAutoMode: true }),
    }
  })
  let activeUserSpecifiedModel = options.userSpecifiedModel

  /** 执行 inject Model Switch Breadcrumbs 对应的业务处理。 */
  function injectModelSwitchBreadcrumbs(
    modelArg: string,
    resolvedModel: string,
  ): void {
    const breadcrumbs = createModelSwitchBreadcrumbs(
      modelArg,
      modelDisplayString(resolvedModel),
    )
    mutableMessages.push(...breadcrumbs)
    for (const crumb of breadcrumbs) {
      if (
        typeof crumb.message.content === 'string' &&
        crumb.message.content.includes(`<${LOCAL_COMMAND_STDOUT_TAG}>`)
      ) {
        output.enqueue({
          type: 'user',
          message: crumb.message,
          session_id: getSessionId(),
          parent_tool_use_id: null,
          uuid: crumb.uuid,
          timestamp: crumb.timestamp,
          isReplay: true,
        } satisfies SDKUserMessageReplay)
      }
    }
  }

  // 缓存 SDK MCP 客户端，避免每次运行时重新连接
  let sdkClients: MCPServerConnection[] = []
  let sdkTools: Tools = []

  // 跟踪哪些 MCP 客户端已注册 elicitation 处理程序
  const elicitationRegistered = new Set<string>()

  /**
   * 在已连接但尚未注册 elicitation 的 MCP 客户端上注册 elicitation 请求/完成处理程序。排除 SDK MCP 服务器，因为它们通过 SdkControlClientTransport 路由。钩子先运行（匹配 REPL 行为）；如果没有钩子响应，则通过控制协议将请求转发给 SDK 消费者。
   */
  function registerElicitationHandlers(clients: MCPServerConnection[]): void {
    for (const connection of clients) {
      if (
        connection.type !== 'connected' ||
        elicitationRegistered.has(connection.name)
      ) {
        continue
      }
      // 跳过 SDK MCP 服务器——elicitation 通过 SdkControlClientTransport 流转
      if (connection.config.type === 'sdk') {
        continue
      }
      const serverName = connection.name

      // 包裹在 try/catch 中，因为如果客户端创建时未声明 elicitation 能力（例如 SDK 创建的客户端），setRequestHandler 会抛出异常。
      try {
        connection.client.setRequestHandler(
          ElicitRequestSchema,
          async (request, extra) => {
            logMCPDebug(
              serverName,
              `Elicitation request received in print mode: ${jsonStringify(request)}`,
            )

            const mode = request.params.mode === 'url' ? 'url' : 'form'


            // 首先运行 elicitation 钩子——它们可以编程方式提供响应
            const hookResponse = await runElicitationHooks(
              serverName,
              request.params,
              extra.signal,
            )
            if (hookResponse) {
              logMCPDebug(
                serverName,
                `Elicitation resolved by hook: ${jsonStringify(hookResponse)}`,
              )
              return hookResponse
            }

            // 通过控制协议委托给 SDK 消费者
            const url =
              'url' in request.params
                ? (request.params.url as string)
                : undefined
            const requestedSchema =
              'requestedSchema' in request.params
                ? (request.params.requestedSchema as
                    | Record<string, unknown>
                    | undefined)
                : undefined

            const elicitationId =
              'elicitationId' in request.params
                ? (request.params.elicitationId as string | undefined)
                : undefined

            const rawResult = await structuredIO.handleElicitation(
              serverName,
              request.params.message,
              requestedSchema,
              extra.signal,
              mode,
              url,
              elicitationId,
            )

            const result = await runElicitationResultHooks(
              serverName,
              rawResult,
              extra.signal,
              mode,
              elicitationId,
            )

            return result
          },
        )

        // 向 SDK 消费者呈现完成通知（URL 模式）
        connection.client.setNotificationHandler(
          ElicitationCompleteNotificationSchema,
          notification => {
            const { elicitationId } = notification.params
            logMCPDebug(
              serverName,
              `Elicitation completion notification: ${elicitationId}`,
            )
            void executeNotificationHooks({
              message: `MCP server "${serverName}" confirmed elicitation ${elicitationId} complete`,
              notificationType: 'elicitation_complete',
            })
            output.enqueue({
              type: 'system',
              subtype: 'elicitation_complete',
              mcp_server_name: serverName,
              elicitation_id: elicitationId,
              uuid: randomUUID(),
              session_id: getSessionId(),
            })
          },
        )

        elicitationRegistered.add(serverName)
      } catch {
        // 如果客户端创建时未声明 elicitation 能力，setRequestHandler 会抛出异常——静默跳过
      }
    }
  }

  /** 更新 update Sdk Mcp 对应的数据或状态。 */
  async function updateSdkMcp() {
    // 检查是否需要更新 SDK MCP 服务器（新增或移除服务器）
    const currentServerNames = new Set(Object.keys(sdkMcpConfigs))
    const connectedServerNames = new Set(sdkClients.map(c => c.name))

    // 检查是否存在任何差异（新增或移除）
    const hasNewServers = Array.from(currentServerNames).some(
      name => !connectedServerNames.has(name),
    )
    /** 判断是否满足 has Removed Servers 对应的数据或状态。 */
    const hasRemovedServers = Array.from(connectedServerNames).some(
      name => !currentServerNames.has(name),
    )
    // 检查是否有 SDK 客户端待处理且需要升级
    const hasPendingSdkClients = sdkClients.some(c => c.type === 'pending')
    // 检查是否有 SDK 客户端握手失败需要重试。否则，进入“failed”状态的客户端（例如在 WebSocket 重连竞争时握手超时）将永远保持失败状态——其名称满足 connectedServerNames 差异，但贡献零个工具。
    const hasFailedSdkClients = sdkClients.some(c => c.type === 'failed')

    const haveServersChanged =
      hasNewServers ||
      hasRemovedServers ||
      hasPendingSdkClients ||
      hasFailedSdkClients

    if (haveServersChanged) {
      // 清理已移除的服务器
      for (const client of sdkClients) {
        if (!currentServerNames.has(client.name)) {
          if (client.type === 'connected') {
            await client.cleanup()
          }
        }
      }

      // 使用当前配置重新初始化所有 SDK MCP 服务器
      const sdkSetup = await setupSdkMcpClients(
        sdkMcpConfigs,
        (serverName, message) =>
          structuredIO.sendMcpMessage(serverName, message),
      )
      sdkClients = sdkSetup.clients
      sdkTools = sdkSetup.tools

      // 将 SDK MCP 工具存储在 appState 中，以便子代理通过 assembleToolPool 访问它们。此处仅存储工具——SDK 客户端已经在查询循环（allMcpClients）和 mcp_status 处理程序中单独合并。使用旧的（connectedServerNames）和新的（currentServerNames）来在服务器添加或移除时移除过时的 SDK 工具。
      const allSdkNames = uniq([...connectedServerNames, ...currentServerNames])
      setAppState(prev => ({
        ...prev,
        mcp: {
          ...prev.mcp,
          tools: [
            ...prev.mcp.tools.filter(
              t =>
                !allSdkNames.some(name =>
                  t.name.startsWith(getMcpPrefix(name)),
                ),
            ),
            ...sdkTools,
          ],
        },
      }))

      // 必要时设置特殊的内部 VSCode MCP 服务器。
      setupVscodeSdkMcp(sdkClients)
    }
  }

  void updateSdkMcp()

  // 动态添加的 MCP 服务器（通过 mcp_set_servers 控制消息）的状态。这些与 SDK MCP 服务器分开，并支持所有传输类型
  let dynamicMcpState: DynamicMcpState = {
    clients: [],
    tools: [],
    configs: {},
  }

  // ask() 和 get_context_usage 控制请求共享的工具组装。关闭可变 sdkTools/dynamicMcpState 绑定，以便两个调用点都能看到延迟连接的服务器。
  const buildAllTools = (appState: AppState): Tools => {
    const assembledTools = assembleToolPool(
      appState.toolPermissionContext,
      appState.mcp.tools,
    )
    let allTools = uniqBy(
      mergeAndFilterTools(
        [...tools, ...sdkTools, ...dynamicMcpState.tools],
        assembledTools,
        appState.toolPermissionContext.mode,
      ),
      'name',
    )
    if (options.permissionPromptToolName) {
      allTools = allTools.filter(
        tool => !toolMatchesName(tool, options.permissionPromptToolName!),
      )
    }
    const initJsonSchema = getInitJsonSchema()
    if (initJsonSchema && !options.jsonSchema) {
      const syntheticOutputResult = createSyntheticOutputTool(initJsonSchema)
      if ('tool' in syntheticOutputResult) {
        allTools = [...allTools, syntheticOutputResult.tool]
      }
    }
    return allTools
  }

  // 应用 MCP 服务器更改的辅助函数——由 mcp_set_servers 控制消息和后台插件安装使用。注意：需要嵌套函数——改变闭包状态（sdkMcpConfigs, sdkClients 等）。
  let mcpChangesPromise: Promise<{
    response: SDKControlMcpSetServersResponse
    sdkServersChanged: boolean
  }> = Promise.resolve({
    response: {
      added: [] as string[],
      removed: [] as string[],
      errors: {} as Record<string, string>,
    },
    sdkServersChanged: false,
  })

  /** 执行 apply Mcp Server Changes 对应的业务处理。 */
  function applyMcpServerChanges(
    servers: Record<string, McpServerConfigForProcessTransport>,
  ): Promise<{
    response: SDKControlMcpSetServersResponse
    sdkServersChanged: boolean
  }> {
    // 序列化调用以防止并发调用者（后台插件安装和 mcp_set_servers 控制消息）之间的竞态条件
    const doWork = async (): Promise<{
      response: SDKControlMcpSetServersResponse
      sdkServersChanged: boolean
    }> => {
      const oldSdkClientNames = new Set(sdkClients.map(c => c.name))

      const result = await handleMcpSetServers(
        servers,
        { configs: sdkMcpConfigs, clients: sdkClients, tools: sdkTools },
        dynamicMcpState,
        setAppState,
      )

      // 更新 SDK 状态（需要改变 sdkMcpConfigs，因为它是共享的）
      for (const key of Object.keys(sdkMcpConfigs)) {
        delete sdkMcpConfigs[key]
      }
      Object.assign(sdkMcpConfigs, result.newSdkState.configs)
      sdkClients = result.newSdkState.clients
      sdkTools = result.newSdkState.tools
      dynamicMcpState = result.newDynamicState

      // 保持appState.mcp.tools同步，以便子代理可以看到SDK MCP工具。使用新旧SDK客户端名称移除过时的工具。
      if (result.sdkServersChanged) {
        const newSdkClientNames = new Set(sdkClients.map(c => c.name))
        const allSdkNames = uniq([...oldSdkClientNames, ...newSdkClientNames])
        setAppState(prev => ({
          ...prev,
          mcp: {
            ...prev.mcp,
            tools: [
              ...prev.mcp.tools.filter(
                t =>
                  !allSdkNames.some(name =>
                    t.name.startsWith(getMcpPrefix(name)),
                  ),
              ),
              ...sdkTools,
            ],
          },
        }))
      }

      return {
        response: result.response,
        sdkServersChanged: result.sdkServersChanged,
      }
    }

    mcpChangesPromise = mcpChangesPromise.then(doWork, doWork)
    return mcpChangesPromise
  }

  // 为控制响应构建McpServerStatus[]。由mcp_status和reload_plugins处理程序共享。读取闭包状态：sdkClients, dynamicMcpState。
  function buildMcpServerStatuses(): McpServerStatus[] {
    const currentAppState = getAppState()
    const currentMcpClients = currentAppState.mcp.clients
    const allMcpTools = uniqBy(
      [...currentAppState.mcp.tools, ...dynamicMcpState.tools],
      'name',
    )
    const existingNames = new Set([
      ...currentMcpClients.map(c => c.name),
      ...sdkClients.map(c => c.name),
    ])
    return [
      ...currentMcpClients,
      ...sdkClients,
      ...dynamicMcpState.clients.filter(c => !existingNames.has(c.name)),
    ].map(connection => {
      let config
      if (
        connection.config.type === 'sse' ||
        connection.config.type === 'http'
      ) {
        config = {
          type: connection.config.type,
          url: connection.config.url,
          headers: connection.config.headers,
          oauth: connection.config.oauth,
        }
      } else if (
        connection.config.type === 'stdio' ||
        connection.config.type === undefined
      ) {
        config = {
          type: 'stdio' as const,
          command: connection.config.command,
          args: connection.config.args,
        }
      }
      const serverTools =
        connection.type === 'connected'
          ? filterToolsByServer(allMcpTools, connection.name).map(tool => ({
              name: tool.mcpInfo?.toolName ?? tool.name,
              annotations: {
                readOnly: tool.isReadOnly({}) || undefined,
                destructive: tool.isDestructive?.({}) || undefined,
                openWorld: tool.isOpenWorld?.({}) || undefined,
              },
            }))
          : undefined
      // 带允许列表预过滤的功能透传。IDE读取experimental['claude/channel']以决定是否显示"启用频道"提示——仅在channel_enable实际通过允许列表时才回显它。这不是安全边界（处理程序会重新运行完整门控）；只是避免死按钮。
      let capabilities: { experimental?: Record<string, unknown> } | undefined
      if (
        (feature('MCP_CHANNELS')) &&
        connection.type === 'connected' &&
        connection.capabilities.experimental
      ) {
        const exp = { ...connection.capabilities.experimental }
        if (
          exp['claude/channel'] &&
          (!isChannelsEnabled() ||
            !isChannelAllowlisted(connection.config.pluginSource))
        ) {
          delete exp['claude/channel']
        }
        if (Object.keys(exp).length > 0) {
          capabilities = { experimental: exp }
        }
      }
      return {
        name: connection.name,
        status: connection.type,
        serverInfo:
          connection.type === 'connected' ? connection.serverInfo : undefined,
        error: connection.type === 'failed' ? connection.error : undefined,
        config,
        scope: connection.config.scope,
        tools: serverTools,
        capabilities,
      }
    })
  }

  // 注意：需要嵌套函数——需要闭包访问applyMcpServerChanges和updateSdkMcp
  async function installPluginsAndApplyMcpInBackground(): Promise<void> {
    try {
      const pluginsInstalled = await installPluginsForHeadless()

      if (pluginsInstalled) {
        await applyPluginMcpDiff()
      }
    } catch (error) {
      logError(error)
    }
  }

  // 所有无头用户的插件后台安装。从extraKnownMarketplaces安装市场插件，并安装缺失的已启用插件。CLAUDE_CODE_SYNC_PLUGIN_INSTALL=true：在第一次查询前的run()中解析，确保插件在第一次ask()时可用。
  let pluginInstallPromise: Promise<void> | null = null
  // --bare / SIMPLE：跳过插件安装。脚本调用在会话期间不添加插件；下次交互式运行时会同步。
  if (!isBareMode()) {
    if (isEnvTruthy(process.env.CLAUDE_CODE_SYNC_PLUGIN_INSTALL)) {
      pluginInstallPromise = installPluginsAndApplyMcpInBackground()
    } else {
      void installPluginsAndApplyMcpInBackground()
    }
  }

  // 空闲超时管理
  const idleTimeout = createIdleTimeoutManager(() => !running)

  // 用于热重载的可变命令和代理
  let currentCommands = commands
  let currentAgents = agents

  // 清除所有插件相关缓存，重新加载命令/代理/钩子。在CLAUDE_CODE_SYNC_PLUGIN_INSTALL完成后（首次查询前）以及非同步后台安装完成后调用。refreshActivePlugins调用clearAllCaches()，这是因为loadAllPlugins()可能在main.tsx启动时、在获取托管设置之前已经运行。如果不清除，getCommands()将根据过时的插件列表重建。
  async function refreshPluginState(): Promise<void> {
    // refreshActivePlugins处理完全缓存清理(clearAllCaches)，重新加载所有插件组件加载器，写入AppState.plugins和AppState.agentDefinitions，注册钩子，并增加mcp.pluginReconnectKey。
    const { agentDefinitions: freshAgentDefs } =
      await refreshActivePlugins(setAppState)

    // 无头特定：currentCommands/currentAgents是由查询循环捕获的本地可变引用（REPL使用AppState代替）。getCommands是新鲜的，因为refreshActivePlugins清除了它的缓存。
    currentCommands = await getCommands(cwd())

    // 保留SDK提供的代理（--agents CLI标志或SDK初始化control_request）——两者都通过parseAgentsFromJson注入，source='flagSettings'。loadMarkdownFilesForSubdir从不分配此来源，因此它清楚地识别出"注入的，不可从磁盘加载"。
    //
    // 之前的过滤器使用负集合差集(!freshAgentTypes.has(a))，这也匹配了在受污染的初始currentAgents中的插件代理，但在应用托管设置后正确地将其从freshAgentDefs中排除——导致策略阻止的代理泄漏到初始化消息中。参见gh-23085：在Commander定义时，isBridgeEnabled()在setEligibility(true)运行之前污染了设置缓存。
    const sdkAgents = currentAgents.filter(a => a.source === 'flagSettings')
    currentAgents = [...freshAgentDefs.allAgents, ...sdkAgents]
  }

  // 插件状态更改后重新比较MCP配置。过滤到process-transport-supported类型并携带SDK模式服务器，以便applyMcpServerChanges的差异比较不会关闭它们的传输。嵌套：需要闭包访问sdkMcpConfigs, applyMcpServerChanges, updateSdkMcp。
  async function applyPluginMcpDiff(): Promise<void> {
    const { servers: newConfigs } = await getAllMcpConfigs()
    const supportedConfigs: Record<string, McpServerConfigForProcessTransport> =
      {}
    for (const [name, config] of Object.entries(newConfigs)) {
      const type = config.type
      if (
        type === undefined ||
        type === 'stdio' ||
        type === 'sse' ||
        type === 'http' ||
        type === 'sdk'
      ) {
        supportedConfigs[name] = config
      }
    }
    for (const [name, config] of Object.entries(sdkMcpConfigs)) {
      if (config.type === 'sdk' && !(name in supportedConfigs)) {
        supportedConfigs[name] = config
      }
    }
    const { response, sdkServersChanged } =
      await applyMcpServerChanges(supportedConfigs)
    if (sdkServersChanged) {
      void updateSdkMcp()
    }
    logForDebugging(
      `Headless MCP refresh: added=${response.added.length}, removed=${response.removed.length}`,
    )
  }

  // 订阅技能变化以进行热重载
  const unsubscribeSkillChanges = skillChangeDetector.subscribe(() => {
    clearCommandsCache()
    void getCommands(cwd()).then(newCommands => {
      currentCommands = newCommands
    })
  })

  // 主动模式：安排一个tick以保持模型自主循环。setTimeout(0)让出事件循环，以便待处理的stdin消息（中断、用户消息）在tick触发之前得到处理。
  const scheduleProactiveTick =
    feature('PROACTIVE')
      ? () => {
          setTimeout(() => {
            if (
              !proactiveModule?.isProactiveActive() ||
              proactiveModule.isProactivePaused() ||
              inputClosed
            ) {
              return
            }
            const tickContent = `<${TICK_TAG}>${new Date().toLocaleTimeString()}</${TICK_TAG}>`
            enqueue({
              mode: 'prompt' as const,
              value: tickContent,
              uuid: randomUUID(),
              priority: 'later',
              isMeta: true,
            })
            void run()
          }, 0)
        }
      : undefined

  // 当收到'now'优先级的消息时中止当前操作。
  subscribeToCommandQueue(() => {
    if (abortController && getCommandsByMaxPriority('now').length > 0) {
      abortController.abort('interrupt')
    }
  })

  /** 执行 run 对应的数据或状态。 */
  const run = async () => {
    if (running) {
      return
    }

    running = true
    runPhase = undefined
    notifySessionStateChanged('running')
    idleTimeout.stop()

    headlessProfilerCheckpoint('run_entry')
    // 首次查询前刷新 SDK MCP 工具，使初始化后动态提供的服务器进入工具池。
    await updateSdkMcp()
    headlessProfilerCheckpoint('after_updateSdkMcp')

    // 解析延迟的插件安装(CLAUDE_CODE_SYNC_PLUGIN_INSTALL)。promise被急切地启动，以便安装与其他初始化重叠。在此处等待确保插件在第一次ask()之前可用。如果设置了CLAUDE_CODE_SYNC_PLUGIN_INSTALL_TIMEOUT_MS，则与该截止时间竞态，超时后不带插件继续（记录错误）。
    if (pluginInstallPromise) {
      const timeoutMs = parseInt(
        process.env.CLAUDE_CODE_SYNC_PLUGIN_INSTALL_TIMEOUT_MS || '',
        10,
      )
      if (timeoutMs > 0) {
        /** 执行 timeout 对应的业务处理。 */
        const timeout = sleep(timeoutMs).then(() => 'timeout' as const)
        const result = await Promise.race([pluginInstallPromise, timeout])
        if (result === 'timeout') {
          logError(
            new Error(
              `CLAUDE_CODE_SYNC_PLUGIN_INSTALL: plugin installation timed out after ${timeoutMs}ms`,
            ),
          )
        }
      } else {
        await pluginInstallPromise
      }
      pluginInstallPromise = null

      // 既然插件已安装，刷新命令、代理和钩子
      await refreshPluginState()

      // 既然初始安装已完成，为插件钩子设置热重载。在同步安装模式下，setup.ts跳过此项以避免与安装竞态。
      const { setupPluginHookHotReload } = await import(
        '../utils/plugins/loadPluginHooks.js'
      )
      setupPluginHookHotReload()
    }

    // 仅主线程命令（agentId===undefined）——子代理通知由子代理在query.ts中的回合中门控排出。定义在try块外部，以便在run()底部的finally后队列重新检查中可访问。
    const isMainThread = (cmd: QueuedCommand) => cmd.agentId === undefined

    try {
      let command: QueuedCommand | undefined
      let waitingForAgents = false

      // 将命令处理提取到命名函数中以实现do-while模式。排出队列，将连续的提示模式命令批量合并为一次ask()调用，以便在长时间轮次中排队等待的消息合并为单个后续轮次，而不是N个单独的轮次。
      const drainCommandQueue = async () => {
        while ((command = dequeue(isMainThread))) {
          if (
            command.mode !== 'prompt' &&
            command.mode !== 'orphaned-permission' &&
            command.mode !== 'task-notification'
          ) {
            throw new Error(
              'only prompt commands are supported in streaming mode',
            )
          }

          // 非提示命令（task-notification，orphaned-permission）携带副作用或orphanedPermission状态，因此单独处理。提示命令贪婪地收集具有匹配工作负载的后续命令。
          const batch: QueuedCommand[] = [command]
          if (command.mode === 'prompt') {
            while (canBatchWith(command, peek(isMainThread))) {
              batch.push(dequeue(isMainThread)!)
            }
            if (batch.length > 1) {
              command = {
                ...command,
                /** 执行 value 对应的业务处理。 */
                value: joinPromptValues(batch.map(c => c.value)),
                uuid: batch.findLast(c => c.uuid)?.uuid ?? command.uuid,
              }
            }
          }
          /** 执行 batch Uuids 对应的业务处理。 */
          const batchUuids = batch.map(c => c.uuid).filter(u => u !== undefined)

          // QueryEngine将通过其messagesToAck路径为command.uuid（批处理中的最后一个uuid）发出重放。在此处为其余uuid发出重放，以便跟踪逐uuid传递的消费者（clank's）不仅限于合并后幸存的那个。
          if (options.replayUserMessages && batch.length > 1) {
            for (const c of batch) {
              if (c.uuid && c.uuid !== command.uuid) {
                output.enqueue({
                  type: 'user',
                  message: { role: 'user', content: c.value },
                  session_id: getSessionId(),
                  parent_tool_use_id: null,
                  uuid: c.uuid,
                  isReplay: true,
                } satisfies SDKUserMessageReplay)
              }
            }
          }

          // 合并所有 MCP 客户端。`appState.mcp` 由 `main.tsx` 逐步填充（镜像 `useManageMCPConnections`）。每次命令读取时重新获取，使得延迟连接的服务器在下一轮可见。`registerElicitationHandlers` 是幂等的（通过集合追踪）。
          const appState = getAppState()
          const allMcpClients = [
            ...appState.mcp.clients,
            ...sdkClients,
            ...dynamicMcpState.clients,
          ]
          registerElicitationHandlers(allMcpClients)
          // 在构建时通过 `--channels` 列入允许列表的服务器通道处理器（或通过 `enableChannel()` 在会话中启用）。每轮运行，如同 `registerElicitationHandlers` —— 每个客户端幂等（`setNotificationHandler` 替换而非堆叠），对未列入允许列表的服务器无操作（一次特性开关检查）。
          for (const client of allMcpClients) {
            reregisterChannelHandlerAfterReconnect(client)
          }

          const allTools = buildAllTools(appState)

          for (const uuid of batchUuids) {
            notifyCommandLifecycle(uuid, 'started')
          }

          // 任务通知在后台代理完成时到达。为 SDK 消费者发出 SDK 系统事件，然后回退到 `ask()`，以便模型看到代理结果并据此操作。这与 TUI 行为匹配：`useQueueProcessor` 始终向模型提供通知，无论协调器模式如何。
          if (command.mode === 'task-notification') {
            const notificationText =
              typeof command.value === 'string' ? command.value : ''
            // 解析 XML 格式的通知
            const taskIdMatch = notificationText.match(
              /<task-id>([^<]+)<\/task-id>/,
            )
            const toolUseIdMatch = notificationText.match(
              /<tool-use-id>([^<]+)<\/tool-use-id>/,
            )
            const outputFileMatch = notificationText.match(
              /<output-file>([^<]+)<\/output-file>/,
            )
            const statusMatch = notificationText.match(
              /<status>([^<]+)<\/status>/,
            )
            const summaryMatch = notificationText.match(
              /<summary>([^<]+)<\/summary>/,
            )

            /** 判断是否满足 is Valid Status 对应的数据或状态。 */
            const isValidStatus = (
              s: string | undefined,
            ): s is 'completed' | 'failed' | 'stopped' | 'killed' =>
              s === 'completed' ||
              s === 'failed' ||
              s === 'stopped' ||
              s === 'killed'
            const rawStatus = statusMatch?.[1]
            const status = isValidStatus(rawStatus)
              ? rawStatus === 'killed'
                ? 'stopped'
                : rawStatus
              : 'completed'

            const usageMatch = notificationText.match(
              /<usage>([\s\S]*?)<\/usage>/,
            )
            const usageContent = usageMatch?.[1] ?? ''
            const totalTokensMatch = usageContent.match(
              /<total_tokens>(\d+)<\/total_tokens>/,
            )
            const toolUsesMatch = usageContent.match(
              /<tool_uses>(\d+)<\/tool_uses>/,
            )
            const durationMsMatch = usageContent.match(
              /<duration_ms>(\d+)<\/duration_ms>/,
            )

            // 仅在存在 `<status>` 标签时发出 `task_notification` SDK 事件——这意味着这是终端通知（已完成/失败/已停止）。来自 `enqueueStreamEvent` 的流事件不带 `<status>`（它们是进度心跳）；在此处发出它们将默认设置为 'completed' 并错误地关闭 SDK 消费者的任务。终端书签现在通过 `emitTaskTerminatedSdk` 直接发出，因此跳过无状态事件是安全的。
            if (statusMatch) {
              output.enqueue({
                type: 'system',
                subtype: 'task_notification',
                task_id: taskIdMatch?.[1] ?? '',
                tool_use_id: toolUseIdMatch?.[1],
                status,
                output_file: outputFileMatch?.[1] ?? '',
                summary: summaryMatch?.[1] ?? '',
                usage:
                  totalTokensMatch && toolUsesMatch
                    ? {
                        total_tokens: parseInt(totalTokensMatch[1]!, 10),
                        tool_uses: parseInt(toolUsesMatch[1]!, 10),
                        duration_ms: durationMsMatch
                          ? parseInt(durationMsMatch[1]!, 10)
                          : 0,
                      }
                    : undefined,
                session_id: getSessionId(),
                uuid: randomUUID(),
              })
            }
            // 不继续——回退到 `ask()` 让模型处理结果
          }

          const input = command.value

          // 中止任何正在进行的建议生成。
          suggestionState.abortController?.abort()
          suggestionState.abortController = null
          suggestionState.pendingSuggestion = null

          abortController = createAbortController()
          headlessProfilerCheckpoint('before_ask')
          startQueryProfile()
          // 每迭代的 ALS 上下文，使在 `ask()` 内产生的后台代理在其分离的 await 中继承工作负载。进程内 cron 标记 `cmd.workload`；SDK `--workload` 标志是 `options.workload`。const 捕获：TS 在闭包内丢失 `while ((command = dequeue()))` 的窄化。
          const cmd = command
          await runWithWorkload(cmd.workload ?? options.workload, async () => {
            for await (const message of ask({
              commands: uniqBy(
                [...currentCommands, ...appState.mcp.commands],
                'name',
              ),
              prompt: input,
              promptUuid: cmd.uuid,
              isMeta: cmd.isMeta,
              cwd: cwd(),
              tools: allTools,
              verbose: options.verbose,
              mcpClients: allMcpClients,
              thinkingConfig: options.thinkingConfig,
              maxTurns: options.maxTurns,
              maxBudgetUsd: options.maxBudgetUsd,
              taskBudget: options.taskBudget,
              canUseTool,
              userSpecifiedModel: activeUserSpecifiedModel,
              fallbackModel: options.fallbackModel,
              jsonSchema: getInitJsonSchema() ?? options.jsonSchema,
              mutableMessages,
              /** 获取 get Read File Cache 对应的数据或状态。 */
              getReadFileCache: () =>
                pendingSeeds.size === 0
                  ? readFileState
                  : mergeFileStateCaches(readFileState, pendingSeeds),
              /** 设置并保存 set Read File Cache 对应的数据或状态。 */
              setReadFileCache: cache => {
                readFileState = cache
                for (const [path, seed] of pendingSeeds.entries()) {
                  const existing = readFileState.get(path)
                  if (!existing || seed.timestamp > existing.timestamp) {
                    readFileState.set(path, seed)
                  }
                }
                pendingSeeds.clear()
              },
              customSystemPrompt: options.systemPrompt,
              appendSystemPrompt: options.appendSystemPrompt,
              getAppState,
              setAppState,
              abortController,
              replayUserMessages: options.replayUserMessages,
              includePartialMessages: options.includePartialMessages,
              /** 处理 handle Elicitation 对应的数据或状态。 */
              handleElicitation: (serverName, params, elicitSignal) =>
                structuredIO.handleElicitation(
                  serverName,
                  params.message,
                  undefined,
                  elicitSignal,
                  params.mode,
                  params.url,
                  'elicitationId' in params ? params.elicitationId : undefined,
                ),
              agents: currentAgents,
              orphanedPermission: cmd.orphanedPermission,
              /** 设置并保存 set SDK Status 对应的数据或状态。 */
              setSDKStatus: status => {
                output.enqueue({
                  type: 'system',
                  subtype: 'status',
                  status,
                  session_id: getSessionId(),
                  uuid: randomUUID(),
                })
              },
            })) {
              if (message.type === 'result') {
                // 刷新挂起的 SDK 事件，使它们出现在结果之前。
                for (const event of drainSdkEvents()) {
                  output.enqueue(event)
                }

                // 暂不发出：后台代理运行时不要发出结果
                const currentState = getAppState()
                if (
                  getRunningTasks(currentState).some(
                    t => t.type === 'local_agent' && isBackgroundTask(t),
                  )
                ) {
                  heldBackResult = message
                } else {
                  heldBackResult = null
                  output.enqueue(message)
                }
              } else {
                // 刷新 SDK 事件（task_started, task_progress），以便后台代理进度实时流式传输，而非等到结果时批量发出。
                for (const event of drainSdkEvents()) {
                  output.enqueue(event)
                }
                output.enqueue(message)
              }
            }
          }) // 结束 runWithWorkload

          for (const uuid of batchUuids) {
            notifyCommandLifecycle(uuid, 'completed')
          }

          // 生成并发出供 SDK 消费者使用的提示建议
          if (
            options.promptSuggestions &&
            !isEnvDefinedFalsy(process.env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION)
          ) {
            // TS 在 while 循环体中将 `suggestionState` 窄化为 `never`；通过 `unknown` 转换以重置窄化。
            const state = suggestionState as unknown as typeof suggestionState
            state.abortController?.abort()
            const localAbort = new AbortController()
            suggestionState.abortController = localAbort

            const cacheSafeParams = getLastCacheSafeParams()
            if (cacheSafeParams) {
              // 使用 ref 对象，使 IIFE 的 finally 块能与其自身的 promise 比较，而无需自引用（这会干扰 TypeScript 的流分析）。
              const ref: { promise: Promise<void> | null } = { promise: null }
              ref.promise = (async () => {
                try {
                  const result = await tryGenerateSuggestion(
                    localAbort,
                    mutableMessages,
                    getAppState,
                    cacheSafeParams,
                  )
                  if (!result || localAbort.signal.aborted) return
                  const suggestionMsg = {
                    type: 'prompt_suggestion' as const,
                    suggestion: result.suggestion,
                    uuid: randomUUID(),
                    session_id: getSessionId(),
                  }
                  // 如果结果因后台代理而暂缓发出，则延迟发出 `prompt_suggestion`，使其始终在结果之后到达。
                  if (heldBackResult) {
                    suggestionState.pendingSuggestion = suggestionMsg
                  } else {
                    output.enqueue(suggestionMsg)
                  }
                } catch (error) {
                  if (
                    error instanceof Error &&
                    (error.name === 'AbortError' ||
                      error.name === 'APIUserAbortError')
                  ) {
                    return
                  }
                  logError(toError(error))
                } finally {
                  if (suggestionState.inflightPromise === ref.promise) {
                    suggestionState.inflightPromise = null
                  }
                }
              })()
              suggestionState.inflightPromise = ref.promise
            }
          }

          // 记录本轮无头分析器指标并开始下一轮
          logHeadlessProfilerTurn()
          logQueryProfileReport()
          headlessProfilerStartTurn()
        }
      }

      // 使用 do-while 循环清空命令，然后等待仍在运行的后台代理。当代理完成时，它们的通知被入队，循环重新清空。
      do {
        // 在命令队列之前清空 SDK 事件（task_started, task_progress），使进度事件先于 task_notification 出现在流上。
        for (const event of drainSdkEvents()) {
          output.enqueue(event)
        }

        runPhase = 'draining_commands'
        await drainCommandQueue()

        // 在退出前检查正在运行的后台任务。排除 `in_process_teammate`——队友按设计长期运行（状态：'running' 贯穿整个生命周期，由关闭协议清理，而非通过转换为 'completed'）。在此处等待它们会导致无限循环（gh-30008）。相同的排除已存在于 `useBackgroundTaskNavigation.ts:55` 中，原因相同；上面的 L1839 已更窄（类型 === 'local_agent'），因此不会命中此处的逻辑。
        waitingForAgents = false
        {
          const state = getAppState()
          /** 判断是否满足 has Running Bg 对应的数据或状态。 */
          const hasRunningBg = getRunningTasks(state).some(
            t => isBackgroundTask(t) && t.type !== 'in_process_teammate',
          )
          const hasMainThreadQueued = peek(isMainThread) !== undefined
          if (hasRunningBg || hasMainThreadQueued) {
            waitingForAgents = true
            if (!hasMainThreadQueued) {
              runPhase = 'waiting_for_agents'
              // 尚无就绪的命令，等待任务完成
              await sleep(100)
            }
            // 循环返回以清空任何新入队的命令
          }
        }
      } while (waitingForAgents)

      if (heldBackResult) {
        output.enqueue(heldBackResult)
        heldBackResult = null
        if (suggestionState.pendingSuggestion) {
          output.enqueue(suggestionState.pendingSuggestion)
          suggestionState.pendingSuggestion = null
        }
      }
    } catch (error) {
      // 在关闭前发出错误结果消息。直接写入 `structuredIO` 以确保立即传递。
      try {
        await structuredIO.write({
          type: 'result',
          subtype: 'error_during_execution',
          duration_ms: 0,
          duration_api_ms: 0,
          is_error: true,
          num_turns: 0,
          stop_reason: null,
          session_id: getSessionId(),
          total_cost_usd: 0,
          usage: EMPTY_USAGE,
          modelUsage: {},
          permission_denials: [],
          uuid: randomUUID(),
          errors: [
            errorMessage(error),
            ...getInMemoryErrors().map(_ => _.error),
          ],
        })
      } catch {
        // 如果无法发出错误结果，仍继续关闭。
      }
      suggestionState.abortController?.abort()
      gracefulShutdownSync(1)
      return
    } finally {
      runPhase = 'finally_flush'
      runPhase = 'finally_post_flush'
      if (!isShuttingDown()) {
        notifySessionStateChanged('idle')
        // 排空以使空闲的 session_state_changed SDK 事件（以及 bg-agent 拆卸期间发出的任何终端 task_notification 书签）在我们阻塞等待下一个命令之前到达输出流。上述 do-while 排空仅在 waitingForAgents 时运行；一旦到达此处，下一个排空将是下一个 run() 的顶部，如果输入空闲则不会到来。
        for (const event of drainSdkEvents()) {
          output.enqueue(event)
        }
      }
      running = false
      // 当完成处理并等待输入时启动空闲计时器
      idleTimeout.start()
    }

    // 主动滴答：如果主动模式激活且队列为空，则注入一个滴答
    if (
      (feature('PROACTIVE')) &&
      proactiveModule?.isProactiveActive() &&
      !proactiveModule.isProactivePaused()
    ) {
      if (peek(isMainThread) === undefined && !inputClosed) {
        scheduleProactiveTick!()
        return
      }
    }

    // 释放互斥锁后重新检查队列。在上一次 dequeue() 返回 undefined 和上述 `running = false` 之间，可能有消息到达（并调用了 run()）。在这种情况下，调用者看到 `running === true` 并立即返回，使消息滞留在队列中无人处理。
    if (peek(isMainThread) !== undefined) {
      void run()
      return
    }

    // 检查未读的队友消息并处理它们。这模仿了 useInboxPoller 在交互式 REPL 模式中的行为。轮询直到没有更多消息（队友可能仍在工作）
    {
      const currentAppState = getAppState()
      const teamContext = currentAppState.teamContext

      if (teamContext && isTeamLead(teamContext)) {
        const agentName = 'team-lead'

        // 在队友活动时轮询消息。这是必需的，因为队友可能在我们等待时发送消息。持续轮询直到团队关闭
        const POLL_INTERVAL_MS = 500

        while (true) {
          // 检查队友是否仍在活动
          const refreshedState = getAppState()
          const hasActiveTeammates =
            hasActiveInProcessTeammates(refreshedState) ||
            (refreshedState.teamContext &&
              Object.keys(refreshedState.teamContext.teammates).length > 0)

          if (!hasActiveTeammates) {
            logForDebugging(
              '[print.ts] No more active teammates, stopping poll',
            )
            break
          }

          const unread = await readUnreadMessages(
            agentName,
            refreshedState.teamContext?.teamName,
          )

          if (unread.length > 0) {
            logForDebugging(
              `[print.ts] Team-lead found ${unread.length} unread messages`,
            )

            // 立即标记为已读以避免重复处理
            await markMessagesAsRead(
              agentName,
              refreshedState.teamContext?.teamName,
            )

            // 处理 shutdown_approved 消息 - 从团队文件中移除队友。这模仿了 useInboxPoller 在交互模式中的行为（第 546-606 行）
            const teamName = refreshedState.teamContext?.teamName
            for (const m of unread) {
              const shutdownApproval = isShutdownApproved(m.text)
              if (shutdownApproval && teamName) {
                const teammateToRemove = shutdownApproval.from
                logForDebugging(
                  `[print.ts] Processing shutdown_approved from ${teammateToRemove}`,
                )

                // 通过名称查找队友 ID
                const teammateId = refreshedState.teamContext?.teammates
                  ? Object.entries(refreshedState.teamContext.teammates).find(
                      ([, t]) => t.name === teammateToRemove,
                    )?.[0]
                  : undefined

                if (teammateId) {
                  // 从团队文件中移除
                  removeTeammateFromTeamFile(teamName, {
                    agentId: teammateId,
                    name: teammateToRemove,
                  })
                  logForDebugging(
                    `[print.ts] Removed ${teammateToRemove} from team file`,
                  )

                  // 取消分配由此队友拥有的任务
                  await unassignTeammateTasks(
                    teamName,
                    teammateId,
                    teammateToRemove,
                    'shutdown',
                  )

                  // 从 AppState 中的 teamContext 移除
                  setAppState(prev => {
                    if (!prev.teamContext?.teammates) return prev
                    if (!(teammateId in prev.teamContext.teammates)) return prev
                    const { [teammateId]: _, ...remainingTeammates } =
                      prev.teamContext.teammates
                    return {
                      ...prev,
                      teamContext: {
                        ...prev.teamContext,
                        teammates: remainingTeammates,
                      },
                    }
                  })
                }
              }
            }

            // 与 useInboxPoller 相同的方式格式化消息
            const formatted = unread
              .map(
                (m: { from: string; text: string; color?: string }) =>
                  `<${TEAMMATE_MESSAGE_TAG} teammate_id="${m.from}"${m.color ? ` color="${m.color}"` : ''}>\n${m.text}\n</${TEAMMATE_MESSAGE_TAG}>`,
              )
              .join('\n\n')

            // 入队并处理
            enqueue({
              mode: 'prompt',
              value: formatted,
              uuid: randomUUID(),
            })
            void run()
            return // run() 将在处理后返回此处
          }

          // 无消息 - 检查是否需要提示关闭。如果输入已关闭且队友活动，则注入一次关闭提示
          if (inputClosed && !shutdownPromptInjected) {
            shutdownPromptInjected = true
            logForDebugging(
              '[print.ts] Input closed with active teammates, injecting shutdown prompt',
            )
            enqueue({
              mode: 'prompt',
              value: SHUTDOWN_TEAM_PROMPT,
              uuid: randomUUID(),
            })
            void run()
            return // run() 将在处理后返回此处
          }

          // 等待并再次检查
          await sleep(POLL_INTERVAL_MS)
        }
      }
    }

    if (inputClosed) {
      // 检查是否存在需要关闭的活动 swarm
      const hasActiveSwarm = await (async () => {
        // 等待任何正在工作的进程内团队成员完成
        const currentAppState = getAppState()
        if (hasWorkingInProcessTeammates(currentAppState)) {
          await waitForTeammatesToBecomeIdle(setAppState, currentAppState)
        }

        // 在可能的等待后重新获取状态
        const refreshedAppState = getAppState()
        const refreshedTeamContext = refreshedAppState.teamContext
        const hasTeamMembersNotCleanedUp =
          refreshedTeamContext &&
          Object.keys(refreshedTeamContext.teammates).length > 0

        return (
          hasTeamMembersNotCleanedUp ||
          hasActiveInProcessTeammates(refreshedAppState)
        )
      })()

      if (hasActiveSwarm) {
        // 团队成员空闲或基于窗格 - 注入提示以关闭团队
        enqueue({
          mode: 'prompt',
          value: SHUTDOWN_TEAM_PROMPT,
          uuid: randomUUID(),
        })
        void run()
      } else {
        // 在关闭输出流之前等待任何正在进行的推送建议
        if (suggestionState.inflightPromise) {
          await Promise.race([suggestionState.inflightPromise, sleep(5000)])
        }
        suggestionState.abortController?.abort()
        suggestionState.abortController = null
        await finalizePendingAsyncHooks()
        unsubscribeSkillChanges()
        unsubscribeAuthStatus?.()
        output.done()
      }
    }
  }

  // Cron调度器：在SDK/-p模式下运行scheduled_tasks.json任务。
  // 镜像REPL的useScheduledTasks钩子。触发提示入队并直接启动
  // run()——与REPL不同，这里没有队列订阅者在空闲时处理入队。
  // run()的互斥锁在活动回合中保证安全：调用为空操作，run()结束时的
  // 后运行重新检查会拾取排队的命令。
  let cronScheduler: import('../utils/cronScheduler.js').CronScheduler | null =
    null
  if (
    feature('AGENT_TRIGGERS') &&
    cronSchedulerModule &&
    cronGate?.isCronSchedulingEnabled()
  ) {
    cronScheduler = cronSchedulerModule.createCronScheduler({
      /** 处理 on Fire 对应的数据或状态。 */
      onFire: prompt => {
        if (inputClosed) return
        enqueue({
          mode: 'prompt',
          value: prompt,
          uuid: randomUUID(),
          priority: 'later',
          // 系统生成——匹配REPL等效的useScheduledTasks.ts。
          // 缺少此项时，messages.ts的metaProp求值为{}→导致提示
          // 在-p模式下cron触发于中间回合时泄漏到可见转录中。
          isMeta: true,
          // 关联到计费头归属块中的cc_workload=，
          // 以便API可以以较低QoS处理cron请求。drainCommandQueue
          // 每次迭代读取此值并将其提升到bootstrap状态，供ask()调用使用。
          workload: WORKLOAD_CRON,
        })
        void run()
      },
      /** 判断是否满足 is Loading 对应的数据或状态。 */
      isLoading: () => running || inputClosed,
      getJitterConfig: cronJitterConfigModule?.getCronJitterConfig,
      /** 判断是否满足 is Killed 对应的数据或状态。 */
      isKilled: () => !cronGate?.isCronSchedulingEnabled(),
    })
    cronScheduler.start()
  }

  /** 输出或发送 send Control Response Success 对应的数据或状态。 */
  const sendControlResponseSuccess = function (
    message: SDKControlRequest,
    response?: Record<string, unknown>,
  ) {
    output.enqueue({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: message.request_id,
        response: response,
      },
    })
  }

  /** 输出或发送 send Control Response Error 对应的数据或状态。 */
  const sendControlResponseError = function (
    message: SDKControlRequest,
    errorMessage: string,
  ) {
    output.enqueue({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: message.request_id,
        error: errorMessage,
      },
    })
  }

  // 通过查找转录中未解析的工具调用并执行它，处理意外的权限响应
  const handledOrphanedToolUseIds = new Set<string>()
  structuredIO.setUnexpectedResponseCallback(async message => {
    await handleOrphanedPermissionResponse({
      message,
      setAppState,
      handledToolUseIds: handledOrphanedToolUseIds,
      /** 处理 on Enqueued 对应的数据或状态。 */
      onEnqueued: () => {
        // 会话的第一条消息可能是孤立的权限检查
        // 而不是用户提示，因此启动循环。
        void run()
      },
    })
  })

  // 跟踪每个服务器的活跃OAuth流程，以便当同一服务器收到新的
  // mcp_authenticate请求时，可以中止先前的流程。
  const activeOAuthFlows = new Map<string, AbortController>()
  // 跟踪用于活跃OAuth流程的手动回调URL提交函数。
  // 当localhost无法访问时使用（例如基于浏览器的IDE）。
  const oauthCallbackSubmitters = new Map<
    string,
    (callbackUrl: string) => void
  >()
  // 跟踪实际调用了手动回调的服务器（以便自动重连路径知道跳过——扩展程序将负责重连）。
  const oauthManualCallbackUsed = new Set<string>()
  // 跟踪OAuth仅认证的promise，以便mcp_oauth_callback_url可以等待令牌交换完成。
  // 重连由扩展程序通过handleAuthDone→mcp_reconnect单独处理。
  const oauthAuthPromises = new Map<string, Promise<void>>()

  // 这本质上是生成一个并行异步任务——我们有两个任务并行运行：
  // 一个从标准输入读取并添加到要处理的队列中，另一个从队列读取、
  // 处理并返回生成结果。
  // 当输入流完成并且队列中的最后一个生成已完成时，处理过程结束。
  void (async () => {
    let initialized = false
    logForDiagnosticsNoPII('info', 'cli_message_loop_started')
    for await (const message of structuredIO.structuredInput) {
      // 非用户事件内联处理（不入队）。同一tick中开始→完成不携带信息，
      // 因此仅触发完成事件。control_response由StructuredIO.processLine报告
      // （该函数也能看到从不在此处产生的孤儿事件）。
      const eventId = 'uuid' in message ? message.uuid : undefined
      if (
        eventId &&
        message.type !== 'user' &&
        message.type !== 'control_response'
      ) {
        notifyCommandLifecycle(eventId, 'completed')
      }

      if (message.type === 'control_request') {
        if (message.request.subtype === 'interrupt') {
          // 当提交归属明确启用时，跟踪中断。
          if (feature('COMMIT_ATTRIBUTION')) {
            setAppState(prev => ({
              ...prev,
              attribution: {
                ...prev.attribution,
                escapeCount: prev.attribution.escapeCount + 1,
              },
            }))
          }
          if (abortController) {
            abortController.abort()
          }
          suggestionState.abortController?.abort()
          suggestionState.abortController = null
          suggestionState.pendingSuggestion = null
          sendControlResponseSuccess(message)
        } else if (message.request.subtype === 'end_session') {
          logForDebugging(
            `[print.ts] end_session received, reason=${message.request.reason ?? 'unspecified'}`,
          )
          if (abortController) {
            abortController.abort()
          }
          suggestionState.abortController?.abort()
          suggestionState.abortController = null
          suggestionState.pendingSuggestion = null
          sendControlResponseSuccess(message)
          break // 退出for-await→落入下面的inputClosed=true drain
        } else if (message.request.subtype === 'initialize') {
          // 来自initialize消息的SDK MCP服务器名称
          // 由浏览器和ProcessTransport会话共同填充
          if (
            message.request.sdkMcpServers &&
            message.request.sdkMcpServers.length > 0
          ) {
            for (const serverName of message.request.sdkMcpServers) {
              // 为SDK MCP服务器创建占位配置
              // 实际的服务器连接由SDK Query类管理
              sdkMcpConfigs[serverName] = {
                type: 'sdk',
                name: serverName,
              }
            }
          }

          await handleInitializeRequest(
            message.request,
            message.request_id,
            initialized,
            output,
            commands,
            modelInfos,
            structuredIO,
            !!options.enableAuthStatus,
            options,
            agents,
            getAppState,
          )

          // 当SDK使用者选择加入时，在AppState中启用提示建议。
          // shouldEnablePromptSuggestion()对非交互式会话返回false，
          // 但SDK使用者明确请求了建议。
          if (message.request.promptSuggestions) {
            setAppState(prev => {
              if (prev.promptSuggestionEnabled) return prev
              return { ...prev, promptSuggestionEnabled: true }
            })
          }

          if (
            message.request.agentProgressSummaries &&
            getFeatureValue('tengu_slate_prism', true)
          ) {
            setSdkAgentProgressSummariesEnabled(true)
          }

          initialized = true

          // 如果自动恢复逻辑预先入队了一个命令，则在initialize设置好
          // systemPrompt、代理、钩子等之后立即排空它。
          if (hasCommandsInQueue()) {
            void run()
          }
        } else if (message.request.subtype === 'set_permission_mode') {
          // 在闭包外保存已收窄的请求，防止异步状态更新时丢失判别联合的收窄结果。
          const permissionModeRequest = message.request
          setAppState(prev => ({
            ...prev,
            toolPermissionContext: handleSetPermissionMode(
              permissionModeRequest,
              message.request_id,
              prev.toolPermissionContext,
              output,
            ),
          }))
          // handleSetPermissionMode发送control_response；
          // 之前紧随其后的notifySessionMetadataChanged现在由
          // onChangeAppState触发（带有外部化的模式名称）。
        } else if (message.request.subtype === 'set_model') {
          const requestedModel = message.request.model ?? 'default'
          const model =
            requestedModel === 'default'
              ? getDefaultMainLoopModel()
              : requestedModel
          activeUserSpecifiedModel = model
          setMainLoopModelOverride(model)
          notifySessionMetadataChanged({ model })
          injectModelSwitchBreadcrumbs(requestedModel, model)

          sendControlResponseSuccess(message)
        } else if (message.request.subtype === 'set_max_thinking_tokens') {
          if (message.request.max_thinking_tokens === null) {
            options.thinkingConfig = undefined
          } else if (message.request.max_thinking_tokens === 0) {
            options.thinkingConfig = { type: 'disabled' }
          } else {
            options.thinkingConfig = {
              type: 'enabled',
              budgetTokens: message.request.max_thinking_tokens,
            }
          }
          sendControlResponseSuccess(message)
        } else if (message.request.subtype === 'mcp_status') {
          sendControlResponseSuccess(message, {
            mcpServers: buildMcpServerStatuses(),
          })
        } else if (message.request.subtype === 'get_context_usage') {
          try {
            const appState = getAppState()
            const data = await collectContextData({
              messages: mutableMessages,
              getAppState,
              options: {
                mainLoopModel: getMainLoopModel(),
                tools: buildAllTools(appState),
                agentDefinitions: appState.agentDefinitions,
                customSystemPrompt: options.systemPrompt,
                appendSystemPrompt: options.appendSystemPrompt,
              },
            })
            sendControlResponseSuccess(message, { ...data })
          } catch (error) {
            sendControlResponseError(message, errorMessage(error))
          }
        } else if (message.request.subtype === 'mcp_message') {
          // 处理来自SDK服务器的MCP通知
          const mcpRequest = message.request
          /** 执行 sdk Client 对应的业务处理。 */
          const sdkClient = sdkClients.find(
            client => client.name === mcpRequest.server_name,
          )
          // 检查客户端是否存在——动态添加的SDK服务器可能具有
          // 客户端占位符，其client为null，直到updateSdkMcp()运行
          if (
            sdkClient &&
            sdkClient.type === 'connected' &&
            sdkClient.client?.transport?.onmessage
          ) {
            sdkClient.client.transport.onmessage(mcpRequest.message)
          }
          sendControlResponseSuccess(message)
        } else if (message.request.subtype === 'rewind_files') {
          const appState = getAppState()
          const result = await handleRewindFiles(
            message.request.user_message_id as UUID,
            appState,
            setAppState,
            message.request.dry_run ?? false,
          )
          if (result.canRewind || message.request.dry_run) {
            sendControlResponseSuccess(message, result)
          } else {
            sendControlResponseError(
              message,
              result.error ?? 'Unexpected error',
            )
          }
        } else if (message.request.subtype === 'cancel_async_message') {
          const targetUuid = message.request.message_uuid
          /** 删除或清理 removed 对应的数据或状态。 */
          const removed = dequeueAllMatching(cmd => cmd.uuid === targetUuid)
          sendControlResponseSuccess(message, {
            cancelled: removed.length > 0,
          })
        } else if (message.request.subtype === 'seed_read_state') {
          // 客户端观察到某个Read后被从上下文中移除（例如通过snip），
          // 因此基于转录的播种错过了它。被排入pendingSeeds；
          // 在下一个克隆-替换边界处应用。
          try {
            // expandPath：所有其他readFileState写入器都会规范化（~、相对路径、
            // 会话cwd与进程cwd）。FileEditTool通过expandPath后的键查找——
            // 直接使用客户端的原始路径会错过。
            const normalizedPath = expandPath(message.request.path)
            // 在读取内容前检查磁盘mtime。如果自客户端观察到后文件已更改，
            // readFile将返回C_current，但我们会以客户端的M_observed存储它——
            // getChangedFiles随后发现磁盘>缓存时间戳，重新读取，比较
            // C_current与C_current = 空，不发送附件，模型永远不会得知
            // C_observed→C_current的更改。跳过播种会导致Edit失败并显示
            // "文件尚未读取"→强制进行新的Read。
            // Math.floor与FileReadTool和getFileModificationTime匹配。
            const diskMtime = Math.floor((await stat(normalizedPath)).mtimeMs)
            if (diskMtime <= message.request.mtime) {
              const raw = await readFile(normalizedPath, 'utf-8')
              // 去除BOM + 标准化CRLF→LF以匹配readFileInRange和readFileSyncWithMetadata。FileEditTool的内容比较回退（用于Windows mtime变更但内容未改变的情况）会与LF标准化的磁盘读取进行比较。
              const content = (
                raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
              ).replaceAll('\r\n', '\n')
              pendingSeeds.set(normalizedPath, {
                content,
                timestamp: diskMtime,
                offset: undefined,
                limit: undefined,
              })
            }
          } catch {
            // ENOENT等——跳过种子填充但依然成功
          }
          sendControlResponseSuccess(message)
        } else if (message.request.subtype === 'mcp_set_servers') {
          const { response, sdkServersChanged } = await applyMcpServerChanges(
            message.request.servers,
          )
          sendControlResponseSuccess(message, response)

          // 在响应之后连接SDK服务器以避免死锁
          if (sdkServersChanged) {
            void updateSdkMcp()
          }
        } else if (message.request.subtype === 'reload_plugins') {
          try {
            const r = await refreshActivePlugins(setAppState)

            /** 执行 sdk Agents 对应的业务处理。 */
            const sdkAgents = currentAgents.filter(
              a => a.source === 'flagSettings',
            )
            currentAgents = [...r.agentDefinitions.allAgents, ...sdkAgents]

            // 重载成功——尽力收集响应数据，这样读取失败不会掩盖成功的状态变更。使用allSettled以便一个失败不会丢弃其他结果。
            let plugins: SDKControlReloadPluginsResponse['plugins'] = []
            const [cmdsR, mcpR, pluginsR] = await Promise.allSettled([
              getCommands(cwd()),
              applyPluginMcpDiff(),
              loadAllPluginsCacheOnly(),
            ])
            if (cmdsR.status === 'fulfilled') {
              currentCommands = cmdsR.value
            } else {
              logError(cmdsR.reason)
            }
            if (mcpR.status === 'rejected') {
              logError(mcpR.reason)
            }
            if (pluginsR.status === 'fulfilled') {
              plugins = pluginsR.value.enabled.map(p => ({
                name: p.name,
                path: p.path,
                source: p.source,
              }))
            } else {
              logError(pluginsR.reason)
            }

            sendControlResponseSuccess(message, {
              /** 执行 commands 对应的业务处理。 */
              commands: currentCommands
                .filter(cmd => cmd.userInvocable !== false)
                .map(cmd => ({
                  name: getCommandName(cmd),
                  description: formatDescriptionWithSource(cmd),
                  argumentHint: cmd.argumentHint || '',
                })),
              /** 执行 agents 对应的业务处理。 */
              agents: currentAgents.map(a => ({
                name: a.agentType,
                description: a.whenToUse,
                model: a.model === 'inherit' ? undefined : a.model,
              })),
              plugins,
              mcpServers: buildMcpServerStatuses(),
              error_count: r.error_count,
            } satisfies SDKControlReloadPluginsResponse)
          } catch (error) {
            sendControlResponseError(message, errorMessage(error))
          }
        } else if (message.request.subtype === 'mcp_reconnect') {
          const currentAppState = getAppState()
          const { serverName } = message.request
          elicitationRegistered.delete(serverName)
          // 配置存在性检查必须覆盖与下面操作相同的来源。SDK注入的服务器（query({mcpServers:{...}})）和动态添加的服务器在此处缺失，因此toggleMcpServer/reconnect返回"Server not found"，即使断开/重连本可以工作（gh-31339 / CC-314）。
          const config =
            getMcpConfigByName(serverName) ??
            mcpClients.find(c => c.name === serverName)?.config ??
            sdkClients.find(c => c.name === serverName)?.config ??
            dynamicMcpState.clients.find(c => c.name === serverName)?.config ??
            currentAppState.mcp.clients.find(c => c.name === serverName)
              ?.config ??
            null
          if (!config) {
            sendControlResponseError(message, `Server not found: ${serverName}`)
          } else {
            const result = await reconnectMcpServerImpl(serverName, config)
            // 使用新的客户端、工具、命令和资源更新appState.mcp
            const prefix = getMcpPrefix(serverName)
            setAppState(prev => ({
              ...prev,
              mcp: {
                ...prev.mcp,
                /** 执行 clients 对应的业务处理。 */
                clients: prev.mcp.clients.map(c =>
                  c.name === serverName ? result.client : c,
                ),
                tools: [
                  ...reject(prev.mcp.tools, t => t.name?.startsWith(prefix)),
                  ...result.tools,
                ],
                commands: [
                  ...reject(prev.mcp.commands, c =>
                    commandBelongsToServer(c, serverName),
                  ),
                  ...result.commands,
                ],
                resources:
                  result.resources && result.resources.length > 0
                    ? { ...prev.mcp.resources, [serverName]: result.resources }
                    : omit(prev.mcp.resources, serverName),
              },
            }))
            // 同时更新dynamicMcpState，以便run()在下一轮获取新工具（run()读取dynamicMcpState，而不是appState）
            dynamicMcpState = {
              ...dynamicMcpState,
              clients: [
                ...dynamicMcpState.clients.filter(c => c.name !== serverName),
                result.client,
              ],
              tools: [
                ...dynamicMcpState.tools.filter(
                  t => !t.name?.startsWith(prefix),
                ),
                ...result.tools,
              ],
            }
            if (result.client.type === 'connected') {
              registerElicitationHandlers([result.client])
              reregisterChannelHandlerAfterReconnect(result.client)
              sendControlResponseSuccess(message)
            } else {
              const errorMessage =
                result.client.type === 'failed'
                  ? (result.client.error ?? 'Connection failed')
                  : `Server status: ${result.client.type}`
              sendControlResponseError(message, errorMessage)
            }
          }
        } else if (message.request.subtype === 'mcp_toggle') {
          const currentAppState = getAppState()
          const { serverName, enabled } = message.request
          elicitationRegistered.delete(serverName)
          // 检查必须匹配下方的客户端查找展开（包括sdkClients和dynamicMcpState.clients）。与上面mcp_reconnect相同的修复（gh-31339 / CC-314）。
          const config =
            getMcpConfigByName(serverName) ??
            mcpClients.find(c => c.name === serverName)?.config ??
            sdkClients.find(c => c.name === serverName)?.config ??
            dynamicMcpState.clients.find(c => c.name === serverName)?.config ??
            currentAppState.mcp.clients.find(c => c.name === serverName)
              ?.config ??
            null

          if (!config) {
            sendControlResponseError(message, `Server not found: ${serverName}`)
          } else if (!enabled) {
            // 禁用：持久化 + 断开连接（匹配TUI toggleMcpServer行为）
            setMcpServerEnabled(serverName, false)
            /** 执行 client 对应的业务处理。 */
            const client = [
              ...mcpClients,
              ...sdkClients,
              ...dynamicMcpState.clients,
              ...currentAppState.mcp.clients,
            ].find(c => c.name === serverName)
            if (client && client.type === 'connected') {
              await clearServerCache(serverName, config)
            }
            // 更新appState.mcp以反映禁用状态并移除工具/命令/资源
            const prefix = getMcpPrefix(serverName)
            setAppState(prev => ({
              ...prev,
              mcp: {
                ...prev.mcp,
                /** 执行 clients 对应的业务处理。 */
                clients: prev.mcp.clients.map(c =>
                  c.name === serverName
                    ? { name: serverName, type: 'disabled' as const, config }
                    : c,
                ),
                /** 转换 tools 对应的数据或状态。 */
                tools: reject(prev.mcp.tools, t => t.name?.startsWith(prefix)),
                /** 执行 commands 对应的业务处理。 */
                commands: reject(prev.mcp.commands, c =>
                  commandBelongsToServer(c, serverName),
                ),
                resources: omit(prev.mcp.resources, serverName),
              },
            }))
            sendControlResponseSuccess(message)
          } else {
            // 启用：持久化 + 重新连接
            setMcpServerEnabled(serverName, true)
            const result = await reconnectMcpServerImpl(serverName, config)
            // 使用新的客户端、工具、命令和资源更新appState.mcp
            // 这确保LLM在启用服务器后看到更新的工具
            const prefix = getMcpPrefix(serverName)
            setAppState(prev => ({
              ...prev,
              mcp: {
                ...prev.mcp,
                /** 执行 clients 对应的业务处理。 */
                clients: prev.mcp.clients.map(c =>
                  c.name === serverName ? result.client : c,
                ),
                tools: [
                  ...reject(prev.mcp.tools, t => t.name?.startsWith(prefix)),
                  ...result.tools,
                ],
                commands: [
                  ...reject(prev.mcp.commands, c =>
                    commandBelongsToServer(c, serverName),
                  ),
                  ...result.commands,
                ],
                resources:
                  result.resources && result.resources.length > 0
                    ? { ...prev.mcp.resources, [serverName]: result.resources }
                    : omit(prev.mcp.resources, serverName),
              },
            }))
            if (result.client.type === 'connected') {
              registerElicitationHandlers([result.client])
              reregisterChannelHandlerAfterReconnect(result.client)
              sendControlResponseSuccess(message)
            } else {
              const errorMessage =
                result.client.type === 'failed'
                  ? (result.client.error ?? 'Connection failed')
                  : `Server status: ${result.client.type}`
              sendControlResponseError(message, errorMessage)
            }
          }
        } else if (message.request.subtype === 'channel_enable') {
          const currentAppState = getAppState()
          handleChannelEnable(
            message.request_id,
            message.request.serverName,
            // 池展开匹配mcp_status——所有三个客户端来源。
            [
              ...currentAppState.mcp.clients,
              ...sdkClients,
              ...dynamicMcpState.clients,
            ],
            output,
          )
        } else if (message.request.subtype === 'mcp_authenticate') {
          const { serverName } = message.request
          const currentAppState = getAppState()
          const config =
            getMcpConfigByName(serverName) ??
            mcpClients.find(c => c.name === serverName)?.config ??
            currentAppState.mcp.clients.find(c => c.name === serverName)
              ?.config ??
            null
          if (!config) {
            sendControlResponseError(message, `Server not found: ${serverName}`)
          } else if (config.type !== 'sse' && config.type !== 'http') {
            sendControlResponseError(
              message,
              `Server type "${config.type}" does not support OAuth authentication`,
            )
          } else {
            try {
              // 中止此服务器之前正在进行的OAuth流程
              activeOAuthFlows.get(serverName)?.abort()
              const controller = new AbortController()
              activeOAuthFlows.set(serverName, controller)

              // 从回调中捕获认证URL
              let resolveAuthUrl: (url: string) => void
              const authUrlPromise = new Promise<string>(resolve => {
                resolveAuthUrl = resolve
              })

              // 在后台启动OAuth流程
              const oauthPromise = performMCPOAuthFlow(
                serverName,
                config,
                url => resolveAuthUrl!(url),
                controller.signal,
                {
                  skipBrowserOpen: true,
                  /** 处理 on Waiting For Callback 对应的数据或状态。 */
                  onWaitingForCallback: submit => {
                    oauthCallbackSubmitters.set(serverName, submit)
                  },
                },
              )

              // 等待认证URL（或流程完成而不需要重定向）
              const authUrl = await Promise.race([
                authUrlPromise,
                oauthPromise.then(() => null as string | null),
              ])

              if (authUrl) {
                sendControlResponseSuccess(message, {
                  authUrl,
                  requiresUserAction: true,
                })
              } else {
                sendControlResponseSuccess(message, {
                  requiresUserAction: false,
                })
              }

              // 为mcp_oauth_callback_url处理器存储仅认证的promise。
              // 不要吞没错误——回调处理器需要检测认证失败并向调用者报告。
              oauthAuthPromises.set(serverName, oauthPromise)

              // 处理后台完成——认证后重新连接。
              // 当使用手动回调时，在此处跳过重新连接；扩展的handleAuthDone → mcp_reconnect处理它（这也会更新dynamicMcpState以注册工具）。
              const fullFlowPromise = oauthPromise
                .then(async () => {
                  // 如果在OAuth流程期间服务器被禁用，则不重新连接
                  if (isMcpServerDisabled(serverName)) {
                    return
                  }
                  // 如果使用了手动回调路径则跳过重新连接——handleAuthDone将通过mcp_reconnect执行（它会更新dynamicMcpState以注册工具）。
                  if (oauthManualCallbackUsed.has(serverName)) {
                    return
                  }
                  // 在成功认证后重新连接服务器
                  const result = await reconnectMcpServerImpl(
                    serverName,
                    config,
                  )
                  const prefix = getMcpPrefix(serverName)
                  setAppState(prev => ({
                    ...prev,
                    mcp: {
                      ...prev.mcp,
                      /** 执行 clients 对应的业务处理。 */
                      clients: prev.mcp.clients.map(c =>
                        c.name === serverName ? result.client : c,
                      ),
                      tools: [
                        ...reject(prev.mcp.tools, t =>
                          t.name?.startsWith(prefix),
                        ),
                        ...result.tools,
                      ],
                      commands: [
                        ...reject(prev.mcp.commands, c =>
                          commandBelongsToServer(c, serverName),
                        ),
                        ...result.commands,
                      ],
                      resources:
                        result.resources && result.resources.length > 0
                          ? {
                              ...prev.mcp.resources,
                              [serverName]: result.resources,
                            }
                          : omit(prev.mcp.resources, serverName),
                    },
                  }))
                  // 同时更新dynamicMcpState，以便run()在下一轮获取新工具（run()读取dynamicMcpState，而不是appState）
                  dynamicMcpState = {
                    ...dynamicMcpState,
                    clients: [
                      ...dynamicMcpState.clients.filter(
                        c => c.name !== serverName,
                      ),
                      result.client,
                    ],
                    tools: [
                      ...dynamicMcpState.tools.filter(
                        t => !t.name?.startsWith(prefix),
                      ),
                      ...result.tools,
                    ],
                  }
                })
                .catch(error => {
                  logForDebugging(
                    `MCP OAuth failed for ${serverName}: ${error}`,
                    { level: 'error' },
                  )
                })
                .finally(() => {
                  // 仅当这仍然是活动流程时进行清理
                  if (activeOAuthFlows.get(serverName) === controller) {
                    activeOAuthFlows.delete(serverName)
                    oauthCallbackSubmitters.delete(serverName)
                    oauthManualCallbackUsed.delete(serverName)
                    oauthAuthPromises.delete(serverName)
                  }
                })
              void fullFlowPromise
            } catch (error) {
              sendControlResponseError(message, errorMessage(error))
            }
          }
        } else if (message.request.subtype === 'mcp_oauth_callback_url') {
          const { serverName, callbackUrl } = message.request
          const submit = oauthCallbackSubmitters.get(serverName)
          if (submit) {
            // 在提交前验证回调URL。auth.ts中的submit回调会静默忽略缺少code参数的URL，这样会导致auth promise无法resolve，并阻塞控制消息循环直到超时。
            let hasCodeOrError = false
            try {
              const parsed = new URL(callbackUrl)
              hasCodeOrError =
                parsed.searchParams.has('code') ||
                parsed.searchParams.has('error')
            } catch {
              // 无效的URL
            }
            if (!hasCodeOrError) {
              sendControlResponseError(
                message,
                'Invalid callback URL: missing authorization code. Please paste the full redirect URL including the code parameter.',
              )
            } else {
              oauthManualCallbackUsed.add(serverName)
              submit(callbackUrl)
              // 在响应前等待认证（令牌交换）完成。重新连接由扩展通过handleAuthDone → mcp_reconnect（更新工具相关dynamicMcpState）处理。
              const authPromise = oauthAuthPromises.get(serverName)
              if (authPromise) {
                try {
                  await authPromise
                  sendControlResponseSuccess(message)
                } catch (error) {
                  sendControlResponseError(
                    message,
                    error instanceof Error
                      ? error.message
                      : 'OAuth authentication failed',
                  )
                }
              } else {
                sendControlResponseSuccess(message)
              }
            }
          } else {
            sendControlResponseError(
              message,
              `No active OAuth flow for server: ${serverName}`,
            )
          }
        } else if (message.request.subtype === 'mcp_clear_auth') {
          const { serverName } = message.request
          const currentAppState = getAppState()
          const config =
            getMcpConfigByName(serverName) ??
            mcpClients.find(c => c.name === serverName)?.config ??
            currentAppState.mcp.clients.find(c => c.name === serverName)
              ?.config ??
            null
          if (!config) {
            sendControlResponseError(message, `Server not found: ${serverName}`)
          } else if (config.type !== 'sse' && config.type !== 'http') {
            sendControlResponseError(
              message,
              `Cannot clear auth for server type "${config.type}"`,
            )
          } else {
            await revokeServerTokens(serverName, config)
            const result = await reconnectMcpServerImpl(serverName, config)
            const prefix = getMcpPrefix(serverName)
            setAppState(prev => ({
              ...prev,
              mcp: {
                ...prev.mcp,
                /** 执行 clients 对应的业务处理。 */
                clients: prev.mcp.clients.map(c =>
                  c.name === serverName ? result.client : c,
                ),
                tools: [
                  ...reject(prev.mcp.tools, t => t.name?.startsWith(prefix)),
                  ...result.tools,
                ],
                commands: [
                  ...reject(prev.mcp.commands, c =>
                    commandBelongsToServer(c, serverName),
                  ),
                  ...result.commands,
                ],
                resources:
                  result.resources && result.resources.length > 0
                    ? {
                        ...prev.mcp.resources,
                        [serverName]: result.resources,
                      }
                    : omit(prev.mcp.resources, serverName),
              },
            }))
            sendControlResponseSuccess(message, {})
          }
        } else if (message.request.subtype === 'apply_flag_settings') {
          // 在应用前快照当前模型——我们需要检测模型切换，以便注入面包屑并通知监听器。
          const prevModel = getMainLoopModel()

          // 将提供的设置合并到内存中的标志设置中
          const existing = getFlagSettingsInline() ?? {}
          const incoming = message.request.settings
          // 浅合并顶层键；getSettingsForSource通过mergeWith处理与基于文件的标志设置的深度合并。JSON序列化会丢弃`undefined`，所以调用者使用`null`来表示"清除此键"。将null转换为删除，使得SettingsSchema().safeParse()不会拒绝整个对象（z.string().optional()接受string | undefined，不接受null）。
          const merged = { ...existing, ...incoming }
          for (const key of Object.keys(merged)) {
            if (merged[key as keyof typeof merged] === null) {
              delete merged[key as keyof typeof merged]
            }
          }
          setFlagSettingsInline(merged)
          // 通过notifyChange路由，使fanOut()在监听器运行前重置设置缓存。:392处的订阅者会为我们调用applySettingsChange。在#20625之前，这是直接调用applySettingsChange()，依赖其自身的内部重置——现在重置集中在fanOut中，这里直接调用会读取陈旧的缓存设置并静默丢弃更新。额外好处：通过notifyChange还会通知其他订阅者（loadPluginHooks、sandbox-adapter）关于变更，之前直接调用跳过了这一步。
          settingsChangeDetector.notifyChange('flagSettings')

          // 如果传入的设置包含模型变更，则更新覆盖，以便getMainLoopModel()反映此变更。覆盖的优先级高于getUserSpecifiedModelSetting()中的设置级联，因此如果没有此更新，getMainLoopModel()将返回陈旧的覆盖，模型变更会被静默忽略（与:2811处的set_model行为一致）。
          if ('model' in incoming) {
            if (incoming.model != null) {
              setMainLoopModelOverride(String(incoming.model))
            } else {
              setMainLoopModelOverride(undefined)
            }
          }

          // 如果模型变更，则注入面包屑，以便模型看到
          const newModel = getMainLoopModel()
          if (newModel !== prevModel) {
            activeUserSpecifiedModel = newModel
            const modelArg = incoming.model ? String(incoming.model) : 'default'
            notifySessionMetadataChanged({ model: newModel })
            injectModelSwitchBreadcrumbs(modelArg, newModel)
          }

          sendControlResponseSuccess(message)
        } else if (message.request.subtype === 'get_settings') {
          const currentAppState = getAppState()
          const model = getMainLoopModel()
          // modelSupportsEffort门控与claude.ts一致——applied.effort必须镜像实际发送到API的内容，而不仅仅是配置的内容。
          const effort = modelSupportsEffort(model)
            ? resolveAppliedEffort(model, currentAppState.effortValue)
            : undefined
          sendControlResponseSuccess(message, {
            ...getSettingsWithSources(),
            applied: {
              model,
              // 数字effort不在公共SDK模式中。
              effort: typeof effort === 'string' ? effort : null,
            },
          })
        } else if (message.request.subtype === 'stop_task') {
          const { task_id: taskId } = message.request
          try {
            await stopTask(taskId, {
              getAppState,
              setAppState,
            })
            sendControlResponseSuccess(message, {})
          } catch (error) {
            sendControlResponseError(message, errorMessage(error))
          }
        } else if (message.request.subtype === 'generate_session_title') {
          // 即发即忘，使得Haiku调用不会阻塞stdin循环（否则会在API往返期间延迟处理后续用户消息/中断）。
          const { description, persist } = message.request
          // 仅在活动控制器尚未中止时（例如被interrupt()中止）复用；已中止的信号会导致queryHaiku立即抛出APIUserAbortError → {title: null}。
          const titleSignal = (
            abortController && !abortController.signal.aborted
              ? abortController
              : createAbortController()
          ).signal
          void (async () => {
            try {
              const title = await generateSessionTitle(description, titleSignal)
              if (title && persist) {
                try {
                  saveAiGeneratedTitle(getSessionId() as UUID, title)
                } catch (e) {
                  logError(e)
                }
              }
              sendControlResponseSuccess(message, { title })
            } catch (e) {
              // 实践中不可达——generateSessionTitle封装了自己的主体并返回null，saveAiGeneratedTitle在上方封装。传播（不吞没）以便SDK调用方（hostComms.ts捕获并记录）能看到意外失败。
              sendControlResponseError(message, errorMessage(e))
            }
          })()
        } else if (message.request.subtype === 'side_question') {
          // 与上面的generate_session_title采用相同的即发即忘模式——派生代理的API往返不能阻塞stdin循环。
          //
          // 由stopHooks（当querySource === 'sdk'时）捕获的快照持有上次主线程轮次发送的确切systemPrompt/userContext/systemContext/messages。复用它们会产生字节相同的前缀 → 缓存命中。
          //
          // 回退（在第一个轮次完成前恢复——尚无快照）：从头重建。buildSideQuestionFallbackParams模仿QueryEngine.ts:ask()的系统提示组装（包括--system-prompt / --append-system-prompt），因此重建的前缀在常见情况下匹配。可能在协调器模式或记忆机制额外内容时错过缓存——可接受，替代方案是侧问题完全失败。
          const { question } = message.request
          void (async () => {
            try {
              const saved = getLastCacheSafeParams()
              const cacheSafeParams = saved
                ? {
                    ...saved,
                    // 如果上一轮次被中断，快照持有一个已中止的控制器；createSubagentContext中的createChildAbortController会传播该中止状态，导致派生代理在发送请求前死亡。控制器不是缓存键的一部分——换入一个新的控制器是安全的。与上面的generate_session_title使用相同的保护。
                    toolUseContext: {
                      ...saved.toolUseContext,
                      abortController: createAbortController(),
                    },
                  }
                : await buildSideQuestionFallbackParams({
                    tools: buildAllTools(getAppState()),
                    commands: currentCommands,
                    mcpClients: [
                      ...getAppState().mcp.clients,
                      ...sdkClients,
                      ...dynamicMcpState.clients,
                    ],
                    messages: mutableMessages,
                    readFileState,
                    getAppState,
                    setAppState,
                    customSystemPrompt: options.systemPrompt,
                    appendSystemPrompt: options.appendSystemPrompt,
                    thinkingConfig: options.thinkingConfig,
                    agents: currentAgents,
                  })
              const result = await runSideQuestion({
                question,
                cacheSafeParams,
              })
              sendControlResponseSuccess(message, { response: result.response })
            } catch (e) {
              sendControlResponseError(message, errorMessage(e))
            }
          })()
        } else if (
          (feature('PROACTIVE')) &&
          (message.request as { subtype: string }).subtype === 'set_proactive'
        ) {
          const req = message.request as unknown as {
            subtype: string
            enabled: boolean
          }
          if (req.enabled) {
            if (!proactiveModule!.isProactiveActive()) {
              proactiveModule!.activateProactive('command')
              scheduleProactiveTick!()
            }
          } else {
            proactiveModule!.deactivateProactive()
          }
          sendControlResponseSuccess(message)
        } else {
          // 未知的控制请求子类型——发送错误响应，这样调用方不会挂起等待永远不会到来的回复。
          sendControlResponseError(
            message,
            `Unsupported control request subtype: ${(message.request as { subtype: string }).subtype}`,
          )
        }
        continue
      } else if (message.type === 'control_response') {
        // 启用重放模式时重放control_response消息
        if (options.replayUserMessages) {
          output.enqueue(message)
        }
        continue
      } else if (message.type === 'keep_alive') {
        // 静默忽略保活消息
        continue
      } else if (message.type === 'update_environment_variables') {
        // 在structuredIO.ts中处理，但TypeScript需要类型守卫
        continue
      } else if (message.type === 'assistant' || message.type === 'system') {
        // 来自网桥的历史重放：注入到mutableMessages中作为对话上下文，以便模型看到之前的轮次。
        const internalMsgs = toInternalMessages([message])
        mutableMessages.push(...internalMsgs)
        if (message.type === 'assistant' && options.replayUserMessages) {
          output.enqueue(message)
        }
        continue
      }
      // 在处理完上述控制、保活、环境变量、助手和系统消息后，只应剩余用户消息。
      if (message.type !== 'user') {
        continue
      }

      // 如果尚未初始化，第一条提示消息会隐式初始化。
      initialized = true

      // 检查重复的用户消息——如果已处理则跳过
      if (message.uuid) {
        const sessionId = getSessionId() as UUID
        const existsInSession = await doesMessageExistInSession(
          sessionId,
          message.uuid,
        )

        // 检查历史重复（来自文件）和运行时重复（当前会话）
        if (existsInSession || receivedMessageUuids.has(message.uuid)) {
          logForDebugging(`Skipping duplicate user message: ${message.uuid}`)
          // 如果启用了重放模式，则发送重复消息的确认
          if (options.replayUserMessages) {
            logForDebugging(
              `Sending acknowledgment for duplicate user message: ${message.uuid}`,
            )
            output.enqueue({
              type: 'user',
              message: message.message,
              session_id: sessionId,
              parent_tool_use_id: null,
              uuid: message.uuid,
              timestamp: message.timestamp,
              isReplay: true,
            } as SDKUserMessageReplay)
          }
          // 历史重复 = 记录中已有此轮输出，说明它已运行但生命周期从未关闭（在确认前被中断）。运行时重复不需要这个——原始入队路径会关闭它们。
          if (existsInSession) {
            notifyCommandLifecycle(message.uuid, 'completed')
          }
          // 不将重复消息加入执行队列
          continue
        }

        // 跟踪此 UUID 以防止运行时重复
        trackReceivedMessageUuid(message.uuid)
      }

      enqueue({
        mode: 'prompt' as const,
        // file_attachments 通过 web composer 的 protobuf catchall 传递。缺失（没有 'file_attachments' 键）时同引用无操作。
        value: message.message.content,
        uuid: message.uuid,
        priority: message.priority,
      })
      // 增加用于归因追踪的提示计数并保存快照。快照保留 promptCount 以便在压缩后仍存在
      if (feature('COMMIT_ATTRIBUTION')) {
        setAppState(prev => ({
          ...prev,
          /** 执行 attribution 对应的业务处理。 */
          attribution: incrementPromptCount(prev.attribution, snapshot => {
            void recordAttributionSnapshot(snapshot).catch(error => {
              logForDebugging(`Attribution: Failed to save snapshot: ${error}`)
            })
          }),
        }))
      }
      void run()
    }
    inputClosed = true
    cronScheduler?.stop()
    if (!running) {
      // 如果推送建议正在处理中，等待其发出后再关闭输出流（5 秒安全超时以防止挂起）。
      if (suggestionState.inflightPromise) {
        await Promise.race([suggestionState.inflightPromise, sleep(5000)])
      }
      suggestionState.abortController?.abort()
      suggestionState.abortController = null
      await finalizePendingAsyncHooks()
      unsubscribeSkillChanges()
      unsubscribeAuthStatus?.()
      output.done()
    }
  })()

  return output
}

/** 创建一个将自定义权限提示工具合并进来的 CanUseToolFn。此函数将 permissionPromptTool 转换为可在 ask.tsx 中使用的 CanUseToolFn */
export function createCanUseToolWithPermissionPrompt(
  permissionPromptTool: PermissionPromptTool,
): CanUseToolFn {
  /** 判断是否满足 can Use Tool 对应的数据或状态。 */
  const canUseTool: CanUseToolFn = async (
    tool,
    input,
    toolUseContext,
    assistantMessage,
    toolUseId,
    forceDecision,
  ) => {
    const mainPermissionResult =
      forceDecision ??
      (await hasPermissionsToUseTool(
        tool,
        input,
        toolUseContext,
        assistantMessage,
        toolUseId,
      ))

    // 如果工具被允许或拒绝，返回结果
    if (
      mainPermissionResult.behavior === 'allow' ||
      mainPermissionResult.behavior === 'deny'
    ) {
      return mainPermissionResult
    }

    // 将权限提示工具与中止信号进行竞速。
    //
    // 为什么需要这样：权限提示工具可能无限期地阻塞等待用户输入（例如通过 stdin 或 UI 对话框）。如果用户触发中断（Ctrl+C），我们需要在工具被阻塞时也能检测到。没有这个竞速，中止检查只会在工具完成后运行，而如果工具正在等待永远不会到来的输入，可能永远不会完成。
    //
    // 第二次检查（combinedSignal.aborted）处理一个竞态条件：在 Promise.race 解析后但在到达此检查前中止触发。
    const { signal: combinedSignal, cleanup: cleanupAbortListener } =
      createCombinedAbortSignal(toolUseContext.abortController.signal)

    // 在开始竞速前检查是否已中止
    if (combinedSignal.aborted) {
      cleanupAbortListener()
      return {
        behavior: 'deny',
        message: 'Permission prompt was aborted.',
        decisionReason: {
          type: 'permissionPromptTool' as const,
          permissionPromptToolName: tool.name,
          toolResult: undefined,
        },
      }
    }

    const abortPromise = new Promise<'aborted'>(resolve => {
      combinedSignal.addEventListener('abort', () => resolve('aborted'), {
        once: true,
      })
    })

    const toolCallPromise = permissionPromptTool.call(
      {
        tool_name: tool.name,
        input,
        tool_use_id: toolUseId,
      },
      toolUseContext,
      canUseTool,
      assistantMessage,
    )

    const raceResult = await Promise.race([toolCallPromise, abortPromise])
    cleanupAbortListener()

    if (raceResult === 'aborted' || combinedSignal.aborted) {
      return {
        behavior: 'deny',
        message: 'Permission prompt was aborted.',
        decisionReason: {
          type: 'permissionPromptTool' as const,
          permissionPromptToolName: tool.name,
          toolResult: undefined,
        },
      }
    }

    // TypeScript 类型收窄：在中止检查后，raceResult 必须是 ToolResult
    const result = raceResult as Awaited<typeof toolCallPromise>

    const permissionToolResultBlockParam =
      permissionPromptTool.mapToolResultToToolResultBlockParam(result.data, '1')
    if (
      !permissionToolResultBlockParam.content ||
      !Array.isArray(permissionToolResultBlockParam.content) ||
      !permissionToolResultBlockParam.content[0] ||
      permissionToolResultBlockParam.content[0].type !== 'text' ||
      typeof permissionToolResultBlockParam.content[0].text !== 'string'
    ) {
      throw new Error(
        'Permission prompt tool returned an invalid result. Expected a single text block param with type="text" and a string text value.',
      )
    }
    return permissionPromptToolResultToPermissionDecision(
      permissionToolOutputSchema().parse(
        safeParseJSON(permissionToolResultBlockParam.content[0].text),
      ),
      permissionPromptTool,
      input,
      toolUseContext,
    )
  }
  return canUseTool
}

// 为测试而导出——回归：当 getMcpTools() 为空时（在逐个服务器连接填充 appState 之前），此函数曾在构造时崩溃。
export function getCanUseToolFn(
  permissionPromptToolName: string | undefined,
  structuredIO: StructuredIO,
  getMcpTools: () => Tool[],
  onPermissionPrompt?: (details: RequiresActionDetails) => void,
): CanUseToolFn {
  if (permissionPromptToolName === 'stdio') {
    return structuredIO.createCanUseTool(onPermissionPrompt)
  }
  if (!permissionPromptToolName) {
    return async (
      tool,
      input,
      toolUseContext,
      assistantMessage,
      toolUseId,
      forceDecision,
    ) =>
      forceDecision ??
      (await hasPermissionsToUseTool(
        tool,
        input,
        toolUseContext,
        assistantMessage,
        toolUseId,
      ))
  }
  // 延迟查找：MCP 连接在打印模式下是按服务器增量进行的，因此工具在初始化时可能尚未在 appState 中。在第一次调用（首次权限提示）时解析，此时连接已经有时间完成。
  let resolved: CanUseToolFn | null = null
  return async (
    tool,
    input,
    toolUseContext,
    assistantMessage,
    toolUseId,
    forceDecision,
  ) => {
    if (!resolved) {
      const mcpTools = getMcpTools()
      const permissionPromptTool = mcpTools.find(t =>
        toolMatchesName(t, permissionPromptToolName),
      ) as PermissionPromptTool | undefined
      if (!permissionPromptTool) {
        const error = `Error: MCP tool ${permissionPromptToolName} (passed via --permission-prompt-tool) not found. Available MCP tools: ${mcpTools.map(t => t.name).join(', ') || 'none'}`
        process.stderr.write(`${error}\n`)
        gracefulShutdownSync(1)
        throw new Error(error)
      }
      if (!permissionPromptTool.inputJSONSchema) {
        const error = `Error: tool ${permissionPromptToolName} (passed via --permission-prompt-tool) must be an MCP tool`
        process.stderr.write(`${error}\n`)
        gracefulShutdownSync(1)
        throw new Error(error)
      }
      resolved = createCanUseToolWithPermissionPrompt(permissionPromptTool)
    }
    return resolved(
      tool,
      input,
      toolUseContext,
      assistantMessage,
      toolUseId,
      forceDecision,
    )
  }
}

/** 处理 handle Initialize Request 对应的数据或状态。 */
async function handleInitializeRequest(
  request: SDKControlInitializeRequest,
  requestId: string,
  initialized: boolean,
  output: Stream<StdoutMessage>,
  commands: Command[],
  modelInfos: ModelInfo[],
  structuredIO: StructuredIO,
  enableAuthStatus: boolean,
  options: {
    systemPrompt: string | undefined
    appendSystemPrompt: string | undefined
    agent?: string | undefined
    userSpecifiedModel?: string | undefined
    [key: string]: unknown
  },
  agents: AgentDefinition[],
  getAppState: () => AppState,
): Promise<void> {
  if (initialized) {
    output.enqueue({
      type: 'control_response',
      response: {
        subtype: 'error',
        error: 'Already initialized',
        request_id: requestId,
        pending_permission_requests:
          structuredIO.getPendingPermissionRequests(),
      },
    })
    return
  }

  // 从 stdin 应用 systemPrompt/appendSystemPrompt 以避免 ARG_MAX 限制
  if (request.systemPrompt !== undefined) {
    options.systemPrompt = request.systemPrompt
  }
  if (request.appendSystemPrompt !== undefined) {
    options.appendSystemPrompt = request.appendSystemPrompt
  }
  if (request.promptSuggestions !== undefined) {
    options.promptSuggestions = request.promptSuggestions
  }

  // 从 stdin 合并代理以避免 ARG_MAX 限制
  if (request.agents) {
    const stdinAgents = parseAgentsFromJson(request.agents, 'flagSettings')
    agents.push(...stdinAgents)
  }

  // 在 SDK 代理合并后重新评估主线程代理。这允许 --agent 引用通过 SDK 定义的代理
  if (options.agent) {
    // 如果 main.tsx 已经找到此代理（文件系统定义的），它已应用了 systemPrompt/model/initialPrompt。跳过以避免双重应用。
    const alreadyResolved = getMainThreadAgentType() === options.agent
    /** 执行 main Thread Agent 对应的业务处理。 */
    const mainThreadAgent = agents.find(a => a.agentType === options.agent)
    if (mainThreadAgent && !alreadyResolved) {
      // 在引导状态中更新主线程代理类型
      setMainThreadAgentType(mainThreadAgent.agentType)

      // 如果用户未指定自定义提示，则应用代理的系统提示。SDK 代理始终是自定义代理（非内置），因此 getSystemPrompt() 不接受参数
      if (!options.systemPrompt && !isBuiltInAgent(mainThreadAgent)) {
        const agentSystemPrompt = mainThreadAgent.getSystemPrompt()
        if (agentSystemPrompt) {
          options.systemPrompt = agentSystemPrompt
        }
      }

      // 如果用户未指定模型且代理有模型，则应用代理的模型
      if (
        !options.userSpecifiedModel &&
        mainThreadAgent.model &&
        mainThreadAgent.model !== 'inherit'
      ) {
        const agentModel = parseUserSpecifiedModel(mainThreadAgent.model)
        setMainLoopModelOverride(agentModel)
      }

      // SDK 定义的代理通过 init 到达，因此 main.tsx 的查找遗漏了它们。
      if (mainThreadAgent.initialPrompt) {
        structuredIO.prependUserMessage(mainThreadAgent.initialPrompt)
      }
    } else if (mainThreadAgent?.initialPrompt) {
      // 文件系统定义的代理（已被 main.tsx 解析）。main.tsx 处理字符串 inputPrompt 情况的 initialPrompt，但当 inputPrompt 是 AsyncIterable（SDK stream-json）时，无法拼接——改为在此使用 prependUserMessage。
      structuredIO.prependUserMessage(mainThreadAgent.initialPrompt)
    }
  }

  const settings = getSettings_DEPRECATED()
  const outputStyle = settings?.outputStyle || DEFAULT_OUTPUT_STYLE_NAME
  const availableOutputStyles = await getAllOutputStyles(getCwd())

  // 仅报告提供商无关的凭据元数据。不存在账户会话。
  const credentialInfo = getApiCredentialInformation()
  if (request.hooks) {
    const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {}
    // 仅校验当前消费的 Hooks 子结构；系统提示数组会保留其缓存分段语义。
    const requestHooks = SDKControlInitializeRequestSchema().parse({
      subtype: 'initialize',
      hooks: request.hooks,
    }).hooks
    for (const [event, matchers] of Object.entries(requestHooks ?? {})) {
      hooks[event as HookEvent] = matchers.map(matcher => {
        /** 执行 callbacks 对应的数据或状态。 */
        const callbacks = matcher.hookCallbackIds.map(callbackId => {
          return structuredIO.createHookCallback(callbackId, matcher.timeout)
        })
        return {
          matcher: matcher.matcher,
          hooks: callbacks,
        }
      })
    }
    registerHookCallbacks(hooks)
  }
  if (request.jsonSchema) {
    setInitJsonSchema(request.jsonSchema)
  }
  const initResponse: SDKControlInitializeResponse = {
    /** 执行 commands 对应的业务处理。 */
    commands: commands
      .filter(cmd => cmd.userInvocable !== false)
      .map(cmd => ({
        name: getCommandName(cmd),
        description: formatDescriptionWithSource(cmd),
        argumentHint: cmd.argumentHint || '',
      })),
    /** 执行 agents 对应的业务处理。 */
    agents: agents.map(agent => ({
      name: agent.agentType,
      description: agent.whenToUse,
      // 'inherit' 是内部哨兵；对公共 API 规范化为 undefined。
      model: agent.model === 'inherit' ? undefined : agent.model,
    })),
    output_style: outputStyle,
    available_output_styles: Object.keys(availableOutputStyles),
    models: modelInfos,
    account: {
      // `account` 为与 Claude Agent SDK 线兼容而保留；它仅包含 API 凭据/提供商元数据，绝不含登录会话。
      apiKeySource: credentialInfo?.apiKeySource,
      apiProvider: getAPIProvider(),
    },
    pid: process.pid,
  }

  if (isFastModeEnabled() && isFastModeAvailable()) {
    const appState = getAppState()
    initResponse.fast_mode_state = getFastModeState(
      options.userSpecifiedModel ?? null,
      appState.fastMode,
    )
  }

  output.enqueue({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: initResponse,
    },
  })

  // 在初始化消息之后，检查认证状态——这将会收到变更通知，但我们也希望发送初始状态。
  if (enableAuthStatus) {
    const authStatusManager = AwsAuthStatusManager.getInstance()
    const status = authStatusManager.getStatus()
    if (status) {
      output.enqueue({
        type: 'auth_status',
        isAuthenticating: status.isAuthenticating,
        output: status.output,
        error: status.error,
        uuid: randomUUID(),
        session_id: getSessionId(),
      })
    }
  }
}

/** 处理 handle Rewind Files 对应的数据或状态。 */
async function handleRewindFiles(
  userMessageId: UUID,
  appState: AppState,
  setAppState: (updater: (prev: AppState) => AppState) => void,
  dryRun: boolean,
): Promise<RewindFilesResult> {
  if (!fileHistoryEnabled()) {
    return { canRewind: false, error: 'File rewinding is not enabled.' }
  }
  if (!fileHistoryCanRestore(appState.fileHistory, userMessageId)) {
    return {
      canRewind: false,
      error: 'No file checkpoint found for this message.',
    }
  }

  if (dryRun) {
    const diffStats = await fileHistoryGetDiffStats(
      appState.fileHistory,
      userMessageId,
    )
    return {
      canRewind: true,
      filesChanged: diffStats?.filesChanged,
      insertions: diffStats?.insertions,
      deletions: diffStats?.deletions,
    }
  }

  try {
    await fileHistoryRewind(
      updater =>
        setAppState(prev => ({
          ...prev,
          fileHistory: updater(prev.fileHistory),
        })),
      userMessageId,
    )
  } catch (error) {
    return {
      canRewind: false,
      error: `Failed to rewind: ${errorMessage(error)}`,
    }
  }

  return { canRewind: true }
}

/** 处理 handle Set Permission Mode 对应的数据或状态。 */
function handleSetPermissionMode(
  request: { mode: InternalPermissionMode },
  requestId: string,
  toolPermissionContext: ToolPermissionContext,
  output: Stream<StdoutMessage>,
): ToolPermissionContext {
  // 检查是否尝试切换到 bypassPermissions 模式。
  if (request.mode === 'bypassPermissions') {
    if (isBypassPermissionsModeDisabled()) {
      output.enqueue({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: requestId,
          error:
            'Cannot set permission mode to bypassPermissions because it is disabled by settings or configuration',
        },
      })
      return toolPermissionContext
    }
    if (!toolPermissionContext.isBypassPermissionsModeAvailable) {
      output.enqueue({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: requestId,
          error:
            'Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions',
        },
      })
      return toolPermissionContext
    }
  }

  // 检查是否尝试切换到无分类器门的自动模式。
  if (
    feature('TRANSCRIPT_CLASSIFIER') &&
    request.mode === 'auto' &&
    !isAutoModeGateEnabled()
  ) {
    const reason = getAutoModeUnavailableReason()
    output.enqueue({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: requestId,
        error: reason
          ? `Cannot set permission mode to auto: ${getAutoModeUnavailableNotification(reason)}`
          : 'Cannot set permission mode to auto',
      },
    })
    return toolPermissionContext
  }

  // 允许模式切换。
  output.enqueue({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: {
        mode: request.mode,
      },
    },
  })

  return {
    ...transitionPermissionMode(
      toolPermissionContext.mode,
      request.mode,
      toolPermissionContext,
    ),
    mode: request.mode,
  }
}

/**
 * IDE 触发的通道启用。从连接的 pluginSource 派生 ChannelEntry（IDE 无法伪造 kind/marketplace——我们只取服务器名称），将其附加到会话的 allowedChannels，并运行完整的门控。门控失败时，回滚追加。成功时，注册一个通知处理程序，该处理程序将通道消息以 priority:'next' 入队——drainCommandQueue 会在回合之间拾取它们。故意不注册 useManageMCPConnections 为交互模式设置的 claude/channel/permission 处理程序。该处理程序会在 handleInteractivePermission 内部解析待处理的对话框——但 print.ts 从不调用 handleInteractivePermission。当 SDK 权限落于 'ask' 时，它会通过 stdio 去往消费者的 canUseTool 回调；不存在 CLI 端的对话框供远程“yes tbxkq”来解析。如果 IDE 想要通过通道转发工具批准，那是 IDE 端针对其自身待处理映射的管道。（也由 tengu_harbor_permissions 单独门控——在交互模式下尚未发布。）
 */
function handleChannelEnable(
  requestId: string,
  serverName: string,
  connectionPool: readonly MCPServerConnection[],
  output: Stream<StdoutMessage>,
): void {
  /** 执行 respond Error 对应的业务处理。 */
  const respondError = (error: string) =>
    output.enqueue({
      type: 'control_response',
      response: { subtype: 'error', request_id: requestId, error },
    })

  if (!(feature('MCP_CHANNELS'))) {
    return respondError('channels feature not available in this build')
  }

  // 只有“已连接”的客户端具有 .capabilities 和 .client 来注册处理程序。调用处的 pool 展开与 mcp_status 匹配。
  const connection = connectionPool.find(
    c => c.name === serverName && c.type === 'connected',
  )
  if (!connection || connection.type !== 'connected') {
    return respondError(`server ${serverName} is not connected`)
  }

  const pluginSource = connection.config.pluginSource
  const parsed = pluginSource ? parsePluginIdentifier(pluginSource) : undefined
  if (!parsed?.marketplace) {
    // 无 pluginSource 或无 @ 的来源——永远无法通过 {plugin, marketplace} 键控的允许列表。短路并产生与门控相同的原因。
    return respondError(
      `server ${serverName} is not plugin-sourced; channel_enable requires a marketplace plugin`,
    )
  }

  const entry: ChannelEntry = {
    kind: 'plugin',
    name: parsed.name,
    marketplace: parsed.marketplace,
  }
  // 幂等性：重复启用时不重复追加。
  const prior = getAllowedChannels()
  /** 执行 already 对应的业务处理。 */
  const already = prior.some(
    e =>
      e.kind === 'plugin' &&
      e.name === entry.name &&
      e.marketplace === entry.marketplace,
  )
  if (!already) setAllowedChannels([...prior, entry])

  const gate = gateChannelServer(
    serverName,
    connection.capabilities,
    pluginSource,
  )
  if (gate.action === 'skip') {
    // 回滚——仅移除我们追加的条目。
    if (!already) setAllowedChannels(prior)
    return respondError(gate.reason)
  }

  const pluginId =
    `${entry.name}@${entry.marketplace}`
  logMCPDebug(serverName, 'Channel notifications registered')

  // 与 useManageMCPConnections 中交互式注册块相同的入队形状。drainCommandQueue 在回合之间处理它——通道消息以优先级 'next' 入队，并在到达后的下一回合被模型看到。
  connection.client.setNotificationHandler(
    ChannelMessageNotificationSchema(),
    async notification => {
      const { content, meta } = notification.params
      logMCPDebug(
        serverName,
        `notifications/claude/channel: ${content.slice(0, 80)}`,
      )
      enqueue({
        mode: 'prompt',
        value: wrapChannelMessage(serverName, content, meta),
        priority: 'next',
        isMeta: true,
        origin: { kind: 'channel', server: serverName },
        skipSlashCommands: true,
      })
    },
  )

  output.enqueue({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: undefined,
    },
  })
}

/**
 * 在 mcp_reconnect / mcp_toggle 创建新客户端后重新注册通道通知处理程序。handleChannelEnable 将处理程序绑定到了旧客户端对象；allowedChannels 在重连后保留，但处理程序绑定不会。没有这个，重连后通道消息会静默丢失，而 IDE 仍认为通道是活跃的。镜像了 useManageMCPConnections 中交互式 CLI 的 onConnectionAttempt，该函数在每次新连接时重新门控。与 registerElicitationHandlers 在相同的调用点成对出现。如果服务器从未启用通道，则为无操作：gateChannelServer 内部调用 findChannelEntry，对于未列出的服务器返回 skip/session，因此重连非通道 MCP 服务器仅花费一次特性标志检查。
 */
function reregisterChannelHandlerAfterReconnect(
  connection: MCPServerConnection,
): void {
  if (!(feature('MCP_CHANNELS'))) return
  if (connection.type !== 'connected') return

  const gate = gateChannelServer(
    connection.name,
    connection.capabilities,
    connection.config.pluginSource,
  )
  if (gate.action !== 'register') return

  const entry = findChannelEntry(connection.name, getAllowedChannels())
  const pluginId =
    entry?.kind === 'plugin'
      ? (`${entry.name}@${entry.marketplace}`)
      : undefined

  logMCPDebug(
    connection.name,
    'Channel notifications re-registered after reconnect',
  )
  connection.client.setNotificationHandler(
    ChannelMessageNotificationSchema(),
    async notification => {
      const { content, meta } = notification.params
      logMCPDebug(
        connection.name,
        `notifications/claude/channel: ${content.slice(0, 80)}`,
      )
      enqueue({
        mode: 'prompt',
        value: wrapChannelMessage(connection.name, content, meta),
        priority: 'next',
        isMeta: true,
        origin: { kind: 'channel', server: connection.name },
        skipSlashCommands: true,
      })
    },
  )
}

/** 根据 outputFormat 以正确的格式发出错误消息。使用 stream-json 时，向 stdout 写入 JSON；否则向 stderr 写入纯文本。 */
function emitLoadError(
  message: string,
  outputFormat: string | undefined,
): void {
  if (outputFormat === 'stream-json') {
    const errorResult = {
      type: 'result',
      subtype: 'error_during_execution',
      duration_ms: 0,
      duration_api_ms: 0,
      is_error: true,
      num_turns: 0,
      stop_reason: null,
      session_id: getSessionId(),
      total_cost_usd: 0,
      usage: EMPTY_USAGE,
      modelUsage: {},
      permission_denials: [],
      uuid: randomUUID(),
      errors: [message],
    }
    process.stdout.write(jsonStringify(errorResult) + '\n')
  } else {
    process.stderr.write(message + '\n')
  }
}

/** 从消息数组中移除一条被中断的用户消息及其后的合成助手哨兵。在网关触发的重启期间使用，以在重新入队中断的提示前清理消息历史。@internal 导出的测试用。 */
export function removeInterruptedMessage(
  messages: Message[],
  interruptedUserMessage: NormalizedUserMessage,
): void {
  /** 执行 idx 对应的业务处理。 */
  const idx = messages.findIndex(m => m.uuid === interruptedUserMessage.uuid)
  if (idx !== -1) {
    // 移除用户消息以及紧随其后的哨兵。当 idx 是最后一个元素时，splice 安全处理。
    messages.splice(idx, 2)
  }
}

type LoadInitialMessagesResult = {
  messages: Message[]
  turnInterruptionState?: TurnInterruptionState
  agentSetting?: string
}

/** 获取 load Initial Messages 对应的数据或状态。 */
async function loadInitialMessages(
  setAppState: (f: (prev: AppState) => AppState) => void,
  options: {
    continue: boolean | undefined
    resume: string | boolean | undefined
    resumeSessionAt: string | undefined
    forkSession: boolean | undefined
    outputFormat: string | undefined
    sessionStartHooksPromise?: ReturnType<typeof processSessionStartHooks>
  },
): Promise<LoadInitialMessagesResult> {
  const persistSession = !isSessionPersistenceDisabled()
  // 在打印模式下处理继续。
  if (options.continue) {
    try {

      const result = await loadConversationForResume(
        undefined /* sessionId */,
        undefined /* 文件路径 */,
      )
      if (result) {
        // 将协调器模式与恢复的会话模式匹配。
        if (feature('COORDINATOR_MODE') && coordinatorModeModule) {
          const warning = coordinatorModeModule.matchSessionMode(result.mode)
          if (warning) {
            process.stderr.write(warning + '\n')
            // 刷新代理定义以反映模式切换。
            const {
              getAgentDefinitionsWithOverrides,
              getActiveAgentsFromList,
            } =
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              require('../tools/AgentTool/loadAgentsDir.js') as typeof import('../tools/AgentTool/loadAgentsDir.js')
            getAgentDefinitionsWithOverrides.cache.clear?.()
            const freshAgentDefs = await getAgentDefinitionsWithOverrides(
              getCwd(),
            )

            setAppState(prev => ({
              ...prev,
              agentDefinitions: {
                ...freshAgentDefs,
                allAgents: freshAgentDefs.allAgents,
                activeAgents: getActiveAgentsFromList(freshAgentDefs.allAgents),
              },
            }))
          }
        }

        // 重用恢复的会话 ID。
        if (!options.forkSession) {
          if (result.sessionId) {
            switchSession(
              asSessionId(result.sessionId),
              result.fullPath ? dirname(result.fullPath) : null,
            )
            if (persistSession) {
              await resetSessionFilePointer()
            }
          }
        }
        restoreSessionStateFromLog(result, setAppState)

        // 恢复会话元数据，以便在退出时通过 reAppendSessionMetadata 重新追加。
        restoreSessionMetadata(
          options.forkSession
            ? { ...result, worktreeSession: undefined }
            : result,
        )

        // 恢复会话的写入模式入口
        if (feature('COORDINATOR_MODE') && coordinatorModeModule) {
          saveMode(
            coordinatorModeModule.isCoordinatorMode()
              ? 'coordinator'
              : 'normal',
          )
        }

        return {
          messages: result.messages,
          turnInterruptionState: result.turnInterruptionState,
          agentSetting: result.agentSetting,
        }
      }
    } catch (error) {
      logError(error)
      gracefulShutdownSync(1)
      return { messages: [] }
    }
  }

  // 处理打印模式下的恢复（接受会话ID或本地JSONL文件）。
  if (options.resume) {
    try {

      // 在打印模式下——我们需要有效的会话ID、JSONL文件或URL
      const parsedSessionId = parseSessionIdentifier(
        typeof options.resume === 'string' ? options.resume : '',
      )
      if (!parsedSessionId) {
        let errorMessage =
          'Error: --resume requires a valid session ID when used with --print. Usage: claude -p --resume <session-id>'
        if (typeof options.resume === 'string') {
          errorMessage += `. Session IDs must be in UUID format (e.g., 550e8400-e29b-41d4-a716-446655440000). Provided value "${options.resume}" is not a valid UUID`
        }
        emitLoadError(errorMessage, options.outputFormat)
        gracefulShutdownSync(1)
        return { messages: [] }
      }

      // 加载具有指定会话ID的对话
      const result = await loadConversationForResume(
        parsedSessionId.sessionId,
        parsedSessionId.jsonlFile || undefined,
      )

      if (!result || result.messages.length === 0) {
        if (parsedSessionId.isUrl) {
          // 执行SessionStart钩子以启动新会话，因为我们正在开始一个新会话
          return {
            messages: await (options.sessionStartHooksPromise ??
              processSessionStartHooks('startup')),
          }
        } else {
          emitLoadError(
            `No conversation found with session ID: ${parsedSessionId.sessionId}`,
            options.outputFormat,
          )
          gracefulShutdownSync(1)
          return { messages: [] }
        }
      }

      // 处理resumeSessionAt特性
      if (options.resumeSessionAt) {
        /** 执行 index 对应的业务处理。 */
        const index = result.messages.findIndex(
          m => m.uuid === options.resumeSessionAt,
        )
        if (index < 0) {
          emitLoadError(
            `No message found with message.uuid of: ${options.resumeSessionAt}`,
            options.outputFormat,
          )
          gracefulShutdownSync(1)
          return { messages: [] }
        }

        result.messages = index >= 0 ? result.messages.slice(0, index + 1) : []
      }

      // 将协调模式匹配到恢复会话的模式
      if (feature('COORDINATOR_MODE') && coordinatorModeModule) {
        const warning = coordinatorModeModule.matchSessionMode(result.mode)
        if (warning) {
          process.stderr.write(warning + '\n')
          // 刷新代理定义以反映模式切换
          const { getAgentDefinitionsWithOverrides, getActiveAgentsFromList } =
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            require('../tools/AgentTool/loadAgentsDir.js') as typeof import('../tools/AgentTool/loadAgentsDir.js')
          getAgentDefinitionsWithOverrides.cache.clear?.()
          const freshAgentDefs = await getAgentDefinitionsWithOverrides(
            getCwd(),
          )

          setAppState(prev => ({
            ...prev,
            agentDefinitions: {
              ...freshAgentDefs,
              allAgents: freshAgentDefs.allAgents,
              activeAgents: getActiveAgentsFromList(freshAgentDefs.allAgents),
            },
          }))
        }
      }

      // 重用恢复会话的ID
      if (!options.forkSession && result.sessionId) {
        switchSession(
          asSessionId(result.sessionId),
          result.fullPath ? dirname(result.fullPath) : null,
        )
        if (persistSession) {
          await resetSessionFilePointer()
        }
      }
      restoreSessionStateFromLog(result, setAppState)

      // 恢复会话元数据，以便在退出时通过reAppendSessionMetadata重新追加
      restoreSessionMetadata(
        options.forkSession
          ? { ...result, worktreeSession: undefined }
          : result,
      )

      // 恢复会话的写入模式入口
      if (feature('COORDINATOR_MODE') && coordinatorModeModule) {
        saveMode(
          coordinatorModeModule.isCoordinatorMode() ? 'coordinator' : 'normal',
        )
      }

      return {
        messages: result.messages,
        turnInterruptionState: result.turnInterruptionState,
        agentSetting: result.agentSetting,
      }
    } catch (error) {
      logError(error)
      const errorMessage =
        error instanceof Error
          ? `Failed to resume session: ${error.message}`
          : 'Failed to resume session with --print mode'
      emitLoadError(errorMessage, options.outputFormat)
      gracefulShutdownSync(1)
      return { messages: [] }
    }
  }

  // 加入在main.tsx中启动的SessionStart钩子promise（如果未启动则重新运行——例如，--continue没有之前的会话会进入此处，sessionStartHooksPromise为undefined，因为main.tsx在continue上进行了守卫）
  return {
    messages: await (options.sessionStartHooksPromise ??
      processSessionStartHooks('startup')),
  }
}

/** 获取 get Structured IO 对应的数据或状态。 */
function getStructuredIO(
  inputPrompt: string | AsyncIterable<string>,
  options: {
    replayUserMessages?: boolean
  },
): StructuredIO {
  let inputStream: AsyncIterable<string>
  if (typeof inputPrompt === 'string') {
    if (inputPrompt.trim() !== '') {
      // 标准化为流输入。
      inputStream = fromArray([
        jsonStringify({
          type: 'user',
          session_id: '',
          message: {
            role: 'user',
            content: inputPrompt,
          },
          parent_tool_use_id: null,
        } satisfies SDKUserMessage),
      ])
    } else {
      // 空字符串——创建空流
      inputStream = fromArray([])
    }
  } else {
    inputStream = inputPrompt
  }

  return new StructuredIO(inputStream, options.replayUserMessages)
}

/**
 * 通过查找记录中未解决的工具调用并将其加入执行队列来处理意外的权限响应。
 * 如果权限已加入队列则返回true，否则返回false。
 */
export async function handleOrphanedPermissionResponse({
  message,
  setAppState,
  onEnqueued,
  handledToolUseIds,
}: {
  message: SDKControlResponse
  /** 设置并保存 set App State 对应的数据或状态。 */
  setAppState: (f: (prev: AppState) => AppState) => void
  /** 处理 on Enqueued 对应的数据或状态。 */
  onEnqueued?: () => void
  handledToolUseIds: Set<string>
}): Promise<boolean> {
  if (
    message.response.subtype === 'success' &&
    message.response.response?.toolUseID &&
    typeof message.response.response.toolUseID === 'string'
  ) {
    const permissionResult = message.response.response as PermissionResult
    const { toolUseID } = permissionResult
    if (!toolUseID) {
      return false
    }

    logForDebugging(
      `handleOrphanedPermissionResponse: received orphaned control_response for toolUseID=${toolUseID} request_id=${message.response.request_id}`,
    )

    // 防止重新处理同一个孤立的tool_use。如果没有此守卫，重复的control_response传递（例如来自WebSocket重连）会导致同一工具多次执行，在消息数组中产生重复的tool_use ID，从而引发API的400错误。一旦损坏，每次重试会累积更多重复。
    if (handledToolUseIds.has(toolUseID)) {
      logForDebugging(
        `handleOrphanedPermissionResponse: skipping duplicate orphaned permission for toolUseID=${toolUseID} (already handled)`,
      )
      return false
    }

    const assistantMessage = await findUnresolvedToolUse(toolUseID)
    if (!assistantMessage) {
      logForDebugging(
        `handleOrphanedPermissionResponse: no unresolved tool_use found for toolUseID=${toolUseID} (already resolved in transcript)`,
      )
      return false
    }

    handledToolUseIds.add(toolUseID)
    logForDebugging(
      `handleOrphanedPermissionResponse: enqueuing orphaned permission for toolUseID=${toolUseID} messageID=${assistantMessage.message.id}`,
    )
    enqueue({
      mode: 'orphaned-permission' as const,
      value: [],
      orphanedPermission: {
        permissionResult,
        assistantMessage,
      },
    })

    onEnqueued?.()
    return true
  }
  return false
}

export type DynamicMcpState = {
  clients: MCPServerConnection[]
  tools: Tools
  configs: Record<string, ScopedMcpServerConfig>
}

/**
 * 将进程传输配置转换为作用域配置。
 * 类型在结构上兼容，因此我们只需添加作用域。
 */
function toScopedConfig(
  config: McpServerConfigForProcessTransport,
): ScopedMcpServerConfig {
  // McpServerConfigForProcessTransport是McpServerConfig的子集（排除了IDE特定类型如sse-ide和ws-ide）
  // 添加作用域使其成为有效的ScopedMcpServerConfig
  return { ...config, scope: 'dynamic' } as ScopedMcpServerConfig
}

/** 在SDK进程中运行的SDK MCP服务器的状态。 */
export type SdkMcpState = {
  configs: Record<string, McpSdkServerConfig>
  clients: MCPServerConnection[]
  tools: Tools
}

/** handleMcpSetServers的结果——包含新状态和响应数据。 */
export type McpSetServersResult = {
  response: SDKControlMcpSetServersResponse
  newSdkState: SdkMcpState
  newDynamicState: DynamicMcpState
  sdkServersChanged: boolean
}

/**
 * 通过处理SDK和基于进程的服务器来处理mcp_set_servers请求。
 * SDK服务器在SDK进程中运行；基于进程的服务器由CLI生成。
 * 应用企业级allowedMcpServers/deniedMcpServers策略——与--mcp-config相同的过滤（参见main.tsx中的filterMcpServersByPolicy调用）。如果没有这个，SDK V2的Query.setMcpServers()是第二个策略绕过向量。被阻止的服务器会在response.errors中报告，以便SDK消费者知道它们为何未被添加。
 */
export async function handleMcpSetServers(
  servers: Record<string, McpServerConfigForProcessTransport>,
  sdkState: SdkMcpState,
  dynamicState: DynamicMcpState,
  setAppState: (f: (prev: AppState) => AppState) => void,
): Promise<McpSetServersResult> {
  // 对基于进程的服务器（stdio/http/sse）强制执行企业MCP策略。
  // 镜像main.tsx中的--mcp-config过滤器——两个用户控制的注入路径必须具有相同的门。类型为'sdk'的服务器豁免（由SDK管理，CLI从不为其生成/连接——参见filterMcpServersByPolicy的JSDoc）。被阻止的服务器放入response.errors中，以便SDK调用者看到原因。
  const { allowed: allowedServers, blocked } = filterMcpServersByPolicy(servers)
  const policyErrors: Record<string, string> = {}
  for (const name of blocked) {
    policyErrors[name] =
      'Blocked by enterprise policy (allowedMcpServers/deniedMcpServers)'
  }

  // 将SDK服务器与基于进程的服务器分离
  const sdkServers: Record<string, McpSdkServerConfig> = {}
  const processServers: Record<string, McpServerConfigForProcessTransport> = {}

  for (const [name, config] of Object.entries(allowedServers)) {
    if (config.type === 'sdk') {
      sdkServers[name] = config
    } else {
      processServers[name] = config
    }
  }

  // 处理SDK服务器
  const currentSdkNames = new Set(Object.keys(sdkState.configs))
  const newSdkNames = new Set(Object.keys(sdkServers))
  const sdkAdded: string[] = []
  const sdkRemoved: string[] = []

  const newSdkConfigs = { ...sdkState.configs }
  let newSdkClients = [...sdkState.clients]
  let newSdkTools = [...sdkState.tools]

  // 移除不再处于期望状态的SDK服务器
  for (const name of currentSdkNames) {
    if (!newSdkNames.has(name)) {
      /** 执行 client 对应的业务处理。 */
      const client = newSdkClients.find(c => c.name === name)
      if (client && client.type === 'connected') {
        await client.cleanup()
      }
      newSdkClients = newSdkClients.filter(c => c.name !== name)
      const prefix = `mcp__${name}__`
      newSdkTools = newSdkTools.filter(t => !t.name.startsWith(prefix))
      delete newSdkConfigs[name]
      sdkRemoved.push(name)
    }
  }

  // 将新的SDK服务器添加为待定状态——它们将在下一次查询时通过updateSdkMcp()升级为已连接
  for (const [name, config] of Object.entries(sdkServers)) {
    if (!currentSdkNames.has(name)) {
      newSdkConfigs[name] = config
      const pendingClient: MCPServerConnection = {
        type: 'pending',
        name,
        config: { ...config, scope: 'dynamic' as const },
      }
      newSdkClients = [...newSdkClients, pendingClient]
      sdkAdded.push(name)
    }
  }

  // 处理基于进程的服务器
  const processResult = await reconcileMcpServers(
    processServers,
    dynamicState,
    setAppState,
  )

  return {
    response: {
      added: [...sdkAdded, ...processResult.response.added],
      removed: [...sdkRemoved, ...processResult.response.removed],
      errors: { ...policyErrors, ...processResult.response.errors },
    },
    newSdkState: {
      configs: newSdkConfigs,
      clients: newSdkClients,
      tools: newSdkTools,
    },
    newDynamicState: processResult.newState,
    sdkServersChanged: sdkAdded.length > 0 || sdkRemoved.length > 0,
  }
}

/** 将当前的动态MCP服务器集合与新的期望状态协调一致。处理添加、移除和配置变更。 */
export async function reconcileMcpServers(
  desiredConfigs: Record<string, McpServerConfigForProcessTransport>,
  currentState: DynamicMcpState,
  setAppState: (f: (prev: AppState) => AppState) => void,
): Promise<{
  response: SDKControlMcpSetServersResponse
  newState: DynamicMcpState
}> {
  const currentNames = new Set(Object.keys(currentState.configs))
  const desiredNames = new Set(Object.keys(desiredConfigs))

  /** 转换 to Remove 对应的数据或状态。 */
  const toRemove = [...currentNames].filter(n => !desiredNames.has(n))
  /** 转换 to Add 对应的数据或状态。 */
  const toAdd = [...desiredNames].filter(n => !currentNames.has(n))

  // 检查配置变更（相同名称，不同配置）
  const toCheck = [...currentNames].filter(n => desiredNames.has(n))
  /** 转换 to Replace 对应的数据或状态。 */
  const toReplace = toCheck.filter(name => {
    const currentConfig = currentState.configs[name]
    const desiredConfigRaw = desiredConfigs[name]
    if (!currentConfig || !desiredConfigRaw) return true
    const desiredConfig = toScopedConfig(desiredConfigRaw)
    return !areMcpConfigsEqual(currentConfig, desiredConfig)
  })

  const removed: string[] = []
  const added: string[] = []
  const errors: Record<string, string> = {}

  let newClients = [...currentState.clients]
  let newTools = [...currentState.tools]

  // 移除旧服务器（包括被替换的）
  for (const name of [...toRemove, ...toReplace]) {
    /** 执行 client 对应的业务处理。 */
    const client = newClients.find(c => c.name === name)
    const config = currentState.configs[name]
    if (client && config) {
      if (client.type === 'connected') {
        try {
          await client.cleanup()
        } catch (e) {
          logError(e)
        }
      }
      // 清除记忆化缓存
      await clearServerCache(name, config)
    }

    // 从该服务器移除工具
    const prefix = `mcp__${name}__`
    newTools = newTools.filter(t => !t.name.startsWith(prefix))

    // 从客户端列表中移除
    newClients = newClients.filter(c => c.name !== name)

    // 跟踪移除（仅针对实际移除的，而非被替换的）
    if (toRemove.includes(name)) {
      removed.push(name)
    }
  }

  // 添加新服务器（包括替换的）
  for (const name of [...toAdd, ...toReplace]) {
    const config = desiredConfigs[name]
    if (!config) continue
    const scopedConfig = toScopedConfig(config)

    // SDK服务器由SDK进程管理，而非CLI。仅跟踪它们，无需尝试连接。
    if (config.type === 'sdk') {
      added.push(name)
      continue
    }

    try {
      const client = await connectToServer(name, scopedConfig)
      newClients.push(client)

      if (client.type === 'connected') {
        const serverTools = await fetchToolsForClient(client)
        newTools.push(...serverTools)
      } else if (client.type === 'failed') {
        errors[name] = client.error || 'Connection failed'
      }

      added.push(name)
    } catch (e) {
      const err = toError(e)
      errors[name] = err.message
      logError(err)
    }
  }

  // 构建新配置
  const newConfigs: Record<string, ScopedMcpServerConfig> = {}
  for (const name of desiredNames) {
    const config = desiredConfigs[name]
    if (config) {
      newConfigs[name] = toScopedConfig(config)
    }
  }

  const newState: DynamicMcpState = {
    clients: newClients,
    tools: newTools,
    configs: newConfigs,
  }

  // 用新工具更新AppState
  setAppState(prev => {
    // 获取所有动态服务器名称（当前+新的）
    const allDynamicServerNames = new Set([
      ...Object.keys(currentState.configs),
      ...Object.keys(newConfigs),
    ])

    // 移除旧的动态工具
    const nonDynamicTools = prev.mcp.tools.filter(t => {
      for (const serverName of allDynamicServerNames) {
        if (t.name.startsWith(`mcp__${serverName}__`)) {
          return false
        }
      }
      return true
    })

    // 移除旧的动态客户端
    const nonDynamicClients = prev.mcp.clients.filter(c => {
      return !allDynamicServerNames.has(c.name)
    })

    return {
      ...prev,
      mcp: {
        ...prev.mcp,
        tools: [...nonDynamicTools, ...newTools],
        clients: [...nonDynamicClients, ...newClients],
      },
    }
  })

  return {
    response: { added, removed, errors },
    newState,
  }
}
