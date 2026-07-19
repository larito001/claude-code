import type { Attributes } from '@opentelemetry/api'
import { isEnvTruthy } from './envUtils.js'

export function getTelemetryAttributes(): Attributes {
  const attributes: Attributes = {
  }

  if (isEnvTruthy(process.env.OTEL_METRICS_INCLUDE_VERSION)) {
    attributes['app.version'] = MACRO.VERSION
  }

  return attributes
}
