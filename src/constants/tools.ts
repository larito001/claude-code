import { feature } from 'src/utils/features.js'
import { TASK_OUTPUT_TOOL_NAME } from '../tools/TaskOutputTool/constants.js'
import { EXIT_PLAN_MODE_V2_TOOL_NAME } from '../tools/ExitPlanModeTool/constants.js'
import { ENTER_PLAN_MODE_TOOL_NAME } from '../tools/EnterPlanModeTool/constants.js'
import { AGENT_TOOL_NAME } from '../tools/AgentTool/constants.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../tools/AskUserQuestionTool/prompt.js'
import { TASK_STOP_TOOL_NAME } from '../tools/TaskStopTool/prompt.js'
import { FILE_READ_TOOL_NAME } from '../tools/FileReadTool/prompt.js'
import { GREP_TOOL_NAME } from '../tools/GrepTool/prompt.js'
import { WEB_FETCH_TOOL_NAME } from '../tools/WebFetchTool/prompt.js'
import { GLOB_TOOL_NAME } from '../tools/GlobTool/prompt.js'
import { SHELL_TOOL_NAMES } from '../utils/shell/shellToolUtils.js'
import { FILE_EDIT_TOOL_NAME } from '../tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../tools/FileWriteTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../tools/NotebookEditTool/constants.js'
import { SKILL_TOOL_NAME } from '../tools/SkillTool/constants.js'
import { SEND_MESSAGE_TOOL_NAME } from '../tools/SendMessageTool/constants.js'
import { TASK_CREATE_TOOL_NAME } from '../tools/TaskCreateTool/constants.js'
import { TASK_GET_TOOL_NAME } from '../tools/TaskGetTool/constants.js'
import { TASK_LIST_TOOL_NAME } from '../tools/TaskListTool/constants.js'
import { TASK_UPDATE_TOOL_NAME } from '../tools/TaskUpdateTool/constants.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '../tools/SyntheticOutputTool/SyntheticOutputTool.js'
import { ENTER_WORKTREE_TOOL_NAME } from '../tools/EnterWorktreeTool/constants.js'
import { EXIT_WORKTREE_TOOL_NAME } from '../tools/ExitWorktreeTool/constants.js'
import {
  CRON_CREATE_TOOL_NAME,
  CRON_DELETE_TOOL_NAME,
  CRON_LIST_TOOL_NAME,
} from '../tools/ScheduleCronTool/prompt.js'

export const ALL_AGENT_DISALLOWED_TOOLS = new Set([
  TASK_OUTPUT_TOOL_NAME,
  EXIT_PLAN_MODE_V2_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  // 阻止对普通异步子代理的递归 Agent 调用。
  AGENT_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
  // 防止子代理内部的递归工作流执行。
])

export const CUSTOM_AGENT_DISALLOWED_TOOLS = new Set([
  ...ALL_AGENT_DISALLOWED_TOOLS,
])

/* 异步代理工具可用性状态（事实来源） */
export const ASYNC_AGENT_ALLOWED_TOOLS = new Set([
  FILE_READ_TOOL_NAME,
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  GREP_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  GLOB_TOOL_NAME,
  ...SHELL_TOOL_NAMES,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  SKILL_TOOL_NAME,
  SYNTHETIC_OUTPUT_TOOL_NAME,
  ENTER_WORKTREE_TOOL_NAME,
  EXIT_WORKTREE_TOOL_NAME,
])
/**
 * 工具仅允许进程内队友使用（非通用异步代理）。
 * 它们由 inProcessRunner.ts 注入，并通过 filterToolsForAgent
 * 经由 isInProcessTeammate() 检查来允许。
 */
export const IN_PROCESS_TEAMMATE_ALLOWED_TOOLS = new Set([
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  // 队友创建的 cron 被标记为创建者 agentId，并路由到
  // 该队友的 pendingUserMessages 队列（参见 useScheduledTasks.ts）。
  ...(feature('AGENT_TRIGGERS')
    ? [CRON_CREATE_TOOL_NAME, CRON_DELETE_TOOL_NAME, CRON_LIST_TOOL_NAME]
    : []),
])

/*
 * 对异步代理已阻止：
 * - AgentTool：已阻止以防止递归
 * - TaskOutputTool：已阻止以防止递归
 * - ExitPlanModeTool：计划模式是主线程抽象。
 * - TaskStopTool：需要访问主线程任务状态。
 *
 * 稍后启用（需要工作）：
 * - MCPTool：待定
 * - ListMcpResourcesTool：待定
 * - ReadMcpResourceTool：待定
 */

/** 协调器模式下允许的工具 - 仅协调器的输出和代理管理工具 */
export const COORDINATOR_MODE_ALLOWED_TOOLS = new Set([
  AGENT_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  SYNTHETIC_OUTPUT_TOOL_NAME,
])
