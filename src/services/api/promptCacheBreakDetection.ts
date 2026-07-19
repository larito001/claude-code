import type { BetaToolUnion } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { createPatch } from 'diff'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import type { AgentId } from 'src/types/ids.js'
import type { Message } from 'src/types/message.js'
import { logForDebugging } from 'src/utils/debug.js'
import { djb2Hash } from 'src/utils/hash.js'
import { logError } from 'src/utils/log.js'
import { getClaudeTempDir } from 'src/utils/permissions/filesystem.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import type { QuerySource } from '../../constants/querySource.js'

/** 获取 get Cache Break Diff Path 对应的数据或状态。 */
function getCacheBreakDiffPath(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let suffix = ''
  for (let i = 0; i < 4; i++) {
    suffix += chars[Math.floor(Math.random() * chars.length)]
  }
  return join(getClaudeTempDir(), `cache-break-${suffix}.diff`)
}

type PreviousState = {
  systemHash: number
  toolsHash: number
  /** 带有 cache_control 完整的系统块哈希。捕获 stripCacheControl 从 systemHash 中擦除的作用域/TTL 翻转（global↔org, 1h↔5m）。 */
  cacheControlHash: number
  toolNames: string[]
  /**
   * 每个工具的架构哈希。当 toolSchemasChanged 但 added=removed=0 时，通过差异比较判断哪个工具的描述发生了变化（根据 BQ 2026-03-22，77% 的工具中断由此引起）。AgentTool/SkillTool 嵌入动态的 agent/command 列表。
   */
  perToolHashes: Record<string, number>
  systemCharCount: number
  model: string
  fastMode: boolean
  /** 'tool_based' | 'system_prompt' | 'none' — 当 MCP 工具被发现/移除时翻转。 */
  globalCacheStrategy: string
  /** 排序后的 beta 头部列表。通过差异比较显示哪些头部被添加/移除。 */
  betas: string[]
  /** AFK_MODE_BETA_HEADER 的存在性 — 不应再破坏缓存（在 claude.ts 中已锁定为 sticky-on）。通过跟踪来验证修复。 */
  autoModeActive: boolean
  /** 解析后的 effort（环境、选项或模型默认值）。 */
  effortValue: string
  /** getExtraBodyParams() 的哈希；捕获 CLAUDE_CODE_EXTRA_BODY 的变化。 */
  extraBodyHash: number
  callCount: number
  pendingChanges: PendingChanges | null
  prevCacheReadTokens: number | null
  /** 当本地压缩移除缓存内容时设置。缓存读取会合理下降 — 这是预期的，不是中断。 */
  cacheDeletionsPending: boolean
  /** 创建 build Diffable Content 对应的数据或状态。 */
  buildDiffableContent: () => string
}

type PendingChanges = {
  systemPromptChanged: boolean
  toolSchemasChanged: boolean
  modelChanged: boolean
  fastModeChanged: boolean
  cacheControlChanged: boolean
  globalCacheStrategyChanged: boolean
  betasChanged: boolean
  autoModeChanged: boolean
  effortChanged: boolean
  extraBodyChanged: boolean
  addedToolCount: number
  removedToolCount: number
  systemCharDelta: number
  addedTools: string[]
  removedTools: string[]
  changedToolSchemas: string[]
  previousModel: string
  newModel: string
  prevGlobalCacheStrategy: string
  newGlobalCacheStrategy: string
  addedBetas: string[]
  removedBetas: string[]
  prevEffortValue: string
  newEffortValue: string
  /** 创建 build Prev Diffable Content 对应的数据或状态。 */
  buildPrevDiffableContent: () => string
}

const previousStateBySource = new Map<string, PreviousState>()

// 限制跟踪源的数量以防止无界内存增长。每个条目存储一个约 300KB+ 的 diffableContent 字符串（序列化的系统提示 + 工具架构）。如果没有上限，生成许多子代理（每个都有唯一的 agentId 键）会导致映射无限增长。
const MAX_TRACKED_SOURCES = 10

