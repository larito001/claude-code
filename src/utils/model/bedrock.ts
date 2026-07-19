import memoize from 'lodash-es/memoize.js'
import { refreshAndGetAwsCredentials } from '../auth.js'
import { getAWSRegion, isEnvTruthy } from '../envUtils.js'
import { logError } from '../log.js'
import { getAWSClientProxyConfig } from '../proxy.js'

/** 获取 get Bedrock Inference Profiles 对应的数据或状态。 */
export const getBedrockInferenceProfiles = memoize(async function (): Promise<
  string[]
> {
  const [client, { ListInferenceProfilesCommand }] = await Promise.all([
    createBedrockClient(),
    import('@aws-sdk/client-bedrock'),
  ])
  const allProfiles = []
  let nextToken: string | undefined

  try {
    do {
      const command = new ListInferenceProfilesCommand({
        ...(nextToken && { nextToken }),
        typeEquals: 'SYSTEM_DEFINED',
      })
      const response = await client.send(command)

      if (response.inferenceProfileSummaries) {
        allProfiles.push(...response.inferenceProfileSummaries)
      }

      nextToken = response.nextToken
    } while (nextToken)

    // 过滤Anthropic模型（查询中处理SYSTEM_DEFINED过滤）
    return allProfiles
      .filter(profile => profile.inferenceProfileId?.includes('anthropic'))
      .map(profile => profile.inferenceProfileId)
      .filter(Boolean) as string[]
  } catch (error) {
    logError(error as Error)
    throw error
  }
})

/** 获取 find First Match 对应的数据或状态。 */
export function findFirstMatch(
  profiles: string[],
  substring: string,
): string | null {
  return profiles.find(p => p.includes(substring)) ?? null
}

/** 创建 create Bedrock Client 对应的数据或状态。 */
async function createBedrockClient() {
  const { BedrockClient } = await import('@aws-sdk/client-bedrock')
  // 严格匹配Anthropic Bedrock SDK的区域行为：
  // - 读取AWS_REGION或AWS_DEFAULT_REGION环境变量（不读AWS配置文件）
  // - 如果两者均未设置，则回退到'us-east-1'
  // 这确保我们从客户端将使用的相同区域查询配置文件
  const region = getAWSRegion()

  const skipAuth = isEnvTruthy(process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH)

  const clientConfig: ConstructorParameters<typeof BedrockClient>[0] = {
    region,
    ...(process.env.ANTHROPIC_BEDROCK_BASE_URL && {
      endpoint: process.env.ANTHROPIC_BEDROCK_BASE_URL,
    }),
    ...(await getAWSClientProxyConfig()),
    ...(skipAuth && {
      requestHandler: new (
        await import('@smithy/node-http-handler')
      ).NodeHttpHandler(),
      httpAuthSchemes: [
        {
          schemeId: 'smithy.api#noAuth',
          /** 执行 identity Provider 对应的业务处理。 */
          identityProvider: () => async () => ({}),
          signer: new (await import('@smithy/core')).NoAuthSigner(),
        },
      ],
      /** 执行 http Auth Scheme Provider 对应的业务处理。 */
      httpAuthSchemeProvider: () => [{ schemeId: 'smithy.api#noAuth' }],
    }),
  }

  if (!skipAuth && !process.env.AWS_BEARER_TOKEN_BEDROCK) {
    // 仅当不使用API密钥认证时才刷新凭据
    const cachedCredentials = await refreshAndGetAwsCredentials()
    if (cachedCredentials) {
      clientConfig.credentials = {
        accessKeyId: cachedCredentials.accessKeyId,
        secretAccessKey: cachedCredentials.secretAccessKey,
        sessionToken: cachedCredentials.sessionToken,
      }
    }
  }

  return new BedrockClient(clientConfig)
}

/** 创建 create Bedrock Runtime Client 对应的数据或状态。 */
export async function createBedrockRuntimeClient() {
  const { BedrockRuntimeClient } = await import(
    '@aws-sdk/client-bedrock-runtime'
  )
  const region = getAWSRegion()
  const skipAuth = isEnvTruthy(process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH)

  const clientConfig: ConstructorParameters<typeof BedrockRuntimeClient>[0] = {
    region,
    ...(process.env.ANTHROPIC_BEDROCK_BASE_URL && {
      endpoint: process.env.ANTHROPIC_BEDROCK_BASE_URL,
    }),
    ...(await getAWSClientProxyConfig()),
    ...(skipAuth && {
      // BedrockRuntimeClient默认使用HTTP/2且无回退
      // 代理服务器可能不支持此协议，因此我们显式强制使用HTTP/1.1
      requestHandler: new (
        await import('@smithy/node-http-handler')
      ).NodeHttpHandler(),
      httpAuthSchemes: [
        {
          schemeId: 'smithy.api#noAuth',
          /** 执行 identity Provider 对应的业务处理。 */
          identityProvider: () => async () => ({}),
          signer: new (await import('@smithy/core')).NoAuthSigner(),
        },
      ],
      /** 执行 http Auth Scheme Provider 对应的业务处理。 */
      httpAuthSchemeProvider: () => [{ schemeId: 'smithy.api#noAuth' }],
    }),
  }

  if (!skipAuth && !process.env.AWS_BEARER_TOKEN_BEDROCK) {
    // 仅当不使用API密钥认证时才刷新凭据
    const cachedCredentials = await refreshAndGetAwsCredentials()
    if (cachedCredentials) {
      clientConfig.credentials = {
        accessKeyId: cachedCredentials.accessKeyId,
        secretAccessKey: cachedCredentials.secretAccessKey,
        sessionToken: cachedCredentials.sessionToken,
      }
    }
  }

  return new BedrockRuntimeClient(clientConfig)
}

