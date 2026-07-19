import type {
  AsyncHookJSONOutput,
  HookEvent,
  SyncHookJSONOutput,
} from 'src/entrypoints/agentSdkTypes.js'
import { logForDebugging } from '../debug.js'
import type { ShellCommand } from '../ShellCommand.js'
import { invalidateSessionEnvCache } from '../sessionEnvironment.js'
import { jsonParse, jsonStringify } from '../slowOperations.js'
import { emitHookResponse, startHookProgressInterval } from './hookEvents.js'

export type PendingAsyncHook = {
  processId: string
  hookId: string
  hookName: string
  hookEvent: HookEvent | 'StatusLine' | 'FileSuggestion'
  toolName?: string
  pluginId?: string
  startTime: number
  timeout: number
  command: string
  responseAttachmentSent: boolean
  shellCommand?: ShellCommand
  /** 停止或关闭 stop Progress Interval 对应的数据或状态。 */
  stopProgressInterval: () => void
}

// 全局注册表状态
const pendingHooks = new Map<string, PendingAsyncHook>()

/** 添加或注册 register Pending Async Hook 对应的数据或状态。 */
export function registerPendingAsyncHook({
  processId,
  hookId,
  asyncResponse,
  hookName,
  hookEvent,
  command,
  shellCommand,
  toolName,
  pluginId,
}: {
  processId: string
  hookId: string
  asyncResponse: AsyncHookJSONOutput
  hookName: string
  hookEvent: HookEvent | 'StatusLine' | 'FileSuggestion'
  command: string
  shellCommand: ShellCommand
  toolName?: string
  pluginId?: string
}): void {
  const timeout = asyncResponse.asyncTimeout || 15000 // 默认15秒
  const existingHook = pendingHooks.get(processId)
  if (existingHook) {
    existingHook.stopProgressInterval()
    if (
      existingHook.shellCommand &&
      existingHook.shellCommand.status !== 'completed' &&
      existingHook.shellCommand.status !== 'killed'
    ) {
      existingHook.shellCommand.kill()
    }
    existingHook.shellCommand?.cleanup()
    logForDebugging(
      `Hooks: Replacing duplicate async hook registration ${processId}`,
      { level: 'warn' },
    )
  }
  logForDebugging(
    `Hooks: Registering async hook ${processId} (${hookName}) with timeout ${timeout}ms`,
  )
  const stopProgressInterval = startHookProgressInterval({
    hookId,
    hookName,
    hookEvent,
    /** 获取 get Output 对应的数据或状态。 */
    getOutput: async () => {
      const taskOutput = pendingHooks.get(processId)?.shellCommand?.taskOutput
      if (!taskOutput) {
        return { stdout: '', stderr: '', output: '' }
      }
      const stdout = await taskOutput.getStdout()
      const stderr = taskOutput.getStderr()
      return { stdout, stderr, output: stdout + stderr }
    },
  })
  pendingHooks.set(processId, {
    processId,
    hookId,
    hookName,
    hookEvent,
    toolName,
    pluginId,
    command,
    startTime: Date.now(),
    timeout,
    responseAttachmentSent: false,
    shellCommand,
    stopProgressInterval,
  })
}

/** 获取 get Pending Async Hooks 对应的数据或状态。 */
export function getPendingAsyncHooks(): PendingAsyncHook[] {
  return Array.from(pendingHooks.values()).filter(
    hook => !hook.responseAttachmentSent,
  )
}

/** 执行 finalize Hook 对应的业务处理。 */
async function finalizeHook(
  hook: PendingAsyncHook,
  exitCode: number,
  outcome: 'success' | 'error' | 'cancelled',
): Promise<void> {
  hook.stopProgressInterval()
  const taskOutput = hook.shellCommand?.taskOutput
  const stdout = taskOutput ? await taskOutput.getStdout() : ''
  const stderr = taskOutput?.getStderr() ?? ''
  hook.shellCommand?.cleanup()
  emitHookResponse({
    hookId: hook.hookId,
    hookName: hook.hookName,
    hookEvent: hook.hookEvent,
    output: stdout + stderr,
    stdout,
    stderr,
    exitCode,
    outcome,
  })
}