const TRACKED_SOURCE_PREFIXES = [
  'repl_main_thread',
  'sdk',
  'agent:custom',
  'agent:default',
  'agent:builtin',
]

// 触发缓存中断警告所需的最小绝对 token 下降量。小的下降（例如几千个 token）可能由于正常变化而发生，不值得报警。
const MIN_CACHE_MISS_TOKENS = 2_000

// Anthropic 服务器端提示缓存 TTL 阈值用于测试。这些持续时间后的缓存中断很可能是由于 TTL 过期而非客户端更改。
const CACHE_TTL_5MIN_MS = 5 * 60 * 1000
export const CACHE_TTL_1HOUR_MS = 60 * 60 * 1000

// 要从缓存中断检测中排除的模型（例如 haiku 有不同的缓存行为）
function isExcludedModel(model: string): boolean {
  return model.includes('haiku')
}

/**
 * 返回 querySource 的跟踪键，如果未跟踪则返回 null。Compact 与 repl_main_thread 共享相同的服务器端缓存（相同的 cacheSafeParams），因此它们共享跟踪状态。
 * 对于具有跟踪 querySource 的子代理，使用唯一的 agentId 隔离跟踪状态。这防止了当同一代理类型的多个实例并发运行时出现假阳性缓存中断通知。
 * 未跟踪的源（speculation, session_memory, prompt_suggestion 等）是短命的派生代理，缓存中断检测对此没有价值 — 它们每次使用新的 agentId 运行 1-3 轮，因此没有有意义的内容进行比较。
 */
function getTrackingKey(
  querySource: QuerySource,
  agentId?: AgentId,
): string | null {
  if (querySource === 'compact') return 'repl_main_thread'
  for (const prefix of TRACKED_SOURCE_PREFIXES) {
    if (querySource.startsWith(prefix)) return agentId || querySource
  }
  return null
}

/** 执行 strip Cache Control 对应的业务处理。 */
function stripCacheControl(
  items: ReadonlyArray<Record<string, unknown>>,
): unknown[] {
  return items.map(item => {
    if (!('cache_control' in item)) return item
    const { cache_control: _, ...rest } = item
    return rest
  })
}

/** 计算 compute Hash 对应的数据或状态。 */
function computeHash(data: unknown): number {
  const str = jsonStringify(data)
  if (typeof Bun !== 'undefined') {
    const hash = Bun.hash(str)
    // Bun.hash 对于大输入可能返回 bigint；安全地转换为 number
    return typeof hash === 'bigint' ? Number(hash & 0xffffffffn) : hash
  }
  // 非 Bun 运行时的回退（例如通过 npm 全局安装的 Node.js）
  return djb2Hash(str)
}

/** MCP 工具名称是用户控制的（服务器配置），可能泄露文件路径。将它们折叠为 'mcp'；内置名称是固定词汇表。 */
function sanitizeToolName(name: string): string {
  return name.startsWith('mcp__') ? 'mcp' : name
}

/** 计算 compute Per Tool Hashes 对应的数据或状态。 */
function computePerToolHashes(
  strippedTools: ReadonlyArray<unknown>,
  names: string[],
): Record<string, number> {
  const hashes: Record<string, number> = {}
  for (let i = 0; i < strippedTools.length; i++) {
    hashes[names[i] ?? `__idx_${i}`] = computeHash(strippedTools[i])
  }
  return hashes
}

/** 获取 get System Char Count 对应的数据或状态。 */
function getSystemCharCount(system: TextBlockParam[]): number {
  let total = 0
  for (const block of system) {
    total += block.text.length
  }
  return total
}

/** 创建 build Diffable Content 对应的数据或状态。 */
function buildDiffableContent(
  system: TextBlockParam[],
  tools: BetaToolUnion[],
  model: string,
): string {
  const systemText = system.map(b => b.text).join('\n\n')
  const toolDetails = tools
    .map(t => {
      if (!('name' in t)) return 'unknown'
      const desc = 'description' in t ? t.description : ''
      const schema = 'input_schema' in t ? jsonStringify(t.input_schema) : ''
      return `${t.name}\n  description: ${desc}\n  input_schema: ${schema}`
    })
    .sort()
    .join('\n\n')
  return `Model: ${model}\n\n=== System Prompt ===\n\n${systemText}\n\n=== Tools (${tools.length}) ===\n\n${toolDetails}\n`
}

