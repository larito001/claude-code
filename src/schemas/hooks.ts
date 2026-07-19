/**
 * 提取Hook Zod模式以打破导入循环。
 *
 * 此文件包含与hook相关的模式定义，这些定义最初位于src/utils/settings/types.ts中。通过将它们提取到这里，我们打破了settings/types.ts和plugins/schemas.ts之间的循环依赖。
 *
 * 两个文件现在都从此共享位置导入，而不是相互导入。
 */

import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import { HOOK_EVENTS } from 'src/entrypoints/sdk/coreTypes.js'
import { z } from 'zod/v4'
import { lazySchema } from '../utils/lazySchema.js'
import { SHELL_TYPES } from '../utils/shell/shellProvider.js'

// `if`条件字段的共享模式。
// 使用权限规则语法（例如"Bash(git *)", "Read(*.ts)"）在生成前过滤hook。
// 根据hook输入的tool_name和tool_input进行评估。
const IfConditionSchema = lazySchema(() =>
  z
    .string()
    .optional()
    .describe(
      'Permission rule syntax to filter when this hook runs (e.g., "Bash(git *)"). ' +
        'Only runs if the tool call matches the pattern. Avoids spawning hooks for non-matching commands.',
    ),
)

// 单个hook模式的内部工厂（在导出的判别联合成员和HookCommandSchema工厂之间共享）
function buildHookSchemas() {
  const BashCommandHookSchema = z.object({
    type: z.literal('command').describe('Shell command hook type'),
    command: z.string().describe('Shell command to execute'),
    if: IfConditionSchema(),
    shell: z
      .enum(SHELL_TYPES)
      .optional()
      .describe(
        "Shell interpreter. 'bash' uses your $SHELL (bash/zsh/sh); 'powershell' uses pwsh. Defaults to bash.",
      ),
    timeout: z
      .number()
      .positive()
      .optional()
      .describe('Timeout in seconds for this specific command'),
    statusMessage: z
      .string()
      .optional()
      .describe('Custom status message to display in spinner while hook runs'),
    once: z
      .boolean()
      .optional()
      .describe('If true, hook runs once and is removed after execution'),
    async: z
      .boolean()
      .optional()
      .describe('If true, hook runs in background without blocking'),
    asyncRewake: z
      .boolean()
      .optional()
      .describe(
        'If true, hook runs in background and wakes the model on exit code 2 (blocking error). Implies async.',
      ),
  })

  const PromptHookSchema = z.object({
    type: z.literal('prompt').describe('LLM prompt hook type'),
    prompt: z
      .string()
      .describe(
        'Prompt to evaluate with LLM. Use $ARGUMENTS placeholder for hook input JSON.',
      ),
    if: IfConditionSchema(),
    timeout: z
      .number()
      .positive()
      .optional()
      .describe('Timeout in seconds for this specific prompt evaluation'),
    // @[MODEL LAUNCH]: 更新下方.describe()字符串中的示例模型ID（prompt + agent hooks）。
    model: z
      .string()
      .optional()
      .describe(
        'Model to use for this prompt hook (e.g., "claude-sonnet-4-6"). If not specified, uses the default small fast model.',
      ),
    statusMessage: z
      .string()
      .optional()
      .describe('Custom status message to display in spinner while hook runs'),
    once: z
      .boolean()
      .optional()
      .describe('If true, hook runs once and is removed after execution'),
  })

  const HttpHookSchema = z.object({
    type: z.literal('http').describe('HTTP hook type'),
    url: z.string().url().describe('URL to POST the hook input JSON to'),
    if: IfConditionSchema(),
    timeout: z
      .number()
      .positive()
      .optional()
      .describe('Timeout in seconds for this specific request'),
    headers: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Additional headers to include in the request. Values may reference environment variables using $VAR_NAME or ${VAR_NAME} syntax (e.g., "Authorization": "Bearer $MY_TOKEN"). Only variables listed in allowedEnvVars will be interpolated.',
      ),
    allowedEnvVars: z
      .array(z.string())
      .optional()
      .describe(
        'Explicit list of environment variable names that may be interpolated in header values. Only variables listed here will be resolved; all other $VAR references are left as empty strings. Required for env var interpolation to work.',
      ),
    statusMessage: z
      .string()
      .optional()
      .describe('Custom status message to display in spinner while hook runs'),
    once: z
      .boolean()
      .optional()
      .describe('If true, hook runs once and is removed after execution'),
  })

  const AgentHookSchema = z.object({
    type: z.literal('agent').describe('Agentic verifier hook type'),
    // 此处不要添加.transform()。此模式由parseSettingsFile使用，
    // 而updateSettingsForSource会通过JSON.stringify对解析结果进行往返处理——转换后的函数值会被静默丢弃，
    // 从而从settings.json中删除用户的prompt（gh-24920, CC-79）。
    // 该.transform（来自#10594）将字符串包装在`(_msgs) => prompt`中，
    // 用于旧的程序化构造路径。Agent hooks现在在整个解析和持久化过程中保持为声明式设置对象。
    prompt: z
      .string()
      .describe(
        'Prompt describing what to verify (e.g. "Verify that unit tests ran and passed."). Use $ARGUMENTS placeholder for hook input JSON.',
      ),
    if: IfConditionSchema(),
    timeout: z
      .number()
      .positive()
      .optional()
      .describe('Timeout in seconds for agent execution (default 60)'),
    model: z
      .string()
      .optional()
      .describe(
        'Model to use for this agent hook (e.g., "claude-sonnet-4-6"). If not specified, uses Haiku.',
      ),
    statusMessage: z
      .string()
      .optional()
      .describe('Custom status message to display in spinner while hook runs'),
    once: z
      .boolean()
      .optional()
      .describe('If true, hook runs once and is removed after execution'),
  })

  return {
    BashCommandHookSchema,
    PromptHookSchema,
    HttpHookSchema,
    AgentHookSchema,
  }
}

