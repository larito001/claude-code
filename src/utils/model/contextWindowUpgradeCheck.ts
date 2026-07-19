import { checkOpus1mAccess, checkSonnet1mAccess } from './check1mAccess.js'
import { getUserSpecifiedModelSetting } from './model.js'

// @[MODEL LAUNCH]: 如果新模型支持1M上下文升级路径，则为该模型添加一个分支。
/**
 * 获取可用模型升级以获得更多上下文
 * 如果没有可用的升级或用户已达到最大上下文，则返回null
 */
function getAvailableUpgrade(): {
  alias: string
  name: string
  multiplier: number
} | null {
  const currentModelSetting = getUserSpecifiedModelSetting()
  if (currentModelSetting === 'opus' && checkOpus1mAccess()) {
    return {
      alias: 'opus[1m]',
      name: 'Opus 1M',
      multiplier: 5,
    }
  } else if (currentModelSetting === 'sonnet' && checkSonnet1mAccess()) {
    return {
      alias: 'sonnet[1m]',
      name: 'Sonnet 1M',
      multiplier: 5,
    }
  }

  return null
}

/** 获取不同上下文的升级消息 */
export function getUpgradeMessage(context: 'warning' | 'tip'): string | null {
  const upgrade = getAvailableUpgrade()
  if (!upgrade) return null

  switch (context) {
    case 'warning':
      return `/model ${upgrade.alias}`
    case 'tip':
      return `Tip: You have access to ${upgrade.name} with ${upgrade.multiplier}x more context`
    default:
      return null
  }
}
