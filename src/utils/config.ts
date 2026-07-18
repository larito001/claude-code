import { feature } from 'bun:bundle'
import { randomBytes } from 'crypto'
import { unwatchFile, watchFile } from 'fs'
import memoize from 'lodash-es/memoize.js'
import pickBy from 'lodash-es/pickBy.js'
import { basename, dirname, join, resolve } from 'path'
import { getOriginalCwd, getSessionTrustAccepted } from '../bootstrap/state.js'
import { getAutoMemEntrypoint } from '../memdir/paths.js'
import { logEvent } from '../services/analytics/index.js'
import type { McpServerConfig } from '../services/mcp/types.js'
import type {
  ReferralEligibilityResponse,
} from '../types/claudeAccount.js'
import { getCwd } from '../utils/cwd.js'
import { registerCleanup } from './cleanupRegistry.js'
import { logForDebugging } from './debug.js'
import { logForDiagnosticsNoPII } from './diagLogs.js'
import { getGlobalClaudeFile } from './env.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from './envUtils.js'
import { ConfigParseError, getErrnoCode } from './errors.js'
import { writeFileSyncAndFlush_DEPRECATED } from './file.js'
import { getFsImplementation } from './fsOperations.js'
import { findCanonicalGitRoot } from './git.js'
import { safeParseJSON } from './json.js'
import { stripBOM } from './jsonRead.js'
import * as lockfile from './lockfile.js'
import { logError } from './log.js'
import type { MemoryType } from './memory/types.js'
import { normalizePathForConfigKey } from './path.js'
import { getEssentialTrafficOnlyReason } from './privacyLevel.js'
import { getManagedFilePath } from './settings/managedPath.js'
import type { ThemeSetting } from './theme.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const teamMemPaths = feature('TEAMMEM')
  ? (require('../memdir/teamMemPaths.js') as typeof import('../memdir/teamMemPaths.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */
import type { ImageDimensions } from './imageResizer.js'
import type { ModelOption } from './model/modelOptions.js'
import { jsonParse, jsonStringify } from './slowOperations.js'

// 重入防护：防止 getConfig → logEvent → getGlobalConfig → getConfig
// 当配置文件损坏时无限递归。 logEvent的采样检查
// 从全局配置中读取 GrowthBook 功能，再次调用 getConfig。
let insideGetConfig = false

// 用于坐标映射的图像尺寸信息（仅在调整图像大小时设置）
export type PastedContent = {
  id: number // 连续数字 ID
  type: 'text' | 'image'
  content: string
  mediaType?: string // 例如，“图像/png”、“图像/jpeg”
  filename?: string // 附件槽中图像的显示名称
  dimensions?: ImageDimensions
  sourcePath?: string // 拖到终端上的图像的原始文件路径
}

export interface SerializedStructuredHistoryEntry {
  display: string
  pastedContents?: Record<number, PastedContent>
  pastedText?: string
}
export interface HistoryEntry {
  display: string
  pastedContents: Record<number, PastedContent>
}

export type ReleaseChannel = 'stable' | 'latest'

export type ProjectConfig = {
  allowedTools: string[]
  mcpContextUris: string[]
  mcpServers?: Record<string, McpServerConfig>
  lastAPIDuration?: number
  lastAPIDurationWithoutRetries?: number
  lastToolDuration?: number
  lastCost?: number
  lastDuration?: number
  lastLinesAdded?: number
  lastLinesRemoved?: number
  lastTotalInputTokens?: number
  lastTotalOutputTokens?: number
  lastTotalCacheCreationInputTokens?: number
  lastTotalCacheReadInputTokens?: number
  lastTotalWebSearchRequests?: number
  lastFpsAverage?: number
  lastFpsLow1Pct?: number
  lastSessionId?: string
  lastModelUsage?: Record<
    string,
    {
      inputTokens: number
      outputTokens: number
      cacheReadInputTokens: number
      cacheCreationInputTokens: number
      webSearchRequests: number
      costUSD: number
    }
  >
  lastSessionMetrics?: Record<string, number>
  exampleFiles?: string[]
  exampleFilesGeneratedAt?: number

  // 信任对话框设置
  hasTrustDialogAccepted?: boolean

  hasCompletedProjectOnboarding?: boolean
  projectOnboardingSeenCount: number
  hasClaudeMdExternalIncludesApproved?: boolean
  hasClaudeMdExternalIncludesWarningShown?: boolean
  // MCP 服务器批准字段 - 迁移到设置但保留向后兼容性
  enabledMcpjsonServers?: string[]
  disabledMcpjsonServers?: string[]
  enableAllProjectMcpServers?: boolean
  // 禁用的 MCP 服务器列表（所有范围）- 用于启用/禁用切换
  disabledMcpServers?: string[]
  // 默认禁用的内置 MCP 服务器的选择加入列表
  enabledMcpServers?: string[]
  // 工作树会话管理
  activeWorktreeSession?: {
    originalCwd: string
    worktreePath: string
    worktreeName: string
    originalBranch?: string
    sessionId: string
    hookBased?: boolean
  }
  /** “克劳德远程控制”多会话的生成模式。通过首次运行对话框或“w”切换设置。 */
  remoteControlSpawnMode?: 'same-dir' | 'worktree'
}

const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  allowedTools: [],
  mcpContextUris: [],
  mcpServers: {},
  enabledMcpjsonServers: [],
  disabledMcpjsonServers: [],
  hasTrustDialogAccepted: false,
  projectOnboardingSeenCount: 0,
  hasClaudeMdExternalIncludesApproved: false,
  hasClaudeMdExternalIncludesWarningShown: false,
}

export type InstallMethod = 'local' | 'native' | 'global' | 'unknown'

export {
  EDITOR_MODES,
  NOTIFICATION_CHANNELS,
} from './configConstants.js'

import type { EDITOR_MODES, NOTIFICATION_CHANNELS } from './configConstants.js'

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number]

// TODO：保留“emacs”以实现向后兼容性 - 在几个版本后删除
export type EditorMode = 'emacs' | (typeof EDITOR_MODES)[number]

export type DiffTool = 'terminal' | 'auto'

export type OutputStyle = string

