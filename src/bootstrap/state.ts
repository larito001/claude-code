import type { Attributes, Meter, MetricOptions } from '@opentelemetry/api'
import type { logs } from '@opentelemetry/api-logs'
import type { LoggerProvider } from '@opentelemetry/sdk-logs'
import type { MeterProvider } from '@opentelemetry/sdk-metrics'
import type { BasicTracerProvider } from '@opentelemetry/sdk-trace-base'
import { realpathSync } from 'fs'
import sumBy from 'lodash-es/sumBy.js'
import { cwd } from 'process'
import type { HookEvent, ModelUsage } from 'src/entrypoints/agentSdkTypes.js'
import type { AgentColorName } from 'src/tools/AgentTool/agentColorManager.js'
import type { HookCallbackMatcher } from 'src/types/hooks.js'
// 为浏览器SDK构建的间接层（package.json中的"browser"字段将crypto.ts替换为crypto.browser.ts）。纯粹叶节点重新导出node:crypto —— 零循环依赖风险。路径别名导入绕过bootstrap-isolation规则（该规则仅检查./和/前缀）；显式禁用文档化意图。eslint-disable-next-line custom-rules/bootstrap-isolation
import { randomUUID } from 'src/utils/crypto.js'
import type { ModelSetting } from 'src/utils/model/model.js'
import type { ModelStrings } from 'src/utils/model/modelStrings.js'
import type { SettingSource } from 'src/utils/settings/constants.js'
import { resetSettingsCache } from 'src/utils/settings/settingsCache.js'
import type { PluginHookMatcher } from 'src/utils/settings/types.js'
import { createSignal } from 'src/utils/signal.js'

// 注册钩子的联合类型——可以是SDK回调或原生插件钩子
type RegisteredHookMatcher = HookCallbackMatcher | PluginHookMatcher

import type { SessionId } from 'src/types/ids.js'

// 请勿在此处添加更多状态——谨慎使用全局状态

// 通过--dangerously-load-development-channels传入的条目上设置dev: true。允许列表门控按条目检查此项（而不是会话级别的hasDevChannels位），因此同时传递两个标志不会让开发对话框的接受泄露允许列表绕过到--channels条目。
export type ChannelEntry = { kind: 'server'; name: string; dev?: boolean }

export type AttributedCounter = {
  /** 添加或注册 add 对应的数据或状态。 */
  add(value: number, additionalAttributes?: Attributes): void
}

type State = {
  originalCwd: string
  // 稳定的项目根目录——在启动时设置一次（包括通过--worktree标志），不会在会话中期由EnterWorktreeTool更新。用于项目标识（历史、技能、会话），而非文件操作。
  projectRoot: string
  totalCostUSD: number
  totalAPIDuration: number
  totalAPIDurationWithoutRetries: number
  totalToolDuration: number
  startTime: number
  lastInteractionTime: number
  totalLinesAdded: number
  totalLinesRemoved: number
  hasUnknownModelCost: boolean
  cwd: string
  modelUsage: { [modelName: string]: ModelUsage }
  mainLoopModelOverride: ModelSetting | undefined
  initialMainLoopModel: ModelSetting
  modelStrings: ModelStrings | null
  isInteractive: boolean
  // 若为true，ensureToolResultPairing在匹配失败时将抛出异常，而非使用合成占位符修复。HFI在启动时选择启用，以便轨迹快速失败，而不是用虚假的tool_results来训练模型。
  strictToolResultPairing: boolean
  sdkAgentProgressSummariesEnabled: boolean
  clientType: string
  sessionSource: string | undefined
  questionPreviewFormat: 'markdown' | 'html' | undefined
  flagSettingsPath: string | undefined
  flagSettingsInline: Record<string, unknown> | null
  allowedSettingSources: SettingSource[]
  // 遥测状态
  meter: Meter | null
  sessionCounter: AttributedCounter | null
  costCounter: AttributedCounter | null
  tokenCounter: AttributedCounter | null
  activeTimeCounter: AttributedCounter | null
  statsStore: {
    /** 订阅并观察状态变化。 */
    observe(name: string, value: number): void
  } | null
  sessionId: SessionId
  // 用于跟踪会话谱系的父会话ID（例如，计划模式 -> 实施）
  parentSessionId: SessionId | undefined
  // 日志器状态
  loggerProvider: LoggerProvider | null
  eventLogger: ReturnType<typeof logs.getLogger> | null
  // 计表提供程序状态
  meterProvider: MeterProvider | null
  // 跟踪器提供程序状态
  tracerProvider: BasicTracerProvider | null
  // 代理颜色状态
  agentColorMap: Map<string, AgentColorName>
  agentColorIndex: number
  // 由context.ts缓存的CLAUDE.md内容，用于自动模式分类器。打破yoloClassifier → claudemd → filesystem → permissions循环。
  cachedClaudeMdContent: string | null
  // 最近的错误的内存错误日志
  inMemoryErrorLog: Array<{ error: string; timestamp: string }>
  // 来自--plugin-dir标志的仅会话插件
  inlinePlugins: Array<string>
  // 仅会话的绕过权限模式标志（不持久化）
  sessionBypassPermissionsMode: boolean
  // 控制.claude-code-core-framework/scheduled_tasks.json监视器的仅会话标志（useScheduledTasks）。当JSON有条目时由cronScheduler.start()设置，或由CronCreateTool设置。不持久化。
  scheduledTasksEnabled: boolean
  // 通过CronCreate创建的仅会话cron任务，durable: false。按计划触发，如同文件支持的任务，但从不写入.claude-code-core-framework/scheduled_tasks.json —— 它们随进程终止。通过下面的SessionCronTask类型化（不从cronTasks.ts导入以保持bootstrap作为导入DAG的叶节点）。
  sessionCronTasks: SessionCronTask[]
  // 通过TeamCreate在此会话中创建的Teams。cleanupSessionTeams()在优雅关闭时移除它们，这样subagent创建的团队不会永远持久化在磁盘上（gh-32730）。TeamDelete移除条目以避免重复清理。存储在此处（而非teamHelpers.ts），以便resetStateForTests()在测试之间清除它。
  sessionCreatedTeams: Set<string>
  // 用于主目录的仅会话信任标志（不持久化到磁盘）当从主目录运行时，信任对话框被显示但不会保存到磁盘。此标志允许需要信任的功能在会话期间工作。
  sessionTrustAccepted: boolean
  // 禁用到磁盘的会话持久化的仅会话标志
  sessionPersistenceDisabled: boolean
  // 追踪用户是否在此会话中退出了计划模式（用于重新进入指导）
  hasExitedPlanMode: boolean
  // 追踪是否需要显示计划模式退出附件（一次性通知）
  needsPlanModeExitAttachment: boolean
  // 追踪是否需要显示自动模式退出附件（一次性通知）
  needsAutoModeExitAttachment: boolean
  // 追踪此会话中是否已显示LSP插件推荐（仅显示一次）
  // SDK初始化事件状态 - 用于结构化输出的jsonSchema
  initJsonSchema: Record<string, unknown> | null
  // 注册的钩子 - SDK回调与插件原生钩子
  registeredHooks: Partial<Record<HookEvent, RegisteredHookMatcher[]>> | null
  // 计划slug的缓存：sessionId -> wordSlug
  planSlugCache: Map<string, string>
  // 追踪已调用的技能以便在压缩时保留
  // 键是复合的：`${agentId ?? ''}:${skillName}` 以防止跨代理覆盖
  invokedSkills: Map<
    string,
    {
      skillName: string
      skillPath: string
      content: string
      invokedAt: number
      agentId: string | null
    }
  >
  // SDK提供的beta功能（例如context-1m-2025-08-07）
  sdkBetas: string[] | undefined
  // 主线程代理类型（来自--agent标志或设置）
  mainThreadAgentType: string | undefined
  // 远程模式（--remote标志）
  // 系统提示部分缓存状态
  systemPromptSectionCache: Map<string, string | null>
  // 上次发送给模型的日期（用于检测午夜日期变更）
  lastEmittedDate: string | null
  // 来自--add-dir标志的额外目录（用于加载CLAUDE.md）
  additionalDirectoriesForClaudeMd: string[]
  // 来自--channels标志的通道服务器白名单（其通道通知应注册此会话的服务器）。在main.tsx中解析一次——标签决定信任模型：'plugin' → 市场验证+白名单，'server' → 白名单始终失败（模式仅限插件）。任何类型都需要entry.dev绕过白名单。
  allowedChannels: ChannelEntry[]
  // 如果allowedChannels中有任何条目来自
  // --dangerously-load-development-channels则为true（以便通道门控在被策略阻止的消息中能命名正确的标志）
  hasDevChannels: boolean
  // 包含会话`.jsonl`的目录；null = 从originalCwd派生。
  sessionProjectDir: string | null
  // 来自本地功能配置的缓存提示缓存1小时TTL白名单（会话稳定）
  promptCache1hAllowlist: string[] | null
  // 缓存1小时TTL用户资格（会话稳定）。在第一次评估时锁定，以便会话中的超量翻转不会改变cache_control TTL，从而破坏服务器端提示缓存。
  promptCache1hEligible: boolean | null
  // AFK_MODE_BETA_HEADER的粘性开启锁。一旦自动模式首次激活，会话剩余时间持续发送该头部，以便Shift+Tab切换不会破坏约50-70K token的提示缓存。
  afkModeHeaderLatched: boolean | null
  // FAST_MODE_BETA_HEADER的粘性开启锁。一旦快速模式首次启用，持续发送该头部，以便冷却进入/退出不会双重破坏提示缓存。`speed`主体参数保持动态。
  fastModeHeaderLatched: boolean | null
  // 用于清除先前工具循环思考的粘性开启锁。在上次API调用超过1小时后触发（确认缓存未命中——保留思考没有缓存命中收益）。一旦锁定，持续开启，以便新加温的清除思考缓存不会因切换回keep:'all'而被破坏。
  thinkingClearLatched: boolean | null
  // 与用户消息一起持久化的当前提示ID。
  promptId: string | null
  // 主对话链的最后API requestId（非子代理）。
  // 每次主会话查询成功的API响应后更新。
  // 在关闭时读取，以向推理发送缓存驱逐提示。
  lastMainRequestId: string | undefined
  // 最后一次成功API调用的时间戳，用于缓存管理。
  lastApiCompletionTimestamp: number | null
}

