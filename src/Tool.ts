import type {
  ToolResultBlockParam,
  ToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import type {
  ElicitRequestURLParams,
  ElicitResult,
} from '@modelcontextprotocol/sdk/types.js'
import type { UUID } from 'crypto'
import type { z } from 'zod/v4'
import type { Command } from './commands.js'
import type { CanUseToolFn } from './hooks/useCanUseTool.js'
import type { ThinkingConfig } from './utils/thinking.js'

export type ToolInputJSONSchema = {
  [x: string]: unknown
  type: 'object'
  properties?: {
    [x: string]: unknown
  }
}

import type { Notification } from './context/notifications.js'
import type {
  MCPServerConnection,
  ServerResource,
} from './services/mcp/types.js'
import type {
  AgentDefinition,
  AgentDefinitionsResult,
} from './tools/AgentTool/loadAgentsDir.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  ProgressMessage,
  SystemLocalCommandMessage,
  SystemMessage,
  UserMessage,
} from './types/message.js'
// 从中心位置导入权限类型以打破导入循环
// 从中心位置导入 PermissionResult 以打破导入循环
import type {
  AdditionalWorkingDirectory,
  PermissionMode,
  PermissionResult,
} from './types/permissions.js'
// 从中心位置导入工具进度类型以打破导入循环
import type {
  AgentToolProgress,
  BashProgress,
  MCPProgress,
  SkillToolProgress,
  TaskOutputProgress,
  ToolProgressData,
} from './types/tools.js'
import type { FileStateCache } from './utils/fileStateCache.js'
import type { DenialTrackingState } from './utils/permissions/denialTracking.js'
import type { SystemPrompt } from './utils/systemPromptType.js'
import type { ContentReplacementState } from './utils/toolResultStorage.js'

// 重新导出进度类型以实现向后兼容性
export type {
  AgentToolProgress,
  BashProgress,
  MCPProgress,
  SkillToolProgress,
  TaskOutputProgress,
}

import type { SpinnerMode } from './components/Spinner.js'
import type { QuerySource } from './constants/querySource.js'
import type { SDKStatus } from './entrypoints/agentSdkTypes.js'
import type { AppState } from './state/AppState.js'
import type {
  HookProgress,
  PromptRequest,
  PromptResponse,
} from './types/hooks.js'
import type { AgentId } from './types/ids.js'
import type { DeepImmutable } from './types/utils.js'
import type { FileHistoryState } from './utils/fileHistory.js'
import type { Theme, ThemeName } from './utils/theme.js'

export type QueryChainTracking = {
  chainId: string
  depth: number
}

export type ValidationResult =
  | { result: true }
  | {
      result: false
      message: string
      errorCode: number
    }

export type SetToolJSXFn = (
  args: {
    jsx: React.ReactNode | null
    shouldHidePromptInput: boolean
    shouldContinueAnimation?: true
    showSpinner?: boolean
    isLocalJSXCommand?: boolean
    isImmediate?: boolean
    /** 设置为 true 以清除本地 JSX 命令（例如，从其 onDone 回调） */
    clearLocalJSX?: boolean
  } | null,
) => void

// 从中心位置导入工具权限类型以打破导入循环
import type { ToolPermissionRulesBySource } from './types/permissions.js'

// 重新导出以实现向后兼容性
export type { ToolPermissionRulesBySource }

// 将 DeepImmutable 应用于导入的类型
export type ToolPermissionContext = DeepImmutable<{
  mode: PermissionMode
  additionalWorkingDirectories: Map<string, AdditionalWorkingDirectory>
  alwaysAllowRules: ToolPermissionRulesBySource
  alwaysDenyRules: ToolPermissionRulesBySource
  alwaysAskRules: ToolPermissionRulesBySource
  isBypassPermissionsModeAvailable: boolean
  isAutoModeAvailable?: boolean
  strippedDangerousRules?: ToolPermissionRulesBySource
  /** 如果为 true，则自动拒绝权限提示（例如，无法显示 UI 的后台代理） */
  shouldAvoidPermissionPrompts?: boolean
  /** 当 true 时，在显示权限对话框（协调器工作人员）之前等待自动检查（分类器、挂钩） */
  awaitAutomatedChecksBeforeDialog?: boolean
  /** 存储模型启动的计划模式进入之前的权限模式，因此可以在退出时恢复 */
  prePlanMode?: PermissionMode
}>

