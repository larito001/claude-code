import { randomUUID } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

type RunResult = {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const CLI_PATH = resolve(import.meta.dir, '../src/entrypoints/cli.tsx')
const TIMEOUT_MS = 120_000

async function runCli(
  args: string[],
  cwd: string,
  env: Record<string, string | undefined>,
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
  }, TIMEOUT_MS)
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

function parseResult(output: string): string {
  const parsed = JSON.parse(output) as { result?: string }
  return parsed.result?.trim() ?? ''
}

function appendFeature(current: string | undefined, feature: string): string {
  return [...new Set([...(current ?? '').split(',').filter(Boolean), feature])].join(
    ',',
  )
}

function countOccurrences(content: string, needle: string): number {
  return content.split(needle).length - 1
}

const tempRoot = await mkdtemp(join(tmpdir(), 'claude-session-smoke-'))
const tempConfig = join(tempRoot, 'config')
const tempProject = join(tempRoot, 'portable-project')
const sessionId = randomUUID()
const marker = 'SESSION_CHAIN_7Q9X'
const previousEnvironment = new Map(
  [
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_CODE_FEATURES',
    'CLAUDE_CODE_SIMPLE',
  ].map(name => [name, process.env[name]]),
)

process.env.CLAUDE_CONFIG_DIR = tempConfig
process.env.CLAUDE_CODE_FEATURES = appendFeature(
  process.env.CLAUDE_CODE_FEATURES,
  'SESSION_TRANSCRIPT',
)
delete process.env.CLAUDE_CODE_SIMPLE