// 也在此处 - 修改前请三思
function getInitialState(): State {
  // 解析cwd中的符号链接以匹配shell.ts中setCwd的行为
  // 这可确保与会话存储路径清理方式的一致性
  let resolvedCwd = ''
  if (
    typeof process !== 'undefined' &&
    typeof process.cwd === 'function' &&
    typeof realpathSync === 'function'
  ) {
    const rawCwd = cwd()
    try {
      resolvedCwd = realpathSync(rawCwd).normalize('NFC')
    } catch {
      // CloudStorage挂载上的文件提供者EPERM（按路径组件lstat）
      resolvedCwd = rawCwd.normalize('NFC')
    }
  }
  const state: State = {
    originalCwd: resolvedCwd,
    projectRoot: resolvedCwd,
    totalCostUSD: 0,
    totalAPIDuration: 0,
    totalAPIDurationWithoutRetries: 0,
    totalToolDuration: 0,
    startTime: Date.now(),
    lastInteractionTime: Date.now(),
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    hasUnknownModelCost: false,
    cwd: resolvedCwd,
    modelUsage: {},
    mainLoopModelOverride: undefined,
    initialMainLoopModel: null,
    modelStrings: null,
    isInteractive: false,
    strictToolResultPairing: false,
    sdkAgentProgressSummariesEnabled: false,
    clientType: 'cli',
    sessionSource: undefined,
    questionPreviewFormat: undefined,
    flagSettingsPath: undefined,
    flagSettingsInline: null,
    allowedSettingSources: [
      'userSettings',
      'projectSettings',
      'localSettings',
      'flagSettings',
      'policySettings',
    ],
    // 遥测状态
    meter: null,
    sessionCounter: null,
    costCounter: null,
    tokenCounter: null,
    activeTimeCounter: null,
    statsStore: null,
    sessionId: randomUUID() as SessionId,
    parentSessionId: undefined,
    // 日志记录器状态
    loggerProvider: null,
    eventLogger: null,
    // 计量器提供者状态
    meterProvider: null,
    tracerProvider: null,
    // 代理颜色状态
    agentColorMap: new Map(),
    agentColorIndex: 0,
    cachedClaudeMdContent: null,
    // 最近错误的内存错误日志
    inMemoryErrorLog: [],
    // 来自--plugin-dir标志的仅会话插件
    inlinePlugins: [],
    // 仅会话绕过权限模式标志（不持久化）
    sessionBypassPermissionsMode: false,
    // 计划任务被禁用，直到标志或对话框启用它们
    scheduledTasksEnabled: false,
    sessionCronTasks: [],
    sessionCreatedTeams: new Set(),
    // 仅会话信任标志（不持久化到磁盘）
    sessionTrustAccepted: false,
    // 仅会话标志，用于禁用会话持久化到磁盘
    sessionPersistenceDisabled: false,
    // 跟踪用户在此会话中是否已退出计划模式
    hasExitedPlanMode: false,
    // 跟踪是否需要显示计划模式退出附件
    needsPlanModeExitAttachment: false,
    // 跟踪是否需要显示自动模式退出附件
    needsAutoModeExitAttachment: false,
    // 跟踪是否已在此会话中显示LSP插件推荐
    // SDK初始化事件状态
    initJsonSchema: null,
    registeredHooks: null,
    // 计划片段缓存
    planSlugCache: new Map(),
    // 跟踪调用的技能以在压缩时保留
    invokedSkills: new Map(),
    // 跟踪慢操作以用于开发者栏显示
    // SDK提供的测试版
    sdkBetas: undefined,
    // 主线程代理类型
    mainThreadAgentType: undefined,
    // 远程模式
    // 系统提示段缓存状态
    systemPromptSectionCache: new Map(),
    // 最后给模型的日期
    lastEmittedDate: null,
    // 来自--add-dir标志的额外目录（用于CLAUDE.md加载）
    additionalDirectoriesForClaudeMd: [],
    // 从 --channels 标志获取的频道服务器允许列表
    allowedChannels: [],
    hasDevChannels: false,
    // 会话项目目录（null 表示从 originalCwd 派生）
    sessionProjectDir: null,
    // 提示缓存 1 小时允许列表（null 表示尚未从本地功能配置中获取）
    promptCache1hAllowlist: null,
    // 提示缓存 1 小时资格（null 表示尚未评估）
    promptCache1hEligible: null,
    // Beta 标头锁存（null 表示尚未触发）
    afkModeHeaderLatched: null,
    fastModeHeaderLatched: null,
    thinkingClearLatched: null,
    // 当前提示 ID
    promptId: null,
    lastMainRequestId: undefined,
    lastApiCompletionTimestamp: null,
  }

  return state
}

