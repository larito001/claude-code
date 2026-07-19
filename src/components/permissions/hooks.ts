import { useEffect, useRef } from 'react'
import type { ToolUseConfirm } from '../../components/permissions/PermissionRequest.js'
import { useSetAppState } from '../../state/AppState.js'

/**
 * Count a permission prompt once for commit attribution.
 */
export function usePermissionPromptTracking(
  toolUseConfirm: ToolUseConfirm,
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
  }, [toolUseConfirm, setAppState])
}
