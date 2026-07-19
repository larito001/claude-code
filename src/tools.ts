import { type Tool, type Tools } from './Tool.js'
import { AgentTool } from './tools/AgentTool/AgentTool.js'
import { SkillTool } from './tools/SkillTool/SkillTool.js'
import { BashTool } from './tools/BashTool/BashTool.js'
import { FileEditTool } from './tools/FileEditTool/FileEditTool.js'
import { FileReadTool } from './tools/FileReadTool/FileReadTool.js'
import { FileWriteTool } from './tools/FileWriteTool/FileWriteTool.js'
import { GlobTool } from './tools/GlobTool/GlobTool.js'
import { NotebookEditTool } from './tools/NotebookEditTool/NotebookEditTool.js'
import { WebFetchTool } from './tools/WebFetchTool/WebFetchTool.js'
import { TaskStopTool } from './tools/TaskStopTool/TaskStopTool.js'
import { SleepTool } from './tools/SleepTool/SleepTool.js'
// 仅在可选功能启用时加载计划任务工具。
/* eslint-disable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
const cronTools = feature('AGENT_TRIGGERS')
  ? [
      require('./tools/ScheduleCronTool/CronCreateTool.js').CronCreateTool,
      require('./tools/ScheduleCronTool/CronDeleteTool.js').CronDeleteTool,
      require('./tools/ScheduleCronTool/CronListTool.js').CronListTool,
    ]
  : []
/* eslint-enable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
import { TaskOutputTool } from './tools/TaskOutputTool/TaskOutputTool.js'
import { WebSearchTool } from './tools/WebSearchTool/WebSearchTool.js'
import { TodoWriteTool } from './tools/TodoWriteTool/TodoWriteTool.js'
import { ExitPlanModeV2Tool } from './tools/ExitPlanModeTool/ExitPlanModeV2Tool.js'
import { TestingPermissionTool } from './tools/testing/TestingPermissionTool.js'
import { GrepTool } from './tools/GrepTool/GrepTool.js'
// 延迟 require 以打破循环依赖：tools.ts -> TeamCreateTool/TeamDeleteTool -> ... -> tools.ts
/* eslint-disable @typescript-eslint/no-require-imports */
/** 获取 get Team Create Tool 对应的数据或状态。 */
const getTeamCreateTool = () =>
  require('./tools/TeamCreateTool/TeamCreateTool.js')
    .TeamCreateTool as typeof import('./tools/TeamCreateTool/TeamCreateTool.js').TeamCreateTool
/** 获取 get Team Delete Tool 对应的数据或状态。 */
const getTeamDeleteTool = () =>
  require('./tools/TeamDeleteTool/TeamDeleteTool.js')
    .TeamDeleteTool as typeof import('./tools/TeamDeleteTool/TeamDeleteTool.js').TeamDeleteTool
/** 获取 get Send Message Tool 对应的数据或状态。 */
const getSendMessageTool = () =>
  require('./tools/SendMessageTool/SendMessageTool.js')
    .SendMessageTool as typeof import('./tools/SendMessageTool/SendMessageTool.js').SendMessageTool
/* eslint-enable @typescript-eslint/no-require-imports */
import { AskUserQuestionTool } from './tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { LSPTool } from './tools/LSPTool/LSPTool.js'
import { ListMcpResourcesTool } from './tools/ListMcpResourcesTool/ListMcpResourcesTool.js'
import { ReadMcpResourceTool } from './tools/ReadMcpResourceTool/ReadMcpResourceTool.js'
import { ToolSearchTool } from './tools/ToolSearchTool/ToolSearchTool.js'
import { EnterPlanModeTool } from './tools/EnterPlanModeTool/EnterPlanModeTool.js'
import { EnterWorktreeTool } from './tools/EnterWorktreeTool/EnterWorktreeTool.js'
import { ExitWorktreeTool } from './tools/ExitWorktreeTool/ExitWorktreeTool.js'
import { ConfigTool } from './tools/ConfigTool/ConfigTool.js'
import { TaskCreateTool } from './tools/TaskCreateTool/TaskCreateTool.js'
import { TaskGetTool } from './tools/TaskGetTool/TaskGetTool.js'
import { TaskUpdateTool } from './tools/TaskUpdateTool/TaskUpdateTool.js'
import { TaskListTool } from './tools/TaskListTool/TaskListTool.js'
import uniqBy from 'lodash-es/uniqBy.js'
import { isToolSearchEnabledOptimistic } from './utils/toolSearch.js'
import { isTodoV2Enabled } from './utils/tasks.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from './tools/SyntheticOutputTool/SyntheticOutputTool.js'
export {
  ALL_AGENT_DISALLOWED_TOOLS,
  CUSTOM_AGENT_DISALLOWED_TOOLS,
  ASYNC_AGENT_ALLOWED_TOOLS,
  COORDINATOR_MODE_ALLOWED_TOOLS,
} from './constants/tools.js'
import { feature } from 'src/utils/features.js'
import type { ToolPermissionContext } from './Tool.js'
import { getDenyRuleForTool } from './utils/permissions/permissions.js'
import { hasEmbeddedSearchTools } from './utils/embeddedTools.js'
import { isEnvTruthy } from './utils/envUtils.js'
import { isPowerShellToolEnabled } from './utils/shell/shellToolUtils.js'
import { isAgentSwarmsEnabled } from './utils/agentSwarmsEnabled.js'
import { isWorktreeModeEnabled } from './utils/worktreeModeEnabled.js'
/* eslint-disable @typescript-eslint/no-require-imports */
/** 获取 get Power Shell Tool 对应的数据或状态。 */
const getPowerShellTool = () => {
  if (!isPowerShellToolEnabled()) return null
  return (
    require('./tools/PowerShellTool/PowerShellTool.js') as typeof import('./tools/PowerShellTool/PowerShellTool.js')
  ).PowerShellTool
}
/* eslint-enable @typescript-eslint/no-require-imports */