// 特别在这里
const STATE: State = getInitialState()

/** 获取 get Session Id 对应的数据或状态。 */
export function getSessionId(): SessionId {
  return STATE.sessionId
}

/** 执行 regenerate Session Id 对应的业务处理。 */
export function regenerateSessionId(
  options: { setCurrentAsParent?: boolean } = {},
): SessionId {
  if (options.setCurrentAsParent) {
    STATE.parentSessionId = STATE.sessionId
  }
  // 删除传出会话的计划-子条目，使 Map 不会累积过期的键。需要在对话中携带子条目的调用者（REPL.tsx clearContext）在调用 clearConversation 之前读取它。
  STATE.planSlugCache.delete(STATE.sessionId)
  // 重新生成的会话位于当前项目中：将 projectDir 重置为 null，以便 getTranscriptPath() 从 originalCwd 派生。
  STATE.sessionId = randomUUID() as SessionId
  STATE.sessionProjectDir = null
  return STATE.sessionId
}

/** 获取 get Parent Session Id 对应的数据或状态。 */
export function getParentSessionId(): SessionId | undefined {
  return STATE.parentSessionId
}

/**
 * 原子切换活动会话。`sessionId` 和 `sessionProjectDir` 始终一起更改——两者没有单独的 setter，因此它们不会不同步（CC-34）。
 *
 * @param projectDir — 包含 `<sessionId>.jsonl` 的目录。对于当前项目中的会话，省略（或传递 `null`）——路径将在读取时从 originalCwd 派生。当会话位于不同的项目目录（git worktrees、跨项目恢复）时，传递 `dirname(transcriptPath)`。每次调用都会重置项目目录；它不会从上一个会话继承。
 */
export function switchSession(
  sessionId: SessionId,
  projectDir: string | null = null,
): void {
  // 删除传出会话的计划-子条目，使 Map 在重复 /resume 中保持有界。只读取当前会话的子条目（plans.ts getPlanSlug 默认为 getSessionId()）。
  STATE.planSlugCache.delete(STATE.sessionId)
  STATE.sessionId = sessionId
  STATE.sessionProjectDir = projectDir
  sessionSwitched.emit(sessionId)
}

const sessionSwitched = createSignal<[id: SessionId]>()

/**
 * 注册一个回调，当 switchSession 更改活动 sessionId 时触发。bootstrap 不能直接导入监听器（DAG 叶节点），因此调用者自行注册。concurrentSessions.ts 使用此方法使 PID 文件的 sessionId 与 --resume 保持同步。
 */
export const onSessionSwitch = sessionSwitched.subscribe

/** 当前会话记录所在的项目目录，如果会话是在当前项目中创建的（常见情况——从 originalCwd 派生），则为 `null`。参见 `switchSession()`。 */
export function getSessionProjectDir(): string | null {
  return STATE.sessionProjectDir
}

/** 获取 get Original Cwd 对应的数据或状态。 */
export function getOriginalCwd(): string {
  return STATE.originalCwd
}

/**
 * 获取稳定的项目根目录。与 getOriginalCwd() 不同，它不会在会话期间由 EnterWorktreeTool 更新（因此技能/历史在进入临时工作树时保持稳定）。它由 --worktree 在启动时设置，因为该工作树是会话的项目。用于项目标识（历史、技能、会话），不用于文件操作。
 */
export function getProjectRoot(): string {
  return STATE.projectRoot
}

/** 设置并保存 set Original Cwd 对应的数据或状态。 */
export function setOriginalCwd(cwd: string): void {
  STATE.originalCwd = cwd.normalize('NFC')
}

/** 仅适用于 --worktree 启动标志。会话期间的 EnterWorktreeTool 不得调用此方法——技能/历史应锚定在会话开始的位置。 */
export function setProjectRoot(cwd: string): void {
  STATE.projectRoot = cwd.normalize('NFC')
}

/** 获取 get Cwd State 对应的数据或状态。 */
export function getCwdState(): string {
  return STATE.cwd
}

/** 设置并保存 set Cwd State 对应的数据或状态。 */
export function setCwdState(cwd: string): void {
  STATE.cwd = cwd.normalize('NFC')
}

/** 添加或注册 add To Total Duration State 对应的数据或状态。 */
export function addToTotalDurationState(
  duration: number,
  durationWithoutRetries: number,
): void {
  STATE.totalAPIDuration += duration
  STATE.totalAPIDurationWithoutRetries += durationWithoutRetries
}

/** 重置或恢复 reset Total Duration State And Cost FOR TESTS ONLY 对应的数据或状态。 */
export function resetTotalDurationStateAndCost_FOR_TESTS_ONLY(): void {
  STATE.totalAPIDuration = 0
  STATE.totalAPIDurationWithoutRetries = 0
  STATE.totalCostUSD = 0
}

/** 添加或注册 add To Total Cost State 对应的数据或状态。 */
export function addToTotalCostState(
  cost: number,
  modelUsage: ModelUsage,
  model: string,
): void {
  STATE.modelUsage[model] = modelUsage
  STATE.totalCostUSD += cost
}

/** 获取 get Total Cost USD 对应的数据或状态。 */
export function getTotalCostUSD(): number {
  return STATE.totalCostUSD
}

/** 获取 get Total API Duration 对应的数据或状态。 */
export function getTotalAPIDuration(): number {
  return STATE.totalAPIDuration
}

/** 获取 get Total Duration 对应的数据或状态。 */
export function getTotalDuration(): number {
  return Date.now() - STATE.startTime
}

/** 获取 get Total API Duration Without Retries 对应的数据或状态。 */
export function getTotalAPIDurationWithoutRetries(): number {
  return STATE.totalAPIDurationWithoutRetries
}

/** 获取 get Total Tool Duration 对应的数据或状态。 */
export function getTotalToolDuration(): number {
  return STATE.totalToolDuration
}

/** 添加或注册 add To Tool Duration 对应的数据或状态。 */
export function addToToolDuration(duration: number): void {
  STATE.totalToolDuration += duration
}

/** 获取 get Stats Store 对应的数据或状态。 */
export function getStatsStore(): {
  /** 订阅并观察状态变化。 */
  observe(name: string, value: number): void
} | null {
  return STATE.statsStore
}