export type GlobalConfig = {
  /**
   * @deprecated 请改用settings.apiKeyHelper。
   */
  apiKeyHelper?: string
  projects?: Record<string, ProjectConfig>
  numStartups: number
  installMethod?: InstallMethod
  autoUpdates?: boolean
  // 用于区分基于保护的禁用和用户首选项的标志
  autoUpdatesProtectedForNative?: boolean
  // 上次显示 Doctor 时的会话计数
  doctorShownAtSession?: number
  userID?: string
  theme: ThemeSetting
  hasCompletedOnboarding?: boolean
  // 跟踪重置入门的最后一个版本，与 MIN_VERSION_REQUIRING_ONBOARDING_RESET 一起使用
  lastOnboardingVersion?: string
  // 跟踪查看发行说明的最后一个版本，用于管理发行说明
  lastReleaseNotesSeen?: string
  // 上次获取变更日志时的时间戳（内容存储在 ~/.claude/cache/changelog.md 中）
  changelogLastFetched?: number
  // @deprecated - 迁移到 ~/.claude/cache/changelog.md。保留以获得迁移支持。
  cachedChangelog?: string
  mcpServers?: Record<string, McpServerConfig>
  // claude.ai MCP 连接器已成功连接至少一次。
  // 用于控制“连接器不可用”/“需要身份验证”启动通知：
  // 用户实际使用过的连接器在损坏时值得标记，
  // 但是从第一天起就需要身份验证的组织配置连接器是
  // 用户明显忽略了并且不应该抱怨的事情。
  claudeAiMcpEverConnected?: string[]
  preferredNotifChannel: NotificationChannel
  /**
   * @deprecated。请改用通知挂钩 (docs/hooks.md)。
   */
  customNotifyCommand?: string
  verbose: boolean
  customApiKeyResponses?: {
    approved?: string[]
    rejected?: string[]
  }
  primaryApiKey?: string // 未设置环境变量时用户的主 API 密钥，通过 oauth 设置（TODO：重命名）
  hasAcknowledgedCostThreshold?: boolean
  hasSeenUndercoverAutoNotice?: boolean // ant-only：是否显示一次性自动卧底解释器
  hasResetAutoModeOptInForDefaultOffer?: boolean // ant-only：一次性迁移防护，重新提示流失的自动模式用户
  iterm2KeyBindingInstalled?: boolean // 遗留 - 保留向后兼容性
  editorMode?: EditorMode
  bypassPermissionsModeAccepted?: boolean
  hasUsedBackslashReturn?: boolean
  autoCompactEnabled: boolean // 控制是否启用自动压缩
  showTurnDuration: boolean // 控制是否显示回合持续时间消息（例如“Cooked for 1m 6s”）
  /**
   * @deprecated 请改用 settings.env。
   */
  env: { [key: string]: string } // 为 CLI 设置的环境变量
  hasSeenTasksHint?: boolean // 用户是否看到任务提示
  hasUsedStash?: boolean // 用户是否使用过stash功能（Ctrl+S）
  hasUsedBackgroundTask?: boolean // 用户是否已将任务置于后台 (Ctrl+B)
  queuedCommandUpHintCount?: number // 用户看到排队命令提示的次数的计数器
  diffTool?: DiffTool // 使用哪个工具来显示差异（终端或 vscode）

  // 终端设置状态跟踪
  iterm2SetupInProgress?: boolean
  iterm2BackupPath?: string // iTerm2 首选项的备份文件路径
  appleTerminalBackupPath?: string // Terminal.app 首选项的备份文件路径
  appleTerminalSetupInProgress?: boolean // Terminal.app 设置当前是否正在进行

  // 键绑定设置跟踪
  shiftEnterKeyBindingInstalled?: boolean // 是否安装 Shift+Enter 键绑定（对于 iTerm2 或 VSCode）
  optionAsMetaKeyInstalled?: boolean // 是否安装 Option 作为 Meta 键（对于 Terminal.app）

  // IDE配置
  autoConnectIde?: boolean // 如果只有一个有效的 IDE 可用，是否在启动时自动连接到 IDE
  autoInstallIdeExtension?: boolean // 从 IDE 中运行时是否自动安装 IDE 扩展

  // IDE 对话框
  hasIdeOnboardingBeenShown?: Record<string, boolean> // 终端名称与是否已显示 IDE 入门的映射
  ideHintShownCount?: number // /ide 命令提示已显示的次数
  hasIdeAutoConnectDialogBeenShown?: boolean // 是否显示自动连接IDE对话框

  tipsHistory: {
    [tipId: string]: number // 键是tipId，值是最后一次显示tip时的numStartups
  }

  // /buddy 同伴灵魂 — 读取时从 userId 重新生成的骨骼。请参阅 src/buddy/。
  companion?: import('../buddy/types.js').StoredCompanion
  companionMuted?: boolean

  // 反馈调查跟踪
  feedbackSurveyState?: {
    lastShownTime?: number
  }

  // 成绩单共享提示跟踪（“不要再问”）
  transcriptShareDismissed?: boolean

  // 内存使用情况跟踪
  memoryUsageCount: number // 用户添加到内存的次数

  // Sonnet-1M 配置
  hasShownS1MWelcomeV2?: Record<string, boolean> // 是否已按组织显示 Sonnet-1M v2 欢迎消息
  // 每个组织的 Sonnet-1M 订户访问缓存 - 密钥是组织 ID
  // hasAccess 的意思是“hasAccessAsDefault”，但保留旧名称以供向后使用
  // compatibility.
  s1mAccessCache?: Record<
    string,
    { hasAccess: boolean; hasAccessNotAsDefault?: boolean; timestamp: number }
  >
  // 每个组织的 Sonnet-1M PayG 访问缓存 - 密钥是组织 ID
  // hasAccess 的意思是“hasAccessAsDefault”，但保留旧名称以供向后使用
  // compatibility.
  s1mNonSubscriberAccessCache?: Record<
    string,
    { hasAccess: boolean; hasAccessNotAsDefault?: boolean; timestamp: number }
  >

  // 访客通过每个组织的资格缓存 - 密钥是组织 ID
  passesEligibilityCache?: Record<
    string,
    ReferralEligibilityResponse & { timestamp: number }
  >

  // 每个帐户的 Grove 配置缓存 - 密钥是帐户 UUID
  groveConfigCache?: Record<
    string,
    { grove_enabled: boolean; timestamp: number }
  >

  hasVisitedExtraUsage?: boolean // 用户是否访问过 /extra-usage — 隐藏信用追加销售

  // Opus 1M 合并通知跟踪
  opus1mMergeNoticeSeenCount?: number // opus-1m-merge 通知已显示的次数

  // 实验注册通知跟踪（由实验 ID 键入）
  experimentNoticesSeenCount?: Record<string, number>

  // OpusPlan 实验配置
  hasShownOpusPlanWelcome?: Record<string, boolean> // 是否已按组织显示 OpusPlan 欢迎消息

  // 队列使用情况跟踪
  promptQueueUseCount: number // use 使用提示队列的次数

  // 顺便说一句，使用情况跟踪
  btwUseCount: number // 用户使用/btw的次数

  // 计划模式使用情况跟踪
  lastPlanModeUse?: number // 上次计划模式使用的时间戳

  // 订阅通知跟踪
  subscriptionNoticeCount?: number // 订阅通知展示次数
  hasAvailableSubscription?: boolean // 用户是否有可用订阅的缓存结果
  subscriptionUpsellShownCount?: number // 订阅加售已显示的次数（已弃用）
  recommendedSubscription?: string // 从 Statsig 缓存配置值（已弃用）

  // 待办事项功能配置
  todoFeatureEnabled: boolean // 是否启用待办事项功能
  showExpandedTodos?: boolean // 是否显示展开的待办事项，即使是空的
  showSpinnerTree?: boolean // 是否显示队友旋转树而不是药丸

  // 首次开始时间跟踪
  firstStartTime?: string // Claude Code 首次在此计算机上启动时的 ISO 时间戳

  messageIdleNotifThresholdMs: number // 用户必须空闲多长时间才能收到 Claude 生成完毕的通知

  githubActionSetupCount?: number // 用户设置 GitHub Action 的次数
  slackAppInstallCount?: number // 用户点击安装 Slack 应用程序的次数

  // 文件检查点配置
  fileCheckpointingEnabled: boolean

  // 终端进度条配置（OSC 9;4）
  terminalProgressBarEnabled: boolean

  // 终端选项卡状态指示器 (OSC 21337)。打开时会发出彩色光
  // 点 + 状态文本到选项卡侧边栏并删除微调器前缀
  // 来自标题（点使其变得多余）。
  showStatusInTerminalTab?: boolean

  // 克劳德代码使用情况跟踪
  claudeCodeFirstTokenDate?: string // 用户第一个 Claude Code OAuth 令牌的 ISO 时间戳

  // 模型切换标注跟踪（仅限 ant）
  modelSwitchCalloutDismissed?: boolean // 用户是否选择“不再显示”
  modelSwitchCalloutLastShown?: number // 最后显示的时间戳（24 小时内不显示）
  modelSwitchCalloutVersion?: string

  // 工作量标注跟踪 - 针对 Opus 4.6 用户显示一次
  effortCalloutDismissed?: boolean // v1 - 旧版本，为已经看过 v2 的 Pro 用户阅读以抑制 v2
  effortCalloutV2Dismissed?: boolean

  // 桌面追加销售启动对话框跟踪
  desktopUpsellSeenCount?: number // 总放映次数（最多 3 次）
  desktopUpsellDismissed?: boolean // 选择“不要再问”

  // 空闲返回对话框跟踪
  idleReturnDismissed?: boolean // 选择“不要再问”

  // Opus 4.5 Pro 迁移跟踪
  opusProMigrationComplete?: boolean
  opusProMigrationTimestamp?: number

  // Sonnet 4.5 1m 迁移跟踪
  sonnet1m45MigrationComplete?: boolean

  // Opus 4.0/4.1 → 当前 Opus 迁移（显示一次性通知）
  legacyOpusMigrationTimestamp?: number

  // Sonnet 4.5 → 4.6 迁移（pro/max/team premium）
  sonnet45To46MigrationTimestamp?: number

  // 缓存的 statsig 门值
  cachedStatsigGates: {
    [gateName: string]: boolean
  }

  // 缓存的 statsig 动态配置
  cachedDynamicConfigs?: { [configName: string]: unknown }

  // 缓存的 GrowthBook 特征值
  cachedGrowthBookFeatures?: { [featureName: string]: unknown }

  // 本地 GrowthBook 覆盖（仅限 ant，通过 /config Gates 选项卡设置）。
  // 在 env-var 覆盖之后但在实际解析值之前检查。
  growthBookOverrides?: { [featureName: string]: unknown }

  // 紧急提示跟踪 - 存储最后显示的提示以防止重新显示
  lastShownEmergencyTip?: string

  // 文件选择器 gitignore 行为
  respectGitignore: boolean // 文件选择器是否应该尊重 .gitignore 文件（默认值：true）。注意：.ignore 文件始终受到尊重

  // 复制命令行为
  copyFullResponse: boolean // /copy 是否始终复制完整响应而不是显示选择器

  // 全屏应用内文本选择行为
  copyOnSelect?: boolean // 鼠标松开时自动复制到剪贴板（未定义 → true；让 cmd+c 通过无操作“工作”）

  // 用于传送目录切换的 GitHub 存储库路径映射
  // 键：“owner/repo”（小写），值：克隆 repo 的绝对路径数组
  githubRepoPaths?: Record<string, string[]>

  // 用于启动 claude-cli:// 深层链接的终端模拟器。捕获自
  // 自深层链接处理程序运行以来，交互会话期间的 TERM_PROGRAM
  // 无头 (LaunchServices/xdg)，未设置 TERM_PROGRAM。
  deepLinkTerminal?: string

  // iTerm2 it2 CLI 设置
  iterm2It2SetupComplete?: boolean // it2设置是否已验证
  preferTmuxOverIterm2?: boolean // 用户偏好始终使用 tmux 而不是 iTerm2 分割窗格

  // 自动完成排名的技能使用跟踪
  skillUsage?: Record<string, { usageCount: number; lastUsedAt: number }>
  // 官方市场自动安装跟踪
  officialMarketplaceAutoInstallAttempted?: boolean // 是否尝试自动安装
  officialMarketplaceAutoInstalled?: boolean // 自动安装是否成功
  officialMarketplaceAutoInstallFailReason?:
    | 'policy_blocked'
    | 'git_unavailable'
    | 'gcs_unavailable'
    | 'unknown' // 失败原因（如果适用）
  officialMarketplaceAutoInstallRetryCount?: number // 重试次数
  officialMarketplaceAutoInstallLastAttemptTime?: number // 最后一次尝试的时间戳
  officialMarketplaceAutoInstallNextRetryTime?: number // 最早重试时间

  // Chrome 设置中的克劳德
  hasCompletedClaudeInChromeOnboarding?: boolean // Chrome 入门中是否已显示 Claude
  claudeInChromeDefaultEnabled?: boolean // Chrome中的Claude是否默认启用（未定义表示平台默认）
  cachedChromeExtensionInstalled?: boolean // Chrome扩展是否安装的缓存结果

  // Chrome 扩展程序配对状态（跨会话持续存在）
  chromeExtension?: {
    pairedDeviceId?: string
    pairedDeviceName?: string
  }

  // LSP插件推荐偏好
  lspRecommendationDisabled?: boolean // 禁用所有 LSP 插件建议
  lspRecommendationNeverPlugins?: string[] // 绝不建议的插件 ID
  lspRecommendationIgnoredCount?: number // 跟踪被忽略的建议（5 后停止）

  // Claude Code 提示协议状态（来自 CLI/SDK 的 <claude-code-hint /> 标记）。
  // 按提示类型嵌套，因此将来的类型（docs、mcp、...）无需新的插入
  // 顶级键。
  claudeCodeHints?: {
    // 已提示用户输入插件 ID。显示一次语义：
    // 无论是/否响应都会记录下来，并且不会重新提示。上限为
    // 100 个条目限制配置增长 — 超过该限制，提示将完全停止。
    plugin?: string[]
    // 用户从对话框中选择“不再显示插件安装提示”。
    disabled?: boolean
  }

  // 权限解释器配置
  permissionExplainerEnabled?: boolean // 启用俳句生成的权限请求解释（默认值：true）

  // 队友生成模式：“自动” | 'tmux' | 'tmux' | “进行中”
  teammateMode?: 'auto' | 'tmux' | 'in-process' // 如何生成队友（默认值：“自动”）
  // 当工具调用未通过时为新队友建模。
  // undefined = 硬编码 Opus（向后兼容）； null = 领导者模型； string = 模型别名/ID。
  teammateDefaultModel?: string | null

  // PR 状态页脚配置（通过 GrowthBook 进行功能标记）
  prStatusFooterEnabled?: boolean // 在页脚中显示 PR 审核状态（默认值：true）

  // Tmux 实时面板可见性（仅限 ant，通过 tmux 药丸上的 Enter 进行切换）
  tungstenPanelVisible?: boolean

  // 从 API 缓存组织级快速模式状态。
  // 用于检测跨会话更改并通知用户。
  penguinModeOrgEnabled?: boolean

  // 后台刷新上次运行时的纪元毫秒（快速模式、配额、通行证、客户端数据）。
  // 与 tengu_cicada_nap_ms 一起使用来限制 API 调用
  startupPrefetchedAt?: number

  // 缓存了上次 API 响应中的额外使用禁用原因
  // undefined = 无缓存，null = 启用额外使用，string = 禁用原因。
  cachedExtraUsageDisabledReason?: string | null

  // 自动权限通知跟踪（仅限 Ant）
  autoPermissionsNotificationCount?: number // 自动权限通知显示的次数

  // 推测配置（仅限 ant）
  speculationEnabled?: boolean // 是否启用推测（默认：true）


  // 服务器端实验的客户端数据（在引导期间获取）。
  clientDataCache?: Record<string, unknown> | null

  // 模型选择器的附加模型选项（在引导期间获取）。
  additionalModelOptionsCache?: ModelOption[]

  // /api/claude_code/organizations/metrics_enabled 的磁盘缓存。
  // 组织级别的设置很少改变；跨进程持久化可以避免
  // 每次“claude -p”调用时都会进行冷 API 调用。
  metricsStatusCache?: {
    enabled: boolean
    timestamp: number
  }

  // 最后应用的迁移集的版本。当等于
  // CURRENT_MIGRATION_VERSION，runMigrations() 跳过所有同步迁移
  // （避免每次启动时 11× saveGlobalConfig 锁定+重新读取）。
  migrationVersion?: number
}

