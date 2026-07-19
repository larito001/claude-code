import { feature } from 'src/utils/features.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { logError } from '../utils/log.js'
import { getAutoModeEnabledState } from '../utils/permissions/permissionSetup.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../utils/settings/settings.js'

/**
 * 一次性迁移：为已接受旧版 2 选项 AutoModeOptInDialog 但未将 auto 设为默认的用户清除 skipAutoPermissionPrompt。重新弹出对话框，使其看到新的“将其设为我的默认模式”选项。防护位于 GlobalConfig (~/.claude.json) 中，而非 settings.json，因此可抵御设置重置且不会自行重新启用。
 *
 * 仅在 tengu_auto_mode_config.enabled === 'enabled' 时执行。对于 'opt-in' 用户，清除 skipAutoPermissionPrompt 会从轮播中移除 auto (permissionSetup.ts:988) — 对话框将变得不可达，迁移将自相矛盾。实际中约 40 个目标蚂蚁均为 'enabled'（他们通过裸 Shift+Tab 到达旧对话框，该方式要求 'enabled'），但此防护使其无论何种情况都安全。
 */
export function resetAutoModeOptInForDefaultOffer(): void {
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    const config = getGlobalConfig()
    if (config.hasResetAutoModeOptInForDefaultOffer) return
    if (getAutoModeEnabledState() !== 'enabled') return

    try {
      const user = getSettingsForSource('userSettings')
      if (
        user?.skipAutoPermissionPrompt &&
        user?.permissions?.defaultMode !== 'auto'
      ) {
        updateSettingsForSource('userSettings', {
          skipAutoPermissionPrompt: undefined,
        })
      }

      saveGlobalConfig(c => {
        if (c.hasResetAutoModeOptInForDefaultOffer) return c
        return { ...c, hasResetAutoModeOptInForDefaultOffer: true }
      })
    } catch (error) {
      logError(new Error(`Failed to reset auto mode opt-in: ${error}`))
    }
  }
}
