import type { LoadedPlugin, PluginError } from '../../types/plugin.js'

/**
 * Demote local plugins whose declared dependencies are missing. Dependencies
 * are matched by manifest name because all plugins are supplied explicitly
 * through --plugin-dir and no remote installer participates in resolution.
 */
export function verifyAndDemote(plugins: readonly LoadedPlugin[]): {
  demoted: Set<string>
  errors: PluginError[]
} {
  const known = new Set(plugins.map(plugin => plugin.name))
  const enabled = new Set(
    plugins.filter(plugin => plugin.enabled).map(plugin => plugin.name),
  )
  const errors: PluginError[] = []

  let changed = true
  while (changed) {
    changed = false
    for (const plugin of plugins) {
      if (!enabled.has(plugin.name)) continue
      const missing = (plugin.manifest.dependencies ?? []).find(
        dependency => !enabled.has(dependency),
      )
      if (!missing) continue

      enabled.delete(plugin.name)
      errors.push({
        type: 'dependency-unsatisfied',
        source: plugin.source,
        plugin: plugin.name,
        dependency: missing,
        reason: known.has(missing) ? 'not-enabled' : 'not-found',
      })
      changed = true
    }
  }

  return {
    demoted: new Set(
      plugins
        .filter(plugin => plugin.enabled && !enabled.has(plugin.name))
        .map(plugin => plugin.source),
    ),
    errors,
  }
}
