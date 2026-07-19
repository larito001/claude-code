import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
} from '@anthropic-ai/sdk'
import type {
  BetaMessage,
  BetaStopReason,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { AFK_MODE_BETA_HEADER } from 'src/constants/betas.js'
import type { SDKAssistantMessageError } from 'src/entrypoints/agentSdkTypes.js'
import type {
  AssistantMessage,
  Message,
  UserMessage,
} from 'src/types/message.js'
import { getAnthropicApiKeyWithSource } from 'src/utils/auth.js'
import { createAssistantAPIErrorMessage } from 'src/utils/messages.js'
import { getModelStrings } from 'src/utils/model/modelStrings.js'
import { getAPIProvider } from 'src/utils/model/providers.js'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import {
  API_PDF_MAX_PAGES,
  PDF_TARGET_RAW_SIZE,
} from '../../constants/apiLimits.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { formatFileSize } from '../../utils/format.js'
import { ImageResizeError } from '../../utils/imageResizer.js'
import { ImageSizeError } from '../../utils/imageValidation.js'
import { formatAPIError } from './errorUtils.js'

export const API_ERROR_MESSAGE_PREFIX = 'API Error'

/** 启动或启用 starts With Api Error Prefix 对应的数据或状态。 */
export function startsWithApiErrorPrefix(text: string): boolean {
  return (
    text.startsWith(API_ERROR_MESSAGE_PREFIX) ||
    text.startsWith(`Check DEEPSEEK_API_KEY · ${API_ERROR_MESSAGE_PREFIX}`)
  )
}
export const PROMPT_TOO_LONG_ERROR_MESSAGE = 'Prompt is too long'

/** 判断是否满足 is Prompt Too Long Message 对应的数据或状态。 */
export function isPromptTooLongMessage(msg: AssistantMessage): boolean {
  if (!msg.isApiErrorMessage) {
    return false
  }
  const content = msg.message.content
  if (!Array.isArray(content)) {
    return false
  }
  return content.some(
    block =>
      block.type === 'text' &&
      block.text.startsWith(PROMPT_TOO_LONG_ERROR_MESSAGE),
  )
}

/**
 * 从原始 prompt-too-long API 错误消息中解析实际/限制 token 数量，例如 "prompt is too long: 137500 tokens > 135000 maximum"。原始字符串可能包含 SDK 前缀或 JSON 封装，或具有不同的大小写 (Vertex)，因此此解析有意宽松。
 */
export function parsePromptTooLongTokenCounts(rawMessage: string): {
  actualTokens: number | undefined
  limitTokens: number | undefined
} {
  const match = rawMessage.match(
    /prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)/i,
  )
  return {
    actualTokens: match ? parseInt(match[1]!, 10) : undefined,
    limitTokens: match ? parseInt(match[2]!, 10) : undefined,
  }
}

/**
 * 返回 prompt-too-long 错误报告的超限 token 数量，如果消息不是 PTL 或其 errorDetails 无法解析，则返回 undefined。Reactive compact 使用此差值在一次重试中跳过多个组，而不是逐次剥离。
 */
export function getPromptTooLongTokenGap(
  msg: AssistantMessage,
): number | undefined {
  if (!isPromptTooLongMessage(msg) || !msg.errorDetails) {
    return undefined
  }
  const { actualTokens, limitTokens } = parsePromptTooLongTokenCounts(
    msg.errorDetails,
  )
  if (actualTokens === undefined || limitTokens === undefined) {
    return undefined
  }
  const gap = actualTokens - limitTokens
  return gap > 0 ? gap : undefined
}

/**
 * 此原始 API 错误文本是否是 stripImagesFromMessages 可以修复的媒体大小拒绝？Reactive compact 的 summarize 重试使用此判断来决定是剥离并重试（媒体错误）还是放弃（其他情况）。
 *
 * 模式必须与填充 errorDetails 的 getAssistantMessageFromError 分支（~L523 PDF, ~L560 image, ~L573 many-image）以及 classifyAPIError 分支（~L929-946）保持同步。闭环：errorDetails 仅在这些分支已匹配相同子字符串后设置，因此对于该路径，isMediaSizeError(errorDetails) 是永真式。API 措辞漂移会导致优雅降级（errorDetails 保持未定义，调用者短路），而不是假阴性。
 */
