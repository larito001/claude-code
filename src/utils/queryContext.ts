/**
 * 用于构建query()调用的API缓存键前缀（systemPrompt, userContext, systemContext）的共享辅助函数。
 *
 * 它位于自己的文件中，因为它从context.ts和constants/prompts.ts导入，这些文件在依赖关系图中处于高层。将这些导入放在systemPrompt.ts或sideQuestion.ts（两者都从commands.ts可达）中会产生循环依赖。只有入口层文件从这里导入（QueryEngine.ts, cli/print.ts）。
 */

import type { Command } from '../commands.js'
import {
  getSystemPrompt,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
} from '../constants/prompts.js'
import { getSystemContext, getUserContext } from '../context.js'
import type { MCPServerConnection } from '../services/mcp/types.js'
import type { AppState } from '../state/AppStateStore.js'
import type { Tools, ToolUseContext } from '../Tool.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import type { Message } from '../types/message.js'
import { createAbortController } from './abortController.js'
import type { FileStateCache } from './fileStateCache.js'
import type { CacheSafeParams } from './forkedAgent.js'
import { getMainLoopModel } from './model/model.js'
import { asSystemPrompt } from './systemPromptType.js'
import {
  shouldEnableThinkingByDefault,
  type ThinkingConfig,
} from './thinking.js'

/**
 * 获取构成API缓存键前缀的三个上下文片段：
 * systemPrompt parts, userContext, systemContext。
 *
 * 当设置了customSystemPrompt时，默认的getSystemPrompt构建和
 * getSystemContext会被跳过——自定义提示完全取代默认提示，并且systemContext会附加到一个未被使用的默认提示上。
 *
 * 调用者从defaultSystemPrompt（或customSystemPrompt）+ 可选附加项 + appendSystemPrompt组装最终的systemPrompt。QueryEngine在之上注入协调器userContext和记忆机制提示；
 * sideQuestion的备用方案直接使用基础结果。
 */
export async function fetchSystemPromptParts({
  tools,
  mainLoopModel,
  additionalWorkingDirectories,
  mcpClients,
  customSystemPrompt,
}: {
  tools: Tools
  mainLoopModel: string
  additionalWorkingDirectories: string[]
  mcpClients: MCPServerConnection[]
  customSystemPrompt: string | string[] | undefined
}): Promise<{
  defaultSystemPrompt: string[]
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
}> {
  const [defaultSystemPrompt, userContext, systemContext] = await Promise.all([
    customSystemPrompt !== undefined
      ? Promise.resolve([])
      : getSystemPrompt(
          tools,
          mainLoopModel,
          additionalWorkingDirectories,
          mcpClients,
        ),
    getUserContext(),
    customSystemPrompt !== undefined ? Promise.resolve({}) : getSystemContext(),
  ])
  return { defaultSystemPrompt, userContext, systemContext }
}

/**
 * 将默认系统提示词中的会话动态区段迁移为用户上下文文本。
 *
 * 边界前内容保持为可跨会话缓存的系统提示词；边界后内容和 systemContext
 * 合并到返回文本中，由调用方注入首条用户上下文消息。
 */
export function relocateDynamicSystemPromptSections(
  defaultSystemPrompt: string[],
  systemContext: { [key: string]: string },
): {
  defaultSystemPrompt: string[]
  systemContext: { [key: string]: string }
  relocatedContext: string
} {
  const boundaryIndex = defaultSystemPrompt.indexOf(
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  )
  const dynamicPromptParts =
    boundaryIndex >= 0 ? defaultSystemPrompt.slice(boundaryIndex + 1) : []
  const staticPromptParts =
    boundaryIndex >= 0
      ? defaultSystemPrompt.slice(0, boundaryIndex)
      : defaultSystemPrompt
  const relocatedContext = [
    ...dynamicPromptParts,
    Object.entries(systemContext)
      .map(([key, value]) => `# ${key}\n${value}`)
      .join('\n\n'),
  ]
    .filter(Boolean)
    .join('\n\n')
  return {
    defaultSystemPrompt: staticPromptParts,
    systemContext: {},
    relocatedContext,
  }
}

