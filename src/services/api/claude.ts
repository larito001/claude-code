import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaImageBlockParam,
  BetaJSONOutputFormat,
  BetaMessage,
  BetaMessageDeltaUsage,
  BetaMessageStreamParams,
  BetaOutputConfig,
  BetaRawContentBlockDelta,
  BetaRawMessageStreamEvent,
  BetaRequestDocumentBlock,
  BetaStopReason,
  BetaToolChoiceAuto,
  BetaToolChoiceTool,
  BetaToolResultBlockParam,
  BetaToolResultContentBlockParam,
  BetaToolUnion,
  BetaUsage,
  BetaMessageParam as MessageParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { Stream } from '@anthropic-ai/sdk/streaming.mjs'
import { randomUUID } from 'crypto'
import {
  getAPIProvider,
  isFirstPartyAnthropicBaseUrl,
} from 'src/utils/model/providers.js'
import {
  getAttributionHeader,
  getCLISyspromptPrefix,
} from '../../constants/system.js'
import {
  getEmptyToolPermissionContext,
  type QueryChainTracking,
  type Tool,
  type ToolPermissionContext,
  type Tools,
  toolMatchesName,
} from '../../Tool.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
  UserMessage,
} from '../../types/message.js'
import {
  type CacheScope,
  logAPIPrefix,
  splitSysPromptPrefix,
  toolToAPISchema,
} from '../../utils/api.js'
import {
  getBedrockExtraBodyParamsBetas,
  getMergedBetas,
  getModelBetas,
} from '../../utils/betas.js'
import {
  CAPPED_DEFAULT_MAX_TOKENS,
  getModelMaxOutputTokens,
  getSonnet1mExpTreatmentEnabled,
} from '../../utils/context.js'
import { resolveAppliedEffort } from '../../utils/effort.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import { computeFingerprintFromMessages } from '../../utils/fingerprint.js'
import { logError } from '../../utils/log.js'
import {
  createAssistantAPIErrorMessage,
  createUserMessage,
  ensureToolResultPairing,
  normalizeContentFromAPI,
  normalizeMessagesForAPI,
  stripAdvisorBlocks,
  stripCallerFieldFromAssistantMessage,
  stripToolReferenceBlocksFromUserMessage,
} from '../../utils/messages.js'
import {
  getDefaultOpusModel,
  getDefaultSonnetModel,
  getSmallFastModel,
  isNonCustomOpusModel,
} from '../../utils/model/model.js'
import {
  asSystemPrompt,
  type SystemPrompt,
} from '../../utils/systemPromptType.js'
import { getAPIContextManagement } from '../compact/apiMicrocompact.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const autoModeStateModule = feature('TRANSCRIPT_CLASSIFIER')
  ? (require('../../utils/permissions/autoModeState.js') as typeof import('../../utils/permissions/autoModeState.js'))
  : null

import { feature } from 'src/utils/features.js'
import type { ClientOptions } from '@anthropic-ai/sdk'
import {
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk/error'
import {
  getAfkModeHeaderLatched,
  getFastModeHeaderLatched,
  getLastApiCompletionTimestamp,
  getPromptCache1hAllowlist,
  getPromptCache1hEligible,
  getThinkingClearLatched,
  setAfkModeHeaderLatched,
  setFastModeHeaderLatched,
  setLastMainRequestId,
  setPromptCache1hAllowlist,
  setPromptCache1hEligible,
  setThinkingClearLatched,
} from 'src/bootstrap/state.js'
import {
  AFK_MODE_BETA_HEADER,
  CONTEXT_1M_BETA_HEADER,
  CONTEXT_MANAGEMENT_BETA_HEADER,
  EFFORT_BETA_HEADER,
  FAST_MODE_BETA_HEADER,
  PROMPT_CACHING_SCOPE_BETA_HEADER,
  REDACT_THINKING_BETA_HEADER,
  STRUCTURED_OUTPUTS_BETA_HEADER,
  TASK_BUDGETS_BETA_HEADER,
} from 'src/constants/betas.js'
import type { QuerySource } from 'src/constants/querySource.js'
import type { Notification } from 'src/context/notifications.js'
import { addToTotalSessionCost } from 'src/cost-tracker.js'
import { getFeatureValue } from 'src/services/featureConfig.js'
import type { AgentId } from 'src/types/ids.js'
import {
  ADVISOR_TOOL_INSTRUCTIONS,
  getExperimentAdvisorModels,
  isAdvisorEnabled,
  isValidAdvisorModel,
  modelSupportsAdvisor,
} from 'src/utils/advisor.js'
import { getAgentContext } from 'src/utils/agentContext.js'
import {
  getToolSearchBetaHeader,
  modelSupportsStructuredOutputs,
  shouldIncludeFirstPartyOnlyBetas,
  shouldUseGlobalCacheScope,
} from 'src/utils/betas.js'
import { getMaxThinkingTokensForModel } from 'src/utils/context.js'
import { logForDebugging } from 'src/utils/debug.js'
import { logForDiagnosticsNoPII } from 'src/utils/diagLogs.js'
import { type EffortValue, modelSupportsEffort } from 'src/utils/effort.js'
import {
  isFastModeAvailable,
  isFastModeCooldown,
  isFastModeEnabled,
  isFastModeSupportedByModel,
} from 'src/utils/fastMode.js'
import { returnValue } from 'src/utils/generators.js'
import { headlessProfilerCheckpoint } from 'src/utils/headlessProfiler.js'
import { calculateUSDCost } from 'src/utils/modelCost.js'
import { endQueryProfile, queryCheckpoint } from 'src/utils/queryProfiler.js'
import {
  modelSupportsAdaptiveThinking,
  modelSupportsThinking,
  type ThinkingConfig,
} from 'src/utils/thinking.js'
import {
  extractDiscoveredToolNames,
  isDeferredToolsDeltaEnabled,
  isToolSearchEnabled,
} from 'src/utils/toolSearch.js'
import { API_MAX_MEDIA_PER_REQUEST } from '../../constants/apiLimits.js'
import { ADVISOR_BETA_HEADER } from '../../constants/betas.js'
import {
  formatDeferredToolLine,
  isDeferredTool,
  TOOL_SEARCH_TOOL_NAME,
} from '../../tools/ToolSearchTool/prompt.js'
import { count } from '../../utils/array.js'
import { validateBoundedIntEnvVar } from '../../utils/envValidation.js'
import { safeParseJSON } from '../../utils/json.js'
import { getInferenceProfileBackingModel } from '../../utils/model/bedrock.js'
import {
  normalizeModelStringForAPI,
  parseUserSpecifiedModel,
} from '../../utils/model/model.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { startLLMRequestSpan } from '../../utils/telemetry/sessionTracing.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import { getInitializationStatus } from '../lsp/manager.js'
import { withStreamingVCR, withVCR } from '../vcr.js'
import { CLIENT_REQUEST_ID_HEADER, getAnthropicClient } from './client.js'
import {
  API_ERROR_MESSAGE_PREFIX,
  CUSTOM_OFF_SWITCH_MESSAGE,
  getAssistantMessageFromError,
  getErrorMessageIfRefusal,
} from './errors.js'
import {
  EMPTY_USAGE,
  type GlobalCacheStrategy,
  logAPIError,
  logAPISuccessAndDuration,
  type NonNullableUsage,
} from './logging.js'
import {
  CACHE_TTL_1HOUR_MS,
  checkResponseForCacheBreak,
  recordPromptState,
} from './promptCacheBreakDetection.js'
import {
  CannotRetryError,
  FallbackTriggeredError,
  is529Error,
  type RetryContext,
  withRetry,
} from './withRetry.js'

// 定义表示有效 JSON 值的类型
type JsonValue = string | number | boolean | null | JsonObject | JsonArray
type JsonObject = { [key: string]: JsonValue }
type JsonArray = JsonValue[]

/**
 * 根据 API 请求组装额外的主体参数
 * CLAUDE_CODE_EXTRA_BODY 环境变量（如果存在且在任何测试版上）
 * 标头（主要用于基岩请求）。
 *
 * @param betaHeaders - 要包含在请求中的一组 beta 标头。
 * @returns 表示额外主体参数的 JSON 对象。
 */
export function getExtraBodyParams(betaHeaders?: string[]): JsonObject {
  // 先解析用户额外的身体参数
  const extraBodyStr = process.env.CLAUDE_CODE_EXTRA_BODY
  let result: JsonObject = {}

  if (extraBodyStr) {
    try {
      // 解析为 JSON，可以是 null、boolean、number、string、array 或 object
      const parsed = safeParseJSON(extraBodyStr)
      // 我们期望一个带有键值对的对象传播到 API 参数中
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // 浅克隆 - safeParseJSON 是 LRU 缓存并返回相同的值
        // 同一字符串的对象引用。改变下面的“结果”
        // 会毒害缓存，导致过时的值持续存在。
        result = { ...(parsed as JsonObject) }
      } else {
        logForDebugging(
          `CLAUDE_CODE_EXTRA_BODY env var must be a JSON object, but was given ${extraBodyStr}`,
          { level: 'error' },
        )
      }
    } catch (error) {
      logForDebugging(
        `Error parsing CLAUDE_CODE_EXTRA_BODY: ${errorMessage(error)}`,
        { level: 'error' },
      )
    }
  }

  // 如果提供了beta头，处理它们
  if (betaHeaders && betaHeaders.length > 0) {
    if (result.anthropic_beta && Array.isArray(result.anthropic_beta)) {
      // 添加到现有数组，避免重复
      const existingHeaders = result.anthropic_beta as string[]
      /** 创建 new Headers 对应的数据或状态。 */
      const newHeaders = betaHeaders.filter(
        header => !existingHeaders.includes(header),
      )
      result.anthropic_beta = [...existingHeaders, ...newHeaders]
    } else {
      // 使用beta头创建新数组
      result.anthropic_beta = betaHeaders
    }
  }

  return result
}

/** 获取 get Prompt Caching Enabled 对应的数据或状态。 */
export function getPromptCachingEnabled(model: string): boolean {
  // 全局禁用优先
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING)) return false

  // 检查是否应为小型/快速模型禁用
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING_HAIKU)) {
    const smallFastModel = getSmallFastModel()
    if (model === smallFastModel) return false
  }

  // 检查是否应为默认Sonnet禁用
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING_SONNET)) {
    const defaultSonnet = getDefaultSonnetModel()
    if (model === defaultSonnet) return false
  }

  // 检查是否应为默认Opus禁用
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING_OPUS)) {
    const defaultOpus = getDefaultOpusModel()
    if (model === defaultOpus) return false
  }

  return true
}

/** 获取 get Cache Control 对应的数据或状态。 */
export function getCacheControl({
  scope,
  querySource,
}: {
  scope?: CacheScope
  querySource?: QuerySource
} = {}): {
  type: 'ephemeral'
  ttl?: '1h'
  scope?: CacheScope
} {
  return {
    type: 'ephemeral',
    ...(should1hCacheTTL(querySource) && { ttl: '1h' }),
    ...(scope === 'global' && { scope }),
  }
}

/**
 * 确定是否应对提示缓存使用1小时TTL。
 *
 * 仅在显式启用且查询源匹配配置的白名单时应用。
 * 模式支持末尾的'*'进行前缀匹配。
 * 示例：
 * - { allowlist: ["repl_main_thread*", "sdk"] } — 仅主线程 + SDK
 * - { allowlist: ["repl_main_thread*", "sdk", "agent:*"] } — 还包括子代理
 * - { allowlist: ["*"] } — 所有源
 *
 * 白名单在STATE中缓存以保证会话稳定性——防止请求中途本地功能配置的磁盘缓存更新时出现混合TTL。
 */