/** 获取 get Empty Tool Permission Context 对应的数据或状态。 */
export const getEmptyToolPermissionContext: () => ToolPermissionContext =
  () => ({
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  })

export type CompactProgressEvent =
  | {
      type: 'hooks_start'
      hookType: 'pre_compact' | 'post_compact' | 'session_start'
    }
  | { type: 'compact_start' }
  | { type: 'compact_end' }

export type ToolUseContext = {
  options: {
    commands: Command[]
    debug: boolean
    mainLoopModel: string
    tools: Tools
    verbose: boolean
    thinkingConfig: ThinkingConfig
    mcpClients: MCPServerConnection[]
    mcpResources: Record<string, ServerResource[]>
    isNonInteractiveSession: boolean
    agentDefinitions: AgentDefinitionsResult
    maxBudgetUsd?: number
    /** 自定义系统提示符替换默认系统提示符 */
    customSystemPrompt?: string
    /** 主系统提示符后附加的附加系统提示符 */
    appendSystemPrompt?: string
    /** 仅追加到子代理系统提示词的附加指令。 */
    appendSubagentSystemPrompt?: string
    /** 覆盖 querySource 以进行分析跟踪 */
    querySource?: QuerySource
    /** 用于获取最新工具的可选回调（例如，在 MCP 服务器连接查询中后） */
    refreshTools?: () => Tools
  }
  abortController: AbortController
  readFileState: FileStateCache
  /** 获取 get App State 对应的数据或状态。 */
  getAppState(): AppState
  /** 设置并保存 set App State 对应的数据或状态。 */
  setAppState(f: (prev: AppState) => AppState): void
  /**
   * 始终共享的 setAppState 用于会话范围的基础设施（后台
   * 任务、会话挂钩）。与 setAppState 不同，setAppState 对于异步代理来说是无操作的
   * （请参阅 createSubagentContext），这总是到达根存储，因此代理
   * 在任何嵌套深度都可以注册/清理过时的基础设施
   * 单轮。仅由createSubagentContext设置；主线程上下文
   * 回退到 setAppState。
   */
  setAppStateForTasks?: (f: (prev: AppState) => AppState) => void
  /**
   * 由工具调用错误触发的 URL 引发的可选处理程序 (-32042)。
   * 在打印/SDK 模式下，这委托给 StructuredIO.handleElicitation。
   * 在 REPL 模式下，这是未定义的，并且使用基于队列的 UI 路径。
   */
  handleElicitation?: (
    serverName: string,
    params: ElicitRequestURLParams,
    signal: AbortSignal,
  ) => Promise<ElicitResult>
  setToolJSX?: SetToolJSXFn
  /** 添加或注册 add Notification 对应的数据或状态。 */
  addNotification?: (notif: Notification) => void
  /** 将仅 UI 系统消息附加到 REPL 消息列表。脱光于
   *  NormalizeMessagesForAPI 边界 — Exclude<> 使该类型强制执行。 */
  appendSystemMessage?: (
    msg: Exclude<SystemMessage, SystemLocalCommandMessage>,
  ) => void
  /** 发送操作系统级别的通知（iTerm2、Kitty、Ghostty、bell 等） */
  sendOSNotification?: (opts: {
    message: string
    notificationType: string
  }) => void
  nestedMemoryAttachmentTriggers?: Set<string>
  /**
   * CLAUDE.md 路径已作为nested_memory 附件注入
   * 会议。 memoryFilesToAttachments 的 Dedup — readFileState 是一个 LRU
   * 在繁忙的会话中驱逐条目，因此它的 .has() 检查本身就可以
   * 重新注入相同的 CLAUDE.md 数十次。
   */
  loadedNestedMemoryPaths?: Set<string>
  dynamicSkillDirTriggers?: Set<string>
  userModified?: boolean
  /** 设置并保存 set In Progress Tool Use I Ds 对应的数据或状态。 */
  setInProgressToolUseIDs: (f: (prev: Set<string>) => Set<string>) => void
  /** 仅在交互式 (REPL) 上下文中连接； SDK/QueryEngine 不设置此项。 */
  setHasInterruptibleToolInProgress?: (v: boolean) => void
  /** 设置并保存 set Response Length 对应的数据或状态。 */
  setResponseLength: (f: (prev: number) => number) => void
  /** 当新的 API 请求开始时，由子代理流推送 TTFT 指标。 */
  pushApiMetricsEntry?: (ttftMs: number) => void
  /** 设置并保存 set Stream Mode 对应的数据或状态。 */
  setStreamMode?: (mode: SpinnerMode) => void
  /** 处理 on Compact Progress 对应的数据或状态。 */
  onCompactProgress?: (event: CompactProgressEvent) => void
  /** 设置并保存 set SDK Status 对应的数据或状态。 */
  setSDKStatus?: (status: SDKStatus) => void
  /** 启动或启用 open Message Selector 对应的数据或状态。 */
  openMessageSelector?: () => void
  /** 更新 update File History State 对应的数据或状态。 */
  updateFileHistoryState: (
    updater: (prev: FileHistoryState) => FileHistoryState,
  ) => void
  /** 设置并保存 set Conversation Id 对应的数据或状态。 */
  setConversationId?: (id: UUID) => void
  agentId?: AgentId // 仅为子代理设置；使用 getSessionId() 获取会话 ID。挂钩使用它来区分子代理调用。
  agentType?: string // 子代理类型名称。对于主线程的 --agent 类型，钩子会回退到 getMainThreadAgentType()。
  /** 如果为 true，则即使钩子自动批准，也必须始终调用 canUseTool。
   *  推测用于覆盖文件路径重写。 */
  requireCanUseTool?: boolean
  messages: Message[]
  fileReadingLimits?: {
    maxTokens?: number
    maxSizeBytes?: number
  }
  globLimits?: {
    maxResults?: number
  }
  queryTracking?: QueryChainTracking
  /** 用于向用户请求交互式提示的回调工厂。
   * 返回绑定到给定源名称的提示回调。
   * 仅在交互式 (REPL) 上下文中可用。 */
  requestPrompt?: (
    sourceName: string,
    toolInputSummary?: string | null,
  ) => (request: PromptRequest) => Promise<PromptResponse>
  toolUseId?: string
  criticalSystemReminder_EXPERIMENTAL?: string
  /** 如果为 true，则即使对于子代理，也会在消息上保留 toolUseResult。
   * 由正在处理的队友使用，用户可以查看其记录。 */
  preserveToolUseResults?: boolean
  /** setAppState 为 a 的异步子代理的本地拒绝跟踪状态
   *  无操作。如果没有这个，拒绝计数器永远不会累积，并且
   *  永远不会达到回退提示阈值。可变的——
   *  权限代码将其更新到位。 */
  localDenialTracking?: DenialTrackingState
  /**
   * 工具结果的每个对话线程内容替换状态
   * 预算。如果存在，query.ts 将应用聚合工具结果预算。
   * 主线程：REPL 规定一次（永不重置 — 过时的 UUID 密钥
   * 是惰性的）。子代理：createSubagentContext 克隆父代理的状态
   * 默认情况下（缓存共享分叉需要相同的决策），或者
   * resumeAgentBackground 线程是根据侧链记录重建的。
   */
  contentReplacementState?: ContentReplacementState
  /**
   * 父渲染的系统提示字节，在回合开始时冻结。
   * 由fork子代理用来共享父级的提示缓存——重新调用
   * 分叉生成时的 getSystemPrompt() 可能会发散（local feature configuration 冷→热）
   * 并破坏缓存。请参阅 forkSubagent.ts。
   */
  renderedSystemPrompt?: SystemPrompt
}

