// 用于标记消息中技能/命令元数据的XML标签名
export const COMMAND_NAME_TAG = 'command-name'
export const COMMAND_MESSAGE_TAG = 'command-message'
export const COMMAND_ARGS_TAG = 'command-args'

// 用户消息中终端/bash命令输入和输出的XML标签名
// 这些包裹代表终端活动的内容，而非实际用户提示
export const BASH_INPUT_TAG = 'bash-input'
export const BASH_STDOUT_TAG = 'bash-stdout'
export const BASH_STDERR_TAG = 'bash-stderr'
export const LOCAL_COMMAND_STDOUT_TAG = 'local-command-stdout'
export const LOCAL_COMMAND_STDERR_TAG = 'local-command-stderr'
export const LOCAL_COMMAND_CAVEAT_TAG = 'local-command-caveat'

// 所有指示消息为终端输出而非用户提示的终端相关标签
export const TERMINAL_OUTPUT_TAGS = [
  BASH_INPUT_TAG,
  BASH_STDOUT_TAG,
  BASH_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_CAVEAT_TAG,
] as const

export const TICK_TAG = 'tick'

// 任务通知（后台任务完成）的XML标签名
export const TASK_NOTIFICATION_TAG = 'task-notification'
export const TASK_ID_TAG = 'task-id'
export const TOOL_USE_ID_TAG = 'tool-use-id'
export const TASK_TYPE_TAG = 'task-type'
export const OUTPUT_FILE_TAG = 'output-file'
export const STATUS_TAG = 'status'
export const SUMMARY_TAG = 'summary'
export const REASON_TAG = 'reason'
export const WORKTREE_TAG = 'worktree'
export const WORKTREE_PATH_TAG = 'worktreePath'
export const WORKTREE_BRANCH_TAG = 'worktreeBranch'

// 队友消息（群体智能体间通信）的XML标签名
export const TEAMMATE_MESSAGE_TAG = 'teammate-message'

// 外部频道消息的XML标签名
export const CHANNEL_MESSAGE_TAG = 'channel-message'
export const CHANNEL_TAG = 'channel'

// 跨会话UDS消息（另一个Claude会话的收件箱）的XML标签名
export const CROSS_SESSION_MESSAGE_TAG = 'cross-session-message'

// 在fork子进程的第一条消息中包裹规则/格式模板的XML标签。
// 允许转录渲染器折叠模板并仅显示指令。
export const FORK_BOILERPLATE_TAG = 'fork-boilerplate'
// 指令文本前的前缀，由渲染器去除。在buildChildMessage（生成）和UserForkBoilerplateMessage（解析）之间保持同步。
export const FORK_DIRECTIVE_PREFIX = 'Your directive: '

// 请求帮助的斜杠命令的常见参数模式
export const COMMON_HELP_ARGS = ['help', '-h', '--help']

// 请求当前状态/信息的斜杠命令的常见参数模式
export const COMMON_INFO_ARGS = [
  'list',
  'show',
  'display',
  'current',
  'view',
  'get',
  'check',
  'describe',
  'print',
  'version',
  'about',
  'status',
  '?',
]