/** 扩展跟踪快照 — 所有可能影响我们可从客户端观察到的服务器端缓存键的因素。所有字段都是可选的，以便调用点可以增量添加；未定义的字段比较为稳定。 */
export type PromptStateSnapshot = {
  system: TextBlockParam[]
  toolSchemas: BetaToolUnion[]
  querySource: QuerySource
  model: string
  agentId?: AgentId
  fastMode?: boolean
  globalCacheStrategy?: string
  betas?: readonly string[]
  autoModeActive?: boolean
  effortValue?: string | number
  extraBodyParams?: unknown
}

/** 阶段 1（调用前）：记录当前提示/工具状态并检测变化。不触发事件 — 仅存储待处理更改供阶段 2 使用。 */
export function recordPromptState(snapshot: PromptStateSnapshot): void {
  try {
    const {
      system,
      toolSchemas,
      querySource,
      model,
      agentId,
      fastMode,
      globalCacheStrategy = '',
      betas = [],
      autoModeActive = false,
      effortValue,
      extraBodyParams,
    } = snapshot
    const key = getTrackingKey(querySource, agentId)
    if (!key) return

    const strippedSystem = stripCacheControl(
      system as unknown as ReadonlyArray<Record<string, unknown>>,
    )
    const strippedTools = stripCacheControl(
      toolSchemas as unknown as ReadonlyArray<Record<string, unknown>>,
    )

    const systemHash = computeHash(strippedSystem)
    const toolsHash = computeHash(strippedTools)
    // 哈希包含 cache_control 的完整系统数组 — 这会捕获剥离后的哈希无法看到的范围翻转（global↔org/none）和 TTL 翻转（1h↔5m），因为文本内容相同。
    const cacheControlHash = computeHash(
      system.map(b => ('cache_control' in b ? b.cache_control : null)),
    )
    /** 转换 tool Names 对应的数据或状态。 */
    const toolNames = toolSchemas.map(t => ('name' in t ? t.name : 'unknown'))
    // 仅当聚合值发生变化时才计算每个工具的哈希 — 常见情况（工具未变化）跳过额外的 N 次 jsonStringify 调用。
    const computeToolHashes = () =>
      computePerToolHashes(strippedTools, toolNames)
    const systemCharCount = getSystemCharCount(system)
    /** 执行 lazy Diffable Content 对应的业务处理。 */
    const lazyDiffableContent = () =>
      buildDiffableContent(system, toolSchemas, model)
    const isFastMode = fastMode ?? false
    const sortedBetas = [...betas].sort()
    const effortStr = effortValue === undefined ? '' : String(effortValue)
    const extraBodyHash =
      extraBodyParams === undefined ? 0 : computeHash(extraBodyParams)

    const prev = previousStateBySource.get(key)

    if (!prev) {
      // 如果映射达到容量，移除最旧的条目
      while (previousStateBySource.size >= MAX_TRACKED_SOURCES) {
        const oldest = previousStateBySource.keys().next().value
        if (oldest !== undefined) previousStateBySource.delete(oldest)
      }

      previousStateBySource.set(key, {
        systemHash,
        toolsHash,
        cacheControlHash,
        toolNames,
        systemCharCount,
        model,
        fastMode: isFastMode,
        globalCacheStrategy,
        betas: sortedBetas,
        autoModeActive,
        effortValue: effortStr,
        extraBodyHash,
        callCount: 1,
        pendingChanges: null,
        prevCacheReadTokens: null,
        cacheDeletionsPending: false,
        buildDiffableContent: lazyDiffableContent,
        perToolHashes: computeToolHashes(),
      })
      return
    }

    prev.callCount++

    const systemPromptChanged = systemHash !== prev.systemHash
    const toolSchemasChanged = toolsHash !== prev.toolsHash
    const modelChanged = model !== prev.model
    const fastModeChanged = isFastMode !== prev.fastMode
    const cacheControlChanged = cacheControlHash !== prev.cacheControlHash
    const globalCacheStrategyChanged =
      globalCacheStrategy !== prev.globalCacheStrategy
    const betasChanged =
      sortedBetas.length !== prev.betas.length ||
      sortedBetas.some((b, i) => b !== prev.betas[i])
    const autoModeChanged = autoModeActive !== prev.autoModeActive
    const effortChanged = effortStr !== prev.effortValue
    const extraBodyChanged = extraBodyHash !== prev.extraBodyHash

    if (
      systemPromptChanged ||
      toolSchemasChanged ||
      modelChanged ||
      fastModeChanged ||
      cacheControlChanged ||
      globalCacheStrategyChanged ||
      betasChanged ||
      autoModeChanged ||
      effortChanged ||
      extraBodyChanged
    ) {
      const prevToolSet = new Set(prev.toolNames)
      const newToolSet = new Set(toolNames)
      const prevBetaSet = new Set(prev.betas)
      const newBetaSet = new Set(sortedBetas)
      /** 添加或注册 added Tools 对应的数据或状态。 */
      const addedTools = toolNames.filter(n => !prevToolSet.has(n))
      /** 删除或清理 removed Tools 对应的数据或状态。 */
      const removedTools = prev.toolNames.filter(n => !newToolSet.has(n))
      const changedToolSchemas: string[] = []
      if (toolSchemasChanged) {
        const newHashes = computeToolHashes()
        for (const name of toolNames) {
          if (!prevToolSet.has(name)) continue
          if (newHashes[name] !== prev.perToolHashes[name]) {
            changedToolSchemas.push(name)
          }
        }
        prev.perToolHashes = newHashes
      }
      prev.pendingChanges = {
        systemPromptChanged,
        toolSchemasChanged,
        modelChanged,
        fastModeChanged,
        cacheControlChanged,
        globalCacheStrategyChanged,
        betasChanged,
        autoModeChanged,
        effortChanged,
        extraBodyChanged,
        addedToolCount: addedTools.length,
        removedToolCount: removedTools.length,
        addedTools,
        removedTools,
        changedToolSchemas,
        systemCharDelta: systemCharCount - prev.systemCharCount,
        previousModel: prev.model,
        newModel: model,
        prevGlobalCacheStrategy: prev.globalCacheStrategy,
        newGlobalCacheStrategy: globalCacheStrategy,
        /** 添加或注册 added Betas 对应的数据或状态。 */
        addedBetas: sortedBetas.filter(b => !prevBetaSet.has(b)),
        /** 删除或清理 removed Betas 对应的数据或状态。 */
        removedBetas: prev.betas.filter(b => !newBetaSet.has(b)),
        prevEffortValue: prev.effortValue,
        newEffortValue: effortStr,
        buildPrevDiffableContent: prev.buildDiffableContent,
      }
    } else {
      prev.pendingChanges = null
    }

    prev.systemHash = systemHash
    prev.toolsHash = toolsHash
    prev.cacheControlHash = cacheControlHash
    prev.toolNames = toolNames
    prev.systemCharCount = systemCharCount
    prev.model = model
    prev.fastMode = isFastMode
    prev.globalCacheStrategy = globalCacheStrategy
    prev.betas = sortedBetas
    prev.autoModeActive = autoModeActive
    prev.effortValue = effortStr
    prev.extraBodyHash = extraBodyHash
    prev.buildDiffableContent = lazyDiffableContent
  } catch (e: unknown) {
    logError(e)
  }
}

