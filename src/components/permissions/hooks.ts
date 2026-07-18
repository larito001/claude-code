import { useEffect, useRef } from 'react'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { sanitizeToolNameForAnalytics } from 'src/services/analytics/metadata.js'
import { SandboxManager } from 'src/utils/sandbox/sandbox-adapter.js'
import type { ToolUseConfirm } from '../../components/permissions/PermissionRequest.js'
import { useSetAppState } from '../../state/AppState.js'
import { env } from '../../utils/env.js'
import { type CompletionType, logUnaryEvent } from '../../utils/unaryLogging.js'

export type UnaryEvent = {
  completion_type: CompletionType
  language_name: string | Promise<string>
}

/**
 * Logs permission request events using analytics and unary logging.
 * Handles both the analytics event and the unary event logging.
 */
export function usePermissionRequestLogging(
  toolUseConfirm: ToolUseConfirm,
  unaryEvent: UnaryEvent,
): void {
  const setAppState = useSetAppState()
  // Guard against effect re-firing if toolUseConfirm's object reference
  // changes during a single dialog's lifetime (e.g., parent re-renders with a
  // fresh object). Without this, the unconditional setAppState below can
  // cascade into an infinite microtask loop — each re-fire does another
  // setAppState spread + splitCommand → shell-quote regex,
  // pegging CPU at 100% and leaking ~500MB/min in JSRopeString/RegExp allocs.
  // The component is keyed by toolUseID, so this ref resets on remount —
  // we only need to dedupe re-fires WITHIN one dialog instance.
  const loggedToolUseID = useRef<string | null>(null)

  useEffect(() => {
    if (loggedToolUseID.current === toolUseConfirm.toolUseID) {
      return
    }
    loggedToolUseID.current = toolUseConfirm.toolUseID

    // Increment permission prompt count for attribution tracking
    setAppState(prev => ({
      ...prev,
      attribution: {
        ...prev.attribution,
        permissionPromptCount: prev.attribution.permissionPromptCount + 1,
      },
    }))

    // Log analytics event
    logEvent('tengu_tool_use_show_permission_request', {
      messageID: toolUseConfirm.assistantMessage.message
        .id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      toolName: sanitizeToolNameForAnalytics(toolUseConfirm.tool.name),
      isMcp: toolUseConfirm.tool.isMcp ?? false,
      decisionReasonType: toolUseConfirm.permissionResult.decisionReason
        ?.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      sandboxEnabled: SandboxManager.isSandboxingEnabled(),
    })

    void logUnaryEvent({
      completion_type: unaryEvent.completion_type,
      event: 'response',
      metadata: {
        language_name: unaryEvent.language_name,
        message_id: toolUseConfirm.assistantMessage.message.id,
        platform: env.platform,
      },
    })
  }, [toolUseConfirm, unaryEvent, setAppState])
}
