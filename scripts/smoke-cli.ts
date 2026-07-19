import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { StructuredIO } from '../src/cli/structuredIO.js'
import { ndjsonSafeStringify } from '../src/cli/ndjsonSafeStringify.js'
import {
  SDKControlInitializeRequestSchema,
  SDKUpdateEnvironmentVariablesMessageSchema,
} from '../src/entrypoints/sdk/controlSchemas.js'

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
    pluginHelp.stdout.includes('marketplace'),
    '用于自建扩展源的通用 Marketplace 命令缺失',
  )
} finally {
  await rm(temporaryConfig, { recursive: true, force: true })
}

console.log('CLI、结构化 I/O 与子命令冒烟测试：通过')
