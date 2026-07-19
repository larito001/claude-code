import type { APIError } from '@anthropic-ai/sdk'

// 来自 OpenSSL 的 SSL/TLS 错误码（Node.js 和 Bun 均使用）
// 参见：https://www.openssl.org/docs/man3.1/man3/X509_STORE_CTX_get_error.html
const SSL_ERROR_CODES = new Set([
  // 证书验证错误
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_SIGNATURE_FAILURE',
  'CERT_NOT_YET_VALID',
  'CERT_HAS_EXPIRED',
  'CERT_REVOKED',
  'CERT_REJECTED',
  'CERT_UNTRUSTED',
  // 自签名证书错误
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  // 证书链错误
  'CERT_CHAIN_TOO_LONG',
  'PATH_LENGTH_EXCEEDED',
  // 主机名/备用名称错误
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'HOSTNAME_MISMATCH',
  // TLS 握手错误
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC',
])

export type ConnectionErrorDetails = {
  code: string
  message: string
  isSSLError: boolean
}

/**
 * 从错误原因链中提取连接错误详情。
 * Anthropic SDK 将底层错误包装在 `cause` 属性中。
 * 此函数遍历原因链以查找根错误代码/消息。
 */
export function extractConnectionErrorDetails(
  error: unknown,
): ConnectionErrorDetails | null {
  if (!error || typeof error !== 'object') {
    return null
  }

  // 遍历原因链以查找带代码的根错误
  let current: unknown = error
  const maxDepth = 5 // 防止无限循环
  let depth = 0

  while (current && depth < maxDepth) {
    if (
      current instanceof Error &&
      'code' in current &&
      typeof current.code === 'string'
    ) {
      const code = current.code
      const isSSLError = SSL_ERROR_CODES.has(code)
      return {
        code,
        message: current.message,
        isSSLError,
      }
    }

    // 移动到链中的下一个原因
    if (
      current instanceof Error &&
      'cause' in current &&
      current.cause !== current
    ) {
      current = current.cause
      depth++
    } else {
      break
    }
  }

  return null
}

/**
 * 返回针对 SSL/TLS 错误的可操作提示，适用于主 API 客户端之外的上下文（MCP 令牌交换、预检连接检查），在这些场景中 `formatAPIError` 不适用。
 *
 * 动机：位于 TLS 拦截代理（Zscaler 等）后的企业用户，在浏览器中看到 MCP 授权完成，但令牌交换失败并显示原始 SSL 代码。展示可能的修复方案可节省一轮支持沟通。
 */
export function getSSLErrorHint(error: unknown): string | null {
  const details = extractConnectionErrorDetails(error)
  if (!details?.isSSLError) {
    return null
  }
  return `SSL certificate error (${details.code}). If you are behind a corporate proxy or TLS-intercepting firewall, set NODE_EXTRA_CA_CERTS to your CA bundle path, or ask IT to allowlist *.anthropic.com. Run /doctor for details.`
}

/** 从消息字符串中去除 HTML 内容（例如 CloudFlare 错误页面），如果检测到 HTML，则返回用户友好的标题或空字符串。如果未找到 HTML，则返回原始消息不变。 */
function sanitizeMessageHTML(message: string): string {
  if (message.includes('<!DOCTYPE html') || message.includes('<html')) {
    const titleMatch = message.match(/<title>([^<]+)<\/title>/)
    if (titleMatch && titleMatch[1]) {
      return titleMatch[1].trim()
    }
    return ''
  }
  return message
}

/** 检测错误消息是否包含 HTML 内容（例如 CloudFlare 错误页面），并返回用户友好的替代消息 */
export function sanitizeAPIError(apiError: APIError): string {
  const message = apiError.message
  if (!message) {
    // 从 JSONL 恢复的旧错误或第三方提供商错误可能没有标准 message 字段；
    // 下方的嵌套错误解析会在调用链的后续阶段尝试提取可用信息。
    return ''
  }
  return sanitizeMessageHTML(message)
}

/**
 * 来自会话 JSONL 的反序列化 API 错误的结构。
 *
 * 经过 JSON 往返后，SDK 的 APIError 丢失了其 `.message` 属性。
 * 实际消息位于不同的嵌套层级，具体取决于提供商：
 *
 * - Bedrock/代理：`{ error: { message: "..." } }`
 * - 标准 Anthropic API：`{ error: { error: { message: "..." } } }`
 *   （外层的 `.error` 是响应体，内层的 `.error` 是 API 错误）
 *
 * 另请参阅：`logging.ts` 中的 `getErrorMessage`，它处理相同的结构。
 */
