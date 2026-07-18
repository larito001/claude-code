export type McpOAuthDiscoveryState = {
  authorizationServerUrl: string
  resourceMetadataUrl?: string
}

export type McpOAuthCredential = {
  serverName: string
  serverUrl: string
  accessToken: string
  refreshToken?: string
  expiresAt: number
  scope?: string
  clientId?: string
  clientSecret?: string
  stepUpScope?: string
  discoveryState?: McpOAuthDiscoveryState
}

export type SecureStorageData = {
  mcpOAuth?: Record<string, McpOAuthCredential>
  mcpOAuthClientConfig?: Record<string, { clientSecret?: string }>
}

export type SecureStorage = {
  name: string
  read(): SecureStorageData | null
  readAsync(): Promise<SecureStorageData | null>
  update(data: SecureStorageData): { success: boolean; warning?: string }
  delete(): boolean
}
