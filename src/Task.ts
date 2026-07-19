import { randomBytes } from 'crypto'
import type { AppState } from './state/AppState.js'
import type { AgentId } from './types/ids.js'
import { getTaskOutputPath } from './utils/task/diskOutput.js'

export type TaskType =
  | 'local_bash'
  | 'local_agent'
  | 'in_process_teammate'
  | 'dream'

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'killed'

/** 当任务处于终止状态且不再转移时为真。用于防止向已死亡的队友注入消息、从AppState中驱逐已完成的任务以及孤儿清理路径。 */
export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
}

export type TaskHandle = {
  taskId: string
  /** 规范化 cleanup 对应的数据或状态。 */
  cleanup?: () => void
}

export type SetAppState = (f: (prev: AppState) => AppState) => void

export type TaskContext = {
  abortController: AbortController
  /** 获取 get App State 对应的数据或状态。 */
  getAppState: () => AppState
  setAppState: SetAppState
}

// 所有任务状态共享的基础字段
export type TaskStateBase = {
  id: string
  type: TaskType
  status: TaskStatus
  description: string
  toolUseId?: string
  startTime: number
  endTime?: number
  totalPausedMs?: number
  outputFile: string
  outputOffset: number
  notified: boolean
}

export type LocalShellSpawnInput = {
  command: string
  description: string
  timeout?: number
  toolUseId?: string
  agentId?: AgentId
}

// getTaskByType 分发的操作：kill。spawn/render 从未以多态方式调用（已在 #22546 中移除）。所有六个 kill 实现仅使用 setAppState — getAppState/abortController 是多余负担。
export type Task = {
  name: string
  type: TaskType
  /** 执行 kill 对应的业务处理。 */
  kill(taskId: string, setAppState: SetAppState): Promise<void>
}

// 任务 ID 前缀
const TASK_ID_PREFIXES: Record<string, string> = {
  local_bash: 'b', // 保持为 'b' 以保持向后兼容性
  local_agent: 'a',
  in_process_teammate: 't',
  dream: 'd',
}

// 获取任务 ID 前缀
function getTaskIdPrefix(type: TaskType): string {
  return TASK_ID_PREFIXES[type] ?? 'x'
}

// 任务 ID 的不区分大小写的安全字母表（数字 + 小写字母）。36^8 ≈ 2.8 万亿种组合，足以抵御暴力符号链接攻击。
const TASK_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/** 执行 generate Task Id 对应的业务处理。 */
export function generateTaskId(type: TaskType): string {
  const prefix = getTaskIdPrefix(type)
  const bytes = randomBytes(8)
  let id = prefix
  for (let i = 0; i < 8; i++) {
    id += TASK_ID_ALPHABET[bytes[i]! % TASK_ID_ALPHABET.length]
  }
  return id
}

/** 创建 create Task State Base 对应的数据或状态。 */
export function createTaskStateBase(
  id: string,
  type: TaskType,
  description: string,
  toolUseId?: string,
): TaskStateBase {
  return {
    id,
    type,
    status: 'pending',
    description,
    toolUseId,
    startTime: Date.now(),
    outputFile: getTaskOutputPath(id),
    outputOffset: 0,
    notified: false,
  }
}
