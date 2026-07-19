import memoize from 'lodash-es/memoize.js'
import { join } from 'path'
import { getPlatform } from '../platform.js'

/** 根据当前平台获取托管设置目录的路径。 */
export const getManagedFilePath = memoize(function (): string {
  if (process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH) {
    return process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH
  }

  switch (getPlatform()) {
    case 'macos':
      return '/Library/Application Support/ClaudeCode'
    case 'windows':
      return 'C:\\Program Files\\ClaudeCode'
    default:
      return '/etc/claude-code'
  }
})

/**
 * 获取managed-settings.d/ drop-in目录的路径。
 * 首先合并managed-settings.json（基础），然后此目录中的文件按字母顺序合并到其上（drop-in覆盖基础，后合并的文件优先）。
 */
export const getManagedSettingsDropInDir = memoize(function (): string {
  return join(getManagedFilePath(), 'managed-settings.d')
})
