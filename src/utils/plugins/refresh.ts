import { getOriginalCwd } from '../../bootstrap/state.js'
import { clearCommandsCache, type Command } from '../../commands.js'
import { reinitializeLspServerManager } from '../../services/lsp/manager.js'
import type { AppState } from '../../state/AppState.js'
import {
  clearAgentDefinitionsCache,
  getAgentDefinitionsWithOverrides,
  type AgentDefinitionsResult,
} from '../../tools/AgentTool/loadAgentsDir.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import { clearOutputStyleCaches } from '../../outputStyles/loadOutputStylesDir.js'
import { clearPluginAgentCache } from './loadPluginAgents.js'
import {
  clearPluginCommandCache,
  clearPluginSkillsCache,
  getPluginCommands,
} from './loadPluginCommands.js'
import { clearPluginHookCache, loadPluginHooks } from './loadPluginHooks.js'
import { clearPluginOutputStyleCache } from './loadPluginOutputStyles.js'
import { loadPluginLspServers } from './lspPluginIntegration.js'
import { loadPluginMcpServers } from './mcpPluginIntegration.js'
import { clearPluginCache, loadAllPlugins } from './pluginLoader.js'

type SetAppState = (updater: (previous: AppState) => AppState) => void

export type RefreshActivePluginsResult = {
  enabled_count: number
  disabled_count: number
  command_count: number
  agent_count: number
  hook_count: number
  mcp_count: number
  lsp_count: number
  error_count: number
  agentDefinitions: AgentDefinitionsResult
  pluginCommands: Command[]
}

function clearLocalPluginCaches(): void {
  clearPluginCache('local plugin reload')
  clearPluginCommandCache()
  clearPluginSkillsCache()
  clearPluginAgentCache()
  clearPluginHookCache()
  clearPluginOutputStyleCache()
  clearCommandsCache()
  clearAgentDefinitionsCache()
  clearOutputStyleCaches()
}

export async function refreshActivePlugins(
  setAppState: SetAppState,
): Promise<RefreshActivePluginsResult> {
  clearLocalPluginCaches()
  const pluginResult = await loadAllPlugins()
  const [pluginCommands, agentDefinitions] = await Promise.all([
    getPluginCommands(),
    getAgentDefinitionsWithOverrides(getOriginalCwd()),
  ])
  const { enabled, disabled, errors } = pluginResult
  const [mcpCounts, lspCounts] = await Promise.all([
    Promise.all(
      enabled.map(async plugin => {
        const servers = await loadPluginMcpServers(plugin, errors)
        if (servers) plugin.mcpServers = servers
        return servers ? Object.keys(servers).length : 0
      }),
    ),
    Promise.all(
      enabled.map(async plugin => {
        const servers = await loadPluginLspServers(plugin, errors)
        if (servers) plugin.lspServers = servers
        return servers ? Object.keys(servers).length : 0
      }),
    ),
  ])

  setAppState(previous => ({
    ...previous,
    plugins: {
      ...previous.plugins,
      enabled,
      disabled,
      commands: pluginCommands,
      errors,
    },
    agentDefinitions,
    mcp: {
      ...previous.mcp,
      pluginReconnectKey: previous.mcp.pluginReconnectKey + 1,
    },
  }))
  reinitializeLspServerManager()

  let hookLoadFailed = false
  try {
    await loadPluginHooks()
  } catch (error) {
    hookLoadFailed = true
    logForDebugging(`Local plugin hook reload failed: ${errorMessage(error)}`, {
      level: 'error',
    })
  }
  const hookCount = enabled.reduce(
    (sum, plugin) =>
      sum +
      Object.values(plugin.hooksConfig ?? {}).reduce(
        (eventSum, matchers) =>
          eventSum +
          (matchers?.reduce(
            (matcherSum, matcher) => matcherSum + matcher.hooks.length,
            0,
          ) ?? 0),
        0,
      ),
    0,
  )
  return {
    enabled_count: enabled.length,
    disabled_count: disabled.length,
    command_count: pluginCommands.length,
    agent_count: agentDefinitions.allAgents.length,
    hook_count: hookCount,
    mcp_count: mcpCounts.reduce((sum, count) => sum + count, 0),
    lsp_count: lspCounts.reduce((sum, count) => sum + count, 0),
    error_count: errors.length + (hookLoadFailed ? 1 : 0),
    agentDefinitions,
    pluginCommands,
  }
}