export function isMediaSizeError(raw: string): boolean {
  return (
    (raw.includes('image exceeds') && raw.includes('maximum')) ||
    (raw.includes('image dimensions exceed') && raw.includes('many-image')) ||
    /maximum of \d+ PDF pages/.test(raw)
  )
}

/**
 * 消息级谓词：此助手消息是否是媒体大小拒绝？与 isPromptTooLongMessage 类似。检查 errorDetails（由 getAssistantMessageFromError 分支在 ~L523/560/573 处填充的原始 API 错误字符串）而不是内容文本，因为媒体错误具有每个变体的内容字符串。
 */
export function isMediaSizeErrorMessage(msg: AssistantMessage): boolean {
  return (
    msg.isApiErrorMessage === true &&
    msg.errorDetails !== undefined &&
    isMediaSizeError(msg.errorDetails)
  )
}
export const CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE = 'Credit balance is too low'
export const INVALID_API_KEY_ERROR_MESSAGE =
  'Missing API key · Set DEEPSEEK_API_KEY in .env and restart'
export const INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL =
  'Invalid API key · Update DEEPSEEK_API_KEY in .env'
export const INVALID_API_KEY_ERROR_MESSAGE_HELPER =
  'Invalid API key returned by apiKeyHelper · Update the command in settings'
export const ORG_DISABLED_ERROR_MESSAGE_ENV_KEY =
  'The configured API key belongs to a disabled organization · Update the key in .env'
export const REPEATED_529_ERROR_MESSAGE = 'Repeated 529 Overloaded errors'
export const CUSTOM_OFF_SWITCH_MESSAGE =
  'Opus is experiencing high load, please use /model to switch to Sonnet'
