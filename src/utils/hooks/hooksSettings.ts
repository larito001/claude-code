import { resolve } from 'path'
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import { getSessionId } from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppState.js'
import type { EditableSettingSource } from '../settings/constants.js'
import { SOURCES } from '../settings/constants.js'
import {
  getSettingsFilePathForSource,
  getSettingsForSource,
} from '../settings/settings.js'
import type { HookCommand, HookMatcher } from '../settings/types.js'
import { DEFAULT_HOOK_SHELL } from '../shell/shellProvider.js'
import { getSessionHooks } from './sessionHooks.js'

export type HookSource =
  | EditableSettingSource
  | 'policySettings'
  | 'pluginHook'
  | 'sessionHook'
  | 'builtinHook'

export interface IndividualHookConfig {
  event: HookEvent
  config: HookCommand
  matcher?: string
  source: HookSource
  pluginName?: string
}

/** 检查两个钩子是否相等（只比较命令/提示内容，不比较超时） */
export function isHookEqual(
  a: HookCommand | { type: 'function'; timeout?: number },
  b: HookCommand | { type: 'function'; timeout?: number },
): boolean {
  if (a.type !== b.type) return false

  // 使用 switch 进行穷举类型检查
  // 注意：我们只比较命令/提示内容，不比较超时
  // `if` 是标识的一部分：相同命令但不同 `if` 条件
  // 是不同的钩子（例如，setup.sh if=Bash(git *) 与 if=Bash(npm *)）。
  const sameIf = (x: { if?: string }, y: { if?: string }) =>
    (x.if ?? '') === (y.if ?? '')
  switch (a.type) {
    case 'command':
      // shell 是标识的一部分：相同命令字符串但不同
      // shell 是不同的钩子。默认 'bash' 所以 undefined === 'bash'。
      return (
        b.type === 'command' &&
        a.command === b.command &&
        (a.shell ?? DEFAULT_HOOK_SHELL) === (b.shell ?? DEFAULT_HOOK_SHELL) &&
        sameIf(a, b)
      )
    case 'prompt':
      return b.type === 'prompt' && a.prompt === b.prompt && sameIf(a, b)
    case 'agent':
      return b.type === 'agent' && a.prompt === b.prompt && sameIf(a, b)
    case 'http':
      return b.type === 'http' && a.url === b.url && sameIf(a, b)
    case 'function':
      // 函数钩子无法比较（没有稳定标识符）
      return false
  }
}

/** 获取钩子的显示文本 */
export function getHookDisplayText(
  hook: HookCommand | { type: 'callback' | 'function'; statusMessage?: string },
): string {
  // 如果提供了自定义状态消息则返回
  if ('statusMessage' in hook && hook.statusMessage) {
    return hook.statusMessage
  }

  switch (hook.type) {
    case 'command':
      return hook.command
    case 'prompt':
      return hook.prompt
    case 'agent':
      return hook.prompt
    case 'http':
      return hook.url
    case 'callback':
      return 'callback'
    case 'function':
      return 'function'
  }
}

/** 获取 get All Hooks 对应的数据或状态。 */
export function getAllHooks(appState: AppState): IndividualHookConfig[] {
  const hooks: IndividualHookConfig[] = []

  // 检查是否仅限于托管钩子
  const policySettings = getSettingsForSource('policySettings')
  const restrictedToManagedOnly = policySettings?.allowManagedHooksOnly === true

  // 如果设置了 allowManagedHooksOnly，不要在 UI 中显示任何钩子
  // （用户/项目/本地钩子被阻止，托管钩子被故意隐藏）
  if (!restrictedToManagedOnly) {
    // 从所有可编辑源获取钩子
    const sources = [
      'userSettings',
      'projectSettings',
      'localSettings',
    ] as EditableSettingSource[]

    // 跟踪我们已经处理过的设置文件以避免重复
    // （例如，从 home 目录运行时，userSettings 和 projectSettings
    // 都解析为 ~/.claude-code-core-framework/settings.json）
    const seenFiles = new Set<string>()

    for (const source of sources) {
      const filePath = getSettingsFilePathForSource(source)
      if (filePath) {
        const resolvedPath = resolve(filePath)
        if (seenFiles.has(resolvedPath)) {
          continue
        }
        seenFiles.add(resolvedPath)
      }

      const sourceSettings = getSettingsForSource(source)
      if (!sourceSettings?.hooks) {
        continue
      }

      for (const [event, matchers] of Object.entries(sourceSettings.hooks)) {
        for (const matcher of matchers as HookMatcher[]) {
          for (const hookCommand of matcher.hooks) {
            hooks.push({
              event: event as HookEvent,
              config: hookCommand,
              matcher: matcher.matcher,
              source,
            })
          }
        }
      }
    }
  }

  // 获取会话钩子
  const sessionId = getSessionId()
  const sessionHooks = getSessionHooks(appState, sessionId)
  for (const [event, matchers] of sessionHooks.entries()) {
    for (const matcher of matchers) {
      for (const hookCommand of matcher.hooks) {
        hooks.push({
          event,
          config: hookCommand,
          matcher: matcher.matcher,
          source: 'sessionHook',
        })
      }
    }
  }

  return hooks
}

