/**
 * MDM（移动设备管理）配置文件强制应用于Claude Code托管设置。
 *
 * 从操作系统级MDM配置读取企业设置：
 * - macOS：`com.anthropic.claudecode` 偏好域
 *   （仅位于 /Library/Managed Preferences/ 的MDM配置文件——不是用户可写的 ~/Library/Preferences/）
 * - Windows：`HKLM\SOFTWARE\Policies\ClaudeCode`（仅管理员）
 *   和 `HKCU\SOFTWARE\Policies\ClaudeCode`（用户可写，优先级最低）
 * - Linux：无MDM等效机制（改用 /etc/claude-code/managed-settings.json）
 *
 * 策略设置采用“最先来源获胜”——存在的最高优先级来源提供所有策略设置。优先级（从高到低）：
 *   remote → HKLM/plist → managed-settings.json → HKCU
 *
 * 架构：
 *   constants.ts — 共享常量和plist路径构建器（零重量导入）
 *   rawRead.ts   — 仅子进程I/O（零重量导入，在main.tsx评估时触发）
 *   settings.ts  — 解析、缓存、最先来源获胜逻辑（此文件）
 */

import { join } from 'path'
import { logForDebugging } from '../../debug.js'
import { logForDiagnosticsNoPII } from '../../diagLogs.js'
import { readFileSync } from '../../fileRead.js'
import { getFsImplementation } from '../../fsOperations.js'
import { safeParseJSON } from '../../json.js'
import { profileCheckpoint } from '../../startupProfiler.js'
import {
  getManagedFilePath,
  getManagedSettingsDropInDir,
} from '../managedPath.js'
import { type SettingsJson, SettingsSchema } from '../types.js'
import {
  filterInvalidPermissionRules,
  formatZodError,
  type ValidationError,
} from '../validation.js'
import {
  WINDOWS_REGISTRY_KEY_PATH_HKCU,
  WINDOWS_REGISTRY_KEY_PATH_HKLM,
  WINDOWS_REGISTRY_VALUE_NAME,
} from './constants.js'
import {
  fireRawRead,
  getMdmRawReadPromise,
  type RawReadResult,
} from './rawRead.js'

// ---------------------------------------------------------------------------
// 类型与缓存
// ---------------------------------------------------------------------------

type MdmResult = { settings: SettingsJson; errors: ValidationError[] }
const EMPTY_RESULT: MdmResult = Object.freeze({ settings: {}, errors: [] })
let mdmCache: MdmResult | null = null
let hkcuCache: MdmResult | null = null
let mdmLoadPromise: Promise<void> | null = null

// ---------------------------------------------------------------------------
// 启动加载——尽早触发，在首次设置读取前等待
// ---------------------------------------------------------------------------

/** 启动异步MDM/HKCU读取。尽可能在启动初期调用此函数，以便子进程与模块加载并行运行。 */
export function startMdmSettingsLoad(): void {
  if (mdmLoadPromise) return
  mdmLoadPromise = (async () => {
    profileCheckpoint('mdm_load_start')
    const startTime = Date.now()

    // 如果cli.tsx已触发启动原始读取，则使用该结果；否则触发新的读取。两种路径产生相同的RawReadResult；consumeRawReadResult会解析它。
    const rawPromise = getMdmRawReadPromise() ?? fireRawRead()
    const { mdm, hkcu } = consumeRawReadResult(await rawPromise)
    mdmCache = mdm
    hkcuCache = hkcu
    profileCheckpoint('mdm_load_end')

    const duration = Date.now() - startTime
    logForDebugging(`MDM settings load completed in ${duration}ms`)
    if (Object.keys(mdm.settings).length > 0) {
      logForDebugging(
        `MDM settings found: ${Object.keys(mdm.settings).join(', ')}`,
      )
      try {
        logForDiagnosticsNoPII('info', 'mdm_settings_loaded', {
          duration_ms: duration,
          key_count: Object.keys(mdm.settings).length,
          error_count: mdm.errors.length,
        })
      } catch {
        // 诊断日志记录尽力而为
      }
    }
  })()
}

/** 等待正在进行的MDM加载。在首次设置读取前调用此函数。如果startMdmSettingsLoad()足够早地被调用，此函数将立即解析。 */
export async function ensureMdmSettingsLoaded(): Promise<void> {
  if (!mdmLoadPromise) {
    startMdmSettingsLoad()
  }
  await mdmLoadPromise
}

// ---------------------------------------------------------------------------
// 同步缓存读取器——由设置管道（loadSettingsFromDisk）使用
// ---------------------------------------------------------------------------

/**
 * 从会话缓存中读取管理员控制的MDM设置。
 *
 * 返回仅管理员来源的设置：
 * - macOS：/Library/Managed Preferences/（需要root权限）
 * - Windows：HKLM注册表（需要管理员权限）
 *
 * 不包括HKCU（用户可写）——请使用getHkcuSettings()获取。
 */
export function getMdmSettings(): MdmResult {
  return mdmCache ?? EMPTY_RESULT
}

/** 读取HKCU注册表设置（用户可写，最低策略优先级）。仅Windows相关——在其他平台上返回空值。 */
export function getHkcuSettings(): MdmResult {
  return hkcuCache ?? EMPTY_RESULT
}

// ---------------------------------------------------------------------------
// 缓存管理
// ---------------------------------------------------------------------------

/** 清除MDM和HKCU设置缓存，强制在下一次加载时重新读取。 */
export function clearMdmSettingsCache(): void {
  mdmCache = null
  hkcuCache = null
  mdmLoadPromise = null
}

