type ProactiveState = {
  active: boolean
  paused: boolean
  contextBlocked: boolean
  nextTickAt: number | null
}

const listeners = new Set<() => void>()
let state: ProactiveState = {
  active: false,
  paused: false,
  contextBlocked: false,
  nextTickAt: null,
}

function updateState(patch: Partial<ProactiveState>): void {
  const next = { ...state, ...patch }
  if (
    next.active === state.active &&
    next.paused === state.paused &&
    next.contextBlocked === state.contextBlocked &&
    next.nextTickAt === state.nextTickAt
  ) {
    return
  }
  state = next
  for (const listener of listeners) listener()
}

export function subscribeToProactiveChanges(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getProactiveControlSnapshot(): string {
  return `${state.active}:${state.paused}:${state.contextBlocked}`
}

export function isProactiveActive(): boolean {
  return state.active
}

export function isProactivePaused(): boolean {
  return state.paused || state.contextBlocked
}

export function getNextTickAt(): number | null {
  return state.nextTickAt
}

export function activateProactive(_source: string = 'api'): void {
  updateState({ active: true, paused: false, contextBlocked: false })
}

export function deactivateProactive(): void {
  updateState({
    active: false,
    paused: false,
    contextBlocked: false,
    nextTickAt: null,
  })
}

export function pauseProactive(): void {
  if (state.active) updateState({ paused: true, nextTickAt: null })
}

export function resumeProactive(): void {
  if (state.active) updateState({ paused: false })
}

export function setContextBlocked(contextBlocked: boolean): void {
  updateState({
    contextBlocked,
    ...(contextBlocked ? { nextTickAt: null } : {}),
  })
}

export function setNextTickAt(nextTickAt: number | null): void {
  updateState({ nextTickAt })
}