/** 设置并保存 set Stats Store 对应的数据或状态。 */
export function setStatsStore(
  store: {
    /** 订阅并观察状态变化。 */
    observe(name: string, value: number): void
  } | null,
): void {
  STATE.statsStore = store
}

/**
 * 标记发生了交互。
 *
 * 默认情况下，对 Date.now() 的实际调用会延迟到下一个 Ink 渲染帧（通过 flushInteractionTime()），以避免在每次按键时调用 Date.now()。
 *
 * 当从 React useEffect 回调或其他在 Ink 渲染周期已刷新后运行的代码调用时，传递 `immediate = true`。否则时间戳会保持过时直到下一次渲染，如果用户空闲（例如等待输入的权限对话框），可能永远不会到来。
 */
let interactionTimeDirty = false

/** 更新 update Last Interaction Time 对应的数据或状态。 */
export function updateLastInteractionTime(immediate?: boolean): void {
  if (immediate) {
    flushInteractionTime_inner()
  } else {
    interactionTimeDirty = true
  }
}

/** 如果自上次刷新以来记录了交互，则立即更新时间戳。由 Ink 在每个渲染周期之前调用，以便将多次按键批处理到单个 Date.now() 调用中。 */
export function flushInteractionTime(): void {
  if (interactionTimeDirty) {
    flushInteractionTime_inner()
  }
}

/** 执行 flush Interaction Time inner 对应的业务处理。 */
function flushInteractionTime_inner(): void {
  STATE.lastInteractionTime = Date.now()
  interactionTimeDirty = false
}

/** 添加或注册 add To Total Lines Changed 对应的数据或状态。 */
export function addToTotalLinesChanged(added: number, removed: number): void {
  STATE.totalLinesAdded += added
  STATE.totalLinesRemoved += removed
}

/** 获取 get Total Lines Added 对应的数据或状态。 */
export function getTotalLinesAdded(): number {
  return STATE.totalLinesAdded
}

/** 获取 get Total Lines Removed 对应的数据或状态。 */
export function getTotalLinesRemoved(): number {
  return STATE.totalLinesRemoved
}

/** 获取 get Total Input Tokens 对应的数据或状态。 */
export function getTotalInputTokens(): number {
  return sumBy(Object.values(STATE.modelUsage), 'inputTokens')
}

/** 获取 get Total Output Tokens 对应的数据或状态。 */
export function getTotalOutputTokens(): number {
  return sumBy(Object.values(STATE.modelUsage), 'outputTokens')
}

/** 获取 get Total Cache Read Input Tokens 对应的数据或状态。 */
export function getTotalCacheReadInputTokens(): number {
  return sumBy(Object.values(STATE.modelUsage), 'cacheReadInputTokens')
}

/** 获取 get Total Cache Creation Input Tokens 对应的数据或状态。 */
export function getTotalCacheCreationInputTokens(): number {
  return sumBy(Object.values(STATE.modelUsage), 'cacheCreationInputTokens')
}

/** 获取 get Total Web Search Requests 对应的数据或状态。 */
export function getTotalWebSearchRequests(): number {
  return sumBy(Object.values(STATE.modelUsage), 'webSearchRequests')
}

let outputTokensAtTurnStart = 0
let currentTurnTokenBudget: number | null = null
/** 获取 get Turn Output Tokens 对应的数据或状态。 */
export function getTurnOutputTokens(): number {
  return getTotalOutputTokens() - outputTokensAtTurnStart
}
/** 获取 get Current Turn Token Budget 对应的数据或状态。 */
export function getCurrentTurnTokenBudget(): number | null {
  return currentTurnTokenBudget
}
let budgetContinuationCount = 0
/** 执行 snapshot Output Tokens For Turn 对应的业务处理。 */
export function snapshotOutputTokensForTurn(budget: number | null): void {
  outputTokensAtTurnStart = getTotalOutputTokens()
  currentTurnTokenBudget = budget
  budgetContinuationCount = 0
}
/** 获取 get Budget Continuation Count 对应的数据或状态。 */
export function getBudgetContinuationCount(): number {
  return budgetContinuationCount
}
/** 执行 increment Budget Continuation Count 对应的业务处理。 */
export function incrementBudgetContinuationCount(): void {
  budgetContinuationCount++
}

/** 设置并保存 set Has Unknown Model Cost 对应的数据或状态。 */
export function setHasUnknownModelCost(): void {
  STATE.hasUnknownModelCost = true
}

/** 判断是否满足 has Unknown Model Cost 对应的数据或状态。 */
export function hasUnknownModelCost(): boolean {
  return STATE.hasUnknownModelCost
}

/** 获取 get Last Main Request Id 对应的数据或状态。 */
export function getLastMainRequestId(): string | undefined {
  return STATE.lastMainRequestId
}

/** 设置并保存 set Last Main Request Id 对应的数据或状态。 */
export function setLastMainRequestId(requestId: string): void {
  STATE.lastMainRequestId = requestId
}

/** 获取 get Last Api Completion Timestamp 对应的数据或状态。 */
export function getLastApiCompletionTimestamp(): number | null {
  return STATE.lastApiCompletionTimestamp
}

/** 设置并保存 set Last Api Completion Timestamp 对应的数据或状态。 */
export function setLastApiCompletionTimestamp(timestamp: number): void {
  STATE.lastApiCompletionTimestamp = timestamp
}

/** 获取 get Last Interaction Time 对应的数据或状态。 */
export function getLastInteractionTime(): number {
  return STATE.lastInteractionTime
}

// 滚动排空暂停——后台间隔在开始工作前检查此标志，以避免与滚动帧竞争事件循环。由 ScrollBox scrollBy/scrollTo 设置，在最后一次滚动事件后的 SCROLL_DRAIN_IDLE_MS 清除。模块作用域（不在 STATE 中）——瞬态热路径标志，不需要测试重置，因为防抖计时器会自行清除。
let scrollDraining = false
let scrollDrainTimer: ReturnType<typeof setTimeout> | undefined
const SCROLL_DRAIN_IDLE_MS = 150

/** 标记滚动事件刚刚发生。后台间隔通过 getIsScrollDraining() 进行门控，并在防抖清除前跳过其工作。 */
export function markScrollActivity(): void {
  scrollDraining = true
  if (scrollDrainTimer) clearTimeout(scrollDrainTimer)
  scrollDrainTimer = setTimeout(() => {
    scrollDraining = false
    scrollDrainTimer = undefined
  }, SCROLL_DRAIN_IDLE_MS)
  scrollDrainTimer.unref?.()
}

/** 当滚动正在主动排空时（在最后一次事件后的 150 毫秒内）为 true。间隔应在设置此标志时提前返回——工作将在滚动稳定后的下一个 tick 继续。 */
export function getIsScrollDraining(): boolean {
  return scrollDraining
}