// 从集中位置重新导出 ToolProgressData
export type { ToolProgressData }

export type Progress = ToolProgressData | HookProgress

export type ToolProgress<P extends ToolProgressData> = {
  toolUseID: string
  data: P
}

/** 整理 filter Tool Progress Messages 对应的数据或状态。 */
export function filterToolProgressMessages(
  progressMessagesForMessage: ProgressMessage[],
): ProgressMessage<ToolProgressData>[] {
  return progressMessagesForMessage.filter(
    (msg): msg is ProgressMessage<ToolProgressData> =>
      msg.data?.type !== 'hook_progress',
  )
}

export type ToolResult<T> = {
  data: T
  newMessages?: (
    | UserMessage
    | AssistantMessage
    | AttachmentMessage
    | SystemMessage
  )[]
  // contextModifier 仅适用于非并发安全的工具。
  contextModifier?: (context: ToolUseContext) => ToolUseContext
  /** MCP 协议元数据（structedContent、_meta）传递给 SDK 使用者 */
  mcpMeta?: {
    _meta?: Record<string, unknown>
    structuredContent?: Record<string, unknown>
  }
}

export type ToolCallProgress<P extends ToolProgressData = ToolProgressData> = (
  progress: ToolProgress<P>,
) => void

// 任何输出具有字符串键的对象的模式类型
export type AnyObject = z.ZodType<{ [key: string]: unknown }>

