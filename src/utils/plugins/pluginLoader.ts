import { readFile, realpath } from 'fs/promises'
import memoize from 'lodash-es/memoize.js'
import { basename, isAbsolute, join, relative, resolve } from 'path'
import { getInlinePlugins } from '../../bootstrap/state.js'
import type {
  LoadedPlugin,
  PluginComponent,
  PluginError,
  PluginLoadResult,
  PluginManifest,
} from '../../types/plugin.js'
import { logForDebugging } from '../debug.js'
import { errorMessage, isFsInaccessible, toError } from '../errors.js'
import { pathExists } from '../file.js'
import { lazySchema } from '../lazySchema.js'
import { logError } from '../log.js'
import {
  clearPluginSettingsBase,
  getPluginSettingsBase,
  resetSettingsCache,
  setPluginSettingsBase,
} from '../settings/settingsCache.js'
import type { HooksSettings } from '../settings/types.js'
import { SettingsSchema } from '../settings/types.js'
import { jsonParse } from '../slowOperations.js'
import { verifyAndDemote } from './dependencyResolver.js'
import {
  type CommandMetadata,
  PluginHooksSchema,
  PluginManifestSchema,
} from './schemas.js'

export async function loadPluginManifest(
  manifestPath: string,
  fallbackName: string,
  source: string,
): Promise<PluginManifest> {
  if (!(await pathExists(manifestPath))) {
    return {
      name: fallbackName,
      description: `Local plugin from ${source}`,
    }
  }

  let parsed: unknown
  try {
    parsed = jsonParse(await readFile(manifestPath, 'utf-8'))
  } catch (error) {
    throw new Error(
      `Plugin ${fallbackName} has an unreadable manifest at ${manifestPath}: ${errorMessage(error)}`,
    )
  }

  const result = PluginManifestSchema().safeParse(parsed)
  if (!result.success) {
    const details = result.error.issues
      .map(issue => `${issue.path.join('.') || 'root'}: ${issue.message}`)
      .join(', ')
    throw new Error(`Plugin ${fallbackName} has an invalid manifest: ${details}`)
  }
  return result.data
}

function resolvePluginPath(pluginRoot: string, declaration: string): string | null {
  const resolvedRoot = resolve(pluginRoot)
  const resolvedPath = resolve(pluginRoot, declaration)
  const rel = relative(resolvedRoot, resolvedPath)
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  return resolvedPath
}

async function validatePluginPaths(
  declarations: string[],
  pluginRoot: string,
  pluginName: string,
  source: string,
  component: PluginComponent,
  errors: PluginError[],
): Promise<string[]> {
  const checks = await Promise.all(
    declarations.map(async declaration => {
      const fullPath = resolvePluginPath(pluginRoot, declaration)
      return {
        declaration,
        fullPath,
        exists: fullPath ? await pathExists(fullPath) : false,
      }
    }),
  )
  const valid: string[] = []
  for (const check of checks) {
    if (check.fullPath && check.exists) {
      valid.push(check.fullPath)
      continue
    }
    const path = check.fullPath ?? join(pluginRoot, check.declaration)
    errors.push({
      type: 'path-not-found',
      source,
      plugin: pluginName,
      path,
      component,
    })
  }
  return valid
}

async function loadPluginHooksFile(
  filePath: string,
  pluginName: string,
): Promise<HooksSettings> {
  const parsed = jsonParse(await readFile(filePath, 'utf-8'))
  const result = PluginHooksSchema().safeParse(parsed)
  if (!result.success) {
    throw new Error(
      `Invalid hooks for ${pluginName}: ${result.error.issues.map(issue => issue.message).join(', ')}`,
    )
  }
  return result.data.hooks as HooksSettings
}

function mergeHooks(
  base: HooksSettings | undefined,
  additional: HooksSettings,
): HooksSettings {
  if (!base) return additional
  const merged = { ...base }
  for (const [event, matchers] of Object.entries(additional)) {
    const key = event as keyof HooksSettings
    merged[key] = [...(merged[key] ?? []), ...matchers]
  }
  return merged
}

const PluginSettingsSchema = lazySchema(() =>
  SettingsSchema().pick({ agent: true }).strip(),
)

function parsePluginSettings(
  raw: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const result = PluginSettingsSchema().safeParse(raw)
  if (!result.success || Object.keys(result.data).length === 0) return undefined
  return result.data
}

