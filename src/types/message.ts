import type { APIError } from '@anthropic-ai/sdk'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type {
  BetaContentBlock,
  BetaMessage,
  BetaRawMessageStreamEvent,
  BetaToolUseBlock,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { SDKAssistantMessageError } from '@anthropic-ai/claude-agent-sdk'
import type { UUID } from 'node:crypto'
import type { PermissionMode } from './permissions.js'

/**
 * 内部消息协议的核心类型。
 *
 * 这些类型与当前查询、会话存储、Hook 和终端渲染链实际生成的
 * 对象保持一致。协议边界可以携带额外字段，但不再用 `any` 绕过
 * 判别字段和必需属性的静态检查。
 */

/** 标记用户消息的真实来源。缺省值表示键盘输入。 */
export type MessageOrigin =
  | { kind: 'human' }
  | { kind: 'channel'; server: string }
  | { kind: 'coordinator' }
  | { kind: 'task-notification' }

/** 系统消息在终端中的显示级别。 */
export type SystemMessageLevel = 'info' | 'warning' | 'error'

/** 仅用于显式的向前兼容边界，读取额外字段前必须缩小类型。 */
export type OpenMessage = Record<string, unknown>

type MessageBase = {
  uuid: UUID
  timestamp: string
}

/** 发送给模型的用户角色负载。 */
export type UserMessage = MessageBase & {
  type: 'user'
  message: {
    role: 'user'
    content: string | ContentBlockParam[]
  }
  isMeta?: true
  isVisibleInTranscriptOnly?: true
  isVirtual?: true
  isCompactSummary?: true
  summarizeMetadata?: {
    messagesSummarized: number
    userContext?: string
    direction?: PartialCompactDirection
  }
  toolUseResult?: unknown
  mcpMeta?: {
    _meta?: Record<string, unknown>
    structuredContent?: Record<string, unknown>
  }
  imagePasteIds?: number[]
  sourceToolAssistantUUID?: UUID
  permissionMode?: PermissionMode
  origin?: MessageOrigin
}

/** 模型返回的助手角色负载及本地执行元数据。 */
export type AssistantMessage = MessageBase & {
  type: 'assistant'
  message: BetaMessage
  requestId?: string
  apiError?: 'max_output_tokens'
  error?: SDKAssistantMessageError
  errorDetails?: string
  isApiErrorMessage?: boolean
  isMeta?: boolean
  isVirtual?: true
  advisorModel?: string
}

type SystemMessageBase = MessageBase & {
  type: 'system'
  isMeta?: boolean
  content?: string
  level?: SystemMessageLevel
  toolUseID?: string
}

/** 普通系统提示消息。 */
export type SystemInformationalMessage = SystemMessageBase & {
  subtype: 'informational'
  content: string
  level: SystemMessageLevel
  preventContinuation?: boolean
}

/** 记录已放行命令的权限重试消息。 */
export type SystemPermissionRetryMessage = SystemMessageBase & {
  subtype: 'permission_retry'
  content: string
  commands: string[]
  level: 'info'
}

/** 定时任务触发时的系统消息。 */
export type SystemScheduledTaskFireMessage = SystemMessageBase & {
  subtype: 'scheduled_task_fire'
  content: string
}

/** 单个 Hook 的名称、提示和耗时摘要。 */
export type StopHookInfo = {
  command: string
  promptText?: string
  durationMs?: number
}

/** Stop 类 Hook 执行后的聚合摘要。 */
export type SystemStopHookSummaryMessage = SystemMessageBase & {
  subtype: 'stop_hook_summary'
  hookCount: number
  hookInfos: StopHookInfo[]
  hookErrors: string[]
  preventedContinuation: boolean
  stopReason?: string
  hasOutput: boolean
  level: SystemMessageLevel
  hookLabel?: string
  totalDurationMs?: number
}

/** 单轮执行时间和可选 token 预算统计。 */
export type SystemTurnDurationMessage = SystemMessageBase & {
  subtype: 'turn_duration'
  durationMs: number
  budgetTokens?: number
  budgetLimit?: number
  budgetNudges?: number
  messageCount?: number
}

/** 用户离开期间会话活动的摘要。 */
export type SystemAwaySummaryMessage = SystemMessageBase & {
  subtype: 'away_summary'
  content: string
}

/** 记忆文件已落盘的提示。 */
export type SystemMemorySavedMessage = SystemMessageBase & {
  subtype: 'memory_saved'
  writtenPaths: string[]
}

/** 所有后台 Agent 已停止的提示。 */
export type SystemAgentsKilledMessage = SystemMessageBase & {
  subtype: 'agents_killed'
}

/** API 调用的延迟、速度和调度统计。 */
export type SystemApiMetricsMessage = SystemMessageBase & {
  subtype: 'api_metrics'
  ttftMs: number
  otps: number
  isP50?: boolean
  hookDurationMs?: number
  turnDurationMs?: number
  toolDurationMs?: number
  classifierDurationMs?: number
  toolCount?: number
  hookCount?: number
  classifierCount?: number
  configWriteCount?: number
}

/** 本地斜杠命令的输入或输出文本。 */
export type SystemLocalCommandMessage = SystemMessageBase & {
  subtype: 'local_command'
  content: string
  level: 'info'
}

/** 完整压缩边界的持久化元数据。 */
export type CompactMetadata = {
  trigger: 'manual' | 'auto'
  preTokens: number
  userContext?: string
  messagesSummarized?: number
  preCompactDiscoveredTools?: string[]
  preservedSegment?: {
    headUuid: UUID
    anchorUuid: UUID
    tailUuid: UUID
  }
}

/** 会话压缩分界消息。 */
export type SystemCompactBoundaryMessage = SystemMessageBase & {
  subtype: 'compact_boundary'
  content: string
  level: 'info'
  compactMetadata: CompactMetadata
  logicalParentUuid?: UUID
}

/** 工具结果微压缩的详细统计。 */
export type MicrocompactMetadata = {
  trigger: 'auto'
  preTokens: number
  tokensSaved: number
  compactedToolIds: string[]
  clearedAttachmentUUIDs: string[]
}

/** 工具结果微压缩分界消息。 */
export type SystemMicrocompactBoundaryMessage = SystemMessageBase & {
  subtype: 'microcompact_boundary'
  content: string
  level: 'info'
  microcompactMetadata: MicrocompactMetadata
}

/** API 请求重试前向用户展示的错误状态。 */
export type SystemAPIErrorMessage = SystemMessageBase & {
  subtype: 'api_error'
  level: 'error'
  cause?: Error
  error: APIError
  retryInMs: number
  retryAttempt: number
  maxRetries: number
}

/** 仅用于转录兼容的思考系统消息。 */
export type SystemThinkingMessage = SystemMessageBase & {
  subtype: 'thinking'
  content?: string
}

/** 所有可写入内部会话的系统消息联合。 */
export type SystemMessage =
  | SystemInformationalMessage
  | SystemPermissionRetryMessage
  | SystemScheduledTaskFireMessage
  | SystemStopHookSummaryMessage
  | SystemTurnDurationMessage
  | SystemAwaySummaryMessage
  | SystemMemorySavedMessage
  | SystemAgentsKilledMessage
  | SystemApiMetricsMessage
  | SystemLocalCommandMessage
  | SystemCompactBoundaryMessage
  | SystemMicrocompactBoundaryMessage
  | SystemAPIErrorMessage
  | SystemThinkingMessage

/** 具有稳定 type 判别字段的开放附件负载。 */
export type OpenAttachment = { type: string } & Record<string, unknown>

/** 会话附件包装，泛型参数保留具体附件的判别联合。 */
export type AttachmentMessage<T = OpenAttachment> = MessageBase & {
  type: 'attachment'
  attachment: T
}

/** 工具或 Hook 在运行期间的增量进度。 */
export type ProgressMessage<T = Record<string, unknown>> = MessageBase & {
  type: 'progress'
  data: T
  toolUseID: string
  parentToolUseID: string
}

/** 流式回退时用来撤销已产生助手消息的墓碑。 */
export type TombstoneMessage = {
  type: 'tombstone'
  message: AssistantMessage
}

/** 写入会话记录并参与查询的内部消息。 */
export type Message =
  | UserMessage
  | AssistantMessage
  | SystemMessage
  | AttachmentMessage
  | ProgressMessage

/** 内容已拆分为单块的用户消息。 */
export type NormalizedUserMessage = Omit<UserMessage, 'message'> & {
  message: {
    role: 'user'
    content: [ContentBlockParam]
  }
}

/** 内容已拆分为单块的助手消息。 */
export type NormalizedAssistantMessage<
  T extends BetaContentBlock = BetaContentBlock,
> = Omit<AssistantMessage, 'message'> & {
  message: Omit<BetaMessage, 'content'> & { content: [T] }
}

/** 归一化后供 UI 和工具配对使用的消息。 */
export type NormalizedMessage =
  | NormalizedUserMessage
  | NormalizedAssistantMessage
  | SystemMessage
  | AttachmentMessage
  | ProgressMessage

/** 同类工具调用在 UI 中的聚合表示。 */
export type GroupedToolUseMessage = {
  type: 'grouped_tool_use'
  toolName: string
  messages: NormalizedAssistantMessage<BetaToolUseBlock>[]
  results: NormalizedUserMessage[]
  displayMessage: NormalizedAssistantMessage<BetaToolUseBlock>
  uuid: string
  timestamp: string
  messageId: string
}

/** 可被读取/搜索摘要合并的单块消息。 */
export type CollapsibleMessage =
  | NormalizedAssistantMessage<BetaToolUseBlock>
  | NormalizedUserMessage
  | GroupedToolUseMessage

/** 连续读取、搜索和相关 Hook 的 UI 摘要。 */
export type CollapsedReadSearchGroup = {
  type: 'collapsed_read_search'
  searchCount: number
  readCount: number
  listCount: number
  replCount: number
  memorySearchCount: number
  memoryReadCount: number
  memoryWriteCount: number
  readFilePaths: string[]
  searchArgs: string[]
  latestDisplayHint?: string
  messages: CollapsibleMessage[]
  displayMessage: CollapsibleMessage
  uuid: UUID
  timestamp: string
  teamMemorySearchCount?: number
  teamMemoryReadCount?: number
  teamMemoryWriteCount?: number
  mcpCallCount?: number
  mcpServerNames?: string[]
  bashCount?: number
  gitOpBashCount?: number
  commits?: {
    sha: string
    kind: 'committed' | 'amended' | 'cherry-picked'
  }[]
  pushes?: { branch: string }[]
  branches?: { ref: string; action: 'merged' | 'rebased' }[]
  prs?: {
    number: number
    url?: string
    action: 'created' | 'edited' | 'merged' | 'commented' | 'closed' | 'ready'
  }[]
  hookTotalMs?: number
  hookCount?: number
  hookInfos?: StopHookInfo[]
  relevantMemories?: { path: string; content: string; mtimeMs: number }[]
}

/** 终端消息列表可直接渲染的联合。 */
export type RenderableMessage =
  | Exclude<NormalizedMessage, ProgressMessage>
  | GroupedToolUseMessage
  | CollapsedReadSearchGroup

/** 会话启动 Hook 可返回的持久化消息。 */
export type HookResultMessage =
  | UserMessage
  | SystemMessage
  | AttachmentMessage
  | ProgressMessage

/** 工具批次完成后发给 SDK 的人类可读摘要。 */
export type ToolUseSummaryMessage = MessageBase & {
  type: 'tool_use_summary'
  summary: string
  precedingToolUseIds: string[]
}

/** 每次模型流请求开始前的内部边界事件。 */
export type RequestStartEvent = {
  type: 'stream_request_start'
}

/** Anthropic 消息流中的原始事件包装。 */
export type StreamEvent = {
  type: 'stream_event'
  event: BetaRawMessageStreamEvent
  ttftMs?: number
}

/** 局部压缩选择器的方向。 */
export type PartialCompactDirection = 'from' | 'up_to'