/** 检查 check For Async Hook Responses 对应的数据或状态。 */
export async function checkForAsyncHookResponses(): Promise<
  Array<{
    processId: string
    response: SyncHookJSONOutput
    hookName: string
    hookEvent: HookEvent | 'StatusLine' | 'FileSuggestion'
    toolName?: string
    pluginId?: string
    stdout: string
    stderr: string
    exitCode?: number
  }>
> {
  const responses: {
    processId: string
    response: SyncHookJSONOutput
    hookName: string
    hookEvent: HookEvent | 'StatusLine' | 'FileSuggestion'
    toolName?: string
    pluginId?: string
    stdout: string
    stderr: string
    exitCode?: number
  }[] = []

  const pendingCount = pendingHooks.size
  logForDebugging(`Hooks: Found ${pendingCount} total hooks in registry`)

  // 处理前快照钩子 — 之后我们会改变该映射。
  const hooks = Array.from(pendingHooks.values())

  const settled = await Promise.allSettled(
    hooks.map(async hook => {
      const stdout = (await hook.shellCommand?.taskOutput.getStdout()) ?? ''
      const stderr = hook.shellCommand?.taskOutput.getStderr() ?? ''
      logForDebugging(
        `Hooks: Checking hook ${hook.processId} (${hook.hookName}) - attachmentSent: ${hook.responseAttachmentSent}, stdout length: ${stdout.length}`,
      )

      if (!hook.shellCommand) {
        logForDebugging(
          `Hooks: Hook ${hook.processId} has no shell command, removing from registry`,
        )
        hook.stopProgressInterval()
        return { type: 'remove' as const, processId: hook.processId }
      }

      logForDebugging(`Hooks: Hook shell status ${hook.shellCommand.status}`)

      if (
        hook.shellCommand.status !== 'completed' &&
        Date.now() - hook.startTime >= hook.timeout
      ) {
        if (hook.shellCommand.status !== 'killed') {
          hook.shellCommand.kill()
        }
        await finalizeHook(hook, 1, 'cancelled')
        logForDebugging(
          `Hooks: Async hook ${hook.processId} exceeded ${hook.timeout}ms timeout`,
          { level: 'warn' },
        )
        return { type: 'remove' as const, processId: hook.processId }
      }

      if (hook.shellCommand.status === 'killed') {
        logForDebugging(
          `Hooks: Hook ${hook.processId} is ${hook.shellCommand.status}, removing from registry`,
        )
        hook.stopProgressInterval()
        hook.shellCommand.cleanup()
        return { type: 'remove' as const, processId: hook.processId }
      }

      if (hook.shellCommand.status !== 'completed') {
        return { type: 'skip' as const }
      }

      if (hook.responseAttachmentSent || !stdout.trim()) {
        logForDebugging(
          `Hooks: Skipping hook ${hook.processId} - already delivered/sent or no stdout`,
        )
        hook.stopProgressInterval()
        hook.shellCommand.cleanup()
        return { type: 'remove' as const, processId: hook.processId }
      }

      const lines = stdout.split('\n')
      logForDebugging(
        `Hooks: Processing ${lines.length} lines of stdout for ${hook.processId}`,
      )

      const execResult = await hook.shellCommand.result
      const exitCode = execResult.code

      let response: SyncHookJSONOutput = {}
      for (const line of lines) {
        if (line.trim().startsWith('{')) {
          logForDebugging(
            `Hooks: Found JSON line: ${line.trim().substring(0, 100)}...`,
          )
          try {
            const parsed = jsonParse(line.trim())
            if (!('async' in parsed)) {
              logForDebugging(
                `Hooks: Found sync response from ${hook.processId}: ${jsonStringify(parsed)}`,
              )
              response = parsed
              break
            }
          } catch {
            logForDebugging(
              `Hooks: Failed to parse JSON from ${hook.processId}: ${line.trim()}`,
            )
          }
        }
      }

      hook.responseAttachmentSent = true
      await finalizeHook(hook, exitCode, exitCode === 0 ? 'success' : 'error')

      return {
        type: 'response' as const,
        processId: hook.processId,
        isSessionStart: hook.hookEvent === 'SessionStart',
        payload: {
          processId: hook.processId,
          response,
          hookName: hook.hookName,
          hookEvent: hook.hookEvent,
          toolName: hook.toolName,
          pluginId: hook.pluginId,
          stdout,
          stderr,
          exitCode,
        },
      }
    }),
  )

  // allSettled — 隔离失败，使得一个抛出的回调不会孤立其他已应用的副作用（responseAttachmentSent, finalizeHook）。
  let sessionStartCompleted = false
  for (const [index, s] of settled.entries()) {
    if (s.status !== 'fulfilled') {
      const hook = hooks[index]!
      hook.stopProgressInterval()
      if (
        hook.shellCommand &&
        hook.shellCommand.status !== 'completed' &&
        hook.shellCommand.status !== 'killed'
      ) {
        hook.shellCommand.kill()
      }
      hook.shellCommand?.cleanup()
      pendingHooks.delete(hook.processId)
      logForDebugging(
        `Hooks: checkForAsyncHookResponses callback rejected for ${hook.processId}: ${s.reason}`,
        { level: 'error' },
      )
      continue
    }
    const r = s.value
    if (r.type === 'remove') {
      pendingHooks.delete(r.processId)
    } else if (r.type === 'response') {
      responses.push(r.payload)
      pendingHooks.delete(r.processId)
      if (r.isSessionStart) sessionStartCompleted = true
    }
  }

  if (sessionStartCompleted) {
    logForDebugging(
      `Invalidating session env cache after SessionStart hook completed`,
    )
    invalidateSessionEnvCache()
  }

  logForDebugging(
    `Hooks: checkForNewResponses returning ${responses.length} responses`,
  )
  return responses
}

