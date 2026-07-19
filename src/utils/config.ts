import { feature } from 'src/utils/features.js'
import { unwatchFile, watchFile } from 'fs'
import memoize from 'lodash-es/memoize.js'
import pickBy from 'lodash-es/pickBy.js'
import { basename, dirname, join, resolve } from 'path'
import { getOriginalCwd, getSessionTrustAccepted } from '../bootstrap/state.js'
import { getAutoMemEntrypoint } from '../memdir/paths.js'
import type { McpServerConfig } from '../services/mcp/types.js'
import { getCwd } from '../utils/cwd.js'
import { registerCleanup } from './cleanupRegistry.js'
import { logForDebugging } from './debug.js'
import { logForDiagnosticsNoPII } from './diagLogs.js'
import { getGlobalConfigFile } from './env.js'
import { getFrameworkConfigHomeDir } from './envUtils.js'
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
import { getManagedFilePath } from './settings/managedPath.js'
import type { ThemeSetting } from './theme.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const teamMemPaths = feature('TEAMMEM')
  ? (require('../memdir/teamMemPaths.js') as typeof import('../memdir/teamMemPaths.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */
import type { ImageDimensions } from './imageResizer.js'
import { jsonParse, jsonStringify } from './slowOperations.js'

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
  // 禁用的 MCP 服务器列表（所有范围）- 用于启用/禁用切换
  disabledMcpServers?: string[]
  // 工作树会话管理
  activeWorktreeSession?: {
    originalCwd: string
    worktreePath: string
    worktreeName: string
    originalBranch?: string
    sessionId: string
    hookBased?: boolean
  }
}

const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  allowedTools: [],
  mcpServers: {},
  hasTrustDialogAccepted: false,
  projectOnboardingSeenCount: 0,
  hasClaudeMdExternalIncludesApproved: false,
  hasClaudeMdExternalIncludesWarningShown: false,
}

export {
  EDITOR_MODES,
  NOTIFICATION_CHANNELS,
} from './configConstants.js'

import type { EDITOR_MODES, NOTIFICATION_CHANNELS } from './configConstants.js'

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number]

// 旧配置可能仍包含“emacs”；继续接受该值以保证跨版本迁移。
export type EditorMode = 'emacs' | (typeof EDITOR_MODES)[number]

export type DiffTool = 'terminal' | 'auto'

export type OutputStyle = string

export const CONFIG_SCHEMA_VERSION = 1 as const

