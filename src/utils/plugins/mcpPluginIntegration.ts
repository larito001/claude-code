import { readFile } from 'fs/promises'
import { isAbsolute, relative, resolve } from 'path'
import { expandEnvVarsInString } from '../../services/mcp/envExpansion.js'
import {
  type McpServerConfig,
  McpServerConfigSchema,
  type ScopedMcpServerConfig,
} from '../../services/mcp/types.js'
import type { LoadedPlugin, PluginError } from '../../types/plugin.js'
import { logForDebugging } from '../debug.js'
import { errorMessage, isENOENT } from '../errors.js'
import { jsonParse } from '../slowOperations.js'
import { getLocalPluginDataDir } from './localPluginEnvironment.js'

function resolveLocalFile(pluginRoot: string, declaration: string): string | null {
  const root = resolve(pluginRoot)
  const file = resolve(root, declaration)
  const rel = relative(root, file)
  return rel.startsWith('..') || isAbsolute(rel) ? null : file
}

async function loadMcpFile(
  plugin: LoadedPlugin,
  declaration: string,
  errors: PluginError[],
): Promise<Record<string, McpServerConfig>> {
  const filePath = resolveLocalFile(plugin.path, declaration)
  if (!filePath) {
    errors.push({
      type: 'mcp-config-invalid',
      source: plugin.source,
      plugin: plugin.name,
      serverName: declaration,
      validationError: 'Path escapes plugin root',
    })
    return {}
  }
  try {
    const raw = jsonParse(await readFile(filePath, 'utf-8')) as unknown
    const record =
      typeof raw === 'object' && raw !== null && 'mcpServers' in raw
        ? (raw as { mcpServers: unknown }).mcpServers
        : raw
    if (typeof record !== 'object' || record === null || Array.isArray(record)) {
      throw new Error('Expected an object of MCP server configurations')
    }
    const servers: Record<string, McpServerConfig> = {}
    for (const [name, config] of Object.entries(record)) {
      const result = McpServerConfigSchema().safeParse(config)
      if (result.success) {
        servers[name] = result.data
      } else {
        errors.push({
          type: 'mcp-config-invalid',
          source: plugin.source,
          plugin: plugin.name,
          serverName: name,
          validationError: result.error.message,
        })
      }
    }
    return servers
  } catch (error) {
    if (!isENOENT(error) || declaration !== '.mcp.json') {
      errors.push({
        type: 'mcp-config-invalid',
        source: plugin.source,
        plugin: plugin.name,
        serverName: declaration,
        validationError: errorMessage(error),
      })
    }
    return {}
  }
}

export async function loadPluginMcpServers(
  plugin: LoadedPlugin,
  errors: PluginError[] = [],
): Promise<Record<string, McpServerConfig> | undefined> {
  const servers: Record<string, McpServerConfig> = {
    ...(await loadMcpFile(plugin, '.mcp.json', errors)),
  }
  const declarations = plugin.manifest.mcpServers
    ? Array.isArray(plugin.manifest.mcpServers)
      ? plugin.manifest.mcpServers
      : [plugin.manifest.mcpServers]
    : []
  for (const declaration of declarations) {
    if (typeof declaration === 'string') {
      Object.assign(servers, await loadMcpFile(plugin, declaration, errors))
    } else {
      Object.assign(servers, declaration)
    }
  }
  return Object.keys(servers).length > 0 ? servers : undefined
}

function resolvePluginValue(
  value: string,
  plugin: LoadedPlugin,
  missing: string[],
): string {
  const withPluginPaths = value
    .replaceAll('${CLAUDE_PLUGIN_ROOT}', plugin.path)
    .replaceAll('${CLAUDE_PLUGIN_DATA}', getLocalPluginDataDir(plugin.source))
  const expanded = expandEnvVarsInString(withPluginPaths)
  missing.push(...expanded.missingVars)
  return expanded.expanded
}

function resolvePluginMcpEnvironment(
  config: McpServerConfig,
  plugin: LoadedPlugin,
  errors: PluginError[],
  serverName: string,
): McpServerConfig {
  const missing: string[] = []
  const resolveValue = (value: string) =>
    resolvePluginValue(value, plugin, missing)
  let resolved: McpServerConfig
  switch (config.type) {
    case undefined:
    case 'stdio': {
      resolved = {
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
      }
      break
    }
    case 'sse':
    case 'http':
    case 'ws':
      resolved = {
        ...config,
        url: resolveValue(config.url),
        headers: config.headers
          ? Object.fromEntries(
              Object.entries(config.headers).map(([key, value]) => [
                key,
                resolveValue(value),
              ]),
            )
          : undefined,
      }
      break
    default:
      resolved = config
  }
  if (missing.length > 0) {
    errors.push({
      type: 'mcp-config-invalid',
      source: plugin.source,
      plugin: plugin.name,
      serverName,
      validationError: `Missing environment variables: ${[...new Set(missing)].join(', ')}`,
    })
  }
  return resolved
}

export async function getPluginMcpServers(
  plugin: LoadedPlugin,
  errors: PluginError[] = [],
): Promise<Record<string, ScopedMcpServerConfig> | undefined> {
  if (!plugin.enabled) return undefined
  const servers = plugin.mcpServers ?? (await loadPluginMcpServers(plugin, errors))
  if (!servers) return undefined
  plugin.mcpServers = servers
  const scoped: Record<string, ScopedMcpServerConfig> = {}
  for (const [name, config] of Object.entries(servers)) {
    try {
      scoped[`plugin:${plugin.name}:${name}`] = {
        ...resolvePluginMcpEnvironment(config, plugin, errors, name),
        scope: 'dynamic',
        pluginSource: plugin.source,
      }
    } catch (error) {
      logForDebugging(
        `Failed to resolve MCP server ${name} from local plugin ${plugin.name}: ${errorMessage(error)}`,
        { level: 'error' },
      )
    }
  }
  return Object.keys(scoped).length > 0 ? scoped : undefined
}
