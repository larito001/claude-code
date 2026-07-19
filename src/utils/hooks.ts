/** 钩子是用户定义的 shell 命令，可在 Claude Code 生命周期的各个节点执行。 */
import { basename } from 'path'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { pathExists } from './file.js'
import { wrapSpawn } from './ShellCommand.js'
import { TaskOutput } from './task/TaskOutput.js'
import { getCwd } from './cwd.js'
import { randomUUID } from 'crypto'
import { formatShellPrefixCommand } from './bash/shellPrefix.js'
import {
  getHookEnvFilePath,
  invalidateSessionEnvCache,
} from './sessionEnvironment.js'
import { subprocessEnv } from './subprocessEnv.js'
import { getPlatform } from './platform.js'
import { findGitBashPath, windowsPathToPosixPath } from './windowsPaths.js'
import { getCachedPowerShellPath } from './shell/powershellDetection.js'
import { DEFAULT_HOOK_SHELL } from './shell/shellProvider.js'
import { buildPowerShellArgs } from './shell/powershellProvider.js'
import { getLocalPluginDataDir } from './plugins/localPluginEnvironment.js'
import {
  getSessionId,
  getProjectRoot,
  getIsNonInteractiveSession,
  getRegisteredHooks,
  getStatsStore,
  getOriginalCwd,
  getMainThreadAgentType,
} from '../bootstrap/state.js'
import { checkHasTrustDialogAccepted } from './config.js'
import {
  getHooksConfigFromSnapshot,
  shouldAllowManagedHooksOnly,
  shouldDisableAllHooksIncludingManaged,
} from './hooks/hooksConfigSnapshot.js'
import {
  getCurrentSessionTitle,
  getTranscriptPathForSession,
  getAgentTranscriptPath,
} from './sessionStorage.js'
import type { AgentId } from '../types/ids.js'
import {
  getInitialSettings,
  getSettingsForSource,
} from './settings/settings.js'
import {
  hookJSONOutputSchema,
  promptRequestSchema,
  type HookCallback,
  type HookCallbackMatcher,
  type PromptRequest,
  type PromptResponse,
  isAsyncHookJSONOutput,
  isSyncHookJSONOutput,
  type PermissionRequestResult,
} from '../types/hooks.js'
import type {
  HookEvent,
  HookInput,
  HookJSONOutput,
  NotificationHookInput,
  PostToolUseHookInput,
  PostToolUseFailureHookInput,
  PermissionDeniedHookInput,
  PreCompactHookInput,
  PostCompactHookInput,
  PreToolUseHookInput,
  SessionStartHookInput,
  SessionEndHookInput,
  SetupHookInput,
  StopHookInput,
  StopFailureHookInput,
  SubagentStartHookInput,
  SubagentStopHookInput,
  TeammateIdleHookInput,
  TaskCreatedHookInput,
  TaskCompletedHookInput,
  ConfigChangeHookInput,
  CwdChangedHookInput,
  FileChangedHookInput,
  InstructionsLoadedHookInput,
  UserPromptSubmitHookInput,
  PermissionRequestHookInput,
  ElicitationHookInput,
  ElicitationResultHookInput,
  PermissionUpdate,
  ExitReason,
  SyncHookJSONOutput,
  AsyncHookJSONOutput,
} from 'src/entrypoints/agentSdkTypes.js'
import type { StatusLineCommandInput } from '../types/statusLine.js'
import type { ElicitResult } from '@modelcontextprotocol/sdk/types.js'
import type { FileSuggestionCommandInput } from '../types/fileSuggestion.js'
import type { HookResultMessage } from 'src/types/message.js'
import chalk from 'chalk'
import type {
  HookMatcher,
  HookCommand,
  PluginHookMatcher,
  SkillHookMatcher,
} from './settings/types.js'
import { getHookDisplayText } from './hooks/hooksSettings.js'
import { logForDebugging } from './debug.js'
import { logForDiagnosticsNoPII } from './diagLogs.js'
import { firstLineOf } from './stringUtils.js'
import {
  permissionRuleValueFromString,
} from './permissions/permissionRuleParser.js'
import { logError } from './log.js'
import { createCombinedAbortSignal } from './combinedAbortSignal.js'
import type { PermissionResult } from './permissions/PermissionResult.js'
import { registerPendingAsyncHook } from './hooks/AsyncHookRegistry.js'
import { enqueuePendingNotification } from './messageQueueManager.js'
import {
  extractTextContent,
  getLastAssistantMessage,
  wrapInSystemReminder,
} from './messages.js'
import {
  emitHookStarted,
  emitHookResponse,
  startHookProgressInterval,
} from './hooks/hookEvents.js'
import { createAttachmentMessage } from './attachments.js'
import { all } from './generators.js'
import { findToolByName, type Tools, type ToolUseContext } from '../Tool.js'
import { execPromptHook } from './hooks/execPromptHook.js'
import type { Message, AssistantMessage } from '../types/message.js'
import { execAgentHook } from './hooks/execAgentHook.js'
import { execHttpHook } from './hooks/execHttpHook.js'
import type { ShellCommand } from './ShellCommand.js'
import {
  getSessionHooks,
  getSessionFunctionHooks,
  getSessionHookCallback,
  clearSessionHooks,
  type SessionDerivedHookMatcher,
  type FunctionHook,
} from './hooks/sessionHooks.js'
import type { AppState } from '../state/AppState.js'
import { jsonStringify, jsonParse } from './slowOperations.js'
import { isEnvTruthy } from './envUtils.js'
import { errorMessage, getErrnoCode } from './errors.js'

const TOOL_HOOK_EXECUTION_TIMEOUT_MS = 10 * 60 * 1000

/**
 * SessionEnd 钩子在关闭/清除期间运行，需要比 TOOL_HOOK_EXECUTION_TIMEOUT_MS 更严格的边界。该值被调用者同时用作每个钩子的默认超时时间和整体的 AbortSignal 上限（钩子并行运行，因此一个值就足够了）。可通过环境变量覆盖，以便那些清理脚本需要更多时间的用户使用。
 */
const SESSION_END_HOOK_TIMEOUT_MS_DEFAULT = 1500
/** 获取 get Session End Hook Timeout Ms 对应的数据或状态。 */
export function getSessionEndHookTimeoutMs(): number {
  const raw = process.env.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS
  const parsed = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : SESSION_END_HOOK_TIMEOUT_MS_DEFAULT
}

/** 执行 execute In Background 对应的数据或状态。 */
function executeInBackground({
  processId,
  hookId,
  shellCommand,
  asyncResponse,
  hookEvent,
  hookName,
  command,
  asyncRewake,
  pluginId,
}: {
  processId: string
  hookId: string
  shellCommand: ShellCommand
  asyncResponse: AsyncHookJSONOutput
  hookEvent: HookEvent | 'StatusLine' | 'FileSuggestion'
  hookName: string
  command: string
  asyncRewake?: boolean
  pluginId?: string
}): boolean {
  if (asyncRewake) {
    // asyncRewake 钩子完全绕过注册表。完成后，如果退出码为 2（阻塞错误），则将其排队作为任务通知，以便通过 useQueueProcessor（空闲）唤醒模型，或通过 queued_command 附件（忙碌）在查询过程中注入。
    //
    // 注意：我们故意不在此处调用 shellCommand.background()，因为它会调用 taskOutput.spillToDisk()，从而破坏内存中的 stdout/stderr 捕获（在磁盘模式下 getStderr() 返回空字符串）。StreamWrappers 保持附加状态并将数据管道传输到内存中的 TaskOutput 缓冲区。中止处理器已经对 'interrupt' 原因（用户提交了新消息）执行空操作，因此钩子可以在新提示下存活。硬取消（Escape）会通过中止处理器杀死钩子，这是期望的行为。
    void shellCommand.result.then(async result => {
      // result 在 'exit' 上解析，但 stdio 'data' 事件可能仍然挂起。让出 I/O，以便 StreamWrapper 数据处理程序在我们读取之前排入 TaskOutput。
      await new Promise(resolve => setImmediate(resolve))
      const stdout = await shellCommand.taskOutput.getStdout()
      const stderr = shellCommand.taskOutput.getStderr()
      shellCommand.cleanup()
      emitHookResponse({
        hookId,
        hookName,
        hookEvent,
        output: stdout + stderr,
        stdout,
        stderr,
        exitCode: result.code,
        outcome: result.code === 0 ? 'success' : 'error',
      })
      if (result.code === 2) {
        enqueuePendingNotification({
          value: wrapInSystemReminder(
            `Stop hook blocking error from command "${hookName}": ${stderr || stdout}`,
          ),
          mode: 'task-notification',
        })
      }
    })
    return true
  }

  // ShellCommand 上的 TaskOutput 累积数据 — 不需要流监听器
  if (!shellCommand.background(processId)) {
    return false
  }

  registerPendingAsyncHook({
    processId,
    hookId,
    asyncResponse,
    hookEvent,
    hookName,
    command,
    shellCommand,
    pluginId,
  })

  return true
}
/**
 * 检查是否因缺乏工作区信任而应跳过钩子。
 *
 * 所有钩子都需要工作区信任，因为它们会执行来自 .claude-code-core-framework/settings.json 的任意命令。这是一项深度防御的安全措施。
 *
 * 上下文：钩子通过 captureHooksConfigSnapshot() 在显示信任对话框之前被捕获。虽然大多数钩子在通过正常程序流建立信任后才执行，但对所有钩子强制信任可以防止：
 * - 未来可能出现的意外执行钩子的 bug
 * - 任何可能在信任对话框之前触发钩子的代码路径
 * - 在不受信任的工作区中执行钩子带来的安全问题
 *
 * 促使此检查的历史漏洞：
 * - 用户拒绝信任对话框时执行 SessionEnd 钩子
 * - 子代理在信任之前完成时执行 SubagentStop 钩子
 *
 * @returns 如果应跳过钩子则返回 true，如果应执行则返回 false
 */
export function shouldSkipHookDueToTrust(): boolean {
  // 在非交互模式（SDK）中，信任是隐式的 - 始终执行
  const isInteractive = !getIsNonInteractiveSession()
  if (!isInteractive) {
    return false
  }

  // 在交互模式中，所有钩子都需要信任
  const hasTrust = checkHasTrustDialogAccepted()
  return !hasTrust
}

/** 创建所有钩子类型通用的基础钩子输入 */
export function createBaseHookInput(
  permissionMode?: string,
  sessionId?: string,
  // 窄类型化（不是 ToolUseContext），以便调用者可以直接通过结构类型传递 toolUseContext，而无需此函数依赖 Tool.ts。
  agentInfo?: { agentId?: string; agentType?: string },
): {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} {
  const resolvedSessionId = sessionId ?? getSessionId()
  // agent_type: 子代理的类型（来自 toolUseContext）优先于会话的 --agent 标志。钩子使用 agent_id 的存在来区分 --agent 会话中的子代理调用与主线程调用。
  const resolvedAgentType = agentInfo?.agentType ?? getMainThreadAgentType()
  return {
    session_id: resolvedSessionId,
    transcript_path: getTranscriptPathForSession(resolvedSessionId),
    cwd: getCwd(),
    permission_mode: permissionMode,
    agent_id: agentInfo?.agentId,
    agent_type: resolvedAgentType,
  }
}

export interface HookBlockingError {
  blockingError: string
  command: string
}

/** 从 MCP SDK 重新导出 ElicitResult 作为 ElicitationResponse，以保持向后兼容。 */
export type ElicitationResponse = ElicitResult

export interface HookResult {
  message?: HookResultMessage
  systemMessage?: string
  blockingError?: HookBlockingError
  outcome: 'success' | 'blocking' | 'non_blocking_error' | 'cancelled'
  preventContinuation?: boolean
  stopReason?: string
  permissionBehavior?: 'ask' | 'deny' | 'allow' | 'passthrough'
  hookPermissionDecisionReason?: string
  additionalContext?: string
  sessionTitle?: string
  initialUserMessage?: string
  updatedInput?: Record<string, unknown>
  updatedMCPToolOutput?: unknown
  permissionRequestResult?: PermissionRequestResult
  elicitationResponse?: ElicitationResponse
  watchPaths?: string[]
  elicitationResultResponse?: ElicitationResponse
  retry?: boolean
  hook: HookCommand | HookCallback | FunctionHook
}

export type AggregatedHookResult = {
  message?: HookResultMessage
  blockingError?: HookBlockingError
  preventContinuation?: boolean
  stopReason?: string
  hookPermissionDecisionReason?: string
  hookSource?: string
  permissionBehavior?: PermissionResult['behavior']
  additionalContexts?: string[]
  sessionTitle?: string
  initialUserMessage?: string
  updatedInput?: Record<string, unknown>
  updatedMCPToolOutput?: unknown
  permissionRequestResult?: PermissionRequestResult
  watchPaths?: string[]
  elicitationResponse?: ElicitationResponse
  elicitationResultResponse?: ElicitationResponse
  retry?: boolean
}

/** 解析并验证 JSON 字符串是否符合钩子输出的 Zod 模式。返回验证后的输出或格式化的验证错误。 */
function validateHookJson(
  jsonString: string,
): { json: HookJSONOutput } | { validationError: string } {
  const parsed = jsonParse(jsonString)
  const validation = hookJSONOutputSchema().safeParse(parsed)
  if (validation.success) {
    logForDebugging('Successfully parsed and validated hook JSON output')
    return { json: validation.data }
  }
  const errors = validation.error.issues
    .map(err => `  - ${err.path.join('.')}: ${err.message}`)
    .join('\n')
  return {
    validationError: `Hook JSON output validation failed:\n${errors}\n\nThe hook's output was: ${jsonStringify(parsed, null, 2)}`,
  }
}

/** 解析 parse Hook Output 对应的数据或状态。 */
function parseHookOutput(stdout: string): {
  json?: HookJSONOutput
  plainText?: string
  validationError?: string
} {
  const trimmed = stdout.trim()
  if (!trimmed.startsWith('{')) {
    logForDebugging('Hook output does not start with {, treating as plain text')
    return { plainText: stdout }
  }

  try {
    const result = validateHookJson(trimmed)
    if ('json' in result) {
      return result
    }
    // 对于命令钩子，在错误消息中包含模式提示
    const errorMessage = `${result.validationError}\n\nExpected schema:\n${jsonStringify(
      {
        continue: 'boolean (optional)',
        suppressOutput: 'boolean (optional)',
        stopReason: 'string (optional)',
        decision: '"approve" | "block" (optional)',
        reason: 'string (optional)',
        systemMessage: 'string (optional)',
        hookSpecificOutput: {
          'for PreToolUse': {
            hookEventName: '"PreToolUse"',
            permissionDecision:
              '"allow" | "deny" | "ask" | "defer" (optional)',
            permissionDecisionReason: 'string (optional)',
            updatedInput: 'object (optional) - Modified tool input to use',
          },
          'for UserPromptSubmit': {
            hookEventName: '"UserPromptSubmit"',
            additionalContext: 'string (optional)',
            sessionTitle: 'string (optional)',
          },
          'for PostToolUse': {
            hookEventName: '"PostToolUse"',
            additionalContext: 'string (optional)',
          },
        },
      },
      null,
      2,
    )}`
    logForDebugging(errorMessage)
    return { plainText: stdout, validationError: errorMessage }
  } catch (e) {
    logForDebugging(`Failed to parse hook output as JSON: ${e}`)
    return { plainText: stdout }
  }
}

/** 解析 parse Http Hook Output 对应的数据或状态。 */
function parseHttpHookOutput(body: string): {
  json?: HookJSONOutput
  validationError?: string
} {
  const trimmed = body.trim()

  if (trimmed === '') {
    const validation = hookJSONOutputSchema().safeParse({})
    if (validation.success) {
      logForDebugging(
        'HTTP hook returned empty body, treating as empty JSON object',
      )
      return { json: validation.data }
    }
  }

  if (!trimmed.startsWith('{')) {
    const validationError = `HTTP hook must return JSON, but got non-JSON response body: ${trimmed.length > 200 ? trimmed.slice(0, 200) + '\u2026' : trimmed}`
    logForDebugging(validationError)
    return { validationError }
  }

  try {
    const result = validateHookJson(trimmed)
    if ('json' in result) {
      return result
    }
    logForDebugging(result.validationError)
    return result
  } catch (e) {
    const validationError = `HTTP hook must return valid JSON, but parsing failed: ${e}`
    logForDebugging(validationError)
    return { validationError }
  }
}