function should1hCacheTTL(querySource?: QuerySource): boolean {
  // 3P Bedrock用户在选择通过环境变量加入时获得1小时TTL——他们自行管理计费
  // 不需要本地功能配置门控，因为3P用户没有配置本地功能配置
  if (
    getAPIProvider() === 'bedrock' &&
    isEnvTruthy(process.env.ENABLE_PROMPT_CACHING_1H_BEDROCK)
  ) {
    return true
  }

  // 在引导状态下锁存资格以保证会话稳定性。
  let userEligible = getPromptCache1hEligible()
  if (userEligible === null) {
    userEligible = isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_PROMPT_CACHE_1H)
    setPromptCache1hEligible(userEligible)
  }
  if (!userEligible) return false

  // 在引导状态下缓存白名单以保证会话稳定性——防止请求中途本地功能配置的磁盘缓存更新时出现混合TTL
  let allowlist = getPromptCache1hAllowlist()
  if (allowlist === null) {
    allowlist = (process.env.CLAUDE_CODE_PROMPT_CACHE_1H_SOURCES ?? '*')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
    setPromptCache1hAllowlist(allowlist)
  }

  return (
    querySource !== undefined &&
    allowlist.some(pattern =>
      pattern.endsWith('*')
        ? querySource.startsWith(pattern.slice(0, -1))
        : querySource === pattern,
    )
  )
}

/** 为API请求配置effort参数。 */
function configureEffortParams(
  effortValue: EffortValue | undefined,
  outputConfig: BetaOutputConfig,
  betas: string[],
  model: string,
): void {
  if (!modelSupportsEffort(model) || 'effort' in outputConfig) {
    return
  }

  // Agent SDK 还声明了当前 Messages API 不接受的 `xhigh`；只发送线协议支持的值。
  if (effortValue !== undefined && effortValue !== 'xhigh') {
    outputConfig.effort = effortValue
  }
  betas.push(EFFORT_BETA_HEADER)
}

// output_config.task_budget — API端的模型token预算感知。
// Stainless SDK类型尚未在BetaOutputConfig中包含task_budget，因此我们
// 在本地定义wire形状并进行转换。API在接收时验证；请参见monorepo中的
// 上游定义位置：api/api/schemas/messages/request/output_config.py:12-39。
// Beta: task-budgets-2026-03-13（EAP，截至2026年3月仅适用于claude-strudel-eap）。
type TaskBudgetParam = {
  type: 'tokens'
  total: number
  remaining?: number
}

/** 执行 configure Task Budget Params 对应的业务处理。 */
export function configureTaskBudgetParams(
  taskBudget: Options['taskBudget'],
  outputConfig: BetaOutputConfig & { task_budget?: TaskBudgetParam },
  betas: string[],
): void {
  if (
    !taskBudget ||
    'task_budget' in outputConfig ||
    !shouldIncludeFirstPartyOnlyBetas()
  ) {
    return
  }
  outputConfig.task_budget = {
    type: 'tokens',
    total: taskBudget.total,
    ...(taskBudget.remaining !== undefined && {
      remaining: taskBudget.remaining,
    }),
  }
  if (!betas.includes(TASK_BUDGETS_BETA_HEADER)) {
    betas.push(TASK_BUDGETS_BETA_HEADER)
  }
}

/** 获取 get API Metadata 对应的数据或状态。 */
export function getAPIMetadata() {
  // https://docs.google.com/document/d/1dURO9ycXXQCBS0V4Vhl4poDBRgkelFc5t2BNPoEgH5Q/edit?tab=t.0#heading=h.5g7nec5b09w5
  let extra: JsonObject = {}
  const extraStr = process.env.CLAUDE_CODE_EXTRA_METADATA
  if (extraStr) {
    const parsed = safeParseJSON(extraStr, false)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      extra = parsed as JsonObject
    } else {
      logForDebugging(
        `CLAUDE_CODE_EXTRA_METADATA env var must be a JSON object, but was given ${extraStr}`,
        { level: 'error' },
      )
    }
  }

  return Object.keys(extra).length > 0
    ? { user_id: jsonStringify(extra) }
    : {}
}

/** 校验 verify Api Key 对应的数据或状态。 */
export async function verifyApiKey(
  apiKey: string,
  isNonInteractiveSession: boolean,
): Promise<boolean> {
  // 如果在打印模式下运行（isNonInteractiveSession），则跳过API验证
  if (isNonInteractiveSession) {
    return true
  }

  try {
    // 警告：如果你将其更改为使用非Haiku模型，则此请求在1P中将失败，除非它使用getCLISyspromptPrefix。
    const model = getSmallFastModel()
    const betas = getModelBetas(model)
    return await returnValue(
      withRetry(
        () =>
          getAnthropicClient({
            apiKey,
            maxRetries: 3,
            model,
            source: 'verify_api_key',
          }),
        async anthropic => {
          const messages: MessageParam[] = [{ role: 'user', content: 'test' }]
          // biome-ignore lint/plugin: API key verification is intentionally a minimal direct call
          await anthropic.beta.messages.create({
            model,
            max_tokens: 1,
            messages,
            temperature: 1,
            ...(betas.length > 0 && { betas }),
            metadata: getAPIMetadata(),
            ...getExtraBodyParams(),
          })
          return true
        },
        { maxRetries: 2, model, thinkingConfig: { type: 'disabled' } }, // Use fewer retries for API key verification
      ),
    )
  } catch (errorFromRetry) {
    let error = errorFromRetry
    if (errorFromRetry instanceof CannotRetryError) {
      error = errorFromRetry.originalError
    }
    logError(error)
    // 检查身份验证错误
    if (
      error instanceof Error &&
      error.message.includes(
        '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      )
    ) {
      return false
    }
    throw error
  }
}

/** 执行 user Message To Message Param 对应的业务处理。 */
export function userMessageToMessageParam(
  message: UserMessage,
  addCache = false,
  enablePromptCaching: boolean,
  querySource?: QuerySource,
): MessageParam {
  if (addCache) {
    if (typeof message.message.content === 'string') {
      return {
        role: 'user',
        content: [
          {
            type: 'text',
            text: message.message.content,
            ...(enablePromptCaching && {
              cache_control: getCacheControl({ querySource }),
            }),
          },
        ],
      }
    } else {
      return {
        role: 'user',
        /** 执行 content 对应的业务处理。 */
        content: message.message.content.map(
          (block: BetaContentBlockParam, index: number) => ({
            ...block,
            ...(index === message.message.content.length - 1
              ? enablePromptCaching
                ? { cache_control: getCacheControl({ querySource }) }
                : {}
              : {}),
          }),
        ),
      }
    }
  }
  // 克隆数组内容，以防止缓存控制插入污染由次要查询共享的原始消息。
  return {
    role: 'user',
    content: Array.isArray(message.message.content)
      ? [...message.message.content]
      : message.message.content,
  }
}

/** 执行 assistant Message To Message Param 对应的业务处理。 */
export function assistantMessageToMessageParam(
  message: AssistantMessage,
  addCache = false,
  enablePromptCaching: boolean,
  querySource?: QuerySource,
): MessageParam {
  if (addCache) {
    if (typeof message.message.content === 'string') {
      return {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: message.message.content,
            ...(enablePromptCaching && {
              cache_control: getCacheControl({ querySource }),
            }),
          },
        ],
      }
    } else {
      return {
        role: 'assistant',
        /** 执行 content 对应的业务处理。 */
        content: message.message.content.map(
          (block: BetaContentBlockParam, index: number) => ({
            ...block,
            ...(index === message.message.content.length - 1 &&
            block.type !== 'thinking' &&
            block.type !== 'redacted_thinking'
              ? enablePromptCaching
                ? { cache_control: getCacheControl({ querySource }) }
                : {}
              : {}),
          }),
        ),
      }
    }
  }
  return {
    role: 'assistant',
    content: message.message.content,
  }
}

export type Options = {
  /** 获取 get Tool Permission Context 对应的数据或状态。 */
  getToolPermissionContext: () => Promise<ToolPermissionContext>
  model: string
  toolChoice?: BetaToolChoiceTool | BetaToolChoiceAuto | undefined
  isNonInteractiveSession: boolean
  extraToolSchemas?: BetaToolUnion[]
  maxOutputTokensOverride?: number
  fallbackModel?: string
  /** 处理 on Streaming Fallback 对应的数据或状态。 */
  onStreamingFallback?: () => void
  querySource: QuerySource
  agents: AgentDefinition[]
  allowedAgentTypes?: string[]
  hasAppendSystemPrompt: boolean
  fetchOverride?: ClientOptions['fetch']
  enablePromptCaching?: boolean
  skipCacheWrite?: boolean
  temperatureOverride?: number
  effortValue?: EffortValue
  mcpTools: Tools
  hasPendingMcpServers?: boolean
  queryTracking?: QueryChainTracking
  agentId?: AgentId // 仅对子代理设置
  outputFormat?: BetaJSONOutputFormat
  fastMode?: boolean
  advisorModel?: string
  /** 添加或注册 add Notification 对应的数据或状态。 */
  addNotification?: (notif: Notification) => void
  // API端任务预算（output_config.task_budget）。与
  // tokenBudget.ts +500k自动继续功能不同——此预算发送给API
  // 以便模型可以自我调节。`remaining`由调用者计算
  // （query.ts在代理循环中递减）。
  taskBudget?: { total: number; remaining?: number }
}

/** 执行 query Model Without Streaming 对应的业务处理。 */
export async function queryModelWithoutStreaming({
  messages,
  systemPrompt,
  thinkingConfig,
  tools,
  signal,
  options,
}: {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: ThinkingConfig
  tools: Tools
  signal: AbortSignal
  options: Options
}): Promise<AssistantMessage> {
  // 存储助手消息但继续消费生成器以确保
  // logAPISuccessAndDuration被调用（这发生在所有yield之后）
  let assistantMessage: AssistantMessage | undefined
  for await (const message of withStreamingVCR(messages, async function* () {
    yield* queryModel(
      messages,
      systemPrompt,
      thinkingConfig,
      tools,
      signal,
      options,
    )
  })) {
    if (message.type === 'assistant') {
      assistantMessage = message
    }
  }
  if (!assistantMessage) {
    // 如果信号被中止，则抛出APIUserAbortError而不是通用错误
    // 这允许调用者优雅地处理中止场景
    if (signal.aborted) {
      throw new APIUserAbortError()
    }
    throw new Error('No assistant message found')
  }
  return assistantMessage
}

/** 执行 query Model With Streaming 对应的业务处理。 */
export async function* queryModelWithStreaming({
  messages,
  systemPrompt,
  thinkingConfig,
  tools,
  signal,
  options,
}: {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: ThinkingConfig
  tools: Tools
  signal: AbortSignal
  options: Options
}): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage,
  void
> {
  return yield* withStreamingVCR(messages, async function* () {
    yield* queryModel(
      messages,
      systemPrompt,
      thinkingConfig,
      tools,
      signal,
      options,
    )
  })
}

/**
 * 确定是否应延迟LSP工具（工具出现时带有defer_loading: true）
 * 因为LSP初始化尚未完成。
 */
function shouldDeferLspTool(tool: Tool): boolean {
  if (!('isLsp' in tool) || !tool.isLsp) {
    return false
  }
  const status = getInitializationStatus()
  // 在挂起或未启动时延迟
  return status.status === 'pending' || status.status === 'not-started'
}