type NestedAPIError = {
  error?: {
    message?: string
    error?: { message?: string }
  }
}

/** 判断是否满足 has Nested Error 对应的数据或状态。 */
function hasNestedError(value: unknown): value is NestedAPIError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof value.error === 'object' &&
    value.error !== null
  )
}

/**
 * 从缺少顶层 `.message` 的反序列化 API 错误中提取人类可读的消息。
 *
 * 检查两个嵌套层级（先深后浅以获取特异性）：
 * 1. `error.error.error.message` — 标准 Anthropic API 结构
 * 2. `error.error.message` — Bedrock 结构
 */
function extractNestedErrorMessage(error: APIError): string | null {
  if (!hasNestedError(error)) {
    return null
  }

  // 通过缩小类型访问 `.error`，使 TypeScript 看到嵌套结构，而不是 SDK 的 `Object | undefined`。
  const narrowed: NestedAPIError = error
  const nested = narrowed.error

  // 标准 Anthropic API 结构：{ error: { error: { message } } }
  const deepMsg = nested?.error?.message
  if (typeof deepMsg === 'string' && deepMsg.length > 0) {
    const sanitized = sanitizeMessageHTML(deepMsg)
    if (sanitized.length > 0) {
      return sanitized
    }
  }

  // Bedrock 结构：{ error: { message } }
  const msg = nested?.message
  if (typeof msg === 'string' && msg.length > 0) {
    const sanitized = sanitizeMessageHTML(msg)
    if (sanitized.length > 0) {
      return sanitized
    }
  }

  return null
}

/** 格式化 format API Error 对应的数据或状态。 */
export function formatAPIError(error: APIError): string {
  // 从原因链中提取连接错误详情
  const connectionDetails = extractConnectionErrorDetails(error)

  if (connectionDetails) {
    const { code, isSSLError } = connectionDetails

    // 处理超时错误
    if (code === 'ETIMEDOUT') {
      return 'Request timed out. Check your internet connection and proxy settings'
    }

    // 处理带有特定消息的 SSL/TLS 错误
    if (isSSLError) {
      switch (code) {
        case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
        case 'UNABLE_TO_GET_ISSUER_CERT':
        case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
          return 'Unable to connect to API: SSL certificate verification failed. Check your proxy or corporate SSL certificates'
        case 'CERT_HAS_EXPIRED':
          return 'Unable to connect to API: SSL certificate has expired'
        case 'CERT_REVOKED':
          return 'Unable to connect to API: SSL certificate has been revoked'
        case 'DEPTH_ZERO_SELF_SIGNED_CERT':
        case 'SELF_SIGNED_CERT_IN_CHAIN':
          return 'Unable to connect to API: Self-signed certificate detected. Check your proxy or corporate SSL certificates'
        case 'ERR_TLS_CERT_ALTNAME_INVALID':
        case 'HOSTNAME_MISMATCH':
          return 'Unable to connect to API: SSL certificate hostname mismatch'
        case 'CERT_NOT_YET_VALID':
          return 'Unable to connect to API: SSL certificate is not yet valid'
        default:
          return `Unable to connect to API: SSL error (${code})`
      }
    }
  }

  if (error.message === 'Connection error.') {
    // 如果有代码但非 SSL，则包含其以用于调试
    if (connectionDetails?.code) {
      return `Unable to connect to API (${connectionDetails.code})`
    }
    return 'Unable to connect to API. Check your internet connection'
  }

  // 防护：当从 JSONL 反序列化时（例如 --resume），错误对象可能是一个没有 `.message` 属性的普通对象。返回安全的回退值，而不是 undefined，否则会导致访问 `.length` 的调用者崩溃。
  if (!error.message) {
    return (
      extractNestedErrorMessage(error) ??
      `API error (status ${error.status ?? 'unknown'})`
    )
  }

  const sanitizedMessage = sanitizeAPIError(error)
  // 如果经过净化的消息与原始消息不同（即HTML已被净化），则使用净化后的消息
  return sanitizedMessage !== error.message && sanitizedMessage.length > 0
    ? sanitizedMessage
    : error.message
}