export const API_TIMEOUT_ERROR_MESSAGE = 'Request timed out'
/** 获取 get Pdf Too Large Error Message 对应的数据或状态。 */
export function getPdfTooLargeErrorMessage(): string {
  const limits = `max ${API_PDF_MAX_PAGES} pages, ${formatFileSize(PDF_TARGET_RAW_SIZE)}`
  return getIsNonInteractiveSession()
    ? `PDF too large (${limits}). Try reading the file a different way (e.g., extract text with pdftotext).`
    : `PDF too large (${limits}). Double press esc to go back and try again, or use pdftotext to convert to text first.`
}
/** 获取 get Pdf Password Protected Error Message 对应的数据或状态。 */
export function getPdfPasswordProtectedErrorMessage(): string {
  return getIsNonInteractiveSession()
    ? 'PDF is password protected. Try using a CLI tool to extract or convert the PDF.'
    : 'PDF is password protected. Please double press esc to edit your message and try again.'
}
/** 获取 get Pdf Invalid Error Message 对应的数据或状态。 */
export function getPdfInvalidErrorMessage(): string {
  return getIsNonInteractiveSession()
    ? 'The PDF file was not valid. Try converting it to text first (e.g., pdftotext).'
    : 'The PDF file was not valid. Double press esc to go back and try again with a different file.'
}
/** 获取 get Image Too Large Error Message 对应的数据或状态。 */
export function getImageTooLargeErrorMessage(): string {
  return getIsNonInteractiveSession()
    ? 'Image was too large. Try resizing the image or using a different approach.'
    : 'Image was too large. Double press esc to go back and try again with a smaller image.'
}
/** 获取 get Request Too Large Error Message 对应的数据或状态。 */
export function getRequestTooLargeErrorMessage(): string {
  const limits = `max ${formatFileSize(PDF_TARGET_RAW_SIZE)}`
  return getIsNonInteractiveSession()
    ? `Request too large (${limits}). Try with a smaller file.`
    : `Request too large (${limits}). Double press esc to go back and try with a smaller file.`
}
// 用于记录 tool_use/tool_result 不匹配错误的临时辅助函数
function logToolUseToolResultMismatch(
  toolUseId: string,
  messages: Message[],
  messagesForAPI: (UserMessage | AssistantMessage)[],
): void {
  try {
    // 在标准化消息中查找 tool_use
    let normalizedIndex = -1
    for (let i = 0; i < messagesForAPI.length; i++) {
      const msg = messagesForAPI[i]
      if (!msg) continue
      const content = msg.message.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block.type === 'tool_use' &&
            'id' in block &&
            block.id === toolUseId
          ) {
            normalizedIndex = i
            break
          }
        }
      }
      if (normalizedIndex !== -1) break
    }

    // 在原始消息中查找 tool_use
    let originalIndex = -1
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]
      if (!msg) continue
      if (msg.type === 'assistant' && 'message' in msg) {
        const content = msg.message.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (
              block.type === 'tool_use' &&
              'id' in block &&
              block.id === toolUseId
            ) {
              originalIndex = i
              break
            }
          }
        }
      }
      if (originalIndex !== -1) break
    }

    // 构建标准化序列
    const normalizedSeq: string[] = []
    for (let i = normalizedIndex + 1; i < messagesForAPI.length; i++) {
      const msg = messagesForAPI[i]
      if (!msg) continue
      const content = msg.message.content
      if (Array.isArray(content)) {
        for (const block of content) {
          const role = msg.message.role
          if (block.type === 'tool_use' && 'id' in block) {
            normalizedSeq.push(`${role}:tool_use:${block.id}`)
          } else if (block.type === 'tool_result' && 'tool_use_id' in block) {
            normalizedSeq.push(`${role}:tool_result:${block.tool_use_id}`)
          } else if (block.type === 'text') {
            normalizedSeq.push(`${role}:text`)
          } else if (block.type === 'thinking') {
            normalizedSeq.push(`${role}:thinking`)
          } else if (block.type === 'image') {
            normalizedSeq.push(`${role}:image`)
          } else {
            normalizedSeq.push(`${role}:${block.type}`)
          }
        }
      } else if (typeof content === 'string') {
        normalizedSeq.push(`${msg.message.role}:string_content`)
      }
    }

    // 构建预标准化序列
    const preNormalizedSeq: string[] = []
    for (let i = originalIndex + 1; i < messages.length; i++) {
      const msg = messages[i]
      if (!msg) continue

      switch (msg.type) {
        case 'user':
        case 'assistant': {
          if ('message' in msg) {
            const content = msg.message.content
            if (Array.isArray(content)) {
              for (const block of content) {
                const role = msg.message.role
                if (block.type === 'tool_use' && 'id' in block) {
                  preNormalizedSeq.push(`${role}:tool_use:${block.id}`)
                } else if (
                  block.type === 'tool_result' &&
                  'tool_use_id' in block
                ) {
                  preNormalizedSeq.push(
                    `${role}:tool_result:${block.tool_use_id}`,
                  )
                } else if (block.type === 'text') {
                  preNormalizedSeq.push(`${role}:text`)
                } else if (block.type === 'thinking') {
                  preNormalizedSeq.push(`${role}:thinking`)
                } else if (block.type === 'image') {
                  preNormalizedSeq.push(`${role}:image`)
                } else {
                  preNormalizedSeq.push(`${role}:${block.type}`)
                }
              }
            } else if (typeof content === 'string') {
              preNormalizedSeq.push(`${msg.message.role}:string_content`)
            }
          }
          break
        }
        case 'attachment':
          if ('attachment' in msg) {
            preNormalizedSeq.push(`attachment:${msg.attachment.type}`)
          }
          break
        case 'system':
          if ('subtype' in msg) {
            preNormalizedSeq.push(`system:${msg.subtype}`)
          }
          break
        case 'progress':
          if (
            'progress' in msg &&
            msg.progress &&
            typeof msg.progress === 'object' &&
            'type' in msg.progress
          ) {
            preNormalizedSeq.push(`progress:${msg.progress.type ?? 'unknown'}`)
          } else {
            preNormalizedSeq.push('progress:unknown')
          }
          break
      }
    }

    // 记录到本地功能配置
  } catch (_) {
    // 在调试日志中忽略错误
  }
}

