// 内部协议常量固定在当前源码的 Schema 版本；公共 SDK 类型由持续维护的
// Agent SDK 依赖提供。
export type * from '@anthropic-ai/claude-agent-sdk'

// 供运行时 Schema 和钩子注册共同使用的常量数组。
export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PermissionRequest',
  'PermissionDenied',
  'Setup',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'Elicitation',
  'ElicitationResult',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'InstructionsLoaded',
  'CwdChanged',
  'FileChanged',
] as const

export const EXIT_REASONS = [
  'clear',
  'resume',
  'prompt_input_exit',
  'other',
  'bypass_permissions_disabled',
] as const
