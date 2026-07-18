/**
 * Provider-neutral analytics sink.
 *
 * Core events are forwarded only to the OpenTelemetry logger configured by
 * the application owner. No vendor endpoint or credential is embedded here.
 */

import { logOTelEvent } from '../../utils/telemetry/events.js'
import { attachAnalyticsSink } from './index.js'

type LogEventMetadata = { [key: string]: boolean | number | undefined }

function toOtelMetadata(
  metadata: LogEventMetadata,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [
      key,
      value === undefined ? undefined : String(value),
    ]),
  )
}

function logEventImpl(eventName: string, metadata: LogEventMetadata): void {
  void logOTelEvent(eventName, toOtelMetadata(metadata))
}

async function logEventAsyncImpl(
  eventName: string,
  metadata: LogEventMetadata,
): Promise<void> {
  await logOTelEvent(eventName, toOtelMetadata(metadata))
}

export function initializeAnalyticsSink(): void {
  attachAnalyticsSink({
    logEvent: logEventImpl,
    logEventAsync: logEventAsyncImpl,
  })
}
