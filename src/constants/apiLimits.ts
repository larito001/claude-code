/**
 * Anthropic API 限制
 *
 * 这些常量定义了 Anthropic API 强制执行的服务器端限制。
 * 保持此文件无依赖关系，以防止循环导入。
 *
 * 最后验证：2025-12-22
 * 来源：api/api/schemas/messages/blocks/ 和 api/api/config.py
 *
 * 未来：有关从服务器动态获取限制的信息，请参阅 issue #13240。
 */

// =============================================================================
// 图像限制
// =============================================================================

/**
 * 最大 base64 编码图像大小（API 强制执行）。
 * API 会拒绝 base64 字符串长度超过此值的图像。
 * 注意：这是 base64 长度，而不是原始字节。Base64 使大小增加约 33%。
 */
export const API_IMAGE_MAX_BASE64_SIZE = 5 * 1024 * 1024 // 5 MB

/**
 * 目标原始图像大小，使其在编码后保持在 base64 限制以下。
 * Base64 编码使大小增加 4/3，因此我们推导出最大原始大小：
 * raw_size * 4/3 = base64_size → raw_size = base64_size * 3/4
 */
export const IMAGE_TARGET_RAW_SIZE = (API_IMAGE_MAX_BASE64_SIZE * 3) / 4 // 3.75 MB

/**
 * 客户端图像调整大小的最大尺寸。
 *
 * 注意：API 内部会调整大于 1568px 的图像（来源：
 * encoding/full_encoding.py），但这是在服务器端处理的，不会
 * 导致错误。这些客户端限制（2000px）稍大，以便在有益时保持质量。
 *
 * API_IMAGE_MAX_BASE64_SIZE（5MB）是实际硬限制，超过它会导致 API 错误。
 */
export const IMAGE_MAX_WIDTH = 2000
export const IMAGE_MAX_HEIGHT = 2000

// =============================================================================
// PDF 限制
// =============================================================================

/**
 * 编码后符合 API 请求限制的最大原始 PDF 文件大小。
 * API 的总请求大小限制为 32MB。Base64 编码使大小增加约 33%（4/3），因此 20MB 原始 → 约 27MB base64，为对话上下文留出空间。
 */
export const PDF_TARGET_RAW_SIZE = 20 * 1024 * 1024 // 20 MB

/** API 接受的 PDF 最大页数。 */
export const API_PDF_MAX_PAGES = 100

/** 超过此大小阈值的 PDF 会被提取为页面图像，而不是作为 base64 文档块发送。这仅适用于第一方 API；非第一方始终使用提取。 */
export const PDF_EXTRACT_SIZE_THRESHOLD = 3 * 1024 * 1024 // 3 MB

/** 页面提取路径的最大 PDF 文件大小。大于此值的 PDF 会被拒绝，以避免处理极大的文件。 */
export const PDF_MAX_EXTRACT_SIZE = 100 * 1024 * 1024 // 100 MB

/** Read 工具在使用 pages 参数的单次调用中提取的最大页数。 */
export const PDF_MAX_PAGES_PER_READ = 20

/** 页数超过此值的 PDF 在 @提及时会获得引用处理，而不是内联到上下文中。 */
export const PDF_AT_MENTION_INLINE_THRESHOLD = 10

// =============================================================================
// 媒体限制
// =============================================================================

/**
 * 每个 API 请求允许的最大媒体项数（图像 + PDF）。
 * API 会拒绝超过此限制的请求，并给出令人困惑的错误信息。
 * 我们在客户端进行验证，以提供清晰的错误消息。
 */
export const API_MAX_MEDIA_PER_REQUEST = 100
