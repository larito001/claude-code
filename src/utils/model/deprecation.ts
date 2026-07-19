/**
 * 模型弃用工具
 *
 * 包含关于已弃用模型及其退役日期的信息。
 */

type DeprecatedModelInfo = {
  isDeprecated: true
  modelName: string
  retirementDate: string
}

type NotDeprecatedInfo = {
  isDeprecated: false
}

type DeprecationInfo = DeprecatedModelInfo | NotDeprecatedInfo

type DeprecationEntry = {
  /** 人类可读的模型名称 */
  modelName: string
  retirementDate: string
}

/**
 * 已弃用的模型及其按提供商的退役日期。
 * 键是与模型ID匹配的子字符串（不区分大小写）。
 * 要添加新的已弃用模型，请向此对象添加一个条目。
 */
const DEPRECATED_MODELS: Record<string, DeprecationEntry> = {
  'claude-3-opus': {
    modelName: 'Claude 3 Opus',
    retirementDate: 'January 5, 2026',
  },
  'claude-3-7-sonnet': {
    modelName: 'Claude 3.7 Sonnet',
    retirementDate: 'February 19, 2026',
  },
  'claude-3-5-haiku': {
    modelName: 'Claude 3.5 Haiku',
    retirementDate: 'February 19, 2026',
  },
}

/** 检查模型是否已弃用并获取其弃用信息 */
function getDeprecatedModelInfo(modelId: string): DeprecationInfo {
  const lowercaseModelId = modelId.toLowerCase()
  for (const [key, value] of Object.entries(DEPRECATED_MODELS)) {
    if (!lowercaseModelId.includes(key)) {
      continue
    }
    return {
      isDeprecated: true,
      modelName: value.modelName,
      retirementDate: value.retirementDate,
    }
  }

  return { isDeprecated: false }
}

/** 获取模型的弃用警告消息，如果未弃用则返回null */
export function getModelDeprecationWarning(
  modelId: string | null,
): string | null {
  if (!modelId) {
    return null
  }

  const info = getDeprecatedModelInfo(modelId)
  if (!info.isDeprecated) {
    return null
  }

  return `⚠ ${info.modelName} will be retired on ${info.retirementDate}. Consider switching to a newer model.`
}