export type GlobalConfig = {
  schemaVersion: typeof CONFIG_SCHEMA_VERSION
  /**
   * @deprecated 请改用settings.apiKeyHelper。
   */
  apiKeyHelper?: string
  projects?: Record<string, ProjectConfig>
  numStartups: number
  theme: ThemeSetting
  hasCompletedOnboarding?: boolean
  // 跟踪重置入门的最后一个版本，与 MIN_VERSION_REQUIRING_ONBOARDING_RESET 一起使用
  lastOnboardingVersion?: string
  mcpServers?: Record<string, McpServerConfig>
  preferredNotifChannel: NotificationChannel
  verbose: boolean
  hasAcknowledgedCostThreshold?: boolean
  editorMode?: EditorMode
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


  // 内存使用情况跟踪
  memoryUsageCount: number // 用户添加到内存的次数

  // 队列使用情况跟踪
  promptQueueUseCount: number // use 使用提示队列的次数

  // 顺便说一句，使用情况跟踪
  btwUseCount: number // 用户使用/btw的次数

  // 计划模式使用情况跟踪
  lastPlanModeUse?: number // 上次计划模式使用的时间戳

  // 待办事项功能配置
  todoFeatureEnabled: boolean // 是否启用待办事项功能
  showExpandedTodos?: boolean // 是否显示展开的待办事项，即使是空的
  showSpinnerTree?: boolean // 是否显示队友旋转树而不是药丸

  messageIdleNotifThresholdMs: number // 用户必须空闲多长时间才能收到 Claude 生成完毕的通知

  // 文件检查点配置
  fileCheckpointingEnabled: boolean

  // 终端进度条配置（OSC 9;4）
  terminalProgressBarEnabled: boolean

  // 终端选项卡状态指示器 (OSC 21337)。打开时会发出彩色光
  // 点 + 状态文本到选项卡侧边栏并删除微调器前缀
  // 来自标题（点使其变得多余）。
  showStatusInTerminalTab?: boolean

  // 空闲返回对话框跟踪
  idleReturnDismissed?: boolean // 选择“不要再问”

  // 本地功能配置覆盖。环境变量 FRAMEWORK_FEATURE_OVERRIDES 优先。
  featureOverrides?: { [featureName: string]: unknown }

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

  // iTerm2 it2 CLI 设置
  iterm2It2SetupComplete?: boolean // it2设置是否已验证
  preferTmuxOverIterm2?: boolean // 用户偏好始终使用 tmux 而不是 iTerm2 分割窗格

  // 自动完成排名的技能使用跟踪
  skillUsage?: Record<string, { usageCount: number; lastUsedAt: number }>
  // 权限解释器配置
  permissionExplainerEnabled?: boolean // 启用俳句生成的权限请求解释（默认值：true）

  // 队友生成模式：“自动” | 'tmux' | 'tmux' | “进行中”
  teammateMode?: 'auto' | 'tmux' | 'in-process' // 如何生成队友（默认值：“自动”）
  // 当工具调用未通过时为新队友建模。
  // undefined = 硬编码 Opus（向后兼容）； null = 领导者模型； string = 模型别名/ID。
  teammateDefaultModel?: string | null

  // PR 状态页脚配置（通过 local feature configuration 进行功能标记）
  prStatusFooterEnabled?: boolean // 在页脚中显示 PR 审核状态（默认值：true）

  // 从 API 缓存组织级快速模式状态。
  // 用于检测跨会话更改并通知用户。
  fastModeApiEnabled?: boolean

  // 后台刷新上次运行时的纪元毫秒（快速模式、配额、通行证、客户端数据）。
  // 与 tengu_cicada_nap_ms 一起使用来限制 API 调用
  startupPrefetchedAt?: number

  // 自动权限通知跟踪
  autoPermissionsNotificationCount?: number // 自动权限通知显示的次数

  // 推测配置
  speculationEnabled?: boolean // 是否启用推测（默认：true）


}

/**
 * 全新默认 GlobalConfig 的工厂。使用而不是深度克隆
 * 共享常量——嵌套容器（数组、记录）都是空的，所以
 * 工厂以零克隆成本提供新鲜参考。
 */
function createDefaultGlobalConfig(): GlobalConfig {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    numStartups: 0,
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
    respectGitignore: true,
    copyFullResponse: false,
  }
}

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = createDefaultGlobalConfig()

export const GLOBAL_CONFIG_KEYS = [
  'apiKeyHelper',
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
  'copyFullResponse',
  'copyOnSelect',
  'permissionExplainerEnabled',
  'prStatusFooterEnabled',
] as const

export type GlobalConfigKey = (typeof GLOBAL_CONFIG_KEYS)[number]

/** 判断是否满足 is Global Config Key 对应的数据或状态。 */
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
 * 该函数逐级检查父目录是否已获批准。信任某个目录也意味着
 * 信任它的所有子目录。
 *
 * @returns 信任对话框是否已被接受（即“不应显示”）
 */
let _trustAccepted = false

/** 重置或恢复 reset Trust Dialog Accepted Cache For Testing 对应的数据或状态。 */
export function resetTrustDialogAcceptedCacheForTesting(): void {
  _trustAccepted = false
}

/** 检查 check Has Trust Dialog Accepted 对应的数据或状态。 */
export function checkHasTrustDialogAccepted(): boolean {
  // 信任仅在会话期间从假→真转变（而不是相反），
  // 所以一旦为真我们就可以锁定它。 false 不被缓存——它会被重新检查
  // 在每次通话中，以便在会话中获取信任对话接受。
  // （lodash memoize 不适合这里，因为它也会缓存 false。）
  return (_trustAccepted ||= computeTrustDialogAccepted())
}

