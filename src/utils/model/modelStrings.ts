import {
  getModelStrings as getModelStringsState,
  setModelStrings as setModelStringsState,
} from 'src/bootstrap/state.js'
import { getInitialSettings } from '../settings/settings.js'
import {
  ALL_MODEL_CONFIGS,
  CANONICAL_ID_TO_KEY,
  type CanonicalModelId,
  type ModelKey,
} from './configs.js'

/** 当前模型别名到实际 API 模型 ID 的映射。 */
export type ModelStrings = Record<ModelKey, string>

const MODEL_KEYS = Object.keys(ALL_MODEL_CONFIGS) as ModelKey[]

function getBuiltinModelStrings(): ModelStrings {
  const modelStrings = {} as ModelStrings
  for (const key of MODEL_KEYS) modelStrings[key] = ALL_MODEL_CONFIGS[key]
  return modelStrings
}

/** 将用户配置的模型覆盖应用到规范模型列表。 */
function applyModelOverrides(modelStrings: ModelStrings): ModelStrings {
  const overrides = getInitialSettings().modelOverrides
  if (!overrides) return modelStrings

  const result = { ...modelStrings }
  for (const [canonicalId, override] of Object.entries(overrides)) {
    const key = CANONICAL_ID_TO_KEY[canonicalId as CanonicalModelId]
    if (key && override) result[key] = override
  }
  return result
}

/** 将覆盖后的模型 ID 还原为规范模型 ID。 */
export function resolveOverriddenModel(modelId: string): string {
  let overrides: Record<string, string> | undefined
  try {
    overrides = getInitialSettings().modelOverrides
  } catch {
    return modelId
  }
  if (!overrides) return modelId

  for (const [canonicalId, override] of Object.entries(overrides)) {
    if (override === modelId) return canonicalId
  }
  return modelId
}

function initializeModelStrings(): ModelStrings {
  const modelStrings = getBuiltinModelStrings()
  setModelStringsState(modelStrings)
  return modelStrings
}

/** 获取应用了用户覆盖的模型字符串。 */
export function getModelStrings(): ModelStrings {
  const modelStrings = getModelStringsState() ?? initializeModelStrings()
  return applyModelOverrides(modelStrings)
}

/** 保留异步签名，供启动链和 SDK 调用方统一等待。 */
export async function ensureModelStringsInitialized(): Promise<void> {
  if (getModelStringsState() === null) initializeModelStrings()
}