/** 处理 process Hook JSON Output 对应的数据或状态。 */
function processHookJSONOutput({
  json,
  command,
  hookName,
  toolUseID,
  hookEvent,
  expectedHookEvent,
  stdout,
  stderr,
  exitCode,
  durationMs,
}: {
  json: SyncHookJSONOutput
  command: string
  hookName: string
  toolUseID: string
  hookEvent: HookEvent
  expectedHookEvent?: HookEvent
  stdout?: string
  stderr?: string
  exitCode?: number
  durationMs?: number
}): Partial<HookResult> {
  const result: Partial<HookResult> = {}

  // 此时我们知道它是同步响应
  const syncJson = json

  // 处理常见元素
  if (syncJson.continue === false) {
    result.preventContinuation = true
    if (syncJson.stopReason) {
      result.stopReason = syncJson.stopReason
    }
  }

  if (json.decision) {
    switch (json.decision) {
      case 'approve':
        result.permissionBehavior = 'allow'
        break
      case 'block':
        result.permissionBehavior = 'deny'
        result.blockingError = {
          blockingError: json.reason || 'Blocked by hook',
          command,
        }
        break
      default:
        // 将未知决策类型视为错误
        throw new Error(
          `Unknown hook decision type: ${json.decision}. Valid types are: approve, block`,
        )
    }
  }

  // 处理 systemMessage 字段
  if (json.systemMessage) {
    result.systemMessage = json.systemMessage
  }

  // 处理 PreToolUse 特定内容
  if (
    json.hookSpecificOutput?.hookEventName === 'PreToolUse' &&
    json.hookSpecificOutput.permissionDecision
  ) {
    switch (json.hookSpecificOutput.permissionDecision) {
      case 'allow':
        result.permissionBehavior = 'allow'
        break
      case 'deny':
        result.permissionBehavior = 'deny'
        result.blockingError = {
          blockingError: json.reason || 'Blocked by hook',
          command,
        }
        break
      case 'ask':
        result.permissionBehavior = 'ask'
        break
      case 'defer':
        result.permissionBehavior = 'passthrough'
        break
      default:
        // 将未知决策类型视为错误
        throw new Error(
          `Unknown hook permissionDecision type: ${json.hookSpecificOutput.permissionDecision}. Valid types are: allow, deny, ask, defer`,
        )
    }
  }
  if (result.permissionBehavior !== undefined && json.reason !== undefined) {
    result.hookPermissionDecisionReason = json.reason
  }

  // 处理 hookSpecificOutput
  if (json.hookSpecificOutput) {
    // 如果提供了钩子事件名称，则验证其是否与预期匹配
    if (
      expectedHookEvent &&
      json.hookSpecificOutput.hookEventName !== expectedHookEvent
    ) {
      throw new Error(
        `Hook returned incorrect event name: expected '${expectedHookEvent}' but got '${json.hookSpecificOutput.hookEventName}'. Full stdout: ${jsonStringify(json, null, 2)}`,
      )
    }

    switch (json.hookSpecificOutput.hookEventName) {
      case 'PreToolUse':
        // 如果提供了更具体的权限决策，则覆盖
        if (json.hookSpecificOutput.permissionDecision) {
          switch (json.hookSpecificOutput.permissionDecision) {
            case 'allow':
              result.permissionBehavior = 'allow'
              break
            case 'deny':
              result.permissionBehavior = 'deny'
              result.blockingError = {
                blockingError:
                  json.hookSpecificOutput.permissionDecisionReason ||
                  json.reason ||
                  'Blocked by hook',
                command,
              }
              break
            case 'ask':
              result.permissionBehavior = 'ask'
              break
            case 'defer':
              result.permissionBehavior = 'passthrough'
              break
          }
        }
        result.hookPermissionDecisionReason =
          json.hookSpecificOutput.permissionDecisionReason
        // 提取 updatedInput（如果提供）
        if (json.hookSpecificOutput.updatedInput) {
          result.updatedInput = json.hookSpecificOutput.updatedInput
        }
        // 如果提供了 additionalContext，则提取它
        result.additionalContext = json.hookSpecificOutput.additionalContext
        break
      case 'UserPromptSubmit':
        result.additionalContext = json.hookSpecificOutput.additionalContext
        result.sessionTitle = json.hookSpecificOutput.sessionTitle
        break
      case 'SessionStart':
        result.additionalContext = json.hookSpecificOutput.additionalContext
        result.initialUserMessage = json.hookSpecificOutput.initialUserMessage
        if (
          'watchPaths' in json.hookSpecificOutput &&
          json.hookSpecificOutput.watchPaths
        ) {
          result.watchPaths = json.hookSpecificOutput.watchPaths
        }
        break
      case 'Setup':
        result.additionalContext = json.hookSpecificOutput.additionalContext
        break
      case 'SubagentStart':
        result.additionalContext = json.hookSpecificOutput.additionalContext
        break
      case 'PostToolUse':
        result.additionalContext = json.hookSpecificOutput.additionalContext
        // 如果提供了 updatedMCPToolOutput，则提取它
        if (json.hookSpecificOutput.updatedMCPToolOutput) {
          result.updatedMCPToolOutput =
            json.hookSpecificOutput.updatedMCPToolOutput
        }
        break
      case 'PostToolUseFailure':
        result.additionalContext = json.hookSpecificOutput.additionalContext
        break
      case 'PermissionDenied':
        result.retry = json.hookSpecificOutput.retry
        break
      case 'PermissionRequest':
        // 提取权限请求决定
        if (json.hookSpecificOutput.decision) {
          result.permissionRequestResult = json.hookSpecificOutput.decision
          // 同时更新 permissionBehavior 以保持一致性
          result.permissionBehavior =
            json.hookSpecificOutput.decision.behavior === 'allow'
              ? 'allow'
              : 'deny'
          if (
            json.hookSpecificOutput.decision.behavior === 'allow' &&
            json.hookSpecificOutput.decision.updatedInput
          ) {
            result.updatedInput = json.hookSpecificOutput.decision.updatedInput
          }
        }
        break
      case 'Elicitation':
        if (json.hookSpecificOutput.action) {
          result.elicitationResponse = {
            action: json.hookSpecificOutput.action,
            content: json.hookSpecificOutput.content as
              | ElicitationResponse['content']
              | undefined,
          }
          if (json.hookSpecificOutput.action === 'decline') {
            result.blockingError = {
              blockingError: json.reason || 'Elicitation denied by hook',
              command,
            }
          }
        }
        break
      case 'ElicitationResult':
        if (json.hookSpecificOutput.action) {
          result.elicitationResultResponse = {
            action: json.hookSpecificOutput.action,
            content: json.hookSpecificOutput.content as
              | ElicitationResponse['content']
              | undefined,
          }
          if (json.hookSpecificOutput.action === 'decline') {
            result.blockingError = {
              blockingError:
                json.reason || 'Elicitation result blocked by hook',
              command,
            }
          }
        }
        break
    }
  }

  return {
    ...result,
    message: result.blockingError
      ? createAttachmentMessage({
          type: 'hook_blocking_error',
          hookName,
          toolUseID,
          hookEvent,
          blockingError: result.blockingError,
        })
      : createAttachmentMessage({
          type: 'hook_success',
          hookName,
          toolUseID,
          hookEvent,
          // JSON 输出钩子通过 additionalContext → hook_additional_context 注入上下文，而不是此字段。空内容会抑制每轮污染消息的琐碎 "X hook success: Success" 系统提醒（messages.ts:3577 在 '' 时跳过）。
          content: '',
          stdout,
          stderr,
          exitCode,
          command,
          durationMs,
        }),
  }
}

/**
 * 使用 bash 或 PowerShell 执行基于命令的钩子。
 *
 * Shell 解析：hook.shell → 'bash'。PowerShell 钩子启动 pwsh 并携带 -NoProfile -NonInteractive -Command，跳过 bash 特定的准备（POSIX 路径转换、.sh 自动前置、CLAUDE_CODE_SHELL_PREFIX）。参见 docs/design/ps-shell-selection.md §5.1。
 */