/** 获取 get Inference Profile Backing Model 对应的数据或状态。 */
export const getInferenceProfileBackingModel = memoize(async function (
  profileId: string,
): Promise<string | null> {
  try {
    const [client, { GetInferenceProfileCommand }] = await Promise.all([
      createBedrockClient(),
      import('@aws-sdk/client-bedrock'),
    ])
    const command = new GetInferenceProfileCommand({
      inferenceProfileIdentifier: profileId,
    })
    const response = await client.send(command)

    if (!response.models || response.models.length === 0) {
      return null
    }

    // 使用第一个模型作为成本计算的主要支持模型
    // 实践中，应用程序推理配置文件通常在具有相同成本结构的相似模型之间进行负载均衡
    const primaryModel = response.models[0]
    if (!primaryModel?.modelArn) {
      return null
    }

    // 从ARN提取模型名称
    // ARN格式：arn:aws:bedrock:区域:账户:foundation-model/模型名称
    const lastSlashIndex = primaryModel.modelArn.lastIndexOf('/')
    return lastSlashIndex >= 0
      ? primaryModel.modelArn.substring(lastSlashIndex + 1)
      : primaryModel.modelArn
  } catch (error) {
    logError(error as Error)
    return null
  }
})

/** 检查模型ID是否是基础模型（例如"anthropic.claude-sonnet-4-5-20250929-v1:0"） */
export function isFoundationModel(modelId: string): boolean {
  return modelId.startsWith('anthropic.')
}

/**
 * Bedrock的跨区域推理配置文件前缀。
 * 这些前缀允许将请求路由到特定区域的模型。
 */
const BEDROCK_REGION_PREFIXES = ['us', 'eu', 'apac', 'global'] as const

/**
 * 从Bedrock ARN中提取模型/推理配置文件ID。
 * 如果输入不是ARN，则原样返回。
 *
 * ARN格式：arn:aws:bedrock:<region>:<account>:inference-profile/<profile-id>
 * 也处理：arn:aws:bedrock:<region>:<account>:application-inference-profile/<profile-id>
 * 以及基础模型ARN：arn:aws:bedrock:<region>::foundation-model/<model-id>
 */
export function extractModelIdFromArn(modelId: string): string {
  if (!modelId.startsWith('arn:')) {
    return modelId
  }
  const lastSlashIndex = modelId.lastIndexOf('/')
  if (lastSlashIndex === -1) {
    return modelId
  }
  return modelId.substring(lastSlashIndex + 1)
}

export type BedrockRegionPrefix = (typeof BEDROCK_REGION_PREFIXES)[number]

/**
 * 从Bedrock跨区域推理模型ID中提取区域前缀。
 * 处理纯模型ID和完整ARN格式。
 * 例如：
 * - "eu.anthropic.claude-sonnet-4-5-20250929-v1:0" → "eu"
 * - "us.anthropic.claude-3-7-sonnet-20250219-v1:0" → "us"
 * - "arn:aws:bedrock:ap-northeast-2:123:inference-profile/global.anthropic.claude-opus-4-6-v1" → "global"
 * - "anthropic.claude-3-5-sonnet-20241022-v2:0" → undefined (基础模型)
 * - "claude-sonnet-4-5-20250929" → undefined (第一方格式)
 */
export function getBedrockRegionPrefix(
  modelId: string,
): BedrockRegionPrefix | undefined {
  // 如果存在，从ARN格式中提取推理配置文件ID
  // ARN格式：arn:aws:bedrock:<region>:<account>:inference-profile/<profile-id>
  const effectiveModelId = extractModelIdFromArn(modelId)

  for (const prefix of BEDROCK_REGION_PREFIXES) {
    if (effectiveModelId.startsWith(`${prefix}.anthropic.`)) {
      return prefix
    }
  }
  return undefined
}

/**
 * 向Bedrock模型ID应用区域前缀。
 * 如果模型已有不同的区域前缀，则会被替换。
 * 如果模型是基础模型（anthropic.*），则会添加前缀。
 * 如果模型不是Bedrock模型，则原样返回。
 *
 * 例如：
 * - applyBedrockRegionPrefix("us.anthropic.claude-sonnet-4-5-v1:0", "eu") → "eu.anthropic.claude-sonnet-4-5-v1:0"
 * - applyBedrockRegionPrefix("anthropic.claude-sonnet-4-5-v1:0", "eu") → "eu.anthropic.claude-sonnet-4-5-v1:0"
 * - applyBedrockRegionPrefix("claude-sonnet-4-5-20250929", "eu") → "claude-sonnet-4-5-20250929" (不是Bedrock模型)
 */
export function applyBedrockRegionPrefix(
  modelId: string,
  prefix: BedrockRegionPrefix,
): string {
  // 检查是否已有区域前缀并替换它
  const existingPrefix = getBedrockRegionPrefix(modelId)
  if (existingPrefix) {
    return modelId.replace(`${existingPrefix}.`, `${prefix}.`)
  }

  // 检查是否是基础模型（anthropic.*）并添加前缀
  if (isFoundationModel(modelId)) {
    return `${prefix}.${modelId}`
  }

  // 不是Bedrock模型格式，原样返回
  return modelId
}
