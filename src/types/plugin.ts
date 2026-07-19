import type { LspServerConfig } from '../services/lsp/types.js'
import type { McpServerConfig } from '../services/mcp/types.js'
import type { BundledSkillDefinition } from '../skills/bundledSkills.js'
import type {
  CommandMetadata,
  PluginAuthor,
  PluginManifest,
} from '../utils/plugins/schemas.js'
import type { HooksSettings } from '../utils/settings/types.js'

export type { PluginAuthor, PluginManifest, CommandMetadata }

/**
 * CLI 自带内置插件的定义。
 * 内置插件出现在 /plugin UI 中，用户可启用/禁用（持久化到用户设置）。
 */
export type BuiltinPluginDefinition = {
  /** 插件名称（用于 `{name}@builtin` 标识符） */
  name: string
  /** 在 /plugin UI 中显示的描述 */
  description: string
  /** 可选的版本字符串 */
  version?: string
  /** 此插件提供的技能 */
  skills?: BundledSkillDefinition[]
  /** 此插件提供的钩子 */
  hooks?: HooksSettings
  /** 此插件提供的 MCP 服务器 */
  mcpServers?: Record<string, McpServerConfig>
  /** 此插件是否可用（例如基于系统能力）。不可用的插件将被完全隐藏。 */
  isAvailable?: () => boolean
  /** 用户设置偏好前的默认启用状态（默认为 true） */
  defaultEnabled?: boolean
}

export type PluginRepository = {
  url: string
  branch: string
  lastUpdated?: string
  commitSha?: string
}

export type PluginConfig = {
  repositories: Record<string, PluginRepository>
}

export type LoadedPlugin = {
  name: string
  manifest: PluginManifest
  path: string
  source: string
  repository: string // 仓库标识符，通常与源相同
  enabled?: boolean
  isBuiltin?: boolean // 对于 CLI 自带的内置插件为 true
  sha?: string // 用于版本固定的 Git 提交 SHA（来自市场条目源）
  commandsPath?: string
  commandsPaths?: string[] // 来自清单的附加命令路径
  commandsMetadata?: Record<string, CommandMetadata> // 来自对象映射格式的命名命令的元数据
  agentsPath?: string
  agentsPaths?: string[] // 来自清单的附加代理路径
  skillsPath?: string
  skillsPaths?: string[] // 来自清单的附加技能路径
  outputStylesPath?: string
  outputStylesPaths?: string[] // 来自清单的附加输出样式路径
  hooksConfig?: HooksSettings
  mcpServers?: Record<string, McpServerConfig>
  lspServers?: Record<string, LspServerConfig>
  settings?: Record<string, unknown>
}

export type PluginComponent =
  | 'commands'
  | 'agents'
  | 'skills'
  | 'hooks'
  | 'output-styles'

/**
 * 插件错误类型的可区分联合。
 * 每个错误类型都有特定的上下文数据，以便更好地调试和用户指导。
 *
 * 这取代了以前基于字符串的错误匹配方法，采用类型安全的错误处理，在错误消息改变时不会中断。
 *
 * 实现状态：
 * 当前在生产中使用（2 种类型）：
 * - generic-error：用于各种插件加载失败
 * - plugin-not-found：在市场中没有找到插件时使用
 *
 * 计划将来使用（10 种类型——参见 pluginLoader.ts 中的 TODO）：
 * - path-not-found, git-auth-failed, git-timeout, network-error
 * - manifest-parse-error, manifest-validation-error
 * - marketplace-not-found, marketplace-load-failed
 * - mcp-config-invalid, hook-load-failed, component-load-failed
 *
 * 这些未使用的类型支持 UI 格式化，并提供了提高错误特异性的清晰路线图。它们可以随着错误创建点的重构而逐步实施。
 */
export type PluginError =
  | {
      type: 'path-not-found'
      source: string
      plugin?: string
      path: string
      component: PluginComponent
    }
  | {
      type: 'git-auth-failed'
      source: string
      plugin?: string
      gitUrl: string
      authType: 'ssh' | 'https'
    }
  | {
      type: 'git-timeout'
      source: string
      plugin?: string
      gitUrl: string
      operation: 'clone' | 'pull'
    }
  | {
      type: 'network-error'
      source: string
      plugin?: string
      url: string
      details?: string
    }
  | {
      type: 'manifest-parse-error'
      source: string
      plugin?: string
      manifestPath: string
      parseError: string
    }
  | {
      type: 'manifest-validation-error'
      source: string
      plugin?: string
      manifestPath: string
      validationErrors: string[]
    }
  | {
      type: 'plugin-not-found'
      source: string
      pluginId: string
      marketplace: string
    }
  | {
      type: 'marketplace-not-found'
      source: string
      marketplace: string
      availableMarketplaces: string[]
    }
  | {
      type: 'marketplace-load-failed'
      source: string
      marketplace: string
      reason: string
    }
  | {
      type: 'mcp-config-invalid'
      source: string
      plugin: string
      serverName: string
      validationError: string
    }
  | {
      type: 'mcp-server-suppressed-duplicate'
      source: string
      plugin: string
      serverName: string
      duplicateOf: string
    }
  | {
      type: 'lsp-config-invalid'
      source: string
      plugin: string
      serverName: string
      validationError: string
    }
  | {
      type: 'hook-load-failed'
      source: string
      plugin: string
      hookPath: string
      reason: string
    }
  | {
      type: 'component-load-failed'
      source: string
      plugin: string
      component: PluginComponent
      path: string
      reason: string
    }
  | {
      type: 'mcpb-download-failed'
      source: string
      plugin: string
      url: string
      reason: string
    }
  | {
      type: 'mcpb-extract-failed'
      source: string
      plugin: string
      mcpbPath: string
      reason: string
    }
  | {
      type: 'mcpb-invalid-manifest'
      source: string
      plugin: string
      mcpbPath: string
      validationError: string
    }
  | {
      type: 'lsp-config-invalid'
      source: string
      plugin: string
      serverName: string
      validationError: string
    }
  | {
      type: 'lsp-server-start-failed'
      source: string
      plugin: string
      serverName: string
      reason: string
    }
  | {
      type: 'lsp-server-crashed'
      source: string
      plugin: string
      serverName: string
      exitCode: number | null
      signal?: string
    }
  | {
      type: 'lsp-request-timeout'
      source: string
      plugin: string
      serverName: string
      method: string
      timeoutMs: number
    }
  | {
      type: 'lsp-request-failed'
      source: string
      plugin: string
      serverName: string
      method: string
      error: string
    }
  | {
      type: 'marketplace-blocked-by-policy'
      source: string
      plugin?: string
      marketplace: string
      blockedByBlocklist?: boolean // 如果被 blockedMarketplaces 阻止则为 true，如果不在 strictKnownMarketplaces 中则为 false
      allowedSources: string[] // 格式化的源字符串（例如 "github:owner/repo"）
    }
  | {
      type: 'dependency-unsatisfied'
      source: string
      plugin: string
      dependency: string
      reason: 'not-enabled' | 'not-found'
    }
  | {
      type: 'plugin-cache-miss'
      source: string
      plugin: string
      installPath: string
    }
  | {
      type: 'generic-error'
      source: string
      plugin?: string
      error: string
    }

