import type { AppState } from '../../state/AppState.js'
import { logForDebugging } from '../debug.js'
import { updateHooksConfigSnapshot } from '../hooks/hooksConfigSnapshot.js'
import {
  createDisabledBypassPermissionsContext,
  findOverlyBroadBashPermissions,
  isBypassPermissionsModeDisabled,
  removeDangerousPermissions,
  transitionPlanAutoMode,
} from '../permissions/permissionSetup.js'
import { syncPermissionRulesFromDisk } from '../permissions/permissions.js'
import { loadAllPermissionRulesFromDisk } from '../permissions/permissionsLoader.js'
import type { SettingSource } from './constants.js'
import { getInitialSettings } from './settings.js'

/**
 * 将设置变更应用到应用状态。从磁盘重新读取设置，重新加载权限和钩子，并推送新状态。
 *
 * 交互路径（AppState.tsx 通过 useSettingsChange）和无头/SDK 路径（print.ts 直接订阅）均使用此函数，以便托管设置/策略变更在两种模式下都能完全应用。
 *
 * 在迭代监听器之前，设置缓存由通知器（changeDetector.fanOut）重置，因此此处的 getInitialSettings() 读取到的是最新的磁盘状态。之前此函数会自行重置缓存，这——结合 useSettingsChange 自身的重置——会导致每个订阅者在每次通知时产生 N 次磁盘重载。
 *
 * 像清除身份验证缓存和应用环境变量这样的副作用由 `onChangeAppState` 处理，它在状态中的 `settings` 发生变化时触发。
 */
export function applySettingsChange(
  source: SettingSource,
  setAppState: (f: (prev: AppState) => AppState) => void,
): void {
  const newSettings = getInitialSettings()

  logForDebugging(`Settings changed from ${source}, updating app state`)

  const updatedRules = loadAllPermissionRulesFromDisk()
  updateHooksConfigSnapshot()

  setAppState(prev => {
    let newContext = syncPermissionRulesFromDisk(
      prev.toolPermissionContext,
      updatedRules,
    )

    const overlyBroad = findOverlyBroadBashPermissions(updatedRules, [])
    if (overlyBroad.length > 0) {
      newContext = removeDangerousPermissions(newContext, overlyBroad)
    }

    if (
      newContext.isBypassPermissionsModeAvailable &&
      isBypassPermissionsModeDisabled()
    ) {
      newContext = createDisabledBypassPermissionsContext(newContext)
    }

    newContext = transitionPlanAutoMode(newContext)

    // 当 settings 中的 effortLevel 发生变化时（例如通过 IDE 的 applyFlagSettings），将其同步到顶层 AppState。仅当设置本身发生改变时才传播——否则，无关的设置变更（如启动时关闭提示）会覆盖 AppState 中保存的 --effort CLI 标志值。
    const prevEffort = prev.settings.effortLevel
    const newEffort = newSettings.effortLevel
    const effortChanged = prevEffort !== newEffort

    return {
      ...prev,
      settings: newSettings,
      toolPermissionContext: newContext,
      // 仅传播一个明确的定义新值——当磁盘键缺失时（例如 /effort max 写入 undefined；--effort CLI 标志），prev.settings.effortLevel 可能已过时（内部写入会抑制用于重新同步 AppState.settings 的监视器），因此 effortChanged 将为 true，我们会擦除 effortValue 中保存的会话作用域值。
      ...(effortChanged && newEffort !== undefined
        ? { effortValue: newEffort }
        : {}),
    }
  })
}