/** 获取 get Hooks For Event 对应的数据或状态。 */
export function getHooksForEvent(
  appState: AppState,
  event: HookEvent,
): IndividualHookConfig[] {
  return getAllHooks(appState).filter(hook => hook.event === event)
}

/** 执行 hook Source Description Display String 对应的业务处理。 */
export function hookSourceDescriptionDisplayString(source: HookSource): string {
  switch (source) {
    case 'userSettings':
      return 'User settings (~/.claude-code-core-framework/settings.json)'
    case 'projectSettings':
      return 'Project settings (.claude-code-core-framework/settings.json)'
    case 'localSettings':
      return 'Local settings (.claude-code-core-framework/settings.local.json)'
    case 'pluginHook':
      // 一个插件可合并多个 hooks 文件，当前运行时只保留合并后的配置与插件名，
      // 不保留每条命令的文件来源；因此这里使用可迁移的路径模式，避免显示错误的单一路径。
      return 'Plugin hooks (~/.claude-code-core-framework/plugins/*/hooks/hooks.json)'
    case 'sessionHook':
      return 'Session hooks (in-memory, temporary)'
    case 'builtinHook':
      return 'Built-in hooks (registered internally by Claude Code)'
    default:
      return source as string
  }
}

/** 执行 hook Source Header Display String 对应的业务处理。 */
export function hookSourceHeaderDisplayString(source: HookSource): string {
  switch (source) {
    case 'userSettings':
      return 'User Settings'
    case 'projectSettings':
      return 'Project Settings'
    case 'localSettings':
      return 'Local Settings'
    case 'pluginHook':
      return 'Plugin Hooks'
    case 'sessionHook':
      return 'Session Hooks'
    case 'builtinHook':
      return 'Built-in Hooks'
    default:
      return source as string
  }
}

/** 执行 hook Source Inline Display String 对应的业务处理。 */
export function hookSourceInlineDisplayString(source: HookSource): string {
  switch (source) {
    case 'userSettings':
      return 'User'
    case 'projectSettings':
      return 'Project'
    case 'localSettings':
      return 'Local'
    case 'pluginHook':
      return 'Plugin'
    case 'sessionHook':
      return 'Session'
    case 'builtinHook':
      return 'Built-in'
    default:
      return source as string
  }
}

/** 整理 sort Matchers By Priority 对应的数据或状态。 */
export function sortMatchersByPriority(
  matchers: string[],
  hooksByEventAndMatcher: Record<
    string,
    Record<string, IndividualHookConfig[]>
  >,
  selectedEvent: HookEvent,
): string[] {
  // 基于 SOURCES 顺序创建优先级映射（索引越低优先级越高）
  const sourcePriority = SOURCES.reduce(
    (acc, source, index) => {
      acc[source] = index
      return acc
    },
    {} as Record<EditableSettingSource, number>,
  )

  return [...matchers].sort((a, b) => {
    const aHooks = hooksByEventAndMatcher[selectedEvent]?.[a] || []
    const bHooks = hooksByEventAndMatcher[selectedEvent]?.[b] || []

    const aSources = Array.from(new Set(aHooks.map(h => h.source)))
    const bSources = Array.from(new Set(bHooks.map(h => h.source)))

    // 按最高优先级源优先排序（优先级数字最低）
    // 插件钩子获得最低优先级（最高数字）
    const getSourcePriority = (source: HookSource) =>
      source === 'pluginHook' || source === 'builtinHook'
        ? 999
        : sourcePriority[source as EditableSettingSource]

    const aHighestPriority = Math.min(...aSources.map(getSourcePriority))
    const bHighestPriority = Math.min(...bSources.map(getSourcePriority))

    if (aHighestPriority !== bHighestPriority) {
      return aHighestPriority - bHighestPriority
    }

    // 如果优先级相同，按匹配器名称排序
    return a.localeCompare(b)
  })
}