/** 计算 compute Trust Dialog Accepted 对应的数据或状态。 */
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
}
const TEST_PROJECT_CONFIG_FOR_TESTING: ProjectConfig = {
  ...DEFAULT_PROJECT_CONFIG,
}

/** 判断是否满足 is Project Config Key 对应的数据或状态。 */
export function isProjectConfigKey(key: string): key is ProjectConfigKey {
  return PROJECT_CONFIG_KEYS.includes(key as ProjectConfigKey)
}

/** 检测一次全新读取是否会丢失仍在内存缓存中存在的已完成的引导状态。这防止被截断或并发写入的配置文件被写回为默认值。 */
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

/** 设置并保存 save Global Config 对应的数据或状态。 */
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
    /** 执行 did Write 对应的业务处理。 */
    const didWrite = saveConfigWithLock(
      getGlobalConfigFile(),
      createDefaultGlobalConfig,
      current => {
        const config = updater(current)
        // 如果没有更改则跳过（返回相同的引用）
        if (config === current) {
          return current
        }
        written = config
        return written
      },
    )
    // 仅成功写入后才更新缓存。如果引导状态保护触发，则文件和有效缓存必须保持不变。
    if (didWrite && written) {
      writeThroughGlobalConfigCache(written)
    }
  } catch (error) {
    logForDebugging(`Failed to save config with lock: ${error}`, {
      level: 'error',
    })
    // 出错时回退到非锁定版本。此回退存在一个竞态窗口：如果另一个进程正在写入（或文件被截断），getConfig 返回默认值。拒绝将这些默认值写入好的缓存配置，以避免擦除已完成的引导状态。
    const currentConfig = getConfig(
      getGlobalConfigFile(),
      createDefaultGlobalConfig,
    )
    if (wouldLoseOnboardingState(currentConfig)) {
      logForDebugging(
        'saveGlobalConfig fallback: re-read config lost completed onboarding state; refusing to write.',
        { level: 'error' },
      )
      return
    }
    const config = updater(currentConfig)
    // 如果无更改则跳过（返回相同引用）
    if (config === currentConfig) {
      return
    }
    written = config
    saveConfig(getGlobalConfigFile(), written, DEFAULT_GLOBAL_CONFIG)
    writeThroughGlobalConfigCache(written)
  }
}

// 全局配置的缓存
let globalConfigCache: { config: GlobalConfig | null; mtime: number } = {
  config: null,
  mtime: 0,
}

// fs.watchFile 轮询间隔，用于检测来自其他实例的写入（毫秒）
const CONFIG_FRESHNESS_POLL_MS = 1000
let freshnessWatcherStarted = false

// fs.watchFile 在 libuv 线程池上轮询 stat，仅在 mtime 更改时才调用我们——停滞的 stat 永远不会阻塞主线程。
function startGlobalConfigFreshnessWatcher(): void {
  if (freshnessWatcherStarted || process.env.NODE_ENV === 'test') return
  freshnessWatcherStarted = true
  const file = getGlobalConfigFile()
  watchFile(
    file,
    { interval: CONFIG_FRESHNESS_POLL_MS, persistent: false },
    curr => {
      // 我们自己的写入也会触发此回调——write-through 的 Date.now() 超调使得 cache.mtime > 文件 mtime，因此我们跳过重新读取。当文件不存在时（初始回调或删除），Bun/Node 也会以 curr.mtimeMs=0 触发——<= 也处理了这种情况。
      if (curr.mtimeMs <= globalConfigCache.mtime) return
      void getFsImplementation()
        .readFile(file, { encoding: 'utf-8' })
        .then(content => {
          // 我们读取时，一次 write-through 可能已推进了缓存；不要退化为 watchFile 统计的过时快照。
          if (curr.mtimeMs <= globalConfigCache.mtime) return
          const parsed = safeParseJSON(stripBOM(content))
          if (
            parsed === null ||
            typeof parsed !== 'object' ||
            (parsed as { schemaVersion?: unknown }).schemaVersion !==
              CONFIG_SCHEMA_VERSION
          ) {
            return
          }
          globalConfigCache = {
            config: {
              ...createDefaultGlobalConfig(),
              ...(parsed as Partial<GlobalConfig>),
            },
            mtime: curr.mtimeMs,
          }
        })
        .catch(() => {})
    },
  )
  registerCleanup(async () => {
    unwatchFile(file)
    freshnessWatcherStarted = false
  })
}

