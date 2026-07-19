import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk'
import type { ClientOptions as BedrockClientOptions } from '@anthropic-ai/bedrock-sdk'
import { randomUUID } from 'crypto'
import type { GoogleAuth } from 'google-auth-library'
import {
  getAnthropicApiKey,
  refreshAndGetAwsCredentials,
  refreshGcpCredentialsIfNeeded,
} from 'src/utils/auth.js'
import { getUserAgent } from 'src/utils/http.js'
import { getSmallFastModel } from 'src/utils/model/model.js'
import {
  getAPIProvider,
  isFirstPartyAnthropicBaseUrl,
} from 'src/utils/model/providers.js'
import { getProxyFetchOptions } from 'src/utils/proxy.js'
import { getSessionId } from '../../bootstrap/state.js'
import { isDebugToStdErr, logForDebugging } from '../../utils/debug.js'
import {
  getAWSRegion,
  getVertexRegionForModel,
  isEnvTruthy,
} from '../../utils/envUtils.js'

/**
 * 不同客户端类型的环境变量：
 *
 * 直接 API：
 * - ANTHROPIC_API_KEY：直接 API 访问必需
 *
 * AWS Bedrock：
 * - 通过 aws-sdk 默认配置 AWS 凭据
 * - AWS_REGION 或 AWS_DEFAULT_REGION：为所有模型设置 AWS 区域（默认：us-east-1）
 * - ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION：可选。专门为小快速模型（Haiku）覆盖 AWS 区域
 *
 * Foundry（Azure）：
 * - ANTHROPIC_FOUNDRY_RESOURCE：你的 Azure 资源名称（例如 'my-resource'）
 *   完整端点：https://{resource}.services.ai.azure.com/anthropic/v1/messages
 * - ANTHROPIC_FOUNDRY_BASE_URL：可选。代替资源——直接提供完整基础 URL
 *   （例如 'https://my-resource.services.ai.azure.com'）
 *
 * 认证（以下之一）：
 * - ANTHROPIC_FOUNDRY_API_KEY：你的 Microsoft Foundry API 密钥（如果使用 API 密钥认证）
 * - Azure AD 认证：如果未提供 API 密钥，则使用 DefaultAzureCredential
 *   支持多种认证方法（环境变量、托管标识、
 *   Azure CLI 等）。参见：https://docs.microsoft.com/en-us/javascript/api/@azure/identity
 *
 * Vertex AI：
 * - 模型特定区域变量（最高优先级）：
 *   - VERTEX_REGION_CLAUDE_3_5_HAIKU：Claude 3.5 Haiku 模型的区域
 *   - VERTEX_REGION_CLAUDE_HAIKU_4_5：Claude Haiku 4.5 模型的区域
 *   - VERTEX_REGION_CLAUDE_3_5_SONNET：Claude 3.5 Sonnet 模型的区域
 *   - VERTEX_REGION_CLAUDE_3_7_SONNET：Claude 3.7 Sonnet 模型的区域
 * - CLOUD_ML_REGION：可选。用于所有模型的默认 GCP 区域
 *   如果上面未指定特定模型区域
 * - ANTHROPIC_VERTEX_PROJECT_ID：必需。你的 GCP 项目 ID
 * - 通过 google-auth-library 配置的标准 GCP 凭据
 *
 * 确定区域的优先级：
 * 1. 硬编码的模型特定环境变量
 * 2. 全局 CLOUD_ML_REGION 变量
 * 3. 配置中的默认区域
 * 4. 后备区域（us-east5）
 */

function createStderrLogger(): ClientOptions['logger'] {
  return {
    /** 执行 error 对应的业务处理。 */
    error: (msg, ...args) =>
      // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
      console.error('[Anthropic SDK ERROR]', msg, ...args),
    /** 执行 warn 对应的业务处理。 */
    // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
    warn: (msg, ...args) => console.error('[Anthropic SDK WARN]', msg, ...args),
    /** 执行 info 对应的业务处理。 */
    // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
    info: (msg, ...args) => console.error('[Anthropic SDK INFO]', msg, ...args),
    /** 执行 debug 对应的业务处理。 */
    debug: (msg, ...args) =>
      // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
      console.error('[Anthropic SDK DEBUG]', msg, ...args),
  }
}

