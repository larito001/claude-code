import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { StructuredIO } from '../src/cli/structuredIO.js'
import { ndjsonSafeStringify } from '../src/cli/ndjsonSafeStringify.js'
import {
  SDKControlInitializeRequestSchema,
  SDKControlRequestSchema,
  SDKUpdateEnvironmentVariablesMessageSchema,
  StdoutMessageSchema,
} from '../src/entrypoints/sdk/controlSchemas.js'
import { ApiKeySourceSchema } from '../src/entrypoints/sdk/coreSchemas.js'
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../src/constants/prompts.js'
import { toSdkApiKeySource } from '../src/utils/messages/systemInit.js'
import { relocateDynamicSystemPromptSections } from '../src/utils/queryContext.js'

type RunResult = {
  exitCode: number
  stdout: string
  stderr: string
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function runCli(args: string[], cwd: string): Promise<RunResult> {
  const cliPath = resolve(import.meta.dir, '../src/entrypoints/cli.tsx')
  const environment = { ...process.env }
  delete environment.ANTHROPIC_API_KEY
  delete environment.DEEPSEEK_API_KEY
  const child = Bun.spawn([process.execPath, 'run', cliPath, ...args], {
    cwd,
    env: environment,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { exitCode, stdout, stderr }
}

const encoded = ndjsonSafeStringify({ text: `left\u2028middle\u2029right` })
assert(!encoded.includes('\u2028'), 'NDJSON 输出仍包含原始 U+2028 行终止符')
assert(!encoded.includes('\u2029'), 'NDJSON 输出仍包含原始 U+2029 行终止符')
assert(
  JSON.parse(encoded).text === `left\u2028middle\u2029right`,
  'NDJSON 行终止符转义改变了 JSON 内容',
)

assert(
  !SDKControlInitializeRequestSchema().safeParse({
    subtype: 'initialize',
    hooks: { PreToolUse: [{ hookCallbackIds: [1] }] },
  }).success,
  '初始化控制协议接受了非字符串 Hook 回调 ID',
)
assert(
  SDKControlInitializeRequestSchema().safeParse({
    subtype: 'initialize',
    systemPrompt: ['静态提示段', '动态提示段'],
    excludeDynamicSections: true,
    title: '协议测试',
  }).success,
  '初始化控制协议拒绝了 Agent SDK 的分段系统提示',
)
assert(
  !SDKControlInitializeRequestSchema().safeParse({
    subtype: 'initialize',
    systemPrompt: '未分段的旧形状',
  }).success,
  '初始化控制协议仍接受已淘汰的单字符串系统提示形状',
)
assert(
  !SDKUpdateEnvironmentVariablesMessageSchema().safeParse({
    type: 'update_environment_variables',
    variables: { INVALID: { nested: true } },
  }).success,
  '环境变量控制协议接受了非字符串值',
)

const retainedControlRequests = [
  { subtype: 'end_session', reason: 'host_closed' },
  { subtype: 'channel_enable', serverName: 'channel-server' },
  { subtype: 'mcp_authenticate', serverName: 'oauth-server' },
  {
    subtype: 'mcp_oauth_callback_url',
    serverName: 'oauth-server',
    callbackUrl: 'http://127.0.0.1/callback?code=test',
  },
  { subtype: 'mcp_clear_auth', serverName: 'oauth-server' },
  {
    subtype: 'generate_session_title',
    description: '一次完整会话',
    persist: true,
  },
  { subtype: 'side_question', question: '当前进度是什么？' },
]
for (const [index, request] of retainedControlRequests.entries()) {
  assert(
    SDKControlRequestSchema().safeParse({
      type: 'control_request',
      request_id: `retained-${index}`,
      request,
    }).success,
    `仍由 CLI 处理的控制请求未纳入协议 Schema: ${request.subtype}`,
  )
}
assert(
  !SDKControlRequestSchema().safeParse({
    type: 'control_request',
    request_id: 'removed-login',
    request: { subtype: 'claude_authenticate' },
  }).success,
  '已删除的 Claude 账号登录请求仍被控制协议接受',
)
assert(
  !ApiKeySourceSchema().safeParse('oauth').success,
  'SDK 系统消息仍接受已删除的 Claude OAuth 登录来源',
)
assert(
  StdoutMessageSchema().safeParse({
    type: 'system',
    subtype: 'notification',
    key: 'build-finished',
    text: '构建完成',
    priority: 'medium',
    uuid: randomUUID(),
    session_id: 'protocol-smoke',
  }).success,
  'SDK 标准输出协议拒绝了保留的通知消息',
)
assert(
  !StdoutMessageSchema().safeParse({ arbitrary: true }).success,
  'SDK 标准输出协议仍允许任意未验证数据',
)
assert(
  !StdoutMessageSchema().safeParse({
    type: 'rate_limit_event',
    rate_limit_info: { status: 'allowed' },
    uuid: randomUUID(),
    session_id: 'protocol-smoke',
  }).success,
  '已移除的 Claude 订阅限流事件仍能通过输出协议',
)
assert(
  toSdkApiKeySource('ANTHROPIC_API_KEY') === 'temporary' &&
    toSdkApiKeySource('none') === 'temporary',
  '环境变量或云提供商认证未映射为临时 API 凭据来源',
)

const relocatedPrompt = relocateDynamicSystemPromptSections(
  ['静态提示段', SYSTEM_PROMPT_DYNAMIC_BOUNDARY, '动态提示段'],
  { '工作目录': 'C:\\workspace' },
)
assert(
  relocatedPrompt.defaultSystemPrompt.length === 1 &&
    relocatedPrompt.defaultSystemPrompt[0] === '静态提示段',
  '动态提示迁移破坏了可缓存的静态系统提示',
)
assert(
  Object.keys(relocatedPrompt.systemContext).length === 0 &&
    relocatedPrompt.relocatedContext.includes('动态提示段') &&
    relocatedPrompt.relocatedContext.includes('# 工作目录\nC:\\workspace'),
  '动态系统提示或环境上下文在迁移时丢失',
)
const promptWithoutBoundary = relocateDynamicSystemPromptSections(
  ['完整的静态提示'],
  {},
)
assert(
  promptWithoutBoundary.defaultSystemPrompt[0] === '完整的静态提示' &&
    promptWithoutBoundary.relocatedContext === '',
  '无动态边界的提示被错误截断',
)

const environmentVariableName = 'CLI_SMOKE_DYNAMIC_ENV'
delete process.env[environmentVariableName]
async function* environmentInput(): AsyncGenerator<string> {
  yield `${JSON.stringify({
    type: 'update_environment_variables',
    variables: { [environmentVariableName]: 'applied' },
  })}\n`
}
const structuredIO = new StructuredIO(environmentInput())
for await (const _message of structuredIO.structuredInput) {
  throw new Error('环境变量控制消息不应进入用户消息流')
}
assert(
  process.env[environmentVariableName] === 'applied',
  '结构化 I/O 未应用经过校验的环境变量更新',
)
delete process.env[environmentVariableName]

const temporaryConfig = await mkdtemp(join(tmpdir(), 'core-cli-smoke-'))
try {
  const mcpHelp = await runCli(['mcp', '--help'], temporaryConfig)
  assert(mcpHelp.exitCode === 0, `MCP 帮助命令失败：${mcpHelp.stderr}`)
  assert(mcpHelp.stdout.includes('add-json'), 'MCP 核心 add-json 命令缺失')
  assert(
    !mcpHelp.stdout.includes('add-from-claude-desktop'),
    '已删除的 Claude Desktop 导入命令仍出现在帮助中',
  )

  const pluginHelp = await runCli(['plugin', '--help'], temporaryConfig)
  assert(pluginHelp.exitCode === 0, `插件帮助命令失败：${pluginHelp.stderr}`)
  assert(
    pluginHelp.stdout.includes('validate') &&
      !pluginHelp.stdout.includes('install') &&
      !pluginHelp.stdout.includes('update'),
    '本地插件命令范围不正确',
  )

  const validPlugin = join(temporaryConfig, 'valid-plugin')
  await mkdir(join(validPlugin, '.claude-plugin'), { recursive: true })
  await writeFile(
    join(validPlugin, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'valid-local-plugin', commands: './commands' }),
  )
  await mkdir(join(validPlugin, 'commands'))
  const validResult = await runCli(
    ['plugin', 'validate', validPlugin],
    temporaryConfig,
  )
  assert(
    validResult.exitCode === 0 &&
      validResult.stdout.includes('Validation passed'),
    `本地插件校验失败：${validResult.stderr}`,
  )

  const invalidPlugin = join(temporaryConfig, 'invalid-plugin')
  await mkdir(join(invalidPlugin, '.claude-plugin'), { recursive: true })
  await writeFile(
    join(invalidPlugin, '.claude-plugin', 'plugin.json'),
    JSON.stringify({
      name: 'invalid-local-plugin',
      commands: './../outside-plugin-root',
    }),
  )
  const invalidResult = await runCli(
    ['plugin', 'validate', invalidPlugin],
    temporaryConfig,
  )
  assert(
    invalidResult.exitCode === 1,
    '本地插件校验接受了越界组件路径',
  )
} finally {
  await rm(temporaryConfig, { recursive: true, force: true })
}

console.log('CLI、结构化 I/O 与子命令冒烟测试：通过')
