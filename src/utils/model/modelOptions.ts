import { getInitialMainLoopModel } from '../../bootstrap/state.js'
import {
  COST_TIER_3_15,
  COST_HAIKU_45,
  formatModelPricing,
} from '../modelCost.js'
import { getInitialSettings } from '../settings/settings.js'
import { isModelAllowed } from './modelAllowlist.js'
import {
  getCanonicalName,
  getDefaultSonnetModel,
  getDefaultOpusModel,
  getDefaultHaikuModel,
  getDefaultMainLoopModelSetting,
  getMarketingNameForModel,
  getUserSpecifiedModelSetting,
  getOpus46PricingSuffix,
  renderDefaultModelSetting,
  type ModelSetting,
} from './model.js'
import { getGlobalConfig } from '../config.js'

// @[MODEL LAUNCH]: 更新下方所有可用和默认的模型选项字符串。

export type ModelOption = {
  value: ModelSetting
  label: string
  description: string
  descriptionForModel?: string
}

/** 获取 get Default Option For User 对应的数据或状态。 */
export function getDefaultOptionForUser(fastMode = false): ModelOption {
  return {
    value: null,
    label: 'Default (recommended)',
    description: `Use the default model (currently ${renderDefaultModelSetting(getDefaultMainLoopModelSetting())}) · ${formatModelPricing(COST_TIER_3_15)}`,
  }
}

// @[MODEL LAUNCH]: 更新或添加模型选项函数（getSonnetXXOption、getOpusXXOption 等），使用新模型的标签和描述。这些显示在 /model 选择器中。
function getSonnet46Option(): ModelOption {
  return {
    value: 'sonnet',
    label: 'Sonnet',
    description: `Sonnet 4.6 · Best for everyday tasks · ${formatModelPricing(COST_TIER_3_15)}`,
    descriptionForModel:
      'Sonnet 4.6 - best for everyday tasks. Generally recommended for most coding tasks',
  }
}

/** 获取 get Opus46 Option 对应的数据或状态。 */
function getOpus46Option(fastMode = false): ModelOption {
  return {
    value: 'opus',
    label: 'Opus',
    description: `Opus 4.6 · Most capable for complex work${getOpus46PricingSuffix(fastMode)}`,
    descriptionForModel: 'Opus 4.6 - most capable for complex work',
  }
}

/** 获取 get Haiku45 Option 对应的数据或状态。 */
function getHaiku45Option(): ModelOption {
  return {
    value: 'haiku',
    label: 'Haiku',
    description: `Haiku 4.5 · Fastest for quick answers · ${formatModelPricing(COST_HAIKU_45)}`,
    descriptionForModel:
      'Haiku 4.5 - fastest for quick answers. Lower cost but less capable than Sonnet 4.6.',
  }
}

/** 获取 get Opus Plan Option 对应的数据或状态。 */
function getOpusPlanOption(): ModelOption {
  return {
    value: 'opusplan',
    label: 'Opus Plan Mode',
    description: 'Use Opus 4.6 in plan mode, Sonnet 4.6 otherwise',
  }
}

// @[MODEL LAUNCH]: 更新下方的模型选择器列表，以包含或重新排序新模型。
function getModelOptionsBase(fastMode = false): ModelOption[] {
  const options = [getDefaultOptionForUser(fastMode)]
  options.push(getOpus46Option(fastMode))
  options.push(getHaiku45Option())
  return options
}

