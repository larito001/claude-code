import { MODEL_ALIASES } from './aliases.js'
import { isModelAllowed } from './modelAllowlist.js'
import { sideQuery } from '../sideQuery.js'
import {
  NotFoundError,
  APIError,
  APIConnectionError,
  AuthenticationError,
} from '@anthropic-ai/sdk'

// 缓存有效模型以避免重复的API调用
const validModelCache = new Map<string, boolean>()

/** 通过尝试实际的API调用来验证模型。 */
export async function validateModel(
  model: string,
): Promise<{ valid: boolean; error?: string }> {
  const normalizedModel = model.trim()

  // 空模型无效
  if (!normalizedModel) {
    return { valid: false, error: 'Model name cannot be empty' }
  }

  // 在任何API调用之前，对照availableModels白名单进行检查
  if (!isModelAllowed(normalizedModel)) {
    return {
      valid: false,
      error: `Model '${normalizedModel}' is not in the list of available models`,
    }
  }

  // 检查是否为已知别名（这些始终有效）
  const lowerModel = normalizedModel.toLowerCase()
  if ((MODEL_ALIASES as readonly string[]).includes(lowerModel)) {
    return { valid: true }
  }

  // 检查是否匹配ANTHROPIC_CUSTOM_MODEL_OPTION（已由用户预先验证）
  if (normalizedModel === process.env.ANTHROPIC_CUSTOM_MODEL_OPTION) {
    return { valid: true }
  }

  // 首先检查缓存
  if (validModelCache.has(normalizedModel)) {
    return { valid: true }
  }


  // 尝试使用最少参数进行实际的API调用
  try {
    await sideQuery({
      model: normalizedModel,
      max_tokens: 1,
      maxRetries: 0,
      querySource: 'model_validation',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Hi',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
    })

    // 如果执行到这里，模型有效
    validModelCache.set(normalizedModel, true)
    return { valid: true }
  } catch (error) {
    return handleValidationError(error, normalizedModel)
  }
}

/** 处理 handle Validation Error 对应的数据或状态。 */
function handleValidationError(
  error: unknown,
  modelName: string,
): { valid: boolean; error: string } {
  // NotFoundError（404）表示模型不存在
  if (error instanceof NotFoundError) {
    return {
      valid: false,
      error: `Model '${modelName}' not found`,
    }
  }

  // 对于其他API错误，提供上下文特定的消息
  if (error instanceof APIError) {
    if (error instanceof AuthenticationError) {
      return {
        valid: false,
        error: 'Authentication failed. Please check your API credentials.',
      }
    }

    if (error instanceof APIConnectionError) {
      return {
        valid: false,
        error: 'Network error. Please check your internet connection.',
      }
    }

    // 检查错误主体中与模型相关的错误
    const errorBody = error.error as unknown
    if (
      errorBody &&
      typeof errorBody === 'object' &&
      'type' in errorBody &&
      errorBody.type === 'not_found_error' &&
      'message' in errorBody &&
      typeof errorBody.message === 'string' &&
      errorBody.message.includes('model:')
    ) {
      return { valid: false, error: `Model '${modelName}' not found` }
    }

    // 通用API错误
    return { valid: false, error: `API error: ${error.message}` }
  }

  // 对于未知错误，为了安全起见，拒绝
  const errorMessage = error instanceof Error ? error.message : String(error)
  return {
    valid: false,
    error: `Unable to validate model: ${errorMessage}`,
  }
}
