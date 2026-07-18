import { feature } from 'src/utils/features.js'
import { initAutoDream } from '../services/autoDream/autoDream.js'
import { initExtractMemories } from '../services/extractMemories/extractMemories.js'
import { initMagicDocs } from '../services/MagicDocs/magicDocs.js'

import { getIsInteractive, getLastInteractionTime } from '../bootstrap/state.js'
import {
  cleanupOldMessageFilesInBackground,
  cleanupOldVersionsThrottled,
} from './cleanup.js'
import { cleanupOldVersions } from './nativeInstaller/index.js'
import { autoUpdateMarketplacesAndPluginsInBackground } from './plugins/pluginAutoupdate.js'

// 24 hours in milliseconds
const RECURRING_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000

// 10 minutes after start.
const DELAY_VERY_SLOW_OPERATIONS_THAT_HAPPEN_EVERY_SESSION = 10 * 60 * 1000

export function initBackgroundHousekeepingServices(): void {
  void initMagicDocs()
  if (feature('EXTRACT_MEMORIES')) {
    initExtractMemories()
  }
  initAutoDream()
}

export function startBackgroundHousekeeping(): void {
  initBackgroundHousekeepingServices()
  void autoUpdateMarketplacesAndPluginsInBackground()
  let needsCleanup = true
  async function runVerySlowOps(): Promise<void> {
    // If the user did something in the last minute, don't make them wait for these slow operations to run.
    if (
      getIsInteractive() &&
      getLastInteractionTime() > Date.now() - 1000 * 60
    ) {
      setTimeout(
        runVerySlowOps,
        DELAY_VERY_SLOW_OPERATIONS_THAT_HAPPEN_EVERY_SESSION,
      ).unref()
      return
    }

    if (needsCleanup) {
      needsCleanup = false
      await cleanupOldMessageFilesInBackground()
    }

    // If the user did something in the last minute, don't make them wait for these slow operations to run.
    if (
      getIsInteractive() &&
      getLastInteractionTime() > Date.now() - 1000 * 60
    ) {
      setTimeout(
        runVerySlowOps,
        DELAY_VERY_SLOW_OPERATIONS_THAT_HAPPEN_EVERY_SESSION,
      ).unref()
      return
    }

    await cleanupOldVersions()
  }

  setTimeout(
    runVerySlowOps,
    DELAY_VERY_SLOW_OPERATIONS_THAT_HAPPEN_EVERY_SESSION,
  ).unref()

  // For long-running sessions, schedule recurring cleanup every 24 hours.
  const interval = setInterval(() => {
    void cleanupOldVersionsThrottled()
  }, RECURRING_CLEANUP_INTERVAL_MS)

  interval.unref()
}