/** 类型守卫，检查值是否为有效的 API Message 响应 */
export function isValidAPIMessage(value: unknown): value is BetaMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'content' in value &&
    'model' in value &&
    'usage' in value &&
    Array.isArray((value as BetaMessage).content) &&
    typeof (value as BetaMessage).model === 'string' &&
    typeof (value as BetaMessage).usage === 'object'
  )
}

/** AWS 可能返回的低级错误。 */
type AmazonError = {
  Output?: {
    __type?: string
  }
  Version?: string
}

/** 给定一个看起来不太正确的响应，检查是否包含任何可提取的已知错误类型。 */
export function extractUnknownErrorFormat(value: unknown): string | undefined {
  // 首先检查值是否为有效对象
  if (!value || typeof value !== 'object') {
    return undefined
  }

  // Amazon Bedrock 路由错误
  if ((value as AmazonError).Output?.__type) {
    return (value as AmazonError).Output!.__type
  }

  return undefined
}

/** 获取 get Assistant Message From Error 对应的数据或状态。 */
export function getAssistantMessageFromError(
  error: unknown,
  model: string,
  options?: {
    messages?: Message[]
    messagesForAPI?: (UserMessage | AssistantMessage)[]
  },
): AssistantMessage {
  // 检查 SDK 超时错误
  if (
    error instanceof APIConnectionTimeoutError ||
    (error instanceof APIConnectionError &&
      error.message.toLowerCase().includes('timeout'))
  ) {
    return createAssistantAPIErrorMessage({
      content: API_TIMEOUT_ERROR_MESSAGE,
      error: 'unknown',
    })
  }

  // 检查图像大小/调整大小错误（在 API 调用前的验证期间抛出）
  // 使用 getImageTooLargeErrorMessage() 为 CLI 用户显示 "esc esc" 提示，但为 SDK 用户显示通用消息（非交互模式）
  if (error instanceof ImageSizeError || error instanceof ImageResizeError) {
    return createAssistantAPIErrorMessage({
      content: getImageTooLargeErrorMessage(),
    })
  }

  // 检查 Opus PAYG 用户的紧急容量关闭开关
  if (
    error instanceof Error &&
    error.message.includes(CUSTOM_OFF_SWITCH_MESSAGE)
  ) {
    return createAssistantAPIErrorMessage({
      content: CUSTOM_OFF_SWITCH_MESSAGE,
      error: 'rate_limit',
    })
  }

  if (error instanceof APIError && error.status === 429) {
    // 无配额头部 — 这不是配额限制。展示 API 实际所说的内容，而不是通用的 "速率限制已达成"。权利拒绝（例如，无额外使用量的 1M 上下文）和基础设施容量 429 错误在此处处理。
    if (error.message.includes('Extra usage is required for long context')) {
      const hint = getIsNonInteractiveSession()
        ? 'use --model to select a standard-context model'
        : 'use /model to select a standard-context model'
      return createAssistantAPIErrorMessage({
        content: `${API_ERROR_MESSAGE_PREFIX}: Extra usage is required for 1M context · ${hint}`,
        error: 'rate_limit',
      })
    }
    // SDK 的 APIError.makeMessage 在顶层没有 .message 时会在前面添加 "429 " 并对正文进行 JSON 字符串化 — 提取内部的 error.message。
    const stripped = error.message.replace(/^429\s+/, '')
    const innerMessage = stripped.match(/"message"\s*:\s*"([^"]*)"/)?.[1]
    const detail = innerMessage || stripped
    const retryAfter = error.headers?.get?.('retry-after')
    const retryHint = retryAfter ? ` Retry after ${retryAfter} seconds.` : ''
    return createAssistantAPIErrorMessage({
      content: `${API_ERROR_MESSAGE_PREFIX}: Rate limit exceeded (429).${retryHint}${detail ? ` ${detail}` : ''}`,
      error: 'rate_limit',
    })
  }

  // 处理提示过长错误（Vertex 返回 413，直接 API 返回 400）
  // 使用不区分大小写的检查，因为 Vertex 返回 "Prompt is too long"（首字母大写）
  if (
    error instanceof Error &&
    error.message.toLowerCase().includes('prompt is too long')
  ) {
    // 内容保持通用（UI 匹配精确字符串）。包含 token 计数的原始错误进入 errorDetails — reactive compact 的重试循环通过 getPromptTooLongTokenGap 从中解析差值。
    return createAssistantAPIErrorMessage({
      content: PROMPT_TOO_LONG_ERROR_MESSAGE,
      error: 'invalid_request',
      errorDetails: error.message,
    })
  }

  // 检查 PDF 页数限制错误
  if (
    error instanceof Error &&
    /maximum of \d+ PDF pages/.test(error.message)
  ) {
    return createAssistantAPIErrorMessage({
      content: getPdfTooLargeErrorMessage(),
      error: 'invalid_request',
      errorDetails: error.message,
    })
  }

  // 检查受密码保护的 PDF 错误
  if (
    error instanceof Error &&
    error.message.includes('The PDF specified is password protected')
  ) {
    return createAssistantAPIErrorMessage({
      content: getPdfPasswordProtectedErrorMessage(),
      error: 'invalid_request',
    })
  }

  // 检查无效 PDF 错误（例如，HTML 文件重命名为 .pdf）
  // 没有此处理程序，无效的 PDF 文档块会保留在会话上下文中，并导致每个后续 API 调用失败并返回 400。
  if (
    error instanceof Error &&
    error.message.includes('The PDF specified was not valid')
  ) {
    return createAssistantAPIErrorMessage({
      content: getPdfInvalidErrorMessage(),
      error: 'invalid_request',
    })
  }

  // 检查图片大小错误（例如："图片超过5MB上限：5316852字节 > 5242880字节"）
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes('image exceeds') &&
    error.message.includes('maximum')
  ) {
    return createAssistantAPIErrorMessage({
      content: getImageTooLargeErrorMessage(),
      errorDetails: error.message,
    })
  }

  // 检查多图片尺寸错误（API对多图片请求强制执行更严格的2000像素限制）
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes('image dimensions exceed') &&
    error.message.includes('many-image')
  ) {
    return createAssistantAPIErrorMessage({
      content: getIsNonInteractiveSession()
        ? 'An image in the conversation exceeds the dimension limit for many-image requests (2000px). Start a new session with fewer images.'
        : 'An image in the conversation exceeds the dimension limit for many-image requests (2000px). Run /compact to remove old images from context, or start a new session.',
      error: 'invalid_request',
      errorDetails: error.message,
    })
  }

  // 服务器拒绝了afk-mode测试头部（计划不包括自动模式）。在非TRANSCRIPT_CLASSIFIER构建中，AFK_MODE_BETA_HEADER为空字符串，因此真值守卫使其在那里不起作用。
  if (
    AFK_MODE_BETA_HEADER &&
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes(AFK_MODE_BETA_HEADER) &&
    error.message.includes('anthropic-beta')
  ) {
    return createAssistantAPIErrorMessage({
      content: 'Auto mode is unavailable for your plan',
      error: 'invalid_request',
    })
  }

  // 检查请求过大错误（413状态）。这通常发生在大型PDF加对话上下文超过32MB API限制时。
  if (error instanceof APIError && error.status === 413) {
    return createAssistantAPIErrorMessage({
      content: getRequestTooLargeErrorMessage(),
      error: 'invalid_request',
    })
  }

  // 检查tool_use/tool_result并发错误
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes(
      '`tool_use` ids were found without `tool_result` blocks immediately after',
    )
  ) {
    // 如果有消息上下文，则记录到本地功能配置中
    if (options?.messages && options?.messagesForAPI) {
      const toolUseIdMatch = error.message.match(/toolu_[a-zA-Z0-9]+/)
      const toolUseId = toolUseIdMatch ? toolUseIdMatch[0] : null
      if (toolUseId) {
        logToolUseToolResultMismatch(
          toolUseId,
          options.messages,
          options.messagesForAPI,
        )
      }
    }

    const baseMessage = 'API Error: 400 due to tool use concurrency issues.'
    const rewindInstruction = getIsNonInteractiveSession()
      ? ''
      : ' Run /rewind to recover the conversation.'
    return createAssistantAPIErrorMessage({
      content: baseMessage + rewindInstruction,
      error: 'invalid_request',
    })
  }

  // 重复的tool_use ID（CC-1212）。ensureToolResultPairing在发送前会去除这些重复，因此遇到此错误意味着新的损坏路径漏过了。记录以查找根本原因，并为用户提供恢复路径而非死锁。
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes('`tool_use` ids must be unique')
  ) {
    const rewindInstruction = getIsNonInteractiveSession()
      ? ''
      : ' Run /rewind to recover the conversation.'
    return createAssistantAPIErrorMessage({
      content: `API Error: 400 duplicate tool_use ID in conversation history.${rewindInstruction}`,
      error: 'invalid_request',
      errorDetails: error.message,
    })
  }

  if (
    error instanceof Error &&
    error.message.includes('Your credit balance is too low')
  ) {
    return createAssistantAPIErrorMessage({
      content: CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE,
      error: 'billing_error',
    })
  }
  // 为API密钥用户提供对已禁用组织的直接补救措施。
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.toLowerCase().includes('organization has been disabled')
  ) {
    const { source } = getAnthropicApiKeyWithSource()
    if (
      source === 'ANTHROPIC_API_KEY' &&
      process.env.ANTHROPIC_API_KEY
    ) {
      return createAssistantAPIErrorMessage({
        error: 'invalid_request',
        content: ORG_DISABLED_ERROR_MESSAGE_ENV_KEY,
      })
    }
  }

  if (
    error instanceof Error &&
    error.message.toLowerCase().includes('x-api-key')
  ) {
    // 检查API密钥是否来自外部来源
    const { source } = getAnthropicApiKeyWithSource()
    return createAssistantAPIErrorMessage({
      error: 'authentication_failed',
      content:
        source === 'apiKeyHelper'
          ? INVALID_API_KEY_ERROR_MESSAGE_HELPER
          : source === 'ANTHROPIC_API_KEY'
            ? INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL
            : INVALID_API_KEY_ERROR_MESSAGE,
    })
  }

  // 其他401/403认证错误的通用处理程序
  if (
    error instanceof APIError &&
    (error.status === 401 || error.status === 403)
  ) {
    return createAssistantAPIErrorMessage({
      error: 'authentication_failed',
      content: getIsNonInteractiveSession()
        ? `Failed to authenticate. ${API_ERROR_MESSAGE_PREFIX}: ${error.message}`
        : `Check DEEPSEEK_API_KEY in .env · ${API_ERROR_MESSAGE_PREFIX}: ${error.message}`,
    })
  }

  // Bedrock错误，例如"403 您无权访问具有指定模型ID的模型。"不包含实际的模型ID
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) &&
    error instanceof Error &&
    error.message.toLowerCase().includes('model id')
  ) {
    const switchCmd = getIsNonInteractiveSession() ? '--model' : '/model'
    const fallbackSuggestion = get3PModelFallbackSuggestion(model)
    return createAssistantAPIErrorMessage({
      content: fallbackSuggestion
        ? `${API_ERROR_MESSAGE_PREFIX} (${model}): ${error.message}. Try ${switchCmd} to switch to ${fallbackSuggestion}.`
        : `${API_ERROR_MESSAGE_PREFIX} (${model}): ${error.message}. Run ${switchCmd} to pick a different model.`,
      error: 'invalid_request',
    })
  }

  // 404未找到——通常意味着所选模型不存在或不可用。引导用户到/model以便他们选择有效的模型。对于第三方用户，建议他们可以尝试的特定备用模型。
  if (error instanceof APIError && error.status === 404) {
    const switchCmd = getIsNonInteractiveSession() ? '--model' : '/model'
    const fallbackSuggestion = get3PModelFallbackSuggestion(model)
    return createAssistantAPIErrorMessage({
      content: fallbackSuggestion
        ? `The model ${model} is not available on your ${getAPIProvider()} deployment. Try ${switchCmd} to switch to ${fallbackSuggestion}, or ask your admin to enable this model.`
        : `There's an issue with the selected model (${model}). It may not exist or you may not have access to it. Run ${switchCmd} to pick a different model.`,
      error: 'invalid_request',
    })
  }

  // 连接错误（非超时）——使用formatAPIError获取详细消息
  if (error instanceof APIConnectionError) {
    return createAssistantAPIErrorMessage({
      content: `${API_ERROR_MESSAGE_PREFIX}: ${formatAPIError(error)}`,
      error: 'unknown',
    })
  }

  if (error instanceof Error) {
    return createAssistantAPIErrorMessage({
      content: `${API_ERROR_MESSAGE_PREFIX}: ${error.message}`,
      error: 'unknown',
    })
  }
  return createAssistantAPIErrorMessage({
    content: API_ERROR_MESSAGE_PREFIX,
    error: 'unknown',
  })
}