async function execCommandHook(
  hook: HookCommand & { type: 'command' },
  hookEvent: HookEvent | 'StatusLine' | 'FileSuggestion',
  hookName: string,
  jsonInput: string,
  signal: AbortSignal,
  hookId: string,
  hookIndex?: number,
  pluginRoot?: string,
  pluginId?: string,
  skillRoot?: string,
  forceSyncExecution?: boolean,
  requestPrompt?: (request: PromptRequest) => Promise<PromptResponse>,
): Promise<{
  stdout: string
  stderr: string
  output: string
  status: number
  aborted?: boolean
  backgrounded?: boolean
}> {
  // 限制为每会话一次事件，以保持 diag_log 体积可控。started/completed 位于 try/finally 内部，因此设置路径抛出异常时不会孤立 started 标记——否则无法与挂起区分。
  const shouldEmitDiag =
    hookEvent === 'SessionStart' ||
    hookEvent === 'Setup' ||
    hookEvent === 'SessionEnd'
  const diagStartMs = Date.now()
  let diagExitCode: number | undefined
  let diagAborted = false

  const isWindows = getPlatform() === 'windows'

  // --
  // 每个钩子的 Shell 选择（docs/design/ps-shell-selection.md 阶段 1）。
  // 解析顺序：hook.shell → DEFAULT_HOOK_SHELL。defaultShell 回退（settings.defaultShell）是阶段 2——尚未接入。
  //
  // bash 路径是历史默认值，保持不变。PowerShell 路径特意跳过了 Windows 特定的 bash 适配（cygpath 转换、.sh 自动前置、POSIX 引用的 SHELL_PREFIX）。
  const shellType = hook.shell ?? DEFAULT_HOOK_SHELL

  const isPowerShell = shellType === 'powershell'

  // --
  // Windows bash 路径：钩子通过 Git Bash（Cygwin）运行，而不是 cmd.exe。
  //
  // 这意味着我们放入环境变量或替换进命令字符串的每个路径必须是 POSIX 路径（/c/Users/foo），而不是 Windows 路径（C:\Users\foo 或 C:/Users/foo）。Git Bash 无法解析 Windows 路径。
  //
  // windowsPathToPosixPath() 是纯 JS 正则转换（无 cygpath 外部调用）：C:\Users\foo → /c/Users/foo，保留 UNC，翻转斜杠。已记忆化（LRU-500），因此重复调用开销小。
  //
  // PowerShell 路径：使用原生路径——完全跳过转换。PowerShell 在 Windows 上期望 Windows 路径（在 Unix 上 pwsh 也可用，使用原生路径）。
  const toHookPath =
    isWindows && !isPowerShell
      ? (p: string) => windowsPathToPosixPath(p)
      : (p: string) => p

  // 将 CLAUDE_PROJECT_DIR 设置为稳定的项目根目录（而不是工作树路径）。getProjectRoot() 在进入工作树时从不更新，因此引用 $CLAUDE_PROJECT_DIR 的钩子始终相对于真正的仓库根目录解析。
  const projectDir = getProjectRoot()

  let command = hook.command
  if (pluginRoot) {
    // 插件目录已消失（孤立的垃圾回收竞争，并发会话删除了它）：抛出异常，以便调用者产生非阻塞错误。运行将失败——且 `python3 <missing>.py` 退出码 2，即钩子协议的“阻止”代码，这会阻塞 UserPromptSubmit/Stop 直到重启。该预检查是必要的，因为因脚本缺失导致的退出码 2 与生成后的有意阻止无法区分。
    if (!(await pathExists(pluginRoot))) {
      throw new Error(
        `Plugin directory does not exist: ${pluginRoot}` +
          (pluginId ? ` (${pluginId} — restart with a valid --plugin-dir path)` : ''),
      )
    }
    // 内联 ROOT 和 DATA 替换，而不是调用 substitutePluginVariables()。该辅助函数无条件地在 Windows 上规范化 \ → / ——对于 bash 是正确的（toHookPath 已经产生 /c/... 因此是空操作），但对于 PS 是错误的，因为 toHookPath 是恒等函数，我们想要原生的 C:\... 反斜杠。内联还允许我们使用函数形式的 .replace()，从而包含 $ 的路径不会被 $-模式解释破坏（罕见但可能：\\server\c$\plugin）。
    const rootPath = toHookPath(pluginRoot)
    command = command.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, () => rootPath)
    if (pluginId) {
      const dataPath = toHookPath(getLocalPluginDataDir(pluginId))
      command = command.replace(/\$\{CLAUDE_PLUGIN_DATA\}/g, () => dataPath)
    }
  }

  // 在 Windows 上（仅 bash），自动为 .sh 脚本前置 `bash`，以便它们执行而不是在默认文件处理程序中打开。PowerShell 原生运行 .ps1 文件——不需要前置。
  if (isWindows && !isPowerShell && command.trim().match(/\.sh(\s|$|")/)) {
    if (!command.trim().startsWith('bash ')) {
      command = `bash ${command}`
    }
  }

  // CLAUDE_CODE_SHELL_PREFIX 通过 POSIX 引号包裹命令（formatShellPrefixCommand 使用 shell-quote）。这对 PowerShell 没有意义——参见设计 §8.1。目前 PS 钩子忽略此前缀；将来可能会引入 CLAUDE_CODE_PS_SHELL_PREFIX（或 shell 感知的前缀）。
  const finalCommand =
    !isPowerShell && process.env.CLAUDE_CODE_SHELL_PREFIX
      ? formatShellPrefixCommand(process.env.CLAUDE_CODE_SHELL_PREFIX, command)
      : command

  const hookTimeoutMs = hook.timeout
    ? hook.timeout * 1000
    : TOOL_HOOK_EXECUTION_TIMEOUT_MS

  // 构建环境变量——所有路径通过 toHookPath 进行 Windows POSIX 转换
  const envVars: NodeJS.ProcessEnv = {
    ...subprocessEnv(),
    CLAUDE_PROJECT_DIR: toHookPath(projectDir),
  }

  // 插件和技能钩子都设置 CLAUDE_PLUGIN_ROOT（技能为保持一致性使用同一名称——技能可以迁移到插件而无需更改代码）
  if (pluginRoot) {
    envVars.CLAUDE_PLUGIN_ROOT = toHookPath(pluginRoot)
    if (pluginId) {
      envVars.CLAUDE_PLUGIN_DATA = toHookPath(
        getLocalPluginDataDir(pluginId),
      )
    }
  }
  if (skillRoot) {
    envVars.CLAUDE_PLUGIN_ROOT = toHookPath(skillRoot)
  }

  // CLAUDE_ENV_FILE 指向一个 .sh 文件，钩子将环境变量定义写入其中；getSessionEnvironmentScript() 连接它们，bashProvider 将内容注入 bash 命令。PS 钩子自然写入 PS 语法 ($env:FOO = 'bar')，bash 无法解析。跳过 PS——与上面已经仅限 bash 的 .sh 前置和 SHELL_PREFIX 一致。
  if (
    !isPowerShell &&
    (hookEvent === 'SessionStart' ||
      hookEvent === 'Setup' ||
      hookEvent === 'CwdChanged' ||
      hookEvent === 'FileChanged') &&
    hookIndex !== undefined
  ) {
    envVars.CLAUDE_ENV_FILE = await getHookEnvFilePath(hookEvent, hookIndex)
  }

  // 当代理工作树被移除时，getCwd() 可能通过 AsyncLocalStorage 返回已删除的路径。在生成前验证，因为 spawn() 对于缺失的 cwd 会异步发出 'error' 事件而不是同步抛出。
  const hookCwd = getCwd()
  const safeCwd = (await pathExists(hookCwd)) ? hookCwd : getOriginalCwd()
  if (safeCwd !== hookCwd) {
    logForDebugging(
      `Hooks: cwd ${hookCwd} not found, falling back to original cwd`,
      { level: 'warn' },
    )
  }

  // --
  // 生成进程。两条完全独立的路径：
  //
  //   Bash 路径：spawn(cmd, [], { shell: <gitBashPath | true> })——shell
  //   选项让 Node 将整个字符串传递给 shell 进行解析。
  //
  //   PowerShell 路径：spawn(pwshPath, ['-NoProfile', '-NonInteractive',
  //   '-Command', cmd]) — 显式 argv，无 shell 选项。 -NoProfile
  //   跳过用户配置文件脚本（更快、确定性）。
  //   -NonInteractive 快速失败而非提示。
  //
  // 用于 bash 钩子的 findGitBashPath() 中的 Git Bash 强制退出仍然存在。
  // PowerShell 钩子从未调用它，因此仅安装了 pwsh 并在每个钩子上设置 shell: 'powershell' 的 Windows 用户理论上可以在没有 Git Bash 的情况下运行 — 但 init.ts 在启动时仍然调用 setShellIfWindows()，这将首先退出。放宽这一点是设计实现顺序的第一阶段（单独的 PR）。
  let child: ChildProcessWithoutNullStreams
  if (shellType === 'powershell') {
    const pwshPath = await getCachedPowerShellPath()
    if (!pwshPath) {
      throw new Error(
        `Hook "${hook.command}" has shell: 'powershell' but no PowerShell ` +
          `executable (pwsh or powershell) was found on PATH. Install ` +
          `PowerShell, or remove "shell": "powershell" to use bash.`,
      )
    }
    child = spawn(pwshPath, buildPowerShellArgs(finalCommand), {
      env: envVars,
      cwd: safeCwd,
      // 阻止在 Windows 上显示控制台窗口（在其他平台上无操作）
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams
  } else {
    // 在 Windows 上，显式使用 Git Bash（cmd.exe 无法运行 bash 语法）。
    // 在其他平台上，shell: true 使用 /bin/sh。
    const shell = isWindows ? findGitBashPath() : true
    child = spawn(finalCommand, [], {
      env: envVars,
      cwd: safeCwd,
      shell,
      // 阻止在 Windows 上显示控制台窗口（在其他平台上无操作）
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams
  }

  // 钩子使用管道模式 — stdout 必须流入 JS，以便我们解析第一行响应来检测异步钩子 ({"async": true})。
  const hookTaskOutput = new TaskOutput(`hook_${child.pid}`, null)
  const shellCommand = wrapSpawn(child, signal, hookTimeoutMs, hookTaskOutput)
  // 跟踪 shellCommand 所有权是否已转移（例如，转移到异步钩子注册表）
  let shellCommandTransferred = false
  // 跟踪 stdin 是否已写入（以避免“写入后结束”错误）
  let stdinWritten = false

  if ((hook.async || hook.asyncRewake) && !forceSyncExecution) {
    const processId = `async_hook_${child.pid}`
    logForDebugging(
      `Hooks: Config-based async hook, backgrounding process ${processId}`,
    )

    // 在后台执行之前写入 stdin，以便钩子接收其输入。
    // 尾随换行符与同步路径匹配 (L1000)。如果没有它，
    // bash `read -r line` 返回退出码 1（在分隔符之前遇到 EOF）— 变量
    // 已填充但 `if read -r line; then ...` 跳过了该分支。
    // 请参阅 gh-30509 / CC-161。
    child.stdin.write(jsonInput + '\n', 'utf8')
    child.stdin.end()
    stdinWritten = true

    const backgrounded = executeInBackground({
      processId,
      hookId,
      shellCommand,
      asyncResponse: { async: true, asyncTimeout: hookTimeoutMs },
      hookEvent,
      hookName,
      command: hook.command,
      asyncRewake: hook.asyncRewake,
      pluginId,
    })
    if (backgrounded) {
      return {
        stdout: '',
        stderr: '',
        output: '',
        status: 0,
        backgrounded: true,
      }
    }
  }

  let stdout = ''
  let stderr = ''
  let output = ''

  // 使用显式 UTF-8 编码设置输出数据收集
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')

  let initialResponseChecked = false

  let asyncResolve:
    | ((result: {
        stdout: string
        stderr: string
        output: string
        status: number
      }) => void)
    | null = null
  const childIsAsyncPromise = new Promise<{
    stdout: string
    stderr: string
    output: string
    status: number
    aborted?: boolean
  }>(resolve => {
    asyncResolve = resolve
  })

  // 跟踪我们处理过的修剪后的提示请求行，以便通过内容匹配从最终 stdout 中剥离它们（无索引跟踪 → 无索引漂移）
  const processedPromptLines = new Set<string>()
  // 序列化异步提示处理，以便按顺序发送响应
  let promptChain = Promise.resolve()
  // 用于检测流式输出中提示请求的行缓冲区
  let lineBuffer = ''

  child.stdout.on('data', data => {
    stdout += data
    output += data

    // 当提供 requestPrompt 时，逐行解析 stdout 以查找提示请求
    if (requestPrompt) {
      lineBuffer += data
      const lines = lineBuffer.split('\n')
      lineBuffer = lines.pop() ?? '' // 最后一个元素是不完整的行

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue

        try {
          const parsed = jsonParse(trimmed)
          const validation = promptRequestSchema().safeParse(parsed)
          if (validation.success) {
            processedPromptLines.add(trimmed)
            logForDebugging(
              `Hooks: Detected prompt request from hook: ${trimmed}`,
            )
            // 链接异步处理以序列化提示响应
            const promptReq = validation.data
            const reqPrompt = requestPrompt
            promptChain = promptChain.then(async () => {
              try {
                const response = await reqPrompt(promptReq)
                child.stdin.write(jsonStringify(response) + '\n', 'utf8')
              } catch (err) {
                logForDebugging(`Hooks: Prompt request handling failed: ${err}`)
                // 用户取消或提示失败 — 关闭 stdin，以便钩子进程不会挂起等待输入
                child.stdin.destroy()
              }
            })
            continue
          }
        } catch {
          // Not JSON, just a normal line
        }
      }
    }

    // 在输出的第一行检查异步响应。异步协议是：
    // 钩子首先发出 {"async":true,...} 作为其第一行，然后是正常输出。
    // 我们必须只解析第一行 — 如果进程很快，在此 'data' 事件触发之前写入更多内容，解析完整累积的 stdout 会失败，异步钩子会阻塞其整个持续时间而不是后台执行。
    if (!initialResponseChecked) {
      const firstLine = firstLineOf(stdout).trim()
      if (!firstLine.includes('}')) return
      initialResponseChecked = true
      logForDebugging(`Hooks: Checking first line for async: ${firstLine}`)
      try {
        const parsed = jsonParse(firstLine)
        logForDebugging(
          `Hooks: Parsed initial response: ${jsonStringify(parsed)}`,
        )
        if (isAsyncHookJSONOutput(parsed) && !forceSyncExecution) {
          const processId = `async_hook_${child.pid}`
          logForDebugging(
            `Hooks: Detected async hook, backgrounding process ${processId}`,
          )

          const backgrounded = executeInBackground({
            processId,
            hookId,
            shellCommand,
            asyncResponse: parsed,
            hookEvent,
            hookName,
            command: hook.command,
            pluginId,
          })
          if (backgrounded) {
            shellCommandTransferred = true
            asyncResolve?.({
              stdout,
              stderr,
              output,
              status: 0,
            })
          }
        } else if (isAsyncHookJSONOutput(parsed) && forceSyncExecution) {
          logForDebugging(
            `Hooks: Detected async hook but forceSyncExecution is true, waiting for completion`,
          )
        } else {
          logForDebugging(
            `Hooks: Initial response is not async, continuing normal processing`,
          )
        }
      } catch (e) {
        logForDebugging(`Hooks: Failed to parse initial response as JSON: ${e}`)
      }
    }
  })

  child.stderr.on('data', data => {
    stderr += data
    output += data
  })

  const stopProgressInterval = startHookProgressInterval({
    hookId,
    hookName,
    hookEvent,
    /** 获取 get Output 对应的数据或状态。 */
    getOutput: async () => ({ stdout, stderr, output }),
  })

  // 在认为输出完成之前，等待 stdout 和 stderr 流结束
  // 这可以防止在 'close' 事件在所有 'data' 事件处理之前触发的竞态条件
  const stdoutEndPromise = new Promise<void>(resolve => {
    child.stdout.on('end', () => resolve())
  })

  const stderrEndPromise = new Promise<void>(resolve => {
    child.stderr.on('end', () => resolve())
  })

  // 写入 stdin，确保处理当钩子命令在读取所有输入之前退出时可能发生的 EPIPE 错误。
  // 注意：由于 Bun 和 Node 的行为不同，在测试中很难设置 EPIPE 处理。
  // TODO: 添加 EPIPE 处理的测试。
  // 如果 stdin 已写入（例如，通过基于配置的异步钩子路径），则跳过
  const stdinWritePromise = stdinWritten
    ? Promise.resolve()
    : new Promise<void>((resolve, reject) => {
        child.stdin.on('error', err => {
          // 当提供 requestPrompt 时，stdin 保持打开以接收提示响应。
          // 后续写入（进程退出后）的 EPIPE 错误是预期的 — 抑制它们。
          if (!requestPrompt) {
            reject(err)
          } else {
            logForDebugging(
              `Hooks: stdin error during prompt flow (likely process exited): ${err}`,
            )
          }
        })
        // 显式指定 UTF-8 编码以确保正确处理 Unicode 字符
        child.stdin.write(jsonInput + '\n', 'utf8')
        // 当提供 requestPrompt 时，保持 stdin 打开以接收提示响应
        if (!requestPrompt) {
          child.stdin.end()
        }
        resolve()
      })

  // 为子进程错误创建 promise
  const childErrorPromise = new Promise<never>((_, reject) => {
    child.on('error', reject)
  })

  // 为子进程 close 创建 promise - 但仅在流结束后才 resolve，以确保所有输出已收集
  const childClosePromise = new Promise<{
    stdout: string
    stderr: string
    output: string
    status: number
    aborted?: boolean
  }>(resolve => {
    let exitCode: number | null = null

    child.on('close', code => {
      exitCode = code ?? 1

      // 等待两个流都结束，然后以最终输出进行解析
      void Promise.all([stdoutEndPromise, stderrEndPromise]).then(() => {
        // 去除我们作为提示请求处理的行，以便 parseHookOutput 只看到最终的钩子结果。与实际处理的行集合进行内容匹配意味着提示 JSON 永远不会泄露（故障封闭），无论行的位置如何。
        const finalStdout =
          processedPromptLines.size === 0
            ? stdout
            : stdout
                .split('\n')
                .filter(line => !processedPromptLines.has(line.trim()))
                .join('\n')

        resolve({
          stdout: finalStdout,
          stderr,
          output,
          status: exitCode!,
          aborted: signal.aborted,
        })
      })
    })
  })

  // 在 stdin 写入、异步检测和进程完成之间竞争
  try {
    if (shouldEmitDiag) {
      logForDiagnosticsNoPII('info', 'hook_spawn_started', {
        hook_event_name: hookEvent,
        index: hookIndex,
      })
    }
    await Promise.race([stdinWritePromise, childErrorPromise])

    // 在解析之前等待任何待处理的提示响应
    const result = await Promise.race([
      childIsAsyncPromise,
      childClosePromise,
      childErrorPromise,
    ])
    // 确保所有排队的提示响应都已发送
    await promptChain
    diagExitCode = result.status
    diagAborted = result.aborted ?? false
    return result
  } catch (error) {
    // 处理来自 stdin 写入或子进程的错误
    const code = getErrnoCode(error)
    diagExitCode = 1

    if (code === 'EPIPE') {
      logForDebugging(
        'EPIPE error while writing to hook stdin (hook command likely closed early)',
      )
      const errMsg =
        'Hook command closed stdin before hook input was fully written (EPIPE)'
      return {
        stdout: '',
        stderr: errMsg,
        output: errMsg,
        status: 1,
      }
    } else if (code === 'ABORT_ERR') {
      diagAborted = true
      return {
        stdout: '',
        stderr: 'Hook cancelled',
        output: 'Hook cancelled',
        status: 1,
        aborted: true,
      }
    } else {
      const errorMsg = errorMessage(error)
      const errOutput = `Error occurred while executing hook command: ${errorMsg}`
      return {
        stdout: '',
        stderr: errOutput,
        output: errOutput,
        status: 1,
      }
    }
  } finally {
    if (shouldEmitDiag) {
      logForDiagnosticsNoPII('info', 'hook_spawn_completed', {
        hook_event_name: hookEvent,
        index: hookIndex,
        duration_ms: Date.now() - diagStartMs,
        exit_code: diagExitCode,
        aborted: diagAborted,
      })
    }
    stopProgressInterval()
    // 清理流资源，除非所有权已转移（例如，转移到异步钩子注册表）
    if (!shellCommandTransferred) {
      shellCommand.cleanup()
    }
  }
}

/**
 * 检查匹配查询是否与钩子匹配器模式匹配
 * @param matchQuery 要匹配的查询（例如 'Write'、'Edit'、'Bash'）
 * @param matcher 匹配器模式 - 可以是：
 *   - 简单字符串用于精确匹配（例如 'Write'）
 *   - 管道分隔的列表用于多个精确匹配（例如 'Write|Edit'）
 *   - 正则表达式模式（例如 '^Write.*'、'.*'、'^(Write|Edit)$'）
 * @returns 如果查询与模式匹配则返回 true
 */
function matchesPattern(matchQuery: string, matcher: string): boolean {
  if (!matcher || matcher === '*') {
    return true
  }
  // 检查是否为简单字符串或管道分隔列表（除 | 外无正则特殊字符）
  if (/^[a-zA-Z0-9_|]+$/.test(matcher)) {
    // 处理管道分隔的精确匹配
    if (matcher.includes('|')) {
      /** 执行 patterns 对应的业务处理。 */
      const patterns = matcher
        .split('|')
        .map(p => p.trim())
      return patterns.includes(matchQuery)
    }
    // 简单的精确匹配
    return matchQuery === matcher
  }

  // 否则视为正则表达式
  try {
    const regex = new RegExp(matcher)
    return regex.test(matchQuery)
  } catch {
    // 如果正则表达式无效，记录错误并返回 false
    logForDebugging(`Invalid regex pattern in hook matcher: ${matcher}`)
    return false
  }
}

type IfConditionMatcher = (ifCondition: string) => boolean

/**
 * 准备用于钩子 `if` 条件的匹配器。代价高昂的工作（工具查找、Zod 验证、Bash 的 tree-sitter 解析）在此处只执行一次；返回的闭包在每个钩子调用时使用。对于非工具事件，返回 undefined。
 */
async function prepareIfConditionMatcher(
  hookInput: HookInput,
  tools: Tools | undefined,
): Promise<IfConditionMatcher | undefined> {
  if (
    hookInput.hook_event_name !== 'PreToolUse' &&
    hookInput.hook_event_name !== 'PostToolUse' &&
    hookInput.hook_event_name !== 'PostToolUseFailure' &&
    hookInput.hook_event_name !== 'PermissionRequest'
  ) {
    return undefined
  }

  const toolName = hookInput.tool_name
  const tool = tools && findToolByName(tools, hookInput.tool_name)
  const input = tool?.inputSchema.safeParse(hookInput.tool_input)
  const patternMatcher =
    input?.success && tool?.preparePermissionMatcher
      ? await tool.preparePermissionMatcher(input.data)
      : undefined

  return ifCondition => {
    const parsed = permissionRuleValueFromString(ifCondition)
    if (parsed.toolName !== toolName) {
      return false
    }
    if (!parsed.ruleContent) {
      return true
    }
    return patternMatcher ? patternMatcher(parsed.ruleContent) : false
  }
}

type FunctionHookMatcher = {
  matcher: string
  hooks: FunctionHook[]
}

/**
 * 与可选插件上下文配对的钩子。
 * 在返回匹配的钩子时使用，以便在运行时应用插件环境变量。
 */
type MatchedHook = {
  hook: HookCommand | HookCallback | FunctionHook
  pluginRoot?: string
  pluginId?: string
  skillRoot?: string
  hookSource?: string
}

/** 判断是否满足 is Internal Hook 对应的数据或状态。 */
function isInternalHook(matched: MatchedHook): boolean {
  return matched.hook.type === 'callback' && matched.hook.internal === true
}

/**
 * 为匹配的钩子构建去重键，按源上下文命名空间。
 *
 * 设置文件中的钩子（无 pluginRoot/skillRoot）共享 '' 前缀，因此用户/项目/本地中定义的相同命令仍然合并为一个——这是去重的原始意图。插件/技能钩子使用其根作为前缀，因此两个插件共享未展开的 `${CLAUDE_PLUGIN_ROOT}/hook.sh` 模板不会合并：展开后它们指向不同的文件。
 */
function hookDedupKey(m: MatchedHook, payload: string): string {
  return `${m.pluginRoot ?? m.skillRoot ?? ''}\0${payload}`
}

/** 获取 get Hooks Config 对应的数据或状态。 */
function getHooksConfig(
  appState: AppState | undefined,
  sessionId: string,
  hookEvent: HookEvent,
): Array<
  | HookMatcher
  | HookCallbackMatcher
  | FunctionHookMatcher
  | PluginHookMatcher
  | SkillHookMatcher
  | SessionDerivedHookMatcher
> {
  // HookMatcher 是经过 zod 剥离的 {matcher, hooks}，因此快照匹配器可以直接推送而无需重新包装。
  const hooks: Array<
    | HookMatcher
    | HookCallbackMatcher
    | FunctionHookMatcher
    | PluginHookMatcher
    | SkillHookMatcher
    | SessionDerivedHookMatcher
  > = [...(getHooksConfigFromSnapshot()?.[hookEvent] ?? [])]

  // 检查是否只应运行受管理的钩子（用于已注册钩子和会话钩子）
  const managedOnly = shouldAllowManagedHooksOnly()

  // 处理已注册的钩子（SDK 回调和插件原生钩子）
  const registeredHooks = getRegisteredHooks()?.[hookEvent]
  if (registeredHooks) {
    for (const matcher of registeredHooks) {
      // 当限制为仅受管理的钩子时跳过插件钩子
      // 插件钩子设置了 pluginRoot，SDK 回调没有
      if (managedOnly && 'pluginRoot' in matcher) {
        continue
      }
      hooks.push(matcher)
    }
  }

  // 合并当前会话的会话钩子
  // 函数钩子（如结构化输出强制）必须限定在其会话范围内
  // 以防止一个代理的钩子泄漏到另一个代理（例如，验证代理泄漏到主代理）
  // 当设置了 allowManagedHooksOnly 时完全跳过会话钩子——
  // 这可以防止来自代理/技能的前置钩子绕过策略。
  // 如果未提供 appState，也跳过（为了向后兼容）
  if (!managedOnly && appState !== undefined) {
    const sessionHooks = getSessionHooks(appState, sessionId, hookEvent).get(
      hookEvent,
    )
    if (sessionHooks) {
      // SessionDerivedHookMatcher 已包含可选的 skillRoot
      for (const matcher of sessionHooks) {
        hooks.push(matcher)
      }
    }

    // 单独合并会话函数钩子（无法持久化为 HookMatcher 格式）
    const sessionFunctionHooks = getSessionFunctionHooks(
      appState,
      sessionId,
      hookEvent,
    ).get(hookEvent)
    if (sessionFunctionHooks) {
      for (const matcher of sessionFunctionHooks) {
        hooks.push(matcher)
      }
    }
  }

  return hooks
}

/**
 * 对给定事件上的钩子进行轻量级存在性检查。镜像由 getHooksConfig() 汇编的源，但在遇到第一个命中时停止，不构建完整合并配置。
 *
 * 有意过度近似：如果事件存在任何匹配器则返回 true，即使仅托管过滤或模式匹配稍后可能会丢弃它。假阳性只是意味着我们继续完整匹配路径；假阴性会跳过钩子，所以我们偏向于 true。
 *
 * 用于在热路径上跳过 createBaseHookInput（getTranscriptPathForSession 路径连接）和 getMatchingHooks，通常情况下钩子未配置。类似模式见 hasInstructionsLoadedHook / hasWorktreeCreateHook。
 */
function hasHookForEvent(
  hookEvent: HookEvent,
  appState: AppState | undefined,
  sessionId: string,
): boolean {
  const snap = getHooksConfigFromSnapshot()?.[hookEvent]
  if (snap && snap.length > 0) return true
  const reg = getRegisteredHooks()?.[hookEvent]
  if (reg && reg.length > 0) return true
  if (appState?.sessionHooks.get(sessionId)?.hooks[hookEvent]) return true
  return false
}

/**
 * 获取匹配给定查询的钩子命令
 * @param appState 当前应用状态（可选，用于向后兼容）
 * @param sessionId 当前会话 ID（主会话或代理 ID）
 * @param hookEvent 钩子事件
 * @param hookInput 用于匹配的钩子输入
 * @returns 匹配的钩子数组，带有可选的插件上下文
 */
export async function getMatchingHooks(
  appState: AppState | undefined,
  sessionId: string,
  hookEvent: HookEvent,
  hookInput: HookInput,
  tools?: Tools,
): Promise<MatchedHook[]> {
  try {
    const hookMatchers = getHooksConfig(appState, sessionId, hookEvent)

    // 如果你更改下面的条件，则必须同时更改 src/utils/hooks/hooksConfigManager.ts。
    let matchQuery: string | undefined = undefined
    switch (hookInput.hook_event_name) {
      case 'PreToolUse':
      case 'PostToolUse':
      case 'PostToolUseFailure':
      case 'PermissionRequest':
      case 'PermissionDenied':
        matchQuery = hookInput.tool_name
        break
      case 'SessionStart':
        matchQuery = hookInput.source
        break
      case 'Setup':
        matchQuery = hookInput.trigger
        break
      case 'PreCompact':
      case 'PostCompact':
        matchQuery = hookInput.trigger
        break
      case 'Notification':
        matchQuery = hookInput.notification_type
        break
      case 'SessionEnd':
        matchQuery = hookInput.reason
        break
      case 'StopFailure':
        matchQuery = hookInput.error
        break
      case 'SubagentStart':
        matchQuery = hookInput.agent_type
        break
      case 'SubagentStop':
        matchQuery = hookInput.agent_type
        break
      case 'TeammateIdle':
      case 'TaskCreated':
      case 'TaskCompleted':
        break
      case 'Elicitation':
        matchQuery = hookInput.mcp_server_name
        break
      case 'ElicitationResult':
        matchQuery = hookInput.mcp_server_name
        break
      case 'ConfigChange':
        matchQuery = hookInput.source
        break
      case 'InstructionsLoaded':
        matchQuery = hookInput.load_reason
        break
      case 'FileChanged':
        matchQuery = basename(hookInput.file_path)
        break
      default:
        break
    }

    logForDebugging(
      `Getting matching hook commands for ${hookEvent} with query: ${matchQuery}`,
      { level: 'verbose' },
    )
    logForDebugging(`Found ${hookMatchers.length} hook matchers in settings`, {
      level: 'verbose',
    })

    // 提取钩子及其插件上下文（如果有）
    const filteredMatchers = matchQuery
      ? hookMatchers.filter(
          matcher =>
            !matcher.matcher || matchesPattern(matchQuery, matcher.matcher),
        )
      : hookMatchers

    /** 执行 matched Hooks 对应的业务处理。 */
    const matchedHooks: MatchedHook[] = filteredMatchers.flatMap(matcher => {
      // 检查这是 PluginHookMatcher（有 pluginRoot）还是 SkillHookMatcher（有 skillRoot）
      const pluginRoot =
        'pluginRoot' in matcher ? matcher.pluginRoot : undefined
      const pluginId = 'pluginId' in matcher ? matcher.pluginId : undefined
      const skillRoot = 'skillRoot' in matcher ? matcher.skillRoot : undefined
      const hookSource = pluginRoot
        ? 'pluginName' in matcher
          ? `plugin:${matcher.pluginName}`
          : 'plugin'
        : skillRoot
          ? 'skillName' in matcher
            ? `skill:${matcher.skillName}`
            : 'skill'
          : 'settings'
      return matcher.hooks.map(hook => ({
        hook,
        pluginRoot,
        pluginId,
        skillRoot,
        hookSource,
      }))
    })

    // 在相同的源上下文内按命令/提示/URL 去重钩子。键由 pluginRoot/skillRoot 命名空间（见上文的 hookDedupKey），因此跨插件模板冲突不会丢失钩子（gh-29724）。
    //
    // 注意：new Map(entries) 在键冲突时保留最后一个条目，而非第一个。对于设置钩子，这意味着最后合并的作用域获胜；对于同插件重复，pluginRoot 相同因此无关紧要。快速路径：回调/函数钩子不需要去重（每个都是唯一的）。当所有钩子都是回调/函数时，跳过下面的 6 遍过滤 + 4×Map + 4×Array.from——这是内部钩子（如 sessionFileAccessHooks）的常见情况。
    if (
      matchedHooks.every(
        m => m.hook.type === 'callback' || m.hook.type === 'function',
      )
    ) {
      return matchedHooks
    }

    // 辅助函数，用于从钩子中提取 `if` 条件以用于去重键。具有不同 `if` 条件的钩子是互不相同的，即使其他方面相同。
    const getIfCondition = (hook: { if?: string }): string => hook.if ?? ''

    const uniqueCommandHooks = Array.from(
      new Map(
        matchedHooks
          .filter(
            (
              m,
            ): m is MatchedHook & { hook: HookCommand & { type: 'command' } } =>
              m.hook.type === 'command',
          )
          // shell is part of identity: {command:'echo x', shell:'bash'}
          // and {command:'echo x', shell:'powershell'} are distinct hooks,
          // not duplicates. Default to 'bash' so legacy configs (no shell
          // field) still dedup against explicit shell:'bash'.
          .map(m => [
            hookDedupKey(
              m,
              `${m.hook.shell ?? DEFAULT_HOOK_SHELL}\0${m.hook.command}\0${getIfCondition(m.hook)}`,
            ),
            m,
          ]),
      ).values(),
    )
    const uniquePromptHooks = Array.from(
      new Map(
        matchedHooks
          .filter(m => m.hook.type === 'prompt')
          .map(m => [
            hookDedupKey(
              m,
              `${(m.hook as { prompt: string }).prompt}\0${getIfCondition(m.hook as { if?: string })}`,
            ),
            m,
          ]),
      ).values(),
    )
    const uniqueAgentHooks = Array.from(
      new Map(
        matchedHooks
          .filter(m => m.hook.type === 'agent')
          .map(m => [
            hookDedupKey(
              m,
              `${(m.hook as { prompt: string }).prompt}\0${getIfCondition(m.hook as { if?: string })}`,
            ),
            m,
          ]),
      ).values(),
    )
    const uniqueHttpHooks = Array.from(
      new Map(
        matchedHooks
          .filter(m => m.hook.type === 'http')
          .map(m => [
            hookDedupKey(
              m,
              `${(m.hook as { url: string }).url}\0${getIfCondition(m.hook as { if?: string })}`,
            ),
            m,
          ]),
      ).values(),
    )
    /** 执行 callback Hooks 对应的数据或状态。 */
    const callbackHooks = matchedHooks.filter(m => m.hook.type === 'callback')
    // 函数钩子不需要去重 - 每个回调都是唯一的
    const functionHooks = matchedHooks.filter(m => m.hook.type === 'function')
    const uniqueHooks = [
      ...uniqueCommandHooks,
      ...uniquePromptHooks,
      ...uniqueAgentHooks,
      ...uniqueHttpHooks,
      ...callbackHooks,
      ...functionHooks,
    ]

    // 根据它们的 `if` 条件过滤钩子。这允许钩子指定条件，如 "Bash(git *)"，只对 git 命令运行，避免非匹配命令的进程生成开销。
    const hasIfCondition = uniqueHooks.some(
      h =>
        (h.hook.type === 'command' ||
          h.hook.type === 'prompt' ||
          h.hook.type === 'agent' ||
          h.hook.type === 'http') &&
        (h.hook as { if?: string }).if,
    )
    const ifMatcher = hasIfCondition
      ? await prepareIfConditionMatcher(hookInput, tools)
      : undefined
    /** 执行 if Filtered Hooks 对应的业务处理。 */
    const ifFilteredHooks = uniqueHooks.filter(h => {
      if (
        h.hook.type !== 'command' &&
        h.hook.type !== 'prompt' &&
        h.hook.type !== 'agent' &&
        h.hook.type !== 'http'
      ) {
        return true
      }
      const ifCondition = (h.hook as { if?: string }).if
      if (!ifCondition) {
        return true
      }
      if (!ifMatcher) {
        logForDebugging(
          `Hook if condition "${ifCondition}" cannot be evaluated for non-tool event ${hookInput.hook_event_name}`,
        )
        return false
      }
      if (ifMatcher(ifCondition)) {
        return true
      }
      logForDebugging(
        `Skipping hook due to if condition "${ifCondition}" not matching`,
      )
      return false
    })

    // HTTP 钩子不支持 SessionStart/Setup 事件。在无头模式下，sandbox ask 回调会死锁，因为这些钩子触发时 structuredInput 消费者尚未启动。
    const filteredHooks =
      hookEvent === 'SessionStart' || hookEvent === 'Setup'
        ? ifFilteredHooks.filter(h => {
            if (h.hook.type === 'http') {
              logForDebugging(
                `Skipping HTTP hook ${(h.hook as { url: string }).url} — HTTP hooks are not supported for ${hookEvent}`,
              )
              return false
            }
            return true
          })
        : ifFilteredHooks

    logForDebugging(
      `Matched ${filteredHooks.length} unique hooks for query "${matchQuery || 'no match query'}" (${matchedHooks.length} before deduplication)`,
      { level: 'verbose' },
    )
    return filteredHooks
  } catch {
    return []
  }
}

/**
 * 格式化来自 PreTool 钩子的配置命令的阻塞错误列表。
 * @param hookName 钩子的名称（例如 'PreToolUse:Write'、'PreToolUse:Edit'、'PreToolUse:Bash'）
 * @param blockingErrors 来自钩子的阻塞错误数组
 * @returns 格式化的阻塞消息
 */
export function getPreToolHookBlockingMessage(
  hookName: string,
  blockingError: HookBlockingError,
): string {
  return `${hookName} hook error: ${blockingError.blockingError}`
}

/**
 * 格式化来自 Stop 钩子的配置命令的阻塞错误列表。
 * @param blockingErrors 来自钩子的阻塞错误数组
 * @returns 格式化的消息，用于向模型提供反馈
 */
export function getStopHookMessage(blockingError: HookBlockingError): string {
  return `Stop hook feedback:\n${blockingError.blockingError}`
}

/**
 * 格式化来自 TeammateIdle 钩子的阻塞错误。
 * @param blockingError 来自钩子的阻塞错误
 * @returns 格式化的消息，用于向模型提供反馈
 */
export function getTeammateIdleHookMessage(
  blockingError: HookBlockingError,
): string {
  return `TeammateIdle hook feedback:\n${blockingError.blockingError}`
}

/**
 * 格式化来自 TaskCreated 钩子的阻塞错误。
 * @param blockingError 来自钩子的阻塞错误
 * @returns 格式化的消息，用于向模型提供反馈
 */
export function getTaskCreatedHookMessage(
  blockingError: HookBlockingError,
): string {
  return `TaskCreated hook feedback:\n${blockingError.blockingError}`
}

/**
 * 格式化来自 TaskCompleted 钩子的阻塞错误。
 * @param blockingError 来自钩子的阻塞错误
 * @returns 格式化的消息，用于向模型提供反馈
 */
export function getTaskCompletedHookMessage(
  blockingError: HookBlockingError,
): string {
  return `TaskCompleted hook feedback:\n${blockingError.blockingError}`
}

/**
 * 格式化来自 UserPromptSubmit 钩子的配置命令的阻塞错误列表。
 * @param blockingErrors 来自钩子的阻塞错误数组
 * @returns 格式化的阻塞消息
 */
export function getUserPromptSubmitHookBlockingMessage(
  blockingError: HookBlockingError,
): string {
  return `UserPromptSubmit operation blocked by hook:\n${blockingError.blockingError}`
}
/**
 * 执行钩子的通用逻辑
 * @param hookInput 结构化的钩子输入，将被验证并转换为 JSON
 * @param toolUseID 用于跟踪此钩子执行的 ID
 * @param matchQuery 用于匹配钩子匹配器的查询
 * @param signal 可选的 AbortSignal，用于取消钩子执行
 * @param timeoutMs 可选的钩子执行超时时间（毫秒）
 * @param toolUseContext 可选的 ToolUseContext，用于基于提示的钩子（如果使用提示钩子则需要）
 * @param messages 可选的对话历史，用于提示/函数钩子
 * @returns 生成进度消息和钩子结果的异步生成器
 */
async function* executeHooks({
  hookInput,
  toolUseID,
  matchQuery,
  signal,
  timeoutMs = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  toolUseContext,
  messages,
  forceSyncExecution,
  requestPrompt,
  toolInputSummary,
}: {
  hookInput: HookInput
  toolUseID: string
  matchQuery?: string
  signal?: AbortSignal
  timeoutMs?: number
  toolUseContext?: ToolUseContext
  messages?: Message[]
  forceSyncExecution?: boolean
  /** 执行 request Prompt 对应的业务处理。 */
  requestPrompt?: (
    sourceName: string,
    toolInputSummary?: string | null,
  ) => (request: PromptRequest) => Promise<PromptResponse>
  toolInputSummary?: string | null
}): AsyncGenerator<AggregatedHookResult> {
  if (shouldDisableAllHooksIncludingManaged()) {
    return
  }

  if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
    return
  }

  const hookEvent = hookInput.hook_event_name
  const hookName = matchQuery ? `${hookEvent}:${matchQuery}` : hookEvent

  // 将提示回调绑定到该钩子的名称和工具输入摘要，以便 UI 可以显示上下文
  const boundRequestPrompt = requestPrompt?.(hookName, toolInputSummary)

  // 安全：所有钩子都需要在交互模式下工作区信任
  // 此集中检查可防止所有当前和未来钩子的 RCE 漏洞
  if (shouldSkipHookDueToTrust()) {
    logForDebugging(
      `Skipping ${hookName} hook execution - workspace trust not accepted`,
    )
    return
  }

  const appState = toolUseContext ? toolUseContext.getAppState() : undefined
  // 使用代理的会话 ID（如果可用），否则回退到主会话
  const sessionId = toolUseContext?.agentId ?? getSessionId()
  const matchingHooks = await getMatchingHooks(
    appState,
    sessionId,
    hookEvent,
    hookInput,
    toolUseContext?.options?.tools,
  )
  if (matchingHooks.length === 0) {
    return
  }

  if (signal?.aborted) {
    return
  }

  if (matchingHooks.every(isInternalHook)) {
    // 快速路径：所有钩子都是内部回调。它们返回 {} 并且不使用中止信号，因此我们可以跳过 span/progress/abortSignal/processHookJSONOutput/resultLoop。测量：每次 PostToolUse 命中从 6.01µs 降至约 1.8µs（-70%）。
    const batchStartTime = Date.now()
    const context = toolUseContext
      ? {
          getAppState: toolUseContext.getAppState,
        }
      : undefined
    for (const [i, { hook }] of matchingHooks.entries()) {
      if (hook.type === 'callback') {
        await hook.callback(hookInput, toolUseID, signal, i, context)
      }
    }
    const totalDurationMs = Date.now() - batchStartTime
    getStatsStore()?.observe('hook_duration_ms', totalDurationMs)
    return
  }

  // 在执行前为每个钩子生成进度消息
  for (const { hook } of matchingHooks) {
    yield {
      message: {
        type: 'progress',
        data: {
          type: 'hook_progress',
          hookEvent,
          hookName,
          command: getHookDisplayText(hook),
          ...(hook.type === 'prompt' && { promptText: hook.prompt }),
          ...('statusMessage' in hook &&
            hook.statusMessage != null && {
              statusMessage: hook.statusMessage,
            }),
        },
        parentToolUseID: toolUseID,
        toolUseID,
        timestamp: new Date().toISOString(),
        uuid: randomUUID(),
      },
    }
  }

  // 跟踪整个钩子批次的挂钟时间
  const batchStartTime = Date.now()

  // hookInput 的惰性一次性字符串化。在此批次中的所有命令/提示/代理/HTTP 钩子之间共享（hookInput 从未改变）。回调/函数钩子在到达此步骤前返回，因此仅包含这些钩子的批次无需支付字符串化成本。
  let jsonInputResult:
    | { ok: true; value: string }
    | { ok: false; error: unknown }
    | undefined
  /** 获取 get Json Input 对应的数据或状态。 */
  function getJsonInput() {
    if (jsonInputResult !== undefined) {
      return jsonInputResult
    }
    try {
      return (jsonInputResult = { ok: true, value: jsonStringify(hookInput) })
    } catch (error) {
      logError(
        Error(`Failed to stringify hook ${hookName} input`, { cause: error }),
      )
      return (jsonInputResult = { ok: false, error })
    }
  }

  // 并行运行所有钩子，每个钩子有单独的超时
  const hookPromises = matchingHooks.map(async function* (
    { hook, pluginRoot, pluginId, skillRoot },
    hookIndex,
  ): AsyncGenerator<HookResult> {
    if (hook.type === 'callback') {
      const callbackTimeoutMs = hook.timeout ? hook.timeout * 1000 : timeoutMs
      const { signal: abortSignal, cleanup } = createCombinedAbortSignal(
        signal,
        { timeoutMs: callbackTimeoutMs },
      )
      yield executeHookCallback({
        toolUseID,
        hook,
        hookEvent,
        hookInput,
        signal: abortSignal,
        hookIndex,
        toolUseContext,
      }).finally(cleanup)
      return
    }

    if (hook.type === 'function') {
      if (!messages) {
        yield {
          message: createAttachmentMessage({
            type: 'hook_error_during_execution',
            hookName,
            toolUseID,
            hookEvent,
            content: 'Messages not provided for function hook',
          }),
          outcome: 'non_blocking_error',
          hook,
        }
        return
      }

      // 函数钩子仅来自会话存储，且内嵌回调
      yield executeFunctionHook({
        hook,
        messages,
        hookName,
        toolUseID,
        hookEvent,
        timeoutMs,
        signal,
      })
      return
    }

    // 命令钩子和提示钩子需要 jsonInput
    const commandTimeoutMs = hook.timeout ? hook.timeout * 1000 : timeoutMs
    const { signal: abortSignal, cleanup } = createCombinedAbortSignal(signal, {
      timeoutMs: commandTimeoutMs,
    })
    const hookId = randomUUID()
    const hookStartMs = Date.now()
    const hookCommand = getHookDisplayText(hook)

    try {
      const jsonInputRes = getJsonInput()
      if (!jsonInputRes.ok) {
        yield {
          message: createAttachmentMessage({
            type: 'hook_error_during_execution',
            hookName,
            toolUseID,
            hookEvent,
            content: `Failed to prepare hook input: ${errorMessage(jsonInputRes.error)}`,
            command: hookCommand,
            durationMs: Date.now() - hookStartMs,
          }),
          outcome: 'non_blocking_error',
          hook,
        }
        cleanup()
        return
      }
      const jsonInput = jsonInputRes.value

      if (hook.type === 'prompt') {
        if (!toolUseContext) {
          throw new Error(
            'ToolUseContext is required for prompt hooks. This is a bug.',
          )
        }
        const promptResult = await execPromptHook(
          hook,
          hookName,
          hookEvent,
          jsonInput,
          abortSignal,
          toolUseContext,
          messages,
          toolUseID,
        )
        // 注入计时字段以实现钩子可见性
        if (promptResult.message?.type === 'attachment') {
          const att = promptResult.message.attachment
          if (
            att.type === 'hook_success' ||
            att.type === 'hook_non_blocking_error'
          ) {
            att.command = hookCommand
            att.durationMs = Date.now() - hookStartMs
          }
        }
        yield promptResult
        cleanup?.()
        return
      }

      if (hook.type === 'agent') {
        if (!toolUseContext) {
          throw new Error(
            'ToolUseContext is required for agent hooks. This is a bug.',
          )
        }
        if (!messages) {
          throw new Error(
            'Messages are required for agent hooks. This is a bug.',
          )
        }
        const agentResult = await execAgentHook(
          hook,
          hookName,
          hookEvent,
          jsonInput,
          abortSignal,
          toolUseContext,
          toolUseID,
          messages,
          'agent_type' in hookInput
            ? (hookInput.agent_type as string)
            : undefined,
        )
        // 注入计时字段以实现钩子可见性
        if (agentResult.message?.type === 'attachment') {
          const att = agentResult.message.attachment
          if (
            att.type === 'hook_success' ||
            att.type === 'hook_non_blocking_error'
          ) {
            att.command = hookCommand
            att.durationMs = Date.now() - hookStartMs
          }
        }
        yield agentResult
        cleanup?.()
        return
      }

      if (hook.type === 'http') {
        emitHookStarted(hookId, hookName, hookEvent)

        // execHttpHook 通过 hook.timeout 或 DEFAULT_HTTP_HOOK_TIMEOUT_MS 在内部管理自己的超时，因此直接传递父信号以避免与 abortSignal 双重堆叠超时。
        const httpResult = await execHttpHook(
          hook,
          hookEvent,
          jsonInput,
          signal,
        )
        cleanup?.()

        if (httpResult.aborted) {
          emitHookResponse({
            hookId,
            hookName,
            hookEvent,
            output: 'Hook cancelled',
            stdout: '',
            stderr: '',
            exitCode: undefined,
            outcome: 'cancelled',
          })
          yield {
            message: createAttachmentMessage({
              type: 'hook_cancelled',
              hookName,
              toolUseID,
              hookEvent,
            }),
            outcome: 'cancelled' as const,
            hook,
          }
          return
        }

        if (httpResult.error || !httpResult.ok) {
          const stderr =
            httpResult.error || `HTTP ${httpResult.statusCode} from ${hook.url}`
          emitHookResponse({
            hookId,
            hookName,
            hookEvent,
            output: stderr,
            stdout: '',
            stderr,
            exitCode: httpResult.statusCode,
            outcome: 'error',
          })
          yield {
            message: createAttachmentMessage({
              type: 'hook_non_blocking_error',
              hookName,
              toolUseID,
              hookEvent,
              stderr,
              stdout: '',
              exitCode: httpResult.statusCode ?? 0,
            }),
            outcome: 'non_blocking_error' as const,
            hook,
          }
          return
        }

        // HTTP 钩子必须返回 JSON — 通过 Zod 进行解析和验证
        const { json: httpJson, validationError: httpValidationError } =
          parseHttpHookOutput(httpResult.body)

        if (httpValidationError) {
          emitHookResponse({
            hookId,
            hookName,
            hookEvent,
            output: httpResult.body,
            stdout: httpResult.body,
            stderr: `JSON validation failed: ${httpValidationError}`,
            exitCode: httpResult.statusCode,
            outcome: 'error',
          })
          yield {
            message: createAttachmentMessage({
              type: 'hook_non_blocking_error',
              hookName,
              toolUseID,
              hookEvent,
              stderr: `JSON validation failed: ${httpValidationError}`,
              stdout: httpResult.body,
              exitCode: httpResult.statusCode ?? 0,
            }),
            outcome: 'non_blocking_error' as const,
            hook,
          }
          return
        }

        if (httpJson && isAsyncHookJSONOutput(httpJson)) {
          // 异步响应：视为成功（不进一步处理）
          emitHookResponse({
            hookId,
            hookName,
            hookEvent,
            output: httpResult.body,
            stdout: httpResult.body,
            stderr: '',
            exitCode: httpResult.statusCode,
            outcome: 'success',
          })
          yield {
            outcome: 'success' as const,
            hook,
          }
          return
        }

        if (httpJson) {
          const processed = processHookJSONOutput({
            json: httpJson,
            command: hook.url,
            hookName,
            toolUseID,
            hookEvent,
            expectedHookEvent: hookEvent,
            stdout: httpResult.body,
            stderr: '',
            exitCode: httpResult.statusCode,
          })
          emitHookResponse({
            hookId,
            hookName,
            hookEvent,
            output: httpResult.body,
            stdout: httpResult.body,
            stderr: '',
            exitCode: httpResult.statusCode,
            outcome: 'success',
          })
          yield {
            ...processed,
            outcome: 'success' as const,
            hook,
          }
          return
        }

        return
      }

      emitHookStarted(hookId, hookName, hookEvent)

      const result = await execCommandHook(
        hook,
        hookEvent,
        hookName,
        jsonInput,
        abortSignal,
        hookId,
        hookIndex,
        pluginRoot,
        pluginId,
        skillRoot,
        forceSyncExecution,
        boundRequestPrompt,
      )
      cleanup?.()
      const durationMs = Date.now() - hookStartMs

      if (result.backgrounded) {
        yield {
          outcome: 'success' as const,
          hook,
        }
        return
      }

      if (result.aborted) {
        emitHookResponse({
          hookId,
          hookName,
          hookEvent,
          output: result.output,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.status,
          outcome: 'cancelled',
        })
        yield {
          message: createAttachmentMessage({
            type: 'hook_cancelled',
            hookName,
            toolUseID,
            hookEvent,
            command: hookCommand,
            durationMs,
          }),
          outcome: 'cancelled' as const,
          hook,
        }
        return
      }

      // 先尝试 JSON 解析
      const { json, plainText, validationError } = parseHookOutput(
        result.stdout,
      )

      if (validationError) {
        emitHookResponse({
          hookId,
          hookName,
          hookEvent,
          output: result.output,
          stdout: result.stdout,
          stderr: `JSON validation failed: ${validationError}`,
          exitCode: 1,
          outcome: 'error',
        })
        yield {
          message: createAttachmentMessage({
            type: 'hook_non_blocking_error',
            hookName,
            toolUseID,
            hookEvent,
            stderr: `JSON validation failed: ${validationError}`,
            stdout: result.stdout,
            exitCode: 1,
            command: hookCommand,
            durationMs,
          }),
          outcome: 'non_blocking_error' as const,
          hook,
        }
        return
      }

      if (json) {
        // 异步响应已在执行期间后台运行
        if (isAsyncHookJSONOutput(json)) {
          yield {
            outcome: 'success' as const,
            hook,
          }
          return
        }

        // 处理 JSON 输出
        const processed = processHookJSONOutput({
          json,
          command: hookCommand,
          hookName,
          toolUseID,
          hookEvent,
          expectedHookEvent: hookEvent,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.status,
          durationMs,
        })

        // 处理 suppressOutput（跳过异步响应）
        if (
          isSyncHookJSONOutput(json) &&
          !json.suppressOutput &&
          plainText &&
          result.status === 0
        ) {
          // 如果未被抑制，仍显示非 JSON 输出
          const content = `${chalk.bold(hookName)} completed`
          emitHookResponse({
            hookId,
            hookName,
            hookEvent,
            output: result.output,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.status,
            outcome: 'success',
          })
          yield {
            ...processed,
            message:
              processed.message ||
              createAttachmentMessage({
                type: 'hook_success',
                hookName,
                toolUseID,
                hookEvent,
                content,
                stdout: result.stdout,
                stderr: result.stderr,
                exitCode: result.status,
                command: hookCommand,
                durationMs,
              }),
            outcome: 'success' as const,
            hook,
          }
          return
        }

        emitHookResponse({
          hookId,
          hookName,
          hookEvent,
          output: result.output,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.status,
          outcome: result.status === 0 ? 'success' : 'error',
        })
        yield {
          ...processed,
          outcome: 'success' as const,
          hook,
        }
        return
      }

      // 对非 JSON 输出回退到现有逻辑
      if (result.status === 0) {
        emitHookResponse({
          hookId,
          hookName,
          hookEvent,
          output: result.output,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.status,
          outcome: 'success',
        })
        yield {
          message: createAttachmentMessage({
            type: 'hook_success',
            hookName,
            toolUseID,
            hookEvent,
            content: result.stdout.trim(),
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.status,
            command: hookCommand,
            durationMs,
          }),
          outcome: 'success' as const,
          hook,
        }
        return
      }

      // 退出码为 2 的钩子提供阻塞反馈
      if (result.status === 2) {
        emitHookResponse({
          hookId,
          hookName,
          hookEvent,
          output: result.output,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.status,
          outcome: 'error',
        })
        yield {
          blockingError: {
            blockingError: `[${hook.command}]: ${result.stderr || 'No stderr output'}`,
            command: hook.command,
          },
          outcome: 'blocking' as const,
          hook,
        }
        return
      }

      // 任何其他非零退出码都是非严重错误，应仅向用户展示。
      emitHookResponse({
        hookId,
        hookName,
        hookEvent,
        output: result.output,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.status,
        outcome: 'error',
      })
      yield {
        message: createAttachmentMessage({
          type: 'hook_non_blocking_error',
          hookName,
          toolUseID,
          hookEvent,
          stderr: `Failed with non-blocking status code: ${result.stderr.trim() || 'No stderr output'}`,
          stdout: result.stdout,
          exitCode: result.status,
          command: hookCommand,
          durationMs,
        }),
        outcome: 'non_blocking_error' as const,
        hook,
      }
      return
    } catch (error) {
      // 在错误时进行清理
      cleanup?.()

      const errorMessage =
        error instanceof Error ? error.message : String(error)
      emitHookResponse({
        hookId,
        hookName,
        hookEvent,
        output: `Failed to run: ${errorMessage}`,
        stdout: '',
        stderr: `Failed to run: ${errorMessage}`,
        exitCode: 1,
        outcome: 'error',
      })
      yield {
        message: createAttachmentMessage({
          type: 'hook_non_blocking_error',
          hookName,
          toolUseID,
          hookEvent,
          stderr: `Failed to run: ${errorMessage}`,
          stdout: '',
          exitCode: 1,
          command: hookCommand,
          durationMs: Date.now() - hookStartMs,
        }),
        outcome: 'non_blocking_error' as const,
        hook,
      }
      return
    }
  })

  let permissionBehavior: PermissionResult['behavior'] | undefined

  // 并行运行所有钩子并等待全部完成
  for await (const result of all(hookPromises)) {
    // 尽早检查 preventContinuation
    if (result.preventContinuation) {
      logForDebugging(
        `Hook ${hookEvent} (${getHookDisplayText(result.hook)}) requested preventContinuation`,
      )
      yield {
        preventContinuation: true,
        stopReason: result.stopReason,
      }
    }

    // 处理不同的结果类型
    if (result.blockingError) {
      yield {
        blockingError: result.blockingError,
      }
    }

    if (result.message) {
      yield { message: result.message }
    }

    // 如果存在，单独生成系统消息
    if (result.systemMessage) {
      yield {
        message: createAttachmentMessage({
          type: 'hook_system_message',
          content: result.systemMessage,
          hookName,
          toolUseID,
          hookEvent,
        }),
      }
    }

    // 从钩子收集附加上下文
    if (result.additionalContext) {
      logForDebugging(
        `Hook ${hookEvent} (${getHookDisplayText(result.hook)}) provided additionalContext (${result.additionalContext.length} chars)`,
      )
      yield {
        additionalContexts: [result.additionalContext],
      }
    }

    if (result.sessionTitle) {
      logForDebugging(
        `Hook ${hookEvent} (${getHookDisplayText(result.hook)}) provided sessionTitle`,
      )
      yield { sessionTitle: result.sessionTitle }
    }

    if (result.initialUserMessage) {
      logForDebugging(
        `Hook ${hookEvent} (${getHookDisplayText(result.hook)}) provided initialUserMessage (${result.initialUserMessage.length} chars)`,
      )
      yield {
        initialUserMessage: result.initialUserMessage,
      }
    }

    if (result.watchPaths && result.watchPaths.length > 0) {
      logForDebugging(
        `Hook ${hookEvent} (${getHookDisplayText(result.hook)}) provided ${result.watchPaths.length} watchPaths`,
      )
      yield {
        watchPaths: result.watchPaths,
      }
    }

    // 如果提供，生成 updatedMCPToolOutput（来自 PostToolUse 钩子）
    if (result.updatedMCPToolOutput) {
      logForDebugging(
        `Hook ${hookEvent} (${getHookDisplayText(result.hook)}) replaced MCP tool output`,
      )
      yield {
        updatedMCPToolOutput: result.updatedMCPToolOutput,
      }
    }

    // 按优先级检查权限行为：deny > ask > allow
    if (result.permissionBehavior) {
      logForDebugging(
        `Hook ${hookEvent} (${getHookDisplayText(result.hook)}) returned permissionDecision: ${result.permissionBehavior}${result.hookPermissionDecisionReason ? ` (reason: ${result.hookPermissionDecisionReason})` : ''}`,
      )
      // 应用优先级规则
      switch (result.permissionBehavior) {
        case 'deny':
          // deny 始终优先
          permissionBehavior = 'deny'
          break
        case 'ask':
          // ask 优先于 allow 但不优先于 deny
          if (permissionBehavior !== 'deny') {
            permissionBehavior = 'ask'
          }
          break
        case 'allow':
          // 仅当未设置其他行为时允许
          if (!permissionBehavior) {
            permissionBehavior = 'allow'
          }
          break
        case 'passthrough':
          // passthrough 不设置权限行为
          break
      }
    }

    // 返回权限行为和 updatedInput（如果提供了，来自 allow 或 ask 行为）
    if (permissionBehavior !== undefined) {
      const updatedInput =
        result.updatedInput &&
        (result.permissionBehavior === 'allow' ||
          result.permissionBehavior === 'ask')
          ? result.updatedInput
          : undefined
      if (updatedInput) {
        logForDebugging(
          `Hook ${hookEvent} (${getHookDisplayText(result.hook)}) modified tool input keys: [${Object.keys(updatedInput).join(', ')}]`,
        )
      }
      yield {
        permissionBehavior,
        hookPermissionDecisionReason: result.hookPermissionDecisionReason,
        hookSource: matchingHooks.find(m => m.hook === result.hook)?.hookSource,
        updatedInput,
      }
    }

    // 对于 passthrough 情况单独返回 updatedInput（无权限决策）
    // 这允许 hooks 修改输入而不做权限决策
    // 注意：检查 result.permissionBehavior（此 hook 的行为），而非聚合的 permissionBehavior
    if (result.updatedInput && result.permissionBehavior === undefined) {
      logForDebugging(
        `Hook ${hookEvent} (${getHookDisplayText(result.hook)}) modified tool input keys: [${Object.keys(result.updatedInput).join(', ')}]`,
      )
      yield {
        updatedInput: result.updatedInput,
      }
    }
    // 返回权限请求结果（如果提供了，来自 PermissionRequest hooks）
    if (result.permissionRequestResult) {
      yield {
        permissionRequestResult: result.permissionRequestResult,
      }
    }
    // 返回重试标志（如果提供了，来自 PermissionDenied hooks）
    if (result.retry) {
      yield {
        retry: result.retry,
      }
    }
    // 返回启发式响应（如果提供了，来自 Elicitation hooks）
    if (result.elicitationResponse) {
      yield {
        elicitationResponse: result.elicitationResponse,
      }
    }
    // 返回启发式结果响应（如果提供了，来自 ElicitationResult hooks）
    if (result.elicitationResultResponse) {
      yield {
        elicitationResultResponse: result.elicitationResultResponse,
      }
    }

    // 如果这是命令/提示/函数 hook（非回调 hook），调用 session hook 回调
    if (appState && result.hook.type !== 'callback') {
      const sessionId = getSessionId()
      // 当 matchQuery 未定义时（例如 Stop hooks），使用空字符串作为匹配器
      const matcher = matchQuery ?? ''
      const hookEntry = getSessionHookCallback(
        appState,
        sessionId,
        hookEvent,
        matcher,
        result.hook,
      )
      // 仅在成功结果上调用 onHookSuccess
      if (hookEntry?.onHookSuccess && result.outcome === 'success') {
        try {
          hookEntry.onHookSuccess(result.hook, result as AggregatedHookResult)
        } catch (error) {
          logError(
            Error('Session hook success callback failed', { cause: error }),
          )
        }
      }
    }
  }

  const totalDurationMs = Date.now() - batchStartTime
  getStatsStore()?.observe('hook_duration_ms', totalDurationMs)


}

export type HookOutsideReplResult = {
  command: string
  succeeded: boolean
  output: string
  blocked: boolean
  watchPaths?: string[]
  systemMessage?: string
}

/** 判断是否满足 has Blocking Result 对应的数据或状态。 */
export function hasBlockingResult(results: HookOutsideReplResult[]): boolean {
  return results.some(r => r.blocked)
}

/**
 * 执行 REPL 外部的 hooks（例如通知、会话结束）
 *
 * 与 executeHooks() 不同，后者会将消息作为系统消息暴露给模型，
 * 此函数仅通过 logForDebugging 记录错误（使用 --debug 可见）。
 * 需要向用户展示错误信息的调用者应适当处理返回的结果
 * （例如 executeSessionEndHooks 在关闭时写入 stderr）。
 *
 * @param getAppState 获取当前应用状态的可选函数（用于会话 hooks）
 * @param hookInput 结构化的 hook 输入，将被验证并转换为 JSON
 * @param matchQuery 用于匹配 hook 匹配器的查询
 * @param signal 可选的 AbortSignal 用于取消 hook 执行
 * @param timeoutMs 可选的 hook 执行超时时间（毫秒）
 * @returns HookOutsideReplResult 对象数组，包含 command、succeeded 和 output
 */
async function executeHooksOutsideREPL({
  getAppState,
  hookInput,
  matchQuery,
  signal,
  timeoutMs = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
}: {
  /** 获取 get App State 对应的数据或状态。 */
  getAppState?: () => AppState
  hookInput: HookInput
  matchQuery?: string
  signal?: AbortSignal
  timeoutMs: number
}): Promise<HookOutsideReplResult[]> {
  if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
    return []
  }

  const hookEvent = hookInput.hook_event_name
  const hookName = matchQuery ? `${hookEvent}:${matchQuery}` : hookEvent
  if (shouldDisableAllHooksIncludingManaged()) {
    logForDebugging(
      `Skipping hooks for ${hookName} due to 'disableAllHooks' managed setting`,
    )
    return []
  }

  // 安全：所有 hooks 在交互模式下要求工作区信任
  // 此集中检查可防止当前及未来所有 hook 的 RCE 漏洞
  if (shouldSkipHookDueToTrust()) {
    logForDebugging(
      `Skipping ${hookName} hook execution - workspace trust not accepted`,
    )
    return []
  }

  const appState = getAppState ? getAppState() : undefined
  // 对外部 REPL hooks 使用主会话 ID
  const sessionId = getSessionId()
  const matchingHooks = await getMatchingHooks(
    appState,
    sessionId,
    hookEvent,
    hookInput,
  )
  if (matchingHooks.length === 0) {
    return []
  }

  if (signal?.aborted) {
    return []
  }

  // 验证并字符串化 hook 输入
  let jsonInput: string
  try {
    jsonInput = jsonStringify(hookInput)
  } catch (error) {
    logError(error)
    return []
  }

  // 并行运行所有 hooks，每个有单独的超时
  const hookPromises = matchingHooks.map(
    async ({ hook, pluginRoot, pluginId }, hookIndex) => {
      // 处理回调 hooks
      if (hook.type === 'callback') {
        const callbackTimeoutMs = hook.timeout ? hook.timeout * 1000 : timeoutMs
        const { signal: abortSignal, cleanup } = createCombinedAbortSignal(
          signal,
          { timeoutMs: callbackTimeoutMs },
        )

        try {
          const toolUseID = randomUUID()
          const json = await hook.callback(
            hookInput,
            toolUseID,
            abortSignal,
            hookIndex,
          )

          cleanup?.()

          if (isAsyncHookJSONOutput(json)) {
            logForDebugging(
              `${hookName} [callback] returned async response, returning empty output`,
            )
            return {
              command: 'callback',
              succeeded: true,
              output: '',
              blocked: false,
            }
          }

          const output =
            hookEvent === 'WorktreeCreate' &&
            isSyncHookJSONOutput(json) &&
            json.hookSpecificOutput?.hookEventName === 'WorktreeCreate'
              ? json.hookSpecificOutput.worktreePath
              : json.systemMessage || ''
          const blocked =
            isSyncHookJSONOutput(json) && json.decision === 'block'

          logForDebugging(`${hookName} [callback] completed successfully`)

          return {
            command: 'callback',
            succeeded: true,
            output,
            blocked,
          }
        } catch (error) {
          cleanup?.()

          const errorMessage =
            error instanceof Error ? error.message : String(error)
          logForDebugging(
            `${hookName} [callback] failed to run: ${errorMessage}`,
            { level: 'error' },
          )
          return {
            command: 'callback',
            succeeded: false,
            output: errorMessage,
            blocked: false,
          }
        }
      }

      // TODO: 实现 REPL 外部的提示停止 hooks
      if (hook.type === 'prompt') {
        return {
          command: hook.prompt,
          succeeded: false,
          output: 'Prompt stop hooks are not yet supported outside REPL',
          blocked: false,
        }
      }

      // TODO: 实现 REPL 外部的代理停止 hooks
      if (hook.type === 'agent') {
        return {
          command: hook.prompt,
          succeeded: false,
          output: 'Agent stop hooks are not yet supported outside REPL',
          blocked: false,
        }
      }

      // 函数 hooks 需要 messages 数组（仅适用于 REPL 上下文）
      // 对于 -p 模式的 Stop hooks，使用支持函数 hooks 的 executeStopHooks
      if (hook.type === 'function') {
        logError(
          new Error(
            `Function hook reached executeHooksOutsideREPL for ${hookEvent}. Function hooks should only be used in REPL context (Stop hooks).`,
          ),
        )
        return {
          command: 'function',
          succeeded: false,
          output: 'Internal error: function hook executed outside REPL context',
          blocked: false,
        }
      }

      // 处理 HTTP hooks（无需 toolUseContext——仅 HTTP POST）。
      // execHttpHook 通过 hook.timeout 或 DEFAULT_HTTP_HOOK_TIMEOUT_MS 内部处理其超时，因此我们直接传递 signal。
      if (hook.type === 'http') {
        try {
          const httpResult = await execHttpHook(
            hook,
            hookEvent,
            jsonInput,
            signal,
          )

          if (httpResult.aborted) {
            logForDebugging(`${hookName} [${hook.url}] cancelled`)
            return {
              command: hook.url,
              succeeded: false,
              output: 'Hook cancelled',
              blocked: false,
            }
          }

          if (httpResult.error || !httpResult.ok) {
            const errMsg =
              httpResult.error ||
              `HTTP ${httpResult.statusCode} from ${hook.url}`
            logForDebugging(`${hookName} [${hook.url}] failed: ${errMsg}`, {
              level: 'error',
            })
            return {
              command: hook.url,
              succeeded: false,
              output: errMsg,
              blocked: false,
            }
          }

          // HTTP hooks 必须返回 JSON — 通过 Zod 解析和验证
          const { json: httpJson, validationError: httpValidationError } =
            parseHttpHookOutput(httpResult.body)
          if (httpValidationError) {
            throw new Error(httpValidationError)
          }
          if (httpJson && !isAsyncHookJSONOutput(httpJson)) {
            logForDebugging(
              `Parsed JSON output from HTTP hook: ${jsonStringify(httpJson)}`,
              { level: 'verbose' },
            )
          }
          const jsonBlocked =
            httpJson &&
            !isAsyncHookJSONOutput(httpJson) &&
            isSyncHookJSONOutput(httpJson) &&
            httpJson.decision === 'block'

          // WorktreeCreate 的消费者将 `output` 视为纯文件系统路径。命令钩子通过 stdout 提供它；HTTP 钩子通过 hookSpecificOutput.worktreePath 提供它。没有 worktreePath 时，输出 '' 以便消费者的长度过滤器跳过它，而不是将原始的 '{}' 主体视为路径。
          const output =
            hookEvent === 'WorktreeCreate'
              ? httpJson &&
                isSyncHookJSONOutput(httpJson) &&
                httpJson.hookSpecificOutput?.hookEventName === 'WorktreeCreate'
                ? httpJson.hookSpecificOutput.worktreePath
                : ''
              : httpResult.body

          return {
            command: hook.url,
            succeeded: true,
            output,
            blocked: !!jsonBlocked,
          }
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error)
          logForDebugging(
            `${hookName} [${hook.url}] failed to run: ${errorMessage}`,
            { level: 'error' },
          )
          return {
            command: hook.url,
            succeeded: false,
            output: errorMessage,
            blocked: false,
          }
        }
      }

      // 处理命令钩子
      const commandTimeoutMs = hook.timeout ? hook.timeout * 1000 : timeoutMs
      const { signal: abortSignal, cleanup } = createCombinedAbortSignal(
        signal,
        { timeoutMs: commandTimeoutMs },
      )
      try {
        const result = await execCommandHook(
          hook,
          hookEvent,
          hookName,
          jsonInput,
          abortSignal,
          randomUUID(),
          hookIndex,
          pluginRoot,
          pluginId,
        )

        // 钩子完成时清除超时
        cleanup?.()

        if (result.aborted) {
          logForDebugging(`${hookName} [${hook.command}] cancelled`)
          return {
            command: hook.command,
            succeeded: false,
            output: 'Hook cancelled',
            blocked: false,
          }
        }

        logForDebugging(
          `${hookName} [${hook.command}] completed with status ${result.status}`,
        )

        // 解析 JSON 以获取要打印的任何消息。
        const { json, validationError } = parseHookOutput(result.stdout)
        if (validationError) {
          // 验证错误通过 logForDebugging 记录并在输出中返回
          throw new Error(validationError)
        }
        if (json && !isAsyncHookJSONOutput(json)) {
          logForDebugging(
            `Parsed JSON output from hook: ${jsonStringify(json)}`,
            { level: 'verbose' },
          )
        }

        // 如果退出码为 2 或 JSON 决策为 'block'，则阻塞
        const jsonBlocked =
          json &&
          !isAsyncHookJSONOutput(json) &&
          isSyncHookJSONOutput(json) &&
          json.decision === 'block'
        const blocked = result.status === 2 || !!jsonBlocked

        // 对于成功的钩子（退出码 0），使用 stdout；对于失败的钩子，使用 stderr
        const output =
          result.status === 0 ? result.stdout || '' : result.stderr || ''

        const watchPaths =
          json &&
          isSyncHookJSONOutput(json) &&
          json.hookSpecificOutput &&
          'watchPaths' in json.hookSpecificOutput
            ? json.hookSpecificOutput.watchPaths
            : undefined

        const systemMessage =
          json && isSyncHookJSONOutput(json) ? json.systemMessage : undefined

        return {
          command: hook.command,
          succeeded: result.status === 0,
          output,
          blocked,
          watchPaths,
          systemMessage,
        }
      } catch (error) {
        // 出错时进行清理
        cleanup?.()

        const errorMessage =
          error instanceof Error ? error.message : String(error)
        logForDebugging(
          `${hookName} [${hook.command}] failed to run: ${errorMessage}`,
          { level: 'error' },
        )
        return {
          command: hook.command,
          succeeded: false,
          output: errorMessage,
          blocked: false,
        }
      }
    },
  )

  // 等待所有钩子完成并收集结果
  return await Promise.all(hookPromises)
}

/**
 * 如果配置了，执行预工具钩子
 * @param toolName 工具名称（例如 'Write', 'Edit', 'Bash'）
 * @param toolUseID 工具使用的 ID
 * @param toolInput 将传递给工具的输入
 * @param permissionMode 来自 toolPermissionContext 的可选权限模式
 * @param signal 可选的 AbortSignal 用于取消钩子执行
 * @param timeoutMs 钩子执行的可选超时时间（毫秒）
 * @param toolUseContext 用于基于提示的钩子的可选 ToolUseContext
 * @returns 生成进度消息并返回阻塞错误的异步生成器
 */
export async function* executePreToolHooks<ToolInput>(
  toolName: string,
  toolUseID: string,
  toolInput: ToolInput,
  toolUseContext: ToolUseContext,
  permissionMode?: string,
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  requestPrompt?: (
    sourceName: string,
    toolInputSummary?: string | null,
  ) => (request: PromptRequest) => Promise<PromptResponse>,
  toolInputSummary?: string | null,
): AsyncGenerator<AggregatedHookResult> {
  const appState = toolUseContext.getAppState()
  const sessionId = toolUseContext.agentId ?? getSessionId()
  if (!hasHookForEvent('PreToolUse', appState, sessionId)) {
    return
  }

  logForDebugging(`executePreToolHooks called for tool: ${toolName}`, {
    level: 'verbose',
  })

  const hookInput: PreToolUseHookInput = {
    ...createBaseHookInput(permissionMode, undefined, toolUseContext),
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseID,
  }

  yield* executeHooks({
    hookInput,
    toolUseID,
    matchQuery: toolName,
    signal,
    timeoutMs,
    toolUseContext,
    requestPrompt,
    toolInputSummary,
  })
}

/**
 * 如果配置了，执行后工具钩子
 * @param toolName 工具名称（例如 'Write', 'Edit', 'Bash'）
 * @param toolUseID 工具使用的 ID
 * @param toolInput 传递给工具的输入
 * @param toolResponse 工具的响应
 * @param toolUseContext 用于基于提示的钩子的 ToolUseContext
 * @param permissionMode 来自 toolPermissionContext 的可选权限模式
 * @param signal 可选的 AbortSignal 用于取消钩子执行
 * @param timeoutMs 钩子执行的可选超时时间（毫秒）
 * @returns 生成进度消息和用于自动反馈的阻塞错误的异步生成器
 */
export async function* executePostToolHooks<ToolInput, ToolResponse>(
  toolName: string,
  toolUseID: string,
  toolInput: ToolInput,
  toolResponse: ToolResponse,
  toolUseContext: ToolUseContext,
  permissionMode?: string,
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): AsyncGenerator<AggregatedHookResult> {
  const hookInput: PostToolUseHookInput = {
    ...createBaseHookInput(permissionMode, undefined, toolUseContext),
    hook_event_name: 'PostToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: toolResponse,
    tool_use_id: toolUseID,
  }

  yield* executeHooks({
    hookInput,
    toolUseID,
    matchQuery: toolName,
    signal,
    timeoutMs,
    toolUseContext,
  })
}

/**
 * 如果配置了，执行后工具使用失败钩子
 * @param toolName 工具名称（例如 'Write', 'Edit', 'Bash'）
 * @param toolUseID 工具使用的 ID
 * @param toolInput 传递给工具的输入
 * @param error 失败工具调用的错误消息
 * @param toolUseContext 用于基于提示的钩子的 ToolUseContext
 * @param isInterrupt 工具是否被用户中断
 * @param permissionMode 来自 toolPermissionContext 的可选权限模式
 * @param signal 可选的 AbortSignal 用于取消钩子执行
 * @param timeoutMs 钩子执行的可选超时时间（毫秒）
 * @returns 生成进度消息和阻塞错误的异步生成器
 */
export async function* executePostToolUseFailureHooks<ToolInput>(
  toolName: string,
  toolUseID: string,
  toolInput: ToolInput,
  error: string,
  toolUseContext: ToolUseContext,
  isInterrupt?: boolean,
  permissionMode?: string,
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): AsyncGenerator<AggregatedHookResult> {
  const appState = toolUseContext.getAppState()
  const sessionId = toolUseContext.agentId ?? getSessionId()
  if (!hasHookForEvent('PostToolUseFailure', appState, sessionId)) {
    return
  }

  const hookInput: PostToolUseFailureHookInput = {
    ...createBaseHookInput(permissionMode, undefined, toolUseContext),
    hook_event_name: 'PostToolUseFailure',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseID,
    error,
    is_interrupt: isInterrupt,
  }

  yield* executeHooks({
    hookInput,
    toolUseID,
    matchQuery: toolName,
    signal,
    timeoutMs,
    toolUseContext,
  })
}

/** 执行 execute Permission Denied Hooks 对应的数据或状态。 */
export async function* executePermissionDeniedHooks<ToolInput>(
  toolName: string,
  toolUseID: string,
  toolInput: ToolInput,
  reason: string,
  toolUseContext: ToolUseContext,
  permissionMode?: string,
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): AsyncGenerator<AggregatedHookResult> {
  const appState = toolUseContext.getAppState()
  const sessionId = toolUseContext.agentId ?? getSessionId()
  if (!hasHookForEvent('PermissionDenied', appState, sessionId)) {
    return
  }

  const hookInput: PermissionDeniedHookInput = {
    ...createBaseHookInput(permissionMode, undefined, toolUseContext),
    hook_event_name: 'PermissionDenied',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseID,
    reason,
  }

  yield* executeHooks({
    hookInput,
    toolUseID,
    matchQuery: toolName,
    signal,
    timeoutMs,
    toolUseContext,
  })
}

/**
 * 如果配置了，执行通知钩子
 * @param notificationData 传递给钩子的通知数据
 * @param timeoutMs 钩子执行的可选超时时间（毫秒）
 * @returns 所有钩子完成时解析的 Promise
 */
export async function executeNotificationHooks(
  notificationData: {
    message: string
    title?: string
    notificationType: string
  },
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): Promise<void> {
  const { message, title, notificationType } = notificationData
  const hookInput: NotificationHookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'Notification',
    message,
    title,
    notification_type: notificationType,
  }

  await executeHooksOutsideREPL({
    hookInput,
    timeoutMs,
    matchQuery: notificationType,
  })
}

