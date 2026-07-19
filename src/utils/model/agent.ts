import type { PermissionMode } from '../permissions/PermissionMode.js'
import { capitalize } from '../stringUtils.js'
import { MODEL_ALIASES, type ModelAlias } from './aliases.js'
import { applyBedrockRegionPrefix, getBedrockRegionPrefix } from './bedrock.js'
import {
  getCanonicalName,
  getRuntimeMainLoopModel,
  parseUserSpecifiedModel,
} from './model.js'
import { getAPIProvider } from './providers.js'

export const AGENT_MODEL_OPTIONS = [...MODEL_ALIASES, 'inherit'] as const
export type AgentModelAlias = (typeof AGENT_MODEL_OPTIONS)[number]

export type AgentModelOption = {
  value: AgentModelAlias
  label: string
  description: string
}

/** 获取默认子代理模型。返回'inherit'，这样子代理继承父线程的模型。 */
export function getDefaultSubagentModel(): string {
  return 'inherit'
}

/**
 * 获取代理的有效模型字符串。
 *
 * 对于Bedrock，如果父模型使用跨区域推理前缀（例如"eu."、"us."），
 * 该前缀将被使用别名模型（例如"sonnet"、"haiku"、"opus"）的子代理继承。
 * 这确保子代理与父模型使用相同区域，当IAM权限限定于特定跨区域推理配置文件时是必要的。
 */
export function getAgentModel(
  agentModel: string | undefined,
  parentModel: string,
  toolSpecifiedModel?: ModelAlias,
  permissionMode?: PermissionMode,
): string {
  if (process.env.CLAUDE_CODE_SUBAGENT_MODEL) {
    return parseUserSpecifiedModel(process.env.CLAUDE_CODE_SUBAGENT_MODEL)
  }

  // 从父模型中提取Bedrock区域前缀以供子代理继承。
  // 这确保子代理使用与父模型相同的跨区域推理配置文件（例如"eu."、"us."），
  // 当IAM权限仅允许特定区域时是必需的。
  const parentRegionPrefix = getBedrockRegionPrefix(parentModel)

  // 辅助函数，用于为Bedrock模型应用父区域前缀。
  // `originalSpec`是解析前的原始模型字符串（别名或完整ID）。
  // 如果用户明确指定了已经带有自身区域前缀（例如"eu.anthropic.…"）的完整模型ID，
  // 我们将保留它，而不是用父模型前缀覆盖。这防止了当代理配置有意固定到与父模型不同区域时
  // 发生静默的数据驻留违规。
  const applyParentRegionPrefix = (
    resolvedModel: string,
    originalSpec: string,
  ): string => {
    if (parentRegionPrefix && getAPIProvider() === 'bedrock') {
      if (getBedrockRegionPrefix(originalSpec)) return resolvedModel
      return applyBedrockRegionPrefix(resolvedModel, parentRegionPrefix)
    }
    return resolvedModel
  }

  // 如果提供了工具指定的模型，则优先使用
  if (toolSpecifiedModel) {
    if (aliasMatchesParentTier(toolSpecifiedModel, parentModel)) {
      return parentModel
    }
    const model = parseUserSpecifiedModel(toolSpecifiedModel)
    return applyParentRegionPrefix(model, toolSpecifiedModel)
  }

  const agentModelWithExp = agentModel ?? getDefaultSubagentModel()

  if (agentModelWithExp === 'inherit') {
    // 对'inherit'应用运行时模型解析以获取有效模型
    // 这确保使用'inherit'的代理在计划模式下获得opusplan→Opus解析
    return getRuntimeMainLoopModel({
      permissionMode: permissionMode ?? 'default',
      mainLoopModel: parentModel,
      exceeds200kTokens: false,
    })
  }

  if (aliasMatchesParentTier(agentModelWithExp, parentModel)) {
    return parentModel
  }
  const model = parseUserSpecifiedModel(agentModelWithExp)
  return applyParentRegionPrefix(model, agentModelWithExp)
}

/**
 * 检查裸系列别名（opus/sonnet/haiku）是否匹配父模型的层级。
 * 如果匹配，子代理将继承父模型的确切模型字符串，而不是将别名解析为提供者默认值。
 *
 * 防止令人惊讶的降级：一个在Opus 4.6上的Vertex用户（通过/model）
 * 使用`model: opus`生成子代理时，应该获得Opus 4.6，而不是getDefaultOpusModel()为3P返回的任何值。
 * 参见 https://github.com/anthropics/claude-code/issues/30815。
 *
 * 仅裸系列别名匹配。`opus[1m]`、`best`、`opusplan`会通过，
 * 因为它们带有超出“与父模型相同层级”的语义。
 */
function aliasMatchesParentTier(alias: string, parentModel: string): boolean {
  const canonical = getCanonicalName(parentModel)
  switch (alias.toLowerCase()) {
    case 'opus':
      return canonical.includes('opus')
    case 'sonnet':
      return canonical.includes('sonnet')
    case 'haiku':
      return canonical.includes('haiku')
    default:
      return false
  }
}

/** 获取 get Agent Model Display 对应的数据或状态。 */
export function getAgentModelDisplay(model: string | undefined): string {
  // 当省略model时，getDefaultSubagentModel()在运行时返回'inherit'
  if (!model) return 'Inherit from parent (default)'
  if (model === 'inherit') return 'Inherit from parent'
  return capitalize(model)
}

/** 获取代理可用的模型选项 */
export function getAgentModelOptions(): AgentModelOption[] {
  return [
    {
      value: 'sonnet',
      label: 'Sonnet',
      description: 'Balanced performance - best for most agents',
    },
    {
      value: 'opus',
      label: 'Opus',
      description: 'Most capable for complex reasoning tasks',
    },
    {
      value: 'haiku',
      label: 'Haiku',
      description: 'Fast and efficient for simple tasks',
    },
    {
      value: 'inherit',
      label: 'Inherit from parent',
      description: 'Use the same model as the main conversation',
    },
  ]
}