/** 检查工具是否与给定主名称匹配。 */
export function toolMatchesName(
  tool: { name: string },
  name: string,
): boolean {
  return tool.name === name
}

/** 从工具列表中按主名称查找工具。 */
export function findToolByName(tools: Tools, name: string): Tool | undefined {
  return tools.find(t => toolMatchesName(t, name))
}

export type Tool<
  Input extends AnyObject = AnyObject,
  Output = unknown,
  P extends ToolProgressData = ToolProgressData,
> = {
  /** 执行 call 对应的数据或状态。 */
  call(
    args: z.infer<Input>,
    context: ToolUseContext,
    canUseTool: CanUseToolFn,
    parentMessage: AssistantMessage,
    onProgress?: ToolCallProgress<P>,
  ): Promise<ToolResult<Output>>
  /** 执行 description 对应的业务处理。 */
  description(
    input: z.infer<Input>,
    options: {
      isNonInteractiveSession: boolean
      toolPermissionContext: ToolPermissionContext
      tools: Tools
    },
  ): Promise<string>
  readonly inputSchema: Input
  // MCP 工具可直接用 JSON Schema 指定输入模式，无需从 Zod 模式转换。
  readonly inputJSONSchema?: ToolInputJSONSchema
  // 当我们这样做时，我们还可以检查并使其更加类型安全。
  outputSchema?: z.ZodType<unknown>
  /** 执行 inputs Equivalent 对应的业务处理。 */
  inputsEquivalent?(a: z.infer<Input>, b: z.infer<Input>): boolean
  /** 判断是否满足 is Concurrency Safe 对应的数据或状态。 */
  isConcurrencySafe(input: z.infer<Input>): boolean
  /** 判断是否满足 is Enabled 对应的数据或状态。 */
  isEnabled(): boolean
  /** 判断是否满足 is Read Only 对应的数据或状态。 */
  isReadOnly(input: z.infer<Input>): boolean
  /** 默认为 false。仅当工具执行不可逆操作（删除、覆盖、发送）时才设置。 */
  isDestructive?(input: z.infer<Input>): boolean
  /**
   * 当用户使用此工具提交新消息时会发生什么
   * 正在运行。
   *
   * - `'cancel'` — 停止工具并放弃其结果
   * - `'block'` — 继续运行；新消息等待
   *
   * 未实现时默认为“阻止”。
   */
  interruptBehavior?(): 'cancel' | 'block'
  /**
   * 返回有关此工具使用是搜索还是读取操作的信息
   * 应该在 UI 中折叠成压缩显示。例子包括
   * 文件搜索（Grep、Glob）、文件读取（Read）和 bash 命令，如 find、
   * grep、wc 等
   *
   * 返回一个对象，指示该操作是搜索还是读取操作：
   * - `isSearch: true` 用于搜索操作（grep、find、glob 模式）
   * - `isRead: true` 用于读取操作（cat、head、tail、文件读取）
   * - `isList: true` 用于目录列表操作（ls、tree、du）
   * - 如果操作不应该折叠，则所有都可以为 false
   */
  isSearchOrReadCommand?(input: z.infer<Input>): {
    isSearch: boolean
    isRead: boolean
    isList?: boolean
  }
  /** 判断是否满足 is Open World 对应的数据或状态。 */
  isOpenWorld?(input: z.infer<Input>): boolean
  /** 执行 requires User Interaction 对应的业务处理。 */
  requiresUserInteraction?(): boolean
  isMcp?: boolean
  isLsp?: boolean
  /**
   * 对于 MCP 工具：从 MCP 服务器接收到的服务器和工具名称（未标准化）。
   * 存在于所有 MCP 工具上，无论“name”是否带有前缀 (mcp__server__tool)
   * 或无前缀（CLAUDE_AGENT_SDK_MCP_NO_PREFIX 模式）。
   */
  mcpInfo?: { serverName: string; toolName: string }
  readonly name: string
  /**
   * 工具结果在保存到磁盘之前的最大大小（以字符为单位）。
   * 超过时，结果将保存到文件中，克劳德会收到预览
   * 使用文件路径而不是完整内容。
   *
   * 对于其输出绝不能持久保存的工具设置为 Infinity（例如 Read、
   * 其中持久创建循环读取→文件→读取循环和工具
   * 已经通过自身的限制进行了自我约束）。
   */
  maxResultSizeChars: number
  /**
   * 如果为 true，则为此工具启用严格模式，这会导致 API
   * 更严格地遵守工具说明和参数模式。
   * 仅在启用 tengu_tool_pear 时应用。
   */
  readonly strict?: boolean

  /**
   * 在观察者看到 tool_use 输入的副本之前调用它（SDK 流，
   * 转录本、canUseTool、PreToolUse/PostToolUse 挂钩）。原地变异
   * 添加遗留/派生字段。必须是幂等的。原始API绑定
   * 输入永远不会改变（保留提示缓存）。当出现以下情况时，不再重新申请
   * hook/permission 返回一个新的updatedInput——它们拥有自己的形状。
   */
  backfillObservableInput?(input: Record<string, unknown>): void

  /**
   * 确定是否允许此工具在当前上下文中使用此输入运行。
   * 它通知模型工具使用失败的原因，并且不直接显示任何 UI。
   * @param input
   * @param context
   */
  validateInput?(
    input: z.infer<Input>,
    context: ToolUseContext,
  ): Promise<ValidationResult>

  /**
   * 确定是否请求用户许可。仅在 validateInput() 通过后调用。
   * 一般权限逻辑位于permissions.ts中。此方法包含特定于工具的逻辑。
   * @param input
   * @param context
   */
  checkPermissions(
    input: z.infer<Input>,
    context: ToolUseContext,
  ): Promise<PermissionResult>

  // 对文件路径进行操作的工具的可选方法
  getPath?(input: z.infer<Input>): string

  /**
   * 为钩子“if”条件准备一个匹配器（权限规则模式，例如
   * “Bash(git *)”中的“git *”）。每个钩子输入对调用一次；任何
   * 昂贵的解析发生在这里。返回一个名为 per 的闭包
   * 钩图案。如果未实现，则仅工具名称级别匹配有效。
   */
  preparePermissionMatcher?(
    input: z.infer<Input>,
  ): Promise<(pattern: string) => boolean>

  /** 执行 prompt 对应的业务处理。 */
  prompt(options: {
    /** 获取 get Tool Permission Context 对应的数据或状态。 */
    getToolPermissionContext: () => Promise<ToolPermissionContext>
    tools: Tools
    agents: AgentDefinition[]
    allowedAgentTypes?: string[]
  }): Promise<string>
  /** 执行 user Facing Name 对应的业务处理。 */
  userFacingName(input: Partial<z.infer<Input>> | undefined): string
  /** 执行 user Facing Name Background Color 对应的业务处理。 */
  userFacingNameBackgroundColor?(
    input: Partial<z.infer<Input>> | undefined,
  ): keyof Theme | undefined
  /**
   * 透明包装器（例如 REPL）将所有渲染委托给其进度
   * 处理程序，它为每个内部工具调用发出看起来本机的块。
   * 包装本身什么也没显示。
   */
  isTransparentWrapper?(): boolean
  /**
   * 返回此工具的简短字符串摘要，用于在紧凑视图中显示。
   * @param input 工具输入
   * @returns 短字符串摘要，或 null 不显示
   */
  getToolUseSummary?(input: Partial<z.infer<Input>> | undefined): string | null
  /**
   * 返回人类可读的现在时活动描述以供旋转器显示。
   * 示例：“读取 src/foo.ts”、“运行包子测试”、“搜索模式”
   * @param input 工具输入
   * @returns 活动描述字符串，或 null 以回退到工具名称
   */
  getActivityDescription?(
    input: Partial<z.infer<Input>> | undefined,
  ): string | null
  /**
   * 返回此工具用于自动模式的紧凑表示
   * 安全分类器。示例：Bash 的“ls -la”、“/tmp/x：新内容”
   * 用于 Edit。返回 '' 以在分类器转录中跳过此工具
   * （例如与安全无关的工具）。可能会返回一个要避免的对象
   * 当调用者 JSON 包装值时进行双重编码。
   */
  toAutoClassifierInput(input: z.infer<Input>): unknown
  /** 转换 map Tool Result To Tool Result Block Param 对应的数据或状态。 */
  mapToolResultToToolResultBlockParam(
    content: Output,
    toolUseID: string,
  ): ToolResultBlockParam
  /**
   * 选修的。当省略时，工具结果不会呈现任何内容（与返回相同）
   * 无效的）。省略其结果已在其他位置呈现的工具。
   */
  renderToolResultMessage?(
    content: Output,
    progressMessagesForMessage: ProgressMessage<P>[],
    options: {
      style?: 'condensed'
      theme: ThemeName
      tools: Tools
      verbose: boolean
      isTranscriptMode?: boolean
      /** 原始 tool_use 输入（如果可用）。对于紧凑的结果很有用
       * 引用请求内容的摘要（例如“发送到#foo”）。 */
      input?: unknown
    },
  ): React.ReactNode
  /**
   * renderToolResultMessage 在 TRANSCRIPT 中显示的扁平化文本
   * 模式（详细 = true，isTranscriptMode = true）。用于成绩单搜索
   * 索引：索引计算该字符串中的出现次数，突出显示
   * 覆盖扫描实际的屏幕缓冲区。对于计数 == 高亮，这
   * 必须返回最终可见的文本——而不是面向模型的文本
   * 从 mapToolResultToToolResultBlockParam 序列化（这增加了
   * 系统提醒、持久输出包装器）。
   *
   * Chrome 可以跳过（计数不足也可以）。 “12 毫秒内找到 3 个文件”
   * 不值得建立索引。幻影并不好——声称的文字
   * 这里但不渲染是一个计数≠突出显示的错误。
   *
   * 可选：省略→transcriptSearch.ts 中的字段名称启发式。
   * test/utils/transcriptSearch.renderFidelity.test.tsx 捕获的漂移
   * 它呈现示例输出并标记已索引但未索引的文本
   * 已渲染（幻影）或已渲染但未索引（计数不足警告）。
   */
  extractSearchText?(out: Output): string
  /**
   * 渲染工具使用消息。请注意，“输入”是部分的，因为我们渲染
   * 尽快（可能在工具参数完全确定之前）发送消息
   * 涌入。
   */
  renderToolUseMessage(
    input: Partial<z.infer<Input>>,
    options: { theme: ThemeName; verbose: boolean; commands?: Command[] },
  ): React.ReactNode
  /**
   * 当此输出的非详细呈现被截断时返回 true
   * （即，单击展开将显示更多内容）。盖茨
   * 单击以全屏展开 - 仅显示实际上很详细的消息
   * 显示更多获得悬停/点击可供性。未设置意味着从未被截断。
   */
  isResultTruncated?(output: Output): boolean
  /**
   * 呈现一个可选标签以在工具使用消息之后显示。
   * 用于附加元数据，如超时、模型、简历 ID 等。
   * 返回 null 不显示任何内容。
   */
  renderToolUseTag?(input: Partial<z.infer<Input>>): React.ReactNode
  /**
   * 选修的。如果省略，则工具运行时不会显示进度 UI。
   */
  renderToolUseProgressMessage?(
    progressMessagesForMessage: ProgressMessage<P>[],
    options: {
      tools: Tools
      verbose: boolean
      terminalSize?: { columns: number; rows: number }
      inProgressToolCallCount?: number
      isTranscriptMode?: boolean
    },
  ): React.ReactNode
  /** 执行 render Tool Use Queued Message 对应的业务处理。 */
  renderToolUseQueuedMessage?(): React.ReactNode
  /**
   * 选修的。省略时，回退到 <FallbackToolUseRejectedMessage />。
   * 仅为需要自定义拒绝 UI 的工具定义此项（例如，文件编辑
   * 显示被拒绝的差异）。
   */
  renderToolUseRejectedMessage?(
    input: z.infer<Input>,
    options: {
      columns: number
      messages: Message[]
      style?: 'condensed'
      theme: ThemeName
      tools: Tools
      verbose: boolean
      progressMessagesForMessage: ProgressMessage<P>[]
      isTranscriptMode?: boolean
    },
  ): React.ReactNode
  /**
   * 选修的。省略时，返回到 <FallbackToolUseErrorMessage />。
   * 仅为需要自定义错误 UI 的工具（例如搜索工具
   * 显示“找不到文件”而不是原始错误）。
   */
  renderToolUseErrorMessage?(
    result: ToolResultBlockParam['content'],
    options: {
      progressMessagesForMessage: ProgressMessage<P>[]
      tools: Tools
      verbose: boolean
      isTranscriptMode?: boolean
    },
  ): React.ReactNode

  /**
   * 将此工具的多个并行实例渲染为一个组。
   * @returns React 节点进行渲染，或 null 回退到单独渲染
   */
  /**
   * 将多个工具使用作为一个组进行渲染（仅限非详细模式）。
   * 在详细模式下，各个工具在其原始位置使用渲染。
   * @returns React 节点进行渲染，或 null 回退到单独渲染
   */
  renderGroupedToolUse?(
    toolUses: Array<{
      param: ToolUseBlockParam
      isResolved: boolean
      isError: boolean
      isInProgress: boolean
      progressMessages: ProgressMessage<P>[]
      result?: {
        param: ToolResultBlockParam
        output: unknown
      }
    }>,
    options: {
      shouldAnimate: boolean
      tools: Tools
    },
  ): React.ReactNode | null
}