/**
 * 当getLastCacheSafeParams()为null时，从原始输入构建CacheSafeParams。
 *
 * 由SDK的side_question处理器（print.ts）在回合完成前的恢复阶段使用——此时还没有stopHooks快照。镜像QueryEngine.ts:ask()中的系统提示组装，以便重建的前缀与主循环将要发送的内容匹配，从而在常见情况下保留缓存命中。
 *
 * 如果主循环应用了此路径不知道的附加项（协调器模式、记忆机制提示），仍可能错过缓存。这是可以接受的——
 * 替代方案是返回null并完全失败该侧面问题。
 */
export async function buildSideQuestionFallbackParams({
  tools,
  commands,
  mcpClients,
  messages,
  readFileState,
  getAppState,
  setAppState,
  customSystemPrompt,
  appendSystemPrompt,
  appendSubagentSystemPrompt,
  excludeDynamicSections,
  thinkingConfig,
  agents,
}: {
  tools: Tools
  commands: Command[]
  mcpClients: MCPServerConnection[]
  messages: Message[]
  readFileState: FileStateCache
  /** 获取 get App State 对应的数据或状态。 */
  getAppState: () => AppState
  /** 设置并保存 set App State 对应的数据或状态。 */
  setAppState: (f: (prev: AppState) => AppState) => void
  customSystemPrompt: string | string[] | undefined
  appendSystemPrompt: string | undefined
  appendSubagentSystemPrompt: string | undefined
  excludeDynamicSections: boolean | undefined
  thinkingConfig: ThinkingConfig | undefined
  agents: AgentDefinition[]
}): Promise<CacheSafeParams> {
  const mainLoopModel = getMainLoopModel()
  const appState = getAppState()

  const promptParts =
    await fetchSystemPromptParts({
      tools,
      mainLoopModel,
      additionalWorkingDirectories: Array.from(
        appState.toolPermissionContext.additionalWorkingDirectories.keys(),
      ),
      mcpClients,
      customSystemPrompt,
    })

  const customPromptParts =
    typeof customSystemPrompt === 'string'
      ? [customSystemPrompt]
      : customSystemPrompt
  let defaultSystemPrompt = promptParts.defaultSystemPrompt
  let systemContext = promptParts.systemContext
  const userContext = { ...promptParts.userContext }
  if (excludeDynamicSections && customPromptParts === undefined) {
    const relocated = relocateDynamicSystemPromptSections(
      defaultSystemPrompt,
      systemContext,
    )
    defaultSystemPrompt = relocated.defaultSystemPrompt
    systemContext = relocated.systemContext
    if (relocated.relocatedContext) {
      userContext['Dynamic environment context'] = relocated.relocatedContext
    }
  }

  const systemPrompt = asSystemPrompt([
    ...(customPromptParts ?? defaultSystemPrompt),
    ...(appendSystemPrompt ? [appendSystemPrompt] : []),
  ])

  // 剥离正在进行的助手消息（stop_reason === null）——与btw.tsx相同的防护。SDK可以在回合中间触发side_question。
  const last = messages.at(-1)
  const forkContextMessages =
    last?.type === 'assistant' && last.message.stop_reason === null
      ? messages.slice(0, -1)
      : messages

  const toolUseContext: ToolUseContext = {
    options: {
      commands,
      debug: false,
      mainLoopModel,
      tools,
      verbose: false,
      thinkingConfig:
        thinkingConfig ??
        (shouldEnableThinkingByDefault() !== false
          ? { type: 'adaptive' }
          : { type: 'disabled' }),
      mcpClients,
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: agents, allAgents: [] },
      customSystemPrompt: customPromptParts?.join('\n\n'),
      appendSystemPrompt,
      appendSubagentSystemPrompt,
    },
    abortController: createAbortController(),
    readFileState,
    getAppState,
    setAppState,
    messages: forkContextMessages,
    /** 设置并保存 set In Progress Tool Use I Ds 对应的数据或状态。 */
    setInProgressToolUseIDs: () => {},
    /** 设置并保存 set Response Length 对应的数据或状态。 */
    setResponseLength: () => {},
    /** 更新 update File History State 对应的数据或状态。 */
    updateFileHistoryState: () => {},
    /** 更新 update Attribution State 对应的数据或状态。 */
    updateAttributionState: () => {},
  }

  return {
    systemPrompt,
    userContext,
    systemContext,
    toolUseContext,
    forkContextMessages,
  }
}
