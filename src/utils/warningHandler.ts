import { logForDebugging } from './debug.js'
import { isEnvTruthy } from './envUtils.js'

// Track warnings to avoid spam — bounded to prevent unbounded memory growth
export const MAX_WARNING_KEYS = 1000
const warningCounts = new Map<string, number>()

// Source entrypoints are development runs even when NODE_ENV is unset.
function isRunningFromSource(): boolean {
  const invokedPath = (process.argv[1] || '').replaceAll('\\', '/')
  return /\/src\/entrypoints\/[^/]+\.[cm]?[jt]sx?$/.test(invokedPath)
}

// Known runtime warnings that are noisy but still useful in debug logs.
const KNOWN_NOISY_WARNINGS = [
  /MaxListenersExceededWarning.*AbortSignal/,
  /MaxListenersExceededWarning.*EventTarget/,
]

function isKnownNoisyWarning(warning: Error): boolean {
  const warningStr = `${warning.name}: ${warning.message}`
  return KNOWN_NOISY_WARNINGS.some(pattern => pattern.test(warningStr))
}

// Store reference to our warning handler so we can detect if it's already installed
let warningHandler: ((warning: Error) => void) | null = null

// For testing only - allows resetting the warning handler state
export function resetWarningHandler(): void {
  if (warningHandler) {
    process.removeListener('warning', warningHandler)
  }
  warningHandler = null
  warningCounts.clear()
}

export function initializeWarningHandler(): void {
  // Only set up handler once - check if our handler is already installed
  const currentListeners = process.listeners('warning')
  if (warningHandler && currentListeners.includes(warningHandler)) {
    return
  }

  // Keep Node's default stderr handler in development; release runs route
  // warnings through the bounded diagnostic handler below.
  const isDevelopment =
    process.env.NODE_ENV === 'development' || isRunningFromSource()
  if (!isDevelopment) {
    process.removeAllListeners('warning')
  }

  // Create and store our warning handler
  warningHandler = (warning: Error) => {
    try {
      const warningKey = `${warning.name}: ${warning.message.slice(0, 50)}`
      const count = warningCounts.get(warningKey) || 0

      // Bound the map to prevent unbounded memory growth from unique warning keys.
      // Once the cap is reached, new unique keys are not retained.
      if (
        warningCounts.has(warningKey) ||
        warningCounts.size < MAX_WARNING_KEYS
      ) {
        warningCounts.set(warningKey, count + 1)
      }

      const isKnownNoisy = isKnownNoisyWarning(warning)

      // Emit only the warning class and bounded occurrence count. Full details
      // may contain code or paths and stay in the explicit debug log.

      // In debug mode, show all warnings with context
      if (isEnvTruthy(process.env.CLAUDE_DEBUG)) {
        const prefix = isKnownNoisy ? '[Known Runtime Warning]' : '[Warning]'
        logForDebugging(`${prefix} ${warning.toString()}`, { level: 'warn' })
      }
      // Release-mode warnings remain available through configured diagnostics.
    } catch {
      // Fail silently - we don't want the warning handler to cause issues
    }
  }

  // Install the warning handler
  process.on('warning', warningHandler)
}