/**
 * 非流式回退请求的每次尝试超时时间，以毫秒为单位。
 * 当设置了API_TIMEOUT_MS时读取该值，以便慢速后端和流式路径
 * 共享相同的上限。
 *
 * （约5分钟）因此，对挂起的后端进行回退时，将引发清晰的
 * APIConnectionTimeoutError，而不是在SIGKILL之前一直停滞。
 *
 * 否则默认为300秒——足够长以应对慢速后端，同时不超过API的10分钟非流式边界。
 */
function getNonstreamingFallbackTimeoutMs(): number {
  const override = parseInt(process.env.API_TIMEOUT_MS || '', 10)
  if (override) return override
  return 300_000
}

/** 非流式 API 请求的辅助生成器。封装了创建 withRetry 生成器的常见模式，迭代生成系统消息，并返回最终的 BetaMessage。 */
export async function* executeNonStreamingRequest(
  clientOptions: {
    model: string
    fetchOverride?: Options['fetchOverride']
    source: string
  },
  retryOptions: {
    model: string
    fallbackModel?: string
    thinkingConfig: ThinkingConfig
    fastMode?: boolean
    signal: AbortSignal
    initialConsecutive529Errors?: number
    querySource?: QuerySource
  },
  paramsFromContext: (context: RetryContext) => BetaMessageStreamParams,
  onAttempt: (attempt: number, start: number, maxOutputTokens: number) => void,
): AsyncGenerator<SystemAPIErrorMessage, BetaMessage> {
  const fallbackTimeoutMs = getNonstreamingFallbackTimeoutMs()
  /** 执行 generator 对应的业务处理。 */
  const generator = withRetry(
    () =>
      getAnthropicClient({
        maxRetries: 0,
        model: clientOptions.model,
        fetchOverride: clientOptions.fetchOverride,
        source: clientOptions.source,
      }),
    async (anthropic, attempt, context) => {
      const start = Date.now()
      const retryParams = paramsFromContext(context)
      onAttempt(attempt, start, retryParams.max_tokens)

      const adjustedParams = adjustParamsForNonStreaming(
        retryParams,
        MAX_NON_STREAMING_TOKENS,
      )

      try {
        // biome-ignore lint/plugin: non-streaming API call
        return await anthropic.beta.messages.create(
          {
            ...adjustedParams,
            model: normalizeModelStringForAPI(adjustedParams.model),
          },
          {
            signal: retryOptions.signal,
            timeout: fallbackTimeoutMs,
          },
        )
      } catch (err) {
        // 用户中止不是错误——立即重新抛出，不记录日志
        if (err instanceof APIUserAbortError) throw err

        // 仪表化：记录非流式请求出错（包括超时）时。使我们能够区分“回退挂起超过容器终止”（无事件）和“回退达到有界超时”（此事件）。
        logForDiagnosticsNoPII('error', 'cli_nonstreaming_fallback_error')
        throw err
      }
    },
    {
      model: retryOptions.model,
      fallbackModel: retryOptions.fallbackModel,
      thinkingConfig: retryOptions.thinkingConfig,
      ...(isFastModeEnabled() && { fastMode: retryOptions.fastMode }),
      signal: retryOptions.signal,
      initialConsecutive529Errors: retryOptions.initialConsecutive529Errors,
      querySource: retryOptions.querySource,
    },
  )

  let e
  do {
    e = await generator.next()
    if (!e.done && e.value.type === 'system') {
      yield e.value
    }
  } while (!e.done)

  return e.value as BetaMessage
}

/** 判断是否满足 is Media 对应的数据或状态。 */
function isMedia(
  block: BetaContentBlockParam | BetaToolResultContentBlockParam,
): block is BetaImageBlockParam | BetaRequestDocumentBlock {
  return block.type === 'image' || block.type === 'document'
}

/** 判断是否满足 is Tool Result 对应的数据或状态。 */
function isToolResult(
  block: BetaContentBlockParam,
): block is BetaToolResultBlockParam {
  return block.type === 'tool_result'
}

/**
 * 将一条流式内容增量合并到对应内容块，并校验事件与内容块类型是否匹配。
 * 集中处理该联合类型可以在 SDK 新增增量类型时触发编译错误，避免静默丢数据。
 */
export function applyContentBlockDelta(
  contentBlock: BetaContentBlock,
  delta: BetaRawContentBlockDelta,
): void {
  switch (delta.type) {
    case 'citations_delta':
      if (contentBlock.type !== 'text') {
        throw new Error('Content block is not a text block')
      }
      contentBlock.citations = [
        ...(contentBlock.citations ?? []),
        delta.citation,
      ]
      return
    case 'input_json_delta':
      if (
        contentBlock.type !== 'tool_use' &&
        contentBlock.type !== 'server_tool_use' &&
        contentBlock.type !== 'mcp_tool_use'
      ) {
        throw new Error('Content block is not an input JSON block')
      }
      if (typeof contentBlock.input !== 'string') {
        throw new Error('Content block input is not a string')
      }
      contentBlock.input += delta.partial_json
      return
    case 'text_delta':
      if (contentBlock.type !== 'text') {
        throw new Error('Content block is not a text block')
      }
      contentBlock.text += delta.text
      return
    case 'signature_delta':
      if (contentBlock.type !== 'thinking') {
        throw new Error('Content block is not a thinking block')
      }
      contentBlock.signature = delta.signature
      return
    case 'thinking_delta':
      if (contentBlock.type !== 'thinking') {
        throw new Error('Content block is not a thinking block')
      }
      contentBlock.thinking += delta.thinking
      return
    case 'compaction_delta':
      if (contentBlock.type !== 'compaction') {
        throw new Error('Content block is not a compaction block')
      }
      contentBlock.content =
        delta.content === null
          ? null
          : `${contentBlock.content ?? ''}${delta.content}`
      return
  }
}

/** 确保消息最多包含 `limit` 个媒体项（图片 + 文档）。首先移除最旧的媒体以保留最新内容。 */
export function stripExcessMediaItems(
  messages: (UserMessage | AssistantMessage)[],
  limit: number,
): (UserMessage | AssistantMessage)[] {
  let toRemove = 0
  for (const msg of messages) {
    if (!Array.isArray(msg.message.content)) continue
    for (const block of msg.message.content) {
      if (isMedia(block)) toRemove++
      if (isToolResult(block) && Array.isArray(block.content)) {
        for (const nested of block.content) {
          if (isMedia(nested)) toRemove++
        }
      }
    }
  }
  toRemove -= limit
  if (toRemove <= 0) return messages

  return messages.map(msg => {
    if (toRemove <= 0) return msg
    const content = msg.message.content
    if (!Array.isArray(content)) return msg

    const before = toRemove
    /** 执行 stripped 对应的业务处理。 */
    const stripped = content
      .map(block => {
        if (
          toRemove <= 0 ||
          !isToolResult(block) ||
          !Array.isArray(block.content)
        )
          return block
        /** 整理 filtered 对应的数据或状态。 */
        const filtered = block.content.filter(n => {
          if (toRemove > 0 && isMedia(n)) {
            toRemove--
            return false
          }
          return true
        })
        return filtered.length === block.content.length
          ? block
          : { ...block, content: filtered }
      })
      .filter(block => {
        if (toRemove > 0 && isMedia(block)) {
          toRemove--
          return false
        }
        return true
      })

    return before === toRemove
      ? msg
      : {
          ...msg,
          message: { ...msg.message, content: stripped },
        }
  }) as (UserMessage | AssistantMessage)[]
}

/** 执行 query Model 对应的业务处理。 */
async function* queryModel(
  messages: Message[],
  systemPrompt: SystemPrompt,
  thinkingConfig: ThinkingConfig,
  tools: Tools,
  signal: AbortSignal,
  options: Options,
): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage,
  void