/** 在执行可能恰逢滚动的昂贵一次性工作（网络、子进程）之前等待此值。如果不滚动则立即解析；否则以空闲间隔轮询直到标志清除。 */
export async function waitForScrollIdle(): Promise<void> {
  while (scrollDraining) {
    // bootstrap 隔离禁止从 src/utils/ 导入 sleep()
    // eslint-disable-next-line no-restricted-syntax
    await new Promise(r => setTimeout(r, SCROLL_DRAIN_IDLE_MS).unref?.())
  }
}

/** 获取 get Model Usage 对应的数据或状态。 */
export function getModelUsage(): { [modelName: string]: ModelUsage } {
  return STATE.modelUsage
}

/** 获取 get Usage For Model 对应的数据或状态。 */
export function getUsageForModel(model: string): ModelUsage | undefined {
  return STATE.modelUsage[model]
}

/** 获取从 --model CLI 标志或用户更新其配置模型后设置的模型覆盖。 */
export function getMainLoopModelOverride(): ModelSetting | undefined {
  return STATE.mainLoopModelOverride
}

/** 获取 get Initial Main Loop Model 对应的数据或状态。 */
export function getInitialMainLoopModel(): ModelSetting {
  return STATE.initialMainLoopModel
}

/** 设置并保存 set Main Loop Model Override 对应的数据或状态。 */
export function setMainLoopModelOverride(
  model: ModelSetting | undefined,
): void {
  STATE.mainLoopModelOverride = model
}

/** 设置并保存 set Initial Main Loop Model 对应的数据或状态。 */
export function setInitialMainLoopModel(model: ModelSetting): void {
  STATE.initialMainLoopModel = model
}

/** 获取 get Sdk Betas 对应的数据或状态。 */
export function getSdkBetas(): string[] | undefined {
  return STATE.sdkBetas
}

/** 设置并保存 set Sdk Betas 对应的数据或状态。 */
export function setSdkBetas(betas: string[] | undefined): void {
  STATE.sdkBetas = betas
}

/** 重置或恢复 reset Cost State 对应的数据或状态。 */
export function resetCostState(): void {
  STATE.totalCostUSD = 0
  STATE.totalAPIDuration = 0
  STATE.totalAPIDurationWithoutRetries = 0
  STATE.totalToolDuration = 0
  STATE.startTime = Date.now()
  STATE.totalLinesAdded = 0
  STATE.totalLinesRemoved = 0
  STATE.hasUnknownModelCost = false
  STATE.modelUsage = {}
  STATE.promptId = null
}

/** 设置用于会话恢复的成本状态值。由 cost-tracker.ts 中的 restoreCostStateForSession 调用。 */
export function setCostStateForRestore({
  totalCostUSD,
  totalAPIDuration,
  totalAPIDurationWithoutRetries,
  totalToolDuration,
  totalLinesAdded,
  totalLinesRemoved,
  lastDuration,
  modelUsage,
}: {
  totalCostUSD: number
  totalAPIDuration: number
  totalAPIDurationWithoutRetries: number
  totalToolDuration: number
  totalLinesAdded: number
  totalLinesRemoved: number
  lastDuration: number | undefined
  modelUsage: { [modelName: string]: ModelUsage } | undefined
}): void {
  STATE.totalCostUSD = totalCostUSD
  STATE.totalAPIDuration = totalAPIDuration
  STATE.totalAPIDurationWithoutRetries = totalAPIDurationWithoutRetries
  STATE.totalToolDuration = totalToolDuration
  STATE.totalLinesAdded = totalLinesAdded
  STATE.totalLinesRemoved = totalLinesRemoved

  // 恢复每个模型的用量明细
  if (modelUsage) {
    STATE.modelUsage = modelUsage
  }

  // 调整startTime使墙上持续时间累计
  if (lastDuration) {
    STATE.startTime = Date.now() - lastDuration
  }
}

// 仅在测试中使用
export function resetStateForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetStateForTests can only be called in tests')
  }
  Object.entries(getInitialState()).forEach(([key, value]) => {
    STATE[key as keyof State] = value as never
  })
  outputTokensAtTurnStart = 0
  currentTurnTokenBudget = null
  budgetContinuationCount = 0
  sessionSwitched.clear()
}

// 你不应直接使用它。请参见src/utils/model/modelStrings.ts::getModelStrings()
export function getModelStrings(): ModelStrings | null {
  return STATE.modelStrings
}

// 你不应直接使用它。请参见src/utils/model/modelStrings.ts
export function setModelStrings(modelStrings: ModelStrings): void {
  STATE.modelStrings = modelStrings
}

// 测试实用函数，用于重置模型字符串以便重新初始化。
// 与setModelStrings分开，因为我们只想在测试中接受'null'。
export function resetModelStringsForTestingOnly() {
  STATE.modelStrings = null
}

/** 设置并保存 set Meter 对应的数据或状态。 */
export function setMeter(
  meter: Meter,
  createCounter: (name: string, options: MetricOptions) => AttributedCounter,
): void {
  STATE.meter = meter

  // 使用提供的工厂初始化所有计数器
  STATE.sessionCounter = createCounter('agent_framework.session.count', {
    description: 'Count of CLI sessions started',
  })
  STATE.costCounter = createCounter('agent_framework.cost.usage', {
    description: 'Cost of the Claude Code session',
    unit: 'USD',
  })
  STATE.tokenCounter = createCounter('agent_framework.token.usage', {
    description: 'Number of tokens used',
    unit: 'tokens',
  })
  STATE.activeTimeCounter = createCounter('agent_framework.active_time.total', {
    description: 'Total active time in seconds',
    unit: 's',
  })
}

/** 获取 get Meter 对应的数据或状态。 */
export function getMeter(): Meter | null {
  return STATE.meter
}

/** 获取 get Session Counter 对应的数据或状态。 */
export function getSessionCounter(): AttributedCounter | null {
  return STATE.sessionCounter
}

/** 获取 get Cost Counter 对应的数据或状态。 */
export function getCostCounter(): AttributedCounter | null {
  return STATE.costCounter
}

/** 获取 get Token Counter 对应的数据或状态。 */
export function getTokenCounter(): AttributedCounter | null {
  return STATE.tokenCounter
}

/** 获取 get Active Time Counter 对应的数据或状态。 */
export function getActiveTimeCounter(): AttributedCounter | null {
  return STATE.activeTimeCounter
}

/** 获取 get Logger Provider 对应的数据或状态。 */
export function getLoggerProvider(): LoggerProvider | null {
  return STATE.loggerProvider
}

/** 设置并保存 set Logger Provider 对应的数据或状态。 */
export function setLoggerProvider(provider: LoggerProvider | null): void {
  STATE.loggerProvider = provider
}

/** 获取 get Event Logger 对应的数据或状态。 */
export function getEventLogger(): ReturnType<typeof logs.getLogger> | null {
  return STATE.eventLogger
}

/** 设置并保存 set Event Logger 对应的数据或状态。 */
export function setEventLogger(
  logger: ReturnType<typeof logs.getLogger> | null,
): void {
  STATE.eventLogger = logger
}

/** 获取 get Meter Provider 对应的数据或状态。 */
export function getMeterProvider(): MeterProvider | null {
  return STATE.meterProvider
}