export type PluginLoadResult = {
  enabled: LoadedPlugin[]
  disabled: LoadedPlugin[]
  errors: PluginError[]
}

/**
 * 从任何 PluginError 获取显示消息的辅助函数
 * 适用于日志记录和简单错误显示
 */
export function getPluginErrorMessage(error: PluginError): string {
  switch (error.type) {
    case 'generic-error':
      return error.error
    case 'path-not-found':
      return `Path not found: ${error.path} (${error.component})`
    case 'git-auth-failed':
      return `Git authentication failed (${error.authType}): ${error.gitUrl}`
    case 'git-timeout':
      return `Git ${error.operation} timeout: ${error.gitUrl}`
    case 'network-error':
      return `Network error: ${error.url}${error.details ? ` - ${error.details}` : ''}`
    case 'manifest-parse-error':
      return `Manifest parse error: ${error.parseError}`
    case 'manifest-validation-error':
      return `Manifest validation failed: ${error.validationErrors.join(', ')}`
    case 'plugin-not-found':
      return `Plugin ${error.pluginId} not found in marketplace ${error.marketplace}`
    case 'marketplace-not-found':
      return `Marketplace ${error.marketplace} not found`
    case 'marketplace-load-failed':
      return `Marketplace ${error.marketplace} failed to load: ${error.reason}`
    case 'mcp-config-invalid':
      return `MCP server ${error.serverName} invalid: ${error.validationError}`
    case 'mcp-server-suppressed-duplicate': {
      const dup = error.duplicateOf.startsWith('plugin:')
        ? `server provided by plugin "${error.duplicateOf.split(':')[1] ?? '?'}"`
        : `already-configured "${error.duplicateOf}"`
      return `MCP server "${error.serverName}" skipped — same command/URL as ${dup}`
    }
    case 'hook-load-failed':
      return `Hook load failed: ${error.reason}`
    case 'component-load-failed':
      return `${error.component} load failed from ${error.path}: ${error.reason}`
    case 'mcpb-download-failed':
      return `Failed to download MCPB from ${error.url}: ${error.reason}`
    case 'mcpb-extract-failed':
      return `Failed to extract MCPB ${error.mcpbPath}: ${error.reason}`
    case 'mcpb-invalid-manifest':
      return `MCPB manifest invalid at ${error.mcpbPath}: ${error.validationError}`
    case 'lsp-config-invalid':
      return `Plugin "${error.plugin}" has invalid LSP server config for "${error.serverName}": ${error.validationError}`
    case 'lsp-server-start-failed':
      return `Plugin "${error.plugin}" failed to start LSP server "${error.serverName}": ${error.reason}`
    case 'lsp-server-crashed':
      if (error.signal) {
        return `Plugin "${error.plugin}" LSP server "${error.serverName}" crashed with signal ${error.signal}`
      }
      return `Plugin "${error.plugin}" LSP server "${error.serverName}" crashed with exit code ${error.exitCode ?? 'unknown'}`
    case 'lsp-request-timeout':
      return `Plugin "${error.plugin}" LSP server "${error.serverName}" timed out on ${error.method} request after ${error.timeoutMs}ms`
    case 'lsp-request-failed':
      return `Plugin "${error.plugin}" LSP server "${error.serverName}" ${error.method} request failed: ${error.error}`
    case 'marketplace-blocked-by-policy':
      if (error.blockedByBlocklist) {
        return `Marketplace '${error.marketplace}' is blocked by enterprise policy`
      }
      return `Marketplace '${error.marketplace}' is not in the allowed marketplace list`
    case 'dependency-unsatisfied': {
      const hint =
        error.reason === 'not-enabled'
          ? 'disabled — enable it or remove the dependency'
          : 'not found in any configured marketplace'
      return `Dependency "${error.dependency}" is ${hint}`
    }
    case 'plugin-cache-miss':
      return `Plugin "${error.plugin}" not cached at ${error.installPath} — run /plugins to refresh`
  }
}