try {
  await mkdir(tempProject, { recursive: true })
  const liveEnvironment = {
    ...process.env,
    CLAUDE_CONFIG_DIR: tempConfig,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_FEATURES: process.env.CLAUDE_CODE_FEATURES,
  }
  assert(
    Boolean(liveEnvironment.DEEPSEEK_API_KEY || liveEnvironment.ANTHROPIC_API_KEY),
    'Live session smoke requires DEEPSEEK_API_KEY or ANTHROPIC_API_KEY',
  )

  const first = await runCli(
    [
      '--bare',
      '--settings',
      '{}',
      '--output-format',
      'json',
      '--session-id',
      sessionId,
      '-p',
      `Remember the marker ${marker} for this session. Reply with exactly SESSION_STORED.`,
    ],
    tempProject,
    liveEnvironment,
  )
  assert(!first.timedOut, 'Initial persisted session request timed out')
  assert(first.exitCode === 0, `Initial session request failed: ${first.stderr}`)
  assert(
    parseResult(first.stdout) === 'SESSION_STORED',
    'Initial session response was unexpected',
  )

  const { getProjectDir, loadTranscriptFromFile } = await import(
    '../src/utils/sessionStorage.js'
  )
  const transcriptPath = join(getProjectDir(tempProject), `${sessionId}.jsonl`)
  const initialTranscript = await readFile(transcriptPath, 'utf8')
  assert(
    initialTranscript.includes(marker),
    'Persisted JSONL transcript lost the initial user marker',
  )
  const initialLog = await loadTranscriptFromFile(transcriptPath)
  assert(
    initialLog.messages.length >= 2 &&
      initialLog.messages.every(message => message.sessionId === sessionId),
    'Persisted transcript could not be reconstructed into a conversation',
  )

  const compact = await runCli(
    [
      '--bare',
      '--settings',
      '{}',
      '--output-format',
      'json',
      '--resume',
      sessionId,
      '-p',
      `/compact Preserve the marker ${marker} exactly.`,
    ],
    tempProject,
    liveEnvironment,
  )
  assert(!compact.timedOut, 'Resumed compaction request timed out')
  assert(compact.exitCode === 0, `Resumed compaction failed: ${compact.stderr}`)

  const compactedTranscript = await readFile(transcriptPath, 'utf8')
  assert(
    compactedTranscript.includes('compactMetadata'),
    'Compaction did not persist a compact boundary',
  )
  assert(
    compactedTranscript.includes(marker),
    'Compaction removed the required marker from persisted context',
  )

  const continued = await runCli(
    [
      '--bare',
      '--settings',
      '{}',
      '--output-format',
      'json',
      '--continue',
      '-p',
      'Return the marker from before compaction exactly, with no other text.',
    ],
    tempProject,
    liveEnvironment,
  )
  assert(!continued.timedOut, 'Continue request timed out')
  assert(continued.exitCode === 0, `Continue request failed: ${continued.stderr}`)
  assert(
    parseResult(continued.stdout) === marker,
    `Continued session did not retain compacted context: ${parseResult(continued.stdout)}`,
  )

  const {
    setCwdState,
    setOriginalCwd,
    setProjectRoot,
  } = await import('../src/bootstrap/state.js')
  setOriginalCwd(tempProject)
  setProjectRoot(tempProject)
  setCwdState(tempProject)

  const {
    getAutoMemDailyLogPath,
    getAutoMemEntrypoint,
    getAutoMemPath,
  } = await import('../src/memdir/paths.js')
  getAutoMemPath.cache.clear?.()
  const memoryDir = getAutoMemPath()
  const memoryPathRelativeToConfig = relative(tempConfig, memoryDir)
  assert(isAbsolute(memoryDir), 'Auto-memory directory is not absolute')
  assert(
    memoryPathRelativeToConfig !== '' &&
      !memoryPathRelativeToConfig.startsWith('..'),
    'Auto-memory escaped the portable configuration directory',
  )
  assert(
    !memoryDir.startsWith(join(tempProject, '.claude')),
    'Auto-memory incorrectly used the project .claude directory',
  )

  const { buildMemoryPrompt, ensureMemoryDirExists } = await import(
    '../src/memdir/memdir.js'
  )
  await ensureMemoryDirExists(memoryDir)
  await writeFile(
    join(memoryDir, 'user-preference.md'),
    [
      '---',
      'name: Commercial framework preference',
      'description: Keep the core suitable for commercial secondary development',
      'type: user',
      '---',
      'The framework must remain production-oriented.',
      '',
    ].join('\n'),
  )
  await writeFile(
    getAutoMemEntrypoint(),
    '- [Commercial framework preference](user-preference.md) — preserve production quality\n',
  )
  const memoryPrompt = buildMemoryPrompt({
    displayName: 'auto memory',
    memoryDir,
  })
  assert(
    memoryPrompt.includes('Commercial framework preference'),
    'MEMORY.md index was not loaded into the memory prompt',
  )

  const { scanMemoryFiles } = await import('../src/memdir/memoryScan.js')
  const memories = await scanMemoryFiles(memoryDir, new AbortController().signal)
  assert(
    memories.some(
      memory =>
        memory.filename === 'user-preference.md' && memory.type === 'user',
    ),
    'Typed memory file was not discoverable',
  )

  const { writeSessionTranscriptSegment } = await import(
    '../src/services/sessionTranscript/sessionTranscript.js'
  )
  const transcriptMarker = 'SESSION_TRANSCRIPT_DEDUP_OK'
  const transcriptMessage = {
    type: 'user',
    uuid: 'session-transcript-dedup',
    message: { content: transcriptMarker },
  }
  await writeSessionTranscriptSegment([transcriptMessage])
  await writeSessionTranscriptSegment([transcriptMessage])
  const dailyLog = await readFile(getAutoMemDailyLogPath(), 'utf8')
  assert(
    countOccurrences(dailyLog, transcriptMarker) === 1,
    'Session transcript memory log did not deduplicate message UUIDs',
  )

  const { getSessionMemoryDir, getSessionMemoryPath } = await import(
    '../src/utils/permissions/filesystem.js'
  )
  const sessionMemoryPath = getSessionMemoryPath()
  assert(
    sessionMemoryPath.startsWith(getProjectDir(tempProject)),
    'Session memory path is outside the portable project storage',
  )
  await mkdir(getSessionMemoryDir(), { recursive: true })
  await writeFile(sessionMemoryPath, '# Goal\nPreserve the commercial core.\n')
  const {
    getSessionMemoryContent,
    hasMetInitializationThreshold,
    hasMetUpdateThreshold,
    recordExtractionTokenCount,
    resetSessionMemoryState,
    setSessionMemoryConfig,
  } = await import('../src/services/SessionMemory/sessionMemoryUtils.js')
  assert(
    (await getSessionMemoryContent())?.includes('commercial core'),
    'Session memory summary could not be read back',
  )
  resetSessionMemoryState()
  setSessionMemoryConfig({
    minimumMessageTokensToInit: 100,
    minimumTokensBetweenUpdate: 50,
  })
  assert(
    !hasMetInitializationThreshold(99) && hasMetInitializationThreshold(100),
    'Session memory initialization threshold boundary is incorrect',
  )
  recordExtractionTokenCount(100)
  assert(
    !hasMetUpdateThreshold(149) && hasMetUpdateThreshold(150),
    'Session memory update threshold boundary is incorrect',
  )

  const {
    truncateSessionMemoryForCompact,
  } = await import('../src/services/SessionMemory/prompts.js')
  const oversizedMemory = `# Goal\n${'x'.repeat(25_000)}\n# Decisions\nKeep APIs stable.`
  const truncated = truncateSessionMemoryForCompact(oversizedMemory)
  assert(truncated.wasTruncated, 'Oversized session memory was not truncated')
  assert(
    truncated.truncatedContent.includes('# Decisions'),
    'Session-memory truncation lost later sections',
  )
} finally {
  for (const [name, value] of previousEnvironment) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await rm(tempRoot, { recursive: true, force: true })
}

console.log('live session, memory, resume, and compact smoke: ok')