> {
  // 先检查低成本条件。对于非 Opus 模型，这完全跳过本地关闭开关配置查找。
  if (
    isNonCustomOpusModel(options.model) &&
    (
      await getFeatureValue<{ activated: boolean }>(
        'tengu-off-switch',
        {
          activated: false,
        },
      )
    ).activated
  ) {
    yield getAssistantMessageFromError(
      new Error(CUSTOM_OFF_SWITCH_MESSAGE),
      options.model,
    )
    return
  }

  // 从查询链中的最后一条 assistant 消息派生出上一个请求 ID。这限定在每个消息数组中（主线程、子代理、队友各自拥有自己的），因此并发代理不会互相干扰请求链追踪。同时也自然处理回滚/撤销，因为已移除的消息不会出现在数组中。

  const resolvedModel =
    getAPIProvider() === 'bedrock' &&
    options.model.includes('application-inference-profile')
      ? ((await getInferenceProfileBackingModel(options.model)) ??
        options.model)
      : options.model

  queryCheckpoint('query_tool_schema_build_start')
  const isAgenticQuery =
    options.querySource.startsWith('repl_main_thread') ||
    options.querySource.startsWith('agent:') ||
    options.querySource === 'sdk' ||
    options.querySource === 'hook_agent' ||
    options.querySource === 'verification_agent'
  const betas = getMergedBetas(options.model, { isAgenticQuery })

  // 当 advisor 启用时，始终发送 advisor beta 标头，以便非代理查询（compact、side_question、extract_memories 等）可以解析对话历史中已有的 advisor server_tool_use 块。
  if (isAdvisorEnabled()) {
    betas.push(ADVISOR_BETA_HEADER)
  }

  let advisorModel: string | undefined
  if (isAgenticQuery && isAdvisorEnabled()) {
    let advisorOption = options.advisorModel

    const advisorExperiment = getExperimentAdvisorModels()
    if (advisorExperiment !== undefined) {
      if (
        normalizeModelStringForAPI(advisorExperiment.baseModel) ===
        normalizeModelStringForAPI(options.model)
      ) {
        // 如果基础模型匹配，则覆盖 advisor 模型。只有当用户无法自行配置时，才应使用实验模型。
        advisorOption = advisorExperiment.advisorModel
      }
    }

    if (advisorOption) {
      const normalizedAdvisorModel = normalizeModelStringForAPI(
        parseUserSpecifiedModel(advisorOption),
      )
      if (!modelSupportsAdvisor(options.model)) {
        logForDebugging(
          `[AdvisorTool] Skipping advisor - base model ${options.model} does not support advisor`,
        )
      } else if (!isValidAdvisorModel(normalizedAdvisorModel)) {
        logForDebugging(
          `[AdvisorTool] Skipping advisor - ${normalizedAdvisorModel} is not a valid advisor model`,
        )
      } else {
        advisorModel = normalizedAdvisorModel
        logForDebugging(
          `[AdvisorTool] Server-side tool enabled with ${advisorModel} as the advisor model`,
        )
      }
    }
  }

  // 检查工具搜索是否启用（检查模式、模型支持以及自动模式的阈值）。这是异步的，因为可能需要为 TstAuto 模式计算 MCP 工具描述大小。
  let useToolSearch = await isToolSearchEnabled(
    options.model,
    tools,
    options.getToolPermissionContext,
    options.agents,
    'query',
  )

  // 一次预计算——isDeferredTool 每次调用会执行两次本地特性配置查找。
  const deferredToolNames = new Set<string>()
  if (useToolSearch) {
    for (const t of tools) {
      if (isDeferredTool(t)) deferredToolNames.add(t.name)
    }
  }

  // 即使工具搜索模式已启用，如果没有延迟工具且没有 MCP 服务器仍在连接中，则跳过。当服务器处于待连接状态时，保持 ToolSearch 可用，以便模型在它们连接后可以发现工具。
  if (
    useToolSearch &&
    deferredToolNames.size === 0 &&
    !options.hasPendingMcpServers
  ) {
    logForDebugging(
      'Tool search disabled: no deferred tools available to search',
    )
    useToolSearch = false
  }

  // 如果此模型未启用工具搜索，则过滤掉 ToolSearchTool。ToolSearchTool 返回 tool_reference 块，不支持的工具搜索的模型无法处理这些块。
  let filteredTools: Tools

  if (useToolSearch) {
    // 动态工具加载：仅包含通过消息历史中的 tool_reference 块发现延迟工具。这消除了预先声明所有延迟工具的需要，并移除了工具数量的限制。
    const discoveredToolNames = extractDiscoveredToolNames(messages)

    filteredTools = tools.filter(tool => {
      // 始终包含非延迟工具
      if (!deferredToolNames.has(tool.name)) return true
      // 始终包含 ToolSearchTool（以便它可以发现更多工具）
      if (toolMatchesName(tool, TOOL_SEARCH_TOOL_NAME)) return true
      // 仅包含已发现的延迟工具
      return discoveredToolNames.has(tool.name)
    })
  } else {
    filteredTools = tools.filter(
      t => !toolMatchesName(t, TOOL_SEARCH_TOOL_NAME),
    )
  }

  // 如果启用，添加工具搜索 beta 标头——这是接受 defer_loading 所必需的。标头因提供商而异：1P/Foundry 使用 advanced-tool-use，Vertex/Bedrock 使用 tool-search-tool。对于 Bedrock，此标头必须放在 extraBodyParams 中，而不是 betas 数组中。
  const toolSearchHeader = useToolSearch ? getToolSearchBetaHeader() : null
  if (toolSearchHeader && getAPIProvider() !== 'bedrock') {
    if (!betas.includes(toolSearchHeader)) {
      betas.push(toolSearchHeader)
    }
  }

  const useGlobalCacheFeature = shouldUseGlobalCacheScope()
  /** 执行 will Defer 对应的业务处理。 */
  const willDefer = (t: Tool) =>
    useToolSearch && (deferredToolNames.has(t.name) || shouldDeferLspTool(t))
  // MCP 工具是每个用户的→动态工具部分→无法全局缓存。仅在 MCP 工具实际渲染时进行门控（不是 defer_loading）。
  const needsToolBasedCacheMarker =
    useGlobalCacheFeature &&
    filteredTools.some(t => t.isMcp === true && !willDefer(t))

  // 确保在启用全局缓存时存在 prompt_caching_scope beta 标头。
  if (
    useGlobalCacheFeature &&
    !betas.includes(PROMPT_CACHING_SCOPE_BETA_HEADER)
  ) {
    betas.push(PROMPT_CACHING_SCOPE_BETA_HEADER)
  }

  // 确定用于日志记录的全局缓存策略
  const globalCacheStrategy: GlobalCacheStrategy = useGlobalCacheFeature
    ? needsToolBasedCacheMarker
      ? 'none'
      : 'system_prompt'
    : 'none'

  // 构建工具模式，当工具搜索启用时为 MCP 工具添加 defer_loading。注意：我们将完整的 `tools` 列表（而非 filteredTools）传递给 toolToAPISchema，以便 ToolSearchTool 的提示可以列出所有可用的 MCP 工具。过滤仅影响实际发送给 API 的工具，不影响模型在工具描述中看到的内容。
  const toolSchemas = await Promise.all(
    filteredTools.map(tool =>
      toolToAPISchema(tool, {
        getToolPermissionContext: options.getToolPermissionContext,
        tools,
        agents: options.agents,
        allowedAgentTypes: options.allowedAgentTypes,
        model: options.model,
        deferLoading: willDefer(tool),
      }),
    ),
  )

  if (useToolSearch) {
    /** 执行 included Deferred Tools 对应的业务处理。 */
    const includedDeferredTools = count(filteredTools, t =>
      deferredToolNames.has(t.name),
    )
    logForDebugging(
      `Dynamic tool loading: ${includedDeferredTools}/${deferredToolNames.size} deferred tools included`,
    )
  }

  queryCheckpoint('query_tool_schema_build_end')

  // 在构建系统提示之前规范化消息（用于指纹识别所需）
  queryCheckpoint('query_message_normalization_start')
  let messagesForAPI = normalizeMessagesForAPI(messages, filteredTools)
  queryCheckpoint('query_message_normalization_end')

  // 模型特定的后处理：如果所选模型不支持工具搜索，则剥离工具搜索相关字段。
  //
  // 为什么在 normalizeMessagesForAPI 之外还需要这个？
  // - normalizeMessagesForAPI 使用 isToolSearchEnabledNoModelCheck()，因为它被从许多上下文调用，其中一些没有模型上下文。将其签名中添加模型将是一个大型重构。
  // - 此后处理使用模型感知的 isToolSearchEnabled() 检查
  // - 这处理对话中模型切换（例如 Sonnet → Haiku）的情况，其中来自前一模型的过时工具搜索字段会导致 400 错误
  //
  // 注意：对于 assistant 消息，normalizeMessagesForAPI 已经规范化了工具输入，因此 stripCallerFieldFromAssistantMessage 只需要删除 'caller' 字段（不需要重新规范化输入）。
  if (!useToolSearch) {
    messagesForAPI = messagesForAPI.map(msg => {
      switch (msg.type) {
        case 'user':
          // 从 tool_result 内容中剥离 tool_reference 块
          return stripToolReferenceBlocksFromUserMessage(msg)
        case 'assistant':
          // 从 tool_use 块中剥离 'caller' 字段
          return stripCallerFieldFromAssistantMessage(msg)
        default:
          return msg
      }
    })
  }

  // 修复在恢复 tool_use 时可能发生的 tool_use/tool_result 配对错乱，并剥离引用不存在 tool_use 的孤立 tool_result。
  messagesForAPI = ensureToolResultPairing(messagesForAPI)

  // 剥离 advisor 块——如果没有 beta 标头，API 会拒绝它们。
  if (!betas.includes(ADVISOR_BETA_HEADER)) {
    messagesForAPI = stripAdvisorBlocks(messagesForAPI)
  }

  // 在发起 API 调用前剥离多余的媒体项。API 会拒绝包含超过 100 个媒体项的请求，但返回令人困惑的错误。为了避免报错（在 Cowork/CCD 中很难从其恢复），我们静默地丢弃最旧的媒体项以保持在限制内。
  messagesForAPI = stripExcessMediaItems(
    messagesForAPI,
    API_MAX_MEDIA_PER_REQUEST,
  )

  // 从第一条用户消息计算请求归属指纹。必须在注入合成消息（例如 deferred tool names）之前运行，以便指纹反映实际用户输入。
  const fingerprint = computeFingerprintFromMessages(messagesForAPI)

  // 当增量附件启用时，通过持久化的 deferred_tools_delta 附件宣告延迟工具，而不是通过此临时前置项（只要池发生变化就会破坏缓存）。
  if (useToolSearch && !isDeferredToolsDeltaEnabled()) {
    const deferredToolList = tools
      .filter(t => deferredToolNames.has(t.name))
      .map(formatDeferredToolLine)
      .sort()
      .join('\n')
    if (deferredToolList) {
      messagesForAPI = [
        createUserMessage({
          content: `<available-deferred-tools>\n${deferredToolList}\n</available-deferred-tools>`,
          isMeta: true,
        }),
        ...messagesForAPI,
      ]
    }
  }

  // filter(Boolean) 通过将每个元素转换为布尔值来工作——空字符串变为 false 并被过滤掉。
  systemPrompt = asSystemPrompt(
    [
      getAttributionHeader(fingerprint),
      getCLISyspromptPrefix({
        isNonInteractive: options.isNonInteractiveSession,
        hasAppendSystemPrompt: options.hasAppendSystemPrompt,
      }),
      ...systemPrompt,
      ...(advisorModel ? [ADVISOR_TOOL_INSTRUCTIONS] : []),
    ].filter(Boolean),
  )

  // 前置系统提示块以便于 API 识别
  logAPIPrefix(systemPrompt)

  const enablePromptCaching =
    options.enablePromptCaching ?? getPromptCachingEnabled(options.model)
  const system = buildSystemPromptBlocks(systemPrompt, enablePromptCaching, {
    skipGlobalCacheForSystemPrompt: needsToolBasedCacheMarker,
    querySource: options.querySource,
  })
  const useBetas = betas.length > 0

  // 构建用于详细跟踪的最小上下文（当 beta 跟踪启用时）注意：实际的新上下文 (new_context) 消息提取是在 sessionTracing.ts 中完成的，基于 messagesForAPI 数组中的 querySource（代理）使用基于哈希的跟踪。
  const extraToolSchemas = [...(options.extraToolSchemas ?? [])]
  if (advisorModel) {
    // 根据 API 约定，服务器工具必须位于 tools 数组中。在 toolSchemas（携带 cache_control 标记）之后追加，以便切换 /advisor 仅搅动小的后缀，不会搅动缓存的先前部分。
    extraToolSchemas.push({
      type: 'advisor_20260301',
      name: 'advisor',
      model: advisorModel,
    } as unknown as BetaToolUnion)
  }
  const allTools = [...toolSchemas, ...extraToolSchemas]

  const isFastMode =
    isFastModeEnabled() &&
    isFastModeAvailable() &&
    !isFastModeCooldown() &&
    isFastModeSupportedByModel(options.model) &&
    !!options.fastMode

  // 动态 beta 标头的持久开启锁存。每个标头一旦首次发送，就会在整个会话的剩余时间内持续发送，以便会话中的切换不会改变服务器端缓存键并破坏约 50-70K 的令牌。锁存在 /clear 和 /compact 时通过 clearBetaHeaderLatches() 清除。每次调用的门控（isAgenticQuery, querySource===repl_main_thread）保持每次调用独立，因此非代理查询保持其自己的稳定标头集。

  let afkHeaderLatched = getAfkModeHeaderLatched() === true
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    if (
      !afkHeaderLatched &&
      isAgenticQuery &&
      shouldIncludeFirstPartyOnlyBetas() &&
      (autoModeStateModule?.isAutoModeActive() ?? false)
    ) {
      afkHeaderLatched = true
      setAfkModeHeaderLatched(true)
    }
  }

  let fastModeHeaderLatched = getFastModeHeaderLatched() === true
  if (!fastModeHeaderLatched && isFastMode) {
    fastModeHeaderLatched = true
    setFastModeHeaderLatched(true)
  }

  // 仅从代理查询进行锁存，以便分类器调用不会在回合中翻转主线程的 context_management。
  let thinkingClearLatched = getThinkingClearLatched() === true
  if (!thinkingClearLatched && isAgenticQuery) {
    const lastCompletion = getLastApiCompletionTimestamp()
    if (
      lastCompletion !== null &&
      Date.now() - lastCompletion > CACHE_TTL_1HOUR_MS
    ) {
      thinkingClearLatched = true
      setThinkingClearLatched(true)
    }
  }

  const effort = resolveAppliedEffort(options.model, options.effortValue)

  if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
    // 从哈希中排除 defer_loading 工具——API 会将其从提示中剥离，因此它们永远不会影响实际的缓存键。包含它们会在发现工具或 MCP 服务器重新连接时产生误报的“工具模式已更改”的断点。
    const toolsForCacheDetection = allTools.filter(
      t => !('defer_loading' in t && t.defer_loading),
    )
    // 捕获所有可能影响服务器端缓存键的因素。传递锁存的标头值（非实时状态），以便断点检测反映我们实际发送的内容，而不是用户切换的内容。
    recordPromptState({
      system,
      toolSchemas: toolsForCacheDetection,
      querySource: options.querySource,
      model: options.model,
      agentId: options.agentId,
      fastMode: fastModeHeaderLatched,
      globalCacheStrategy,
      betas,
      autoModeActive: afkHeaderLatched,
      effortValue: effort,
      extraBodyParams: getExtraBodyParams(),
    })
  }

  // 捕获 span 以便稍后将其传递给 endLLMRequestSpan。这确保在多个请求并行运行时，响应与正确的请求匹配。
  const llmSpan = startLLMRequestSpan(
    options.model,
    options.querySource,
    isFastMode,
  )

  const startIncludingRetries = Date.now()
  let start = Date.now()
  let attemptNumber = 0
  const attemptStartTimes: number[] = []
  let stream: Stream<BetaRawMessageStreamEvent> | undefined = undefined
  let streamRequestId: string | null | undefined = undefined
  let clientRequestId: string | undefined = undefined
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins -- Response is available in Node 18+ and is used by the SDK
  let streamResponse: Response | undefined = undefined

  // 释放所有流资源以防止原生内存泄漏。Response 对象持有位于 V8 堆之外的原生 TLS/套接字缓冲区（在 Node.js/npm 路径上观察到；参见 GH #32920），因此无论生成器如何退出，我们都必须显式取消并释放它。
  function releaseStreamResources(): void {
    cleanupStream(stream)
    stream = undefined
    if (streamResponse) {
      streamResponse.body?.cancel().catch(() => {})
      streamResponse = undefined
    }
  }

  // 捕获最后一次 API 请求中发送的 beta 版本，包括动态添加的那些，以便我们可以记录并发送到遥测。
  let lastRequestBetas: string[] | undefined

  /** 执行 params From Context 对应的业务处理。 */
  const paramsFromContext = (retryContext: RetryContext) => {
    const betasParams = [...betas]

    // 为 Sonnet 1M 实验动态追加 1M beta。
    if (
      !betasParams.includes(CONTEXT_1M_BETA_HEADER) &&
      getSonnet1mExpTreatmentEnabled(retryContext.model)
    ) {
      betasParams.push(CONTEXT_1M_BETA_HEADER)
    }

    // 对于 Bedrock，包括基于模型的 beta 和动态添加的工具搜索标头。
    const bedrockBetas =
      getAPIProvider() === 'bedrock'
        ? [
            ...getBedrockExtraBodyParamsBetas(retryContext.model),
            ...(toolSearchHeader ? [toolSearchHeader] : []),
          ]
        : []
    const extraBodyParams = getExtraBodyParams(bedrockBetas)

    const outputConfig: BetaOutputConfig = {
      ...((extraBodyParams.output_config as BetaOutputConfig) ?? {}),
    }

    configureEffortParams(
      effort,
      outputConfig,
      betasParams,
      options.model,
    )

    configureTaskBudgetParams(
      options.taskBudget,
      outputConfig as BetaOutputConfig & { task_budget?: TaskBudgetParam },
      betasParams,
    )

    // 将 outputFormat 合并到 extraBodyParams.output_config 中，连同 effort 一起。需要每个 SDK 的结构化输出 beta 标头（参见 messages.mjs 中的 parse()）。
    if (options.outputFormat && !('format' in outputConfig)) {
      outputConfig.format = options.outputFormat as BetaJSONOutputFormat
      // 如果尚未存在且提供商支持，则添加 beta 标头。
      if (
        modelSupportsStructuredOutputs(options.model) &&
        !betasParams.includes(STRUCTURED_OUTPUTS_BETA_HEADER)
      ) {
        betasParams.push(STRUCTURED_OUTPUTS_BETA_HEADER)
      }
    }

    // 重试上下文优先，因为如果我们超出上下文窗口限制，它会尝试纠正方向。
    const maxOutputTokens =
      retryContext?.maxTokensOverride ||
      options.maxOutputTokensOverride ||
      getMaxOutputTokensForModel(options.model)

    const hasThinking =
      thinkingConfig.type !== 'disabled' &&
      !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_THINKING)
    let thinking: BetaMessageStreamParams['thinking'] | undefined = undefined

    // 当所选模型支持自适应思考时，优先使用自适应思考；否则使用配置的令牌预算。
    if (hasThinking && modelSupportsThinking(options.model)) {
      if (
        !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING) &&
        modelSupportsAdaptiveThinking(options.model)
      ) {
        // 对于支持自适应思考的模型，始终使用无预算的自适应思考。
        thinking = {
          type: 'adaptive',
        } satisfies BetaMessageStreamParams['thinking']
      } else {
        // 对于不支持自适应思考的模型，除非明确指定，否则使用默认的思考预算。
        let thinkingBudget = getMaxThinkingTokensForModel(options.model)
        if (
          thinkingConfig.type === 'enabled' &&
          thinkingConfig.budgetTokens !== undefined
        ) {
          thinkingBudget = thinkingConfig.budgetTokens
        }
        thinkingBudget = Math.min(maxOutputTokens - 1, thinkingBudget)
        thinking = {
          budget_tokens: thinkingBudget,
          type: 'enabled',
        } satisfies BetaMessageStreamParams['thinking']
      }
    }

    // 如果启用，获取API上下文管理策略
    const contextManagement = getAPIContextManagement({
      hasThinking,
      isRedactThinkingActive: betasParams.includes(REDACT_THINKING_BETA_HEADER),
      clearAllThinking: thinkingClearLatched,
    })

    const enablePromptCaching =
      options.enablePromptCaching ?? getPromptCachingEnabled(retryContext.model)

    // 快速模式：头部锁定为会话稳定（缓存安全），但 `speed='fast'` 保持动态，因此冷却仍会抑制实际的快速模式请求，而不会更改缓存键。
    let speed: BetaMessageStreamParams['speed']
    const isFastModeForRetry =
      isFastModeEnabled() &&
      isFastModeAvailable() &&
      !isFastModeCooldown() &&
      isFastModeSupportedByModel(options.model) &&
      !!retryContext.fastMode
    if (isFastModeForRetry) {
      speed = 'fast'
    }
    if (fastModeHeaderLatched && !betasParams.includes(FAST_MODE_BETA_HEADER)) {
      betasParams.push(FAST_MODE_BETA_HEADER)
    }

    // AFK模式测试版：一旦自动模式首次激活即锁定。仍由每次调用中的isAgenticQuery控制，因此分类器/压缩不会获得它。
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      if (
        afkHeaderLatched &&
        shouldIncludeFirstPartyOnlyBetas() &&
        isAgenticQuery &&
        !betasParams.includes(AFK_MODE_BETA_HEADER)
      ) {
        betasParams.push(AFK_MODE_BETA_HEADER)
      }
    }

    // 仅在思考禁用时发送temperature参数——API在思考启用时要求temperature:1，这已经是默认值。
    const temperature = !hasThinking
      ? (options.temperatureOverride ?? 1)
      : undefined

    lastRequestBetas = betasParams

    return {
      model: normalizeModelStringForAPI(options.model),
      messages: addCacheBreakpoints(
        messagesForAPI,
        enablePromptCaching,
        options.querySource,
        options.skipCacheWrite,
      ),
      system,
      tools: allTools,
      tool_choice: options.toolChoice,
      ...(useBetas && { betas: betasParams }),
      metadata: getAPIMetadata(),
      max_tokens: maxOutputTokens,
      thinking,
      ...(temperature !== undefined && { temperature }),
      ...(contextManagement &&
        useBetas &&
        betasParams.includes(CONTEXT_MANAGEMENT_BETA_HEADER) && {
          context_management: contextManagement,
        }),
      ...extraBodyParams,
      ...(Object.keys(outputConfig).length > 0 && {
        output_config: outputConfig,
      }),
      ...(speed !== undefined && { speed }),
    }
  }

  const newMessages: AssistantMessage[] = []
  let ttftMs = 0
  let partialMessage: BetaMessage | undefined = undefined
  const contentBlocks: BetaContentBlock[] = []
  let usage: NonNullableUsage = EMPTY_USAGE
  let costUSD = 0
  let stopReason: BetaStopReason | null = null
  let didFallBackToNonStreaming = false
  let fallbackMessage: AssistantMessage | undefined
  let maxOutputTokens = 0
  let responseHeaders: globalThis.Headers | undefined = undefined
  let isFastModeRequest = isFastMode // 保持单独的状态，因为回退时它可能会改变

  try {
    queryCheckpoint('query_client_creation_start')
    /** 执行 generator 对应的业务处理。 */
    const generator = withRetry(
      () =>
        getAnthropicClient({
          maxRetries: 0, // Disabled auto-retry in favor of manual implementation
          model: options.model,
          fetchOverride: options.fetchOverride,
          source: options.querySource,
        }),
      async (anthropic, attempt, context) => {
        attemptNumber = attempt
        isFastModeRequest = context.fastMode ?? false
        start = Date.now()
        attemptStartTimes.push(start)
        // 客户端已由withRetry的getClient()调用创建。每次尝试触发一次；在重试时，客户端通常被缓存（withRetry仅在认证错误后再次调用getClient()），因此从client_creation_start开始的增量在第一次尝试时有意义。
        queryCheckpoint('query_client_creation_end')

        const params = paramsFromContext(context)
        maxOutputTokens = params.max_tokens

        // 在fetch发起之前立即触发。下面的.withResponse()会等待直到响应头到达，因此这必须在await之前，否则"网络TTFB"阶段测量会出错。
        queryCheckpoint('query_api_request_sent')
        if (!options.agentId) {
          headlessProfilerCheckpoint('api_request_sent')
        }

        // 生成并跟踪客户端请求ID，以便超时（不返回服务器请求ID）仍能与服务器日志关联。仅限第一方——第三方供应商不会记录它（inc-4029类）。
        clientRequestId =
          getAPIProvider() === 'firstParty' && isFirstPartyAnthropicBaseUrl()
            ? randomUUID()
            : undefined

        // 使用原始流而非BetaMessageStream以避免O(n²)部分JSON解析
        // BetaMessageStream在每个input_json_delta上调用partialParse()，我们不需要这样做，因为我们自己处理工具输入累积
        // biome-ignore lint/plugin: 主对话循环单独处理属性
        const result = await anthropic.beta.messages
          .create(
            { ...params, stream: true },
            {
              signal,
              ...(clientRequestId && {
                headers: { [CLIENT_REQUEST_ID_HEADER]: clientRequestId },
              }),
            },
          )
          .withResponse()
        queryCheckpoint('query_response_headers_received')
        streamRequestId = result.request_id
        streamResponse = result.response
        return result.data
      },
      {
        model: options.model,
        fallbackModel: options.fallbackModel,
        thinkingConfig,
        ...(isFastModeEnabled() ? { fastMode: isFastMode } : false),
        signal,
        querySource: options.querySource,
      },
    )

    let e
    do {
      e = await generator.next()

      // 产生API错误消息（流有'controller'属性，错误消息没有）
      if (!('controller' in e.value)) {
        yield e.value
      }
    } while (!e.done)
    stream = e.value as Stream<BetaRawMessageStreamEvent>

    // 重置状态
    newMessages.length = 0
    ttftMs = 0
    partialMessage = undefined
    contentBlocks.length = 0
    usage = EMPTY_USAGE
    stopReason = null

    // 流空闲超时看门狗：如果STREAM_IDLE_TIMEOUT_MS内没有块到达，则中止流。与下面的停滞检测不同（仅在*下一个*块到达时触发），它使用setTimeout主动终止挂起的流。没有这个，静默断开的连接可能无限期挂起会话，因为SDK的请求超时仅覆盖初始的fetch()，不包括流式主体。
    const streamWatchdogEnabled = isEnvTruthy(
      process.env.CLAUDE_ENABLE_STREAM_WATCHDOG,
    )
    const STREAM_IDLE_TIMEOUT_MS =
      parseInt(process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS || '', 10) || 90_000
    const STREAM_IDLE_WARNING_MS = STREAM_IDLE_TIMEOUT_MS / 2
    let streamIdleAborted = false
    // 看门狗触发时performance.now()的快照，用于测量中止传播延迟
    let streamWatchdogFiredAt: number | null = null
    let streamIdleWarningTimer: ReturnType<typeof setTimeout> | null = null
    let streamIdleTimer: ReturnType<typeof setTimeout> | null = null
    /** 删除或清理 clear Stream Idle Timers 对应的数据或状态。 */
    function clearStreamIdleTimers(): void {
      if (streamIdleWarningTimer !== null) {
        clearTimeout(streamIdleWarningTimer)
        streamIdleWarningTimer = null
      }
      if (streamIdleTimer !== null) {
        clearTimeout(streamIdleTimer)
        streamIdleTimer = null
      }
    }
    /** 重置或恢复 reset Stream Idle Timer 对应的数据或状态。 */
    function resetStreamIdleTimer(): void {
      clearStreamIdleTimers()
      if (!streamWatchdogEnabled) {
        return
      }
      streamIdleWarningTimer = setTimeout(
        warnMs => {
          logForDebugging(
            `Streaming idle warning: no chunks received for ${warnMs / 1000}s`,
            { level: 'warn' },
          )
          logForDiagnosticsNoPII('warn', 'cli_streaming_idle_warning')
        },
        STREAM_IDLE_WARNING_MS,
        STREAM_IDLE_WARNING_MS,
      )
      streamIdleTimer = setTimeout(() => {
        streamIdleAborted = true
        streamWatchdogFiredAt = performance.now()
        logForDebugging(
          `Streaming idle timeout: no chunks received for ${STREAM_IDLE_TIMEOUT_MS / 1000}s, aborting stream`,
          { level: 'error' },
        )
        logForDiagnosticsNoPII('error', 'cli_streaming_idle_timeout')
        releaseStreamResources()
      }, STREAM_IDLE_TIMEOUT_MS)
    }
    resetStreamIdleTimer()

    try {
      // 流入并累积状态
      let isFirstChunk = true
      let lastEventTime: number | null = null // 在第一个块之后设置，以避免将TTFB测量为停滞
      const STALL_THRESHOLD_MS = 30_000 // 30秒
      let totalStallTime = 0
      let stallCount = 0

      for await (const part of stream) {
        resetStreamIdleTimer()
        const now = Date.now()

        // 检测并记录流停滞（仅在第一个事件之后以避免计入TTFB）
        if (lastEventTime !== null) {
          const timeSinceLastEvent = now - lastEventTime
          if (timeSinceLastEvent > STALL_THRESHOLD_MS) {
            stallCount++
            totalStallTime += timeSinceLastEvent
            logForDebugging(
              `Streaming stall detected: ${(timeSinceLastEvent / 1000).toFixed(1)}s gap between events (stall #${stallCount})`,
              { level: 'warn' },
            )
          }
        }
        lastEventTime = now

        if (isFirstChunk) {
          logForDebugging('Stream started - received first chunk')
          queryCheckpoint('query_first_chunk_received')
          if (!options.agentId) {
            headlessProfilerCheckpoint('first_chunk')
          }
          endQueryProfile()
          isFirstChunk = false
        }

        switch (part.type) {
          case 'message_start': {
            partialMessage = part.message
            ttftMs = Date.now() - start
            usage = updateUsage(usage, part.message?.usage)
            break
          }
          case 'content_block_start':
            switch (part.content_block.type) {
              case 'tool_use':
                contentBlocks[part.index] = {
                  ...part.content_block,
                  input: '',
                }
                break
              case 'server_tool_use':
              case 'mcp_tool_use':
                contentBlocks[part.index] = {
                  ...part.content_block,
                  input: '' as unknown as { [key: string]: unknown },
                }
                if ((part.content_block.name as string) === 'advisor') {
                  logForDebugging(`[AdvisorTool] Advisor tool called`)
                }
                break
              case 'text':
                contentBlocks[part.index] = {
                  ...part.content_block,
                  // 尴尬的是，SDK有时会将文本作为content_block_start消息的一部分返回，然后再次在content_block_delta消息中返回相同的文本。我们在这里忽略它，因为似乎没有方法检测content_block_delta消息何时重复了文本。
                  text: '',
                }
                break
              case 'thinking':
                contentBlocks[part.index] = {
                  ...part.content_block,
                  // 也很尴尬
                  thinking: '',
                  // 初始化签名以确保字段存在，即使signature_delta从未到达
                  signature: '',
                }
                break
              default:
                // 更尴尬的是，SDK在工作时会修改文本块的内容。我们希望块是不可变的，这样我们可以自己累积状态。
                contentBlocks[part.index] = { ...part.content_block }
                if (
                  (part.content_block.type as string) === 'advisor_tool_result'
                ) {
                  logForDebugging(`[AdvisorTool] Advisor tool result received`)
                }
                break
            }
            break
          case 'content_block_delta': {
            const contentBlock = contentBlocks[part.index]
            const delta = part.delta
            if (!contentBlock) {
              throw new RangeError('Content block not found')
            }
            applyContentBlockDelta(contentBlock, delta)
            break
          }
          case 'content_block_stop': {
            const contentBlock = contentBlocks[part.index]
            if (!contentBlock) {
              throw new RangeError('Content block not found')
            }
            if (!partialMessage) {
              throw new Error('Message not found')
            }
            const m: AssistantMessage = {
              message: {
                ...partialMessage,
                content: normalizeContentFromAPI(
                  [contentBlock] as BetaContentBlock[],
                  tools,
                  options.agentId,
                ),
              },
              requestId: streamRequestId ?? undefined,
              type: 'assistant',
              uuid: randomUUID(),
              timestamp: new Date().toISOString(),
              ...(advisorModel && { advisorModel }),
            }
            newMessages.push(m)
            yield m
            break
          }
          case 'message_delta': {
            usage = updateUsage(usage, part.usage)
            // 将最终的使用量和stop_reason写回最后生成的消息。消息在content_block_stop时从partialMessage创建，partialMessage在消息开始时设置，在生成任何token之前（output_tokens: 0, stop_reason: null）。message_delta在content_block_stop之后到达，带有真实值。
            //
            // 重要：使用直接属性修改，而不是对象替换。转录写入队列持有对message.message的引用，并延迟序列化（100ms刷新间隔）。对象替换（{ ...lastMsg.message, usage }）会断开队列引用；直接修改确保转录捕获最终值。
            stopReason = part.delta.stop_reason

            const lastMsg = newMessages.at(-1)
            if (lastMsg) {
              lastMsg.message.usage = usage
              lastMsg.message.stop_reason = stopReason
            }

            // 更新成本
            const costUSDForPart = calculateUSDCost(resolvedModel, usage)
            costUSD += addToTotalSessionCost(
              costUSDForPart,
              usage,
              options.model,
            )

            const refusalMessage = getErrorMessageIfRefusal(
              part.delta.stop_reason,
              options.model,
            )
            if (refusalMessage) {
              yield refusalMessage
            }

            if (stopReason === 'max_tokens') {
              yield createAssistantAPIErrorMessage({
                content: `${API_ERROR_MESSAGE_PREFIX}: Claude's response exceeded the ${
                  maxOutputTokens
                } output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.`,
                apiError: 'max_output_tokens',
                error: 'max_output_tokens',
              })
            }

            if (stopReason === 'model_context_window_exceeded') {
              // 重用max_output_tokens恢复路径——从模型的角度来看，两者都意味着“响应被截断，从断点继续”。
              yield createAssistantAPIErrorMessage({
                content: `${API_ERROR_MESSAGE_PREFIX}: The model has reached its context window limit.`,
                apiError: 'max_output_tokens',
                error: 'max_output_tokens',
              })
            }
            break
          }
          case 'message_stop':
            break
        }

        yield {
          type: 'stream_event',
          event: part,
          ...(part.type === 'message_start' ? { ttftMs } : undefined),
        }
      }
      // 清除空闲超时看门狗，因为流循环已退出
      clearStreamIdleTimers()

      // 如果流被我们的空闲超时看门狗中止，则回退到非流式重试，而不是将其视为已完成的流。
      if (streamIdleAborted) {
        // 仪器仪表：证明for-await在看门狗触发后退出（而不是永远挂起）。exit_delay_ms测量中止传播延迟：0-10ms=中止生效；>>1000ms=其他东西唤醒了循环。
        const exitDelayMs =
          streamWatchdogFiredAt !== null
            ? Math.round(performance.now() - streamWatchdogFiredAt)
            : -1
        logForDiagnosticsNoPII(
          'info',
          'cli_stream_loop_exited_after_watchdog_clean',
        )
        // 防止双重发射：此throw落入下面的catch块，其exit_path='error'探针在streamWatchdogFiredAt上守卫。
        streamWatchdogFiredAt = null
        throw new Error('Stream idle timeout - no chunks received')
      }

      // 检测流何时完成且未产生任何助手消息。这涵盖了两种代理故障模式：1. 完全没有事件（!partialMessage）：代理返回200但带有非SSE的响应体。2. 部分事件（partialMessage已设置但没有内容块完成且未收到stop_reason）：代理返回message_start但流在content_block_stop和带有stop_reason的message_delta之前结束。BetaMessageStream在_endRequest()中有第一个检查，但原始Stream没有——没有它，生成器会静默地不返回助手消息，在-p模式下导致“执行错误”。注意：我们必须检查stopReason以避免误报。例如，使用结构化输出（--json-schema），模型在第1轮调用StructuredOutput工具，然后在第2轮响应end_turn且无内容块。这是合法的空响应，不是不完整的流。
      if (!partialMessage || (newMessages.length === 0 && !stopReason)) {
        logForDebugging(
          !partialMessage
            ? 'Stream completed without receiving message_start event - triggering non-streaming fallback'
            : 'Stream completed with message_start but no content blocks completed - triggering non-streaming fallback',
          { level: 'error' },
        )
        throw new Error('Stream ended without receiving any events')
      }

      // 如果流式传输期间发生任何停顿，则记录摘要
      if (stallCount > 0) {
        logForDebugging(
          `Streaming completed with ${stallCount} stall(s), total stall time: ${(totalStallTime / 1000).toFixed(1)}s`,
          { level: 'warn' },
        )
      }

      // 根据响应令牌检查缓存是否实际上已损坏
      if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
        void checkResponseForCacheBreak(
          options.querySource,
          usage.cache_read_input_tokens,
          usage.cache_creation_input_tokens,
          messages,
          options.agentId,
          streamRequestId,
        )
      }

      // 保留响应标头以进行网关/提供者检测。streamResponse在流于上面的withRetry回调中创建时设置。TypeScript的控制流分析无法追踪到streamResponse在回调中被设置。eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      const resp = streamResponse as unknown as Response | undefined
      if (resp) {
        responseHeaders = resp.headers
      }
    } catch (streamingError) {
      // 在错误路径上也清除空闲超时看门狗
      clearStreamIdleTimers()

      // 仪器仪表：如果看门狗已经触发并且for-await抛出（而不是干净退出），记录循环确实退出了以及在看门狗之后多久。区分真正的挂起和错误退出。
      if (streamIdleAborted && streamWatchdogFiredAt !== null) {
        const exitDelayMs = Math.round(
          performance.now() - streamWatchdogFiredAt,
        )
        logForDiagnosticsNoPII(
          'info',
          'cli_stream_loop_exited_after_watchdog_error',
        )
      }

      if (streamingError instanceof APIUserAbortError) {
        // 检查中止信号是否由用户触发（ESC键）如果信号已中止，则是用户启动的中止；否则，很可能是SDK的超时
        if (signal.aborted) {
          // 这是真正的用户中止（按下了ESC键）
          logForDebugging(
            `Streaming aborted by user: ${errorMessage(streamingError)}`,
          )
          throw streamingError
        } else {
          // SDK抛出了APIUserAbortError但我们的信号未被中止这意味着是SDK内部超时的超时
          logForDebugging(
            `Streaming timeout (SDK abort): ${streamingError.message}`,
            { level: 'error' },
          )
          // 为超时抛出更具体的错误
          throw new APIConnectionTimeoutError({ message: 'Request timed out' })
        }
      }

      // 当标志启用时，跳过非流式回退并让错误传播到withRetry。流中回退在流式工具执行激活时导致工具重复执行：部分流启动了一个工具，然后非流式重试产生了相同的tool_use并再次运行它。参见inc-4258。
      const disableFallback =
        isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK) ||
        getFeatureValue(
          'tengu_disable_streaming_to_non_streaming_fallback',
          false,
        )

      if (disableFallback) {
        logForDebugging(
          `Error streaming (non-streaming fallback disabled): ${errorMessage(streamingError)}`,
          { level: 'error' },
        )
        throw streamingError
      }

      logForDebugging(
        `Error streaming, falling back to non-streaming mode: ${errorMessage(streamingError)}`,
        { level: 'error' },
      )
      didFallBackToNonStreaming = true
      if (options.onStreamingFallback) {
        options.onStreamingFallback()
      }


      // 回退到非流式模式并重试。如果流式失败本身是529错误，则将其计入连续529预算，以便无论过载是在流式模式还是非流式模式中命中，模型回退前的总529次数相同。这是对https://github.com/anthropics/claude-code/issues/1513的推测性修复。
      logForDiagnosticsNoPII('info', 'cli_nonstreaming_fallback_started')
      const result = yield* executeNonStreamingRequest(
        { model: options.model, source: options.querySource },
        {
          model: options.model,
          fallbackModel: options.fallbackModel,
          thinkingConfig,
          ...(isFastModeEnabled() && { fastMode: isFastMode }),
          signal,
          initialConsecutive529Errors: is529Error(streamingError) ? 1 : 0,
          querySource: options.querySource,
        },
        paramsFromContext,
        (attempt, _startTime, tokens) => {
          attemptNumber = attempt
          maxOutputTokens = tokens
        },
      )

      const m: AssistantMessage = {
        message: {
          ...result,
          content: normalizeContentFromAPI(
            result.content,
            tools,
            options.agentId,
          ),
        },
        requestId: streamRequestId ?? undefined,
        type: 'assistant',
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
        ...(advisorModel && {
          advisorModel,
        }),
      }
      newMessages.push(m)
      fallbackMessage = m
      yield m
    } finally {
      clearStreamIdleTimers()
    }
  } catch (errorFromRetry) {
    // FallbackTriggeredError必须传播到query.ts，它执行实际的模型切换。在这里吞掉它会使回退变成空操作——用户只会看到“模型回退触发：X -> Y”作为错误消息，而在回退模型上没有实际重试。
    if (errorFromRetry instanceof FallbackTriggeredError) {
      throw errorFromRetry
    }

    // 检查流创建期间是否发生了应触非流式回退的404错误。这处理了那些返回404给流式端点但非流式工作正常的网关。在v2.1.8之前，BetaMessageStream在迭代期间抛出404（由内部catch捕获并回退），但现在使用原始流，404在创建期间抛出（在此处捕获）。
    const is404StreamCreationError =
      !didFallBackToNonStreaming &&
      errorFromRetry instanceof CannotRetryError &&
      errorFromRetry.originalError instanceof APIError &&
      errorFromRetry.originalError.status === 404

    if (is404StreamCreationError) {
      logForDebugging(
        'Streaming endpoint returned 404, falling back to non-streaming mode',
        { level: 'warn' },
      )
      didFallBackToNonStreaming = true
      if (options.onStreamingFallback) {
        options.onStreamingFallback()
      }


      try {
        // 回退到非流式模式
        const result = yield* executeNonStreamingRequest(
          { model: options.model, source: options.querySource },
          {
            model: options.model,
            fallbackModel: options.fallbackModel,
            thinkingConfig,
            ...(isFastModeEnabled() && { fastMode: isFastMode }),
            signal,
          },
          paramsFromContext,
          (attempt, _startTime, tokens) => {
            attemptNumber = attempt
            maxOutputTokens = tokens
          },
        )

        const m: AssistantMessage = {
          message: {
            ...result,
            content: normalizeContentFromAPI(
              result.content,
              tools,
              options.agentId,
            ),
          },
          requestId: streamRequestId ?? undefined,
          type: 'assistant',
          uuid: randomUUID(),
          timestamp: new Date().toISOString(),
          ...(advisorModel && { advisorModel }),
        }
        newMessages.push(m)
        fallbackMessage = m
        yield m

        // Continue to success logging below
      } catch (fallbackError) {
        // 将模型回退信号传播到query.ts（参见上面的注释）。
        if (fallbackError instanceof FallbackTriggeredError) {
          throw fallbackError
        }

        // 回退也失败，作为普通错误处理
        logForDebugging(
          `Non-streaming fallback also failed: ${errorMessage(fallbackError)}`,
          { level: 'error' },
        )

        let error = fallbackError
        let errorModel = options.model
        if (fallbackError instanceof CannotRetryError) {
          error = fallbackError.originalError
          errorModel = fallbackError.retryContext.model
        }

        logAPIError({
          error,
          model: errorModel,
          durationMs: Date.now() - start,
          attempt: attemptNumber,
          clientRequestId,
          llmSpan,
          fastMode: isFastModeRequest,
        })

        if (error instanceof APIUserAbortError) {
          releaseStreamResources()
          return
        }

        yield getAssistantMessageFromError(error, errorModel, {
          messages,
          messagesForAPI,
        })
        releaseStreamResources()
        return
      }
    } else {
      // 非404错误的原始错误处理
      logForDebugging(`Error in API request: ${errorMessage(errorFromRetry)}`, {
        level: 'error',
      })

      let error = errorFromRetry
      let errorModel = options.model
      if (errorFromRetry instanceof CannotRetryError) {
        error = errorFromRetry.originalError
        errorModel = errorFromRetry.retryContext.model
      }

      logAPIError({
        error,
        model: errorModel,
        durationMs: Date.now() - start,
        attempt: attemptNumber,
        clientRequestId,
        llmSpan,
        fastMode: isFastModeRequest,
      })

      // 对于用户中止操作，不要生成助手错误消息
      // 中断消息在 query.ts 中处理
      if (error instanceof APIUserAbortError) {
        releaseStreamResources()
        return
      }

      yield getAssistantMessageFromError(error, errorModel, {
        messages,
        messagesForAPI,
      })
      releaseStreamResources()
      return
    }
  } finally {
    // 必须在 finally 块中：如果生成器通过 .return() 提前终止（例如消费者跳出 for-await-of 循环，或 query.ts 遇到中止），则 try/finally 之后的代码永远不会执行。否则，Response 对象的原生 TLS/socket 缓冲区会一直泄漏，直到生成器本身被垃圾回收（参见 GH #32920）。
    releaseStreamResources()

    // 非流式回退的成本：流式路径在 message_delta 处理程序中的任何 yield 之前跟踪成本。回退路径推送到 newMessages 然后 yield，因此跟踪必须在此处进行，以便在 yield 处的 .return() 后幸存。
    if (fallbackMessage) {
      const fallbackUsage = fallbackMessage.message.usage
      usage = updateUsage(EMPTY_USAGE, fallbackUsage)
      stopReason = fallbackMessage.message.stop_reason
      const fallbackCost = calculateUSDCost(resolvedModel, fallbackUsage)
      costUSD += addToTotalSessionCost(
        fallbackCost,
        fallbackUsage,
        options.model,
      )
    }
  }

  // 跟踪主对话链的最后一个 requestId，以便关闭时可以发送缓存驱逐提示给推理引擎。排除后台会话（Ctrl+B），它们共享 repl_main_thread querySource 但在代理上下文中运行——它们是独立的对话链，当前台会话清除时不应驱逐其缓存。
  if (
    streamRequestId &&
    !getAgentContext() &&
    (options.querySource.startsWith('repl_main_thread') ||
      options.querySource === 'sdk')
  ) {
    setLastMainRequestId(streamRequestId)
  }

  // 预先计算标量，以便即忘即用的 .then() 闭包不会在 getToolPermissionContext() 解析之前锁定完整的 messagesForAPI 数组（直到上下文窗口限制的整个会话）。
  logAPISuccessAndDuration({
    model:
      newMessages[0]?.message.model ?? partialMessage?.model ?? options.model,
    usage,
    start,
    startIncludingRetries,
    attempt: attemptNumber,
    ttftMs,
    costUSD,
    llmSpan,
    requestSetupMs: start - startIncludingRetries,
    attemptStartTimes,
    fastMode: isFastModeRequest,
  })

  // 防御性：在正常完成时也释放（如果 finally 已经运行过，则为空操作）。
  releaseStreamResources()
}