async function loadPluginSettings(
  pluginRoot: string,
  manifest: PluginManifest,
): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = jsonParse(await readFile(join(pluginRoot, 'settings.json'), 'utf-8'))
    if (isRecord(parsed)) {
      const settings = parsePluginSettings(parsed)
      if (settings) return settings
    }
  } catch (error) {
    if (!isFsInaccessible(error)) {
      logForDebugging(
        `Failed to load settings.json for local plugin ${manifest.name}: ${errorMessage(error)}`,
        { level: 'warn' },
      )
    }
  }
  return manifest.settings ? parsePluginSettings(manifest.settings) : undefined
}

/** Assemble a local plugin from a directory supplied through --plugin-dir. */
export async function createPluginFromPath(
  pluginRoot: string,
  source: string,
  enabled: boolean,
  fallbackName: string,
  strict = true,
): Promise<{ plugin: LoadedPlugin; errors: PluginError[] }> {
  const errors: PluginError[] = []
  const manifest = await loadPluginManifest(
    join(pluginRoot, '.claude-plugin', 'plugin.json'),
    fallbackName,
    source,
  )
  const localSource = `local:${manifest.name}`
  const plugin: LoadedPlugin = {
    name: manifest.name,
    manifest,
    path: pluginRoot,
    source: localSource,
    enabled,
  }

  const [commandsExists, agentsExists, skillsExists, outputStylesExists] =
    await Promise.all([
      !manifest.commands && pathExists(join(pluginRoot, 'commands')),
      !manifest.agents && pathExists(join(pluginRoot, 'agents')),
      !manifest.skills && pathExists(join(pluginRoot, 'skills')),
      !manifest.outputStyles && pathExists(join(pluginRoot, 'output-styles')),
    ])
  if (commandsExists) plugin.commandsPath = join(pluginRoot, 'commands')
  if (agentsExists) plugin.agentsPath = join(pluginRoot, 'agents')
  if (skillsExists) plugin.skillsPath = join(pluginRoot, 'skills')
  if (outputStylesExists) {
    plugin.outputStylesPath = join(pluginRoot, 'output-styles')
  }

  if (manifest.commands) {
    if (typeof manifest.commands === 'object' && !Array.isArray(manifest.commands)) {
      const metadata: Record<string, CommandMetadata> = {}
      const paths: string[] = []
      for (const [name, command] of Object.entries(manifest.commands)) {
        if (command.content) {
          metadata[name] = command
          continue
        }
        if (!command.source) continue
        const valid = await validatePluginPaths(
          [command.source],
          pluginRoot,
          plugin.name,
          plugin.source,
          'commands',
          errors,
        )
        if (valid[0]) {
          paths.push(valid[0])
          metadata[name] = command
        }
      }
      if (paths.length > 0) plugin.commandsPaths = paths
      if (Object.keys(metadata).length > 0) plugin.commandsMetadata = metadata
    } else {
      const declarations = Array.isArray(manifest.commands)
        ? manifest.commands
        : [manifest.commands]
      plugin.commandsPaths = await validatePluginPaths(
        declarations,
        pluginRoot,
        plugin.name,
        plugin.source,
        'commands',
        errors,
      )
    }
  }

  if (manifest.agents) {
    plugin.agentsPaths = await validatePluginPaths(
      Array.isArray(manifest.agents) ? manifest.agents : [manifest.agents],
      pluginRoot,
      plugin.name,
      plugin.source,
      'agents',
      errors,
    )
  }
  if (manifest.skills) {
    plugin.skillsPaths = await validatePluginPaths(
      Array.isArray(manifest.skills) ? manifest.skills : [manifest.skills],
      pluginRoot,
      plugin.name,
      plugin.source,
      'skills',
      errors,
    )
  }
  if (manifest.outputStyles) {
    plugin.outputStylesPaths = await validatePluginPaths(
      Array.isArray(manifest.outputStyles)
        ? manifest.outputStyles
        : [manifest.outputStyles],
      pluginRoot,
      plugin.name,
      plugin.source,
      'output-styles',
      errors,
    )
  }

  let hooks: HooksSettings | undefined
  const loadedHookPaths = new Set<string>()
  const standardHooksPath = join(pluginRoot, 'hooks', 'hooks.json')
  if (await pathExists(standardHooksPath)) {
    try {
      hooks = await loadPluginHooksFile(standardHooksPath, plugin.name)
      loadedHookPaths.add(await realpath(standardHooksPath))
    } catch (error) {
      logError(toError(error))
      errors.push({
        type: 'hook-load-failed',
        source: plugin.source,
        plugin: plugin.name,
        hookPath: standardHooksPath,
        reason: errorMessage(error),
      })
    }
  }

  const hookDeclarations = manifest.hooks
    ? Array.isArray(manifest.hooks)
      ? manifest.hooks
      : [manifest.hooks]
    : []
  for (const declaration of hookDeclarations) {
    if (typeof declaration !== 'string') {
      hooks = mergeHooks(hooks, declaration as HooksSettings)
      continue
    }
    const hookPath = resolvePluginPath(pluginRoot, declaration)
    if (!hookPath || !(await pathExists(hookPath))) {
      errors.push({
        type: 'path-not-found',
        source: plugin.source,
        plugin: plugin.name,
        path: hookPath ?? join(pluginRoot, declaration),
        component: 'hooks',
      })
      continue
    }
    try {
      const normalized = await realpath(hookPath)
      if (loadedHookPaths.has(normalized)) {
        if (strict) {
          errors.push({
            type: 'hook-load-failed',
            source: plugin.source,
            plugin: plugin.name,
            hookPath,
            reason: 'Duplicate hooks file',
          })
        }
        continue
      }
      hooks = mergeHooks(hooks, await loadPluginHooksFile(hookPath, plugin.name))
      loadedHookPaths.add(normalized)
    } catch (error) {
      logError(toError(error))
      errors.push({
        type: 'hook-load-failed',
        source: plugin.source,
        plugin: plugin.name,
        hookPath,
        reason: errorMessage(error),
      })
    }
  }
  if (hooks) plugin.hooksConfig = hooks

  plugin.settings = await loadPluginSettings(pluginRoot, manifest)
  return { plugin, errors }
}

