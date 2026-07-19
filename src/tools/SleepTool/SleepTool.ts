import { feature } from 'src/utils/features.js'
import { createElement } from 'react'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { Text } from '../../ink.js'
import { isProactiveActive } from '../../proactive/index.js'
import { AbortError } from '../../utils/errors.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  getCommandQueue,
  subscribeToCommandQueue,
} from '../../utils/messageQueueManager.js'
import {
  DESCRIPTION,
  SLEEP_TOOL_NAME,
  SLEEP_TOOL_PROMPT,
} from './prompt.js'

const MAX_DURATION_SECONDS = 300

const inputSchema = lazySchema(() =>
  z.strictObject({
    duration: z
      .number()
      .finite()
      .min(1)
      .max(MAX_DURATION_SECONDS)
      .describe(`Duration to wait in seconds (1-${MAX_DURATION_SECONDS})`),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    wake_reason: z.enum(['timer', 'notification']),
    elapsed_seconds: z.number().nonnegative(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
type Output = z.infer<OutputSchema>

function hasRelevantQueuedCommand(agentId: string | undefined): boolean {
  return getCommandQueue().some(command =>
    agentId === undefined
      ? command.agentId === undefined
      : command.mode === 'task-notification' && command.agentId === agentId,
  )
}

function waitUntilTimerOrNotification(
  durationMs: number,
  signal: AbortSignal,
  agentId: string | undefined,
): Promise<'timer' | 'notification'> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false

    const finish = (reason: 'timer' | 'notification') => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      unsubscribe()
      resolve(reason)
    }
    const onAbort = () => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      unsubscribe()
      reject(new AbortError('Sleep interrupted'))
    }
    const onQueueChanged = () => {
      if (hasRelevantQueuedCommand(agentId)) finish('notification')
    }

    const unsubscribe = subscribeToCommandQueue(onQueueChanged)
    signal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(finish, durationMs, 'timer')

    if (signal.aborted) onAbort()
    else onQueueChanged()
  })
}

export const SleepTool = buildTool({
  name: SLEEP_TOOL_NAME,
  maxResultSizeChars: 1_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return SLEEP_TOOL_PROMPT
  },
  isEnabled() {
    return feature('PROACTIVE') && isProactiveActive()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  interruptBehavior() {
    return 'cancel'
  },
  renderToolUseMessage(input) {
    return input.duration === undefined ? 'waiting' : `for ${input.duration}s`
  },
  renderToolResultMessage(output) {
    const message =
      output.wake_reason === 'notification'
        ? `Woke for a queued message after ${output.elapsed_seconds}s`
        : `Waited ${output.elapsed_seconds}s`
    return createElement(Text, { dimColor: true }, message)
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content:
        output.wake_reason === 'notification'
          ? `A queued message arrived after ${output.elapsed_seconds} seconds.`
          : `Slept for ${output.elapsed_seconds} seconds.`,
    }
  },
  async call({ duration }, { abortController, agentId }) {
    const startedAt = performance.now()
    const wakeReason = await waitUntilTimerOrNotification(
      duration * 1_000,
      abortController.signal,
      agentId,
    )
    return {
      data: {
        wake_reason: wakeReason,
        elapsed_seconds: Number(
          ((performance.now() - startedAt) / 1_000).toFixed(3),
        ),
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
