/** Lightweight helpers shared by the macOS secure-storage implementation. */

import { createHash } from 'crypto'
import { userInfo } from 'os'
import { getFrameworkConfigHomeDir } from '../envUtils.js'
import type { SecureStorageData } from './types.js'

// Suffix distinguishing the OAuth credentials keychain entry from the legacy
// API key entry (which uses no suffix). Both share the service name base.
// DO NOT change this value — it's part of the keychain lookup key and would
// orphan existing stored credentials.
export const CREDENTIALS_SERVICE_SUFFIX = '-credentials'

export function getMacOsKeychainStorageServiceName(
  serviceSuffix: string = '',
): string {
  const configDir = getFrameworkConfigHomeDir()
  const isDefaultDir = !process.env.FRAMEWORK_CONFIG_DIR

  // Use a hash of the config dir path to create a unique but stable suffix
  // Only add suffix for non-default directories to maintain backwards compatibility
  const dirHash = isDefaultDir
    ? ''
    : `-${createHash('sha256').update(configDir).digest('hex').substring(0, 8)}`
  return `Claude Code${serviceSuffix}${dirHash}`
}

export function getUsername(): string {
  try {
    return process.env.USER || userInfo().username
  } catch {
    return 'claude-code-user'
  }
}

// --

// Cache for keychain reads to avoid repeated expensive security CLI calls.
// TTL bounds staleness when another process refreshes MCP tokens without a
// blocking spawnSync on
// every read. In-process writes invalidate via clearKeychainCache() directly.
//
// The sync read() path is relatively expensive, so a short TTL can expire
// while many MCP servers authenticate at startup and trigger repeated reads.
// Thirty seconds of cross-process staleness is acceptable for MCP tokens.
//
export const KEYCHAIN_CACHE_TTL_MS = 30_000

export const keychainCacheState: {
  cache: { data: SecureStorageData | null; cachedAt: number } // cachedAt 0 = invalid
  // Incremented on every cache invalidation. readAsync() captures this before
  // spawning and skips its cache write if a newer generation exists, preventing
  // a stale subprocess result from overwriting fresh data written by update().
  generation: number
  // Deduplicates concurrent readAsync() calls so TTL expiry under load spawns
  // one subprocess, not N. Cleared on invalidation so fresh reads don't join
  // a stale in-flight promise.
  readInFlight: Promise<SecureStorageData | null> | null
} = {
  cache: { data: null, cachedAt: 0 },
  generation: 0,
  readInFlight: null,
}

export function clearKeychainCache(): void {
  keychainCacheState.cache = { data: null, cachedAt: 0 }
  keychainCacheState.generation++
  keychainCacheState.readInFlight = null
}
