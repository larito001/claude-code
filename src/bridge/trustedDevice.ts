import memoize from 'lodash-es/memoize.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { logForDebugging } from '../utils/debug.js'
import { getSecureStorage } from '../utils/secureStorage/index.js'

/**
 * Trusted device token source for bridge (remote-control) sessions.
 *
 * Bridge sessions have SecurityTier=ELEVATED on the server (CCR v2).
 * The server gates ConnectBridgeWorker on its own flag
 * (sessions_elevated_auth_enforcement in Anthropic Main); this CLI-side
 * flag controls whether the CLI sends X-Trusted-Device-Token at all.
 * Two flags so rollout can be staged: flip CLI-side first (headers
 * start flowing, server still no-ops), then flip server-side.
 *
 * Enrollment (POST /auth/trusted_devices) is gated server-side by
 * account_session.created_at < 10min.
 * Token is persistent (90d rolling expiry) and stored in keychain.
 *
 * See anthropics/anthropic#274559 (spec), #310375 (B1b tenant RPCs),
 * #295987 (B2 Python routes), #307150 (C1' CCR v2 gate).
 */

const TRUSTED_DEVICE_GATE = 'tengu_sessions_elevated_auth_enforcement'

function isGateEnabled(): boolean {
  return getFeatureValue_CACHED_MAY_BE_STALE(TRUSTED_DEVICE_GATE, false)
}

// Memoized — secureStorage.read() spawns a macOS `security` subprocess (~40ms).
// bridgeApi.ts calls this from getHeaders() on every poll/heartbeat/ack.
// Cache cleared after enrollment (below) and on logout (clearAuthRelatedCaches).
//
// Only the storage read is memoized — the GrowthBook gate is checked live so
// that a gate flip after GrowthBook refresh takes effect without a restart.
const readStoredToken = memoize((): string | undefined => {
  // Env var takes precedence for testing/canary.
  const envToken = process.env.CLAUDE_TRUSTED_DEVICE_TOKEN
  if (envToken) {
    return envToken
  }
  return getSecureStorage().read()?.trustedDeviceToken
})

export function getTrustedDeviceToken(): string | undefined {
  if (!isGateEnabled()) {
    return undefined
  }
  return readStoredToken()
}

export function clearTrustedDeviceTokenCache(): void {
  readStoredToken.cache?.clear?.()
}

/**
 * Clear the stored trusted device token from secure storage and the memo cache.
 * Called before enrollTrustedDevice() so a stale token from the
 * previous account isn't sent as X-Trusted-Device-Token while enrollment is
 * in-flight (enrollTrustedDevice is async — bridge API calls between login and
 * enrollment completion would otherwise still read the old cached token).
 */
export function clearTrustedDeviceToken(): void {
  if (!isGateEnabled()) {
    return
  }
  const secureStorage = getSecureStorage()
  try {
    const data = secureStorage.read()
    if (data?.trustedDeviceToken) {
      delete data.trustedDeviceToken
      secureStorage.update(data)
    }
  } catch {
    // Best-effort — don't block login if storage is inaccessible
  }
  readStoredToken.cache?.clear?.()
}