/**
 * 全新默认 GlobalConfig 的工厂。使用而不是深度克隆
 * 共享常量——嵌套容器（数组、记录）都是空的，所以
 * 工厂以零克隆成本提供新鲜参考。
 */
function createDefaultGlobalConfig(): GlobalConfig {
  return {
    numStartups: 0,
    installMethod: undefined,
    autoUpdates: undefined,
    theme: 'dark',
    preferredNotifChannel: 'auto',
    verbose: false,
    editorMode: 'normal',
    autoCompactEnabled: true,
    showTurnDuration: true,
    hasSeenTasksHint: false,
    hasUsedStash: false,
    hasUsedBackgroundTask: false,
    queuedCommandUpHintCount: 0,
    diffTool: 'auto',
    customApiKeyResponses: {
      approved: [],
      rejected: [],
    },
    env: {},
    tipsHistory: {},
    memoryUsageCount: 0,
    promptQueueUseCount: 0,
    btwUseCount: 0,
    todoFeatureEnabled: true,
    showExpandedTodos: false,
    messageIdleNotifThresholdMs: 60000,
    autoConnectIde: false,
    autoInstallIdeExtension: true,
    fileCheckpointingEnabled: true,
    terminalProgressBarEnabled: true,
    cachedStatsigGates: {},
    cachedDynamicConfigs: {},
    cachedGrowthBookFeatures: {},
    respectGitignore: true,
    copyFullResponse: false,
  }
}

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = createDefaultGlobalConfig()

