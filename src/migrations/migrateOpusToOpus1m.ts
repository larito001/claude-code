import {
  getDefaultMainLoopModelSetting,
  isOpus1mMergeEnabled,
  parseUserSpecifiedModel,
} from '../utils/model/model.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../utils/settings/settings.js'

/**
 * 当用户符合合并的 Opus 1M 体验（1P 上的 Max/Team Premium）条件时，将设置中固定了 'opus' 的用户迁移到 'opus[1m]'。
 *
 * 使用 --model opus 的 CLI 调用不受影响：该标志是运行时覆盖，不会触及 userSettings，因此继续使用普通 Opus。
 *
 * 现有的显式 Opus 1M 选择在迁移过程中保留。
 * 3P 用户被跳过——他们的模型字符串是完整的模型 ID，而非别名。
 *
 * 幂等性：仅在 userSettings.model 正好是 'opus' 时才写入。
 */
export function migrateOpusToOpus1m(): void {
  if (!isOpus1mMergeEnabled()) {
    return
  }

  const model = getSettingsForSource('userSettings')?.model
  if (model !== 'opus') {
    return
  }

  const migrated = 'opus[1m]'
  const modelToSet =
    parseUserSpecifiedModel(migrated) ===
    parseUserSpecifiedModel(getDefaultMainLoopModelSetting())
      ? undefined
      : migrated
  updateSettingsForSource('userSettings', { model: modelToSet })

}