/** 执行 execute Stop Failure Hooks 对应的数据或状态。 */
export async function executeStopFailureHooks(
  lastMessage: AssistantMessage,
  toolUseContext?: ToolUseContext,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): Promise<void> {
  const appState = toolUseContext?.getAppState()
  // executeHooksOutsideREPL 硬编码了主 sessionId (:2738)。Agent 前置钩子（registerFrontmatterHooks）以 agentId 为键；在此处用 agentId 进行门控会通过门控但执行失败。将门控与执行对齐。
  const sessionId = getSessionId()
  if (!hasHookForEvent('StopFailure', appState, sessionId)) return

  const lastAssistantText =
    extractTextContent(lastMessage.message.content, '\n').trim() || undefined

  // 某些 createAssistantAPIErrorMessage 调用点省略了 `error`（例如 errors.ts:431 处的 image-size）。默认为 'unknown'，以便在 getMatchingHooks:1525 处的匹配器过滤始终适用。
  const error = lastMessage.error ?? 'unknown'
  const hookInput: StopFailureHookInput = {
    ...createBaseHookInput(undefined, undefined, toolUseContext),
    hook_event_name: 'StopFailure',
    error,
    error_details: lastMessage.errorDetails,
    last_assistant_message: lastAssistantText,
  }

  await executeHooksOutsideREPL({
    getAppState: toolUseContext?.getAppState,
    hookInput,
    timeoutMs,
    matchQuery: error,
  })
}

