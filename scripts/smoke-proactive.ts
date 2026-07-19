import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolUseContext } from '../src/Tool.js'
import type { AgentId } from '../src/types/ids.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const tempRoot = await mkdtemp(join(tmpdir(), 'framework-proactive-smoke-'))
const previousConfigDir = process.env.FRAMEWORK_CONFIG_DIR
const previousFeatures = process.env.CLAUDE_CODE_FEATURES

process.env.FRAMEWORK_CONFIG_DIR = join(tempRoot, 'config')
process.env.CLAUDE_CODE_FEATURES = [previousFeatures, 'PROACTIVE']
  .filter(Boolean)
  .join(',')

try {
  const [
    { SleepTool },
    { activateProactive, deactivateProactive },
    {
      enqueuePendingNotification,
      getCommandQueue,
      getCommandQueueLength,
      resetCommandQueue,
    },
    { AbortError },
    {
      setCwdState,
      setOriginalCwd,
      setProjectRoot,
      setSessionPersistenceDisabled,
    },
    { getAllBaseTools },
    { getDefaultAppState },
    { createFileStateCacheWithSizeLimit },
  ] = await Promise.all([
    import('../src/tools/SleepTool/SleepTool.js'),
    import('../src/proactive/index.js'),
    import('../src/utils/messageQueueManager.js'),
    import('../src/utils/errors.js'),
    import('../src/bootstrap/state.js'),
    import('../src/tools.js'),
    import('../src/state/AppStateStore.js'),
    import('../src/utils/fileStateCache.js'),
  ])

  setSessionPersistenceDisabled(true)
  setOriginalCwd(tempRoot)
  setProjectRoot(tempRoot)
  setCwdState(tempRoot)
  activateProactive('smoke')

  assert(SleepTool.isEnabled(), 'Sleep is unavailable in proactive mode')
  assert(
    getAllBaseTools().some(tool => tool.name === 'Sleep'),
    'Sleep is missing from the built-in tool registry',
  )
  assert(
    SleepTool.inputSchema.safeParse({ duration: 1 }).success,
    'Sleep rejected its minimum duration',
  )
  assert(
    !SleepTool.inputSchema.safeParse({ duration: 0 }).success,
    'Sleep accepted a zero duration',
  )
  assert(
    !SleepTool.inputSchema.safeParse({ duration: 301 }).success,
    'Sleep accepted a duration above its maximum',
  )

  const timerContext = {
    abortController: new AbortController(),
  } as ToolUseContext
  const timerResult = await SleepTool.call({ duration: 1 }, timerContext)
  assert(timerResult.data.wake_reason === 'timer', 'Sleep timer did not expire')
  assert(
    timerResult.data.elapsed_seconds >= 0.9,
    'Sleep timer returned substantially early',
  )

  let appState = getDefaultAppState()
  const shellContext = {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'smoke-model',
      tools: [SleepTool],
      verbose: false,
      thinkingConfig: { type: 'disabled' as const },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(100),
    getAppState: () => appState,
    setAppState: (updater: (previous: typeof appState) => typeof appState) => {
      appState = updater(appState)
    },
    messages: [],
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
  } as unknown as ToolUseContext

  let backgroundTaskId: string | undefined
  if (process.platform === 'win32') {
    const { PowerShellTool } = await import(
      '../src/tools/PowerShellTool/PowerShellTool.js'
    )
    const result = await PowerShellTool.call(
      {
        command:
          "Start-Sleep -Milliseconds 150; Write-Output 'PROACTIVE_WAKE_OK'",
        run_in_background: true,
      },
      shellContext,
    )
    backgroundTaskId = result.data.backgroundTaskId
  } else {
    const { BashTool } = await import('../src/tools/BashTool/BashTool.js')
    const result = await BashTool.call(
      {
        command: "sleep 0.15; printf 'PROACTIVE_WAKE_OK\\n'",
        run_in_background: true,
      },
      shellContext,
    )
    backgroundTaskId = result.data.backgroundTaskId
  }
  assert(backgroundTaskId, 'Shell command did not start in the background')

  const notificationResult = await SleepTool.call(
    { duration: 10 },
    shellContext,
  )
  assert(
    notificationResult.data.wake_reason === 'notification',
    'Background command completion did not wake Sleep',
  )
  assert(
    getCommandQueueLength() === 1,
    'Sleep consumed the notification before query processing',
  )
  assert(
    getCommandQueue().some(command =>
      String(command.value).includes(backgroundTaskId),
    ),
    'The wake notification did not identify the completed background task',
  )
  resetCommandQueue()

  const targetedContext = {
    abortController: new AbortController(),
  } as ToolUseContext
  const targetedSleep = SleepTool.call({ duration: 300 }, targetedContext)
  enqueuePendingNotification({
    value: '<task_notification>other agent completed</task_notification>',
    mode: 'task-notification',
    agentId: 'other-agent' as AgentId,
  })
  const wokeForOtherAgent = await Promise.race([
    targetedSleep.then(() => true),
    Bun.sleep(50).then(() => false),
  ])
  assert(!wokeForOtherAgent, 'Sleep woke for another agent notification')
  enqueuePendingNotification({
    value: '<task_notification>main command completed</task_notification>',
    mode: 'task-notification',
  })
  assert(
    (await targetedSleep).data.wake_reason === 'notification',
    'Sleep did not wake for its own notification',
  )
  resetCommandQueue()

  const interruptedController = new AbortController()
  const interruptedSleep = SleepTool.call(
    { duration: 300 },
    { abortController: interruptedController } as ToolUseContext,
  )
  interruptedController.abort('interrupt')
  let interruptError: unknown
  try {
    await interruptedSleep
  } catch (error) {
    interruptError = error
  }
  assert(interruptError instanceof AbortError, 'Sleep did not abort cleanly')

  deactivateProactive()
  assert(!SleepTool.isEnabled(), 'Sleep remained enabled outside proactive mode')
  console.log('Proactive/Sleep smoke test passed.')
} finally {
  if (previousConfigDir === undefined) delete process.env.FRAMEWORK_CONFIG_DIR
  else process.env.FRAMEWORK_CONFIG_DIR = previousConfigDir
  if (previousFeatures === undefined) delete process.env.CLAUDE_CODE_FEATURES
  else process.env.CLAUDE_CODE_FEATURES = previousFeatures
  await rm(tempRoot, { recursive: true, force: true })
}