/** 可与 --tools 标志一起使用的预定义工具预设 */
export const TOOL_PRESETS = ['default'] as const

export type ToolPreset = (typeof TOOL_PRESETS)[number]

/** 解析 parse Tool Preset 对应的数据或状态。 */
export function parseToolPreset(preset: string): ToolPreset | null {
  const presetString = preset.toLowerCase()
  if (!TOOL_PRESETS.includes(presetString as ToolPreset)) {
    return null
  }
  return presetString as ToolPreset
}

/**
 * 获取给定预设的工具名称列表
 * 过滤掉通过 isEnabled() 检查禁用的工具
 * @param preset 预设名称
 * @returns 工具名称数组
 */
export function getToolsForDefaultPreset(): string[] {
  const tools = getAllBaseTools()
  /** 判断是否满足 is Enabled 对应的数据或状态。 */
  const isEnabled = tools.map(tool => tool.isEnabled())
  return tools.filter((_, i) => isEnabled[i]).map(tool => tool.name)
}

/**
 * 获取当前环境中可能可用的所有工具的完整详尽列表（尊重 process.env 标志）。
 * 这是所有工具的单一事实来源。
 */
/**
 * 注意：这必须与 https://console.feature configuration.com/4aF3Ewatb6xPVpCwxb5nA3/dynamic_configs/claude_code_global_system_caching 保持同步，以便跨用户缓存系统提示。
 */
export function getAllBaseTools(): Tools {
  return [
    AgentTool,
    TaskOutputTool,
    BashTool,
    // 嵌入式搜索版本在运行时中捆绑了 bfs/ugrep（与 ripgrep 相同的 ARGV0 技巧）。当可用时，Claude shell 中的 find/grep 被别名为这些快速工具，因此专用的 Glob/Grep 工具是不必要的。
    ...(hasEmbeddedSearchTools() ? [] : [GlobTool, GrepTool]),
    ExitPlanModeV2Tool,
    FileReadTool,
    FileEditTool,
    FileWriteTool,
    NotebookEditTool,
    WebFetchTool,
    TodoWriteTool,
    WebSearchTool,
    TaskStopTool,
    SleepTool,
    AskUserQuestionTool,
    SkillTool,
    EnterPlanModeTool,
    ConfigTool,
    ...(isTodoV2Enabled()
      ? [TaskCreateTool, TaskGetTool, TaskUpdateTool, TaskListTool]
      : []),
    ...(isEnvTruthy(process.env.ENABLE_LSP_TOOL) ? [LSPTool] : []),
    ...(isWorktreeModeEnabled() ? [EnterWorktreeTool, ExitWorktreeTool] : []),
    getSendMessageTool(),
    ...(isAgentSwarmsEnabled()
      ? [getTeamCreateTool(), getTeamDeleteTool()]
      : []),
    ...cronTools,
    ...(getPowerShellTool() ? [getPowerShellTool()] : []),
    ...(process.env.NODE_ENV === 'test' ? [TestingPermissionTool] : []),
    ListMcpResourcesTool,
    ReadMcpResourceTool,
    // 当可能启用工具搜索时包含 ToolSearchTool（乐观检查）
    // 实际延迟工具的决定发生在 claude.ts 中的请求时
    ...(isToolSearchEnabledOptimistic() ? [ToolSearchTool] : []),
  ]
}