// @[MODEL LAUNCH]: 将新模型 ID 添加到下方的相应系列模式中，以便“有新版本可用”提示正常工作。
/** 将完整模型名称映射到其系列别名以及该别名当前解析到的版本的营销名称。用于检测用户何时固定了特定的旧版本，并且存在更新的版本。 */
function getModelFamilyInfo(
  model: string,
): { alias: string; currentVersionName: string } | null {
  const canonical = getCanonicalName(model)

  // Sonnet 系列
  if (
    canonical.includes('claude-sonnet-4-6') ||
    canonical.includes('claude-sonnet-4-5') ||
    canonical.includes('claude-sonnet-4-') ||
    canonical.includes('claude-3-7-sonnet') ||
    canonical.includes('claude-3-5-sonnet')
  ) {
    const currentName = getMarketingNameForModel(getDefaultSonnetModel())
    if (currentName) {
      return { alias: 'Sonnet', currentVersionName: currentName }
    }
  }

  // Opus 系列
  if (canonical.includes('claude-opus-4')) {
    const currentName = getMarketingNameForModel(getDefaultOpusModel())
    if (currentName) {
      return { alias: 'Opus', currentVersionName: currentName }
    }
  }

  // Haiku 系列
  if (
    canonical.includes('claude-haiku') ||
    canonical.includes('claude-3-5-haiku')
  ) {
    const currentName = getMarketingNameForModel(getDefaultHaikuModel())
    if (currentName) {
      return { alias: 'Haiku', currentVersionName: currentName }
    }
  }

  return null
}

/** 为已知的 Anthropic 模型返回一个带有可读标签的 ModelOption，如果通过别名存在更新的版本，则提供升级提示。如果模型未被识别，则返回 null。 */
function getKnownModelOption(model: string): ModelOption | null {
  const marketingName = getMarketingNameForModel(model)
  if (!marketingName) return null

  const familyInfo = getModelFamilyInfo(model)
  if (!familyInfo) {
    return {
      value: model,
      label: marketingName,
      description: model,
    }
  }

  // 检查别名当前是否解析为不同的（更新的）版本
  if (marketingName !== familyInfo.currentVersionName) {
    return {
      value: model,
      label: marketingName,
      description: `Newer version available · select ${familyInfo.alias} for ${familyInfo.currentVersionName}`,
    }
  }

  // 与别名相同的版本——仅显示友好名称
  return {
    value: model,
    label: marketingName,
    description: model,
  }
}

/** 获取 get Model Options 对应的数据或状态。 */
export function getModelOptions(fastMode = false): ModelOption[] {
  const options = getModelOptionsBase(fastMode)

  // 从环境变量 ANTHROPIC_CUSTOM_MODEL_OPTION 添加自定义模型
  const envCustomModel = process.env.ANTHROPIC_CUSTOM_MODEL_OPTION
  if (
    envCustomModel &&
    !options.some(existing => existing.value === envCustomModel)
  ) {
    options.push({
      value: envCustomModel,
      label: process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME ?? envCustomModel,
      description:
        process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION ??
        `Custom model (${envCustomModel})`,
    })
  }

  // 从当前模型值或初始值添加自定义模型（如果它尚未在选项中）。
  let customModel: ModelSetting = null
  const currentMainLoopModel = getUserSpecifiedModelSetting()
  const initialMainLoopModel = getInitialMainLoopModel()
  if (currentMainLoopModel !== undefined && currentMainLoopModel !== null) {
    customModel = currentMainLoopModel
  } else if (initialMainLoopModel !== null) {
    customModel = initialMainLoopModel
  }
  if (customModel === null || options.some(opt => opt.value === customModel)) {
    return filterModelOptionsByAllowlist(options)
  } else if (customModel === 'opusplan') {
    return filterModelOptionsByAllowlist([...options, getOpusPlanOption()])
  } else if (customModel === 'opus') {
    return filterModelOptionsByAllowlist([
      ...options,
      getOpus46Option(fastMode),
    ])
  } else {
    // 尝试为已知的 Anthropic 模型显示可读标签，如果别名现在解析为更新的版本，则显示升级提示。
    const knownOption = getKnownModelOption(customModel)
    if (knownOption) {
      options.push(knownOption)
    } else {
      options.push({
        value: customModel,
        label: customModel,
        description: 'Custom model',
      })
    }
    return filterModelOptionsByAllowlist(options)
  }
}

/**
 * 通过availableModels允许列表过滤模型选项。
 * 始终保留“Default”选项（值：null）。
 */
function filterModelOptionsByAllowlist(options: ModelOption[]): ModelOption[] {
  const settings = getInitialSettings() || {}
  if (!settings.availableModels) {
    return options // 无限制
  }
  return options.filter(
    opt =>
      opt.value === null || (opt.value !== null && isModelAllowed(opt.value)),
  )
}