// Write-through：我们刚刚写入的就是新配置。cache.mtime 超调了文件的真实 mtime（Date.now() 在写入后记录），因此新鲜度观察器在下一个 tick 跳过重新读取我们自己的写入。
function writeThroughGlobalConfigCache(config: GlobalConfig): void {
  globalConfigCache = { config, mtime: Date.now() }
}

/** 获取 get Global Config 对应的数据或状态。 */
export function getGlobalConfig(): GlobalConfig {
  if (process.env.NODE_ENV === 'test') {
    return TEST_GLOBAL_CONFIG_FOR_TESTING
  }

  // 快速路径：纯内存读取。启动后，这始终命中——我们自己的写入通过 write-through 进行，其他实例的写入由后台新鲜度观察器拾取（从不阻塞此路径）。
  if (globalConfigCache.config) {
    return globalConfigCache.config
  }

  // 慢路径：启动加载。同步 I/O 在此处可接受，因为它只运行一次，在渲染任何 UI 之前。读取前先执行 stat，任何竞态都会自我纠正（旧的 mtime + 新内容 → 观察器在下一个 tick 重新读取）。
  try {
    let stats: { mtimeMs: number; size: number } | null = null
    try {
      stats = getFsImplementation().statSync(getGlobalConfigFile())
    } catch {
      // 文件不存在
    }
    const config = getConfig(getGlobalConfigFile(), createDefaultGlobalConfig)
    globalConfigCache = {
      config,
      mtime: stats?.mtimeMs ?? Date.now(),
    }
    startGlobalConfigFreshnessWatcher()
    return config
  } catch {
    // 如果出现任何错误，回退到未缓存的行为。
    return getConfig(getGlobalConfigFile(), createDefaultGlobalConfig)
  }
}

/** 设置并保存 save Config 对应的数据或状态。 */
function saveConfig<A extends object>(
  file: string,
  config: A,
  defaultConfig: A,
): void {
  // 在写入配置文件前确保目录存在。
  const dir = dirname(file)
  const fs = getFsImplementation()
  // mkdirSync 在 FsOperations 实现中已经是递归的。
  fs.mkdirSync(dir)

  // 过滤掉任何与默认值匹配的值。
  const filteredConfig = pickBy(
    config,
    (value, key) =>
      key === 'schemaVersion' ||
      jsonStringify(value) !== jsonStringify(defaultConfig[key as keyof A]),
  )
  // 使用安全权限写入配置文件 - mode 仅适用于新文件。
  writeFileSyncAndFlush_DEPRECATED(
    file,
    jsonStringify(filteredConfig, null, 2),
    {
      encoding: 'utf-8',
      mode: 0o600,
    },
  )
}

