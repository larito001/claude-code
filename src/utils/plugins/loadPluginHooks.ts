import memoize from 'lodash-es/memoize.js'
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import {
  clearRegisteredPluginHooks,
  registerHookCallbacks,
} from '../../bootstrap/state.js'
import type { LoadedPlugin } from '../../types/plugin.js'
import { logForDebugging } from '../debug.js'
import type { PluginHookMatcher } from '../settings/types.js'
import { loadAllPluginsCacheOnly } from './pluginLoader.js'

/**
 * Convert plugin hooks configuration to native matchers with plugin context
 */
function convertPluginHooksToMatchers(
  plugin: LoadedPlugin,
): Record<HookEvent, PluginHookMatcher[]> {
  const pluginMatchers: Record<HookEvent, PluginHookMatcher[]> = {
    PreToolUse: [],
    PostToolUse: [],
    PostToolUseFailure: [],
    PermissionDenied: [],
    Notification: [],
    UserPromptSubmit: [],
    SessionStart: [],
    SessionEnd: [],
    Stop: [],
    StopFailure: [],
    SubagentStart: [],
    SubagentStop: [],
    PreCompact: [],
    PostCompact: [],
    PermissionRequest: [],
    Setup: [],
    TeammateIdle: [],
    TaskCreated: [],
    TaskCompleted: [],
    Elicitation: [],
    ElicitationResult: [],
    ConfigChange: [],
    WorktreeCreate: [],
    WorktreeRemove: [],
    InstructionsLoaded: [],
    CwdChanged: [],
    FileChanged: [],
  }

  if (!plugin.hooksConfig) {
    return pluginMatchers
  }

  // Process each hook event - pass through all hook types with plugin context
  for (const [event, matchers] of Object.entries(plugin.hooksConfig)) {
    const hookEvent = event as HookEvent
    if (!pluginMatchers[hookEvent]) {
      continue
    }

    for (const matcher of matchers) {
      if (matcher.hooks.length > 0) {
        pluginMatchers[hookEvent].push({
          matcher: matcher.matcher,
          hooks: matcher.hooks,
          pluginRoot: plugin.path,
          pluginName: plugin.name,
          pluginId: plugin.source,
        })
      }
    }
  }

  return pluginMatchers
}

/**
 * Load and register hooks from all enabled plugins
 */
export const loadPluginHooks = memoize(async (): Promise<void> => {
  const { enabled } = await loadAllPluginsCacheOnly()
  const allPluginHooks: Record<HookEvent, PluginHookMatcher[]> = {
    PreToolUse: [],
    PostToolUse: [],
    PostToolUseFailure: [],
    PermissionDenied: [],
    Notification: [],
    UserPromptSubmit: [],
    SessionStart: [],
    SessionEnd: [],
    Stop: [],
    StopFailure: [],
    SubagentStart: [],
    SubagentStop: [],
    PreCompact: [],
    PostCompact: [],
    PermissionRequest: [],
    Setup: [],
    TeammateIdle: [],
    TaskCreated: [],
    TaskCompleted: [],
    Elicitation: [],
    ElicitationResult: [],
    ConfigChange: [],
    WorktreeCreate: [],
    WorktreeRemove: [],
    InstructionsLoaded: [],
    CwdChanged: [],
    FileChanged: [],
  }

  // Process each enabled plugin
  for (const plugin of enabled) {
    if (!plugin.hooksConfig) {
      continue
    }

    logForDebugging(`Loading hooks from plugin: ${plugin.name}`)
    const pluginMatchers = convertPluginHooksToMatchers(plugin)

    // Merge plugin hooks into the main collection
    for (const event of Object.keys(pluginMatchers) as HookEvent[]) {
      allPluginHooks[event].push(...pluginMatchers[event])
    }
  }

  // Swap the registered local-plugin hooks only after the fresh set is ready.
  clearRegisteredPluginHooks()
  registerHookCallbacks(allPluginHooks)

  const totalHooks = Object.values(allPluginHooks).reduce(
    (sum, matchers) => sum + matchers.reduce((s, m) => s + m.hooks.length, 0),
    0,
  )
  logForDebugging(
    `Registered ${totalHooks} hooks from ${enabled.length} plugins`,
  )
})

export function clearPluginHookCache(): void {
  // Keep current hooks active until the next load performs an atomic swap.
  loadPluginHooks.cache?.clear?.()
}