export const GLOBAL_CONFIG_KEYS = [
  'apiKeyHelper',
  'installMethod',
  'autoUpdates',
  'autoUpdatesProtectedForNative',
  'theme',
  'verbose',
  'preferredNotifChannel',
  'shiftEnterKeyBindingInstalled',
  'editorMode',
  'hasUsedBackslashReturn',
  'autoCompactEnabled',
  'showTurnDuration',
  'diffTool',
  'env',
  'tipsHistory',
  'todoFeatureEnabled',
  'showExpandedTodos',
  'messageIdleNotifThresholdMs',
  'autoConnectIde',
  'autoInstallIdeExtension',
  'fileCheckpointingEnabled',
  'terminalProgressBarEnabled',
  'showStatusInTerminalTab',
  'respectGitignore',
  'claudeInChromeDefaultEnabled',
  'hasCompletedClaudeInChromeOnboarding',
  'lspRecommendationDisabled',
  'lspRecommendationNeverPlugins',
  'lspRecommendationIgnoredCount',
  'copyFullResponse',
  'copyOnSelect',
  'permissionExplainerEnabled',
  'prStatusFooterEnabled',
] as const

export type GlobalConfigKey = (typeof GLOBAL_CONFIG_KEYS)[number]

export function isGlobalConfigKey(key: string): key is GlobalConfigKey {
  return GLOBAL_CONFIG_KEYS.includes(key as GlobalConfigKey)
}

export const PROJECT_CONFIG_KEYS = [
  'allowedTools',
  'hasTrustDialogAccepted',
  'hasCompletedProjectOnboarding',
] as const

export type ProjectConfigKey = (typeof PROJECT_CONFIG_KEYS)[number]

/**
 * 检查用户是否已接受 cwd 的信任对话框。
 *
 * 该函数遍历父目录，检查父目录是否存在
 * 获得批准。接受对目录的信任意味着对子目录的信任
 * directories.
 *
 * @returns 信任对话框是否已被接受（即“不应显示”）
 */
let _trustAccepted = false

export function resetTrustDialogAcceptedCacheForTesting(): void {
  _trustAccepted = false
}

export function checkHasTrustDialogAccepted(): boolean {
  // 信任仅在会话期间从假→真转变（而不是相反），
  // 所以一旦为真我们就可以锁定它。 false 不被缓存——它会被重新检查
  // 在每次通话中，以便在会话中获取信任对话接受。
  // （lodash memoize 不适合这里，因为它也会缓存 false。）
  return (_trustAccepted ||= computeTrustDialogAccepted())
}

function computeTrustDialogAccepted(): boolean {
  // 检查会话级信任（对于信任不持久的主目录情况）
  // 从主目录运行时，会显示信任对话框，但会存储接受
  // 仅在记忆中。这允许挂钩和其他功能在会话期间工作。
  if (getSessionTrustAccepted()) {
    return true
  }

  const config = getGlobalConfig()

  // 始终检查信任的保存位置（git root 或原始 cwd）
  // 这是 saveCurrentProjectConfig 保存信任的主要位置
  const projectPath = getProjectPathForConfig()
  const projectConfig = config.projects?.[projectPath]
  if (projectConfig?.hasTrustDialogAccepted) {
    return true
  }

  // 现在检查当前工作目录及其父目录
  // 标准化路径以实现一致的 JSON 键查找
  let currentPath = normalizePathForConfigKey(getCwd())

  // 遍历所有父目录
  while (true) {
    const pathConfig = config.projects?.[currentPath]
    if (pathConfig?.hasTrustDialogAccepted) {
      return true
    }

    const parentPath = normalizePathForConfigKey(resolve(currentPath, '..'))
    // 如果我们到达根则停止（当父级与当前相同时）
    if (parentPath === currentPath) {
      break
    }
    currentPath = parentPath
  }

  return false
}

/**
 * 检查任意目录（不是会话 cwd）的信任。
 * 从“dir”向上走，如果任何祖先的信任持续存在，则返回 true。
 * 与 checkHasTrustDialogAccepted 不同，这不会咨询会话信任或
 * 记忆的项目路径 - 当目标目录与 cwd 不同时使用（例如
 * /assistant 安装到用户输入的路径中）。
 */
export function isPathTrusted(dir: string): boolean {
  const config = getGlobalConfig()
  let currentPath = normalizePathForConfigKey(resolve(dir))
  while (true) {
    if (config.projects?.[currentPath]?.hasTrustDialogAccepted) return true
    const parentPath = normalizePathForConfigKey(resolve(currentPath, '..'))
    if (parentPath === currentPath) return false
    currentPath = parentPath
  }
}

// 我们必须把这个测试代码放在这里，因为 Jest 不支持模拟 ES 模块:O
const TEST_GLOBAL_CONFIG_FOR_TESTING: GlobalConfig = {
  ...DEFAULT_GLOBAL_CONFIG,
  autoUpdates: false,
}
const TEST_PROJECT_CONFIG_FOR_TESTING: ProjectConfig = {
  ...DEFAULT_PROJECT_CONFIG,
}

export function isProjectConfigKey(key: string): key is ProjectConfigKey {
  return PROJECT_CONFIG_KEYS.includes(key as ProjectConfigKey)
}

/**
 * 检测写入“fresh”是否会丢失身份验证/登录状态
 * 内存缓存仍然有。当“getConfig”遇到损坏时会发生这种情况
 * 或在写入过程中截断的文件（来自另一个进程或非原子回退）
 * 并返回DEFAULT_GLOBAL_CONFIG。写回将永久
 * 擦除授权。参见 GH #3117。
 */
function wouldLoseOnboardingState(fresh: {
  hasCompletedOnboarding?: boolean
}): boolean {
  const cached = globalConfigCache.config
  if (!cached) return false
  const lostOnboarding =
    cached.hasCompletedOnboarding === true &&
    fresh.hasCompletedOnboarding !== true
  return lostOnboarding
}

