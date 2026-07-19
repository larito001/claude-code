import { feature } from 'src/utils/features.js'
import type Anthropic from '@anthropic-ai/sdk'
import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk'
import type { QuerySource } from 'src/constants/querySource.js'
import type { SystemAPIErrorMessage } from 'src/types/message.js'
import { isAwsCredentialsProviderError } from 'src/utils/aws.js'
import { logForDebugging } from 'src/utils/debug.js'
import { logError } from 'src/utils/log.js'
import { createSystemAPIErrorMessage } from 'src/utils/messages.js'
import { clearApiKeyHelperCache, clearAwsCredentialsCache, clearGcpCredentialsCache } from '../../utils/auth.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import {
  type CooldownReason,
  handleFastModeRejectedByAPI,
  isFastModeCooldown,
  isFastModeEnabled,
  triggerFastModeCooldown,
} from '../../utils/fastMode.js'
import { isNonCustomOpusModel } from '../../utils/model/model.js'
import { disableKeepAlive } from '../../utils/proxy.js'
import { sleep } from '../../utils/sleep.js'
import type { ThinkingConfig } from '../../utils/thinking.js'
import { getFeatureValue } from '../featureConfig.js'
import { REPEATED_529_ERROR_MESSAGE } from './errors.js'
import { extractConnectionErrorDetails } from './errorUtils.js'

/** 停止或关闭 abort Error 对应的数据或状态。 */
const abortError = () => new APIUserAbortError()

const DEFAULT_MAX_RETRIES = 10
const FLOOR_OUTPUT_TOKENS = 3000
const MAX_529_RETRIES = 3
export const BASE_DELAY_MS = 500

// 用户正在阻塞等待结果的前台查询源——这些源会在529错误时重试。其他所有内容（摘要、标题、建议、分类器）会立即放弃：在容量级联期间，每次重试会导致3-10倍的网关放大，而且用户无论如何也不会看到那些失败。新源默认不重试——仅当用户在等待结果时才添加此处。
const FOREGROUND_529_RETRY_SOURCES = new Set<QuerySource>([
  'repl_main_thread',
  'repl_main_thread:outputStyle:custom',
  'repl_main_thread:outputStyle:Explanatory',
  'repl_main_thread:outputStyle:Learning',
  'sdk',
  'agent:custom',
  'agent:default',
  'agent:builtin',
  'compact',
  'hook_agent',
  'hook_prompt',
  'verification_agent',
  'side_question',
  // 安全分类器——必须完成以确保自动模式的正确性。yoloClassifier.ts使用'auto_mode'（而不是'yolo_classifier'——那只是类型）。Bash分类器保持独立的功能门控。
  'auto_mode',
  ...(feature('BASH_CLASSIFIER') ? (['bash_classifier'] as const) : []),
])

/** 判断是否满足 should Retry529 对应的数据或状态。 */
function shouldRetry529(querySource: QuerySource | undefined): boolean {
  // undefined → 重试（对于未标记的调用路径采用保守策略）
  return (
    querySource === undefined || FOREGROUND_529_RETRY_SOURCES.has(querySource)
  )
}

// CLAUDE_CODE_UNATTENDED_RETRY：无人值守会话的选择加入行为。无限重试429/529，采用更高的退避和周期性的保活让步，以便主机环境不会在等待期间将会话标记为空闲。保活目前使用SystemAPIErrorMessage让步；专用的主机保活通道可以替换它而不改变重试语义。
const PERSISTENT_MAX_BACKOFF_MS = 5 * 60 * 1000
const PERSISTENT_RESET_CAP_MS = 6 * 60 * 60 * 1000
const HEARTBEAT_INTERVAL_MS = 30_000

/** 判断是否满足 is Persistent Retry Enabled 对应的数据或状态。 */
function isPersistentRetryEnabled(): boolean {
  return feature('UNATTENDED_RETRY')
    ? isEnvTruthy(process.env.CLAUDE_CODE_UNATTENDED_RETRY)
    : false
}

