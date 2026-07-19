import type { UUID } from 'crypto'
import type { FileHistorySnapshot } from 'src/utils/fileHistory.js'
import type { ContentReplacementRecord } from 'src/utils/toolResultStorage.js'
import type { AgentId } from './ids.js'
import type { Message } from './message.js'
import type { QueueOperationMessage } from './messageQueueTypes.js'

export type SerializedMessage = Message & {
  cwd: string
  userType: string
  entrypoint?: string // CLAUDE_CODE_ENTRYPOINT — 区分 cli/sdk-ts/sdk-py 等
  sessionId: string
  timestamp: string
  version: string
  gitBranch?: string
  slug?: string // 用于计划等文件的会话标识（用于恢复）
}

export type LogOption = {
  date: string
  messages: SerializedMessage[]
  fullPath?: string
  value: number
  created: Date
  modified: Date
  firstPrompt: string
  messageCount: number
  fileSize?: number // 文件大小（以字节为单位，用于显示）
  isSidechain: boolean
  isLite?: boolean // 精简日志时为 true（未加载消息）
  sessionId?: string // 精简日志的会话 ID
  teamName?: string // 如果是衍生代理会话，则为团队名称
  agentName?: string // 代理的自定义名称（来自 /rename 或 swarm）
  agentColor?: string // 代理的颜色（来自 /rename 或 swarm）
  agentSetting?: string // 使用的代理定义（来自 --agent 标志或 settings.agent）
  isTeammate?: boolean // 此会话是否由 swarm 队友创建
  leafUuid?: UUID // 如果提供，此 uuid 必须存在于数据库中
  summary?: string // 可选的对话摘要
  customTitle?: string // 可选的用户设置自定义标题
  tag?: string // 会话的可选标签（可在 /resume 中搜索）
  fileHistorySnapshots?: FileHistorySnapshot[] // 可选的文件历史快照
  gitBranch?: string // 会话结束时的 Git 分支
  projectPath?: string // 原始项目目录路径
  prNumber?: number // 链接到此会话的 GitHub PR 编号
  prUrl?: string // 链接到 PR 的完整 URL
  prRepository?: string // 仓库格式为 "owner/repo"
  mode?: 'coordinator' | 'normal' // 用于协调器/普通检测的会话模式
  worktreeSession?: PersistedWorktreeSession | null // 会话结束时的工位树状态（null = 已退出，undefined = 从未进入）
  contentReplacements?: ContentReplacementRecord[] // 用于恢复重建的替换决策
}

export type SummaryMessage = {
  type: 'summary'
  leafUuid: UUID
  summary: string
}

export type CustomTitleMessage = {
  type: 'custom-title'
  sessionId: UUID
  customTitle: string
}

/**
 * AI生成的会话标题。与CustomTitleMessage不同，以便：
 * - 用户重命名（custom-title）在读取偏好中始终优先于AI标题
 * - reAppendSessionMetadata永不重新追加AI标题（它们是临时的/可重新生成的；重新追加会在恢复时覆盖用户重命名）
 * - VS Code的onlyIfNoCustomTitle CAS检查仅匹配用户标题，允许AI覆盖其自身先前的AI标题，但不能覆盖用户标题
 */
export type AiTitleMessage = {
  type: 'ai-title'
  sessionId: UUID
  aiTitle: string
}

export type LastPromptMessage = {
  type: 'last-prompt'
  sessionId: UUID
  lastPrompt: string
}

/**
 * 定期从分支生成的代理当前行为摘要。每 min(5 steps, 2min) 通过在回合中途中分叉主线程写入，以便 `claude ps` 能显示比最后一条用户提示（通常是"ok go"或"fix it"）更有用的内容。
 */
export type TaskSummaryMessage = {
  type: 'task-summary'
  sessionId: UUID
  summary: string
  timestamp: string
}

export type TagMessage = {
  type: 'tag'
  sessionId: UUID
  tag: string
}

export type AgentNameMessage = {
  type: 'agent-name'
  sessionId: UUID
  agentName: string
}

export type AgentColorMessage = {
  type: 'agent-color'
  sessionId: UUID
  agentColor: string
}

