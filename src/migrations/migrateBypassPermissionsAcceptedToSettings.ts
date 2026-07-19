import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { logError } from '../utils/log.js'
import {
  hasSkipDangerousModePermissionPrompt,
  updateSettingsForSource,
} from '../utils/settings/settings.js'

/**
 * 迁移：将 bypassPermissionsModeAccepted 从全局配置移至 settings.json 中的 skipDangerousModePermissionPrompt。这是更好的存放位置，因为 settings.json 是用户可配置的设置文件。
 */
export function migrateBypassPermissionsAcceptedToSettings(): void {
  const globalConfig = getGlobalConfig()

  if (!globalConfig.bypassPermissionsModeAccepted) {
    return
  }

  try {
    if (!hasSkipDangerousModePermissionPrompt()) {
      updateSettingsForSource('userSettings', {
        skipDangerousModePermissionPrompt: true,
      })
    }


    saveGlobalConfig(current => {
      if (!('bypassPermissionsModeAccepted' in current)) return current
      const { bypassPermissionsModeAccepted: _, ...updatedConfig } = current
      return updatedConfig
    })
  } catch (error) {
    logError(
      new Error(`Failed to migrate bypass permissions accepted: ${error}`),
    )
  }
}