/** 直接更新会话缓存。由变更检测轮询使用。 */
export function setMdmSettingsCache(mdm: MdmResult, hkcu: MdmResult): void {
  mdmCache = mdm
  hkcuCache = hkcu
}

// ---------------------------------------------------------------------------
// 刷新——触发新的原始读取，解析，返回结果。
// 由changeDetector.ts中的30分钟轮询使用。
// ---------------------------------------------------------------------------

/**
 * 触发新的MDM子进程读取并解析结果。
 * 不更新缓存——调用者决定是否应用。
 */
export async function refreshMdmSettings(): Promise<{
  mdm: MdmResult
  hkcu: MdmResult
}> {
  const raw = await fireRawRead()
  return consumeRawReadResult(raw)
}

// ---------------------------------------------------------------------------
// 解析——将原始子进程输出转换为已验证的MdmResult
// ---------------------------------------------------------------------------

/**
 * 将JSON命令输出（plutil stdout或注册表JSON值）解析为SettingsJson。
 * 在模式验证之前过滤无效的权限规则，这样一条坏规则不会导致整个MDM设置被拒绝。
 */
export function parseCommandOutputAsSettings(
  stdout: string,
  sourcePath: string,
): { settings: SettingsJson; errors: ValidationError[] } {
  const data = safeParseJSON(stdout, false)
  if (!data || typeof data !== 'object') {
    return { settings: {}, errors: [] }
  }

  const ruleWarnings = filterInvalidPermissionRules(data, sourcePath)
  const parseResult = SettingsSchema().safeParse(data)
  if (!parseResult.success) {
    const errors = formatZodError(parseResult.error, sourcePath)
    return { settings: {}, errors: [...ruleWarnings, ...errors] }
  }
  return { settings: parseResult.data, errors: ruleWarnings }
}

/**
 * 解析reg query stdout以提取注册表字符串值。
 * 匹配REG_SZ和REG_EXPAND_SZ，不区分大小写。
 *
 * 预期格式：
 *     Settings    REG_SZ    {"json":"value"}
 */
export function parseRegQueryStdout(
  stdout: string,
  valueName = 'Settings',
): string | null {
  const lines = stdout.split(/\r?\n/)
  const escaped = valueName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^\\s+${escaped}\\s+REG_(?:EXPAND_)?SZ\\s+(.*)$`, 'i')
  for (const line of lines) {
    const match = line.match(re)
    if (match && match[1]) {
      return match[1].trimEnd()
    }
  }
  return null
}

/** 将原始子进程输出转换为解析后的MDM和HKCU结果，应用最先来源获胜策略。 */
function consumeRawReadResult(raw: RawReadResult): {
  mdm: MdmResult
  hkcu: MdmResult
} {
  // macOS：plist结果（最先来源获胜——已在mdmRawRead中过滤）
  if (raw.plistStdouts && raw.plistStdouts.length > 0) {
    const { stdout, label } = raw.plistStdouts[0]!
    const result = parseCommandOutputAsSettings(stdout, label)
    if (Object.keys(result.settings).length > 0) {
      return { mdm: result, hkcu: EMPTY_RESULT }
    }
  }

  // Windows：HKLM结果
  if (raw.hklmStdout) {
    const jsonString = parseRegQueryStdout(raw.hklmStdout)
    if (jsonString) {
      const result = parseCommandOutputAsSettings(
        jsonString,
        `Registry: ${WINDOWS_REGISTRY_KEY_PATH_HKLM}\\${WINDOWS_REGISTRY_VALUE_NAME}`,
      )
      if (Object.keys(result.settings).length > 0) {
        return { mdm: result, hkcu: EMPTY_RESULT }
      }
    }
  }

  // 没有管理员MDM——在使用HKCU之前检查managed-settings.json
  if (hasManagedSettingsFile()) {
    return { mdm: EMPTY_RESULT, hkcu: EMPTY_RESULT }
  }

  // 回退到HKCU（已在并行中读取）
  if (raw.hkcuStdout) {
    const jsonString = parseRegQueryStdout(raw.hkcuStdout)
    if (jsonString) {
      const result = parseCommandOutputAsSettings(
        jsonString,
        `Registry: ${WINDOWS_REGISTRY_KEY_PATH_HKCU}\\${WINDOWS_REGISTRY_VALUE_NAME}`,
      )
      return { mdm: EMPTY_RESULT, hkcu: result }
    }
  }

  return { mdm: EMPTY_RESULT, hkcu: EMPTY_RESULT }
}

/**
 * 检查基于文件的托管设置（managed-settings.json或任何managed-settings.d/*.json）是否存在且有内容。用于在存在更高优先级的基于文件的来源时跳过HKCU的廉价同步检查。
 */
function hasManagedSettingsFile(): boolean {
  try {
    const filePath = join(getManagedFilePath(), 'managed-settings.json')
    const content = readFileSync(filePath)
    const data = safeParseJSON(content, false)
    if (data && typeof data === 'object' && Object.keys(data).length > 0) {
      return true
    }
  } catch {
    // 降级到drop-in检查
  }
  try {
    const dropInDir = getManagedSettingsDropInDir()
    const entries = getFsImplementation().readdirSync(dropInDir)
    for (const d of entries) {
      if (
        !(d.isFile() || d.isSymbolicLink()) ||
        !d.name.endsWith('.json') ||
        d.name.startsWith('.')
      ) {
        continue
      }
      try {
        const content = readFileSync(join(dropInDir, d.name))
        const data = safeParseJSON(content, false)
        if (data && typeof data === 'object' && Object.keys(data).length > 0) {
          return true
        }
      } catch {
        // 跳过不可读/格式错误的文件
      }
    }
  } catch {
    // drop-in目录不存在
  }
  return false
}
