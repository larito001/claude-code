import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import { HOOK_EVENTS } from 'src/entrypoints/sdk/coreTypes.js'
import type { AppState } from 'src/state/AppState.js'
import type { Message } from 'src/types/message.js'
import { logForDebugging } from '../debug.js'
import type { AggregatedHookResult } from '../hooks.js'
import type { HookCommand } from '../settings/types.js'
import { isHookEqual } from './hooksSettings.js'

type OnHookSuccess = (
  hook: HookCommand | FunctionHook,
  result: AggregatedHookResult,
) => void

/** 函数钩子回调 - 如果检查通过则返回 true，否则返回 false 以阻止 */
export type FunctionHookCallback = (
  messages: Message[],
  signal?: AbortSignal,
) => boolean | Promise<boolean>

/** 嵌入回调的函数钩子类型。仅会话作用域，无法持久化到 settings.json。 */
export type FunctionHook = {
  type: 'function'
  id?: string // 用于移除的可选唯一 ID
  timeout?: number
  callback: FunctionHookCallback
  errorMessage: string
  statusMessage?: string
}

type SessionHookMatcher = {
  matcher: string
  skillRoot?: string
  hooks: Array<{
    hook: HookCommand | FunctionHook
    onHookSuccess?: OnHookSuccess
  }>
}

export type SessionStore = {
  hooks: {
    [event in HookEvent]?: SessionHookMatcher[]
  }
}

/**
 * 使用 Map（而非 Record），因此 .set/.delete 不会改变容器的标识。变形函数会修改 Map 并返回未变的 prev，这样 store.ts 的 Object.is(next, prev) 检查就会短路，跳过监听器通知。会话钩子是每个代理运行时的临时回调，不会被反应式读取（只在查询循环中通过 getAppState() 快照获取）。与 LocalWorkflowTaskState 上的 agentControllers 模式相同。这在高并发工作流中很重要：parallel() 与 N 个 schema 模式代理会在一个同步 tick 中触发 N 次 addFunctionHook 调用。若使用 Record + spread，每次调用需要 O(N) 来复制不断增长的 map（总计 O(N²)），并触发所有约30个 store 监听器。而使用 Map：.set() 是 O(1)，返回 prev 意味着零监听器触发。
 */
export type SessionHooksState = Map<string, SessionStore>

/** 向会话添加命令或提示钩子。会话钩子是临时的、仅内存中，并在会话结束时清除。 */
export function addSessionHook(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
  event: HookEvent,
  matcher: string,
  hook: HookCommand,
  onHookSuccess?: OnHookSuccess,
  skillRoot?: string,
): void {
  addHookToSession(
    setAppState,
    sessionId,
    event,
    matcher,
    hook,
    onHookSuccess,
    skillRoot,
  )
}

/**
 * 向会话添加函数钩子。函数钩子执行内存中的 TypeScript 回调进行验证。
 * @returns 钩子 ID（用于移除）
 */
export function addFunctionHook(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
  event: HookEvent,
  matcher: string,
  callback: FunctionHookCallback,
  errorMessage: string,
  options?: {
    timeout?: number
    id?: string
  },
): string {
  const id = options?.id || `function-hook-${Date.now()}-${Math.random()}`
  const hook: FunctionHook = {
    type: 'function',
    id,
    timeout: options?.timeout || 5000,
    callback,
    errorMessage,
  }
  addHookToSession(setAppState, sessionId, event, matcher, hook)
  return id
}

/** 按 ID 从会话中移除函数钩子。 */
export function removeFunctionHook(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
  event: HookEvent,
  hookId: string,
): void {
  setAppState(prev => {
    const store = prev.sessionHooks.get(sessionId)
    if (!store) {
      return prev
    }

    const eventMatchers = store.hooks[event] || []

    // 从所有匹配器中移除具有匹配 ID 的钩子
    const updatedMatchers = eventMatchers
      .map(matcher => {
        /** 更新 updated Hooks 对应的数据或状态。 */
        const updatedHooks = matcher.hooks.filter(h => {
          if (h.hook.type !== 'function') return true
          return h.hook.id !== hookId
        })

        return updatedHooks.length > 0
          ? { ...matcher, hooks: updatedHooks }
          : null
      })
      .filter((m): m is SessionHookMatcher => m !== null)

    const newHooks =
      updatedMatchers.length > 0
        ? { ...store.hooks, [event]: updatedMatchers }
        : Object.fromEntries(
            Object.entries(store.hooks).filter(([e]) => e !== event),
          )

    prev.sessionHooks.set(sessionId, { hooks: newHooks })
    return prev
  })

  logForDebugging(
    `Removed function hook ${hookId} for event ${event} in session ${sessionId}`,
  )
}

