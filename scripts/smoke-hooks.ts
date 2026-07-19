import {
  checkForAsyncHookResponses,
  clearAllAsyncHooks,
  getPendingAsyncHooks,
  registerPendingAsyncHook,
} from '../src/utils/hooks/AsyncHookRegistry.js'
import {
  clearHookEventState,
  emitHookStarted,
  registerHookEventHandler,
  setAllHookEventsEnabled,
  startHookProgressInterval,
  type HookExecutionEvent,
} from '../src/utils/hooks/hookEvents.js'
import { isBlockedAddress } from '../src/utils/hooks/ssrfGuard.js'
import type { ShellCommand } from '../src/utils/ShellCommand.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function createFakeShellCommand(counters: {
  killed: number
  cleaned: number
}): ShellCommand {
  return {
    status: 'running',
    kill() {
      counters.killed++
      this.status = 'killed'
    },
    cleanup() {
      counters.cleaned++
    },
    taskOutput: {
      async getStdout() {
        return ''
      },
      getStderr() {
        return ''
      },
    },
  } as unknown as ShellCommand
}

const blockedAddresses = [
  '10.0.0.1',
  '100.100.100.200',
  '169.254.169.254',
  '192.0.2.1',
  '198.18.0.1',
  '198.51.100.2',
  '203.0.113.3',
  '224.0.0.1',
  '255.255.255.255',
  '::ffff:169.254.169.254',
  '::169.254.169.254',
  '64:ff9b::a9fe:a9fe',
  'fc00::1',
  'fe80::1',
  'ff02::1',
  '2001:db8::1',
]
for (const address of blockedAddresses) {
  assert(isBlockedAddress(address), `SSRF guard allowed blocked address ${address}`)
}
for (const address of ['127.0.0.1', '::1', '8.8.8.8', '2606:4700:4700::1111']) {
  assert(!isBlockedAddress(address), `SSRF guard blocked public/loopback address ${address}`)
}

clearHookEventState()
emitHookStarted('queued', 'queued-hook', 'SessionStart')
registerHookEventHandler(() => {
  throw new Error('intentional smoke handler failure')
})

const events: HookExecutionEvent[] = []
registerHookEventHandler(event => events.push(event))
setAllHookEventsEnabled(true)
emitHookStarted('direct', 'direct-hook', 'PreToolUse')
assert(
  events.some(event => event.type === 'started' && event.hookId === 'direct'),
  'Hook events stopped after a consumer threw',
)

let concurrentPolls = 0
let maxConcurrentPolls = 0
let pollCount = 0
const stopProgress = startHookProgressInterval({
  hookId: 'progress',
  hookName: 'progress-hook',
  hookEvent: 'PreToolUse',
  intervalMs: 5,
  async getOutput() {
    concurrentPolls++
    maxConcurrentPolls = Math.max(maxConcurrentPolls, concurrentPolls)
    const currentPoll = ++pollCount
    await Bun.sleep(12)
    concurrentPolls--
    if (currentPoll === 1) throw new Error('intentional polling failure')
    return { stdout: String(currentPoll), stderr: '', output: String(currentPoll) }
  },
})
for (let attempt = 0; attempt < 50; attempt++) {
  if (events.some(event => event.type === 'progress')) break
  await Bun.sleep(10)
}
stopProgress()
await Bun.sleep(20)
assert(maxConcurrentPolls === 1, 'Hook progress polling overlapped requests')
assert(
  events.some(event => event.type === 'progress'),
  'Hook progress did not recover after a polling failure',
)

const firstCounters = { killed: 0, cleaned: 0 }
const secondCounters = { killed: 0, cleaned: 0 }
registerPendingAsyncHook({
  processId: 'duplicate',
  hookId: 'first',
  asyncResponse: { async: true },
  hookName: 'first-hook',
  hookEvent: 'SessionStart',
  command: 'first',
  shellCommand: createFakeShellCommand(firstCounters),
})
registerPendingAsyncHook({
  processId: 'duplicate',
  hookId: 'second',
  asyncResponse: { async: true },
  hookName: 'second-hook',
  hookEvent: 'SessionStart',
  command: 'second',
  shellCommand: createFakeShellCommand(secondCounters),
})
assert(
  firstCounters.killed === 1 && firstCounters.cleaned === 1,
  'Replacing an async hook did not clean up the previous process',
)
clearAllAsyncHooks()
assert(
  secondCounters.killed === 1 && secondCounters.cleaned === 1,
  'Clearing async hooks did not clean up the active process',
)

const timeoutCounters = { killed: 0, cleaned: 0 }
registerPendingAsyncHook({
  processId: 'timeout',
  hookId: 'timeout',
  asyncResponse: { async: true, asyncTimeout: 1 },
  hookName: 'timeout-hook',
  hookEvent: 'SessionStart',
  command: 'timeout',
  shellCommand: createFakeShellCommand(timeoutCounters),
})
await Bun.sleep(5)
await checkForAsyncHookResponses()
assert(
  timeoutCounters.killed === 1 && timeoutCounters.cleaned === 1,
  'Async hook timeout did not terminate and clean up the process',
)
assert(
  getPendingAsyncHooks().length === 0,
  'Timed-out async hook remained in the registry',
)

clearHookEventState()
console.log('hook execution and security smoke: ok')