/** 判断是否满足 is Transient Capacity Error 对应的数据或状态。 */
function isTransientCapacityError(error: unknown): boolean {
  return (
    is529Error(error) || (error instanceof APIError && error.status === 429)
  )
}

/** 判断是否满足 is Stale Connection Error 对应的数据或状态。 */
function isStaleConnectionError(error: unknown): boolean {
  if (!(error instanceof APIConnectionError)) {
    return false
  }
  const details = extractConnectionErrorDetails(error)
  return details?.code === 'ECONNRESET' || details?.code === 'EPIPE'
}

export interface RetryContext {
  maxTokensOverride?: number
  model: string
  thinkingConfig: ThinkingConfig
  fastMode?: boolean
}

interface RetryOptions {
  maxRetries?: number
  model: string
  fallbackModel?: string
  thinkingConfig: ThinkingConfig
  fastMode?: boolean
  signal?: AbortSignal
  querySource?: QuerySource
  /** 预先设置连续529计数器。当此重试循环是流式529后的非流式回退时使用——流式529应计入MAX_529_RETRIES，这样无论哪种请求模式遇到过载，回退前的总529次数都保持一致。 */
  initialConsecutive529Errors?: number
}

export class CannotRetryError extends Error {
  /** 初始化当前实例及其必要状态。 */
  constructor(
    public readonly originalError: unknown,
    public readonly retryContext: RetryContext,
  ) {
    const message = errorMessage(originalError)
    super(message)
    this.name = 'RetryError'

    // 如果可用，保留原始堆栈跟踪
    if (originalError instanceof Error && originalError.stack) {
      this.stack = originalError.stack
    }
  }
}

export class FallbackTriggeredError extends Error {
  /** 初始化当前实例及其必要状态。 */
  constructor(
    public readonly originalModel: string,
    public readonly fallbackModel: string,
  ) {
    super(`Model fallback triggered: ${originalModel} -> ${fallbackModel}`)
    this.name = 'FallbackTriggeredError'
  }
}

