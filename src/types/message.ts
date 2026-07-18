/**
 * Internal message compatibility model.
 *
 * The runtime accepts additional fields as protocols evolve, so the base
 * shape remains open while preserving the discriminants used throughout the
 * query, rendering, session and hook pipelines.
 */
export type MessageOrigin = 'user' | 'assistant' | 'system' | string
export type SystemMessageLevel = 'info' | 'warning' | 'error' | string

export type OpenMessage = Record<string, any>
export type UserMessage = any
export type AssistantMessage = any
export type SystemMessage = any
export type AttachmentMessage<T = any> = any
export type ProgressMessage<T = any> = any
export type TombstoneMessage = any
export type Message = any
export type NormalizedMessage = any
export type NormalizedUserMessage = any
export type NormalizedAssistantMessage<T = any> = any
export type RenderableMessage = any
export type CollapsibleMessage = any
export type CollapsedReadSearchGroup = any
export type GroupedToolUseMessage = any
export type HookResultMessage = any
export type SystemAPIErrorMessage = any
export type SystemAgentsKilledMessage = any
export type SystemApiMetricsMessage = any
export type SystemAwaySummaryMessage = any
export type SystemCompactBoundaryMessage = any
export type SystemInformationalMessage = any
export type SystemLocalCommandMessage = any
export type SystemMemorySavedMessage = any
export type SystemMicrocompactBoundaryMessage = any
export type SystemPermissionRetryMessage = any
export type SystemScheduledTaskFireMessage = any
export type SystemStopHookSummaryMessage = any
export type SystemThinkingMessage = any
export type SystemTurnDurationMessage = any
export type ToolUseSummaryMessage = any
export type RequestStartEvent = any
export type StreamEvent = any

export type CompactMetadata = any
export type PartialCompactDirection = any
export type StopHookInfo = any
