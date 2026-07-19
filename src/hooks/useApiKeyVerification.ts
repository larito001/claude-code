import { useCallback, useState } from 'react'
import { verifyApiKey } from '../services/api/claude.js'
import { getAnthropicApiKeyWithSource, getApiKeyFromApiKeyHelper } from '../utils/auth.js'

export type VerificationStatus =
  | 'loading'
  | 'valid'
  | 'invalid'
  | 'missing'
  | 'error'

export type ApiKeyVerificationResult = {
  status: VerificationStatus
  /** 执行 reverify 对应的业务处理。 */
  reverify: () => Promise<void>
  error: Error | null
}

/** 管理 use Api Key Verification 对应的数据或状态。 */
export function useApiKeyVerification(): ApiKeyVerificationResult {
  /** 执行 [status, set Status] 对应的业务处理。 */
  const [status, setStatus] = useState<VerificationStatus>(() => {
    // 使用 skipRetrievingKeyFromApiKeyHelper 来避免在信任对话框显示前执行 apiKeyHelper（安全：防止通过 settings.json 进行 RCE）
    const { key, source } = getAnthropicApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true,
    })
    // 如果 apiKeyHelper 已配置，即使我们尚未执行它，我们也有一个密钥源 - 返回 'loading' 表示后续会验证
    if (key || source === 'apiKeyHelper') {
      return 'loading'
    }
    return 'missing'
  })
  const [error, setError] = useState<Error | null>(null)

  /** 校验 verify 对应的数据或状态。 */
  const verify = useCallback(async (): Promise<void> => {
    // 预热 apiKeyHelper 缓存（如果未配置则无操作），然后从所有源读取。getAnthropicApiKeyWithSource() 读取现已温暖的缓存。
    await getApiKeyFromApiKeyHelper()
    const { key: apiKey, source } = getAnthropicApiKeyWithSource()
    if (!apiKey) {
      if (source === 'apiKeyHelper') {
        setStatus('error')
        setError(new Error('API key helper did not return a valid key'))
        return
      }
      const newStatus = 'missing'
      setStatus(newStatus)
      return
    }

    try {
      const isValid = await verifyApiKey(apiKey, false)
      const newStatus = isValid ? 'valid' : 'invalid'
      setStatus(newStatus)
      return
    } catch (error) {
      // 当 API 返回错误响应但不是无效 API 密钥错误时发生。在这种情况下，我们仍然将 API 密钥标记为无效 - 但同时记录错误，以便向用户显示更友好的信息
      setError(error as Error)
      const newStatus = 'error'
      setStatus(newStatus)
      return
    }
  }, [])

  return {
    status,
    reverify: verify,
    error,
  }
}
