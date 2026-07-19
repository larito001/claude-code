import type { BetaUsage as Usage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import chalk from 'chalk'
import {
  addToTotalCostState,
  addToTotalLinesChanged,
  getCostCounter,
  getModelUsage,
  getSdkBetas,
  getSessionId,
  getTokenCounter,
  getTotalAPIDuration,
  getTotalAPIDurationWithoutRetries,
  getTotalCacheCreationInputTokens,
  getTotalCacheReadInputTokens,
  getTotalCostUSD,
  getTotalDuration,
  getTotalInputTokens,
  getTotalLinesAdded,
  getTotalLinesRemoved,
  getTotalOutputTokens,
  getTotalToolDuration,
  getTotalWebSearchRequests,
  getUsageForModel,
  hasUnknownModelCost,
  resetCostState,
  resetStateForTests,
  setCostStateForRestore,
  setHasUnknownModelCost,
} from './bootstrap/state.js'
import type { ModelUsage } from './entrypoints/agentSdkTypes.js'
import {
  getCurrentProjectConfig,
  saveCurrentProjectConfig,
} from './utils/config.js'
import {
  getContextWindowForModel,
  getModelMaxOutputTokens,
} from './utils/context.js'
import { isFastModeEnabled } from './utils/fastMode.js'
import { formatDuration, formatNumber } from './utils/format.js'
import type { FpsMetrics } from './utils/fpsTracker.js'
import { getCanonicalName } from './utils/model/model.js'
import { calculateUSDCost } from './utils/modelCost.js'
export {
  getTotalCostUSD as getTotalCost,
  getTotalDuration,
  getTotalAPIDuration,
  getTotalAPIDurationWithoutRetries,
  addToTotalLinesChanged,
  getTotalLinesAdded,
  getTotalLinesRemoved,
  getTotalInputTokens,
  getTotalOutputTokens,
  getTotalCacheReadInputTokens,
  getTotalCacheCreationInputTokens,
  getTotalWebSearchRequests,
  formatCost,
  hasUnknownModelCost,
  resetStateForTests,
  resetCostState,
  setHasUnknownModelCost,
  getModelUsage,
  getUsageForModel,
}

type StoredCostState = {
  totalCostUSD: number
  totalAPIDuration: number
  totalAPIDurationWithoutRetries: number
  totalToolDuration: number
  totalLinesAdded: number
  totalLinesRemoved: number
  lastDuration: number | undefined
  modelUsage: { [modelName: string]: ModelUsage } | undefined
}

/**
 * 从项目配置中获取特定会话的已存储成本状态。
 * 如果会话ID匹配则返回成本数据，否则返回undefined。
 * 在调用 saveCurrentSessionCosts() 覆盖配置之前，使用此函数读取成本。
 */
export function getStoredSessionCosts(
  sessionId: string,
): StoredCostState | undefined {
  const projectConfig = getCurrentProjectConfig()

  // 仅当这是上次保存的同一会话时才返回成本。
  if (projectConfig.lastSessionId !== sessionId) {
    return undefined
  }

  // 使用上下文窗口构建模型使用量。
  let modelUsage: { [modelName: string]: ModelUsage } | undefined
  if (projectConfig.lastModelUsage) {
    modelUsage = Object.fromEntries(
      Object.entries(projectConfig.lastModelUsage).map(([model, usage]) => [
        model,
        {
          ...usage,
          contextWindow: getContextWindowForModel(model, getSdkBetas()),
          maxOutputTokens: getModelMaxOutputTokens(model).default,
        },
      ]),
    )
  }

  return {
    totalCostUSD: projectConfig.lastCost ?? 0,
    totalAPIDuration: projectConfig.lastAPIDuration ?? 0,
    totalAPIDurationWithoutRetries:
      projectConfig.lastAPIDurationWithoutRetries ?? 0,
    totalToolDuration: projectConfig.lastToolDuration ?? 0,
    totalLinesAdded: projectConfig.lastLinesAdded ?? 0,
    totalLinesRemoved: projectConfig.lastLinesRemoved ?? 0,
    lastDuration: projectConfig.lastDuration,
    modelUsage,
  }
}

/**
 * 在恢复会话时从项目配置还原成本状态。
 * 仅当会话ID与上次保存的会话匹配时才还原。
 * @returns 如果成本状态已还原则返回 true，否则返回 false。
 */
export function restoreCostStateForSession(sessionId: string): boolean {
  const data = getStoredSessionCosts(sessionId)
  if (!data) {
    return false
  }
  setCostStateForRestore(data)
  return true
}

/**
 * 将当前会话的成本保存到项目配置。
 * 在切换会话之前调用此函数以避免丢失累积的成本。
 */
export function saveCurrentSessionCosts(fpsMetrics?: FpsMetrics): void {
  saveCurrentProjectConfig(current => ({
    ...current,
    lastCost: getTotalCostUSD(),
    lastAPIDuration: getTotalAPIDuration(),
    lastAPIDurationWithoutRetries: getTotalAPIDurationWithoutRetries(),
    lastToolDuration: getTotalToolDuration(),
    lastDuration: getTotalDuration(),
    lastLinesAdded: getTotalLinesAdded(),
    lastLinesRemoved: getTotalLinesRemoved(),
    lastTotalInputTokens: getTotalInputTokens(),
    lastTotalOutputTokens: getTotalOutputTokens(),
    lastTotalCacheCreationInputTokens: getTotalCacheCreationInputTokens(),
    lastTotalCacheReadInputTokens: getTotalCacheReadInputTokens(),
    lastTotalWebSearchRequests: getTotalWebSearchRequests(),
    lastFpsAverage: fpsMetrics?.averageFps,
    lastFpsLow1Pct: fpsMetrics?.low1PctFps,
    /** 执行 last Model Usage 对应的业务处理。 */
    lastModelUsage: Object.fromEntries(
      Object.entries(getModelUsage()).map(([model, usage]) => [
        model,
        {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadInputTokens: usage.cacheReadInputTokens,
          cacheCreationInputTokens: usage.cacheCreationInputTokens,
          webSearchRequests: usage.webSearchRequests,
          costUSD: usage.costUSD,
        },
      ]),
    ),
    lastSessionId: getSessionId(),
  }))
}

/** 格式化 format Cost 对应的数据或状态。 */
function formatCost(cost: number, maxDecimalPlaces: number = 4): string {
  return `$${cost > 0.5 ? round(cost, 100).toFixed(2) : cost.toFixed(maxDecimalPlaces)}`
}

/** 格式化 format Model Usage 对应的数据或状态。 */
function formatModelUsage(): string {
  const modelUsageMap = getModelUsage()
  if (Object.keys(modelUsageMap).length === 0) {
    return 'Usage:                 0 input, 0 output, 0 cache read, 0 cache write'
  }

  // 按短名称累积使用量
  const usageByShortName: { [shortName: string]: ModelUsage } = {}
  for (const [model, usage] of Object.entries(modelUsageMap)) {
    const shortName = getCanonicalName(model)
    if (!usageByShortName[shortName]) {
      usageByShortName[shortName] = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0,
        contextWindow: 0,
        maxOutputTokens: 0,
      }
    }
    const accumulated = usageByShortName[shortName]
    accumulated.inputTokens += usage.inputTokens
    accumulated.outputTokens += usage.outputTokens
    accumulated.cacheReadInputTokens += usage.cacheReadInputTokens
    accumulated.cacheCreationInputTokens += usage.cacheCreationInputTokens
    accumulated.webSearchRequests += usage.webSearchRequests
    accumulated.costUSD += usage.costUSD
  }

  let result = 'Usage by model:'
  for (const [shortName, usage] of Object.entries(usageByShortName)) {
    const usageString =
      `  ${formatNumber(usage.inputTokens)} input, ` +
      `${formatNumber(usage.outputTokens)} output, ` +
      `${formatNumber(usage.cacheReadInputTokens)} cache read, ` +
      `${formatNumber(usage.cacheCreationInputTokens)} cache write` +
      (usage.webSearchRequests > 0
        ? `, ${formatNumber(usage.webSearchRequests)} web search`
        : '') +
      ` (${formatCost(usage.costUSD)})`
    result += `\n` + `${shortName}:`.padStart(21) + usageString
  }
  return result
}

