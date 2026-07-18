import { homedir } from 'os'
import { join, posix, win32 } from 'path'
import { logForDebugging } from './debug.js'
import { getPlatform, type Platform } from './platform.js'

export type SystemDirectories = {
  HOME: string
  DESKTOP: string
  DOCUMENTS: string
  DOWNLOADS: string
  [key: string]: string // Index signature for compatibility with Record<string, string>
}

type EnvLike = Record<string, string | undefined>

type SystemDirectoriesOptions = {
  env?: EnvLike
  homedir?: string
  platform?: Platform
}

/**
 * Get cross-platform system directories
 * Handles differences between Windows, macOS, Linux, and WSL
 * @param options Optional overrides for testing (env, homedir, platform)
 */
export function getSystemDirectories(
  options?: SystemDirectoriesOptions,
): SystemDirectories {
  const platform = options?.platform ?? getPlatform()
  const homeDir = options?.homedir ?? homedir()
  const env = options?.env ?? process.env
  const platformJoin =
    platform === 'windows'
      ? win32.join
      : platform === 'macos' ||
          platform === 'linux' ||
          platform === 'wsl'
        ? posix.join
        : join

  // Default paths used by most platforms
  const defaults: SystemDirectories = {
    HOME: homeDir,
    DESKTOP: platformJoin(homeDir, 'Desktop'),
    DOCUMENTS: platformJoin(homeDir, 'Documents'),
    DOWNLOADS: platformJoin(homeDir, 'Downloads'),
  }

  switch (platform) {
    case 'windows': {
      // Windows: Use USERPROFILE if available (handles localized folder names)
      const userProfile = env.USERPROFILE || homeDir
      return {
        HOME: userProfile,
        DESKTOP: win32.join(userProfile, 'Desktop'),
        DOCUMENTS: win32.join(userProfile, 'Documents'),
        DOWNLOADS: win32.join(userProfile, 'Downloads'),
      }
    }

    case 'linux':
    case 'wsl': {
      // Linux/WSL: Check XDG Base Directory specification first
      return {
        HOME: homeDir,
        DESKTOP: env.XDG_DESKTOP_DIR || defaults.DESKTOP,
        DOCUMENTS: env.XDG_DOCUMENTS_DIR || defaults.DOCUMENTS,
        DOWNLOADS: env.XDG_DOWNLOAD_DIR || defaults.DOWNLOADS,
      }
    }

    case 'macos':
    default: {
      // macOS and unknown platforms use standard paths
      if (platform === 'unknown') {
        logForDebugging(`Unknown platform detected, using default paths`)
      }
      return defaults
    }
  }
}
