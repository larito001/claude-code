import { HOOK_EVENTS } from 'src/entrypoints/sdk/coreTypes.js'
import type { AppState } from 'src/state/AppState.js'
import { logForDebugging } from '../debug.js'
import type { HooksSettings } from '../settings/types.js'
import { addSessionHook, removeSessionHook } from './sessionHooks.js'

/**
 * 从技能的 frontmatter 中注册钩子作为会话钩子。
 *
 * 钩子被注册为会话范围的钩子，持续整个会话期间。如果钩子具有 `once: true`，则在首次成功执行后会自动移除。
 *
 * @param setAppState - 更新应用状态的函数
 * @param sessionId - 当前会话 ID
 * @param hooks - 来自技能 frontmatter 的钩子设置
 * @param skillName - 技能名称（用于日志记录）
 * @param skillRoot - 技能的基础目录（用于 CLAUDE_PLUGIN_ROOT 环境变量）
 */
export function registerSkillHooks(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
  hooks: HooksSettings,
  skillName: string,
  skillRoot?: string,
): void {
  let registeredCount = 0

  for (const eventName of HOOK_EVENTS) {
    const matchers = hooks[eventName]
    if (!matchers) continue

    for (const matcher of matchers) {
      for (const hook of matcher.hooks) {
        // 对于 `once: true` 的钩子，使用 onHookSuccess 回调在执行后移除
        const onHookSuccess = hook.once
          ? () => {
              logForDebugging(
                `Removing one-shot hook for event ${eventName} in skill '${skillName}'`,
              )
              removeSessionHook(setAppState, sessionId, eventName, hook)
            }
          : undefined

        addSessionHook(
          setAppState,
          sessionId,
          eventName,
          matcher.matcher || '',
          hook,
          onHookSuccess,
          skillRoot,
        )
        registeredCount++
      }
    }
  }

  if (registeredCount > 0) {
    logForDebugging(
      `Registered ${registeredCount} hooks from skill '${skillName}'`,
    )
  }
}