export function saveGlobalConfig(
  updater: (currentConfig: GlobalConfig) => GlobalConfig,
): void {
  if (process.env.NODE_ENV === 'test') {
    const config = updater(TEST_GLOBAL_CONFIG_FOR_TESTING)
    // 如果没有更改则跳过（返回相同的引用）
    if (config === TEST_GLOBAL_CONFIG_FOR_TESTING) {
      return
    }
    Object.assign(TEST_GLOBAL_CONFIG_FOR_TESTING, config)
    return
  }

  let written: GlobalConfig | null = null
  try {
    const didWrite = saveConfigWithLock(
      getGlobalClaudeFile(),
      createDefaultGlobalConfig,
      current => {
        const config = updater(current)
        // 如果没有更改则跳过（返回相同的引用）
        if (config === current) {
          return current
        }
        written = {
          ...config,
          projects: removeProjectHistory(current.projects),
        }
        return written
      },
    )
    // 只有当我们真正写过时才写通。如果授权丢失守卫
    // 跳闸（或更新程序未进行任何更改），文件未受影响并且
    // 缓存仍然有效——触摸它会破坏守卫。
    if (didWrite && written) {
      writeThroughGlobalConfigCache(written)
    }
  } catch (error) {
    logForDebugging(`Failed to save config with lock: ${error}`, {
      level: 'error',
    })
    // Fall back to non-locked version on error. This fallback is a race
    // window: if another process is mid-write (or the file got truncated),
    // getConfig returns defaults. Refuse to write those over a good cached
    // config to avoid wiping auth. See GH #3117.
    const currentConfig = getConfig(
      getGlobalClaudeFile(),
      createDefaultGlobalConfig,
    )
    if (wouldLoseOnboardingState(currentConfig)) {
      logForDebugging(
        'saveGlobalConfig fallback: re-read config is missing auth that cache has; refusing to write. See GH #3117.',
        { level: 'error' },
      )
      logEvent('tengu_config_auth_loss_prevented', {})
      return
    }
    const config = updater(currentConfig)
    // Skip if no changes (same reference returned)
    if (config === currentConfig) {
      return
    }
    written = {
      ...config,
      projects: removeProjectHistory(currentConfig.projects),
    }
    saveConfig(getGlobalClaudeFile(), written, DEFAULT_GLOBAL_CONFIG)
    writeThroughGlobalConfigCache(written)
  }
}

// Cache for global config
let globalConfigCache: { config: GlobalConfig | null; mtime: number } = {
  config: null,
  mtime: 0,
}

// Tracking for config file operations (telemetry)
let lastReadFileStats: { mtime: number; size: number } | null = null
let configCacheHits = 0
let configCacheMisses = 0
// Session-total count of actual disk writes to the global config file.
// Exposed for ant-only dev diagnostics (see inc-4552) so anomalous write
// rates surface in the UI before they corrupt ~/.claude.json.
let globalConfigWriteCount = 0

export function getGlobalConfigWriteCount(): number {
  return globalConfigWriteCount
}

export const CONFIG_WRITE_DISPLAY_THRESHOLD = 20

function reportConfigCacheStats(): void {
  const total = configCacheHits + configCacheMisses
  if (total > 0) {
    logEvent('tengu_config_cache_stats', {
      cache_hits: configCacheHits,
      cache_misses: configCacheMisses,
      hit_rate: configCacheHits / total,
    })
  }
  configCacheHits = 0
  configCacheMisses = 0
}

// Register cleanup to report cache stats at session end
// eslint-disable-next-line custom-rules/no-top-level-side-effects
registerCleanup(async () => {
  reportConfigCacheStats()
})

/**
 * Migrates old autoUpdaterStatus to new installMethod and autoUpdates fields
 * @internal
 */
function migrateConfigFields(config: GlobalConfig): GlobalConfig {
  // Already migrated
  if (config.installMethod !== undefined) {
    return config
  }

  // autoUpdaterStatus is removed from the type but may exist in old configs
  const legacy = config as GlobalConfig & {
    autoUpdaterStatus?:
      | 'migrated'
      | 'installed'
      | 'disabled'
      | 'enabled'
      | 'no_permissions'
      | 'not_configured'
  }

  // Determine install method and auto-update preference from old field
  let installMethod: InstallMethod = 'unknown'
  let autoUpdates = config.autoUpdates ?? true // Default to enabled unless explicitly disabled

  switch (legacy.autoUpdaterStatus) {
    case 'migrated':
      installMethod = 'local'
      break
    case 'installed':
      installMethod = 'native'
      break
    case 'disabled':
      // When disabled, we don't know the install method
      autoUpdates = false
      break
    case 'enabled':
    case 'no_permissions':
    case 'not_configured':
      // These imply global installation
      installMethod = 'global'
      break
    case undefined:
      // No old status, keep defaults
      break
  }

  return {
    ...config,
    installMethod,
    autoUpdates,
  }
}

/**
 * Removes history field from projects (migrated to history.jsonl)
 * @internal
 */
function removeProjectHistory(
  projects: Record<string, ProjectConfig> | undefined,
): Record<string, ProjectConfig> | undefined {
  if (!projects) {
    return projects
  }

  const cleanedProjects: Record<string, ProjectConfig> = {}
  let needsCleaning = false

  for (const [path, projectConfig] of Object.entries(projects)) {
    // history is removed from the type but may exist in old configs
    const legacy = projectConfig as ProjectConfig & { history?: unknown }
    if (legacy.history !== undefined) {
      needsCleaning = true
      const { history, ...cleanedConfig } = legacy
      cleanedProjects[path] = cleanedConfig
    } else {
      cleanedProjects[path] = projectConfig
    }
  }

  return needsCleaning ? cleanedProjects : projects
}

// fs.watchFile poll interval for detecting writes from other instances (ms)
const CONFIG_FRESHNESS_POLL_MS = 1000
let freshnessWatcherStarted = false

// fs.watchFile polls stat on the libuv threadpool and only calls us when mtime
// changed — a stalled stat never blocks the main thread.
function startGlobalConfigFreshnessWatcher(): void {
  if (freshnessWatcherStarted || process.env.NODE_ENV === 'test') return
  freshnessWatcherStarted = true
  const file = getGlobalClaudeFile()
  watchFile(
    file,
    { interval: CONFIG_FRESHNESS_POLL_MS, persistent: false },
    curr => {
      // Our own writes fire this too — the write-through's Date.now()
      // overshoot makes cache.mtime > file mtime, so we skip the re-read.
      // Bun/Node also fire with curr.mtimeMs=0 when the file doesn't exist
      // (initial callback or deletion) — the <= handles that too.
      if (curr.mtimeMs <= globalConfigCache.mtime) return
      void getFsImplementation()
        .readFile(file, { encoding: 'utf-8' })
        .then(content => {
          // A write-through may have advanced the cache while we were reading;
          // don't regress to the stale snapshot watchFile stat'd.
          if (curr.mtimeMs <= globalConfigCache.mtime) return
          const parsed = safeParseJSON(stripBOM(content))
          if (parsed === null || typeof parsed !== 'object') return
          globalConfigCache = {
            config: migrateConfigFields({
              ...createDefaultGlobalConfig(),
              ...(parsed as Partial<GlobalConfig>),
            }),
            mtime: curr.mtimeMs,
          }
          lastReadFileStats = { mtime: curr.mtimeMs, size: curr.size }
        })
        .catch(() => {})
    },
  )
  registerCleanup(async () => {
    unwatchFile(file)
    freshnessWatcherStarted = false
  })
}

// Write-through: what we just wrote IS the new config. cache.mtime overshoots
// the file's real mtime (Date.now() is recorded after the write) so the
// freshness watcher skips re-reading our own write on its next tick.
function writeThroughGlobalConfigCache(config: GlobalConfig): void {
  globalConfigCache = { config, mtime: Date.now() }
  lastReadFileStats = null
}

