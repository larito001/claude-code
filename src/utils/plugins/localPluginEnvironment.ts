import { mkdirSync } from 'fs'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../envUtils.js'

function safePluginName(pluginId: string): string {
  return pluginId.replace(/[^a-zA-Z0-9._-]/g, '-')
}

/** Return the persistent data directory for a local plugin, creating it lazily. */
export function getLocalPluginDataDir(pluginId: string): string {
  const dir = join(
    getClaudeConfigHomeDir(),
    'plugin-data',
    safePluginName(pluginId),
  )
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Expand the two filesystem variables supported by local plugin content. */
export function substituteLocalPluginVariables(
  value: string,
  plugin: { path: string; source?: string },
): string {
  const normalize = (path: string) =>
    process.platform === 'win32' ? path.replace(/\\/g, '/') : path
  let expanded = value.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, () =>
    normalize(plugin.path),
  )
  if (plugin.source) {
    expanded = expanded.replace(/\$\{CLAUDE_PLUGIN_DATA\}/g, () =>
      normalize(getLocalPluginDataDir(plugin.source!)),
    )
  }
  return expanded
}
