import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import { HOOK_EVENTS } from 'src/entrypoints/sdk/coreTypes.js'
import type { AppState } from 'src/state/AppState.js'
import { logForDebugging } from '../debug.js'
import type { HooksSettings } from '../settings/types.js'
import { addSessionHook } from './sessionHooks.js'

/**
 * 从frontmatter（代理或技能）注册钩子到会话范围的钩子。
 * 这些钩子在会话/代理期间处于活动状态，并在会话/代理结束时清理。
 *
 * @param setAppState 用于更新应用状态的函数
 * @param sessionId 用于限定钩子范围的会话ID（代理的代理ID，技能的会话ID）
 * @param hooks 来自frontmatter的钩子设置
 * @param sourceName 用于日志记录的人类可读源名称（例如，“agent 'my-agent'”）
 * @param isAgent 如果为true，将Stop钩子转换为SubagentStop（因为子代理触发SubagentStop，而不是Stop）
 */
export function registerFrontmatterHooks(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
  hooks: HooksSettings,
  sourceName: string,
  isAgent: boolean = false,
): void {
  if (!hooks || Object.keys(hooks).length === 0) {
    return
  }

  let hookCount = 0

  for (const event of HOOK_EVENTS) {
    const matchers = hooks[event]
    if (!matchers || matchers.length === 0) {
      continue
    }

    // 对于代理，将Stop钩子转换为SubagentStop，因为代理完成时触发的是SubagentStop（当使用agentId调用executeStopHooks时，它使用SubagentStop）
    let targetEvent: HookEvent = event
    if (isAgent && event === 'Stop') {
      targetEvent = 'SubagentStop'
      logForDebugging(
        `Converting Stop hook to SubagentStop for ${sourceName} (subagents trigger SubagentStop)`,
      )
    }

    for (const matcherConfig of matchers) {
      const matcher = matcherConfig.matcher ?? ''
      const hooksArray = matcherConfig.hooks

      if (!hooksArray || hooksArray.length === 0) {
        continue
      }

      for (const hook of hooksArray) {
        addSessionHook(setAppState, sessionId, targetEvent, matcher, hook)
        hookCount++
      }
    }
  }

  if (hookCount > 0) {
    logForDebugging(
      `Registered ${hookCount} frontmatter hook(s) from ${sourceName} for session ${sessionId}`,
    )
  }
}
