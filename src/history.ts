import { appendFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { getProjectRoot, getSessionId } from './bootstrap/state.js'
import { registerCleanup } from './utils/cleanupRegistry.js'
import type { HistoryEntry, PastedContent } from './utils/config.js'
import { logForDebugging } from './utils/debug.js'
import { getFrameworkConfigHomeDir, isEnvTruthy } from './utils/envUtils.js'
import { getErrnoCode } from './utils/errors.js'
import { readLinesReverse } from './utils/fsOperations.js'
import { lock } from './utils/lockfile.js'
import {
  hashPastedText,
  retrievePastedText,
  storePastedText,
} from './utils/pasteStore.js'
import { sleep } from './utils/sleep.js'
import { jsonParse, jsonStringify } from './utils/slowOperations.js'

const MAX_HISTORY_ITEMS = 100
const MAX_PASTED_CONTENT_LENGTH = 1024

/** 存储的粘贴内容 - 内联内容或指向粘贴存储的哈希引用。 */
type StoredPastedContent = {
  id: number
  type: 'text' | 'image'
  content?: string // 小粘贴的内联内容
  contentHash?: string // 外部存储的大粘贴的哈希引用
  mediaType?: string
  filename?: string
}

/**
 * Claude Code 解析历史记录中的粘贴内容引用，以匹配回粘贴的内容。引用形式如下：
 *   Text: [Pasted text #1 +10 lines]
 *   Image: [Image #2]
 * 这些编号在单个提示内期望唯一，但跨提示不唯一。我们选择数值自增ID，因为它们比其他ID选项更用户友好。
 */

// 注意：原始文本粘贴实现会将类似"line1\nline2\nline3"的输入视为+2行，而非3行。我们在此保留该行为。
export function getPastedTextRefNumLines(text: string): number {
  return (text.match(/\r\n|\r|\n/g) || []).length
}

/** 格式化 format Pasted Text Ref 对应的数据或状态。 */
export function formatPastedTextRef(id: number, numLines: number): string {
  if (numLines === 0) {
    return `[Pasted text #${id}]`
  }
  return `[Pasted text #${id} +${numLines} lines]`
}

/** 格式化 format Image Ref 对应的数据或状态。 */
export function formatImageRef(id: number): string {
  return `[Image #${id}]`
}

/** 解析 parse References 对应的数据或状态。 */
export function parseReferences(
  input: string,
): Array<{ id: number; match: string; index: number }> {
  const referencePattern =
    /\[(Pasted text|Image|\.\.\.Truncated text) #(\d+)(?: \+\d+ lines)?(\.)*\]/g
  const matches = [...input.matchAll(referencePattern)]
  return matches
    .map(match => ({
      id: parseInt(match[2] || '0'),
      match: match[0],
      index: match.index,
    }))
    .filter(match => match.id > 0)
}

/** 替换输入中的 [Pasted text #N] 占位符为实际内容。图像引用保持不变 —— 它们成为内容块，而不是内联文本。 */
/** 执行 expand Pasted Text Refs 对应的业务处理。 */
export function expandPastedTextRefs(
  input: string,
  pastedContents: Record<number, PastedContent>,
): string {
  const refs = parseReferences(input)
  let expanded = input
  // 在原始匹配偏移处进行拼接，使得粘贴内容中类似占位符的字符串永远不会与实际引用混淆。逆序操作使得后续替换后早期偏移仍然有效。
  for (let i = refs.length - 1; i >= 0; i--) {
    const ref = refs[i]!
    const content = pastedContents[ref.id]
    if (content?.type !== 'text') continue
    expanded =
      expanded.slice(0, ref.index) +
      content.content +
      expanded.slice(ref.index + ref.match.length)
  }
  return expanded
}

/** 解析 deserialize Log Entry 对应的数据或状态。 */
function deserializeLogEntry(line: string): LogEntry {
  return jsonParse(line) as LogEntry
}

/** 创建 make Log Entry Reader 对应的数据或状态。 */
async function* makeLogEntryReader(): AsyncGenerator<LogEntry> {
  const currentSession = getSessionId()

  // 从尚未刷新到磁盘的条目开始
  for (let i = pendingEntries.length - 1; i >= 0; i--) {
    yield pendingEntries[i]!
  }

  // 从全局历史文件读取（跨所有项目共享）
  const historyPath = join(getFrameworkConfigHomeDir(), 'history.jsonl')

  try {
    for await (const line of readLinesReverse(historyPath)) {
      try {
        const entry = deserializeLogEntry(line)
        // removeLastFromHistory 慢路径：条目在删除前已被刷新，因此在此处过滤，使得 getHistory（上箭头）和 makeHistoryReader（ctrl+r 搜索）一致地跳过它。
        if (
          entry.sessionId === currentSession &&
          skippedTimestamps.has(entry.timestamp)
        ) {
          continue
        }
        yield entry
      } catch (error) {
        // 非严重错误 —— 仅跳过格式错误的行
        logForDebugging(`Failed to parse history line: ${error}`)
      }
    }
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code === 'ENOENT') {
      return
    }
    throw e
  }
}

/** 创建 make History Reader 对应的数据或状态。 */
export async function* makeHistoryReader(): AsyncGenerator<HistoryEntry> {
  for await (const entry of makeLogEntryReader()) {
    yield await logEntryToHistoryEntry(entry)
  }
}

export type TimestampedHistoryEntry = {
  display: string
  timestamp: number
  /** 确定 resolve 对应的数据或状态。 */
  resolve: () => Promise<HistoryEntry>
}

/** ctrl+r 选择器的当前项目历史：按显示文本去重，最新在前，带时间戳。粘贴内容通过 `resolve()` 延迟解析 —— 选择器仅读取显示文本和时间戳用于列表。 */
/** 获取 get Timestamped History 对应的数据或状态。 */
export async function* getTimestampedHistory(): AsyncGenerator<TimestampedHistoryEntry> {
  const currentProject = getProjectRoot()
  const seen = new Set<string>()

  for await (const entry of makeLogEntryReader()) {
    if (!entry || typeof entry.project !== 'string') continue
    if (entry.project !== currentProject) continue
    if (seen.has(entry.display)) continue
    seen.add(entry.display)

    yield {
      display: entry.display,
      timestamp: entry.timestamp,
      /** 确定 resolve 对应的数据或状态。 */
      resolve: () => logEntryToHistoryEntry(entry),
    }

    if (seen.size >= MAX_HISTORY_ITEMS) return
  }
}

/**
 * 获取当前项目的历史条目，当前会话条目优先。
 * 在当前会话的条目在其他会话条目之前返回，因此并发会话不会交错它们的上箭头历史。在每个组内，按最新优先排序。扫描与之前相同的 MAX_HISTORY_ITEMS 窗口 —— 在该窗口内重新排序条目，不超出窗口。
 */
/** 获取 get History 对应的数据或状态。 */
export async function* getHistory(): AsyncGenerator<HistoryEntry> {
  const currentProject = getProjectRoot()
  const currentSession = getSessionId()
  const otherSessionEntries: LogEntry[] = []
  let yielded = 0

  for await (const entry of makeLogEntryReader()) {
    // 跳过格式错误的条目（文件损坏、旧格式或无效的 JSON 结构）
    if (!entry || typeof entry.project !== 'string') continue
    if (entry.project !== currentProject) continue

    if (entry.sessionId === currentSession) {
      yield await logEntryToHistoryEntry(entry)
      yielded++
    } else {
      otherSessionEntries.push(entry)
    }

    // 与之前相同的 MAX_HISTORY_ITEMS 窗口 —— 仅在其中重新排序。
    if (yielded + otherSessionEntries.length >= MAX_HISTORY_ITEMS) break
  }

  for (const entry of otherSessionEntries) {
    if (yielded >= MAX_HISTORY_ITEMS) return
    yield await logEntryToHistoryEntry(entry)
    yielded++
  }
}

type LogEntry = {
  display: string
  pastedContents: Record<number, StoredPastedContent>
  timestamp: number
  project: string
  sessionId?: string
}

/** 通过从粘贴存储中获取数据（如果需要），将存储的粘贴内容解析为完整的 PastedContent。 */
/** 确定 resolve Stored Pasted Content 对应的数据或状态。 */
async function resolveStoredPastedContent(
  stored: StoredPastedContent,
): Promise<PastedContent | null> {
  // 如果有内联内容，直接使用
  if (stored.content) {
    return {
      id: stored.id,
      type: stored.type,
      content: stored.content,
      mediaType: stored.mediaType,
      filename: stored.filename,
    }
  }

  // 如果有哈希引用，从粘贴存储中获取
  if (stored.contentHash) {
    const content = await retrievePastedText(stored.contentHash)
    if (content) {
      return {
        id: stored.id,
        type: stored.type,
        content,
        mediaType: stored.mediaType,
        filename: stored.filename,
      }
    }
  }

  // 内容不可用
  return null
}

/** 通过解析粘贴存储引用，将 LogEntry 转换为 HistoryEntry。 */
/** 输出或发送 log Entry To History Entry 对应的数据或状态。 */
async function logEntryToHistoryEntry(entry: LogEntry): Promise<HistoryEntry> {
  const pastedContents: Record<number, PastedContent> = {}

  for (const [id, stored] of Object.entries(entry.pastedContents || {})) {
    const resolved = await resolveStoredPastedContent(stored)
    if (resolved) {
      pastedContents[Number(id)] = resolved
    }
  }

  return {
    display: entry.display,
    pastedContents,
  }
}

let pendingEntries: LogEntry[] = []
let isWriting = false
let currentFlushPromise: Promise<void> | null = null
let cleanupRegistered = false
let lastAddedEntry: LogEntry | null = null
// 已刷新到磁盘且应在读取时跳过的条目的时间戳。由 removeLastFromHistory 在条目已超越待处理缓冲区时使用。会话作用域（进程重启时模块状态重置）。
const skippedTimestamps = new Set<number>()

// 核心刷新逻辑 —— 将待处理条目写入磁盘
/** 执行 immediate Flush History 对应的业务处理。 */
async function immediateFlushHistory(): Promise<void> {
  if (pendingEntries.length === 0) {
    return
  }

  let release
  try {
    const historyPath = join(getFrameworkConfigHomeDir(), 'history.jsonl')

    // 在获取锁之前确保文件存在（追加模式会创建不存在的文件）
    await writeFile(historyPath, '', {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'a',
    })

    release = await lock(historyPath, {
      stale: 10000,
      retries: {
        retries: 3,
        minTimeout: 50,
      },
    })

    /** 执行 json Lines 对应的业务处理。 */
    const jsonLines = pendingEntries.map(entry => jsonStringify(entry) + '\n')
    pendingEntries = []

    await appendFile(historyPath, jsonLines.join(''), { mode: 0o600 })
  } catch (error) {
    logForDebugging(`Failed to write prompt history: ${error}`)
  } finally {
    if (release) {
      await release()
    }
  }
}

/** 执行 flush Prompt History 对应的业务处理。 */
async function flushPromptHistory(retries: number): Promise<void> {
  if (isWriting || pendingEntries.length === 0) {
    return
  }

  // 停止尝试刷新历史，直到下一个用户提示
  if (retries > 5) {
    return
  }

  isWriting = true

  try {
    await immediateFlushHistory()
  } finally {
    isWriting = false

    if (pendingEntries.length > 0) {
      // 避免在热循环中重试
      await sleep(500)

      void flushPromptHistory(retries + 1)
    }
  }
}

/** 添加或注册 add To Prompt History 对应的数据或状态。 */
async function addToPromptHistory(
  command: HistoryEntry | string,
): Promise<void> {
  const entry =
    typeof command === 'string'
      ? { display: command, pastedContents: {} }
      : command

  const storedPastedContents: Record<number, StoredPastedContent> = {}
  if (entry.pastedContents) {
    for (const [id, content] of Object.entries(entry.pastedContents)) {
      // 过滤掉图像（它们单独存储在 image-cache 中）
      if (content.type === 'image') {
        continue
      }

      // 对于小型文本内容，内联存储
      if (content.content.length <= MAX_PASTED_CONTENT_LENGTH) {
        storedPastedContents[Number(id)] = {
          id: content.id,
          type: content.type,
          content: content.content,
          mediaType: content.mediaType,
          filename: content.filename,
        }
      } else {
        // 对于大型文本内容，同步计算哈希并存储引用。实际磁盘写入异步进行（即发即忘）
        const hash = hashPastedText(content.content)
        storedPastedContents[Number(id)] = {
          id: content.id,
          type: content.type,
          contentHash: hash,
          mediaType: content.mediaType,
          filename: content.filename,
        }
        // 即发即忘的磁盘写入 —— 不阻塞历史条目创建
        void storePastedText(hash, content.content)
      }
    }
  }

  const logEntry: LogEntry = {
    ...entry,
    pastedContents: storedPastedContents,
    timestamp: Date.now(),
    project: getProjectRoot(),
    sessionId: getSessionId(),
  }

  pendingEntries.push(logEntry)
  lastAddedEntry = logEntry
  currentFlushPromise = flushPromptHistory(0)
  void currentFlushPromise
}

/** 添加或注册 add To History 对应的数据或状态。 */
export function addToHistory(command: HistoryEntry | string): void {
  // 在由Claude Code的Tungsten工具生成的tmux会话中运行时跳过历史记录。这可以防止验证/测试会话污染用户的真实命令历史。
  if (isEnvTruthy(process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY)) {
    return
  }

  // 在首次使用时注册清理
  if (!cleanupRegistered) {
    cleanupRegistered = true
    registerCleanup(async () => {
      // 如果存在正在进行中的刷新，则等待它完成
      if (currentFlushPromise) {
        await currentFlushPromise
      }
      // 如果刷新完成后仍有待处理条目，则执行一次最终刷新
      if (pendingEntries.length > 0) {
        await immediateFlushHistory()
      }
    })
  }

  void addToPromptHistory(command)
}

/** 删除或清理 clear Pending History Entries 对应的数据或状态。 */
export function clearPendingHistoryEntries(): void {
  pendingEntries = []
  lastAddedEntry = null
  skippedTimestamps.clear()
}

/**
 * 撤销最近的addToHistory调用。由auto-restore-on-interrupt使用：当Esc在任何响应到达之前回滚对话时，提交在语义上被撤销——历史记录条目也应如此，否则Up-arrow会显示恢复的文本两次（一次来自输入框，一次来自磁盘）。
 *
 * 快速路径从待处理缓冲区中弹出。如果异步刷新已经赢得竞赛（TTFT通常远大于磁盘写入延迟），条目的时间戳将被添加到由getHistory查询的跳过集中。一次性：清除跟踪的条目，因此第二次调用是空操作。
 */
/** 删除或清理 remove Last From History 对应的数据或状态。 */
export function removeLastFromHistory(): void {
  if (!lastAddedEntry) return
  const entry = lastAddedEntry
  lastAddedEntry = null

  const idx = pendingEntries.lastIndexOf(entry)
  if (idx !== -1) {
    pendingEntries.splice(idx, 1)
  } else {
    skippedTimestamps.add(entry.timestamp)
  }
}
