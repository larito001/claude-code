import { resetSdkInitState } from '../../bootstrap/state.js'
import { isRestrictedToPluginOnly } from '../settings/pluginOnlyPolicy.js'
// 作为模块对象导入，以便 spyOn 在测试中工作（直接导入会绕过 spy）
import * as settingsModule from '../settings/settings.js'
import { resetSettingsCache } from '../settings/settingsCache.js'
import type { HooksSettings } from '../settings/types.js'

let initialHooksConfig: HooksSettings | null = null

/**
 * 从允许的来源获取 hooks。
 * 如果 policySettings 中设置了 allowManagedHooksOnly，则只返回受管理的 hooks。
 * 如果 policySettings 中设置了 disableAllHooks，则不返回任何 hooks。
 * 如果在非托管设置中设置了 disableAllHooks，则仅返回受管理的 hooks
 * （非托管设置无法禁用受管理的 hooks）。
 * 否则，返回合并自所有来源的 hooks（向后兼容）。
 */
function getHooksFromAllowedSources(): HooksSettings {
  const policySettings = settingsModule.getSettingsForSource('policySettings')

  // 如果受管理设置禁用了所有 hooks，则返回空
  if (policySettings?.disableAllHooks === true) {
    return {}
  }

  // 如果在受管理设置中设置了 allowManagedHooksOnly，则仅使用受管理的 hooks
  if (policySettings?.allowManagedHooksOnly === true) {
    return policySettings.hooks ?? {}
  }

  // strictPluginOnlyCustomization: 阻止用户/项目/本地设置的 hooks。
  // 插件 hooks（注册的频道，hooks.ts:1391）不受影响——
  // 它们被单独组装，且那里的 managedOnly 跳过基于 shouldAllowManagedHooksOnly() 键控，而不是此策略。Agent frontmatter
  // hooks 在注册时（runAgent.ts:~535）通过 agent 来源被门控——
  // 插件/内置/policySettings agent 正常注册，用户来源的
  // agent 在 ["hooks"] 下跳过注册。此处的全面执行时
  // 阻塞会过度杀死插件 agent 的 hooks。
  if (isRestrictedToPluginOnly('hooks')) {
    return policySettings?.hooks ?? {}
  }

  const mergedSettings = settingsModule.getSettings_DEPRECATED()

  // 如果在非托管设置中设置了 disableAllHooks，则仅受管理的 hooks 仍然运行
  // （非托管设置无法覆盖受管理的 hooks）
  if (mergedSettings.disableAllHooks === true) {
    return policySettings?.hooks ?? {}
  }

  // 否则，使用所有 hooks（合并自所有来源）——向后兼容
  return mergedSettings.hooks ?? {}
}

/**
 * 检查是否应仅运行受管理的 hooks。
 * 当以下情况时为真：
 * - policySettings 有 allowManagedHooksOnly: true，或者
 * - 在非托管设置中设置了 disableAllHooks（非托管设置
 *   无法禁用受管理的 hooks，因此它们实际上变为仅受管理）
 */
export function shouldAllowManagedHooksOnly(): boolean {
  const policySettings = settingsModule.getSettingsForSource('policySettings')
  if (policySettings?.allowManagedHooksOnly === true) {
    return true
  }
  // 如果设置了 disableAllHooks 但并非来自受管理设置，
  // 则视为仅受管理（非受管理的 hooks 被禁用，受管理的 hooks 仍运行）
  if (
    settingsModule.getSettings_DEPRECATED().disableAllHooks === true &&
    policySettings?.disableAllHooks !== true
  ) {
    return true
  }
  return false
}

/**
 * 检查是否应禁用所有 hooks（包括受管理的）。
 * 仅当受管理/策略设置具有 disableAllHooks: true 时才为真。
 * 当在非托管设置中设置了 disableAllHooks 时，受管理的 hooks 仍运行。
 */
export function shouldDisableAllHooksIncludingManaged(): boolean {
  return (
    settingsModule.getSettingsForSource('policySettings')?.disableAllHooks ===
    true
  )
}

/**
 * 捕获当前 hooks 配置的快照
 * 应在应用程序启动期间调用一次
 * 遵循 allowManagedHooksOnly 设置
 */
export function captureHooksConfigSnapshot(): void {
  initialHooksConfig = getHooksFromAllowedSources()
}

/**
 * 更新 hooks 配置的快照
 * 当通过设置修改 hooks 时应调用此函数
 * 遵循 allowManagedHooksOnly 设置
 */
export function updateHooksConfigSnapshot(): void {
  // 重置会话缓存以确保我们从磁盘读取新的设置。
  // 若不如此，当用户外部编辑 settings.json 然后运行 /hooks 时，快照可能会使用过时的缓存设置——会话缓存
  // 可能尚未失效（例如，如果文件监视器的稳定性
  // 阈值尚未过去）。
  resetSettingsCache()
  initialHooksConfig = getHooksFromAllowedSources()
}

/**
 * 从快照获取当前 hooks 配置
 * 如果快照不存在，则回退到设置
 * @returns hooks 配置
 */
export function getHooksConfigFromSnapshot(): HooksSettings | null {
  if (initialHooksConfig === null) {
    captureHooksConfigSnapshot()
  }
  return initialHooksConfig
}

/**
 * 重置 hooks 配置快照（用于测试）
 * 同时重置 SDK 初始化状态以防止测试污染
 */
export function resetHooksConfigSnapshot(): void {
  initialHooksConfig = null
  resetSdkInitState()
}