/**
 * 工具的集合。使用此类型代替“Tool[]”以使其更容易
 * 跟踪工具集在代码库中的组装、传递和过滤位置。
 */
export type Tools = readonly Tool[]

/**
 * `buildTool` 提供默认值的方法。 `ToolDef` 可以省略这些；
 * 由此产生的“工具”总是有它们。
 */
type DefaultableToolKeys =
  | 'isEnabled'
  | 'isConcurrencySafe'
  | 'isReadOnly'
  | 'isDestructive'
  | 'checkPermissions'
  | 'toAutoClassifierInput'
  | 'userFacingName'

/**
 * `buildTool` 接受的工具定义。与“工具”形状相同，但带有
 * 默认方法可选 - `buildTool` 填充它们，以便调用者始终
 * 查看完整的“工具”。
 */
export type ToolDef<
  Input extends AnyObject = AnyObject,
  Output = unknown,
  P extends ToolProgressData = ToolProgressData,
> = Omit<Tool<Input, Output, P>, DefaultableToolKeys> &
  Partial<Pick<Tool<Input, Output, P>, DefaultableToolKeys>>

/**
 * 类型级展开镜像 `{ ...TOOL_DEFAULTS, ...def }`。对于每个
 * 默认密钥：如果 D 提供（必需），则 D 的类型获胜；如果 D 省略
 * 它或者它是可选的（继承自约束中的 Partial<>），
 * 默认填充。所有其他密钥都逐字来自 D — 保留数量，
 * 可选的存在和文字类型与“满足工具”完全相同。
 */