async function loadLocalPlugins(): Promise<PluginLoadResult> {
  const plugins: LoadedPlugin[] = []
  const errors: PluginError[] = []
  const seenNames = new Set<string>()

  for (const [index, configuredPath] of getInlinePlugins().entries()) {
    const pluginRoot = resolve(configuredPath)
    if (!(await pathExists(pluginRoot))) {
      errors.push({
        type: 'path-not-found',
        source: `local[${index}]`,
        path: pluginRoot,
        component: 'commands',
      })
      continue
    }
    try {
      const { plugin, errors: pluginErrors } = await createPluginFromPath(
        pluginRoot,
        `local[${index}]`,
        true,
        basename(pluginRoot),
      )
      errors.push(...pluginErrors)
      if (seenNames.has(plugin.name)) {
        errors.push({
          type: 'generic-error',
          source: plugin.source,
          plugin: plugin.name,
          error: `Duplicate local plugin name: ${plugin.name}`,
        })
        continue
      }
      seenNames.add(plugin.name)
      plugins.push(plugin)
    } catch (error) {
      errors.push({
        type: 'generic-error',
        source: `local[${index}]`,
        error: errorMessage(error),
      })
    }
  }

  const { demoted, errors: dependencyErrors } = verifyAndDemote(plugins)
  for (const plugin of plugins) {
    if (demoted.has(plugin.source)) plugin.enabled = false
  }
  errors.push(...dependencyErrors)
  const enabled = plugins.filter(plugin => plugin.enabled)
  cachePluginSettings(enabled)
  return {
    enabled,
    disabled: plugins.filter(plugin => !plugin.enabled),
    errors,
  }
}

export const loadAllPlugins = memoize(loadLocalPlugins)
export const loadAllPluginsCacheOnly = memoize(loadLocalPlugins)

export function clearPluginCache(reason?: string): void {
  if (reason) logForDebugging(`Clearing local plugin cache: ${reason}`)
  loadAllPlugins.cache.clear()
  loadAllPluginsCacheOnly.cache.clear()
  if (getPluginSettingsBase() !== undefined) resetSettingsCache()
  clearPluginSettingsBase()
}

function mergePluginSettings(
  plugins: LoadedPlugin[],
): Record<string, unknown> | undefined {
  let merged: Record<string, unknown> | undefined
  for (const plugin of plugins) {
    if (!plugin.settings) continue
    merged = { ...(merged ?? {}), ...plugin.settings }
  }
  return merged
}

export function cachePluginSettings(plugins: LoadedPlugin[]): void {
  const settings = mergePluginSettings(plugins)
  setPluginSettingsBase(settings)
  if (settings && Object.keys(settings).length > 0) resetSettingsCache()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
