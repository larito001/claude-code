export const MODEL_ALIASES = [
  'sonnet',
  'opus',
  'haiku',
  'best',
  'sonnet[1m]',
  'opus[1m]',
  'opusplan',
] as const
export type ModelAlias = (typeof MODEL_ALIASES)[number]

/** 判断是否满足 is Model Alias 对应的数据或状态。 */
export function isModelAlias(modelInput: string): modelInput is ModelAlias {
  return MODEL_ALIASES.includes(modelInput as ModelAlias)
}

/**
 * 在availableModels允许列表中充当通配符的纯模型系列别名。
 * 当允许列表中有“opus”时，任何opus模型都被允许（opus 4.5、4.6等）。
 * 当允许列表中有特定模型ID时，仅允许该确切版本。
 */
export const MODEL_FAMILY_ALIASES = ['sonnet', 'opus', 'haiku'] as const

/** 判断是否满足 is Model Family Alias 对应的数据或状态。 */
export function isModelFamilyAlias(model: string): boolean {
  return (MODEL_FAMILY_ALIASES as readonly string[]).includes(model)
}