export function getGlobalConfig(): GlobalConfig {
  if (process.env.NODE_ENV === 'test') {
    return TEST_GLOBAL_CONFIG_FOR_TESTING
  }

  // Fast path: pure memory read. After startup, this always hits — our own
  // writes go write-through and other instances' writes are picked up by the
  // background freshness watcher (never blocks this path).
  if (globalConfigCache.config) {
    configCacheHits++
    return globalConfigCache.config
  }

  // Slow path: startup load. Sync I/O here is acceptable because it runs
  // exactly once, before any UI is rendered. Stat before read so any race
  // self-corrects (old mtime + new content → watcher re-reads next tick).
  configCacheMisses++
  try {
    let stats: { mtimeMs: number; size: number } | null = null
    try {
      stats = getFsImplementation().statSync(getGlobalClaudeFile())
    } catch {
      // File doesn't exist
    }
    const config = migrateConfigFields(
      getConfig(getGlobalClaudeFile(), createDefaultGlobalConfig),
    )
    globalConfigCache = {
      config,
      mtime: stats?.mtimeMs ?? Date.now(),
    }
    lastReadFileStats = stats
      ? { mtime: stats.mtimeMs, size: stats.size }
      : null
    startGlobalConfigFreshnessWatcher()
    return config
  } catch {
    // If anything goes wrong, fall back to uncached behavior
    return migrateConfigFields(
      getConfig(getGlobalClaudeFile(), createDefaultGlobalConfig),
    )
  }
}

export function getCustomApiKeyStatus(
  truncatedApiKey: string,
): 'approved' | 'rejected' | 'new' {
  const config = getGlobalConfig()
  if (config.customApiKeyResponses?.approved?.includes(truncatedApiKey)) {
    return 'approved'
  }
  if (config.customApiKeyResponses?.rejected?.includes(truncatedApiKey)) {
    return 'rejected'
  }
  return 'new'
}

function saveConfig<A extends object>(
  file: string,
  config: A,
  defaultConfig: A,
): void {
  // Ensure the directory exists before writing the config file
  const dir = dirname(file)
  const fs = getFsImplementation()
  // mkdirSync is already recursive in FsOperations implementation
  fs.mkdirSync(dir)

  // Filter out any values that match the defaults
  const filteredConfig = pickBy(
    config,
    (value, key) =>
      jsonStringify(value) !== jsonStringify(defaultConfig[key as keyof A]),
  )
  // Write config file with secure permissions - mode only applies to new files
  writeFileSyncAndFlush_DEPRECATED(
    file,
    jsonStringify(filteredConfig, null, 2),
    {
      encoding: 'utf-8',
      mode: 0o600,
    },
  )
  if (file === getGlobalClaudeFile()) {
    globalConfigWriteCount++
  }
}

/**
 * Returns true if a write was performed; false if the write was skipped
 * (no changes, or auth-loss guard tripped). Callers use this to decide
 * whether to invalidate the cache -- invalidating after a skipped write
 * destroys the good cached state the auth-loss guard depends on.
 */
function saveConfigWithLock<A extends object>(
  file: string,
  createDefault: () => A,
  mergeFn: (current: A) => A,
): boolean {
  const defaultConfig = createDefault()
  const dir = dirname(file)
  const fs = getFsImplementation()

  // Ensure directory exists (mkdirSync is already recursive in FsOperations)
  fs.mkdirSync(dir)

  let release
  try {
    const lockFilePath = `${file}.lock`
    const startTime = Date.now()
    release = lockfile.lockSync(file, {
      lockfilePath: lockFilePath,
      onCompromised: err => {
        // Default onCompromised throws from a setTimeout callback, which
        // becomes an unhandled exception. Log instead -- the lock being
        // stolen (e.g. after a 10s event-loop stall) is recoverable.
        logForDebugging(`Config lock compromised: ${err}`, { level: 'error' })
      },
    })
    const lockTime = Date.now() - startTime
    if (lockTime > 100) {
      logForDebugging(
        'Lock acquisition took longer than expected - another Claude instance may be running',
      )
      logEvent('tengu_config_lock_contention', {
        lock_time_ms: lockTime,
      })
    }

    // Check for stale write - file changed since we last read it
    // Only check for global config file since lastReadFileStats tracks that specific file
    if (lastReadFileStats && file === getGlobalClaudeFile()) {
      try {
        const currentStats = fs.statSync(file)
        if (
          currentStats.mtimeMs !== lastReadFileStats.mtime ||
          currentStats.size !== lastReadFileStats.size
        ) {
          logEvent('tengu_config_stale_write', {
            read_mtime: lastReadFileStats.mtime,
            write_mtime: currentStats.mtimeMs,
            read_size: lastReadFileStats.size,
            write_size: currentStats.size,
          })
        }
      } catch (e) {
        const code = getErrnoCode(e)
        if (code !== 'ENOENT') {
          throw e
        }
        // File doesn't exist yet, no stale check needed
      }
    }

    // Re-read the current config to get latest state. If the file is
    // momentarily corrupted (concurrent writes, kill-during-write), this
    // returns defaults -- we must not write those back over good config.
    const currentConfig = getConfig(file, createDefault)
    if (file === getGlobalClaudeFile() && wouldLoseOnboardingState(currentConfig)) {
      logForDebugging(
        'saveConfigWithLock: re-read config is missing auth that cache has; refusing to write to avoid wiping ~/.claude.json. See GH #3117.',
        { level: 'error' },
      )
      logEvent('tengu_config_auth_loss_prevented', {})
      return false
    }

    // Apply the merge function to get the updated config
    const mergedConfig = mergeFn(currentConfig)

    // Skip write if no changes (same reference returned)
    if (mergedConfig === currentConfig) {
      return false
    }

    // Filter out any values that match the defaults
    const filteredConfig = pickBy(
      mergedConfig,
      (value, key) =>
        jsonStringify(value) !== jsonStringify(defaultConfig[key as keyof A]),
    )

    // Create timestamped backup of existing config before writing
    // We keep multiple backups to prevent data loss if a reset/corrupted config
    // overwrites a good backup. Backups are stored in ~/.claude/backups/ to
    // keep the home directory clean.
    try {
      const fileBase = basename(file)
      const backupDir = getConfigBackupDir()

      // Ensure backup directory exists
      try {
        fs.mkdirSync(backupDir)
      } catch (mkdirErr) {
        const mkdirCode = getErrnoCode(mkdirErr)
        if (mkdirCode !== 'EEXIST') {
          throw mkdirErr
        }
      }

      // Check existing backups first -- skip creating a new one if a recent
      // backup already exists. During startup, many saveGlobalConfig calls fire
      // within milliseconds of each other; without this check, each call
      // creates a new backup file that accumulates on disk.
      const MIN_BACKUP_INTERVAL_MS = 60_000
      const existingBackups = fs
        .readdirStringSync(backupDir)
        .filter(f => f.startsWith(`${fileBase}.backup.`))
        .sort()
        .reverse() // Most recent first (timestamps sort lexicographically)

      const mostRecentBackup = existingBackups[0]
      const mostRecentTimestamp = mostRecentBackup
        ? Number(mostRecentBackup.split('.backup.').pop())
        : 0
      const shouldCreateBackup =
        Number.isNaN(mostRecentTimestamp) ||
        Date.now() - mostRecentTimestamp >= MIN_BACKUP_INTERVAL_MS

      if (shouldCreateBackup) {
        const backupPath = join(backupDir, `${fileBase}.backup.${Date.now()}`)
        fs.copyFileSync(file, backupPath)
      }

      // Clean up old backups, keeping only the 5 most recent
      const MAX_BACKUPS = 5
      // Re-read if we just created one; otherwise reuse the list
      const backupsForCleanup = shouldCreateBackup
        ? fs
            .readdirStringSync(backupDir)
            .filter(f => f.startsWith(`${fileBase}.backup.`))
            .sort()
            .reverse()
        : existingBackups

      for (const oldBackup of backupsForCleanup.slice(MAX_BACKUPS)) {
        try {
          fs.unlinkSync(join(backupDir, oldBackup))
        } catch {
          // Ignore cleanup errors
        }
      }
    } catch (e) {
      const code = getErrnoCode(e)
      if (code !== 'ENOENT') {
        logForDebugging(`Failed to backup config: ${e}`, {
          level: 'error',
        })
      }
      // No file to backup or backup failed, continue with write
    }

    // Write config file with secure permissions - mode only applies to new files
    writeFileSyncAndFlush_DEPRECATED(
      file,
      jsonStringify(filteredConfig, null, 2),
      {
        encoding: 'utf-8',
        mode: 0o600,
      },
    )
    if (file === getGlobalClaudeFile()) {
      globalConfigWriteCount++
    }
    return true
  } finally {
    if (release) {
      release()
    }
  }
}