/** 设置并保存 set Meter Provider 对应的数据或状态。 */
export function setMeterProvider(provider: MeterProvider | null): void {
  STATE.meterProvider = provider
}
/** 获取 get Tracer Provider 对应的数据或状态。 */
export function getTracerProvider(): BasicTracerProvider | null {
  return STATE.tracerProvider
}
/** 设置并保存 set Tracer Provider 对应的数据或状态。 */
export function setTracerProvider(provider: BasicTracerProvider | null): void {
  STATE.tracerProvider = provider
}

/** 获取 get Is Non Interactive Session 对应的数据或状态。 */
export function getIsNonInteractiveSession(): boolean {
  return !STATE.isInteractive
}

/** 获取 get Is Interactive 对应的数据或状态。 */
export function getIsInteractive(): boolean {
  return STATE.isInteractive
}

/** 设置并保存 set Is Interactive 对应的数据或状态。 */
export function setIsInteractive(value: boolean): void {
  STATE.isInteractive = value
}

/** 获取 get Client Type 对应的数据或状态。 */
export function getClientType(): string {
  return STATE.clientType
}

/** 设置并保存 set Client Type 对应的数据或状态。 */
export function setClientType(type: string): void {
  STATE.clientType = type
}

/** 获取 get Sdk Agent Progress Summaries Enabled 对应的数据或状态。 */
export function getSdkAgentProgressSummariesEnabled(): boolean {
  return STATE.sdkAgentProgressSummariesEnabled
}

/** 设置并保存 set Sdk Agent Progress Summaries Enabled 对应的数据或状态。 */
export function setSdkAgentProgressSummariesEnabled(value: boolean): void {
  STATE.sdkAgentProgressSummariesEnabled = value
}

/** 获取 get Strict Tool Result Pairing 对应的数据或状态。 */
export function getStrictToolResultPairing(): boolean {
  return STATE.strictToolResultPairing
}

/** 设置并保存 set Strict Tool Result Pairing 对应的数据或状态。 */
export function setStrictToolResultPairing(value: boolean): void {
  STATE.strictToolResultPairing = value
}

/** 获取 get Session Source 对应的数据或状态。 */
export function getSessionSource(): string | undefined {
  return STATE.sessionSource
}

/** 设置并保存 set Session Source 对应的数据或状态。 */
export function setSessionSource(source: string): void {
  STATE.sessionSource = source
}

/** 获取 get Question Preview Format 对应的数据或状态。 */
export function getQuestionPreviewFormat(): 'markdown' | 'html' | undefined {
  return STATE.questionPreviewFormat
}

/** 设置并保存 set Question Preview Format 对应的数据或状态。 */
export function setQuestionPreviewFormat(format: 'markdown' | 'html'): void {
  STATE.questionPreviewFormat = format
}

/** 获取 get Agent Color Map 对应的数据或状态。 */
export function getAgentColorMap(): Map<string, AgentColorName> {
  return STATE.agentColorMap
}

/** 获取 get Flag Settings Path 对应的数据或状态。 */
export function getFlagSettingsPath(): string | undefined {
  return STATE.flagSettingsPath
}

/** 设置并保存 set Flag Settings Path 对应的数据或状态。 */
export function setFlagSettingsPath(path: string | undefined): void {
  STATE.flagSettingsPath = path
}

/** 获取 get Flag Settings Inline 对应的数据或状态。 */
export function getFlagSettingsInline(): Record<string, unknown> | null {
  return STATE.flagSettingsInline
}

/** 设置并保存 set Flag Settings Inline 对应的数据或状态。 */
export function setFlagSettingsInline(
  settings: Record<string, unknown> | null,
): void {
  STATE.flagSettingsInline = settings
}

/** 设置并保存 set Cached Claude Md Content 对应的数据或状态。 */
export function setCachedClaudeMdContent(content: string | null): void {
  STATE.cachedClaudeMdContent = content
}

/** 获取 get Cached Claude Md Content 对应的数据或状态。 */
export function getCachedClaudeMdContent(): string | null {
  return STATE.cachedClaudeMdContent
}

/** 添加或注册 add To In Memory Error Log 对应的数据或状态。 */
export function addToInMemoryErrorLog(errorInfo: {
  error: string
  timestamp: string
}): void {
  const MAX_IN_MEMORY_ERRORS = 100
  if (STATE.inMemoryErrorLog.length >= MAX_IN_MEMORY_ERRORS) {
    STATE.inMemoryErrorLog.shift() // 移除最旧的错误
  }
  STATE.inMemoryErrorLog.push(errorInfo)
}

/** 获取 get Allowed Setting Sources 对应的数据或状态。 */
export function getAllowedSettingSources(): SettingSource[] {
  return STATE.allowedSettingSources
}

/** 设置并保存 set Allowed Setting Sources 对应的数据或状态。 */
export function setAllowedSettingSources(sources: SettingSource[]): void {
  STATE.allowedSettingSources = sources
}

/** 执行 prefer Third Party Authentication 对应的业务处理。 */
export function preferThirdPartyAuthentication(): boolean {
  // 出于身份验证原因，IDE扩展应表现为第一方（1P）。
  return getIsNonInteractiveSession() && STATE.clientType !== 'claude-vscode'
}

/** 设置并保存 set Inline Plugins 对应的数据或状态。 */
export function setInlinePlugins(plugins: Array<string>): void {
  STATE.inlinePlugins = plugins
}

/** 获取 get Inline Plugins 对应的数据或状态。 */
export function getInlinePlugins(): Array<string> {
  return STATE.inlinePlugins
}

/** 设置并保存 set Use Cowork Plugins 对应的数据或状态。 */
/** 设置并保存 set Session Bypass Permissions Mode 对应的数据或状态。 */
export function setSessionBypassPermissionsMode(enabled: boolean): void {
  STATE.sessionBypassPermissionsMode = enabled
}

/** 获取 get Session Bypass Permissions Mode 对应的数据或状态。 */
export function getSessionBypassPermissionsMode(): boolean {
  return STATE.sessionBypassPermissionsMode
}

/** 设置并保存 set Scheduled Tasks Enabled 对应的数据或状态。 */
export function setScheduledTasksEnabled(enabled: boolean): void {
  STATE.scheduledTasksEnabled = enabled
}

/** 获取 get Scheduled Tasks Enabled 对应的数据或状态。 */
export function getScheduledTasksEnabled(): boolean {
  return STATE.scheduledTasksEnabled
}

export type SessionCronTask = {
  id: string
  cron: string
  prompt: string
  createdAt: number
  recurring?: boolean
  /**
   * 当设置时，任务由进程内的队友（而非团队负责人）创建。
   * 调度程序将fires路由到该队友的pendingUserMessages队列，
   * 而不是主REPL命令队列。仅会话——从不写入磁盘。
   */
  agentId?: string
}

/** 获取 get Session Cron Tasks 对应的数据或状态。 */
export function getSessionCronTasks(): SessionCronTask[] {
  return STATE.sessionCronTasks
}

/** 添加或注册 add Session Cron Task 对应的数据或状态。 */
export function addSessionCronTask(task: SessionCronTask): void {
  STATE.sessionCronTasks.push(task)
}