/** 删除或清理 remove Delivered Async Hooks 对应的数据或状态。 */
export function removeDeliveredAsyncHooks(processIds: string[]): void {
  for (const processId of processIds) {
    const hook = pendingHooks.get(processId)
    if (hook && hook.responseAttachmentSent) {
      logForDebugging(`Hooks: Removing delivered hook ${processId}`)
      hook.stopProgressInterval()
      pendingHooks.delete(processId)
    }
  }
}

/** 执行 finalize Pending Async Hooks 对应的业务处理。 */
export async function finalizePendingAsyncHooks(): Promise<void> {
  const hooks = Array.from(pendingHooks.values())
  const settled = await Promise.allSettled(
    hooks.map(async hook => {
      if (hook.shellCommand?.status === 'completed') {
        const result = await hook.shellCommand.result
        await finalizeHook(
          hook,
          result.code,
          result.code === 0 ? 'success' : 'error',
        )
      } else {
        if (hook.shellCommand && hook.shellCommand.status !== 'killed') {
          hook.shellCommand.kill()
        }
        await finalizeHook(hook, 1, 'cancelled')
      }
    }),
  )
  pendingHooks.clear()
  for (const [index, result] of settled.entries()) {
    if (result.status === 'rejected') {
      const hook = hooks[index]!
      hook.stopProgressInterval()
      hook.shellCommand?.cleanup()
      logForDebugging(
        `Hooks: Failed to finalize async hook ${hook.processId}: ${result.reason}`,
        { level: 'error' },
      )
    }
  }
}

// 清除所有钩子的测试工具函数
export function clearAllAsyncHooks(): void {
  for (const hook of pendingHooks.values()) {
    hook.stopProgressInterval()
    if (
      hook.shellCommand &&
      hook.shellCommand.status !== 'completed' &&
      hook.shellCommand.status !== 'killed'
    ) {
      hook.shellCommand.kill()
    }
    hook.shellCommand?.cleanup()
  }
  pendingHooks.clear()
}
