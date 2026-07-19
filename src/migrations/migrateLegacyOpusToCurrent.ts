import { saveGlobalConfig } from '../utils/config.js'
import { isLegacyModelRemapEnabled } from '../utils/model/model.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../utils/settings/settings.js'

/**
 * 将第一方用户从显式的 Opus 4.0/4.1 模型字符串迁移出来。
 *
 * 'opus' 别名已经为第一方解析为 Opus 4.6，因此任何仍在显式 4.0/4.1 字符串上的用户都是在 4.5 发布之前就在设置中固定了它。
 * parseUserSpecifiedModel 现在无论如何在运行时静默重新映射它们——此迁移清理设置文件，使 /model 显示正确的内容，并设置时间戳，以便 REPL 可以显示一次性通知。
 *
 * 只修改 userSettings。项目/本地/策略设置中的遗留字符串保持不变（我们不能/不应该重写那些），并且在运行时仍由 parseUserSpecifiedModel 重新映射。读取和写入同一源使得此操作在没有完成标志的情况下保持幂等，并避免为仅在一个项目中固定了它的用户静默地将 'opus' 提升为全局默认值。
 */
export function migrateLegacyOpusToCurrent(): void {
  if (!isLegacyModelRemapEnabled()) {
    return
  }

  const model = getSettingsForSource('userSettings')?.model
  if (
    model !== 'claude-opus-4-20250514' &&
    model !== 'claude-opus-4-1-20250805' &&
    model !== 'claude-opus-4-0' &&
    model !== 'claude-opus-4-1'
  ) {
    return
  }

  updateSettingsForSource('userSettings', { model: 'opus' })
  saveGlobalConfig(current => ({
    ...current,
    legacyOpusMigrationTimestamp: Date.now(),
  }))
}