export type AgentSettingMessage = {
  type: 'agent-setting'
  sessionId: UUID
  agentSetting: string
}

/** 存储在会话记录中的PR链接消息。将会话链接到GitHub拉取请求以进行跟踪和导航。 */
export type PRLinkMessage = {
  type: 'pr-link'
  sessionId: UUID
  prNumber: number
  prUrl: string
  prRepository: string // 例如，“owner/repo”
  timestamp: string // 链接时的ISO时间戳
}

export type ModeEntry = {
  type: 'mode'
  sessionId: UUID
  mode: 'coordinator' | 'normal'
}

/** 持久化到记录中以供恢复的工作树会话状态。来自 utils/worktree.ts 的 WorktreeSession 的子集——排除了恢复工作树时不需要的临时字段。 */
export type PersistedWorktreeSession = {
  originalCwd: string
  worktreePath: string
  worktreeName: string
  worktreeBranch?: string
  originalBranch?: string
  originalHeadCommit?: string
  sessionId: string
  tmuxSessionName?: string
  hookBased?: boolean
}

/**
 * 记录会话当前是否在由 EnterWorktree 或 --worktree 创建的工作树内。最后写入者胜出：进入时写入会话，退出时写入 null。在 --resume 时，仅当 worktreePath 仍存在于磁盘上时才恢复（/exit 对话框可能已将其移除）。
 */
export type WorktreeStateEntry = {
  type: 'worktree-state'
  sessionId: UUID
  worktreeSession: PersistedWorktreeSession | null
}

/**
 * 记录那些在上下文表示中被替换为较小存根的内容块（完整内容已持久化到其他地方）。在恢复时重放以实现提示缓存稳定性。每次至少替换一个块的强制执行遍历时写入一次。当设置了agentId时，该记录属于子代理侧链（AgentTool 恢复读取这些）；当未设置时，属于主线程（/resume 读取这些）。
 */
export type ContentReplacementEntry = {
  type: 'content-replacement'
  sessionId: UUID
  agentId?: AgentId
  replacements: ContentReplacementRecord[]
}

export type FileHistorySnapshotMessage = {
  type: 'file-history-snapshot'
  messageId: UUID
  snapshot: FileHistorySnapshot
  isSnapshotUpdate: boolean
}

export type TranscriptMessage = SerializedMessage & {
  parentUuid: UUID | null
  logicalParentUuid?: UUID | null // 当parentUuid因会话中断而被设为null时，保留逻辑父级
  isSidechain: boolean
  gitBranch?: string
  agentId?: string // 用于侧链记录的代理ID，以支持恢复代理
  teamName?: string // 如果是生成的代理会话，则为团队名称
  agentName?: string // 代理的自定义名称（来自 /rename 或 swarm）
  agentColor?: string // 代理的颜色（来自 /rename 或 swarm）
  promptId?: string // 与用户提示消息的 OTel prompt.id 相关联
}

export type SpeculationAcceptMessage = {
  type: 'speculation-accept'
  timestamp: string
  timeSavedMs: number
}

export type Entry =
  | TranscriptMessage
  | SummaryMessage
  | CustomTitleMessage
  | AiTitleMessage
  | LastPromptMessage
  | TaskSummaryMessage
  | TagMessage
  | AgentNameMessage
  | AgentColorMessage
  | AgentSettingMessage
  | PRLinkMessage
  | FileHistorySnapshotMessage
  | QueueOperationMessage
  | SpeculationAcceptMessage
  | ModeEntry
  | WorktreeStateEntry
  | ContentReplacementEntry

/** 整理 sort Logs 对应的数据或状态。 */
export function sortLogs(logs: LogOption[]): LogOption[] {
  return logs.sort((a, b) => {
    // 按修改日期排序（最新的在前）
    const modifiedDiff = b.modified.getTime() - a.modified.getTime()
    if (modifiedDiff !== 0) {
      return modifiedDiff
    }

    // 如果修改日期相同，则按创建日期排序（最新的在前）
    return b.created.getTime() - a.created.getTime()
  })
}
