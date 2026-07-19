import type { LspServerConfig } from '../services/lsp/types.js'
import type { McpServerConfig } from '../services/mcp/types.js'
import type {
  CommandMetadata,
  PluginAuthor,
  PluginManifest,
} from '../utils/plugins/schemas.js'
import type { HooksSettings } from '../utils/settings/types.js'

export type { CommandMetadata, PluginAuthor, PluginManifest }

export type LoadedPlugin = {
  name: string
  manifest: PluginManifest
  path: string
  source: string
  enabled: boolean
  commandsPath?: string
  commandsPaths?: string[]
  commandsMetadata?: Record<string, CommandMetadata>
  agentsPath?: string
  agentsPaths?: string[]
  skillsPath?: string
  skillsPaths?: string[]
  outputStylesPath?: string
  outputStylesPaths?: string[]
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

export type PluginError =
  | {
      type: 'path-not-found'
      source: string
      plugin?: string
      path: string
      component: PluginComponent
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
      type: 'dependency-unsatisfied'
      source: string
      plugin: string
      dependency: string
      reason: 'not-enabled' | 'not-found'
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

export function getPluginErrorMessage(error: PluginError): string {
  switch (error.type) {
    case 'path-not-found':
      return `Path not found: ${error.path} (${error.component})`
    case 'mcp-config-invalid':
      return `MCP server ${error.serverName} invalid: ${error.validationError}`
    case 'mcp-server-suppressed-duplicate':
      return `MCP server ${error.serverName} duplicates ${error.duplicateOf}`
    case 'lsp-config-invalid':
      return `LSP server ${error.serverName} invalid: ${error.validationError}`
    case 'hook-load-failed':
      return `Hook load failed: ${error.reason}`
    case 'dependency-unsatisfied':
      return `Dependency ${error.dependency} is ${error.reason === 'not-enabled' ? 'disabled' : 'not found'}`
    case 'generic-error':
      return error.error
  }
}
