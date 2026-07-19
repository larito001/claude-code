/**
 * 检查当前基础地址是否为 Anthropic 官方 API。
 * 未配置地址时由 SDK 使用官方默认端点。
 */
export function isFirstPartyAnthropicBaseUrl(): boolean {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) return true

  try {
    return new URL(baseUrl).host === 'api.anthropic.com'
  } catch {
    return false
  }
}
