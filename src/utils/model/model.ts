import { getMainLoopModelOverride } from '../../bootstrap/state.js'
import {
  has1mContext,
  is1mContextDisabled,
  modelSupports1M,
} from '../context.js'
import { isEnvTruthy } from '../envUtils.js'
import { getModelStrings, resolveOverriddenModel } from './modelStrings.js'
import { formatModelPricing, getOpus46CostTier } from '../modelCost.js'
import { getInitialSettings } from '../settings/settings.js'
import type { PermissionMode } from '../permissions/PermissionMode.js'
import { LIGHTNING_BOLT } from '../../constants/figures.js'
import { isModelAllowed } from './modelAllowlist.js'
import { type ModelAlias, isModelAlias } from './aliases.js'
import { capitalize } from '../stringUtils.js'

export type ModelShortName = string
export type ModelName = string
export type ModelSetting = ModelName | ModelAlias | null

/** 获取 get Small Fast Model 对应的数据或状态。 */
export function getSmallFastModel(): ModelName {
  return process.env.ANTHROPIC_SMALL_FAST_MODEL || getDefaultHaikuModel()
}

/** 判断是否满足 is Non Custom Opus Model 对应的数据或状态。 */
export function isNonCustomOpusModel(model: ModelName): boolean {
  return (
    model === getModelStrings().opus40 ||
    model === getModelStrings().opus41 ||
    model === getModelStrings().opus45 ||
    model === getModelStrings().opus46
  )
}

/**
 * 从 /model（包括通过 /config）获取模型的帮助程序、--model 标志、环境变量、
 * 或保存的设置。如果用户指定的话，返回的值可以是模型别名。
 * 如果用户没有配置任何内容，则未定义，在这种情况下我们回退到
 * 默认值（空）。
 *
 * 该函数内的优先级顺序：
 * 1. 会话期间模型覆盖（来自 /model 命令）- 最高优先级
 * 2. 启动时模型覆盖（来自 --model 标志）
 * 3.ANTHROPIC_MODEL环境变量
 * 4. 设置（来自用户保存的设置）
 */
export function getUserSpecifiedModelSetting(): ModelSetting | undefined {
  let specifiedModel: ModelSetting | undefined

  const modelOverride = getMainLoopModelOverride()
  if (modelOverride !== undefined) {
    specifiedModel = modelOverride
  } else {
    const settings = getInitialSettings() || {}
    specifiedModel = process.env.ANTHROPIC_MODEL || settings.model || undefined
  }

  // 如果用户指定的模型不在 availableModels 允许列表中，则忽略该模型。
  if (specifiedModel && !isModelAllowed(specifiedModel)) {
    return undefined
  }

  return specifiedModel
}

/**
 * 获取当前会话使用的主循环模型。
 *
 * 选型优先顺序：
 * 1. 会话期间模型覆盖（来自 /model 命令）- 最高优先级
 * 2. 启动时模型覆盖（来自 --model 标志）
 * 3.ANTHROPIC_MODEL环境变量
 * 4. 设置（来自用户保存的设置）
 * 5. 内置默认值
 *
 * @returns 要使用的解析模型名称
 */
export function getMainLoopModel(): ModelName {
  const model = getUserSpecifiedModelSetting()
  if (model !== undefined && model !== null) {
    return parseUserSpecifiedModel(model)
  }
  return getDefaultMainLoopModel()
}

/** 获取 get Best Model 对应的数据或状态。 */
export function getBestModel(): ModelName {
  return getDefaultOpusModel()
}

// @[MODEL LAUNCH]：更新默认的 Opus 模型。
export function getDefaultOpusModel(): ModelName {
  if (process.env.ANTHROPIC_DEFAULT_OPUS_MODEL) {
    return process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
  }
  return getModelStrings().opus46
}

// @[MODEL LAUNCH]：更新默认的 Sonnet 模型。
export function getDefaultSonnetModel(): ModelName {
  if (process.env.ANTHROPIC_DEFAULT_SONNET_MODEL) {
    return process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
  }
  return getModelStrings().sonnet46
}

// @[模型启动]：更新默认俳句模型（3P 提供商可能会滞后，因此保持默认值不变）。
export function getDefaultHaikuModel(): ModelName {
  if (process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL) {
    return process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  }

  // API 默认使用 Haiku 4.5。
  return getModelStrings().haiku45
}

/**
 * 根据运行时上下文获取运行时使用的模型。
 * @param params 运行时上下文的子集，用于确定要使用的模型。
 * @returns 使用的模型
 */