type BuiltTool<D> = Omit<D, DefaultableToolKeys> & {
  [K in DefaultableToolKeys]-?: K extends keyof D
    ? undefined extends D[K]
      ? ToolDefaults[K]
      : D[K]
    : ToolDefaults[K]
}

/**
 * 从部分定义构建完整的“工具”，填充安全默认值
 * 用于常用的存根方法。所有工具导出都应通过此函数，这样
 * 默认值位于一个地方，调用者永远不需要 `?.() ??默认`。
 *
 * 默认值（重要时失败关闭）：
 * - `isEnabled`→`true`
 * - `isConcurrencySafe`→`false`（假设不安全）
 * - `isReadOnly`→`false`（假设写入）
 * - `isDestructive` → `false`
 * - `checkPermissions` → `{behavior: 'allow', UpdatedInput }`（遵循一般权限系统）
 * - `toAutoClassifierInput` → `''` （跳过分类器 — 安全相关工具必须覆盖）
 * - `userFacingName` → `名称`
 */
const TOOL_DEFAULTS = {
  /** 判断是否满足 is Enabled 对应的数据或状态。 */
  isEnabled: () => true,
  /** 判断是否满足 is Concurrency Safe 对应的数据或状态。 */
  isConcurrencySafe: (_input?: unknown) => false,
  /** 判断是否满足 is Read Only 对应的数据或状态。 */
  isReadOnly: (_input?: unknown) => false,
  /** 判断是否满足 is Destructive 对应的数据或状态。 */
  isDestructive: (_input?: unknown) => false,
  /** 检查 check Permissions 对应的数据或状态。 */
  checkPermissions: (
    input: { [key: string]: unknown },
    _ctx?: ToolUseContext,
  ): Promise<PermissionResult> =>
    Promise.resolve({ behavior: 'allow', updatedInput: input }),
  /** 转换 to Auto Classifier Input 对应的数据或状态。 */
  toAutoClassifierInput: (_input?: unknown) => '',
  /** 执行 user Facing Name 对应的业务处理。 */
  userFacingName: (_input?: unknown) => '',
}

// 默认类型是 TOOL_DEFAULTS 的实际形状（可选参数，因此
// 0-arg 和 full-arg 调用站点类型检查 - 存根的数量和数量各不相同
// 测试依赖于此），而不是接口的严格签名。
type ToolDefaults = typeof TOOL_DEFAULTS

// D 从调用处推断具体的工具定义，约束只限定必需的结构，
// 不会把宽泛类型泄漏到返回值。BuiltTool<D> 在类型层镜像
// 运行时的 `{ ...TOOL_DEFAULTS, ...def }`。
type AnyToolDef = ToolDef<AnyObject, unknown, ToolProgressData>

/** 创建 build Tool 对应的数据或状态。 */
export function buildTool<D extends AnyToolDef>(def: D): BuiltTool<D> {
  // 运行时只是合并默认值与工具定义；类型断言用来表达展开后的
  // 精确 BuiltTool<D> 形状。所有工具都由全量类型检查覆盖。
  return {
    ...TOOL_DEFAULTS,
    /** 执行 user Facing Name 对应的业务处理。 */
    userFacingName: () => def.name,
    ...def,
  } as BuiltTool<D>
}