/**
 * 过滤掉被权限上下文全面拒绝的工具。
 * 如果存在匹配其名称且没有 ruleContent 的拒绝规则（即对该工具的全面拒绝），则该工具被过滤掉。
 *
 * 使用与运行时权限检查相同的匹配器（步骤 1a），因此像 `mcp__server` 这样的 MCP 服务器前缀规则会在模型看到它们之前从该服务器剥离所有工具——而不仅仅是在调用时。
 */
export function filterToolsByDenyRules<
  T extends {
    name: string
    mcpInfo?: { serverName: string; toolName: string }
  },
>(tools: readonly T[], permissionContext: ToolPermissionContext): T[] {
  return tools.filter(tool => !getDenyRuleForTool(permissionContext, tool))
}

/** 获取 get Tools 对应的数据或状态。 */
export const getTools = (permissionContext: ToolPermissionContext): Tools => {
  // 简单模式：仅 Bash、Read 和 Edit 工具
  if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
    const simpleTools: Tool[] = [BashTool, FileReadTool, FileEditTool]
    return filterToolsByDenyRules(simpleTools, permissionContext)
  }

  // 获取所有基础工具，并过滤掉那些有条件添加的特殊工具
  const specialTools = new Set([
    ListMcpResourcesTool.name,
    ReadMcpResourceTool.name,
    SYNTHETIC_OUTPUT_TOOL_NAME,
  ])

  /** 转换 tools 对应的数据或状态。 */
  const tools = getAllBaseTools().filter(tool => !specialTools.has(tool.name))

  // 过滤掉被拒绝规则拒绝的工具
  const allowedTools = filterToolsByDenyRules(tools, permissionContext)

  /** 判断是否满足 is Enabled 对应的数据或状态。 */
  const isEnabled = allowedTools.map(_ => _.isEnabled())
  return allowedTools.filter((_, i) => isEnabled[i])
}

/**
 * 为给定的权限上下文和 MCP 工具组装完整工具池。
 *
 * 这是组合内置工具和 MCP 工具的单一事实来源。
 * REPL.tsx（通过 useMergedTools hook）和 runAgent.ts（用于协调器工作进程）都使用此函数以确保一致的工具池组装。
 *
 * 该函数：
 * 1. 通过 getTools() 获取内置工具（尊重模式过滤）
 * 2. 按拒绝规则过滤 MCP 工具
 * 3. 按工具名称去重（内置工具优先）
 *
 * @param permissionContext - 用于过滤内置工具的权限上下文
 * @param mcpTools - 来自 appState.mcp.tools 的 MCP 工具
 * @returns 内置和 MCP 工具的组合、去重数组
 */
export function assembleToolPool(
  permissionContext: ToolPermissionContext,
  mcpTools: Tools,
): Tools {
  const builtInTools = getTools(permissionContext)

  // 过滤掉拒绝列表中的 MCP 工具
  const allowedMcpTools = filterToolsByDenyRules(mcpTools, permissionContext)

  // 对每个分区进行排序以保证提示缓存稳定性，将内置工具保持为连续前缀。服务器的 claude_code_system_cache_policy 在最后一个前缀匹配的内置工具之后放置了一个全局缓存断点；平面排序会将 MCP 工具插入到内置工具中，并且每当 MCP 工具在现有内置工具之间排序时，会使所有下游缓存键失效。uniqBy 保留插入顺序，因此内置工具在名称冲突时获胜。
  // 避免使用 Array.toSorted（Node 20+）——我们支持 Node 18。builtInTools 是只读的，因此先复制再排序；allowedMcpTools 是新的 .filter() 结果。
  const byName = (a: Tool, b: Tool) => a.name.localeCompare(b.name)
  return uniqBy(
    [...builtInTools].sort(byName).concat(allowedMcpTools.sort(byName)),
    'name',
  )
}

/**
 * 获取所有工具，包括内置工具和 MCP 工具。
 *
 * 当您需要完整工具列表时，这是首选函数，用于：
 * - 工具搜索阈值计算（isToolSearchEnabled）
 * - 包含 MCP 工具的令牌计数
 * - 任何应考虑 MCP 工具的上下文
 *
 * 仅当您特别需要仅内置工具时才使用 getTools()。
 *
 * @param permissionContext - 用于过滤内置工具的权限上下文
 * @param mcpTools - 来自 appState.mcp.tools 的 MCP 工具
 * @returns 内置和 MCP 工具的组合数组
 */
export function getMergedTools(
  permissionContext: ToolPermissionContext,
  mcpTools: Tools,
): Tools {
  const builtInTools = getTools(permissionContext)
  return [...builtInTools, ...mcpTools]
}
