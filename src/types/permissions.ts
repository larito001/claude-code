/**
 * 提取纯权限类型定义以打破导入周期。
 *
 * 该文件仅包含类型定义和常量，没有运行时依赖项。
 * 实现文件保留在 src/utils/permissions/ 中，但现在可以从这里导入
 * 以避免循环依赖。
 */

import { feature } from 'src/utils/features.js'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'

// ============================================================================
// 权限模式
// ============================================================================

export const EXTERNAL_PERMISSION_MODES = [
  'acceptEdits',
  'bypassPermissions',
  'default',
  'dontAsk',
  'plan',
  'auto',
] as const

export type ExternalPermissionMode = (typeof EXTERNAL_PERMISSION_MODES)[number]

// 用于类型检查的穷举模式联合。用户可寻址运行时集
// 下面是 INTERNAL_PERMISSION_MODES。
export type InternalPermissionMode = ExternalPermissionMode | 'bubble'
export type PermissionMode = InternalPermissionMode

// 运行时验证集：用户可寻址的模式（settings.json
// defaultMode、--permission-mode CLI 标志、对话恢复）。
export const INTERNAL_PERMISSION_MODES = [
  ...EXTERNAL_PERMISSION_MODES.filter(mode => mode !== 'auto'),
  ...(feature('TRANSCRIPT_CLASSIFIER') ? (['auto'] as const) : ([] as const)),
] as const satisfies readonly PermissionMode[]

export const PERMISSION_MODES = INTERNAL_PERMISSION_MODES

// ============================================================================
// 权限行为
// ============================================================================

export type PermissionBehavior = 'allow' | 'deny' | 'ask'

// ============================================================================
// 权限规则
// ============================================================================

/**
 * 权限规则源自何处。
 * 包括所有设置源值以及其他特定于规则的源。
 */
export type PermissionRuleSource =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'flagSettings'
  | 'policySettings'
  | 'cliArg'
  | 'command'
  | 'session'

/**
 * 权限规则的值 - 指定使用哪个工具和可选内容
 */
export type PermissionRuleValue = {
  toolName: string
  ruleContent?: string
}

/**
 * 权限规则及其来源和行为
 */
export type PermissionRule = {
  source: PermissionRuleSource
  ruleBehavior: PermissionBehavior
  ruleValue: PermissionRuleValue
}

// ============================================================================
// 权限更新
// ============================================================================

/**
 * 应保留权限更新的位置
 */
export type PermissionUpdateDestination =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'session'
  | 'cliArg'

/**
 * 权限配置的更新操作
 */
export type PermissionUpdate =
  | {
      type: 'addRules'
      destination: PermissionUpdateDestination
      rules: PermissionRuleValue[]
      behavior: PermissionBehavior
    }
  | {
      type: 'replaceRules'
      destination: PermissionUpdateDestination
      rules: PermissionRuleValue[]
      behavior: PermissionBehavior
    }
  | {
      type: 'removeRules'
      destination: PermissionUpdateDestination
      rules: PermissionRuleValue[]
      behavior: PermissionBehavior
    }
  | {
      type: 'setMode'
      destination: PermissionUpdateDestination
      mode: ExternalPermissionMode
    }
  | {
      type: 'addDirectories'
      destination: PermissionUpdateDestination
      directories: string[]
    }
  | {
      type: 'removeDirectories'
      destination: PermissionUpdateDestination
      directories: string[]
    }

/**
 * 附加工作目录权限的来源。
 * 注意：这目前与 PermissionRuleSource 相同，但保留为
 * 为了语义清晰和未来潜在的分歧而使用单独的类型。
 */
export type WorkingDirectorySource = PermissionRuleSource

/**
 * 权限范围内包含的附加目录
 */
export type AdditionalWorkingDirectory = {
  path: string
  source: WorkingDirectorySource
}

// ============================================================================
// 许可决定和结果
// ============================================================================

/**
 * 权限元数据的最小命令形状。
 * 这是有意成为完整命令类型的子集，以避免导入循环。
 * 仅包含与权限相关的组件所需的属性。
 */
export type PermissionCommandMetadata = {
  name: string
  description?: string
  // 允许附加属性以实现向前兼容性
  [key: string]: unknown
}

/**
 * 附加到权限决策的元数据
 */
export type PermissionMetadata =
  | { command: PermissionCommandMetadata }
  | undefined

/**
 * 授予权限后的结果
 */
export type PermissionAllowDecision<
  Input extends { [key: string]: unknown } = { [key: string]: unknown },
> = {
  behavior: 'allow'
  updatedInput?: Input
  userModified?: boolean
  decisionReason?: PermissionDecisionReason
  toolUseID?: string
  acceptFeedback?: string
  contentBlocks?: ContentBlockParam[]
}

/**
 * 将异步运行的待处理分类器检查的元数据。
 * 用于启用非阻塞允许分类器评估。
 */
export type PendingClassifierCheck = {
  command: string
  cwd: string
  descriptions: string[]
}

/**
 * 应提示用户时的结果
 */
export type PermissionAskDecision<
  Input extends { [key: string]: unknown } = { [key: string]: unknown },