export function getRuntimeMainLoopModel(params: {
  permissionMode: PermissionMode
  mainLoopModel: string
  exceeds200kTokens?: boolean
}): ModelName {
  const { permissionMode, mainLoopModel, exceeds200kTokens = false } = params

  // opusplan 在计划模式下使用 Opus，不带 [1m] 后缀。
  if (
    getUserSpecifiedModelSetting() === 'opusplan' &&
    permissionMode === 'plan' &&
    !exceeds200kTokens
  ) {
    return getDefaultOpusModel()
  }

  // 默认十四行诗计划
  if (getUserSpecifiedModelSetting() === 'haiku' && permissionMode === 'plan') {
    return getDefaultSonnetModel()
  }

  return mainLoopModel
}

/** 返回活动API提供商的默认主循环模型。 */
export function getDefaultMainLoopModelSetting(): ModelName | ModelAlias {
  // API密钥和云提供商默认使用其配置的Sonnet模型。
  return getDefaultSonnetModel()
}

/**
 * 同步操作以获取要使用的默认主循环模型
 * （绕过任何用户指定的值）。
 */
export function getDefaultMainLoopModel(): ModelName {
  return parseUserSpecifiedModel(getDefaultMainLoopModelSetting())
}

// @[MODEL LAUNCH]：为下面的新模型添加规范名称映射。
/**
 * 纯字符串匹配，从第一方模型中删除日期/提供商后缀
 * 姓名。输入必须已经是 1P 格式的 ID（例如“claude-3-7-sonnet-20250219”，
 * 'us.anthropic.claude-opus-4-6-v1:0')。不触及设置，因此安全
 * 模块顶层（请参阅 modelCost.ts 中的 MODEL_COSTS）。
 */
export function firstPartyNameToCanonical(name: ModelName): ModelShortName {
  name = name.toLowerCase()
  // Claude 4+型号的特殊情况以区分版本
  // 顺序事项：先检查更具体的版本（4-5之前4）
  if (name.includes('claude-opus-4-6')) {
    return 'claude-opus-4-6'
  }
  if (name.includes('claude-opus-4-5')) {
    return 'claude-opus-4-5'
  }
  if (name.includes('claude-opus-4-1')) {
    return 'claude-opus-4-1'
  }
  if (name.includes('claude-opus-4')) {
    return 'claude-opus-4'
  }
  if (name.includes('claude-sonnet-4-6')) {
    return 'claude-sonnet-4-6'
  }
  if (name.includes('claude-sonnet-4-5')) {
    return 'claude-sonnet-4-5'
  }
  if (name.includes('claude-sonnet-4')) {
    return 'claude-sonnet-4'
  }
  if (name.includes('claude-haiku-4-5')) {
    return 'claude-haiku-4-5'
  }
  // Claude 3.x 模型使用不同的命名方案 (claude-3-{family})
  if (name.includes('claude-3-7-sonnet')) {
    return 'claude-3-7-sonnet'
  }
  if (name.includes('claude-3-5-sonnet')) {
    return 'claude-3-5-sonnet'
  }
  if (name.includes('claude-3-5-haiku')) {
    return 'claude-3-5-haiku'
  }
  if (name.includes('claude-3-opus')) {
    return 'claude-3-opus'
  }
  if (name.includes('claude-3-sonnet')) {
    return 'claude-3-sonnet'
  }
  if (name.includes('claude-3-haiku')) {
    return 'claude-3-haiku'
  }
  const match = name.match(/(claude-(\d+-\d+-)?\w+)/)
  if (match && match[1]) {
    return match[1]
  }
  // 如果没有模式匹配，则回退到原始名称
  return name
}

/**
 * 将完整模型字符串映射到跨 1P 和 3P 提供商统一的较短规范版本。
 * For example, 'claude-3-5-haiku-20241022' and 'us.anthropic.claude-3-5-haiku-20241022-v1:0'
 * 都将映射到“claude-3-5-haiku”。
 * @param fullModelName 完整的模型名称（例如“claude-3-5-haiku-20241022”）
 * @returns 如果找到则为短名称（例如“claude-3-5-haiku”），如果不存在映射则为原始名称
 */
export function getCanonicalName(fullModelName: ModelName): ModelShortName {
  // 将覆盖的模型 ID 解析回规范名称。
  // solved 始终是 1P 格式的 ID，因此firstPartyNameToCanonical 可以处理它。
  return firstPartyNameToCanonical(resolveOverriddenModel(fullModelName))
}