/**
 * 清理流资源以防止内存泄漏。
 * @internal 为测试导出的内部函数
 */
export function cleanupStream(
  stream: Stream<BetaRawMessageStreamEvent> | undefined,
): void {
  if (!stream) {
    return
  }
  try {
    // 如果尚未中止，则通过其控制器中止流
    if (!stream.controller.signal.aborted) {
      stream.controller.abort()
    }
  } catch {
    // Ignore - stream may already be closed
  }
}

/**
 * 使用来自流式 API 事件的新值更新使用统计信息。
 * 注意：Anthropic 的流式 API 提供累计使用量总计，而非增量变化。
 * 每个事件包含直到流中该点的完整使用量。
 *
 * 与输入相关的令牌（input_tokens、cache_creation_input_tokens、cache_read_input_tokens）
 * 通常在 message_start 中设置并保持不变。message_delta 事件可能为这些字段发送
 * 显式的 0 值，这不应覆盖 message_start 中的值。
 * 我们仅在这些字段具有非空、非零值时更新它们。
 */
export function updateUsage(
  usage: Readonly<NonNullableUsage>,
  partUsage: BetaMessageDeltaUsage | undefined,
): NonNullableUsage {
  if (!partUsage) {
    return { ...usage }
  }
  return {
    input_tokens:
      partUsage.input_tokens !== null && partUsage.input_tokens > 0
        ? partUsage.input_tokens
        : usage.input_tokens,
    cache_creation_input_tokens:
      partUsage.cache_creation_input_tokens !== null &&
      partUsage.cache_creation_input_tokens > 0
        ? partUsage.cache_creation_input_tokens
        : usage.cache_creation_input_tokens,
    cache_read_input_tokens:
      partUsage.cache_read_input_tokens !== null &&
      partUsage.cache_read_input_tokens > 0
        ? partUsage.cache_read_input_tokens
        : usage.cache_read_input_tokens,
    output_tokens: partUsage.output_tokens ?? usage.output_tokens,
    server_tool_use: {
      web_search_requests:
        partUsage.server_tool_use?.web_search_requests ??
        usage.server_tool_use.web_search_requests,
      web_fetch_requests:
        partUsage.server_tool_use?.web_fetch_requests ??
        usage.server_tool_use.web_fetch_requests,
    },
    service_tier: usage.service_tier,
    cache_creation: {
      // SDK 类型 BetaMessageDeltaUsage 缺少 cache_creation，但它是真实存在的！
      ephemeral_1h_input_tokens:
        (partUsage as BetaUsage).cache_creation?.ephemeral_1h_input_tokens ??
        usage.cache_creation.ephemeral_1h_input_tokens,
      ephemeral_5m_input_tokens:
        (partUsage as BetaUsage).cache_creation?.ephemeral_5m_input_tokens ??
        usage.cache_creation.ephemeral_5m_input_tokens,
    },
    inference_geo: usage.inference_geo,
    iterations: partUsage.iterations ?? usage.iterations,
    speed: (partUsage as BetaUsage).speed ?? usage.speed,
  }
}

