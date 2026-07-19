/**
 * MDM 设置模块的共享常量和路径构建器。
 *
 * 此模块没有重量级导入（仅 `os`）——可安全地从 mdmRawRead.ts 中使用。
 * mdmRawRead.ts 和 mdmSettings.ts 都从此处导入以避免重复。
 */

import { userInfo } from 'os'

/** Claude Code MDM 配置文件的 macOS 偏好设置域。 */
export const MACOS_PREFERENCE_DOMAIN = 'com.anthropic.claudecode'

/**
 * Claude Code MDM 策略的 Windows 注册表键路径。
 *
 * 这些键位于 SOFTWARE\Policies 下，该路径位于 WOW64 共享键列表中——32 位和 64 位进程无需重定向即可看到相同的值。
 * 不要将这些键移动到 SOFTWARE\ClaudeCode，因为 SOFTWARE 是重定向的，32 位进程将静默地从 WOW6432Node 读取。
 * 参见：https://learn.microsoft.com/en-us/windows/win32/winprog64/shared-registry-keys
 */
export const WINDOWS_REGISTRY_KEY_PATH_HKLM =
  'HKLM\\SOFTWARE\\Policies\\ClaudeCode'
export const WINDOWS_REGISTRY_KEY_PATH_HKCU =
  'HKCU\\SOFTWARE\\Policies\\ClaudeCode'

/** 包含 JSON 设置 blob 的 Windows 注册表值名称。 */
export const WINDOWS_REGISTRY_VALUE_NAME = 'Settings'

/** macOS plutil 二进制文件的路径。 */
export const PLUTIL_PATH = '/usr/bin/plutil'

/** 用于 plutil 的参数，将 plist 转换为 JSON 并输出到标准输出（需要附加 plist 路径）。 */
export const PLUTIL_ARGS_PREFIX = ['-convert', 'json', '-o', '-', '--'] as const

/** 子进程超时时间（毫秒）。 */
export const MDM_SUBPROCESS_TIMEOUT_MS = 5000

/**
 * 按优先级顺序（最高优先）构建 macOS plist 路径列表。
 * 包括系统管理的设备和每用户策略位置。
 */
export function getMacOSPlistPaths(): Array<{ path: string; label: string }> {
  let username = ''
  try {
    username = userInfo().username
  } catch {
    // 忽略
  }

  const paths: Array<{ path: string; label: string }> = []

  if (username) {
    paths.push({
      path: `/Library/Managed Preferences/${username}/${MACOS_PREFERENCE_DOMAIN}.plist`,
      label: 'per-user managed preferences',
    })
  }

  paths.push({
    path: `/Library/Managed Preferences/${MACOS_PREFERENCE_DOMAIN}.plist`,
    label: 'device-level managed preferences',
  })

  return paths
}