/** 执行 render Default Model Setting 对应的业务处理。 */
export function renderDefaultModelSetting(
  setting: ModelName | ModelAlias,
): string {
  if (setting === 'opusplan') {
    return 'Opus 4.6 in plan mode, else Sonnet 4.6'
  }
  return renderModelName(parseUserSpecifiedModel(setting))
}

/** 获取 get Opus46 Pricing Suffix 对应的数据或状态。 */
export function getOpus46PricingSuffix(fastMode: boolean): string {
  const pricing = formatModelPricing(getOpus46CostTier(fastMode))
  const fastModeIndicator = fastMode ? ` (${LIGHTNING_BOLT})` : ''
  return ` ·${fastModeIndicator} ${pricing}`
}

/** 判断是否满足 is Opus1m Merge Enabled 对应的数据或状态。 */
export function isOpus1mMergeEnabled(): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  return true
}

/** 执行 render Model Setting 对应的业务处理。 */
export function renderModelSetting(setting: ModelName | ModelAlias): string {
  if (setting === 'opusplan') {
    return 'Opus Plan'
  }
  if (isModelAlias(setting)) {
    return capitalize(setting)
  }
  return renderModelName(setting)
}

// @[MODEL LAUNCH]: 为新模型添加显示名称条目（基础版 + [1m] 变体，如果适用）。
/** 返回已知公共模型的人类可读显示名称，如果模型未被识别为公共模型则返回null。 */
export function getPublicModelDisplayName(model: ModelName): string | null {
  switch (model) {
    case getModelStrings().opus46:
      return 'Opus 4.6'
    case getModelStrings().opus46 + '[1m]':
      return 'Opus 4.6 (1M context)'
    case getModelStrings().opus45:
      return 'Opus 4.5'
    case getModelStrings().opus41:
      return 'Opus 4.1'
    case getModelStrings().opus40:
      return 'Opus 4'
    case getModelStrings().sonnet46 + '[1m]':
      return 'Sonnet 4.6 (1M context)'
    case getModelStrings().sonnet46:
      return 'Sonnet 4.6'
    case getModelStrings().sonnet45 + '[1m]':
      return 'Sonnet 4.5 (1M context)'
    case getModelStrings().sonnet45:
      return 'Sonnet 4.5'
    case getModelStrings().sonnet40:
      return 'Sonnet 4'
    case getModelStrings().sonnet40 + '[1m]':
      return 'Sonnet 4 (1M context)'
    case getModelStrings().sonnet37:
      return 'Sonnet 3.7'
    case getModelStrings().sonnet35:
      return 'Sonnet 3.5'
    case getModelStrings().haiku45:
      return 'Haiku 4.5'
    case getModelStrings().haiku35:
      return 'Haiku 3.5'
    default:
      return null
  }
}

/** 执行 render Model Name 对应的业务处理。 */
export function renderModelName(model: ModelName): string {
  const publicName = getPublicModelDisplayName(model)
  if (publicName) {
    return publicName
  }
  return model
}

/**
 * 返回用于公共显示的可靠作者名称（例如，在git提交尾注中）。
 * 对于已知公共模型返回"Claude {ModelName}"，对于未知/内部模型返回"Claude ({model})"，以保留确切的模型名称。
 *
 * @param model 完整模型名称
 * @returns 对于公共模型返回"Claude {ModelName}"，对于非公共模型返回"Claude ({model})"
 */
export function getPublicModelName(model: ModelName): string {
  const publicName = getPublicModelDisplayName(model)
  if (publicName) {
    return `Claude ${publicName}`
  }
  return `Claude (${model})`
}

/**
 * 返回在此会话中使用的完整模型名称，可能在解析模型别名之后。
 *
 * 此函数有意不支持版本号，以与模型切换器保持一致。
 *
 * 支持在任何模型别名上添加[1m]后缀（例如haiku[1m]、sonnet[1m]），以启用1M上下文窗口，而无需每个变体都包含在MODEL_ALIASES中。
 *
 * @param modelInput 用户提供的模型别名或名称。
 */
