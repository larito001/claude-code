import type { ModelName } from './model.js'

export type ModelConfig = ModelName

// @[MODEL LAUNCH]: 在此添加新的 CLAUDE_*_CONFIG 常量。请仔细检查正确的模型字符串，因为模式可能会变化。

export const CLAUDE_3_7_SONNET_CONFIG =
  'claude-3-7-sonnet-20250219' as const satisfies ModelConfig

export const CLAUDE_3_5_V2_SONNET_CONFIG =
  'claude-3-5-sonnet-20241022' as const satisfies ModelConfig

export const CLAUDE_3_5_HAIKU_CONFIG =
  'claude-3-5-haiku-20241022' as const satisfies ModelConfig

export const CLAUDE_HAIKU_4_5_CONFIG =
  'claude-haiku-4-5-20251001' as const satisfies ModelConfig

export const CLAUDE_SONNET_4_CONFIG =
  'claude-sonnet-4-20250514' as const satisfies ModelConfig

export const CLAUDE_SONNET_4_5_CONFIG =
  'claude-sonnet-4-5-20250929' as const satisfies ModelConfig

export const CLAUDE_OPUS_4_CONFIG =
  'claude-opus-4-20250514' as const satisfies ModelConfig

export const CLAUDE_OPUS_4_1_CONFIG =
  'claude-opus-4-1-20250805' as const satisfies ModelConfig

export const CLAUDE_OPUS_4_5_CONFIG =
  'claude-opus-4-5-20251101' as const satisfies ModelConfig

export const CLAUDE_OPUS_4_6_CONFIG =
  'claude-opus-4-6' as const satisfies ModelConfig

export const CLAUDE_SONNET_4_6_CONFIG =
  'claude-sonnet-4-6' as const satisfies ModelConfig

// @[MODEL LAUNCH]: 在此注册新的配置。
export const ALL_MODEL_CONFIGS = {
  haiku35: CLAUDE_3_5_HAIKU_CONFIG,
  haiku45: CLAUDE_HAIKU_4_5_CONFIG,
  sonnet35: CLAUDE_3_5_V2_SONNET_CONFIG,
  sonnet37: CLAUDE_3_7_SONNET_CONFIG,
  sonnet40: CLAUDE_SONNET_4_CONFIG,
  sonnet45: CLAUDE_SONNET_4_5_CONFIG,
  sonnet46: CLAUDE_SONNET_4_6_CONFIG,
  opus40: CLAUDE_OPUS_4_CONFIG,
  opus41: CLAUDE_OPUS_4_1_CONFIG,
  opus45: CLAUDE_OPUS_4_5_CONFIG,
  opus46: CLAUDE_OPUS_4_6_CONFIG,
} as const satisfies Record<string, ModelConfig>

export type ModelKey = keyof typeof ALL_MODEL_CONFIGS

/** 所有规范的第一方模型 ID 的联合类型，例如 'claude-opus-4-6' | 'claude-sonnet-4-5-20250929' | … */
export type CanonicalModelId =
  (typeof ALL_MODEL_CONFIGS)[ModelKey]

/** 运行时规范模型 ID 列表 — 用于全面性测试。 */
export const CANONICAL_MODEL_IDS = Object.values(ALL_MODEL_CONFIGS).map(
  model => model,
) as [CanonicalModelId, ...CanonicalModelId[]]

/** 将规范 ID 映射到内部短键。用于应用基于设置的 modelOverrides。 */
export const CANONICAL_ID_TO_KEY: Record<CanonicalModelId, ModelKey> =
  Object.fromEntries(
    (Object.entries(ALL_MODEL_CONFIGS) as [ModelKey, ModelConfig][]).map(
      ([key, model]) => [model, key],
    ),
  ) as Record<CanonicalModelId, ModelKey>
