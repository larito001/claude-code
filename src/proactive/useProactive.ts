import { useEffect, useRef, useSyncExternalStore } from 'react'
import {
  getProactiveControlSnapshot,
  isProactiveActive,
  isProactivePaused,
  setNextTickAt,
  subscribeToProactiveChanges,
} from './index.js'

type ProactiveOptions = {
  isLoading: boolean
  queuedCommandsLength: number
  hasActiveLocalJsxUI: boolean
  isInPlanMode: boolean
  onSubmitTick: (prompt: string) => void
  onQueueTick: (prompt: string) => void
}

const DEFAULT_INTERVAL_MS = 60_000
const MIN_INTERVAL_MS = 5_000

function getTickIntervalMs(): number {
  const configured = Number(process.env.CLAUDE_CODE_PROACTIVE_INTERVAL_MS)
  if (!Number.isFinite(configured)) return DEFAULT_INTERVAL_MS
  return Math.max(MIN_INTERVAL_MS, Math.floor(configured))
}

function createTickPrompt(): string {
  return `<tick>${new Date().toLocaleTimeString()}</tick>`
}

export function useProactive(options: ProactiveOptions): void {
  useSyncExternalStore(
    subscribeToProactiveChanges,
    getProactiveControlSnapshot,
    getProactiveControlSnapshot,
  )

  const callbacks = useRef({
    onSubmitTick: options.onSubmitTick,
    onQueueTick: options.onQueueTick,
  })
  callbacks.current = {
    onSubmitTick: options.onSubmitTick,
    onQueueTick: options.onQueueTick,
  }

  useEffect(() => {
    if (!isProactiveActive() || isProactivePaused()) {
      setNextTickAt(null)
      return
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    let cancelled = false
    const schedule = () => {
      if (cancelled) return
      const interval = getTickIntervalMs()
      setNextTickAt(Date.now() + interval)
      timer = setTimeout(() => {
        setNextTickAt(null)
        if (!isProactiveActive() || isProactivePaused()) return

        const prompt = createTickPrompt()
        if (
          options.isLoading &&
          options.queuedCommandsLength === 0 &&
          !options.hasActiveLocalJsxUI &&
          !options.isInPlanMode
        ) {
          callbacks.current.onQueueTick(prompt)
        } else if (
          !options.isLoading &&
          options.queuedCommandsLength === 0 &&
          !options.hasActiveLocalJsxUI &&
          !options.isInPlanMode
        ) {
          callbacks.current.onSubmitTick(prompt)
        }
        if (!cancelled) schedule()
      }, interval)
    }

    schedule()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      setNextTickAt(null)
    }
  }, [
    options.hasActiveLocalJsxUI,
    options.isInPlanMode,
    options.isLoading,
    options.queuedCommandsLength,
  ])
}