/** 对于第三方用户，当所选模型不可用时建议备用模型。返回模型名称建议，如果没有适用的建议则返回undefined。 */
function get3PModelFallbackSuggestion(model: string): string | undefined {
  if (getAPIProvider() === 'firstParty') {
    return undefined
  }
  // @[MODEL LAUNCH]：为新模型→第三方上一版本添加备用建议链
  const m = model.toLowerCase()
  // 如果失败的模型看起来像Opus 4.6变体，建议默认Opus（第三方为4.1）
  if (m.includes('opus-4-6') || m.includes('opus_4_6')) {
    return getModelStrings().opus41
  }
  // 如果失败的模型看起来像Sonnet 4.6变体，建议Sonnet 4.5
  if (m.includes('sonnet-4-6') || m.includes('sonnet_4_6')) {
    return getModelStrings().sonnet45
  }
  // 如果失败的模型看起来像Sonnet 4.5变体，建议Sonnet 4
  if (m.includes('sonnet-4-5') || m.includes('sonnet_4_5')) {
    return getModelStrings().sonnet40
  }
  return undefined
}

/** 执行 categorize Retryable API Error 对应的业务处理。 */
export function categorizeRetryableAPIError(
  error: APIError,
): SDKAssistantMessageError {
  if (
    error.status === 529 ||
    error.message?.includes('"type":"overloaded_error"')
  ) {
    return 'rate_limit'
  }
  if (error.status === 429) {
    return 'rate_limit'
  }
  if (error.status === 401 || error.status === 403) {
    return 'authentication_failed'
  }
  if (error.status !== undefined && error.status >= 408) {
    return 'server_error'
  }
  return 'unknown'
}

/** 获取 get Error Message If Refusal 对应的数据或状态。 */
export function getErrorMessageIfRefusal(
  stopReason: BetaStopReason | null,
  model: string,
): AssistantMessage | undefined {
  if (stopReason !== 'refusal') {
    return
  }


  const baseMessage = getIsNonInteractiveSession()
    ? `${API_ERROR_MESSAGE_PREFIX}: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup). Try rephrasing the request or attempting a different approach.`
    : `${API_ERROR_MESSAGE_PREFIX}: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup). Please double press esc to edit your last message or start a new session for Claude Code to assist with a different task.`

  const modelSuggestion =
    model !== 'claude-sonnet-4-20250514'
      ? ' If you are seeing this refusal repeatedly, try running /model claude-sonnet-4-20250514 to switch models.'
      : ''

  return createAssistantAPIErrorMessage({
    content: baseMessage + modelSuggestion,
    error: 'invalid_request',
  })
}