/**
 * 如果配置了，执行停止钩子
 * @param toolUseContext 用于基于提示的钩子的 ToolUseContext
 * @param permissionMode 来自 toolPermissionContext 的权限模式
 * @param signal 用于取消钩子执行的 AbortSignal
 * @param stopHookActive 此调用是否在另一个停止钩子内进行
 * @param isSubagent 当前执行上下文是否是子代理
 * @param messages 用于提示/函数钩子的可选对话历史
 * @returns 生成进度消息和阻塞错误的异步生成器
 */
export async function* executeStopHooks(
  permissionMode?: string,
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  stopHookActive: boolean = false,
  subagentId?: AgentId,
  toolUseContext?: ToolUseContext,
  messages?: Message[],
  agentType?: string,
  requestPrompt?: (
    sourceName: string,
    toolInputSummary?: string | null,
  ) => (request: PromptRequest) => Promise<PromptResponse>,
): AsyncGenerator<AggregatedHookResult> {
  const hookEvent = subagentId ? 'SubagentStop' : 'Stop'
  const appState = toolUseContext?.getAppState()
  const sessionId = toolUseContext?.agentId ?? getSessionId()
  if (!hasHookForEvent(hookEvent, appState, sessionId)) {
    return
  }

  // 从最后一条助手消息中提取文本内容，以便钩子可以检查最终响应而无需读取转录文件。
  const lastAssistantMessage = messages
    ? getLastAssistantMessage(messages)
    : undefined
  const lastAssistantText = lastAssistantMessage
    ? extractTextContent(lastAssistantMessage.message.content, '\n').trim() ||
      undefined
    : undefined

  const hookInput: StopHookInput | SubagentStopHookInput = subagentId
    ? {
        ...createBaseHookInput(permissionMode),
        hook_event_name: 'SubagentStop',
        stop_hook_active: stopHookActive,
        agent_id: subagentId,
        agent_transcript_path: getAgentTranscriptPath(subagentId),
        agent_type: agentType ?? '',
        last_assistant_message: lastAssistantText,
      }
    : {
        ...createBaseHookInput(permissionMode),
        hook_event_name: 'Stop',
        stop_hook_active: stopHookActive,
        last_assistant_message: lastAssistantText,
      }

  // 信任检查现已集中在 executeHooks() 中
  yield* executeHooks({
    hookInput,
    toolUseID: randomUUID(),
    signal,
    timeoutMs,
    toolUseContext,
    messages,
    requestPrompt,
  })
}

