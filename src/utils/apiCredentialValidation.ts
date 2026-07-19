import { getConfiguredApiKeyHelper, hasAnthropicApiKeyAuth } from './auth.js'

export type ApiCredentialSources = {
  hasApiKey: boolean
  hasApiKeyHelper: boolean
}

/** 获取 get Api Credential Configuration Error 对应的数据或状态。 */
export function getApiCredentialConfigurationError({
  hasApiKey,
  hasApiKeyHelper,
}: ApiCredentialSources): string | null {
  if (hasApiKey || hasApiKeyHelper) {
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
    hasApiKey: hasAnthropicApiKeyAuth(),
    hasApiKeyHelper: Boolean(getConfiguredApiKeyHelper()),
  })
}