/** 向会话状态添加钩子的内部帮助程序 */
function addHookToSession(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
  event: HookEvent,
  matcher: string,
  hook: HookCommand | FunctionHook,
  onHookSuccess?: OnHookSuccess,
  skillRoot?: string,
): void {
  setAppState(prev => {
    const store = prev.sessionHooks.get(sessionId) ?? { hooks: {} }
    const eventMatchers = store.hooks[event] || []

    // 查找现有匹配器或创建新匹配器
    const existingMatcherIndex = eventMatchers.findIndex(
      m => m.matcher === matcher && m.skillRoot === skillRoot,
    )

    let updatedMatchers: SessionHookMatcher[]
    if (existingMatcherIndex >= 0) {
      // 添加到现有匹配器
      updatedMatchers = [...eventMatchers]
      const existingMatcher = updatedMatchers[existingMatcherIndex]!
      updatedMatchers[existingMatcherIndex] = {
        matcher: existingMatcher.matcher,
        skillRoot: existingMatcher.skillRoot,
        hooks: [...existingMatcher.hooks, { hook, onHookSuccess }],
      }
    } else {
      // 创建新匹配器
      updatedMatchers = [
        ...eventMatchers,
        {
          matcher,
          skillRoot,
          hooks: [{ hook, onHookSuccess }],
        },
      ]
    }

    const newHooks = { ...store.hooks, [event]: updatedMatchers }

    prev.sessionHooks.set(sessionId, { hooks: newHooks })
    return prev
  })

  logForDebugging(
    `Added session hook for event ${event} in session ${sessionId}`,
  )
}

/**
 * 从会话中移除特定钩子
 * @param setAppState 更新应用状态的函数
 * @param sessionId 会话 ID
 * @param event 钩子事件
 * @param hook 要移除的钩子命令
 */
export function removeSessionHook(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
  event: HookEvent,
  hook: HookCommand,
): void {
  setAppState(prev => {
    const store = prev.sessionHooks.get(sessionId)
    if (!store) {
      return prev
    }

    const eventMatchers = store.hooks[event] || []

    // 从所有匹配器中移除钩子
    const updatedMatchers = eventMatchers
      .map(matcher => {
        /** 更新 updated Hooks 对应的数据或状态。 */
        const updatedHooks = matcher.hooks.filter(
          h => !isHookEqual(h.hook, hook),
        )

        return updatedHooks.length > 0
          ? { ...matcher, hooks: updatedHooks }
          : null
      })
      .filter((m): m is SessionHookMatcher => m !== null)

    const newHooks =
      updatedMatchers.length > 0
        ? { ...store.hooks, [event]: updatedMatchers }
        : { ...store.hooks }

    if (updatedMatchers.length === 0) {
      delete newHooks[event]
    }

    prev.sessionHooks.set(sessionId, { ...store, hooks: newHooks })
    return prev
  })

  logForDebugging(
    `Removed session hook for event ${event} in session ${sessionId}`,
  )
}

// 扩展的钩子匹配器，包含可选的 skillRoot 用于技能作用域的钩子
export type SessionDerivedHookMatcher = {
  matcher: string
  hooks: HookCommand[]
  skillRoot?: string
}

/**
 * 将会话钩子匹配器转换为常规钩子匹配器
 * @param sessionMatchers 要转换的会话钩子匹配器
 * @returns 常规钩子匹配器（保留可选的 skillRoot）
 */
function convertToHookMatchers(
  sessionMatchers: SessionHookMatcher[],
): SessionDerivedHookMatcher[] {
  return sessionMatchers.map(sm => ({
    matcher: sm.matcher,
    skillRoot: sm.skillRoot,
    // 过滤掉函数钩子 - 它们无法持久化为 HookMatcher 格式
    hooks: sm.hooks
      .map(h => h.hook)
      .filter((h): h is HookCommand => h.type !== 'function'),
  }))
}

