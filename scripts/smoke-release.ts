import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod/v4'

type RunResult = {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function run(
  command: string[],
  cwd: string,
  env: Record<string, string | undefined>,
  timeoutMs = 120_000,
): Promise<RunResult> {
  const child = Bun.spawn(command, {
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

async function requestJson(
  baseUrl: string,
  path: string,
  init?: RequestInit,
): Promise<{ response: Response; data: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  })
  return { response, data: await response.json() }
}

async function waitForServer(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/info`)
      if (response.ok) return
    } catch {}
    await Bun.sleep(100)
  }
  throw new Error('Config UI did not become ready')
}

function reservePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('probe') })
  const port = probe.port
  probe.stop(true)
  return port
}

const projectRoot = resolve(import.meta.dir, '..')
const builtCli = join(projectRoot, 'dist', 'cli.js')
const builtSdk = join(projectRoot, 'dist', 'sdk', 'index.js')
const builtSdkTypes = join(projectRoot, 'dist', 'sdk', 'agentSdkTypes.d.ts')
const configServerPath = join(projectRoot, 'config-ui', 'server.ts')
const tempRoot = await mkdtemp(join(tmpdir(), 'claude-release-smoke-'))
const tempConfig = join(tempRoot, 'config')
const tempProject = join(tempRoot, 'portable-project')
const tempEnv = join(tempProject, '.env')

try {
  await Promise.all([access(builtCli), access(builtSdk), access(builtSdkTypes)])
  await Bun.write(join(tempProject, '.keep'), '')

  const typeConsumer = await run(
    [
      process.execPath,
      'x',
      'tsc',
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--target',
      'ESNext',
      '--module',
      'ESNext',
      '--moduleResolution',
      'bundler',
      'scripts/fixtures/sdk-consumer.ts',
    ],
    projectRoot,
    process.env,
  )
  assert(
    typeConsumer.exitCode === 0 && !typeConsumer.timedOut,
    `Built SDK declarations failed consumer compilation: ${typeConsumer.stderr}`,
  )

  const sdk = await import('../dist/sdk/index.js')
  assert(typeof sdk.query === 'function', 'Built SDK lost query()')
  assert(typeof sdk.tool === 'function', 'Built SDK lost tool()')
  assert(
    sdk.HOOK_EVENTS.includes('PreToolUse') &&
      sdk.EXIT_REASONS.includes('resume'),
    'Built SDK lost framework protocol constants',
  )
  const sdkTool = sdk.tool(
    'release-ping',
    'Release smoke tool',
    { value: z.string() },
    async ({ value }: { value: string }) => ({
      content: [{ type: 'text' as const, text: value }],
    }),
  )
  assert(
    sdk.createSdkMcpServer({ name: 'release-smoke', tools: [sdkTool] }).type ===
      'sdk',
    'Built SDK could not create an in-process MCP server',
  )

  const isolatedEnv = {
    ...process.env,
    FRAMEWORK_CONFIG_DIR: tempConfig,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }
  assert(
    Boolean(isolatedEnv.DEEPSEEK_API_KEY || isolatedEnv.ANTHROPIC_API_KEY),
    'Release smoke requires DEEPSEEK_API_KEY or ANTHROPIC_API_KEY',
  )
  const version = await run(
    [process.execPath, builtCli, '--version'],
    tempProject,
    isolatedEnv,
    10_000,
  )
  assert(
    version.exitCode === 0 && version.stdout.includes('Claude Code'),
    `Built CLI version failed: ${version.stderr}`,
  )
  const builtCliLive = await run(
    [
      process.execPath,
      builtCli,
      '--bare',
      '--no-session-persistence',
      '--settings',
      '{}',
      '--output-format',
      'json',
      '-p',
      'Reply with exactly BUILT_CLI_OK and no other text.',
    ],
    tempProject,
    isolatedEnv,
  )
  assert(
    builtCliLive.exitCode === 0 && !builtCliLive.timedOut,
    `Built CLI live request failed: ${builtCliLive.stderr}`,
  )
  assert(
    JSON.parse(builtCliLive.stdout).result?.trim() === 'BUILT_CLI_OK',
    'Built CLI returned an unexpected live result',
  )

  let sdkResult: { subtype?: string; result?: string; errors?: string[] } | undefined
  const sdkStderr: string[] = []
  const sdkMessageTypes: string[] = []
  const query = sdk.query({
    prompt: 'Reply with exactly BUILT_SDK_OK and no other text.',
    options: {
      cwd: tempProject,
      env: isolatedEnv,
      executable: 'bun',
      pathToClaudeCodeExecutable: builtCli,
      maxTurns: 1,
      tools: [],
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        excludeDynamicSections: true,
      },
      stderr: (data: string) => sdkStderr.push(data),
    },
  })
  try {
    for await (const message of query) {
      sdkMessageTypes.push(message.type)
      if (message.type === 'result') sdkResult = message
    }
  } finally {
    query.close()
  }
  assert(
    sdkResult?.subtype === 'success',
    `Built SDK query failed: ${sdkResult?.errors?.join('; ') ?? 'no result'}; messages=${sdkMessageTypes.join(',') || '<none>'}; stderr=${sdkStderr.join('').trim() || '<none>'}`,
  )
  assert(
    sdkResult.result?.trim() === 'BUILT_SDK_OK',
    `Built SDK returned an unexpected result: ${sdkResult.result ?? '<missing>'}`,
  )

  await writeFile(tempEnv, 'DEEPSEEK_API_KEY=isolated-placeholder\n')
  const port = reservePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const configProcess = Bun.spawn(
    [process.execPath, 'run', configServerPath],
    {
      cwd: tempProject,
      env: {
        ...process.env,
        FRAMEWORK_CONFIG_DIR: tempConfig,
        CONFIG_PORT: String(port),
        CONFIG_UI_ENV_PATH: tempEnv,
        CONFIG_UI_NO_OPEN: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const configStdout = new Response(configProcess.stdout).text()
  const configStderr = new Response(configProcess.stderr).text()
  try {
    await waitForServer(baseUrl)
    const html = await fetch(baseUrl).then(response => response.text())
    assert(html.includes('Claude Code'), 'Config UI HTML was not served')

    const info = await requestJson(baseUrl, '/api/info')
    assert(info.response.ok, 'Config UI info endpoint failed')
    assert(info.data.cwd === tempProject, 'Config UI ignored its working directory')
    assert(info.data.frameworkDir === tempConfig, 'Config UI ignored config isolation')
    assert(info.data.envPath === tempEnv, 'Config UI ignored env-path override')

    const settingsBody = {
      scope: 'project',
      settings: { permissions: { defaultMode: 'default' } },
    }
    const settingsWrite = await requestJson(baseUrl, '/api/settings', {
      method: 'POST',
      body: JSON.stringify(settingsBody),
    })
    assert(settingsWrite.response.ok, 'Config UI could not write project settings')
    const settingsRead = await requestJson(baseUrl, '/api/settings')
    assert(
      settingsRead.data.project.permissions.defaultMode === 'default',
      'Config UI settings round-trip failed',
    )
    const invalidSettings = await requestJson(baseUrl, '/api/settings', {
      method: 'POST',
      body: JSON.stringify({ scope: 'invalid', settings: {} }),
    })
    assert(invalidSettings.response.status === 400, 'Invalid settings scope was accepted')

    const mcpWrite = await requestJson(baseUrl, '/api/mcp', {
      method: 'POST',
      body: JSON.stringify({
        mcpServers: {
          local: { command: 'portable-command', args: ['--stdio'] },
        },
      }),
    })
    assert(mcpWrite.response.ok, 'Config UI could not write MCP configuration')
    const mcpRead = await requestJson(baseUrl, '/api/mcp')
    assert(
      mcpRead.data.mcpServers.local.command === 'portable-command',
      'Config UI MCP round-trip failed',
    )

    const agentWrite = await requestJson(baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: 'release-reviewer',
        scope: 'project',
        content: 'AGENT_CONFIG_OK',
      }),
    })
    assert(agentWrite.response.ok, 'Config UI could not create an agent')
    const agents = await requestJson(baseUrl, '/api/agents')
    assert(
      agents.data.some(
        (agent: { name: string; content: string }) =>
          agent.name === 'release-reviewer.md' &&
          agent.content === 'AGENT_CONFIG_OK',
      ),
      'Config UI agent round-trip failed',
    )
    const traversalAgent = await requestJson(baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: '../escape', content: 'unsafe' }),
    })
    assert(traversalAgent.response.status === 400, 'Agent path traversal was accepted')

    const skillWrite = await requestJson(baseUrl, '/api/skills', {
      method: 'POST',
      body: JSON.stringify({
        name: 'release-quality',
        scope: 'project',
        content: 'SKILL_CONFIG_OK',
      }),
    })
    assert(skillWrite.response.ok, 'Config UI could not create a skill')
    const skills = await requestJson(baseUrl, '/api/skills')
    assert(
      skills.data.some(
        (skill: { name: string; content: string }) =>
          skill.name === 'release-quality' &&
          skill.content === 'SKILL_CONFIG_OK',
      ),
      'Config UI skill round-trip failed',
    )

    const claudeMdWrite = await requestJson(baseUrl, '/api/claudemd', {
      method: 'POST',
      body: JSON.stringify({
        target: 'projectFramework',
        content: 'CLAUDE_MD_CONFIG_OK',
      }),
    })
    assert(claudeMdWrite.response.ok, 'Config UI could not write CLAUDE.md')
    const claudeMdRead = await requestJson(baseUrl, '/api/claudemd')
    assert(
      claudeMdRead.data.files.projectFramework.content ===
        'CLAUDE_MD_CONFIG_OK',
      'Config UI CLAUDE.md round-trip failed',
    )

    const features = await requestJson(baseUrl, '/api/features')
    const featureNames = Object.keys(features.data)
    assert(featureNames.length > 0, 'Config UI exposed no feature flags')
    const nextFeatures = { ...features.data, [featureNames[0]!]: false }
    const featuresWrite = await requestJson(baseUrl, '/api/features', {
      method: 'POST',
      body: JSON.stringify(nextFeatures),
    })
    assert(featuresWrite.response.ok, 'Config UI could not write feature flags')
    const envContent = await readFile(tempEnv, 'utf8')
    assert(
      envContent.includes('DEEPSEEK_API_KEY=isolated-placeholder') &&
        envContent.includes('CLAUDE_CODE_DISABLE_FEATURES='),
      'Feature update overwrote unrelated env configuration',
    )
    const invalidFeature = await requestJson(baseUrl, '/api/features', {
      method: 'POST',
      body: JSON.stringify({ ...features.data, UNKNOWN_FEATURE: true }),
    })
    assert(invalidFeature.response.status === 400, 'Unknown feature was accepted')

    for (const [path, body] of [
      ['/api/agents', { name: 'release-reviewer', scope: 'project' }],
      ['/api/skills', { name: 'release-quality', scope: 'project' }],
    ] as const) {
      const deletion = await requestJson(baseUrl, path, {
        method: 'DELETE',
        body: JSON.stringify(body),
      })
      assert(deletion.response.ok, `Config UI deletion failed for ${path}`)
    }
  } finally {
    configProcess.kill()
    await configProcess.exited
    const [stdout, stderr] = await Promise.all([configStdout, configStderr])
    assert(
      !stderr.trim(),
      `Config UI emitted an unexpected error: ${stderr.trim()}\n${stdout.trim()}`,
    )
  }

  console.log('Release smoke passed: build + SDK + config UI')
} finally {
  await rm(tempRoot, { recursive: true, force: true })
}