/**
 * 当队友即将进入空闲状态时执行 TeammateIdle 钩子。
 * 如果钩子阻塞（退出码 2），队友应继续工作而不是进入空闲。
 * @param teammateName 进入空闲的队友名称
 * @param teamName 该队友所属的团队
 * @param permissionMode 可选权限模式
 * @param signal 可选的 AbortSignal 用于取消钩子执行
 * @param timeoutMs 钩子执行的可选超时时间（毫秒）
 * @returns 生成进度消息和阻塞错误的异步生成器
 */
export async function* executeTeammateIdleHooks(
  teammateName: string,
  teamName: string,
  permissionMode?: string,
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): AsyncGenerator<AggregatedHookResult> {
  const hookInput: TeammateIdleHookInput = {
    ...createBaseHookInput(permissionMode),
    hook_event_name: 'TeammateIdle',
    teammate_name: teammateName,
    team_name: teamName,
  }

  yield* executeHooks({
    hookInput,
    toolUseID: randomUUID(),
    signal,
    timeoutMs,
  })
}

/**
 * 当任务被创建时执行 TaskCreated 钩子。
 * 如果钩子阻塞（退出码 2），应阻止任务创建并返回反馈。
 * @param taskId 被创建任务的 ID
 * @param taskSubject 任务的主题/标题
 * @param taskDescription 任务的可选描述
 * @param teammateName 创建任务的队友可选名称
 * @param teamName 可选团队名称
 * @param permissionMode 可选权限模式
 * @param signal 可选的 AbortSignal 用于取消钩子执行
 * @param timeoutMs 钩子执行的可选超时时间（毫秒）
 * @param toolUseContext 用于解析 appState 和 sessionId 的可选 ToolUseContext
 * @returns 生成进度消息和阻塞错误的异步生成器
 */
