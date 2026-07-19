/** Local feature configuration with environment and persisted overrides. */
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { logError } from '../utils/log.js'

type FeatureRefreshListener = () => void

const listeners = new Set<FeatureRefreshListener>()
let envOverrides: Record<string, unknown> | undefined

function parseEnvOverrides(): Record<string, unknown> {
  if (envOverrides) return envOverrides

  const raw = process.env.FRAMEWORK_FEATURE_OVERRIDES
  if (!raw) {
    envOverrides = {}
    return envOverrides
  }

  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('FRAMEWORK_FEATURE_OVERRIDES must be a JSON object')
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

export function onFeatureConfigRefresh(
  listener: FeatureRefreshListener,
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function hasFeatureEnvOverride(feature: string): boolean {
  return feature in parseEnvOverrides()
}

export function getAllFeatureOverrides(): Record<string, unknown> {
  return { ...getConfigOverrides(), ...parseEnvOverrides() }
}

export function getFeatureConfigOverrides(): Record<string, unknown> {
  return getConfigOverrides()
}

export function setFeatureConfigOverride(
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

export function clearFeatureConfigOverrides(): void {
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

export async function initializeFeatureConfig(): Promise<void> {
  parseEnvOverrides()
}

export function getFeatureValue<T>(
  feature: string,
  defaultValue: T,
  _refreshIntervalMs?: number,
): T {
  return resolveFeature(feature, defaultValue)
}

export function isFeatureEnabled(gate: string): boolean {
  return Boolean(resolveFeature(gate, false))
}

export function resetFeatureConfig(): void {
  envOverrides = undefined
  emitRefresh()
}

export async function refreshFeatureConfig(): Promise<void> {
  envOverrides = undefined
  parseEnvOverrides()
  emitRefresh()
}
