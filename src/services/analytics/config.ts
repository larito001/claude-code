/** Shared privacy gate for owner-configured telemetry. */

import { isTelemetryDisabled } from '../../utils/privacyLevel.js'

export function isAnalyticsDisabled(): boolean {
  return process.env.NODE_ENV === 'test' || isTelemetryDisabled()
}