// Flag to track if config reading is allowed
let configReadingAllowed = false

export function enableConfigs(): void {
  if (configReadingAllowed) {
    // Ensure this is idempotent
    return
  }

  const startTime = Date.now()
  logForDiagnosticsNoPII('info', 'enable_configs_started')

  // Any reads to configuration before this flag is set show an console warning
  // to prevent us from adding config reading during module initialization
  configReadingAllowed = true
  // We only check the global config because currently all the configs share a file
  getConfig(
    getGlobalClaudeFile(),
    createDefaultGlobalConfig,
    true /* throw on invalid */,
  )

  logForDiagnosticsNoPII('info', 'enable_configs_completed', {
    duration_ms: Date.now() - startTime,
  })
}

/**
 * Returns the directory where config backup files are stored.
 * Uses ~/.claude/backups/ to keep the home directory clean.
 */
function getConfigBackupDir(): string {
  return join(getClaudeConfigHomeDir(), 'backups')
}

/**
 * Find the most recent backup file for a given config file.
 * Checks ~/.claude/backups/ first, then falls back to the legacy location
 * (next to the config file) for backwards compatibility.
 * Returns the full path to the most recent backup, or null if none exist.
 */
function findMostRecentBackup(file: string): string | null {
  const fs = getFsImplementation()
  const fileBase = basename(file)
  const backupDir = getConfigBackupDir()

  // Check the new backup directory first
  try {
    const backups = fs
      .readdirStringSync(backupDir)
      .filter(f => f.startsWith(`${fileBase}.backup.`))
      .sort()

    const mostRecent = backups.at(-1) // Timestamps sort lexicographically
    if (mostRecent) {
      return join(backupDir, mostRecent)
    }
  } catch {
    // Backup dir doesn't exist yet
  }

  // Fall back to legacy location (next to the config file)
  const fileDir = dirname(file)

  try {
    const backups = fs
      .readdirStringSync(fileDir)
      .filter(f => f.startsWith(`${fileBase}.backup.`))
      .sort()

    const mostRecent = backups.at(-1) // Timestamps sort lexicographically
    if (mostRecent) {
      return join(fileDir, mostRecent)
    }

    // Check for legacy backup file (no timestamp)
    const legacyBackup = `${file}.backup`
    try {
      fs.statSync(legacyBackup)
      return legacyBackup
    } catch {
      // Legacy backup doesn't exist
    }
  } catch {
    // Ignore errors reading directory
  }

  return null
}

function getConfig<A>(
  file: string,
  createDefault: () => A,
  throwOnInvalid?: boolean,
): A {
  // Log a warning if config is accessed before it's allowed
  if (!configReadingAllowed && process.env.NODE_ENV !== 'test') {
    throw new Error('Config accessed before allowed.')
  }

  const fs = getFsImplementation()

  try {
    const fileContent = fs.readFileSync(file, {
      encoding: 'utf-8',
    })
    try {
      // Strip BOM before parsing - PowerShell 5.x adds BOM to UTF-8 files
      const parsedConfig = jsonParse(stripBOM(fileContent))
      return {
        ...createDefault(),
        ...parsedConfig,
      }
    } catch (error) {
      // Throw a ConfigParseError with the file path and default config
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      throw new ConfigParseError(errorMessage, file, createDefault())
    }
  } catch (error) {
    // Handle file not found - check for backup and return default
    const errCode = getErrnoCode(error)
    if (errCode === 'ENOENT') {
      const backupPath = findMostRecentBackup(file)
      if (backupPath) {
        process.stderr.write(
          `\nClaude configuration file not found at: ${file}\n` +
            `A backup file exists at: ${backupPath}\n` +
            `You can manually restore it by running: cp "${backupPath}" "${file}"\n\n`,
        )
      }
      return createDefault()
    }

    // Re-throw ConfigParseError if throwOnInvalid is true
    if (error instanceof ConfigParseError && throwOnInvalid) {
      throw error
    }

    // Log config parse errors so users know what happened
    if (error instanceof ConfigParseError) {
      logForDebugging(
        `Config file corrupted, resetting to defaults: ${error.message}`,
        { level: 'error' },
      )

      // Guard: logEvent → shouldSampleEvent → getGlobalConfig → getConfig
      // causes infinite recursion when the config file is corrupted, because
      // the sampling check reads a GrowthBook feature from global config.
      // Only log analytics on the outermost call.
      if (!insideGetConfig) {
        insideGetConfig = true
        try {
          // Log the error for monitoring
          logError(error)

          // Log analytics event for config corruption
          let hasBackup = false
          try {
            fs.statSync(`${file}.backup`)
            hasBackup = true
          } catch {
            // No backup
          }
          logEvent('tengu_config_parse_error', {
            has_backup: hasBackup,
          })
        } finally {
          insideGetConfig = false
        }
      }

      process.stderr.write(
        `\nClaude configuration file at ${file} is corrupted: ${error.message}\n`,
      )

      // Try to backup the corrupted config file (only if not already backed up)
      const fileBase = basename(file)
      const corruptedBackupDir = getConfigBackupDir()

      // Ensure backup directory exists
      try {
        fs.mkdirSync(corruptedBackupDir)
      } catch (mkdirErr) {
        const mkdirCode = getErrnoCode(mkdirErr)
        if (mkdirCode !== 'EEXIST') {
          throw mkdirErr
        }
      }

      const existingCorruptedBackups = fs
        .readdirStringSync(corruptedBackupDir)
        .filter(f => f.startsWith(`${fileBase}.corrupted.`))

      let corruptedBackupPath: string | undefined
      let alreadyBackedUp = false

      // Check if current corrupted content matches any existing backup
      const currentContent = fs.readFileSync(file, { encoding: 'utf-8' })
      for (const backup of existingCorruptedBackups) {
        try {
          const backupContent = fs.readFileSync(
            join(corruptedBackupDir, backup),
            { encoding: 'utf-8' },
          )
          if (currentContent === backupContent) {
            alreadyBackedUp = true
            break
          }
        } catch {
          // Ignore read errors on backups
        }
      }

      if (!alreadyBackedUp) {
        corruptedBackupPath = join(
          corruptedBackupDir,
          `${fileBase}.corrupted.${Date.now()}`,
        )
        try {
          fs.copyFileSync(file, corruptedBackupPath)
          logForDebugging(
            `Corrupted config backed up to: ${corruptedBackupPath}`,
            {
              level: 'error',
            },
          )
        } catch {
          // Ignore backup errors
        }
      }

      // Notify user about corrupted config and available backup
      const backupPath = findMostRecentBackup(file)
      if (corruptedBackupPath) {
        process.stderr.write(
          `The corrupted file has been backed up to: ${corruptedBackupPath}\n`,
        )
      } else if (alreadyBackedUp) {
        process.stderr.write(`The corrupted file has already been backed up.\n`)
      }

      if (backupPath) {
        process.stderr.write(
          `A backup file exists at: ${backupPath}\n` +
            `You can manually restore it by running: cp "${backupPath}" "${file}"\n\n`,
        )
      } else {
        process.stderr.write(`\n`)
      }
    }

    return createDefault()
  }
}