/** 获取 get Anthropic Client 对应的数据或状态。 */
export async function getAnthropicClient({
  apiKey,
  maxRetries,
  model,
  fetchOverride,
  source,
}: {
  apiKey?: string
  maxRetries: number
  model?: string
  fetchOverride?: ClientOptions['fetch']
  source?: string
}): Promise<Anthropic> {
  const containerId = process.env.CLAUDE_CODE_CONTAINER_ID
  const clientApp = process.env.CLAUDE_AGENT_SDK_CLIENT_APP
  const customHeaders = getCustomHeaders()
  const defaultHeaders: { [key: string]: string } = {
    'x-app': 'cli',
    'User-Agent': getUserAgent(),
    'X-Claude-Code-Session-Id': getSessionId(),
    ...customHeaders,
    ...(containerId ? { 'x-claude-remote-container-id': containerId } : {}),
    // SDK 消费者可以在请求诊断中标识他们的应用/库。
    ...(clientApp ? { 'x-client-app': clientApp } : {}),
  }

  // 记录 API 客户端配置以进行 HFI 调试
  logForDebugging(
    `[API:request] Creating client, ANTHROPIC_CUSTOM_HEADERS present: ${!!process.env.ANTHROPIC_CUSTOM_HEADERS}, has Authorization header: ${!!customHeaders['Authorization']}`,
  )

  // 如果通过环境变量启用，则添加额外的保护标头
  const additionalProtectionEnabled = isEnvTruthy(
    process.env.CLAUDE_CODE_ADDITIONAL_PROTECTION,
  )
  if (additionalProtectionEnabled) {
    defaultHeaders['x-anthropic-additional-protection'] = 'true'
  }

  const resolvedFetch = buildFetch(fetchOverride, source)

  const ARGS = {
    defaultHeaders,
    maxRetries,
    timeout: parseInt(process.env.API_TIMEOUT_MS || String(600 * 1000), 10),
    dangerouslyAllowBrowser: true,
    fetchOptions: getProxyFetchOptions({
      forAnthropicAPI: true,
    }) as ClientOptions['fetchOptions'],
    ...(resolvedFetch && {
      fetch: resolvedFetch,
    }),
  }
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)) {
    const { AnthropicBedrock } = await import('@anthropic-ai/bedrock-sdk')
    // 如果指定，则对小快速模型使用区域覆盖
    const awsRegion =
      model === getSmallFastModel() &&
      process.env.ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION
        ? process.env.ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION
        : getAWSRegion()

    const bedrockArgs = {
      ...ARGS,
      awsRegion,
      ...(isEnvTruthy(process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH) && {
        skipAuth: true,
      }),
      ...(isDebugToStdErr() && { logger: createStderrLogger() }),
    } satisfies BedrockClientOptions

    // Bearer 令牌和 AWS 静态凭据必须分别构造客户端，保留 SDK 的认证互斥约束。
    if (process.env.AWS_BEARER_TOKEN_BEDROCK) {
      return new AnthropicBedrock({
        ...bedrockArgs,
        skipAuth: true,
        defaultHeaders: {
          ...bedrockArgs.defaultHeaders,
          Authorization: `Bearer ${process.env.AWS_BEARER_TOKEN_BEDROCK}`,
        },
      }) as unknown as Anthropic
    }

    if (!isEnvTruthy(process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH)) {
      // 刷新认证并通过清除缓存获取凭据
      const cachedCredentials = await refreshAndGetAwsCredentials()
      if (cachedCredentials) {
        return new AnthropicBedrock({
          ...bedrockArgs,
          awsAccessKey: cachedCredentials.accessKeyId,
          awsSecretKey: cachedCredentials.secretAccessKey,
          awsSessionToken: cachedCredentials.sessionToken,
        }) as unknown as Anthropic
      }
    }
    // 我们一直在对返回类型撒谎——这不支持批处理或模型
    return new AnthropicBedrock(bedrockArgs) as unknown as Anthropic
  }
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)) {
    const { AnthropicFoundry } = await import('@anthropic-ai/foundry-sdk')
    // 根据配置确定 Azure AD 令牌提供者
    // SDK 默认读取 ANTHROPIC_FOUNDRY_API_KEY
    let azureADTokenProvider: (() => Promise<string>) | undefined
    if (!process.env.ANTHROPIC_FOUNDRY_API_KEY) {
      if (isEnvTruthy(process.env.CLAUDE_CODE_SKIP_FOUNDRY_AUTH)) {
        // 用于测试/代理场景的模拟令牌提供者（类似于 Vertex 模拟 GoogleAuth）
        azureADTokenProvider = () => Promise.resolve('')
      } else {
        // 使用 DefaultAzureCredential 进行真实的 Azure AD 认证
        const {
          DefaultAzureCredential: AzureCredential,
          getBearerTokenProvider,
        } = await import('@azure/identity')
        azureADTokenProvider = getBearerTokenProvider(
          new AzureCredential(),
          'https://cognitiveservices.azure.com/.default',
        )
      }
    }

    const foundryArgs: ConstructorParameters<typeof AnthropicFoundry>[0] = {
      ...ARGS,
      ...(azureADTokenProvider && { azureADTokenProvider }),
      ...(isDebugToStdErr() && { logger: createStderrLogger() }),
    }
    // 我们一直在对返回类型撒谎——这不支持批处理或模型
    return new AnthropicFoundry(foundryArgs) as unknown as Anthropic
  }
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)) {
    // 如果配置了 gcpAuthRefresh 且凭据已过期，则刷新 GCP 凭据
    // 这类似于我们为 Bedrock 处理 AWS 凭据刷新的方式
    if (!isEnvTruthy(process.env.CLAUDE_CODE_SKIP_VERTEX_AUTH)) {
      await refreshGcpCredentialsIfNeeded()
    }

    const [{ AnthropicVertex }, { GoogleAuth }] = await Promise.all([
      import('@anthropic-ai/vertex-sdk'),
      import('google-auth-library'),
    ])
    // 这里有意在每次 getAnthropicClient() 调用时创建新的 GoogleAuth 实例，
    // 这可能导致重复的认证流程和元数据服务器检查
    // 但是，缓存需要小心处理：
    // - 凭据刷新/过期
    // - 环境变量变化（GOOGLE_APPLICATION_CREDENTIALS、项目变量）
    // - 跨请求的认证状态管理
    // 参见：https://github.com/googleapis/google-auth-library-nodejs/issues/390 了解缓存挑战

    // 通过提供 projectId 作为回退来防止元数据服务器超时
    // google-auth-library 按此顺序检查项目 ID：
    // 1. 环境变量（GCLOUD_PROJECT, GOOGLE_CLOUD_PROJECT 等）
    // 2. 凭据文件（服务账号 JSON、ADC 文件）
    // 3. gcloud 配置
    // 4. GCE 元数据服务器（在 GCP 外部会导致 12 秒超时）
    //
    // 我们仅在用户未配置其他发现方法时设置 projectId，
    // 以免干扰他们现有的认证设置。

    // 按照与 google-auth-library 相同的顺序检查项目环境变量
    // 参见：https://github.com/googleapis/google-auth-library-nodejs/blob/main/src/auth/googleauth.ts
    const hasProjectEnvVar =
      process.env['GCLOUD_PROJECT'] ||
      process.env['GOOGLE_CLOUD_PROJECT'] ||
      process.env['gcloud_project'] ||
      process.env['google_cloud_project']

    // 检查凭据文件路径（服务账号或 ADC）
    // 注意：为了安全，我们同时检查标准和小写变体，
    // 但我们应验证 google-auth-library 实际检查什么。
    const hasKeyFile =
      process.env['GOOGLE_APPLICATION_CREDENTIALS'] ||
      process.env['google_application_credentials']

    const googleAuth = isEnvTruthy(process.env.CLAUDE_CODE_SKIP_VERTEX_AUTH)
      ? ({
          // 用于测试/代理场景的模拟 GoogleAuth
          getClient: () => ({
            /** 获取 get Request Headers 对应的数据或状态。 */
            getRequestHeaders: () => ({}),
          }),
        } as unknown as GoogleAuth)
      : new GoogleAuth({
          scopes: ['https://www.googleapis.com/auth/cloud-platform'],
          // 仅在最后手段回退时使用 ANTHROPIC_VERTEX_PROJECT_ID
          // 这可以防止以下情况导致 12 秒元数据服务器超时：
          // - 未设置项目环境变量 且
          // - 未指定凭据密钥文件 且
          // - ADC 文件存在但缺少 project_id 字段
          //
          // 风险：如果认证项目 != API 目标项目，可能导致计费/审计问题
          // 缓解措施：用户可以设置 GOOGLE_CLOUD_PROJECT 来覆盖。
          ...(hasProjectEnvVar || hasKeyFile
            ? {}
            : {
                projectId: process.env.ANTHROPIC_VERTEX_PROJECT_ID,
              }),
        })

    const vertexArgs: ConstructorParameters<typeof AnthropicVertex>[0] = {
      ...ARGS,
      region: getVertexRegionForModel(model),
      googleAuth,
      ...(isDebugToStdErr() && { logger: createStderrLogger() }),
    }
    // 我们一直在对返回类型撒谎——这不支持批处理或模型
    return new AnthropicVertex(vertexArgs) as unknown as Anthropic
  }

  const clientConfig: ConstructorParameters<typeof Anthropic>[0] = {
    apiKey: apiKey || getAnthropicApiKey(),
    ...ARGS,
    ...(isDebugToStdErr() && { logger: createStderrLogger() }),
  }

  return new Anthropic(clientConfig)
}