/**
 * 将一条消息的使用量累加到总使用量对象中。
 * 用于跟踪跨多个助手轮次的累计使用量。
 */
export function accumulateUsage(
  totalUsage: Readonly<NonNullableUsage>,
  messageUsage: Readonly<NonNullableUsage>,
): NonNullableUsage {
  return {
    input_tokens: totalUsage.input_tokens + messageUsage.input_tokens,
    cache_creation_input_tokens:
      totalUsage.cache_creation_input_tokens +
      messageUsage.cache_creation_input_tokens,
    cache_read_input_tokens:
      totalUsage.cache_read_input_tokens + messageUsage.cache_read_input_tokens,
    output_tokens: totalUsage.output_tokens + messageUsage.output_tokens,
    server_tool_use: {
      web_search_requests:
        totalUsage.server_tool_use.web_search_requests +
        messageUsage.server_tool_use.web_search_requests,
      web_fetch_requests:
        totalUsage.server_tool_use.web_fetch_requests +
        messageUsage.server_tool_use.web_fetch_requests,
    },
    service_tier: messageUsage.service_tier, // Use the most recent service tier
    cache_creation: {
      ephemeral_1h_input_tokens:
        totalUsage.cache_creation.ephemeral_1h_input_tokens +
        messageUsage.cache_creation.ephemeral_1h_input_tokens,
      ephemeral_5m_input_tokens:
        totalUsage.cache_creation.ephemeral_5m_input_tokens +
        messageUsage.cache_creation.ephemeral_5m_input_tokens,
    },
    inference_geo: messageUsage.inference_geo, // Use the most recent
    iterations: messageUsage.iterations, // Use the most recent
    speed: messageUsage.speed, // Use the most recent
  }
}

