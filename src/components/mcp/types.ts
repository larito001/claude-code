import type {
  ConfigScope,
  MCPServerConnection,
  McpHTTPServerConfig,
  McpSSEServerConfig,
  McpStdioServerConfig,
  McpWebSocketServerConfig,
} from '../../services/mcp/types.js'

type BaseServerInfo = {
  name: string
  client: MCPServerConnection
  scope: ConfigScope
}

export type StdioServerInfo = BaseServerInfo & {
  transport: 'stdio'
  config: McpStdioServerConfig
}

export type SSEServerInfo = BaseServerInfo & {
  transport: 'sse'
  config: McpSSEServerConfig
  isAuthenticated?: boolean
}

export type HTTPServerInfo = BaseServerInfo & {
  transport: 'http'
  config: McpHTTPServerConfig
  isAuthenticated?: boolean
}

export type WebSocketServerInfo = BaseServerInfo & {
  transport: 'ws'
  config: McpWebSocketServerConfig
}

export type ServerInfo =
  | StdioServerInfo
  | SSEServerInfo
  | HTTPServerInfo
  | WebSocketServerInfo

export type AgentMcpServerInfo = {
  name: string
  sourceAgents: string[]
  transport: 'stdio' | 'sse' | 'http' | 'ws'
  command?: string
  url?: string
  needsAuth: boolean
  isAuthenticated?: boolean
}

export type MCPViewState =
  | { type: 'list'; defaultTab?: string }
  | { type: 'server-menu'; server: ServerInfo }
  | { type: 'server-tools'; server: ServerInfo }
  | { type: 'server-tool-detail'; server: ServerInfo; toolIndex: number }
  | { type: 'agent-server-menu'; agentServer: AgentMcpServerInfo }
