import { feature } from 'src/utils/features.js'
import { APIError } from '@anthropic-ai/sdk'
import {
  addToTotalDurationState,
  setLastApiCompletionTimestamp,
} from 'src/bootstrap/state.js'
import { logForDebugging } from 'src/utils/debug.js'
import { logError } from 'src/utils/log.js'
import { logOTelEvent } from 'src/utils/telemetry/events.js'
import { endLLMRequestSpan, type Span } from 'src/utils/telemetry/sessionTracing.js'
import type { NonNullableUsage } from '@anthropic-ai/claude-agent-sdk'
import { EMPTY_USAGE } from './emptyUsage.js'
import { extractConnectionErrorDetails } from './errorUtils.js'

export type { NonNullableUsage }
export { EMPTY_USAGE }

// 全局提示缓存的策略
export type GlobalCacheStrategy = 'tool_based' | 'system_prompt' | 'none'

/** 获取 get Error Message 对应的数据或状态。 */
function getErrorMessage(error: unknown): string {
  if (error instanceof APIError) {
    const body = error.error as { error?: { message?: string } } | undefined
    if (body?.error?.message) return body.error.message
  }
  return error instanceof Error ? error.message : String(error)
}

/** 输出或发送 log API Error 对应的数据或状态。 */
export function logAPIError({
  error,
  model,
  durationMs,
  attempt,
  clientRequestId,
  llmSpan,
  fastMode,
}: {
  error: unknown
  model: string
  durationMs: number
  attempt: number
  /** 客户端生成的 ID，通过 x-client-request-id 标头发送（可跨超时） */
  clientRequestId?: string
  /** 来自 startLLMRequestSpan 的跨度 —— 传递此值以正确匹配请求与响应 */
  llmSpan?: Span
  fastMode?: boolean
}): void {
  const errStr = getErrorMessage(error)
  const status = error instanceof APIError ? String(error.status) : undefined
  // 将详细的连接错误信息记录到调试日志（可通过 --debug 查看）
  const connectionDetails = extractConnectionErrorDetails(error)
  if (connectionDetails) {
    const sslLabel = connectionDetails.isSSLError ? ' (SSL error)' : ''
    logForDebugging(
      `Connection error details: code=${connectionDetails.code}${sslLabel}, message=${connectionDetails.message}`,
      { level: 'error' },
    )
  }

  if (clientRequestId) {
    logForDebugging(
      `API error x-client-request-id=${clientRequestId} (give this to the API team for server-log lookup)`,
      { level: 'error' },
    )
  }

  logError(error as Error)

  // 记录 API 错误事件到 OTLP
  void logOTelEvent('api_error', {
    model: model,
    error: errStr,
    status_code: String(status),
    duration_ms: String(durationMs),
    attempt: String(attempt),
    speed: fastMode ? 'fast' : 'normal',
  })

  endLLMRequestSpan(llmSpan, {
    success: false,
    statusCode: status ? parseInt(status) : undefined,
    error: errStr,
    attempt,
  })

}

/** 输出或发送 log API Success And Duration 对应的数据或状态。 */
export function logAPISuccessAndDuration({
  model,
  start,
  startIncludingRetries,
  ttftMs,
  usage,
  attempt,
  costUSD,
  llmSpan,
  requestSetupMs,
  attemptStartTimes,
  fastMode,
}: {
  model: string
  start: number
  startIncludingRetries: number
  ttftMs: number | null
  usage: NonNullableUsage
  attempt: number
  costUSD: number
  /** 来自 startLLMRequestSpan 的跨度 —— 传递此值以正确匹配请求与响应 */
  llmSpan?: Span
  /** 成功尝试之前的请求前设置所花费的时间 */
  requestSetupMs?: number
  /** 每次尝试开始的时间戳（Date.now()）—— 用于 Perfetto 中的重试子跨度 */
  attemptStartTimes?: number[]
  fastMode?: boolean
}): void {
  const durationMs = Date.now() - start
  const durationMsIncludingRetries = Date.now() - startIncludingRetries
  addToTotalDurationState(durationMsIncludingRetries, durationMs)
  setLastApiCompletionTimestamp(Date.now())
  // 记录 API 请求事件到 OTLP
  void logOTelEvent('api_request', {
    model,
    input_tokens: String(usage.input_tokens),
    output_tokens: String(usage.output_tokens),
    cache_read_tokens: String(usage.cache_read_input_tokens),
    cache_creation_tokens: String(usage.cache_creation_input_tokens),
    cost_usd: String(costUSD),
    duration_ms: String(durationMs),
    speed: fastMode ? 'fast' : 'normal',
  })

  endLLMRequestSpan(llmSpan, {
    success: true,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    cacheCreationTokens: usage.cache_creation_input_tokens,
    attempt,
    ttftMs: ttftMs ?? undefined,
    requestSetupMs,
    attemptStartTimes,
  })

}