/** 添加或注册 add Cache Breakpoints 对应的数据或状态。 */
export function addCacheBreakpoints(
  messages: (UserMessage | AssistantMessage)[],
  enablePromptCaching: boolean,
  querySource?: QuerySource,
  skipCacheWrite = false,
): MessageParam[] {

  // 每个请求恰好有一个消息级别的 cache_control 标记。Mycro 的
  // 轮次间驱逐（page_manager/index.rs: Index::insert）会释放
  // 任何不在 cache_store_int_token_boundaries 中的缓存前缀位置的本地注意力 KV 页面。使用两个标记时，倒数第二个位置受到保护，其本地页面会多存活一轮，尽管永远不会从那里恢复——使用一个标记时，它们会立即被释放。对于即忘即用的分支（skipCacheWrite），我们将标记移到倒数第二条消息：这是最后一个共享前缀点，因此写入是 mycro 上的空操作合并（条目已存在），并且分支不会在 KVCC 中留下自己的尾部。密集页面通过引用计数并无论如何通过新哈希存活。
  const markerIndex = skipCacheWrite ? messages.length - 2 : messages.length - 1
  /** 执行 result 对应的业务处理。 */
  const result = messages.map((msg, index) => {
    const addCache = index === markerIndex
    if (msg.type === 'user') {
      return userMessageToMessageParam(
        msg,
        addCache,
        enablePromptCaching,
        querySource,
      )
    }
    return assistantMessageToMessageParam(
      msg,
      addCache,
      enablePromptCaching,
      querySource,
    )
  })

  return result
}