/** 执行 with Retry 对应的业务处理。 */
export async function* withRetry<T>(
  getClient: () => Promise<Anthropic>,
  operation: (
    client: Anthropic,
    attempt: number,
    context: RetryContext,
  ) => Promise<T>,
  options: RetryOptions,
): AsyncGenerator<SystemAPIErrorMessage, T> {
  const maxRetries = getMaxRetries(options)
  const retryContext: RetryContext = {
    model: options.model,
    thinkingConfig: options.thinkingConfig,
    ...(isFastModeEnabled() && { fastMode: options.fastMode }),
  }
  let client: Anthropic | null = null
  let consecutive529Errors = options.initialConsecutive529Errors ?? 0
  let lastError: unknown
  let persistentAttempt = 0
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (options.signal?.aborted) {
      throw new APIUserAbortError()
    }

    // 在此尝试之前捕获快速模式是否激活（回退可能在循环中间改变状态）
    const wasFastModeActive = isFastModeEnabled()
      ? retryContext.fastMode && !isFastModeCooldown()
      : false

    try {
      // 在首次尝试或认证错误后获取新的客户端实例
      // - 401 表示第一方API密钥认证失败
      // - Bedrock特有的认证错误（403或CredentialsProviderError）
      // - Vertex特有的认证错误（凭证刷新失败，401）
      // - ECONNRESET/EPIPE：保持连接套接字过期；禁用连接池并重新连接
      const isStaleConnection = isStaleConnectionError(lastError)
      if (
        isStaleConnection &&
        getFeatureValue(
          'tengu_disable_keepalive_on_econnreset',
          false,
        )
      ) {
        logForDebugging(
          'Stale connection (ECONNRESET/EPIPE) — disabling keep-alive for retry',
        )
        disableKeepAlive()
      }

      if (
        client === null ||
        (lastError instanceof APIError && lastError.status === 401) ||
        isBedrockAuthError(lastError) ||
        isVertexAuthError(lastError) ||
        isStaleConnection
      ) {
        client = await getClient()
      }

      return await operation(client, attempt, retryContext)
    } catch (error) {
      lastError = error
      logForDebugging(
        `API error (attempt ${attempt}/${maxRetries + 1}): ${error instanceof APIError ? `${error.status} ${error.message}` : errorMessage(error)}`,
        { level: 'error' },
      )

      // 快速模式回退：在429/529时，要么等待并重试（短延迟），要么回退到标准速度（长延迟），以避免缓存抖动。在持久模式下跳过：下面的短重试路径在快速模式仍激活时循环，因此其`continue`永远不会到达尝试限制，for循环终止。持久会话无论如何都希望采用分块保活路径，而不是快速模式的缓存保留。
      if (
        wasFastModeActive &&
        !isPersistentRetryEnabled() &&
        error instanceof APIError &&
        (error.status === 429 || is529Error(error))
      ) {
        const retryAfterMs = getRetryAfterMs(error)
        if (retryAfterMs !== null && retryAfterMs < SHORT_RETRY_THRESHOLD_MS) {
          // 短重试延迟：等待并以快速模式仍激活的状态重试，以保留提示缓存（重试时使用相同的模型名称）。
          await sleep(retryAfterMs, options.signal, { abortError })
          continue
        }
        // 长或未知的重试延迟：进入冷却（切换到标准速度模型），并设置最低下限以避免来回切换。
        const cooldownMs = Math.max(
          retryAfterMs ?? DEFAULT_FAST_MODE_FALLBACK_HOLD_MS,
          MIN_COOLDOWN_MS,
        )
        const cooldownReason: CooldownReason = is529Error(error)
          ? 'overloaded'
          : 'rate_limit'
        triggerFastModeCooldown(Date.now() + cooldownMs, cooldownReason)
        if (isFastModeEnabled()) {
          retryContext.fastMode = false
        }
        continue
      }

      // 快速模式回退：如果API拒绝快速模式参数（例如，组织未启用快速模式），则永久禁用快速模式并以标准速度重试。
      if (wasFastModeActive && isFastModeNotEnabledError(error)) {
        handleFastModeRejectedByAPI()
        retryContext.fastMode = false
        continue
      }

      // 非前台源在529时立即放弃——在容量级联期间没有重试放大。用户永远不会看到这些失败。
      if (is529Error(error) && !shouldRetry529(options.querySource)) {
        throw new CannotRetryError(error, retryContext)
      }

      // 跟踪连续的529错误
      if (
        is529Error(error) &&
        // 如果未设置FALLBACK_FOR_ALL_PRIMARY_MODELS，则仅当主要模型是非自定义的Opus模型时才回退。
        // 默认只为内置 Opus 主模型启用模型回退；自定义模型需显式设置
        // FALLBACK_FOR_ALL_PRIMARY_MODELS，避免在未知部署上擅自切换模型。
        (process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS ||
          isNonCustomOpusModel(options.model))
      ) {
        consecutive529Errors++
        if (consecutive529Errors >= MAX_529_RETRIES) {
          // 检查是否指定了回退模型
          if (options.fallbackModel) {

            // 抛出特殊错误以指示已触发回退
            throw new FallbackTriggeredError(
              options.model,
              options.fallbackModel,
            )
          }

          if (
            !process.env.IS_SANDBOX &&
            !isPersistentRetryEnabled()
          ) {
            throw new CannotRetryError(
              new Error(REPEATED_529_ERROR_MESSAGE),
              retryContext,
            )
          }
        }
      }

      // 仅当错误指示应重试时才重试
      const persistent =
        isPersistentRetryEnabled() && isTransientCapacityError(error)
      if (attempt > maxRetries && !persistent) {
        throw new CannotRetryError(error, retryContext)
      }

      // AWS/GCP错误不总是APIError，但可以重试
      const handledCloudAuthError =
        handleAwsCredentialError(error) || handleGcpCredentialError(error)
      if (
        !handledCloudAuthError &&
        (!(error instanceof APIError) || !shouldRetry(error))
      ) {
        throw new CannotRetryError(error, retryContext)
      }

      // 通过调整下次尝试的max_tokens来处理最大令牌上下文溢出错误
      // 注意：使用扩展上下文窗口beta版时，不应出现此400错误。API现在返回'model_context_window_exceeded'停止原因。保留以向后兼容。
      if (error instanceof APIError) {
        const overflowData = parseMaxTokensContextOverflowError(error)
        if (overflowData) {
          const { inputTokens, contextLimit } = overflowData

          const safetyBuffer = 1000
          const availableContext = Math.max(
            0,
            contextLimit - inputTokens - safetyBuffer,
          )
          if (availableContext < FLOOR_OUTPUT_TOKENS) {
            logError(
              new Error(
                `availableContext ${availableContext} is less than FLOOR_OUTPUT_TOKENS ${FLOOR_OUTPUT_TOKENS}`,
              ),
            )
            throw error
          }
          // 确保有足够的令牌用于思考 + 至少1个输出令牌
          const minRequired =
            (retryContext.thinkingConfig.type === 'enabled'
              ? retryContext.thinkingConfig.budgetTokens
              : 0) + 1
          const adjustedMaxTokens = Math.max(
            FLOOR_OUTPUT_TOKENS,
            availableContext,
            minRequired,
          )
          retryContext.maxTokensOverride = adjustedMaxTokens


          continue
        }
      }

      // 对于其他错误，继续正常的重试逻辑。如果可用，获取retry-after头
      const retryAfter = getRetryAfter(error)
      let delayMs: number
      if (persistent && error instanceof APIError && error.status === 429) {
        persistentAttempt++
        // 基于窗口的限制（例如5小时Max/Pro）包含重置时间戳。等待重置，而不是无用地每5分钟轮询。
        const resetDelay = getRateLimitResetDelayMs(error)
        delayMs =
          resetDelay ??
          Math.min(
            getRetryDelay(
              persistentAttempt,
              retryAfter,
              PERSISTENT_MAX_BACKOFF_MS,
            ),
            PERSISTENT_RESET_CAP_MS,
          )
      } else if (persistent) {
        persistentAttempt++
        // Retry-After是服务器指令，绕过getRetryDelay内部的maxDelayMs（有意为之——遵守它是正确的）。在此处限制为6小时重置上限，以避免病态头导致无限等待。
        delayMs = Math.min(
          getRetryDelay(
            persistentAttempt,
            retryAfter,
            PERSISTENT_MAX_BACKOFF_MS,
          ),
          PERSISTENT_RESET_CAP_MS,
        )
      } else {
        delayMs = getRetryDelay(attempt, retryAfter)
      }

      // 在持久模式下，for循环 `attempt` 被限制在 maxRetries+1；
      // 使用 persistentAttempt 进行遥测/产出，以显示真实次数。
      const reportedAttempt = persistent ? persistentAttempt : attempt

      if (persistent) {
        // 将长休眠分块，以便主机看到定期的 stdout 活动，
        // 不会将会话标记为空闲。每次产出作为
        // {type:'system', subtype:'api_retry'} 通过 QueryEngine 出现在 stdout 上。
        let remaining = delayMs
        while (remaining > 0) {
          if (options.signal?.aborted) throw new APIUserAbortError()
          if (error instanceof APIError) {
            yield createSystemAPIErrorMessage(
              error,
              remaining,
              reportedAttempt,
              maxRetries,
            )
          }
          const chunk = Math.min(remaining, HEARTBEAT_INTERVAL_MS)
          await sleep(chunk, options.signal, { abortError })
          remaining -= chunk
        }
        // 限制以使 for 循环永不终止。退避使用单独的
        // persistentAttempt 计数器，该计数器持续增长至 5 分钟上限。
        if (attempt >= maxRetries) attempt = maxRetries
      } else {
        if (error instanceof APIError) {
          yield createSystemAPIErrorMessage(error, delayMs, attempt, maxRetries)
        }
        await sleep(delayMs, options.signal, { abortError })
      }
    }
  }

  throw new CannotRetryError(lastError, retryContext)
}

