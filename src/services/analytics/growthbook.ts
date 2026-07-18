/**
 * Provider-neutral feature configuration facade.
 *
 * The upstream module used Anthropic's hosted GrowthBook service. The framework
 * keeps the established API so existing core call sites and extensions remain
 * compatible, while resolving values only from local configuration and env.
 */
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { logError } from '../../utils/log.js'

export type GrowthBookUserAttributes = {
  id: string
  sessionId: string
  deviceID: string
  platform: 'win32' | 'darwin' | 'linux'
  apiBaseUrlHost?: string
  userType?: string
  email?: string
  appVersion?: string
  github?: Record<string, unknown>
}

type FeatureRefreshListener = () => void

const listeners = new Set<FeatureRefreshListener>()
let envOverrides: Record<string, unknown> | undefined

function parseEnvOverrides(): Record<string, unknown> {
  if (envOverrides) return envOverrides

  const raw = process.env.CLAUDE_CODE_FEATURE_OVERRIDES
  if (!raw) {
    envOverrides = {}
    return envOverrides
  }

  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('CLAUDE_CODE_FEATURE_OVERRIDES must be a JSON object')
    }
    envOverrides = parsed as Record<string, unknown>
  } catch (error) {
    logError(error)
    envOverrides = {}
  }
  return envOverrides
}

function getConfigOverrides(): Record<string, unknown> {
  try {
    return getGlobalConfig().featureOverrides ?? {}
  } catch {
    return {}
  }
}

function resolveFeature<T>(feature: string, defaultValue: T): T {
  const fromEnv = parseEnvOverrides()
  if (feature in fromEnv) return fromEnv[feature] as T

  const fromConfig = getConfigOverrides()
  if (feature in fromConfig) return fromConfig[feature] as T

  return defaultValue
}

function emitRefresh(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      logError(error)
    }
  }
}

export function onGrowthBookRefresh(listener: FeatureRefreshListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function hasGrowthBookEnvOverride(feature: string): boolean {
  return feature in parseEnvOverrides()
}

export function getAllGrowthBookFeatures(): Record<string, unknown> {
  return { ...getConfigOverrides(), ...parseEnvOverrides() }
}

export function getGrowthBookConfigOverrides(): Record<string, unknown> {
  return getConfigOverrides()
}

export function setGrowthBookConfigOverride(
  feature: string,
  value: unknown,
): void {
  try {
    saveGlobalConfig(current => {
      const overrides = current.featureOverrides ?? {}
      if (value === undefined) {
        if (!(feature in overrides)) return current
        const { [feature]: _removed, ...rest } = overrides
        if (Object.keys(rest).length === 0) {
          const { featureOverrides: _old, ...withoutOverrides } = current
          return withoutOverrides
        }
        return { ...current, featureOverrides: rest }
      }
      if (Object.is(overrides[feature], value)) return current
      return {
        ...current,
        featureOverrides: { ...overrides, [feature]: value },
      }
    })
    emitRefresh()
  } catch (error) {
    logError(error)
  }
}

export function clearGrowthBookConfigOverrides(): void {
  try {
    saveGlobalConfig(current => {
      if (!current.featureOverrides) return current
      const { featureOverrides: _old, ...withoutOverrides } = current
      return withoutOverrides
    })
    emitRefresh()
  } catch (error) {
    logError(error)
  }
}

export function getApiBaseUrlHost(): string | undefined {
  try {
    return new URL(
      process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
    ).host
  } catch {
    return undefined
  }
}

export async function initializeGrowthBook(): Promise<void> {
  parseEnvOverrides()
}

export async function getFeatureValue_DEPRECATED<T>(
  feature: string,
  defaultValue: T,
): Promise<T> {
  return resolveFeature(feature, defaultValue)
}

export function getFeatureValue_CACHED_MAY_BE_STALE<T>(
  feature: string,
  defaultValue: T,
): T {
  return resolveFeature(feature, defaultValue)
}

export function getFeatureValue_CACHED_WITH_REFRESH<T>(
  feature: string,
  defaultValue: T,
  _refreshIntervalMs: number,
): T {
  return resolveFeature(feature, defaultValue)
}

export function checkStatsigFeatureGate_CACHED_MAY_BE_STALE(
  gate: string,
): boolean {
  return Boolean(resolveFeature(gate, false))
}

export async function checkSecurityRestrictionGate(
  gate: string,
): Promise<boolean> {
  return Boolean(resolveFeature(gate, false))
}

export async function checkGate_CACHED_OR_BLOCKING(
  gate: string,
): Promise<boolean> {
  return Boolean(resolveFeature(gate, false))
}

export function resetGrowthBook(): void {
  envOverrides = undefined
  emitRefresh()
}

export async function refreshGrowthBookFeatures(): Promise<void> {
  envOverrides = undefined
  parseEnvOverrides()
  emitRefresh()
}

export async function getDynamicConfig_BLOCKS_ON_INIT<T>(
  configName: string,
  defaultValue: T,
): Promise<T> {
  return resolveFeature(configName, defaultValue)
}

export function getDynamicConfig_CACHED_MAY_BE_STALE<T>(
  configName: string,
  defaultValue: T,
): T {
  return resolveFeature(configName, defaultValue)
}