/** 获取 get Custom Headers 对应的数据或状态。 */
function getCustomHeaders(): Record<string, string> {
  const customHeaders: Record<string, string> = {}
  const customHeadersEnv = process.env.ANTHROPIC_CUSTOM_HEADERS

  if (!customHeadersEnv) return customHeaders

  // 按换行符分割以支持多个标头
  const headerStrings = customHeadersEnv.split(/\n|\r\n/)

  for (const headerString of headerStrings) {
    if (!headerString.trim()) continue

    // 解析格式为 "Name: Value"（curl 风格）的标头。在第一个 `:` 处分割，
    // 然后修剪——避免在格式错误的超长标头行上出现正则回溯。
    const colonIdx = headerString.indexOf(':')
    if (colonIdx === -1) continue
    const name = headerString.slice(0, colonIdx).trim()
    const value = headerString.slice(colonIdx + 1).trim()
    if (name) {
      customHeaders[name] = value
    }
  }

  return customHeaders
}

export const CLIENT_REQUEST_ID_HEADER = 'x-client-request-id'

/** 创建 build Fetch 对应的数据或状态。 */
function buildFetch(
  fetchOverride: ClientOptions['fetch'],
  source: string | undefined,
): ClientOptions['fetch'] {
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  const inner = fetchOverride ?? globalThis.fetch
  // 仅发送给第一方 API——Bedrock/Vertex/Foundry 不记录它，
  // 未知标头有被严格代理拒绝的风险（inc-4029 类）。
  const injectClientRequestId =
    getAPIProvider() === 'firstParty' && isFirstPartyAnthropicBaseUrl()
  return (input, init) => {
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const headers = new Headers(init?.headers)
    // 生成客户端请求ID，以便超时（此时不返回服务器请求ID）仍能与API团队的服务端日志关联。想要自行追踪ID的调用者可以预先设置该头。
    if (injectClientRequestId && !headers.has(CLIENT_REQUEST_ID_HEADER)) {
      headers.set(CLIENT_REQUEST_ID_HEADER, randomUUID())
    }
    try {
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      const url = input instanceof Request ? input.url : String(input)
      const id = headers.get(CLIENT_REQUEST_ID_HEADER)
      logForDebugging(
        `[API REQUEST] ${new URL(url).pathname}${id ? ` ${CLIENT_REQUEST_ID_HEADER}=${id}` : ''} source=${source ?? 'unknown'}`,
      )
    } catch {
      // never let logging crash the fetch
    }
    return inner(input, { ...init, headers })
  }
}