/** 获取 get Retry After 对应的数据或状态。 */
function getRetryAfter(error: unknown): string | null {
  return (
    ((error as { headers?: { 'retry-after'?: string } }).headers?.[
      'retry-after'
    ] ||
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      ((error as APIError).headers as Headers)?.get?.('retry-after')) ??
    null
  )
}

/** 获取 get Retry Delay 对应的数据或状态。 */
export function getRetryDelay(
  attempt: number,
  retryAfterHeader?: string | null,
  maxDelayMs = 32000,
): number {
  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader, 10)
    if (!isNaN(seconds)) {
      return seconds * 1000
    }
  }

  const baseDelay = Math.min(
    BASE_DELAY_MS * Math.pow(2, attempt - 1),
    maxDelayMs,
  )
  const jitter = Math.random() * 0.25 * baseDelay
  return baseDelay + jitter
}

/** 解析 parse Max Tokens Context Overflow Error 对应的数据或状态。 */
export function parseMaxTokensContextOverflowError(error: APIError):
  | {
      inputTokens: number
      maxTokens: number
      contextLimit: number
    }
  | undefined {
  if (error.status !== 400 || !error.message) {
    return undefined
  }

  if (
    !error.message.includes(
      'input length and `max_tokens` exceed context limit',
    )
  ) {
    return undefined
  }

  // 示例格式："input length and `max_tokens` exceed context limit: 188059 + 20000 > 200000"
  const regex =
    /input length and `max_tokens` exceed context limit: (\d+) \+ (\d+) > (\d+)/
  const match = error.message.match(regex)

  if (!match || match.length !== 4) {
    return undefined
  }

  if (!match[1] || !match[2] || !match[3]) {
    logError(
      new Error(
        'Unable to parse max_tokens from max_tokens exceed context limit error message',
      ),
    )
    return undefined
  }
  const inputTokens = parseInt(match[1], 10)
  const maxTokens = parseInt(match[2], 10)
  const contextLimit = parseInt(match[3], 10)

  if (isNaN(inputTokens) || isNaN(maxTokens) || isNaN(contextLimit)) {
    return undefined
  }

  return { inputTokens, maxTokens, contextLimit }
}

