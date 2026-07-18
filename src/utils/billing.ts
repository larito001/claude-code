import { getAnthropicApiKey } from './auth.js'
import { isEnvTruthy } from './envUtils.js'

export function shouldShowCostWarnings(): boolean {
  // Check if cost reporting is disabled via environment variable
  if (isEnvTruthy(process.env.DISABLE_COST_WARNINGS)) {
    return false
  }

  return getAnthropicApiKey() !== null
}