> = {
  behavior: 'ask'
  message: string
  updatedInput?: Input
  decisionReason?: PermissionDecisionReason
  suggestions?: PermissionUpdate[]
  blockedPath?: string
  metadata?: PermissionMetadata
  /**
   * If true, this ask decision was triggered by a bashCommandIsSafe_DEPRECATED security check
   * for patterns that splitCommand_DEPRECATED could misparse (e.g. line continuations, shell-quote
   * 变换）。由 bashToolHasPermission 用于在 splitCommand_DEPRECATED 之前提前阻止
   * 转换命令。没有为简单的换行复合命令设置。
   */
  isBashSecurityCheckForMisparsing?: boolean
  /**
   * If set, an allow classifier check should be run asynchronously.
   * 分类器可以在用户响应之前自动批准许可。
   */
  pendingClassifierCheck?: PendingClassifierCheck
  /**
   * 与拒绝一起包含的可选内容块（例如图像）
   * 工具结果中的消息。当用户粘贴图像作为反馈时使用。
   */
  contentBlocks?: ContentBlockParam[]
}

/**
 * 权限被拒绝时的结果
 */
export type PermissionDenyDecision = {
  behavior: 'deny'
  message: string
  decisionReason: PermissionDecisionReason
  toolUseID?: string
}

/**
 * 许可决定 - 允许、询问或拒绝
 */
export type PermissionDecision<
  Input extends { [key: string]: unknown } = { [key: string]: unknown },
> =
  | PermissionAllowDecision<Input>
  | PermissionAskDecision<Input>
  | PermissionDenyDecision

/**
 * 具有附加直通选项的权限结果
 */
export type PermissionResult<
  Input extends { [key: string]: unknown } = { [key: string]: unknown },
> =
  | PermissionDecision<Input>
  | {
      behavior: 'passthrough'
      message: string
      decisionReason?: PermissionDecision<Input>['decisionReason']
      suggestions?: PermissionUpdate[]
      blockedPath?: string
      /**
       * If set, an allow classifier check should be run asynchronously.
       * 分类器可以在用户响应之前自动批准许可。
       */
      pendingClassifierCheck?: PendingClassifierCheck
    }

/**
 * 解释为何做出许可决定
 */
export type PermissionDecisionReason =
  | {
      type: 'rule'
      rule: PermissionRule
    }
  | {
      type: 'mode'
      mode: PermissionMode
    }
  | {
      type: 'subcommandResults'
      reasons: Map<string, PermissionResult>
    }
  | {
      type: 'permissionPromptTool'
      permissionPromptToolName: string
      toolResult: unknown
    }
  | {
      type: 'hook'
      hookName: string
      hookSource?: string
      reason?: string
    }
  | {
      type: 'asyncAgent'
      reason: string
    }
  | {
      type: 'sandboxOverride'
      reason: 'excludedCommand' | 'dangerouslyDisableSandbox'
    }
  | {
      type: 'classifier'
      classifier: string
      reason: string
    }
  | {
      type: 'workingDir'
      reason: string
    }
  | {
      type: 'safetyCheck'
      reason: string
      // 当 true 时，自动模式让分类器评估它而不是
      // 强制提示。对于敏感文件路径（.claude/、.git/、
      // shell 配置）——分类器可以查看上下文并作出判断；Windows 路径绕过尝试和跨机器桥接消息则必须保持不可批准。
      classifierApprovable: boolean
    }
  | {
      type: 'other'
      reason: string
    }

// ============================================================================
// Bash 分类器类型
// ============================================================================

export type ClassifierResult = {
  matches: boolean
  matchedDescription?: string
  confidence: 'high' | 'medium' | 'low'
  reason: string
}

export type ClassifierBehavior = 'deny' | 'ask' | 'allow'

export type YoloClassifierResult = {
  thinking?: string
  shouldBlock: boolean
  reason: string
  unavailable?: boolean
  transcriptTooLong?: boolean
  model: string
  errorDumpPath?: string
}

// ============================================================================
// 权限解释器类型
// ============================================================================

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH'

export type PermissionExplanation = {
  riskLevel: RiskLevel
  explanation: string
  reasoning: string
  risk: string
}

// ============================================================================
// 工具权限上下文
// ============================================================================

/**
 * 按来源映射权限规则
 */
export type ToolPermissionRulesBySource = {
  [T in PermissionRuleSource]?: string[]
}

/**
 * 工具中权限检查所需的上下文
 * 注意：对此仅类型文件使用简化的 DeepImmutable 近似
 */
export type ToolPermissionContext = {
  readonly mode: PermissionMode
  readonly additionalWorkingDirectories: ReadonlyMap<
    string,
    AdditionalWorkingDirectory
  >
  readonly alwaysAllowRules: ToolPermissionRulesBySource
  readonly alwaysDenyRules: ToolPermissionRulesBySource
  readonly alwaysAskRules: ToolPermissionRulesBySource
  readonly isBypassPermissionsModeAvailable: boolean
  readonly strippedDangerousRules?: ToolPermissionRulesBySource
  readonly shouldAvoidPermissionPrompts?: boolean
  readonly awaitAutomatedChecksBeforeDialog?: boolean
  readonly prePlanMode?: PermissionMode
}