// 当前 API 没有专用于快速模式拒绝的响应头，只能兼容其稳定错误短语；
// 若服务端新增机器可读标头，应优先改用标头，避免文案变化影响判断。
function isFastModeNotEnabledError(error: unknown): boolean {
  if (!(error instanceof APIError)) {
    return false
  }
  return (
    error.status === 400 &&
    (error.message?.includes('Fast mode is not enabled') ?? false)
  )
}

/** 判断是否满足 is529 Error 对应的数据或状态。 */
export function is529Error(error: unknown): boolean {
  if (!(error instanceof APIError)) {
    return false
  }

  // 检查消息中是否有 529 状态码或过载错误
  return (
    error.status === 529 ||
    // 见下文：SDK 有时在流式传输期间无法正确传递 529 状态码
    (error.message?.includes('"type":"overloaded_error"') ?? false)
  )
}

/** 判断是否满足 is Bedrock Auth Error 对应的数据或状态。 */
function isBedrockAuthError(error: unknown): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)) {
    // 如果 .aws 包含过去的 Expiration 值，AWS 库会拒绝而不进行 API 调用；
    // 否则，接收过期令牌的 API 调用会给出通用 403
    // 此时服务端通常返回“The security token included in the request is invalid”。
    if (
      isAwsCredentialsProviderError(error) ||
      (error instanceof APIError && error.status === 403)
    ) {
      return true
    }
  }
  return false
}

/**
 * 清除 AWS 认证缓存（如果适用）。
 * @returns 如果执行了操作则返回 true。
 */
function handleAwsCredentialError(error: unknown): boolean {
  if (isBedrockAuthError(error)) {
    clearAwsCredentialsCache()
    return true
  }
  return false
}

// google-auth-library 抛出普通 Error（没有像 AWS 的
// CredentialsProviderError 那样的类型化名称）。匹配常见的 SDK 级凭证失败消息。
function isGoogleAuthLibraryCredentialError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const msg = error.message
  return (
    msg.includes('Could not load the default credentials') ||
    msg.includes('Could not refresh access token') ||
    msg.includes('invalid_grant')
  )
}