/**
 * 获取特定事件的所有会话钩子（排除函数钩子）
 * @param appState 应用状态
 * @param sessionId 会话 ID
 * @param event 可选，按事件过滤
 * @returns 该事件的钩子匹配器；如果未指定事件，则返回所有钩子
 */
export function getSessionHooks(
  appState: AppState,
  sessionId: string,
  event?: HookEvent,
): Map<HookEvent, SessionDerivedHookMatcher[]> {
  const store = appState.sessionHooks.get(sessionId)
  if (!store) {
    return new Map()
  }

  const result = new Map<HookEvent, SessionDerivedHookMatcher[]>()

  if (event) {
    const sessionMatchers = store.hooks[event]
    if (sessionMatchers) {
      result.set(event, convertToHookMatchers(sessionMatchers))
    }
    return result
  }

  for (const evt of HOOK_EVENTS) {
    const sessionMatchers = store.hooks[evt]
    if (sessionMatchers) {
      result.set(evt, convertToHookMatchers(sessionMatchers))
    }
  }

  return result
}

type FunctionHookMatcher = {
  matcher: string
  hooks: FunctionHook[]
}

/**
 * 获取特定事件的所有会话函数钩子
 * 函数钩子保持独立，因为它们无法持久化为 HookMatcher 格式。
 * @param appState 应用状态
 * @param sessionId 会话 ID
 * @param event 可选，按事件过滤
 * @returns 该事件的函数钩子匹配器
 */
export function getSessionFunctionHooks(
  appState: AppState,
  sessionId: string,
  event?: HookEvent,
): Map<HookEvent, FunctionHookMatcher[]> {
  const store = appState.sessionHooks.get(sessionId)
  if (!store) {
    return new Map()
  }

  const result = new Map<HookEvent, FunctionHookMatcher[]>()

  /** 执行 extract Function Hooks 对应的业务处理。 */
  const extractFunctionHooks = (
    sessionMatchers: SessionHookMatcher[],
  ): FunctionHookMatcher[] => {
    return sessionMatchers
      .map(sm => ({
        matcher: sm.matcher,
        /** 执行 hooks 对应的业务处理。 */
        hooks: sm.hooks
          .map(h => h.hook)
          .filter((h): h is FunctionHook => h.type === 'function'),
      }))
      .filter(m => m.hooks.length > 0)
  }

  if (event) {
    const sessionMatchers = store.hooks[event]
    if (sessionMatchers) {
      const functionMatchers = extractFunctionHooks(sessionMatchers)
      if (functionMatchers.length > 0) {
        result.set(event, functionMatchers)
      }
    }
    return result
  }

  for (const evt of HOOK_EVENTS) {
    const sessionMatchers = store.hooks[evt]
    if (sessionMatchers) {
      const functionMatchers = extractFunctionHooks(sessionMatchers)
      if (functionMatchers.length > 0) {
        result.set(evt, functionMatchers)
      }
    }
  }

  return result
}

/** 获取特定会话钩子的完整钩子条目（包括回调） */
export function getSessionHookCallback(
  appState: AppState,
  sessionId: string,
  event: HookEvent,
  matcher: string,
  hook: HookCommand | FunctionHook,
):
  | {
      hook: HookCommand | FunctionHook
      onHookSuccess?: OnHookSuccess
    }
  | undefined {
  const store = appState.sessionHooks.get(sessionId)
  if (!store) {
    return undefined
  }

  const eventMatchers = store.hooks[event]
  if (!eventMatchers) {
    return undefined
  }

  // 在匹配器中查找钩子
  for (const matcherEntry of eventMatchers) {
    if (matcherEntry.matcher === matcher || matcher === '') {
      /** 执行 hook Entry 对应的业务处理。 */
      const hookEntry = matcherEntry.hooks.find(h => isHookEqual(h.hook, hook))
      if (hookEntry) {
        return hookEntry
      }
    }
  }

  return undefined
}

/**
 * 清除特定会话的所有会话钩子
 * @param setAppState 更新应用状态的函数
 * @param sessionId 会话 ID
 */
export function clearSessionHooks(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
): void {
  setAppState(prev => {
    prev.sessionHooks.delete(sessionId)
    return prev
  })

  logForDebugging(`Cleared all session hooks for session ${sessionId}`)
}
