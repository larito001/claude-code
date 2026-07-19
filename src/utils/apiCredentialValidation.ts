import { getConfiguredApiKeyHelper, hasAnthropicApiKeyAuth } from './auth.js'
import {
  getAPIProvider,
  type APIProvider,
} from './model/providers.js'

export type ApiCredentialSources = {
  provider: APIProvider
  hasApiKey: boolean
  hasApiKeyHelper: boolean
}

/** 获取 get Api Credential Configuration Error 对应的数据或状态。 */
export function getApiCredentialConfigurationError({
  provider,
  hasApiKey,
  hasApiKeyHelper,
}: ApiCredentialSources): string | null {
  if (provider !== 'firstParty' || hasApiKey || hasApiKeyHelper) {
    return null
  }

  return (
    'No API key configured. Set ANTHROPIC_API_KEY, or set ' +
    'DEEPSEEK_API_KEY when using the bundled DeepSeek-compatible setup. ' +
    'You can also configure apiKeyHelper through --settings.'
  )
}

/** 获取 get Current Api Credential Configuration Error 对应的数据或状态。 */
export function getCurrentApiCredentialConfigurationError(): string | null {
  return getApiCredentialConfigurationError({
    provider: getAPIProvider(),
    hasApiKey: hasAnthropicApiKeyAuth(),
    hasApiKeyHelper: Boolean(getConfiguredApiKeyHelper()),
  })
}