/** 判断是否满足 is Vertex Auth Error 对应的数据或状态。 */
function isVertexAuthError(error: unknown): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)) {
    // SDK 级别：google-auth-library 在 HTTP 调用之前的 prepareOptions() 中失败
    if (isGoogleAuthLibraryCredentialError(error)) {
      return true
    }
    // 服务器端：Vertex 对过期/无效令牌返回 401
    if (error instanceof APIError && error.status === 401) {
      return true
    }
  }
  return false
}

/**
 * 清除 GCP 认证缓存（如果适用）。
 * @returns 如果执行了操作则返回 true。
 */
function handleGcpCredentialError(error: unknown): boolean {
  if (isVertexAuthError(error)) {
    clearGcpCredentialsCache()
    return true
  }
  return false
}

/** 判断是否满足 should Retry 对应的数据或状态。 */
function shouldRetry(error: APIError): boolean {
  // 持久模式：429/529 始终可重试，并绕过 x-should-retry。
  if (isPersistentRetryEnabled() && isTransientCapacityError(error)) {
    return true
  }

  // 首先通过检查消息内容来检查过载错误。
  // SDK 有时在流式传输期间无法正确传递 529 状态码，
  // 因此我们需要直接检查错误消息
  if (error.message?.includes('"type":"overloaded_error"')) {
    return true
  }

  // 检查可处理的最大令牌上下文溢出错误
  if (parseMaxTokensContextOverflowError(error)) {
    return true
  }

  // 注意，这不是标准头。
  const shouldRetryHeader = error.headers?.get('x-should-retry')

  // 如果服务器明确指示是否重试，则遵循。
  if (shouldRetryHeader === 'true') {
    return true
  }

  if (shouldRetryHeader === 'false') {
    return false
  }

  if (error instanceof APIConnectionError) {
    return true
  }

  if (!error.status) return false

  // 在请求超时时重试。
  if (error.status === 408) return true

  // 在锁定超时时重试。
  if (error.status === 409) return true

  // API 密钥提供者可能对临时速率限制使用 Retry-After。
  if (error.status === 429) {
    return true
  }

  // 在 401 时清除 API 密钥缓存并允许重试。
  if (error.status === 401) {
    clearApiKeyHelperCache()
    return true
  }

  // 重试内部错误。
  if (error.status && error.status >= 500) return true

  return false
}

/** 获取 get Default Max Retries 对应的数据或状态。 */
export function getDefaultMaxRetries(): number {
  if (process.env.CLAUDE_CODE_MAX_RETRIES) {
    return parseInt(process.env.CLAUDE_CODE_MAX_RETRIES, 10)
  }
  return DEFAULT_MAX_RETRIES
}
/** 获取 get Max Retries 对应的数据或状态。 */
function getMaxRetries(options: RetryOptions): number {
  return options.maxRetries ?? getDefaultMaxRetries()
}

const DEFAULT_FAST_MODE_FALLBACK_HOLD_MS = 30 * 60 * 1000 // 30 分钟
const SHORT_RETRY_THRESHOLD_MS = 20 * 1000 // 20秒
const MIN_COOLDOWN_MS = 10 * 60 * 1000 // 10分钟

/** 获取 get Retry After Ms 对应的数据或状态。 */
function getRetryAfterMs(error: APIError): number | null {
  const retryAfter = getRetryAfter(error)
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10)
    if (!isNaN(seconds)) {
      return seconds * 1000
    }
  }
  return null
}

/** 获取 get Rate Limit Reset Delay Ms 对应的数据或状态。 */
function getRateLimitResetDelayMs(error: APIError): number | null {
  const resetHeader = error.headers?.get?.('anthropic-ratelimit-unified-reset')
  if (!resetHeader) return null
  const resetUnixSec = Number(resetHeader)
  if (!Number.isFinite(resetUnixSec)) return null
  const delayMs = resetUnixSec * 1000 - Date.now()
  if (delayMs <= 0) return null
  return Math.min(delayMs, PERSISTENT_RESET_CAP_MS)
}
