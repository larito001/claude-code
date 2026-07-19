import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { UUID } from 'crypto'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import type { CompactionResult } from '../services/compact/compact.js'
import type { ScopedMcpServerConfig } from '../services/mcp/types.js'
import type { ToolUseContext } from '../Tool.js'
import type { EffortValue } from '../utils/effort.js'
import type { IDEExtensionInstallationStatus, IdeType } from '../utils/ide.js'
import type { SettingSource } from '../utils/settings/constants.js'
import type { HooksSettings } from '../utils/settings/types.js'
import type { ThemeName } from '../utils/theme.js'
import type { LogOption } from './logs.js'
import type { Message } from './message.js'
import type { PluginManifest } from './plugin.js'

export type LocalCommandResult =
  | { type: 'text'; value: string }
  | {
      type: 'compact'
      compactionResult: CompactionResult
      displayText?: string
    }
  | { type: 'skip' } // 跳过消息

export type PromptCommand = {
  type: 'prompt'
  progressMessage: string
  contentLength: number // 命令内容的字符长度（用于估算 token）
  argNames?: string[]
  allowedTools?: string[]
  model?: string
  source: SettingSource | 'builtin' | 'mcp' | 'plugin' | 'bundled'
  pluginInfo?: {
    pluginManifest: PluginManifest
    source: string
  }
  disableNonInteractive?: boolean
  // 调用此技能时注册的钩子
  hooks?: HooksSettings
  // 技能资源的基础目录（用于为技能钩子设置 CLAUDE_PLUGIN_ROOT 环境变量）
  skillRoot?: string
  // 执行上下文：'inline'（默认）或 'fork'（作为子代理运行）
  // 'inline' = 技能内容展开到当前对话中
  // 'fork' = 技能在具有独立上下文和 token 预算的子代理中运行
  context?: 'inline' | 'fork'
  // 分叉时使用的代理类型（例如 'Bash'、'general-purpose'）
  // 仅当上下文为 'fork' 时适用
  agent?: string
  effort?: EffortValue
  // 此技能适用的文件路径 glob 模式
  // 设置后，仅当模型触及匹配文件时技能才可见
  paths?: string[]
  /** 获取 get Prompt For Command 对应的数据或状态。 */
  getPromptForCommand(
    args: string,
    context: ToolUseContext,
  ): Promise<ContentBlockParam[]>
}

/** 本地命令实现的调用签名。 */
export type LocalCommandCall = (
  args: string,
  context: LocalJSXCommandContext,
) => Promise<LocalCommandResult>

/** load() 为惰性加载的本地命令返回的模块形状。 */
export type LocalCommandModule = {
  call: LocalCommandCall
}

type LocalCommand = {
  type: 'local'
  supportsNonInteractive: boolean
  /** 获取 load 对应的数据或状态。 */
  load: () => Promise<LocalCommandModule>
}

export type LocalJSXCommandContext = ToolUseContext & {
  canUseTool?: CanUseToolFn
  /** 设置并保存 set Messages 对应的数据或状态。 */
  setMessages: (updater: (prev: Message[]) => Message[]) => void
  options: {
    dynamicMcpConfig?: Record<string, ScopedMcpServerConfig>
    ideInstallationStatus: IDEExtensionInstallationStatus | null
    theme: ThemeName
  }
  /** 处理 on Change API Key 对应的数据或状态。 */
  onChangeAPIKey: () => void
  /** 处理 on Change Dynamic Mcp Config 对应的数据或状态。 */
  onChangeDynamicMcpConfig?: (
    config: Record<string, ScopedMcpServerConfig>,
  ) => void
  /** 处理 on Install IDE Extension 对应的数据或状态。 */
  onInstallIDEExtension?: (ide: IdeType) => void
  /** 执行 resume 对应的业务处理。 */
  resume?: (
    sessionId: UUID,
    log: LogOption,
    entrypoint: ResumeEntrypoint,
  ) => Promise<void>
}

export type ResumeEntrypoint =
  | 'cli_flag'
  | 'slash_command_picker'
  | 'slash_command_session_id'
  | 'slash_command_title'
  | 'fork'

export type CommandResultDisplay = 'skip' | 'system' | 'user'

/**
 * 命令完成时的回调。
 * @param result - 可选的用户可见消息以显示
 * @param options - 命令完成的可选配置
 * @param options.display - 如何显示结果：'skip' | 'system' | 'user'（默认）
 * @param options.shouldQuery - 如果为 true，则在命令完成后向模型发送消息
 * @param options.metaMessages - 作为 isMeta 插入的附加消息（模型可见但隐藏）
 */
export type LocalJSXCommandOnDone = (
  result?: string,
  options?: {
    display?: CommandResultDisplay
    shouldQuery?: boolean
    metaMessages?: string[]
    nextInput?: string
    submitNextInput?: boolean
  },
) => void

/** 本地 JSX 命令实现的调用签名。 */
export type LocalJSXCommandCall = (
  onDone: LocalJSXCommandOnDone,
  context: ToolUseContext & LocalJSXCommandContext,
  args: string,
) => Promise<React.ReactNode>

/** load() 为惰性加载的命令返回的模块形状。 */
export type LocalJSXCommandModule = {
  call: LocalJSXCommandCall
}

type LocalJSXCommand = {
  type: 'local-jsx'
  /**
   * 惰性加载命令实现。
   * 返回一个具有 call() 函数的模块。
   * 这会将依赖项的加载推迟到命令被调用时。
   */
  load: () => Promise<LocalJSXCommandModule>
}

export type CommandBase = {
  description: string
  hasUserSpecifiedDescription?: boolean
  /** 默认为 true。仅在命令有条件启用（功能标志、环境检查等）时设置。 */
  isEnabled?: () => boolean
  /** 默认为 false。仅在命令应隐藏于类型提示/帮助时设置。 */
  isHidden?: boolean
  name: string
  aliases?: string[]
  isMcp?: boolean
  argumentHint?: string // 命令参数的提示文本（在命令后以灰色显示）
  whenToUse?: string // 来自“技能”规范。何时使用此命令的详细使用场景
  version?: string // 命令/技能的版本
  disableModelInvocation?: boolean // 是否禁止模型调用此命令
  userInvocable?: boolean // 用户是否可以通过输入 /skill-name 调用此技能
  loadedFrom?:
    | 'skills'
    | 'plugin'
    | 'managed'
    | 'bundled'
    | 'mcp' // 命令加载的来源
  kind?: 'workflow' // 区分工作流支持的命令（在自动补全中带有徽章）
  immediate?: boolean // 如果为 true，命令立即执行而不等待停止点（绕过队列）
  isSensitive?: boolean // 如果为 true，则从对话历史中隐藏参数。
  /** 默认为 `name`。仅在显示名称不同时重写（例如插件前缀剥离）。 */
  userFacingName?: () => string
}

export type Command = CommandBase &
  (PromptCommand | LocalCommand | LocalJSXCommand)

/** 解析用户可见的名称，当未重写时回退到 `cmd.name`。 */
export function getCommandName(cmd: CommandBase): string {
  return cmd.userFacingName?.() ?? cmd.name
}

/** 解析命令是否启用，默认为 true。 */
export function isCommandEnabled(cmd: CommandBase): boolean {
  return cmd.isEnabled?.() ?? true
}