/** 阶段 2（调用后）：检查 API 响应的缓存 token 以确定是否实际发生了缓存中断。如果是，则使用阶段 1 中的待处理更改来解释原因。 */
export async function checkResponseForCacheBreak(
  querySource: QuerySource,
  cacheReadTokens: number,
  cacheCreationTokens: number,
  messages: Message[],
  agentId?: AgentId,
  requestId?: string | null,
): Promise<void> {
  try {
    const key = getTrackingKey(querySource, agentId)
    if (!key) return

    const state = previousStateBySource.get(key)
    if (!state) return

    // 跳过排除的模型（例如 haiku 有不同的缓存行为）
    if (isExcludedModel(state.model)) return

    const prevCacheRead = state.prevCacheReadTokens
    state.prevCacheReadTokens = cacheReadTokens

    // 计算自上次调用以来的时间以进行 TTL 检测，方法是在消息数组（当前响应之前）中查找最近的助手消息时间戳。
    const lastAssistantMessage = messages.findLast(m => m.type === 'assistant')
    const timeSinceLastAssistantMsg = lastAssistantMessage
      ? Date.now() - new Date(lastAssistantMessage.timestamp).getTime()
      : null

    // 跳过第一次调用——没有先前值可比较
    if (prevCacheRead === null) return

    const changes = state.pendingChanges

    // 通过缓存微压缩进行的缓存删除会故意减少缓存前缀。缓存读取令牌的下降是预期的——重置基线，以便下次调用时不会误判。
    if (state.cacheDeletionsPending) {
      state.cacheDeletionsPending = false
      logForDebugging(
        `[PROMPT CACHE] cache deletion applied, cache read: ${prevCacheRead} → ${cacheReadTokens} (expected drop)`,
      )
      // 不标记为中断——剩余状态仍然有效
      state.pendingChanges = null
      return
    }

    // 检测缓存中断：缓存读取量比上一次下降超过5%，且绝对下降量超过最小阈值。
    const tokenDrop = prevCacheRead - cacheReadTokens
    if (
      cacheReadTokens >= prevCacheRead * 0.95 ||
      tokenDrop < MIN_CACHE_MISS_TOKENS
    ) {
      state.pendingChanges = null
      return
    }

    // 根据待处理的更改构建解释（如果有）
    const parts: string[] = []
    if (changes) {
      if (changes.modelChanged) {
        parts.push(
          `model changed (${changes.previousModel} → ${changes.newModel})`,
        )
      }
      if (changes.systemPromptChanged) {
        const charDelta = changes.systemCharDelta
        const charInfo =
          charDelta === 0
            ? ''
            : charDelta > 0
              ? ` (+${charDelta} chars)`
              : ` (${charDelta} chars)`
        parts.push(`system prompt changed${charInfo}`)
      }
      if (changes.toolSchemasChanged) {
        const toolDiff =
          changes.addedToolCount > 0 || changes.removedToolCount > 0
            ? ` (+${changes.addedToolCount}/-${changes.removedToolCount} tools)`
            : ' (tool prompt/schema changed, same tool set)'
        parts.push(`tools changed${toolDiff}`)
      }
      if (changes.fastModeChanged) {
        parts.push('fast mode toggled')
      }
      if (changes.globalCacheStrategyChanged) {
        parts.push(
          `global cache strategy changed (${changes.prevGlobalCacheStrategy || 'none'} → ${changes.newGlobalCacheStrategy || 'none'})`,
        )
      }
      if (
        changes.cacheControlChanged &&
        !changes.globalCacheStrategyChanged &&
        !changes.systemPromptChanged
      ) {
        // 仅当没有其他因素能解释时，才报告为独立原因——否则作用域/TTL翻转是结果而非根本原因。
        parts.push('cache_control changed (scope or TTL)')
      }
      if (changes.betasChanged) {
        const added = changes.addedBetas.length
          ? `+${changes.addedBetas.join(',')}`
          : ''
        const removed = changes.removedBetas.length
          ? `-${changes.removedBetas.join(',')}`
          : ''
        const diff = [added, removed].filter(Boolean).join(' ')
        parts.push(`betas changed${diff ? ` (${diff})` : ''}`)
      }
      if (changes.autoModeChanged) {
        parts.push('auto mode toggled')
      }
      if (changes.effortChanged) {
        parts.push(
          `effort changed (${changes.prevEffortValue || 'default'} → ${changes.newEffortValue || 'default'})`,
        )
      }
      if (changes.extraBodyChanged) {
        parts.push('extra body params changed')
      }
    }

    // 检查时间间隔是否暗示TTL过期
    const lastAssistantMsgOver5minAgo =
      timeSinceLastAssistantMsg !== null &&
      timeSinceLastAssistantMsg > CACHE_TTL_5MIN_MS
    const lastAssistantMsgOver1hAgo =
      timeSinceLastAssistantMsg !== null &&
      timeSinceLastAssistantMsg > CACHE_TTL_1HOUR_MS

    // PR #19823 后的 BQ 分析（bq-queries/prompt-caching/cache_break_pr19823_analysis.sql）：当所有客户端标志为false且间隔小于TTL时，约90%的中断是服务端路由/驱逐或计费/推理不一致导致的。相应标记，而不暗示是CC的bug排查方向。
    let reason: string
    if (parts.length > 0) {
      reason = parts.join(', ')
    } else if (lastAssistantMsgOver1hAgo) {
      reason = 'possible 1h TTL expiry (prompt unchanged)'
    } else if (lastAssistantMsgOver5minAgo) {
      reason = 'possible 5min TTL expiry (prompt unchanged)'
    } else if (timeSinceLastAssistantMsg !== null) {
      reason = 'likely server-side (prompt unchanged, <5min gap)'
    } else {
      reason = 'unknown cause'
    }


    // 启用 --debug 时写入差异文件。该路径包含在摘要日志中，用于本地诊断。
    let diffPath: string | undefined
    if (changes?.buildPrevDiffableContent) {
      diffPath = await writeCacheBreakDiff(
        changes.buildPrevDiffableContent(),
        state.buildDiffableContent(),
      )
    }

    const diffSuffix = diffPath ? `, diff: ${diffPath}` : ''
    const summary = `[PROMPT CACHE BREAK] ${reason} [source=${querySource}, call #${state.callCount}, cache read: ${prevCacheRead} → ${cacheReadTokens}, creation: ${cacheCreationTokens}${diffSuffix}]`

    logForDebugging(summary, { level: 'warn' })

    state.pendingChanges = null
  } catch (e: unknown) {
    logError(e)
  }
}