/** hook命令的模式（排除函数hook——它们无法持久化） */
export const HookCommandSchema = lazySchema(() => {
  const {
    BashCommandHookSchema,
    PromptHookSchema,
    AgentHookSchema,
    HttpHookSchema,
  } = buildHookSchemas()
  return z.discriminatedUnion('type', [
    BashCommandHookSchema,
    PromptHookSchema,
    AgentHookSchema,
    HttpHookSchema,
  ])
})

/** 具有多个hook的匹配器配置的模式 */
export const HookMatcherSchema = lazySchema(() =>
  z.object({
    matcher: z
      .string()
      .optional()
      .describe('String pattern to match (e.g. tool names like "Write")'), // 字符串（例如Write）用于匹配与hook事件相关的值，例如工具名称
    hooks: z
      .array(HookCommandSchema())
      .describe('List of hooks to execute when the matcher matches'),
  }),
)

/**
 * hook配置的模式
 * 键是hook事件。值是一个匹配器配置数组。
 * 使用partialRecord，因为并非所有hook事件都需要定义。
 */
export const HooksSchema = lazySchema(() =>
  z.partialRecord(z.enum(HOOK_EVENTS), z.array(HookMatcherSchema())),
)

// 从模式推断的类型
export type HookCommand = z.infer<ReturnType<typeof HookCommandSchema>>
export type BashCommandHook = Extract<HookCommand, { type: 'command' }>
export type PromptHook = Extract<HookCommand, { type: 'prompt' }>
export type AgentHook = Extract<HookCommand, { type: 'agent' }>
export type HttpHook = Extract<HookCommand, { type: 'http' }>
export type HookMatcher = z.infer<ReturnType<typeof HookMatcherSchema>>
export type HooksSettings = Partial<Record<HookEvent, HookMatcher[]>>