/** 如果执行了写入则返回 true；如果跳过写入（无更改或身份验证丢失保护触发）则返回 false。调用者使用此值决定是否使缓存失效——在跳过写入后使缓存失效会破坏身份验证丢失保护所依赖的良好缓存状态。 */
function saveConfigWithLock<A extends object>(
  file: string,
  createDefault: () => A,
  mergeFn: (current: A) => A,
): boolean {
  const defaultConfig = createDefault()
  const dir = dirname(file)
  const fs = getFsImplementation()

  // 确保目录存在（mkdirSync 在 FsOperations 中已经是递归的）
  fs.mkdirSync(dir)

  let release
  try {
    const lockFilePath = `${file}.lock`
    const startTime = Date.now()
    release = lockfile.lockSync(file, {
      lockfilePath: lockFilePath,
      /** 处理 on Compromised 对应的数据或状态。 */
      onCompromised: err => {
        // 默认的 onCompromised 从 setTimeout 回调中抛出异常，成为未处理的异常。改为记录日志——锁被窃取（例如在 10 秒事件循环暂停后）是可恢复的。
        logForDebugging(`Config lock compromised: ${err}`, { level: 'error' })
      },
    })
    const lockTime = Date.now() - startTime
    if (lockTime > 100) {
      logForDebugging(
        'Lock acquisition took longer than expected - another Claude instance may be running',
      )
    }

    // 重新读取当前配置以获取最新状态。如果文件暂时损坏（并发写入、写入时被杀死），此操作返回默认值——我们绝不能将这些默认值写回好的配置。
    const currentConfig = getConfig(file, createDefault)
    if (file === getGlobalConfigFile() && wouldLoseOnboardingState(currentConfig)) {
      logForDebugging(
        'saveConfigWithLock: re-read config lost completed onboarding state; refusing to write.',
        { level: 'error' },
      )
      return false
    }

    // 应用合并函数以获取更新后的配置
    const mergedConfig = mergeFn(currentConfig)

    // 若无变化（返回相同引用）则跳过写入
    if (mergedConfig === currentConfig) {
      return false
    }

    // 过滤掉与默认值匹配的任何值
    const filteredConfig = pickBy(
      mergedConfig,
      (value, key) =>
        key === 'schemaVersion' ||
        jsonStringify(value) !== jsonStringify(defaultConfig[key as keyof A]),
    )

    // 在写入前为现有配置创建带时间戳的备份
    // 保留多个备份以防止重置或损坏的配置覆盖良好备份。备份存储在 ~/.claude-code-core-framework/backups/ 中以保持主目录整洁。
    try {
      const fileBase = basename(file)
      const backupDir = getConfigBackupDir()

      // 确保备份目录存在
      try {
        fs.mkdirSync(backupDir)
      } catch (mkdirErr) {
        const mkdirCode = getErrnoCode(mkdirErr)
        if (mkdirCode !== 'EEXIST') {
          throw mkdirErr
        }
      }

      // 先检查现有备份——如果近期备份已存在则跳过创建新备份。启动时，许多 saveGlobalConfig 调用会在毫秒内触发；若无此检查，每次调用都会创建一个新的备份文件并累积在磁盘上。
      const MIN_BACKUP_INTERVAL_MS = 60_000
      const existingBackups = fs
        .readdirStringSync(backupDir)
        .filter(f => f.startsWith(`${fileBase}.backup.`))
        .sort()
        .reverse() // 最近的最先（时间戳按字典序排序）

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

      // 清理旧备份，仅保留最近的5个
      const MAX_BACKUPS = 5
      // 如果刚刚创建了一个备份则重新读取；否则重用列表
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
          // 忽略清理错误
        }
      }
    } catch (e) {
      const code = getErrnoCode(e)
      if (code !== 'ENOENT') {
        logForDebugging(`Failed to backup config: ${e}`, {
          level: 'error',
        })
      }
      // 没有要备份的文件或备份失败，继续写入
    }

    // 以安全权限写入配置文件——mode 仅适用于新文件
    writeFileSyncAndFlush_DEPRECATED(
      file,
      jsonStringify(filteredConfig, null, 2),
      {
        encoding: 'utf-8',
        mode: 0o600,
      },
    )
    return true
  } finally {
    if (release) {
      release()
    }
  }
}

// 标记以跟踪是否允许读取配置
let configReadingAllowed = false

/** 启动或启用 enable Configs 对应的数据或状态。 */
export function enableConfigs(): void {
  if (configReadingAllowed) {
    // 确保此操作是幂等的
    return
  }

  const startTime = Date.now()
  logForDiagnosticsNoPII('info', 'enable_configs_started')

  // 在此标志设置之前对配置的任何读取都会显示控制台警告，以防止在模块初始化期间添加配置读取
  configReadingAllowed = true
  // 我们仅检查全局配置，因为目前所有配置共享一个文件
  getConfig(
    getGlobalConfigFile(),
    createDefaultGlobalConfig,
    true /* 无效时抛出错误 */,
  )

  logForDiagnosticsNoPII('info', 'enable_configs_completed', {
    duration_ms: Date.now() - startTime,
  })
}

/** 返回存储配置备份文件的目录。使用 ~/.claude-code-core-framework/backups/ 以保持主目录整洁。 */
function getConfigBackupDir(): string {
  return join(getFrameworkConfigHomeDir(), 'backups')
}