/** 返回实际移除的任务数量。调用者利用此信息跳过下游工作（例如removeCronTasks中的磁盘读取），当所有id都在此处理完毕时。 */
export function removeSessionCronTasks(ids: readonly string[]): number {
  if (ids.length === 0) return 0
  const idSet = new Set(ids)
  /** 执行 remaining 对应的业务处理。 */
  const remaining = STATE.sessionCronTasks.filter(t => !idSet.has(t.id))
  const removed = STATE.sessionCronTasks.length - remaining.length
  if (removed === 0) return 0
  STATE.sessionCronTasks = remaining
  return removed
}

/** 设置并保存 set Session Trust Accepted 对应的数据或状态。 */
export function setSessionTrustAccepted(accepted: boolean): void {
  STATE.sessionTrustAccepted = accepted
}

/** 获取 get Session Trust Accepted 对应的数据或状态。 */
export function getSessionTrustAccepted(): boolean {
  return STATE.sessionTrustAccepted
}

/** 设置并保存 set Session Persistence Disabled 对应的数据或状态。 */
export function setSessionPersistenceDisabled(disabled: boolean): void {
  STATE.sessionPersistenceDisabled = disabled
}

/** 判断是否满足 is Session Persistence Disabled 对应的数据或状态。 */
export function isSessionPersistenceDisabled(): boolean {
  return STATE.sessionPersistenceDisabled
}

/** 判断是否满足 has Exited Plan Mode In Session 对应的数据或状态。 */
export function hasExitedPlanModeInSession(): boolean {
  return STATE.hasExitedPlanMode
}

/** 设置并保存 set Has Exited Plan Mode 对应的数据或状态。 */
export function setHasExitedPlanMode(value: boolean): void {
  STATE.hasExitedPlanMode = value
}

/** 执行 needs Plan Mode Exit Attachment 对应的业务处理。 */
export function needsPlanModeExitAttachment(): boolean {
  return STATE.needsPlanModeExitAttachment
}

/** 设置并保存 set Needs Plan Mode Exit Attachment 对应的数据或状态。 */
export function setNeedsPlanModeExitAttachment(value: boolean): void {
  STATE.needsPlanModeExitAttachment = value
}

/** 处理 handle Plan Mode Transition 对应的数据或状态。 */
export function handlePlanModeTransition(
  fromMode: string,
  toMode: string,
): void {
  // 如果切换到plan模式，清除任何待处理的exit附件
  // 这防止用户在快速切换时同时发送plan_mode和plan_mode_exit
  if (toMode === 'plan' && fromMode !== 'plan') {
    STATE.needsPlanModeExitAttachment = false
  }

  // 如果切换出plan模式，触发plan_mode_exit附件
  if (fromMode === 'plan' && toMode !== 'plan') {
    STATE.needsPlanModeExitAttachment = true
  }
}

/** 执行 needs Auto Mode Exit Attachment 对应的业务处理。 */
export function needsAutoModeExitAttachment(): boolean {
  return STATE.needsAutoModeExitAttachment
}

/** 设置并保存 set Needs Auto Mode Exit Attachment 对应的数据或状态。 */
export function setNeedsAutoModeExitAttachment(value: boolean): void {
  STATE.needsAutoModeExitAttachment = value
}

/** 处理 handle Auto Mode Transition 对应的数据或状态。 */
export function handleAutoModeTransition(
  fromMode: string,
  toMode: string,
): void {
  // Auto↔plan转换由prepareContextForPlanMode（如果选择加入，auto可在plan期间保持活动）和ExitPlanMode（恢复模式）处理。
  // 跳过两个方向，因此此函数仅处理直接的auto转换。
  if (
    (fromMode === 'auto' && toMode === 'plan') ||
    (fromMode === 'plan' && toMode === 'auto')
  ) {
    return
  }
  const fromIsAuto = fromMode === 'auto'
  const toIsAuto = toMode === 'auto'

  // 如果切换到auto模式，清除任何待处理的exit附件
  // 这防止用户在快速切换时同时发送auto_mode和auto_mode_exit
  if (toIsAuto && !fromIsAuto) {
    STATE.needsAutoModeExitAttachment = false
  }

  // 如果切换出auto模式，触发auto_mode_exit附件
  if (fromIsAuto && !toIsAuto) {
    STATE.needsAutoModeExitAttachment = true
  }
}

// LSP插件推荐会话跟踪
// SDK初始化事件状态
export function setInitJsonSchema(schema: Record<string, unknown>): void {
  STATE.initJsonSchema = schema
}

/** 获取 get Init Json Schema 对应的数据或状态。 */
export function getInitJsonSchema(): Record<string, unknown> | null {
  return STATE.initJsonSchema
}

/** 添加或注册 register Hook Callbacks 对应的数据或状态。 */
export function registerHookCallbacks(
  hooks: Partial<Record<HookEvent, RegisteredHookMatcher[]>>,
): void {
  if (!STATE.registeredHooks) {
    STATE.registeredHooks = {}
  }

  // `registerHookCallbacks`可能被多次调用，因此我们需要合并（而非覆盖）
  for (const [event, matchers] of Object.entries(hooks)) {
    const eventKey = event as HookEvent
    if (!STATE.registeredHooks[eventKey]) {
      STATE.registeredHooks[eventKey] = []
    }
    STATE.registeredHooks[eventKey]!.push(...matchers)
  }
}

/** 获取 get Registered Hooks 对应的数据或状态。 */
export function getRegisteredHooks(): Partial<
  Record<HookEvent, RegisteredHookMatcher[]>
> | null {
  return STATE.registeredHooks
}

/** 删除或清理 clear Registered Hooks 对应的数据或状态。 */
export function clearRegisteredHooks(): void {
  STATE.registeredHooks = null
}

/** 删除或清理 clear Registered Plugin Hooks 对应的数据或状态。 */
export function clearRegisteredPluginHooks(): void {
  if (!STATE.registeredHooks) {
    return
  }

  const filtered: Partial<Record<HookEvent, RegisteredHookMatcher[]>> = {}
  for (const [event, matchers] of Object.entries(STATE.registeredHooks)) {
    // 仅保留回调钩子（没有pluginRoot的那些）
    const callbackHooks = matchers.filter(m => !('pluginRoot' in m))
    if (callbackHooks.length > 0) {
      filtered[event as HookEvent] = callbackHooks
    }
  }

  STATE.registeredHooks = Object.keys(filtered).length > 0 ? filtered : null
}

/** 重置或恢复 reset Sdk Init State 对应的数据或状态。 */
export function resetSdkInitState(): void {
  STATE.initJsonSchema = null
  STATE.registeredHooks = null
}

/** 获取 get Plan Slug Cache 对应的数据或状态。 */
export function getPlanSlugCache(): Map<string, string> {
  return STATE.planSlugCache
}

/** 获取 get Session Created Teams 对应的数据或状态。 */
export function getSessionCreatedTeams(): Set<string> {
  return STATE.sessionCreatedTeams
}

// 调用技能跟踪，以便在压缩过程中保持
export type InvokedSkillInfo = {
  skillName: string
  skillPath: string
  content: string
  invokedAt: number
  agentId: string | null
}