export function parseUserSpecifiedModel(
  modelInput: ModelName | ModelAlias,
): ModelName {
  const modelInputTrimmed = modelInput.trim()
  const normalizedModel = modelInputTrimmed.toLowerCase()

  const has1mTag = has1mContext(normalizedModel)
  const modelString = has1mTag
    ? normalizedModel.replace(/\[1m]$/i, '').trim()
    : normalizedModel

  if (isModelAlias(modelString)) {
    switch (modelString) {
      case 'opusplan':
        return getDefaultSonnetModel() + (has1mTag ? '[1m]' : '') // Sonnet是默认值，Opus在计划模式下
      case 'sonnet':
        return getDefaultSonnetModel() + (has1mTag ? '[1m]' : '')
      case 'haiku':
        return getDefaultHaikuModel() + (has1mTag ? '[1m]' : '')
      case 'opus':
        return getDefaultOpusModel() + (has1mTag ? '[1m]' : '')
      case 'best':
        return getBestModel()
      default:
    }
  }

  // 保留自定义模型名称的原始大小写（例如Azure Foundry部署ID）
  // 仅剥离存在的[1m]后缀，保持基础模型的大小写
  if (has1mTag) {
    return modelInputTrimmed.replace(/\[1m\]$/i, '').trim() + '[1m]'
  }
  return modelInputTrimmed
}

/**
 * 将技能的`model:`前置元数据根据当前模型进行解析，当目标系列支持时，携带`[1m]`后缀。
 *
 * 技能作者编写`model: opus`意味着“使用opus类推理”——而不是“降级到200K”。如果用户当前在230K token的opus[1m]上，并调用了一个`model: opus`的技能，传递原始别名会将有效上下文窗口从1M降低到200K，这会在23%的表观使用率下触发自动压缩，并显示“上下文限制已到达”，尽管没有溢出。
 *
 * 我们仅在目标实际支持[1m]时（sonnet/opus）才携带。在1M会话中带有`model: haiku`的技能仍然会降级——haiku没有1M变体，因此后续的自动压缩是正确的。已经明确指定了[1m]的技能保持不变。
 */
export function resolveSkillModelOverride(
  skillModel: string,
  currentModel: string,
): string {
  if (has1mContext(skillModel) || !has1mContext(currentModel)) {
    return skillModel
  }
  // modelSupports1M 匹配规范ID（'claude-opus-4-6'、'claude-sonnet-4'）；裸的'opus'别名在getCanonicalName中未匹配。先解析。
  if (modelSupports1M(parseUserSpecifiedModel(skillModel))) {
    return skillModel + '[1m]'
  }
  return skillModel
}

/** 执行 model Display String 对应的业务处理。 */
export function modelDisplayString(model: ModelSetting): string {
  if (model === null) {
    return `Default (${getDefaultMainLoopModel()})`
  }
  const resolvedModel = parseUserSpecifiedModel(model)
  return model === resolvedModel ? resolvedModel : `${model} (${resolvedModel})`
}

// @[MODEL LAUNCH]: 为下面的新模型添加一个市场名称映射。
export function getMarketingNameForModel(modelId: string): string | undefined {
  const has1m = modelId.toLowerCase().includes('[1m]')
  const canonical = getCanonicalName(modelId)

  if (canonical.includes('claude-opus-4-6')) {
    return has1m ? 'Opus 4.6 (with 1M context)' : 'Opus 4.6'
  }
  if (canonical.includes('claude-opus-4-5')) {
    return 'Opus 4.5'
  }
  if (canonical.includes('claude-opus-4-1')) {
    return 'Opus 4.1'
  }
  if (canonical.includes('claude-opus-4')) {
    return 'Opus 4'
  }
  if (canonical.includes('claude-sonnet-4-6')) {
    return has1m ? 'Sonnet 4.6 (with 1M context)' : 'Sonnet 4.6'
  }
  if (canonical.includes('claude-sonnet-4-5')) {
    return has1m ? 'Sonnet 4.5 (with 1M context)' : 'Sonnet 4.5'
  }
  if (canonical.includes('claude-sonnet-4')) {
    return has1m ? 'Sonnet 4 (with 1M context)' : 'Sonnet 4'
  }
  if (canonical.includes('claude-3-7-sonnet')) {
    return 'Claude 3.7 Sonnet'
  }
  if (canonical.includes('claude-3-5-sonnet')) {
    return 'Claude 3.5 Sonnet'
  }
  if (canonical.includes('claude-haiku-4-5')) {
    return 'Haiku 4.5'
  }
  if (canonical.includes('claude-3-5-haiku')) {
    return 'Claude 3.5 Haiku'
  }

  return undefined
}

/** 规范化 normalize Model String For API 对应的数据或状态。 */
export function normalizeModelStringForAPI(model: string): string {
  return model.replace(/\[(1|2)m\]/gi, '')
}