/** 从正式备份目录中查找给定配置文件的最新备份。 */
function findMostRecentBackup(file: string): string | null {
  const fs = getFsImplementation()
  const fileBase = basename(file)
  const backupDir = getConfigBackupDir()

  // 先检查新的备份目录
  try {
    const backups = fs
      .readdirStringSync(backupDir)
      .filter(f => f.startsWith(`${fileBase}.backup.`))
      .sort()

    const mostRecent = backups.at(-1) // 时间戳按字典序排序
    if (mostRecent) {
      return join(backupDir, mostRecent)
    }
  } catch {
    // 备份目录尚不存在
  }

  return null
}

/** 获取 get Config 对应的数据或状态。 */
function getConfig<A>(
  file: string,
  createDefault: () => A,
  throwOnInvalid?: boolean,
): A {
  // 如果在允许之前访问配置，则记录警告
  if (!configReadingAllowed && process.env.NODE_ENV !== 'test') {
    throw new Error('Config accessed before allowed.')
  }

  const fs = getFsImplementation()

  try {
    const fileContent = fs.readFileSync(file, {
      encoding: 'utf-8',
    })
    try {
      // 解析前去除 BOM——PowerShell 5.x 会向 UTF-8 文件添加 BOM
      const parsedConfig = jsonParse(stripBOM(fileContent))
      if (
        !parsedConfig ||
        typeof parsedConfig !== 'object' ||
        (parsedConfig as { schemaVersion?: unknown }).schemaVersion !==
          CONFIG_SCHEMA_VERSION
      ) {
        return createDefault()
      }
      return {
        ...createDefault(),
        ...parsedConfig,
      }
    } catch (error) {
      // 抛出带有文件路径和默认配置的 ConfigParseError
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      throw new ConfigParseError(errorMessage, file, createDefault())
    }
  } catch (error) {
    // 处理文件未找到——检查备份并返回默认值
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

    // 如果 throwOnInvalid 为 true，则重新抛出 ConfigParseError
    if (error instanceof ConfigParseError && throwOnInvalid) {
      throw error
    }

    // 记录配置解析错误，以便用户了解发生了什么
    if (error instanceof ConfigParseError) {
      logForDebugging(
        `Config file corrupted, resetting to defaults: ${error.message}`,
        { level: 'error' },
      )

      logError(error)

      process.stderr.write(
        `\nClaude configuration file at ${file} is corrupted: ${error.message}\n`,
      )

      // 尝试备份损坏的配置文件（仅当尚未备份时）
      const fileBase = basename(file)
      const corruptedBackupDir = getConfigBackupDir()

      // 确保备份目录存在
      try {
        fs.mkdirSync(corruptedBackupDir)
      } catch (mkdirErr) {
        const mkdirCode = getErrnoCode(mkdirErr)
        if (mkdirCode !== 'EEXIST') {
          throw mkdirErr
        }
      }

      /** 执行 existing Corrupted Backups 对应的业务处理。 */
      const existingCorruptedBackups = fs
        .readdirStringSync(corruptedBackupDir)
        .filter(f => f.startsWith(`${fileBase}.corrupted.`))

      let corruptedBackupPath: string | undefined
      let alreadyBackedUp = false

      // 检查当前损坏的内容是否与任何现有备份匹配
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
          // 忽略备份上的读取错误
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
          // 忽略备份错误
        }
      }

      // 通知用户配置已损坏及可用的备份
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

// 记忆化函数，用于获取配置查找的项目路径
export const getProjectPathForConfig = memoize((): string => {
  const originalCwd = getOriginalCwd()
  const gitRoot = findCanonicalGitRoot(originalCwd)

  if (gitRoot) {
    // 规范化为一致的 JSON 键（所有平台上使用正斜杠）
    // 这确保像 C:\Users\... 和 C:/Users/... 的路径映射到相同的键
    return normalizePathForConfigKey(gitRoot)
  }

  // 不在 git 仓库中
  return normalizePathForConfigKey(resolve(originalCwd))
})

/** 获取 get Current Project Config 对应的数据或状态。 */
export function getCurrentProjectConfig(): ProjectConfig {
  if (process.env.NODE_ENV === 'test') {
    return TEST_PROJECT_CONFIG_FOR_TESTING
  }

  const absolutePath = getProjectPathForConfig()
  const config = getGlobalConfig()

  if (!config.projects) {
    return DEFAULT_PROJECT_CONFIG
  }

  return config.projects[absolutePath] ?? DEFAULT_PROJECT_CONFIG
}

/** 设置并保存 save Current Project Config 对应的数据或状态。 */
export function saveCurrentProjectConfig(
  updater: (currentConfig: ProjectConfig) => ProjectConfig,
): void {
  if (process.env.NODE_ENV === 'test') {
    const config = updater(TEST_PROJECT_CONFIG_FOR_TESTING)
    // 如果没有更改则跳过（返回相同的引用）
    if (config === TEST_PROJECT_CONFIG_FOR_TESTING) {
      return
    }
    Object.assign(TEST_PROJECT_CONFIG_FOR_TESTING, config)
    return
  }
  const absolutePath = getProjectPathForConfig()

  let written: GlobalConfig | null = null
  try {
    /** 执行 did Write 对应的业务处理。 */
    const didWrite = saveConfigWithLock(
      getGlobalConfigFile(),
      createDefaultGlobalConfig,
      current => {
        const currentProjectConfig =
          current.projects?.[absolutePath] ?? DEFAULT_PROJECT_CONFIG
        const newProjectConfig = updater(currentProjectConfig)
        // 如果没有更改则跳过（返回相同的引用）
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

    // 与 saveGlobalConfig 的后备机制相同的竞态窗口——拒绝将默认值覆盖好的缓存配置。参见 GH #3117。
    const config = getConfig(getGlobalConfigFile(), createDefaultGlobalConfig)
    if (wouldLoseOnboardingState(config)) {
      logForDebugging(
        'saveCurrentProjectConfig fallback: re-read config lost completed onboarding state; refusing to write.',
        { level: 'error' },
      )
      return
    }
    const currentProjectConfig =
      config.projects?.[absolutePath] ?? DEFAULT_PROJECT_CONFIG
    const newProjectConfig = updater(currentProjectConfig)
    // 如果没有更改则跳过（返回相同的引用）
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
    saveConfig(getGlobalConfigFile(), written, DEFAULT_GLOBAL_CONFIG)
    writeThroughGlobalConfigCache(written)
  }
}

/** 获取 get Memory Path 对应的数据或状态。 */
export function getMemoryPath(memoryType: MemoryType): string {
  const cwd = getOriginalCwd()

  switch (memoryType) {
    case 'User':
      return join(getFrameworkConfigHomeDir(), 'CLAUDE.md')
    case 'Local':
      return join(cwd, 'CLAUDE.local.md')
    case 'Project':
      return join(cwd, 'CLAUDE.md')
    case 'Managed':
      return join(getManagedFilePath(), 'CLAUDE.md')
    case 'AutoMem':
      return getAutoMemEntrypoint()
  }
  // 仅当 feature('TEAMMEM') 为 true 时，TeamMem 才是有效的 MemoryType
  if (feature('TEAMMEM')) {
    return teamMemPaths!.getTeamMemEntrypoint()
  }
  return '' // 当 MemoryType 被详尽处理时不可达。
}

/** 获取 get Managed Claude Rules Dir 对应的数据或状态。 */
export function getManagedClaudeRulesDir(): string {
  return join(getManagedFilePath(), '.claude-code-core-framework', 'rules')
}

/** 获取 get User Claude Rules Dir 对应的数据或状态。 */
export function getUserClaudeRulesDir(): string {
  return join(getFrameworkConfigHomeDir(), 'rules')
}

// 仅为测试而导出
export const _getConfigForTesting = getConfig
export const _wouldLoseOnboardingStateForTesting = wouldLoseOnboardingState
/** 执行 set Global Config Cache For Testing 对应的业务处理。 */
export function _setGlobalConfigCacheForTesting(
  config: GlobalConfig | null,
): void {
  globalConfigCache.config = config
  globalConfigCache.mtime = config ? Date.now() : 0
}
