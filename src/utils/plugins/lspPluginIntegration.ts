import { readFile } from 'fs/promises'
import { isAbsolute, relative, resolve } from 'path'
import { z } from 'zod/v4'
import { expandEnvVarsInString } from '../../services/mcp/envExpansion.js'
import type {
  LspServerConfig,
  ScopedLspServerConfig,
} from '../../services/lsp/types.js'
import type { LoadedPlugin, PluginError } from '../../types/plugin.js'
import { errorMessage, isENOENT } from '../errors.js'
import { jsonParse } from '../slowOperations.js'
import { getLocalPluginDataDir } from './localPluginEnvironment.js'
import { LspServerConfigSchema } from './schemas.js'

async function loadLspFile(
  plugin: LoadedPlugin,
  declaration: string,
  errors: PluginError[],
): Promise<Record<string, LspServerConfig>> {
  const root = resolve(plugin.path)
  const filePath = resolve(root, declaration)
  const rel = relative(root, filePath)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    errors.push({
      type: 'lsp-config-invalid',
      source: plugin.source,
      plugin: plugin.name,
      serverName: declaration,
      validationError: 'Path escapes plugin root',
    })
    return {}
  }
  try {
    const parsed = jsonParse(await readFile(filePath, 'utf-8'))
    const result = z
      .record(z.string(), LspServerConfigSchema())
      .safeParse(parsed)
    if (result.success) return result.data
    errors.push({
      type: 'lsp-config-invalid',
      source: plugin.source,
      plugin: plugin.name,
      serverName: declaration,
      validationError: result.error.message,
    })
  } catch (error) {
    if (!isENOENT(error) || declaration !== '.lsp.json') {
      errors.push({
        type: 'lsp-config-invalid',
        source: plugin.source,
        plugin: plugin.name,
        serverName: declaration,
        validationError: errorMessage(error),
      })
    }
  }
  return {}
}

export async function loadPluginLspServers(
  plugin: LoadedPlugin,
  errors: PluginError[] = [],
): Promise<Record<string, LspServerConfig> | undefined> {
  const servers = await loadLspFile(plugin, '.lsp.json', errors)
  const declarations = plugin.manifest.lspServers
    ? Array.isArray(plugin.manifest.lspServers)
      ? plugin.manifest.lspServers
      : [plugin.manifest.lspServers]
    : []
  for (const declaration of declarations) {
    if (typeof declaration === 'string') {
      Object.assign(servers, await loadLspFile(plugin, declaration, errors))
    } else {
      Object.assign(servers, declaration)
    }
  }
  return Object.keys(servers).length > 0 ? servers : undefined
}

function resolveLspConfig(
  config: LspServerConfig,
  plugin: LoadedPlugin,
  serverName: string,
  errors: PluginError[],
): LspServerConfig {
  const missing: string[] = []
  const resolveValue = (value: string): string => {
    const expanded = expandEnvVarsInString(
      value
        .replaceAll('${CLAUDE_PLUGIN_ROOT}', plugin.path)
        .replaceAll(
          '${CLAUDE_PLUGIN_DATA}',
          getLocalPluginDataDir(plugin.source),
        ),
    )
    missing.push(...expanded.missingVars)
    return expanded.expanded
  }
  const resolved: LspServerConfig = {
    ...config,
    command: resolveValue(config.command),
    args: config.args?.map(resolveValue),
    env: {
      CLAUDE_PLUGIN_ROOT: plugin.path,
      CLAUDE_PLUGIN_DATA: getLocalPluginDataDir(plugin.source),
      ...Object.fromEntries(
        Object.entries(config.env ?? {}).map(([key, value]) => [
          key,
          resolveValue(value),
        ]),
      ),
    },
    workspaceFolder: config.workspaceFolder
      ? resolveValue(config.workspaceFolder)
      : undefined,
  }
  if (missing.length > 0) {
    errors.push({
      type: 'lsp-config-invalid',
      source: plugin.source,
      plugin: plugin.name,
      serverName,
      validationError: `Missing environment variables: ${[...new Set(missing)].join(', ')}`,
    })
  }
  return resolved
}

export async function getPluginLspServers(
  plugin: LoadedPlugin,
  errors: PluginError[] = [],
): Promise<Record<string, ScopedLspServerConfig> | undefined> {
  if (!plugin.enabled) return undefined
  const servers = plugin.lspServers ?? (await loadPluginLspServers(plugin, errors))
  if (!servers) return undefined
  plugin.lspServers = servers
  return Object.fromEntries(
    Object.entries(servers).map(([name, config]) => [
      `plugin:${plugin.name}:${name}`,
      {
        ...resolveLspConfig(config, plugin, name, errors),
        scope: 'dynamic' as const,
        source: plugin.name,
      },
    ]),
  )
}
