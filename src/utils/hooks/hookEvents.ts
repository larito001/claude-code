/**
 * 挂钩事件系统，用于广播挂钩执行事件。
 *
 * 此模块提供了一个与主消息流分离的通用事件系统。处理程序可以注册接收事件并决定如何处理它们（例如，转换为SDK消息、日志等）。
 */

import { HOOK_EVENTS } from 'src/entrypoints/sdk/coreTypes.js'

import { logForDebugging } from '../debug.js'

/** 无论 includeHookEvents 选项如何设置，始终会发出的挂钩事件。这些是低噪音的生命周期事件，位于原始允许列表中且向后兼容。 */
const ALWAYS_EMITTED_HOOK_EVENTS = ['SessionStart', 'Setup'] as const

const MAX_PENDING_EVENTS = 100

export type HookStartedEvent = {
  type: 'started'
  hookId: string
  hookName: string
  hookEvent: string
}

export type HookProgressEvent = {
  type: 'progress'
  hookId: string
  hookName: string
  hookEvent: string
  stdout: string
  stderr: string
  output: string
}

export type HookResponseEvent = {
  type: 'response'
  hookId: string
  hookName: string
  hookEvent: string
  output: string
  stdout: string
  stderr: string
  exitCode?: number
  outcome: 'success' | 'error' | 'cancelled'
}

export type HookExecutionEvent =
  | HookStartedEvent
  | HookProgressEvent
  | HookResponseEvent
export type HookEventHandler = (event: HookExecutionEvent) => void

const pendingEvents: HookExecutionEvent[] = []
let eventHandler: HookEventHandler | null = null
let allHookEventsEnabled = false

/** 隔离外部事件处理器异常，避免观察逻辑中断钩子执行主链路。 */
function deliverEvent(
  handler: HookEventHandler,
  event: HookExecutionEvent,
): void {
  try {
    handler(event)
  } catch (error) {
    logForDebugging(`Hook event handler failed: ${String(error)}`, {
      level: 'error',
    })
  }
}

/** 添加或注册 register Hook Event Handler 对应的数据或状态。 */
export function registerHookEventHandler(
  handler: HookEventHandler | null,
): void {
  eventHandler = handler
  if (handler && pendingEvents.length > 0) {
    for (const event of pendingEvents.splice(0)) {
      deliverEvent(handler, event)
    }
  }
}

/** 输出或发送 emit 对应的数据或状态。 */
function emit(event: HookExecutionEvent): void {
  if (eventHandler) {
    deliverEvent(eventHandler, event)
  } else {
    pendingEvents.push(event)
    if (pendingEvents.length > MAX_PENDING_EVENTS) {
      pendingEvents.shift()
    }
  }
}

/** 判断是否满足 should Emit 对应的数据或状态。 */
function shouldEmit(hookEvent: string): boolean {
  if ((ALWAYS_EMITTED_HOOK_EVENTS as readonly string[]).includes(hookEvent)) {
    return true
  }
  return (
    allHookEventsEnabled &&
    (HOOK_EVENTS as readonly string[]).includes(hookEvent)
  )
}

/** 输出或发送 emit Hook Started 对应的数据或状态。 */
export function emitHookStarted(
  hookId: string,
  hookName: string,
  hookEvent: string,
): void {
  if (!shouldEmit(hookEvent)) return

  emit({
    type: 'started',
    hookId,
    hookName,
    hookEvent,
  })
}

/** 输出或发送 emit Hook Progress 对应的数据或状态。 */
export function emitHookProgress(data: {
  hookId: string
  hookName: string
  hookEvent: string
  stdout: string
  stderr: string
  output: string
}): void {
  if (!shouldEmit(data.hookEvent)) return

  emit({
    type: 'progress',
    ...data,
  })
}

/** 启动或启用 start Hook Progress Interval 对应的数据或状态。 */
export function startHookProgressInterval(params: {
  hookId: string
  hookName: string
  hookEvent: string
  /** 获取 get Output 对应的数据或状态。 */
  getOutput: () => Promise<{ stdout: string; stderr: string; output: string }>
  intervalMs?: number
}): () => void {
  if (!shouldEmit(params.hookEvent)) return () => {}

  let lastEmittedOutput = ''
  let stopped = false
  let requestInFlight = false
  /** 执行 interval 对应的业务处理。 */
  const interval = setInterval(() => {
    if (requestInFlight || stopped) return
    requestInFlight = true
    void params
      .getOutput()
      .then(({ stdout, stderr, output }) => {
        if (stopped || output === lastEmittedOutput) return
        lastEmittedOutput = output
        emitHookProgress({
          hookId: params.hookId,
          hookName: params.hookName,
          hookEvent: params.hookEvent,
          stdout,
          stderr,
          output,
        })
      })
      .catch(error => {
        logForDebugging(`Hook progress polling failed: ${String(error)}`, {
          level: 'error',
        })
      })
      .finally(() => {
        requestInFlight = false
      })
  }, params.intervalMs ?? 1000)
  interval.unref()

  return () => {
    stopped = true
    clearInterval(interval)
  }
}

/** 输出或发送 emit Hook Response 对应的数据或状态。 */
export function emitHookResponse(data: {
  hookId: string
  hookName: string
  hookEvent: string
  output: string
  stdout: string
  stderr: string
  exitCode?: number
  outcome: 'success' | 'error' | 'cancelled'
}): void {
  // 始终将完整挂钩输出记录到调试日志，以便进行详细模式调试
  const outputToLog = data.stdout || data.stderr || data.output
  if (outputToLog) {
    logForDebugging(
      `Hook ${data.hookName} (${data.hookEvent}) ${data.outcome}:\n${outputToLog}`,
    )
  }

  if (!shouldEmit(data.hookEvent)) return

  emit({
    type: 'response',
    ...data,
  })
}

/** 启用所有挂钩事件类型（除 SessionStart 和 Setup 之外）的发出。当设置 SDK `includeHookEvents` 选项时调用。 */
export function setAllHookEventsEnabled(enabled: boolean): void {
  allHookEventsEnabled = enabled
}

/** 删除或清理 clear Hook Event State 对应的数据或状态。 */
export function clearHookEventState(): void {
  eventHandler = null
  pendingEvents.length = 0
  allHookEventsEnabled = false
}
