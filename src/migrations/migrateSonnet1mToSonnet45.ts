import {
  getMainLoopModelOverride,
  setMainLoopModelOverride,
} from '../bootstrap/state.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../utils/settings/settings.js'

/**
 * 将保存了"sonnet[1m]"的用户迁移到显式的"sonnet-4-5-20250929[1m]"。
 *
 * 现在"sonnet"别名解析到Sonnet 4.6，因此之前设置"sonnet[1m]"（指向带1M上下文的Sonnet 4.5）的用户需要固定到显式版本以保留他们意图使用的模型。
 *
 * 之所以需要这样做，是因为Sonnet 4.6 1M提供给的用户群与Sonnet 4.5 1M不同，因此我们需要将现有的sonnet[1m]用户固定到Sonnet 4.5 1M。
 *
 * 仅从userSettings读取（而非合并的设置），以免将项目范围的"sonnet[1m]"提升为全局默认。只运行一次，由全局配置中的完成标志跟踪。
 */
export function migrateSonnet1mToSonnet45(): void {
  const config = getGlobalConfig()
  if (config.sonnet1m45MigrationComplete) {
    return
  }

  const model = getSettingsForSource('userSettings')?.model
  if (model === 'sonnet[1m]') {
    updateSettingsForSource('userSettings', {
      model: 'sonnet-4-5-20250929[1m]',
    })
  }

  // 如果内存中已设置覆盖，也一并迁移。
  const override = getMainLoopModelOverride()
  if (override === 'sonnet[1m]') {
    setMainLoopModelOverride('sonnet-4-5-20250929[1m]')
  }

  saveGlobalConfig(current => ({
    ...current,
    sonnet1m45MigrationComplete: true,
  }))
}