/** 当本地压缩从缓存前缀中移除内容时调用。下一次API响应将具有更低的缓存读取令牌——这是预期的，不是缓存中断。 */
export function notifyCacheDeletion(
  querySource: QuerySource,
  agentId?: AgentId,
): void {
  const key = getTrackingKey(querySource, agentId)
  const state = key ? previousStateBySource.get(key) : undefined
  if (state) {
    state.cacheDeletionsPending = true
  }
}

/** 压缩后调用以重置缓存读取基线。压缩合法地减少了消息数量，因此下次调用时缓存读取令牌自然会下降——这不是中断。 */
export function notifyCompaction(
  querySource: QuerySource,
  agentId?: AgentId,
): void {
  const key = getTrackingKey(querySource, agentId)
  const state = key ? previousStateBySource.get(key) : undefined
  if (state) {
    state.prevCacheReadTokens = null
  }
}

/** 规范化 cleanup Agent Tracking 对应的数据或状态。 */
export function cleanupAgentTracking(agentId: AgentId): void {
  previousStateBySource.delete(agentId)
}

/** 重置或恢复 reset Prompt Cache Break Detection 对应的数据或状态。 */
export function resetPromptCacheBreakDetection(): void {
  previousStateBySource.clear()
}

/** 设置并保存 write Cache Break Diff 对应的数据或状态。 */
async function writeCacheBreakDiff(
  prevContent: string,
  newContent: string,
): Promise<string | undefined> {
  try {
    const diffPath = getCacheBreakDiffPath()
    await mkdir(getClaudeTempDir(), { recursive: true })
    const patch = createPatch(
      'prompt-state',
      prevContent,
      newContent,
      'before',
      'after',
    )
    await writeFile(diffPath, patch)
    return diffPath
  } catch {
    return undefined
  }
}
