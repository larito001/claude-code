import { isEnvTruthy } from 'src/utils/envUtils.js'

export const CLAUDE_AI_INFERENCE_SCOPE = 'user:inference' as const
export const CLAUDE_AI_PROFILE_SCOPE = 'user:profile' as const
export const OAUTH_BETA_HEADER = 'oauth-2025-04-20' as const

export const MCP_CLIENT_METADATA_URL =
  'https://claude.ai/oauth/claude-code-client-metadata'

type ApiConfig = {
  BASE_API_URL: string
  CLAUDE_AI_ORIGIN: string
  MCP_PROXY_URL: string
  MCP_PROXY_PATH: string
  OAUTH_FILE_SUFFIX: string
}

const PROD_CONFIG: ApiConfig = {
  BASE_API_URL: 'https://api.anthropic.com',
  CLAUDE_AI_ORIGIN: 'https://claude.ai',
  MCP_PROXY_URL: 'https://mcp-proxy.anthropic.com',
  MCP_PROXY_PATH: '/v1/mcp/{server_id}',
  OAUTH_FILE_SUFFIX: '',
}

const STAGING_CONFIG: ApiConfig = {
  BASE_API_URL: 'https://api-staging.anthropic.com',
  CLAUDE_AI_ORIGIN: 'https://claude-ai.staging.ant.dev',
  MCP_PROXY_URL: 'https://mcp-proxy-staging.anthropic.com',
  MCP_PROXY_PATH: '/v1/mcp/{server_id}',
  OAUTH_FILE_SUFFIX: '-staging-oauth',
}

const LOCAL_CONFIG: ApiConfig = {
  BASE_API_URL:
    process.env.CLAUDE_LOCAL_OAUTH_API_BASE?.replace(/\/$/, '') ??
    'http://localhost:8000',
  CLAUDE_AI_ORIGIN:
    process.env.CLAUDE_LOCAL_OAUTH_APPS_BASE?.replace(/\/$/, '') ??
    'http://localhost:4000',
  MCP_PROXY_URL: 'http://localhost:8205',
  MCP_PROXY_PATH: '/v1/toolbox/shttp/mcp/{server_id}',
  OAUTH_FILE_SUFFIX: '-local-oauth',
}

export function getOauthConfig(): ApiConfig {
  if (process.env.USER_TYPE !== 'ant') return PROD_CONFIG
  if (isEnvTruthy(process.env.USE_LOCAL_OAUTH)) return LOCAL_CONFIG
  if (isEnvTruthy(process.env.USE_STAGING_OAUTH)) return STAGING_CONFIG
  return PROD_CONFIG
}

export function fileSuffixForOauthConfig(): string {
  return getOauthConfig().OAUTH_FILE_SUFFIX
}