/** 创建 build System Prompt Blocks 对应的数据或状态。 */
export function buildSystemPromptBlocks(
  systemPrompt: SystemPrompt,
  enablePromptCaching: boolean,
  options?: {
    skipGlobalCacheForSystemPrompt?: boolean
    querySource?: QuerySource
  },
): TextBlockParam[] {
  // 重要提示：不要再添加任何缓存块，否则会收到 400 错误
  return splitSysPromptPrefix(systemPrompt, {
    skipGlobalCacheForSystemPrompt: options?.skipGlobalCacheForSystemPrompt,
  }).map(block => {
    return {
      type: 'text' as const,
      text: block.text,
      ...(enablePromptCaching &&
        block.cacheScope !== null && {
          cache_control: getCacheControl({
            scope: block.cacheScope,
            querySource: options?.querySource,
          }),
        }),
    }
  })
}

type HaikuOptions = Omit<Options, 'model' | 'getToolPermissionContext'>

/** 执行 query Haiku 对应的业务处理。 */
export async function queryHaiku({
  systemPrompt = asSystemPrompt([]),
  userPrompt,
  outputFormat,
  signal,
  options,
}: {
  systemPrompt: SystemPrompt
  userPrompt: string
  outputFormat?: BetaJSONOutputFormat
  signal: AbortSignal
  options: HaikuOptions
}): Promise<AssistantMessage> {
  const result = await withVCR(
    [
      createUserMessage({
        /** 执行 content 对应的业务处理。 */
        content: systemPrompt.map(text => ({ type: 'text', text })),
      }),
      createUserMessage({
        content: userPrompt,
      }),
    ],
    async () => {
      const messages = [
        createUserMessage({
          content: userPrompt,
        }),
      ]

      const result = await queryModelWithoutStreaming({
        messages,
        systemPrompt,
        thinkingConfig: { type: 'disabled' },
        tools: [],
        signal,
        options: {
          ...options,
          model: getSmallFastModel(),
          enablePromptCaching: options.enablePromptCaching ?? false,
          outputFormat,
          /** 获取 get Tool Permission Context 对应的数据或状态。 */
          async getToolPermissionContext() {
            return getEmptyToolPermissionContext()
          },
        },
      })
      return [result]
    },
  )
  // 我们不对 Haiku 使用流式传输，因此这是安全的
  return result[0]! as AssistantMessage
}

type QueryWithModelOptions = Omit<Options, 'getToolPermissionContext'>

/**
 * 通过 Claude Code 基础设施查询特定模型。
 * 这经过完整的查询管道，包括适当的身份验证、
 * 测试版和标头——不同于直接 API 调用。
 */
export async function queryWithModel({
  systemPrompt = asSystemPrompt([]),
  userPrompt,
  outputFormat,
  signal,
  options,
}: {
  systemPrompt: SystemPrompt
  userPrompt: string
  outputFormat?: BetaJSONOutputFormat
  signal: AbortSignal
  options: QueryWithModelOptions
}): Promise<AssistantMessage> {
  const result = await withVCR(
    [
      createUserMessage({
        /** 执行 content 对应的业务处理。 */
        content: systemPrompt.map(text => ({ type: 'text', text })),
      }),
      createUserMessage({
        content: userPrompt,
      }),
    ],
    async () => {
      const messages = [
        createUserMessage({
          content: userPrompt,
        }),
      ]

      const result = await queryModelWithoutStreaming({
        messages,
        systemPrompt,
        thinkingConfig: { type: 'disabled' },
        tools: [],
        signal,
        options: {
          ...options,
          enablePromptCaching: options.enablePromptCaching ?? false,
          outputFormat,
          /** 获取 get Tool Permission Context 对应的数据或状态。 */
          async getToolPermissionContext() {
            return getEmptyToolPermissionContext()
          },
        },
      })
      return [result]
    },
  )
  return result[0]! as AssistantMessage
}

// 非流式请求根据文档有 10 分钟的最大限制：
// https://platform.claude.com/docs/en/api/errors#long-requests
// SDK 的 21333 令牌上限源自 10 分钟 × 128k 令牌/小时，但我们
// 通过设置客户端级别超时绕过它，因此可以设置更高的上限。
export const MAX_NON_STREAMING_TOKENS = 64_000

/**
 * 当非流式回退的 max_tokens 被限制时，调整思考预算。
 * 确保 API 约束：max_tokens > thinking.budget_tokens
 *
 * @param params - 将发送给 API 的参数
 * @param maxTokensCap - 允许的最大令牌数（MAX_NON_STREAMING_TOKENS）
 * @returns 如果需要，调整后的参数，其中思考预算被限制
 */
export function adjustParamsForNonStreaming<
  T extends {
    max_tokens: number
    thinking?: BetaMessageStreamParams['thinking']
  },
>(params: T, maxTokensCap: number): T {
  const cappedMaxTokens = Math.min(params.max_tokens, maxTokensCap)

  // 如果思考预算会超过限制的 max_tokens，则调整思考预算
  // 以维持约束：max_tokens > thinking.budget_tokens
  const adjustedParams = { ...params }
  if (
    adjustedParams.thinking?.type === 'enabled' &&
    adjustedParams.thinking.budget_tokens
  ) {
    adjustedParams.thinking = {
      ...adjustedParams.thinking,
      budget_tokens: Math.min(
        adjustedParams.thinking.budget_tokens,
        cappedMaxTokens - 1, // Must be at least 1 less than max_tokens
      ),
    }
  }

  return {
    ...adjustedParams,
    max_tokens: cappedMaxTokens,
  }
}

/** 判断是否满足 is Max Tokens Cap Enabled 对应的数据或状态。 */
function isMaxTokensCapEnabled(): boolean {
  // 3P 默认值：false（在 Bedrock/Vertex 上未验证）
  return getFeatureValue('tengu_otk_slot_v1', false)
}

/** 获取 get Max Output Tokens For Model 对应的数据或状态。 */
export function getMaxOutputTokensForModel(model: string): number {
  const maxOutputTokens = getModelMaxOutputTokens(model)

  // 槽位预留上限：对所有模型将默认值降至 8k。BQ p99 输出
  // = 4,911 个令牌；32k/64k 默认值过度预留了 8-16 倍的槽位容量。
  // 达到上限的请求会获得一次干净的 64k 重试（query.ts
  // max_output_tokens_escalate）。Math.min 使具有较低原生默认值的模型
  // （例如 claude-3-opus 为 4k）保持其原生值。在环境变量覆盖之前
  // 应用，因此 CLAUDE_CODE_MAX_OUTPUT_TOKENS 仍然生效。
  const defaultTokens = isMaxTokensCapEnabled()
    ? Math.min(maxOutputTokens.default, CAPPED_DEFAULT_MAX_TOKENS)
    : maxOutputTokens.default

  const result = validateBoundedIntEnvVar(
    'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
    process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS,
    defaultTokens,
    maxOutputTokens.upperLimit,
  )
  return result.effective
}
