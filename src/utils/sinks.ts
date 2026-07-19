import { initializeErrorLogSink } from './errorLogSink.js'

/**
 * Attach the error log sink. Called from setup() for the default command;
 * other entrypoints call this directly because they bypass setup().
 *
 * Leaf module — kept out of setup.ts to avoid the setup → commands → bridge
 * → setup import cycle.
 */
export function initSinks(): void {
  initializeErrorLogSink()
}