export async function* executeTaskCreatedHooks(
  taskId: string,
  taskSubject: string,
  taskDescription?: string,
  teammateName?: string,
  teamName?: string,
  permissionMode?: string,
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  toolUseContext?: ToolUseContext,
): AsyncGenerator<AggregatedHookResult> {
  const hookInput: TaskCreatedHookInput = {
    ...createBaseHookInput(permissionMode),
    hook_event_name: 'TaskCreated',
    task_id: taskId,
    task_subject: taskSubject,
    task_description: taskDescription,
    teammate_name: teammateName,
    team_name: teamName,
  }

  yield* executeHooks({
    hookInput,
    toolUseID: randomUUID(),
    signal,
    timeoutMs,
    toolUseContext,
  })
}

/**
 * 当一个任务被标记为完成时，执行 TaskCompleted 钩子。
 * 如果某个钩子阻塞（退出码为 2），应阻止任务完成并返回反馈。
 * @param taskId 正在完成的任务的 ID
 * @param taskSubject 任务的标题
 * @param taskDescription 可选的任务描述
 * @param teammateName 可选的完成任务的队友名称
 * @param teamName 可选的团队名称
 * @param permissionMode 可选的权限模式
 * @param signal 可选的 AbortSignal，用于取消钩子执行
 * @param timeoutMs 可选的钩子执行超时时间（毫秒）
 * @param toolUseContext 可选的 ToolUseContext，用于解析 appState 和 sessionId
 * @returns 异步生成器，产生进度消息和阻塞错误
 */
export async function* executeTaskCompletedHooks(
  taskId: string,
  taskSubject: string,
  taskDescription?: string,
  teammateName?: string,
  teamName?: string,
  permissionMode?: string,
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  toolUseContext?: ToolUseContext,
): AsyncGenerator<AggregatedHookResult> {
  const hookInput: TaskCompletedHookInput = {
    ...createBaseHookInput(permissionMode),
    hook_event_name: 'TaskCompleted',
    task_id: taskId,
    task_subject: taskSubject,
    task_description: taskDescription,
    teammate_name: teammateName,
    team_name: teamName,
  }

  yield* executeHooks({
    hookInput,
    toolUseID: randomUUID(),
    signal,
    timeoutMs,
    toolUseContext,
  })
}

/**
 * 如果配置了启动钩子，则执行它们
 * @param prompt 将传递给工具的用户提示
 * @param permissionMode 来自 toolPermissionContext 的权限模式
 * @param toolUseContext 用于基于提示的钩子的 ToolUseContext
 * @returns 异步生成器，产生进度消息和钩子结果
 */
export async function* executeUserPromptSubmitHooks(
  prompt: string,
  permissionMode: string,
  toolUseContext: ToolUseContext,
  requestPrompt?: (
    sourceName: string,
    toolInputSummary?: string | null,
  ) => (request: PromptRequest) => Promise<PromptResponse>,
): AsyncGenerator<AggregatedHookResult> {
  const appState = toolUseContext.getAppState()
  const sessionId = toolUseContext.agentId ?? getSessionId()
  if (!hasHookForEvent('UserPromptSubmit', appState, sessionId)) {
    return
  }

  const hookInput: UserPromptSubmitHookInput = {
    ...createBaseHookInput(permissionMode),
    hook_event_name: 'UserPromptSubmit',
    prompt,
    session_title: getCurrentSessionTitle(getSessionId()),
  }

  yield* executeHooks({
    hookInput,
    toolUseID: randomUUID(),
    signal: toolUseContext.abortController.signal,
    timeoutMs: TOOL_HOOK_EXECUTION_TIMEOUT_MS,
    toolUseContext,
    requestPrompt,
  })
}

/**
 * 如果配置了会话启动钩子，则执行它们
 * @param source 会话启动的来源（startup、resume、clear）
 * @param sessionId 可选的会话 ID，用作钩子输入
 * @param agentType 可选的运行此会话的代理类型（来自 --agent 标志）
 * @param model 可选的此会话使用的模型
 * @param signal 可选的 AbortSignal，用于取消钩子执行
 * @param timeoutMs 可选的钩子执行超时时间（毫秒）
 * @returns 异步生成器，产生进度消息和钩子结果
 */
export async function* executeSessionStartHooks(
  source: 'startup' | 'resume' | 'clear' | 'compact',
  sessionId?: string,
  agentType?: string,
  model?: string,
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  forceSyncExecution?: boolean,
): AsyncGenerator<AggregatedHookResult> {
  const hookInput: SessionStartHookInput = {
    ...createBaseHookInput(undefined, sessionId),
    hook_event_name: 'SessionStart',
    source,
    agent_type: agentType,
    model,
  }

  yield* executeHooks({
    hookInput,
    toolUseID: randomUUID(),
    matchQuery: source,
    signal,
    timeoutMs,
    forceSyncExecution,
  })
}

/**
 * 如果配置了设置钩子，则执行它们
 * @param trigger 触发器类型（'init' 或 'maintenance'）
 * @param signal 可选的 AbortSignal，用于取消钩子执行
 * @param timeoutMs 可选的钩子执行超时时间（毫秒）
 * @param forceSyncExecution 如果为 true，异步钩子将不会后台运行
 * @returns 异步生成器，产生进度消息和钩子结果
 */
export async function* executeSetupHooks(
  trigger: 'init' | 'maintenance',
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  forceSyncExecution?: boolean,
): AsyncGenerator<AggregatedHookResult> {
  const hookInput: SetupHookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'Setup',
    trigger,
  }

  yield* executeHooks({
    hookInput,
    toolUseID: randomUUID(),
    matchQuery: trigger,
    signal,
    timeoutMs,
    forceSyncExecution,
  })
}

/**
 * 如果配置了子代理启动钩子，则执行它们
 * @param agentId 子代理的唯一标识符
 * @param agentType 正在启动的子代理的类型/名称
 * @param signal 可选的 AbortSignal，用于取消钩子执行
 * @param timeoutMs 可选的钩子执行超时时间（毫秒）
 * @returns 异步生成器，产生进度消息和钩子结果
 */
export async function* executeSubagentStartHooks(
  agentId: string,
  agentType: string,
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): AsyncGenerator<AggregatedHookResult> {
  const hookInput: SubagentStartHookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'SubagentStart',
    agent_id: agentId,
    agent_type: agentType,
  }

  yield* executeHooks({
    hookInput,
    toolUseID: randomUUID(),
    matchQuery: agentType,
    signal,
    timeoutMs,
  })
}

/**
 * 如果配置了预压缩钩子，则执行它们
 * @param compactData 要传递给钩子的压缩数据
 * @param signal 可选的 AbortSignal，用于取消钩子执行
 * @param timeoutMs 可选的钩子执行超时时间（毫秒）
 * @returns 包含可选的 newCustomInstructions 和 userDisplayMessage 的对象
 */
export async function executePreCompactHooks(
  compactData: {
    trigger: 'manual' | 'auto'
    customInstructions: string | null
  },
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): Promise<{
  newCustomInstructions?: string
  userDisplayMessage?: string
}> {
  const hookInput: PreCompactHookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'PreCompact',
    trigger: compactData.trigger,
    custom_instructions: compactData.customInstructions,
  }

  const results = await executeHooksOutsideREPL({
    hookInput,
    matchQuery: compactData.trigger,
    signal,
    timeoutMs,
  })

  if (results.length === 0) {
    return {}
  }

  // 从成功且输出非空的钩子中提取自定义指令
  const successfulOutputs = results
    .filter(result => result.succeeded && result.output.trim().length > 0)
    .map(result => result.output.trim())

  // 构建包含命令信息的用户显示消息
  const displayMessages: string[] = []
  for (const result of results) {
    if (result.succeeded) {
      if (result.output.trim()) {
        displayMessages.push(
          `PreCompact [${result.command}] completed successfully: ${result.output.trim()}`,
        )
      } else {
        displayMessages.push(
          `PreCompact [${result.command}] completed successfully`,
        )
      }
    } else {
      if (result.output.trim()) {
        displayMessages.push(
          `PreCompact [${result.command}] failed: ${result.output.trim()}`,
        )
      } else {
        displayMessages.push(`PreCompact [${result.command}] failed`)
      }
    }
  }

  return {
    newCustomInstructions:
      successfulOutputs.length > 0 ? successfulOutputs.join('\n\n') : undefined,
    userDisplayMessage:
      displayMessages.length > 0 ? displayMessages.join('\n') : undefined,
  }
}

/**
 * 如果配置了后压缩钩子，则执行它们
 * @param compactData 要传递给钩子的压缩数据，包括摘要
 * @param signal 可选的 AbortSignal，用于取消钩子执行
 * @param timeoutMs 可选的钩子执行超时时间（毫秒）
 * @returns 包含可选的 userDisplayMessage 的对象
 */
export async function executePostCompactHooks(
  compactData: {
    trigger: 'manual' | 'auto'
    compactSummary: string
  },
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): Promise<{
  userDisplayMessage?: string
}> {
  const hookInput: PostCompactHookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'PostCompact',
    trigger: compactData.trigger,
    compact_summary: compactData.compactSummary,
  }

  const results = await executeHooksOutsideREPL({
    hookInput,
    matchQuery: compactData.trigger,
    signal,
    timeoutMs,
  })

  if (results.length === 0) {
    return {}
  }

  const displayMessages: string[] = []
  for (const result of results) {
    if (result.succeeded) {
      if (result.output.trim()) {
        displayMessages.push(
          `PostCompact [${result.command}] completed successfully: ${result.output.trim()}`,
        )
      } else {
        displayMessages.push(
          `PostCompact [${result.command}] completed successfully`,
        )
      }
    } else {
      if (result.output.trim()) {
        displayMessages.push(
          `PostCompact [${result.command}] failed: ${result.output.trim()}`,
        )
      } else {
        displayMessages.push(`PostCompact [${result.command}] failed`)
      }
    }
  }

  return {
    userDisplayMessage:
      displayMessages.length > 0 ? displayMessages.join('\n') : undefined,
  }
}

/**
 * 如果配置了会话结束钩子，则执行它们
 * @param reason 结束会话的原因
 * @param options 可选参数，包括应用状态函数和信号
 * @returns 当所有钩子完成时解析的 Promise
 */
export async function executeSessionEndHooks(
  reason: ExitReason,
  options?: {
    /** 获取 get App State 对应的数据或状态。 */
    getAppState?: () => AppState
    /** 设置并保存 set App State 对应的数据或状态。 */
    setAppState?: (updater: (prev: AppState) => AppState) => void
    signal?: AbortSignal
    timeoutMs?: number
  },
): Promise<void> {
  const {
    getAppState,
    setAppState,
    signal,
    timeoutMs = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  } = options || {}

  const hookInput: SessionEndHookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'SessionEnd',
    reason,
  }

  const results = await executeHooksOutsideREPL({
    getAppState,
    hookInput,
    matchQuery: reason,
    signal,
    timeoutMs,
  })

  // 在关闭期间，Ink 会卸载，因此我们可以直接写入 stderr
  for (const result of results) {
    if (!result.succeeded && result.output) {
      process.stderr.write(
        `SessionEnd hook [${result.command}] failed: ${result.output}\n`,
      )
    }
  }

  // 执行后清除会话钩子
  if (setAppState) {
    const sessionId = getSessionId()
    clearSessionHooks(setAppState, sessionId)
  }
}

/**
 * 如果配置了权限请求钩子，则执行它们
 * 当会向用户显示权限对话框时，会调用这些钩子。
 * 钩子可以编程方式批准或拒绝权限请求。
 * @param toolName 请求权限的工具名称
 * @param toolUseID 工具使用的 ID
 * @param toolInput 将传递给工具的输入
 * @param toolUseContext 请求的 ToolUseContext
 * @param permissionMode 可选的来自 toolPermissionContext 的权限模式
 * @param permissionSuggestions 可选的权限建议（“始终允许”选项）
 * @param signal 可选的 AbortSignal，用于取消钩子执行
 * @param timeoutMs 可选的钩子执行超时时间（毫秒）
 * @returns 异步生成器，产生进度消息并返回聚合结果
 */
export async function* executePermissionRequestHooks<ToolInput>(
  toolName: string,
  toolUseID: string,
  toolInput: ToolInput,
  toolUseContext: ToolUseContext,
  permissionMode?: string,
  permissionSuggestions?: PermissionUpdate[],
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  requestPrompt?: (
    sourceName: string,
    toolInputSummary?: string | null,
  ) => (request: PromptRequest) => Promise<PromptResponse>,
  toolInputSummary?: string | null,
): AsyncGenerator<AggregatedHookResult> {
  logForDebugging(`executePermissionRequestHooks called for tool: ${toolName}`)

  const hookInput: PermissionRequestHookInput = {
    ...createBaseHookInput(permissionMode, undefined, toolUseContext),
    hook_event_name: 'PermissionRequest',
    tool_name: toolName,
    tool_input: toolInput,
    permission_suggestions: permissionSuggestions,
  }

  yield* executeHooks({
    hookInput,
    toolUseID,
    matchQuery: toolName,
    signal,
    timeoutMs,
    toolUseContext,
    requestPrompt,
    toolInputSummary,
  })
}

export type ConfigChangeSource =
  | 'user_settings'
  | 'project_settings'
  | 'local_settings'
  | 'policy_settings'
  | 'skills'

/**
 * 当会话期间配置文件发生更改时，执行配置更改钩子。
 * 当设置、技能或命令在磁盘上发生变化时，由文件监视器触发。
 * 使企业管理员能够审计/记录配置更改以确保安全。
 *
 * 策略设置由企业管理，绝不能被钩子阻止。
 * 钩子仍然会触发（用于审计日志记录），但阻塞结果将被忽略——调用者
 * 对于策略源将始终看到空结果。
 *
 * @param source 已更改的配置类型
 * @param filePath 可选的已更改文件的路径
 * @param timeoutMs 可选的钩子执行超时时间（毫秒）
 */
export async function executeConfigChangeHooks(
  source: ConfigChangeSource,
  filePath?: string,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): Promise<HookOutsideReplResult[]> {
  const hookInput: ConfigChangeHookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'ConfigChange',
    source,
    file_path: filePath,
  }

  const results = await executeHooksOutsideREPL({
    hookInput,
    timeoutMs,
    matchQuery: source,
  })

  // 策略设置由企业管理——钩子触发用于审计日志记录
  // 但绝不能阻止策略变更的应用
  if (source === 'policy_settings') {
    return results.map(r => ({ ...r, blocked: false }))
  }

  return results
}

/** 执行 execute Env Hooks 对应的数据或状态。 */
async function executeEnvHooks(
  hookInput: HookInput,
  timeoutMs: number,
): Promise<{
  results: HookOutsideReplResult[]
  watchPaths: string[]
  systemMessages: string[]
}> {
  const results = await executeHooksOutsideREPL({ hookInput, timeoutMs })
  if (results.length > 0) {
    invalidateSessionEnvCache()
  }
  /** 执行 watch Paths 对应的业务处理。 */
  const watchPaths = results.flatMap(r => r.watchPaths ?? [])
  /** 执行 system Messages 对应的业务处理。 */
  const systemMessages = results
    .map(r => r.systemMessage)
    .filter((m): m is string => !!m)
  return { results, watchPaths, systemMessages }
}

/** 执行 execute Cwd Changed Hooks 对应的数据或状态。 */
export function executeCwdChangedHooks(
  oldCwd: string,
  newCwd: string,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): Promise<{
  results: HookOutsideReplResult[]
  watchPaths: string[]
  systemMessages: string[]
}> {
  const hookInput: CwdChangedHookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'CwdChanged',
    old_cwd: oldCwd,
    new_cwd: newCwd,
  }
  return executeEnvHooks(hookInput, timeoutMs)
}

/** 执行 execute File Changed Hooks 对应的数据或状态。 */
export function executeFileChangedHooks(
  filePath: string,
  event: 'change' | 'add' | 'unlink',
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): Promise<{
  results: HookOutsideReplResult[]
  watchPaths: string[]
  systemMessages: string[]
}> {
  const hookInput: FileChangedHookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'FileChanged',
    file_path: filePath,
    event,
  }
  return executeEnvHooks(hookInput, timeoutMs)
}

export type InstructionsLoadReason =
  | 'session_start'
  | 'nested_traversal'
  | 'path_glob_match'
  | 'include'
  | 'compact'

export type InstructionsMemoryType = 'User' | 'Project' | 'Local' | 'Managed'

/**
 * 检查是否配置了 InstructionsLoaded 钩子（而不执行它们）。
 * 调用者应在调用 executeInstructionsLoadedHooks 之前检查此项，以避免
 * 在没有配置钩子时为每个指令文件构建钩子输入。
 *
 * 检查设置文件钩子（来自 getHooksConfigFromSnapshot）和已注册的
 * 钩子（插件钩子 + 通过 registerHookCallbacks 的 SDK 回调钩子）。会话
 * 派生的钩子（结构化输出强制执行等）是内部的，不进行检查。
 */
export function hasInstructionsLoadedHook(): boolean {
  const snapshotHooks = getHooksConfigFromSnapshot()?.['InstructionsLoaded']
  if (snapshotHooks && snapshotHooks.length > 0) return true
  const registeredHooks = getRegisteredHooks()?.['InstructionsLoaded']
  if (registeredHooks && registeredHooks.length > 0) return true
  return false
}

/**
 * 执行指令加载钩子——当指令文件（CLAUDE.md 或 .claude-code-core-framework/rules/*.md）被加载到上下文时触发。即发即弃——此钩子仅用于可观测性/审计，不支持阻塞。
 *
 * 调度点：
 * - 会话启动时预加载（claudemd.ts 中的 getMemoryFiles）
 * - 压缩后重新预加载（runPostCompactCleanup 清除 getMemoryFiles 缓存；下次调用报告 load_reason: 'compact'）
 * - 当 Claude 触及触发嵌套 CLAUDE.md 或带有路径的条件规则的文件时惰性加载：frontmatter（attachments.ts 中的 memoryFilesToAttachments）
 */