/** 格式化 format Total Cost 对应的数据或状态。 */
export function formatTotalCost(): string {
  const costDisplay =
    formatCost(getTotalCostUSD()) +
    (hasUnknownModelCost()
      ? ' (costs may be inaccurate due to usage of unknown models)'
      : '')

  const modelUsageDisplay = formatModelUsage()

  return chalk.dim(
    `Total cost:            ${costDisplay}\n` +
      `Total duration (API):  ${formatDuration(getTotalAPIDuration())}
Total duration (wall): ${formatDuration(getTotalDuration())}
Total code changes:    ${getTotalLinesAdded()} ${getTotalLinesAdded() === 1 ? 'line' : 'lines'} added, ${getTotalLinesRemoved()} ${getTotalLinesRemoved() === 1 ? 'line' : 'lines'} removed
${modelUsageDisplay}`,
  )
}

/** 执行 round 对应的业务处理。 */
function round(number: number, precision: number): number {
  return Math.round(number * precision) / precision
}

/** 添加或注册 add To Total Model Usage 对应的数据或状态。 */
function addToTotalModelUsage(
  cost: number,
  usage: Usage,
  model: string,
): ModelUsage {
  const modelUsage = getUsageForModel(model) ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
    contextWindow: 0,
    maxOutputTokens: 0,
  }

  modelUsage.inputTokens += usage.input_tokens
  modelUsage.outputTokens += usage.output_tokens
  modelUsage.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0
  modelUsage.cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0
  modelUsage.webSearchRequests +=
    usage.server_tool_use?.web_search_requests ?? 0
  modelUsage.costUSD += cost
  modelUsage.contextWindow = getContextWindowForModel(model, getSdkBetas())
  modelUsage.maxOutputTokens = getModelMaxOutputTokens(model).default
  return modelUsage
}

/** 添加或注册 add To Total Session Cost 对应的数据或状态。 */
export function addToTotalSessionCost(
  cost: number,
  usage: Usage,
  model: string,
): number {
  const modelUsage = addToTotalModelUsage(cost, usage, model)
  addToTotalCostState(cost, modelUsage, model)

  const attrs =
    isFastModeEnabled() && usage.speed === 'fast'
      ? { model, speed: 'fast' }
      : { model }

  getCostCounter()?.add(cost, attrs)
  getTokenCounter()?.add(usage.input_tokens, { ...attrs, type: 'input' })
  getTokenCounter()?.add(usage.output_tokens, { ...attrs, type: 'output' })
  getTokenCounter()?.add(usage.cache_read_input_tokens ?? 0, {
    ...attrs,
    type: 'cacheRead',
  })
  getTokenCounter()?.add(usage.cache_creation_input_tokens ?? 0, {
    ...attrs,
    type: 'cacheCreation',
  })

  return cost
}
