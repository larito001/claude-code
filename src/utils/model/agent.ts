import type { PermissionMode } from '../permissions/PermissionMode.js'
import { capitalize } from '../stringUtils.js'
import { MODEL_ALIASES, type ModelAlias } from './aliases.js'
import {
  getCanonicalName,
  getRuntimeMainLoopModel,
  parseUserSpecifiedModel,
} from './model.js'

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
 * 子代理别名优先继承父模型层级；显式模型 ID 保持不变。
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

  // 如果提供了工具指定的模型，则优先使用
  if (toolSpecifiedModel) {
    if (aliasMatchesParentTier(toolSpecifiedModel, parentModel)) {
      return parentModel
    }
    return parseUserSpecifiedModel(toolSpecifiedModel)
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
  return parseUserSpecifiedModel(agentModelWithExp)
}

/**
 * 检查裸系列别名（opus/sonnet/haiku）是否匹配父模型的层级。
 * 如果匹配，子代理将继承父模型的确切模型字符串，而不是将别名解析为提供者默认值。
 *
 * 防止父线程使用精确模型时，裸系列别名被重新解析成另一个版本。
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