export async function executeInstructionsLoadedHooks(
  filePath: string,
  memoryType: InstructionsMemoryType,
  loadReason: InstructionsLoadReason,
  options?: {
    globs?: string[]
    triggerFilePath?: string
    parentFilePath?: string
    timeoutMs?: number
  },
): Promise<void> {
  const {
    globs,
    triggerFilePath,
    parentFilePath,
    timeoutMs = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  } = options ?? {}

  const hookInput: InstructionsLoadedHookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'InstructionsLoaded',
    file_path: filePath,
    memory_type: memoryType,
    load_reason: loadReason,
    globs,
    trigger_file_path: triggerFilePath,
    parent_file_path: parentFilePath,
  }

  await executeHooksOutsideREPL({
    hookInput,
    timeoutMs,
    matchQuery: loadReason,
  })
}

/** 启发式钩子执行的结果（非 REPL 路径）。 */
export type ElicitationHookResult = {
  elicitationResponse?: ElicitationResponse
  blockingError?: HookBlockingError
}

/** 启发式结果钩子执行的结果（非 REPL 路径）。 */
export type ElicitationResultHookResult = {
  elicitationResultResponse?: ElicitationResponse
  blockingError?: HookBlockingError
}

/**
 * 从 HookOutsideReplResult 解析启发式特定字段。
 * 镜像 processHookJSONOutput 中关于 Elicitation 和 ElicitationResult 钩子事件的相关分支。
 */
function parseElicitationHookOutput(
  result: HookOutsideReplResult,
  expectedEventName: 'Elicitation' | 'ElicitationResult',
): {
  response?: ElicitationResponse
  blockingError?: HookBlockingError
} {
  // 退出码 2 = 阻塞（与 executeHooks 路径相同）
  if (result.blocked && !result.succeeded) {
    return {
      blockingError: {
        blockingError: result.output || `Elicitation blocked by hook`,
        command: result.command,
      },
    }
  }

  if (!result.output.trim()) {
    return {}
  }

  // 尝试解析 JSON 输出以获得结构化启发式响应
  const trimmed = result.output.trim()
  if (!trimmed.startsWith('{')) {
    return {}
  }

  try {
    const parsed = hookJSONOutputSchema().parse(JSON.parse(trimmed))
    if (isAsyncHookJSONOutput(parsed)) {
      return {}
    }
    if (!isSyncHookJSONOutput(parsed)) {
      return {}
    }

    // 检查顶层决策：'block'（退出码 0 + JSON block）
    if (parsed.decision === 'block' || result.blocked) {
      return {
        blockingError: {
          blockingError: parsed.reason || 'Elicitation blocked by hook',
          command: result.command,
        },
      }
    }

    const specific = parsed.hookSpecificOutput
    if (!specific || specific.hookEventName !== expectedEventName) {
      return {}
    }

    if (!specific.action) {
      return {}
    }

    const response: ElicitationResponse = {
      action: specific.action,
      content: specific.content as ElicitationResponse['content'] | undefined,
    }

    const out: {
      response?: ElicitationResponse
      blockingError?: HookBlockingError
    } = { response }

    if (specific.action === 'decline') {
      out.blockingError = {
        blockingError:
          parsed.reason ||
          (expectedEventName === 'Elicitation'
            ? 'Elicitation denied by hook'
            : 'Elicitation result blocked by hook'),
        command: result.command,
      }
    }

    return out
  } catch {
    return {}
  }
}

/** 执行 execute Elicitation Hooks 对应的数据或状态。 */
export async function executeElicitationHooks({
  serverName,
  message,
  requestedSchema,
  permissionMode,
  signal,
  timeoutMs = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  mode,
  url,
  elicitationId,
}: {
  serverName: string
  message: string
  requestedSchema?: Record<string, unknown>
  permissionMode?: string
  signal?: AbortSignal
  timeoutMs?: number
  mode?: 'form' | 'url'
  url?: string
  elicitationId?: string
}): Promise<ElicitationHookResult> {
  const hookInput: ElicitationHookInput = {
    ...createBaseHookInput(permissionMode),
    hook_event_name: 'Elicitation',
    mcp_server_name: serverName,
    message,
    mode,
    url,
    elicitation_id: elicitationId,
    requested_schema: requestedSchema,
  }

  const results = await executeHooksOutsideREPL({
    hookInput,
    matchQuery: serverName,
    signal,
    timeoutMs,
  })

  let elicitationResponse: ElicitationResponse | undefined
  let blockingError: HookBlockingError | undefined

  for (const result of results) {
    const parsed = parseElicitationHookOutput(result, 'Elicitation')
    if (parsed.blockingError) {
      blockingError = parsed.blockingError
    }
    if (parsed.response) {
      elicitationResponse = parsed.response
    }
  }

  return { elicitationResponse, blockingError }
}

/** 执行 execute Elicitation Result Hooks 对应的数据或状态。 */
export async function executeElicitationResultHooks({
  serverName,
  action,
  content,
  permissionMode,
  signal,
  timeoutMs = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  mode,
  elicitationId,
}: {
  serverName: string
  action: 'accept' | 'decline' | 'cancel'
  content?: Record<string, unknown>
  permissionMode?: string
  signal?: AbortSignal
  timeoutMs?: number
  mode?: 'form' | 'url'
  elicitationId?: string
}): Promise<ElicitationResultHookResult> {
  const hookInput: ElicitationResultHookInput = {
    ...createBaseHookInput(permissionMode),
    hook_event_name: 'ElicitationResult',
    mcp_server_name: serverName,
    elicitation_id: elicitationId,
    mode,
    action,
    content,
  }

  const results = await executeHooksOutsideREPL({
    hookInput,
    matchQuery: serverName,
    signal,
    timeoutMs,
  })

  let elicitationResultResponse: ElicitationResponse | undefined
  let blockingError: HookBlockingError | undefined

  for (const result of results) {
    const parsed = parseElicitationHookOutput(result, 'ElicitationResult')
    if (parsed.blockingError) {
      blockingError = parsed.blockingError
    }
    if (parsed.response) {
      elicitationResultResponse = parsed.response
    }
  }

  return { elicitationResultResponse, blockingError }
}

/**
 * 执行状态行命令（如果已配置）
 * @param statusLineInput 将被转换为 JSON 的结构化状态输入
 * @param signal 可选的 AbortSignal 用于取消钩子执行
 * @param timeoutMs 可选的钩子执行超时时间（毫秒）
 * @returns 要显示的状态行文本，如果未配置命令则返回 undefined
 */
export async function executeStatusLineCommand(
  statusLineInput: StatusLineCommandInput,
  signal?: AbortSignal,
  timeoutMs: number = 5000, // Short timeout for status line
  logResult: boolean = false,
): Promise<string | undefined> {
  // 检查所有钩子（包括 statusLine）是否被托管设置禁用
  if (shouldDisableAllHooksIncludingManaged()) {
    return undefined
  }

  // 安全：在交互模式下所有钩子都需要工作区信任
  // 此集中检查可防止所有当前和未来钩子的 RCE 漏洞
  if (shouldSkipHookDueToTrust()) {
    logForDebugging(
      `Skipping StatusLine command execution - workspace trust not accepted`,
    )
    return undefined
  }

  // 当 disableAllHooks 在非托管设置中设置时，只有托管的 statusLine 运行
  // （非托管设置无法禁用托管命令，但非托管命令会被禁用）
  let statusLine
  if (shouldAllowManagedHooksOnly()) {
    statusLine = getSettingsForSource('policySettings')?.statusLine
  } else {
    statusLine = getInitialSettings()?.statusLine
  }

  if (!statusLine || statusLine.type !== 'command') {
    return undefined
  }

  // 使用提供的信号或创建一个默认信号
  const abortSignal = signal || AbortSignal.timeout(timeoutMs)

  try {
    // 将状态输入转换为 JSON
    const jsonInput = jsonStringify(statusLineInput)

    const result = await execCommandHook(
      statusLine,
      'StatusLine',
      'statusLine',
      jsonInput,
      abortSignal,
      randomUUID(),
    )

    if (result.aborted) {
      return undefined
    }

    // 对于成功的钩子（退出码 0），使用 stdout
    if (result.status === 0) {
      // 修剪输出并按行分割，然后用换行符重新连接
      const output = result.stdout
        .trim()
        .split('\n')
        .flatMap(line => line.trim() || [])
        .join('\n')

      if (output) {
        if (logResult) {
          logForDebugging(
            `StatusLine [${statusLine.command}] completed with status ${result.status}`,
          )
        }
        return output
      }
    } else if (logResult) {
      logForDebugging(
        `StatusLine [${statusLine.command}] completed with status ${result.status}`,
        { level: 'warn' },
      )
    }

    return undefined
  } catch (error) {
    logForDebugging(`Status hook failed: ${error}`, { level: 'error' })
    return undefined
  }
}

/**
 * 执行文件建议命令（如果已配置）
 * @param fileSuggestionInput 将被转换为 JSON 的结构化输入
 * @param signal 可选的 AbortSignal 用于取消钩子执行
 * @param timeoutMs 可选的钩子执行超时时间（毫秒）
 * @returns 文件路径数组，如果未配置命令则返回空数组
 */
export async function executeFileSuggestionCommand(
  fileSuggestionInput: FileSuggestionCommandInput,
  signal?: AbortSignal,
  timeoutMs: number = 5000, // Short timeout for typeahead suggestions
): Promise<string[]> {
  // 检查所有钩子是否被托管设置禁用
  if (shouldDisableAllHooksIncludingManaged()) {
    return []
  }

  // 安全：在交互模式下所有钩子都需要工作区信任
  // 此集中检查可防止所有当前和未来钩子的 RCE 漏洞
  if (shouldSkipHookDueToTrust()) {
    logForDebugging(
      `Skipping FileSuggestion command execution - workspace trust not accepted`,
    )
    return []
  }

  // 当 disableAllHooks 在非托管设置中设置时，只有托管的 fileSuggestion 运行
  // （非托管设置无法禁用托管命令，但非托管命令会被禁用）
  let fileSuggestion
  if (shouldAllowManagedHooksOnly()) {
    fileSuggestion = getSettingsForSource('policySettings')?.fileSuggestion
  } else {
    fileSuggestion = getInitialSettings()?.fileSuggestion
  }

  if (!fileSuggestion || fileSuggestion.type !== 'command') {
    return []
  }

  // 使用提供的信号或创建一个默认信号
  const abortSignal = signal || AbortSignal.timeout(timeoutMs)

  try {
    const jsonInput = jsonStringify(fileSuggestionInput)

    const hook = { type: 'command' as const, command: fileSuggestion.command }

    const result = await execCommandHook(
      hook,
      'FileSuggestion',
      'FileSuggestion',
      jsonInput,
      abortSignal,
      randomUUID(),
    )

    if (result.aborted || result.status !== 0) {
      return []
    }

    return result.stdout
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
  } catch (error) {
    logForDebugging(`File suggestion helper failed: ${error}`, {
      level: 'error',
    })
    return []
  }
}

/** 执行 execute Function Hook 对应的数据或状态。 */
async function executeFunctionHook({
  hook,
  messages,
  hookName,
  toolUseID,
  hookEvent,
  timeoutMs,
  signal,
}: {
  hook: FunctionHook
  messages: Message[]
  hookName: string
  toolUseID: string
  hookEvent: HookEvent
  timeoutMs: number
  signal?: AbortSignal
}): Promise<HookResult> {
  const callbackTimeoutMs = hook.timeout ?? timeoutMs
  const { signal: abortSignal, cleanup } = createCombinedAbortSignal(signal, {
    timeoutMs: callbackTimeoutMs,
  })

  try {
    // 检查是否已中止
    if (abortSignal.aborted) {
      cleanup()
      return {
        outcome: 'cancelled',
        hook,
      }
    }

    // 使用中止信号执行回调
    const passed = await new Promise<boolean>((resolve, reject) => {
      // 处理中止信号
      const onAbort = () => reject(new Error('Function hook cancelled'))
      abortSignal.addEventListener('abort', onAbort)

      // 执行回调
      Promise.resolve(hook.callback(messages, abortSignal))
        .then(result => {
          abortSignal.removeEventListener('abort', onAbort)
          resolve(result)
        })
        .catch(error => {
          abortSignal.removeEventListener('abort', onAbort)
          reject(error)
        })
    })

    cleanup()

    if (passed) {
      return {
        outcome: 'success',
        hook,
      }
    }
    return {
      blockingError: {
        blockingError: hook.errorMessage,
        command: 'function',
      },
      outcome: 'blocking',
      hook,
    }
  } catch (error) {
    cleanup()

    // 处理取消
    if (
      error instanceof Error &&
      (error.message === 'Function hook cancelled' ||
        error.name === 'AbortError')
    ) {
      return {
        outcome: 'cancelled',
        hook,
      }
    }

    // 记录日志以进行监控
    logError(error)
    return {
      message: createAttachmentMessage({
        type: 'hook_error_during_execution',
        hookName,
        toolUseID,
        hookEvent,
        content:
          error instanceof Error
            ? error.message
            : 'Function hook execution error',
      }),
      outcome: 'non_blocking_error',
      hook,
    }
  }
}

/** 执行 execute Hook Callback 对应的数据或状态。 */
async function executeHookCallback({
  toolUseID,
  hook,
  hookEvent,
  hookInput,
  signal,
  hookIndex,
  toolUseContext,
}: {
  toolUseID: string
  hook: HookCallback
  hookEvent: HookEvent
  hookInput: HookInput
  signal: AbortSignal
  hookIndex?: number
  toolUseContext?: ToolUseContext
}): Promise<HookResult> {
  // 为需要状态访问的回调创建上下文
  const context = toolUseContext
    ? {
        getAppState: toolUseContext.getAppState,
      }
    : undefined
  const json = await hook.callback(
    hookInput,
    toolUseID,
    signal,
    hookIndex,
    context,
  )
  if (isAsyncHookJSONOutput(json)) {
    return {
      outcome: 'success',
      hook,
    }
  }

  const processed = processHookJSONOutput({
    json,
    command: 'callback',
    // TODO：如果钩子来自插件，则使用插件的完整路径以便更容易调试
    hookName: `${hookEvent}:Callback`,
    toolUseID,
    hookEvent,
    expectedHookEvent: hookEvent,
    // 回调没有 stdout/stderr/exitCode
    stdout: undefined,
    stderr: undefined,
    exitCode: undefined,
  })
  return {
    ...processed,
    outcome: 'success',
    hook,
  }
}

/**
 * 检查 WorktreeCreate 钩子是否已配置（但不执行它们）。
 *
 * 同时检查设置文件钩子（getHooksConfigFromSnapshot）和已注册的
 * 钩子（插件钩子 + 通过 registerHookCallbacks 注册的 SDK 回调钩子）。
 *
 * 必须镜像 getHooksConfig() 中的 managedOnly 过滤——当
 * shouldAllowManagedHooksOnly() 返回 true 时，插件钩子（设置了 pluginRoot）在执行时被跳过，
 * 因此我们在此也必须跳过它们。否则此函数返回
 * true，但 executeWorktreeCreateHook() 找不到匹配的钩子并抛出异常，
 * 阻塞 git-worktree 回退。
 */
export function hasWorktreeCreateHook(): boolean {
  const snapshotHooks = getHooksConfigFromSnapshot()?.['WorktreeCreate']
  if (snapshotHooks && snapshotHooks.length > 0) return true
  const registeredHooks = getRegisteredHooks()?.['WorktreeCreate']
  if (!registeredHooks || registeredHooks.length === 0) return false
  // 镜像 getHooksConfig()：在仅托管模式下跳过插件钩子
  const managedOnly = shouldAllowManagedHooksOnly()
  return registeredHooks.some(
    matcher => !(managedOnly && 'pluginRoot' in matcher),
  )
}

/**
 * 执行 WorktreeCreate 钩子。
 * 从钩子 stdout 返回工作树路径。
 * 如果钩子失败或不产生输出，则抛出异常。
 * 调用者应在调用此函数之前先检查 hasWorktreeCreateHook()。
 */
export async function executeWorktreeCreateHook(
  name: string,
): Promise<{ worktreePath: string }> {
  const hookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'WorktreeCreate' as const,
    name,
  }

  const results = await executeHooksOutsideREPL({
    hookInput,
    timeoutMs: TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  })

  // 找到第一个输出非空且成功的结果
  const successfulResult = results.find(
    r => r.succeeded && r.output.trim().length > 0,
  )

  if (!successfulResult) {
    /** 执行 failed Outputs 对应的业务处理。 */
    const failedOutputs = results
      .filter(r => !r.succeeded)
      .map(r => `${r.command}: ${r.output.trim() || 'no output'}`)
    throw new Error(
      `WorktreeCreate hook failed: ${failedOutputs.join('; ') || 'no successful output'}`,
    )
  }

  const worktreePath = successfulResult.output.trim()
  return { worktreePath }
}

/**
 * 如果已配置，则执行 WorktreeRemove 钩子。
 * 如果钩子已配置并运行，则返回 true；如果没有配置钩子，则返回 false。
 *
 * 同时检查设置文件钩子（getHooksConfigFromSnapshot）和已注册的
 * 钩子（插件钩子 + 通过 registerHookCallbacks 注册的 SDK 回调钩子）。
 */
export async function executeWorktreeRemoveHook(
  worktreePath: string,
): Promise<boolean> {
  const snapshotHooks = getHooksConfigFromSnapshot()?.['WorktreeRemove']
  const registeredHooks = getRegisteredHooks()?.['WorktreeRemove']
  const hasSnapshotHooks = snapshotHooks && snapshotHooks.length > 0
  const hasRegisteredHooks = registeredHooks && registeredHooks.length > 0
  if (!hasSnapshotHooks && !hasRegisteredHooks) {
    return false
  }

  const hookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'WorktreeRemove' as const,
    worktree_path: worktreePath,
  }

  const results = await executeHooksOutsideREPL({
    hookInput,
    timeoutMs: TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  })

  if (results.length === 0) {
    return false
  }

  for (const result of results) {
    if (!result.succeeded) {
      logForDebugging(
        `WorktreeRemove hook failed [${result.command}]: ${result.output.trim()}`,
        { level: 'error' },
      )
    }
  }

  return true
}