// Memoized function to get the project path for config lookup
export const getProjectPathForConfig = memoize((): string => {
  const originalCwd = getOriginalCwd()
  const gitRoot = findCanonicalGitRoot(originalCwd)

  if (gitRoot) {
    // Normalize for consistent JSON keys (forward slashes on all platforms)
    // This ensures paths like C:\Users\... and C:/Users/... map to the same key
    return normalizePathForConfigKey(gitRoot)
  }

  // Not in a git repo
  return normalizePathForConfigKey(resolve(originalCwd))
})

export function getCurrentProjectConfig(): ProjectConfig {
  if (process.env.NODE_ENV === 'test') {
    return TEST_PROJECT_CONFIG_FOR_TESTING
  }

  const absolutePath = getProjectPathForConfig()
  const config = getGlobalConfig()

  if (!config.projects) {
    return DEFAULT_PROJECT_CONFIG
  }

  const projectConfig = config.projects[absolutePath] ?? DEFAULT_PROJECT_CONFIG
  // Not sure how this became a string
  // TODO: Fix upstream
  if (typeof projectConfig.allowedTools === 'string') {
    projectConfig.allowedTools =
      (safeParseJSON(projectConfig.allowedTools) as string[]) ?? []
  }

  return projectConfig
}

export function saveCurrentProjectConfig(
  updater: (currentConfig: ProjectConfig) => ProjectConfig,
): void {
  if (process.env.NODE_ENV === 'test') {
    const config = updater(TEST_PROJECT_CONFIG_FOR_TESTING)
    // Skip if no changes (same reference returned)
    if (config === TEST_PROJECT_CONFIG_FOR_TESTING) {
      return
    }
    Object.assign(TEST_PROJECT_CONFIG_FOR_TESTING, config)
    return
  }
  const absolutePath = getProjectPathForConfig()

  let written: GlobalConfig | null = null
  try {
    const didWrite = saveConfigWithLock(
      getGlobalClaudeFile(),
      createDefaultGlobalConfig,
      current => {
        const currentProjectConfig =
          current.projects?.[absolutePath] ?? DEFAULT_PROJECT_CONFIG
        const newProjectConfig = updater(currentProjectConfig)
        // Skip if no changes (same reference returned)
        if (newProjectConfig === currentProjectConfig) {
          return current
        }
        written = {
          ...current,
          projects: {
            ...current.projects,
            [absolutePath]: newProjectConfig,
          },
        }
        return written
      },
    )
    if (didWrite && written) {
      writeThroughGlobalConfigCache(written)
    }
  } catch (error) {
    logForDebugging(`Failed to save config with lock: ${error}`, {
      level: 'error',
    })

    // Same race window as saveGlobalConfig's fallback -- refuse to write
    // defaults over good cached config. See GH #3117.
    const config = getConfig(getGlobalClaudeFile(), createDefaultGlobalConfig)
    if (wouldLoseOnboardingState(config)) {
      logForDebugging(
        'saveCurrentProjectConfig fallback: re-read config is missing auth that cache has; refusing to write. See GH #3117.',
        { level: 'error' },
      )
      logEvent('tengu_config_auth_loss_prevented', {})
      return
    }
    const currentProjectConfig =
      config.projects?.[absolutePath] ?? DEFAULT_PROJECT_CONFIG
    const newProjectConfig = updater(currentProjectConfig)
    // Skip if no changes (same reference returned)
    if (newProjectConfig === currentProjectConfig) {
      return
    }
    written = {
      ...config,
      projects: {
        ...config.projects,
        [absolutePath]: newProjectConfig,
      },
    }
    saveConfig(getGlobalClaudeFile(), written, DEFAULT_GLOBAL_CONFIG)
    writeThroughGlobalConfigCache(written)
  }
}

export function isAutoUpdaterDisabled(): boolean {
  return getAutoUpdaterDisabledReason() !== null
}

/**
 * Returns true if plugin autoupdate should be skipped.
 * This checks if the auto-updater is disabled AND the FORCE_AUTOUPDATE_PLUGINS
 * env var is not set to 'true'. The env var allows forcing plugin autoupdate
 * even when the auto-updater is otherwise disabled.
 */
export function shouldSkipPluginAutoupdate(): boolean {
  return (
    isAutoUpdaterDisabled() &&
    !isEnvTruthy(process.env.FORCE_AUTOUPDATE_PLUGINS)
  )
}

export type AutoUpdaterDisabledReason =
  | { type: 'development' }
  | { type: 'env'; envVar: string }
  | { type: 'config' }

export function formatAutoUpdaterDisabledReason(
  reason: AutoUpdaterDisabledReason,
): string {
  switch (reason.type) {
    case 'development':
      return 'development build'
    case 'env':
      return `${reason.envVar} set`
    case 'config':
      return 'config'
  }
}

export function getAutoUpdaterDisabledReason(): AutoUpdaterDisabledReason | null {
  if (process.env.NODE_ENV === 'development') {
    return { type: 'development' }
  }
  if (isEnvTruthy(process.env.DISABLE_AUTOUPDATER)) {
    return { type: 'env', envVar: 'DISABLE_AUTOUPDATER' }
  }
  const essentialTrafficEnvVar = getEssentialTrafficOnlyReason()
  if (essentialTrafficEnvVar) {
    return { type: 'env', envVar: essentialTrafficEnvVar }
  }
  const config = getGlobalConfig()
  if (
    config.autoUpdates === false &&
    (config.installMethod !== 'native' ||
      config.autoUpdatesProtectedForNative !== true)
  ) {
    return { type: 'config' }
  }
  return null
}

export function getOrCreateUserID(): string {
  const config = getGlobalConfig()
  if (config.userID) {
    return config.userID
  }

  const userID = randomBytes(32).toString('hex')
  saveGlobalConfig(current => ({ ...current, userID }))
  return userID
}

export function recordFirstStartTime(): void {
  const config = getGlobalConfig()
  if (!config.firstStartTime) {
    const firstStartTime = new Date().toISOString()
    saveGlobalConfig(current => ({
      ...current,
      firstStartTime: current.firstStartTime ?? firstStartTime,
    }))
  }
}

export function getMemoryPath(memoryType: MemoryType): string {
  const cwd = getOriginalCwd()

  switch (memoryType) {
    case 'User':
      return join(getClaudeConfigHomeDir(), 'CLAUDE.md')
    case 'Local':
      return join(cwd, 'CLAUDE.local.md')
    case 'Project':
      return join(cwd, 'CLAUDE.md')
    case 'Managed':
      return join(getManagedFilePath(), 'CLAUDE.md')
    case 'AutoMem':
      return getAutoMemEntrypoint()
  }
  // TeamMem is only a valid MemoryType when feature('TEAMMEM') is true
  if (feature('TEAMMEM')) {
    return teamMemPaths!.getTeamMemEntrypoint()
  }
  return '' // unreachable in external builds where TeamMem is not in MemoryType
}

export function getManagedClaudeRulesDir(): string {
  return join(getManagedFilePath(), '.claude', 'rules')
}

export function getUserClaudeRulesDir(): string {
  return join(getClaudeConfigHomeDir(), 'rules')
}

// Exported for testing only
export const _getConfigForTesting = getConfig
export const _wouldLoseOnboardingStateForTesting = wouldLoseOnboardingState
export function _setGlobalConfigCacheForTesting(
  config: GlobalConfig | null,
): void {
  globalConfigCache.config = config
  globalConfigCache.mtime = config ? Date.now() : 0
}
