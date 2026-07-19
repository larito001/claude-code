import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

type RunResult = {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

const CLI_PATH = resolve(import.meta.dir, '../src/entrypoints/cli.tsx')
const TIMEOUT_MS = 90_000

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function runCli(
  args: string[],
  cwd: string,
  env: Record<string, string | undefined>,
  timeoutMs = TIMEOUT_MS,
): Promise<RunResult> {
  const child = Bun.spawn([process.execPath, 'run', CLI_PATH, ...args], {
    cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    child.kill()
  }, timeoutMs)
  timeout.unref()

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { exitCode, stdout, stderr, timedOut }
  } finally {
    clearTimeout(timeout)
  }
}

function withoutApiCredentials(
  source: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const env = { ...source }
  for (const name of [
    'ANTHROPIC_API_KEY',
    'DEEPSEEK_API_KEY',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
  ]) {
    delete env[name]
  }
  return env
}

const tempConfig = await mkdtemp(join(tmpdir(), 'claude-api-smoke-'))
try {
  const baseEnv = {
    ...process.env,
    CLAUDE_CONFIG_DIR: tempConfig,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }
  const noCredentialEnv = withoutApiCredentials(baseEnv)

  const version = await runCli(['--version'], tempConfig, noCredentialEnv, 10_000)
  assert(version.exitCode === 0 && !version.timedOut, 'CLI version path failed')
  assert(version.stdout.includes('Claude Code'), 'CLI version output is invalid')

  const help = await runCli(['--help'], tempConfig, noCredentialEnv, 10_000)
  assert(help.exitCode === 0 && !help.timedOut, 'CLI help path failed')
  assert(help.stdout.includes('--print'), 'CLI help lost the print option')

  const missing = await runCli(
    ['--bare', '--no-session-persistence', '--settings', '{}', '-p', 'smoke'],
    tempConfig,
    noCredentialEnv,
    10_000,
  )
  assert(!missing.timedOut, 'Missing API key path hung instead of failing')
  assert(missing.exitCode !== 0, 'Missing API key path unexpectedly succeeded')
  assert(
    /No API key configured|ANTHROPIC_API_KEY/i.test(missing.stderr),
    'Missing API key error is not actionable',
  )
  assert(
    !/login|logout|subscription/i.test(missing.stderr),
    'Missing API key error still references account login',
  )

  assert(
    Boolean(baseEnv.DEEPSEEK_API_KEY || baseEnv.ANTHROPIC_API_KEY),
    'Live API smoke requires DEEPSEEK_API_KEY or ANTHROPIC_API_KEY',
  )
  const live = await runCli(
    [
      '--bare',
      '--no-session-persistence',
      '--settings',
      '{}',
      '--output-format',
      'json',
      '-p',
      'Reply with exactly CORE_API_SMOKE_OK and no other text.',
    ],
    tempConfig,
    baseEnv,
  )
  assert(!live.timedOut, 'Live API request timed out')
  assert(
    live.exitCode === 0,
    `Live API request failed (exit ${live.exitCode}): stderr=${live.stderr.trim() || '<empty>'}; stdout=${live.stdout.trim() || '<empty>'}`,
  )
  const response = JSON.parse(live.stdout) as { result?: string }
  assert(
    response.result?.trim() === 'CORE_API_SMOKE_OK',
    `Unexpected live API response: ${response.result ?? '<missing>'}`,
  )
} finally {
  await rm(tempConfig, { recursive: true, force: true })
}

console.log('live API smoke: ok')