/** 添加或注册 add Invoked Skill 对应的数据或状态。 */
export function addInvokedSkill(
  skillName: string,
  skillPath: string,
  content: string,
  agentId: string | null = null,
): void {
  const key = `${agentId ?? ''}:${skillName}`
  STATE.invokedSkills.set(key, {
    skillName,
    skillPath,
    content,
    invokedAt: Date.now(),
    agentId,
  })
}

/** 获取 get Invoked Skills 对应的数据或状态。 */
export function getInvokedSkills(): Map<string, InvokedSkillInfo> {
  return STATE.invokedSkills
}

/** 获取 get Invoked Skills For Agent 对应的数据或状态。 */
export function getInvokedSkillsForAgent(
  agentId: string | undefined | null,
): Map<string, InvokedSkillInfo> {
  const normalizedId = agentId ?? null
  const filtered = new Map<string, InvokedSkillInfo>()
  for (const [key, skill] of STATE.invokedSkills) {
    if (skill.agentId === normalizedId) {
      filtered.set(key, skill)
    }
  }
  return filtered
}

/** 删除或清理 clear Invoked Skills 对应的数据或状态。 */
export function clearInvokedSkills(
  preservedAgentIds?: ReadonlySet<string>,
): void {
  if (!preservedAgentIds || preservedAgentIds.size === 0) {
    STATE.invokedSkills.clear()
    return
  }
  for (const [key, skill] of STATE.invokedSkills) {
    if (skill.agentId === null || !preservedAgentIds.has(skill.agentId)) {
      STATE.invokedSkills.delete(key)
    }
  }
}

/** 删除或清理 clear Invoked Skills For Agent 对应的数据或状态。 */
export function clearInvokedSkillsForAgent(agentId: string): void {
  for (const [key, skill] of STATE.invokedSkills) {
    if (skill.agentId === agentId) {
      STATE.invokedSkills.delete(key)
    }
  }
}

/** 获取 get Main Thread Agent Type 对应的数据或状态。 */
export function getMainThreadAgentType(): string | undefined {
  return STATE.mainThreadAgentType
}

/** 设置并保存 set Main Thread Agent Type 对应的数据或状态。 */
export function setMainThreadAgentType(agentType: string | undefined): void {
  STATE.mainThreadAgentType = agentType
}

// 系统提示部分访问器

/** 获取 get System Prompt Section Cache 对应的数据或状态。 */
export function getSystemPromptSectionCache(): Map<string, string | null> {
  return STATE.systemPromptSectionCache
}

/** 设置并保存 set System Prompt Section Cache Entry 对应的数据或状态。 */
export function setSystemPromptSectionCacheEntry(
  name: string,
  value: string | null,
): void {
  STATE.systemPromptSectionCache.set(name, value)
}

/** 删除或清理 clear System Prompt Section State 对应的数据或状态。 */
export function clearSystemPromptSectionState(): void {
  STATE.systemPromptSectionCache.clear()
}

// 最后发出的日期访问器（用于检测午夜日期变化）

/** 获取 get Last Emitted Date 对应的数据或状态。 */
export function getLastEmittedDate(): string | null {
  return STATE.lastEmittedDate
}

/** 设置并保存 set Last Emitted Date 对应的数据或状态。 */
export function setLastEmittedDate(date: string | null): void {
  STATE.lastEmittedDate = date
}

/** 获取 get Additional Directories For Claude Md 对应的数据或状态。 */
export function getAdditionalDirectoriesForClaudeMd(): string[] {
  return STATE.additionalDirectoriesForClaudeMd
}

/** 设置并保存 set Additional Directories For Claude Md 对应的数据或状态。 */
export function setAdditionalDirectoriesForClaudeMd(
  directories: string[],
): void {
  STATE.additionalDirectoriesForClaudeMd = directories
}

/** 获取 get Allowed Channels 对应的数据或状态。 */
export function getAllowedChannels(): ChannelEntry[] {
  return STATE.allowedChannels
}

/** 设置并保存 set Allowed Channels 对应的数据或状态。 */
export function setAllowedChannels(entries: ChannelEntry[]): void {
  STATE.allowedChannels = entries
}

/** 获取 get Has Dev Channels 对应的数据或状态。 */
export function getHasDevChannels(): boolean {
  return STATE.hasDevChannels
}

/** 设置并保存 set Has Dev Channels 对应的数据或状态。 */
export function setHasDevChannels(value: boolean): void {
  STATE.hasDevChannels = value
}

/** 获取 get Prompt Cache1h Allowlist 对应的数据或状态。 */
export function getPromptCache1hAllowlist(): string[] | null {
  return STATE.promptCache1hAllowlist
}

/** 设置并保存 set Prompt Cache1h Allowlist 对应的数据或状态。 */
export function setPromptCache1hAllowlist(allowlist: string[] | null): void {
  STATE.promptCache1hAllowlist = allowlist
}

/** 获取 get Prompt Cache1h Eligible 对应的数据或状态。 */
export function getPromptCache1hEligible(): boolean | null {
  return STATE.promptCache1hEligible
}

/** 设置并保存 set Prompt Cache1h Eligible 对应的数据或状态。 */
export function setPromptCache1hEligible(eligible: boolean | null): void {
  STATE.promptCache1hEligible = eligible
}

/** 获取 get Afk Mode Header Latched 对应的数据或状态。 */
export function getAfkModeHeaderLatched(): boolean | null {
  return STATE.afkModeHeaderLatched
}

/** 设置并保存 set Afk Mode Header Latched 对应的数据或状态。 */
export function setAfkModeHeaderLatched(v: boolean): void {
  STATE.afkModeHeaderLatched = v
}

/** 获取 get Fast Mode Header Latched 对应的数据或状态。 */
export function getFastModeHeaderLatched(): boolean | null {
  return STATE.fastModeHeaderLatched
}

/** 设置并保存 set Fast Mode Header Latched 对应的数据或状态。 */
export function setFastModeHeaderLatched(v: boolean): void {
  STATE.fastModeHeaderLatched = v
}

/** 获取 get Thinking Clear Latched 对应的数据或状态。 */
export function getThinkingClearLatched(): boolean | null {
  return STATE.thinkingClearLatched
}

/** 设置并保存 set Thinking Clear Latched 对应的数据或状态。 */
export function setThinkingClearLatched(v: boolean): void {
  STATE.thinkingClearLatched = v
}

/** 将beta头部锁存器重置为null。在/clear和/compact时调用，以便新对话获得新的头部评估。 */
/** 删除或清理 clear Beta Header Latches 对应的数据或状态。 */
export function clearBetaHeaderLatches(): void {
  STATE.afkModeHeaderLatched = null
  STATE.fastModeHeaderLatched = null
  STATE.thinkingClearLatched = null
}

/** 获取 get Prompt Id 对应的数据或状态。 */
export function getPromptId(): string | null {
  return STATE.promptId
}

/** 设置并保存 set Prompt Id 对应的数据或状态。 */
export function setPromptId(id: string | null): void {
  STATE.promptId = id
}
