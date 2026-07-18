import { useEffect } from 'react'
import { useNotifications } from 'src/context/notifications.js'
import { useAppState, useSetAppState } from 'src/state/AppState.js'
import {
  type CooldownReason,
  isFastModeEnabled,
  onCooldownExpired,
  onCooldownTriggered,
  onOrgFastModeChanged,
} from 'src/utils/fastMode.js'
import { formatDuration } from 'src/utils/format.js'

const COOLDOWN_STARTED_KEY = 'fast-mode-cooldown-started'
const COOLDOWN_EXPIRED_KEY = 'fast-mode-cooldown-expired'
const ORG_CHANGED_KEY = 'fast-mode-org-changed'

export function useFastModeNotification(): void {
  const { addNotification } = useNotifications()
  const isFastMode = useAppState(state => state.fastMode)
  const setAppState = useSetAppState()

  useEffect(() => {
    if (!isFastModeEnabled()) return
    return onOrgFastModeChanged(orgEnabled => {
      if (orgEnabled) {
        addNotification({
          key: ORG_CHANGED_KEY,
          color: 'fastMode',
          priority: 'immediate',
          text: 'Fast mode is now available · /fast to turn on',
        })
      } else if (isFastMode) {
        setAppState(previous => ({ ...previous, fastMode: false }))
        addNotification({
          key: ORG_CHANGED_KEY,
          color: 'warning',
          priority: 'immediate',
          text: 'Fast mode has been disabled for this API key',
        })
      }
    })
  }, [addNotification, isFastMode, setAppState])

  useEffect(() => {
    if (!isFastMode) return
    const unsubscribeTriggered = onCooldownTriggered((resetAt, reason) => {
      const resetIn = formatDuration(resetAt - Date.now(), {
        hideTrailingZeros: true,
      })
      addNotification({
        key: COOLDOWN_STARTED_KEY,
        invalidates: [COOLDOWN_EXPIRED_KEY],
        text: getCooldownMessage(reason, resetIn),
        color: 'warning',
        priority: 'immediate',
      })
    })
    const unsubscribeExpired = onCooldownExpired(() => {
      addNotification({
        key: COOLDOWN_EXPIRED_KEY,
        invalidates: [COOLDOWN_STARTED_KEY],
        color: 'fastMode',
        text: 'Fast limit reset · now using fast mode',
        priority: 'immediate',
      })
    })
    return () => {
      unsubscribeTriggered()
      unsubscribeExpired()
    }
  }, [addNotification, isFastMode])
}

function getCooldownMessage(reason: CooldownReason, resetIn: string): string {
  return reason === 'overloaded'
    ? `Fast mode is temporarily overloaded · resets in ${resetIn}`
    : `Fast limit reached · resets in ${resetIn}`
}
