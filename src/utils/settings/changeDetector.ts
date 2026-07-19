import chokidar, { type FSWatcher } from 'chokidar'
import { stat } from 'fs/promises'
import * as platformPath from 'path'
import { registerCleanup } from '../cleanupRegistry.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import {
  type ConfigChangeSource,
  executeConfigChangeHooks,
  hasBlockingResult,
} from '../hooks.js'
import { createSignal } from '../signal.js'
import { jsonStringify } from '../slowOperations.js'
import { SETTING_SOURCES, type SettingSource } from './constants.js'
import { clearInternalWrites, consumeInternalWrite } from './internalWrites.js'
import { getManagedSettingsDropInDir } from './managedPath.js'
import {
  getHkcuSettings,
  getMdmSettings,
  refreshMdmSettings,
  setMdmSettingsCache,
} from './mdm/settings.js'
import { getSettingsFilePathForSource } from './settings.js'
import { resetSettingsCache } from './settingsCache.js'

/** 等待文件写入稳定后再处理的时间（毫秒）。这有助于避免处理部分写入或快速连续更改。 */
const FILE_STABILITY_THRESHOLD_MS = 1000

/** 检查文件稳定性的轮询间隔（毫秒）。由chokidar的 awaitWriteFinish 选项使用。必须低于 FILE_STABILITY_THRESHOLD_MS。 */
const FILE_STABILITY_POLL_INTERVAL_MS = 500

/** 将文件更改视为内部操作的时间窗口（毫秒）。如果在调用 markInternalWrite() 后的此窗口内发生文件更改，则假定来自 Claude Code 本身，不会触发通知。 */
const INTERNAL_WRITE_WINDOW_MS = 5000

/** MDM 设置（注册表/plist）更改的轮询间隔。这些无法通过文件系统事件监听，因此我们定期轮询。 */
const MDM_POLL_INTERVAL_MS = 30 * 60 * 1000 // 30分钟

/**
 * 处理设置文件删除前的宽限期（毫秒）。处理自动更新或另一会话启动时常见的删除-重建模式。如果在此窗口内触发了 `add` 或 `change` 事件（文件已重建），则取消删除并将其视为更改。
 *
 * 必须超过 chokidar 的 awaitWriteFinish 延迟（stabilityThreshold + pollInterval），以便宽限期超过重建文件上的写入稳定性检查。
 */
const DELETION_GRACE_MS =
  FILE_STABILITY_THRESHOLD_MS + FILE_STABILITY_POLL_INTERVAL_MS + 200

let watcher: FSWatcher | null = null
let mdmPollTimer: ReturnType<typeof setInterval> | null = null
let lastMdmSnapshot: string | null = null
let initialized = false
let disposed = false
const pendingDeletions = new Map<string, ReturnType<typeof setTimeout>>()
const settingsChanged = createSignal<[source: SettingSource]>()

// 时间常数的测试覆盖
let testOverrides: {
  stabilityThreshold?: number
  pollInterval?: number
  mdmPollInterval?: number
  deletionGrace?: number
} | null = null

/** 初始化文件监视 */
export async function initialize(): Promise<void> {
  if (initialized || disposed) return
  initialized = true

  // 启动 MDM 轮询，监测注册表/plist 更改（独立于文件系统监视）
  startMdmPoll()

  // 注册清理，以便在优雅关闭期间正确释放资源
  registerCleanup(dispose)

  const { dirs, settingsFiles, dropInDir } = await getWatchTargets()
  if (disposed) return // dispose() 在等待期间运行
  if (dirs.length === 0) return

  logForDebugging(
    `Watching for changes in setting files ${[...settingsFiles].join(', ')}...${dropInDir ? ` and drop-in directory ${dropInDir}` : ''}`,
  )

  watcher = chokidar.watch(dirs, {
    persistent: true,
    ignoreInitial: true,
    depth: 0, // Only watch immediate children, not subdirectories
    awaitWriteFinish: {
      stabilityThreshold:
        testOverrides?.stabilityThreshold ?? FILE_STABILITY_THRESHOLD_MS,
      pollInterval:
        testOverrides?.pollInterval ?? FILE_STABILITY_POLL_INTERVAL_MS,
    },
    /** 执行 ignored 对应的业务处理。 */
    ignored: (path, stats) => {
      // 忽略特殊文件类型（套接字、FIFO、设备）——它们无法被监视，在 macOS 上会报错 EOPNOTSUPP。
      if (stats && !stats.isFile() && !stats.isDirectory()) return true
      // 忽略 .git 目录
      if (path.split(platformPath.sep).some(dir => dir === '.git')) return true
      // 允许目录（chokidar 需要它们进行目录级监视）和没有状态信息的路径（chokidar 在 stat 前的初始检查）
      if (!stats || stats.isDirectory()) return false
      // 仅监视已知的设置文件，忽略目录中的其他所有内容。注意：chokidar 在 Windows 上将路径规范化为正斜杠，因此我们将其规范回原生格式以进行比较。
      const normalized = platformPath.normalize(path)
      if (settingsFiles.has(normalized)) return false
      // 也接受 managed-settings.d/ 拖放目录中的 .json 文件
      if (
        dropInDir &&
        normalized.startsWith(dropInDir + platformPath.sep) &&
        normalized.endsWith('.json')
      ) {
        return false
      }
      return true
    },
    // 稳定性的附加选项
    ignorePermissionErrors: true,
    usePolling: false, // Use native file system events
    atomic: true, // Handle atomic writes better
  })

  watcher.on('change', handleChange)
  watcher.on('unlink', handleDelete)
  watcher.on('add', handleAdd)
}

/**
 * 清理文件监视器。返回一个 promise，当 chokidar 的 close() 完成时解析——需要在移除监视目录之前完全停止监视器的调用者（例如测试拆卸）必须 await 此 promise。在时序无关紧要的情况下，fire-and-forget 仍然有效。
 */
export function dispose(): Promise<void> {
  disposed = true
  if (mdmPollTimer) {
    clearInterval(mdmPollTimer)
    mdmPollTimer = null
  }
  for (const timer of pendingDeletions.values()) clearTimeout(timer)
  pendingDeletions.clear()
  lastMdmSnapshot = null
  clearInternalWrites()
  settingsChanged.clear()
  const w = watcher
  watcher = null
  return w ? w.close() : Promise.resolve()
}

/** 订阅设置更改 */
export const subscribe = settingsChanged.subscribe

/** 收集设置文件路径及其去重的父目录以进行监视。返回监视目录的所有潜在设置文件路径，不仅仅是初始化时存在的那些，以便新创建的文件也能被检测到。 */
async function getWatchTargets(): Promise<{
  dirs: string[]
  settingsFiles: Set<string>
  dropInDir: string | null
}> {
  // 从目录到该目录中所有潜在设置文件的映射
  const dirToSettingsFiles = new Map<string, Set<string>>()
  const dirsWithExistingFiles = new Set<string>()

  for (const source of SETTING_SOURCES) {
    // 跳过 flagSettings——它们通过 CLI 提供，在会话期间不会更改。此外，它们可能是 $TMPDIR 中的临时文件，该目录可能包含导致文件监视器挂起或错误的特殊文件（FIFO、套接字）。参见：https://github.com/anthropics/claude-code/issues/16469
    if (source === 'flagSettings') {
      continue
    }
    const path = getSettingsFilePathForSource(source)
    if (!path) {
      continue
    }

    const dir = platformPath.dirname(path)

    // 跟踪每个目录中的所有潜在设置文件
    if (!dirToSettingsFiles.has(dir)) {
      dirToSettingsFiles.set(dir, new Set())
    }
    dirToSettingsFiles.get(dir)!.add(path)

    // 检查文件是否存在——仅监视至少包含一个现有文件的目录
    try {
      const stats = await stat(path)
      if (stats.isFile()) {
        dirsWithExistingFiles.add(dir)
      }
    } catch {
      // 文件不存在，没问题
    }
  }

  // 对于被监视的目录，包含所有潜在的设置文件路径
  // 这确保初始化后创建的文件也能被检测到
  const settingsFiles = new Set<string>()
  for (const dir of dirsWithExistingFiles) {
    const filesInDir = dirToSettingsFiles.get(dir)
    if (filesInDir) {
      for (const file of filesInDir) {
        settingsFiles.add(file)
      }
    }
  }

  // 同时监视 managed-settings.d/ 放置目录中的策略片段
  // 我们将其添加为单独的监视目录，以便 chokidar 的 depth:0 监视其直接子文件（.json 文件）
  // 其中的任何 .json 文件都映射到 'policySettings' 源
  let dropInDir: string | null = null
  const managedDropIn = getManagedSettingsDropInDir()
  try {
    const stats = await stat(managedDropIn)
    if (stats.isDirectory()) {
      dirsWithExistingFiles.add(managedDropIn)
      dropInDir = managedDropIn
    }
  } catch {
    // 投放目录不存在，没问题
  }

  return { dirs: [...dirsWithExistingFiles], settingsFiles, dropInDir }
}

/** 设置并保存 setting Source To Config Change Source 对应的数据或状态。 */
function settingSourceToConfigChangeSource(
  source: SettingSource,
): ConfigChangeSource {
  switch (source) {
    case 'userSettings':
      return 'user_settings'
    case 'projectSettings':
      return 'project_settings'
    case 'localSettings':
      return 'local_settings'
    case 'flagSettings':
    case 'policySettings':
      return 'policy_settings'
  }
}

/** 处理 handle Change 对应的数据或状态。 */
function handleChange(path: string): void {
  const source = getSourceForPath(path)
  if (!source) return

  // 如果此路径有挂起的删除（删除并重新创建模式），则取消删除——我们将将其视为更改处理
  const pendingTimer = pendingDeletions.get(path)
  if (pendingTimer) {
    clearTimeout(pendingTimer)
    pendingDeletions.delete(path)
    logForDebugging(
      `Cancelled pending deletion of ${path} — file was recreated`,
    )
  }

  // 检查这是否为内部写入
  if (consumeInternalWrite(path, INTERNAL_WRITE_WINDOW_MS)) {
    return
  }

  logForDebugging(`Detected change to ${path}`)

  // 首先触发 ConfigChange 钩子——如果被阻塞（退出码 2 或 decision: 'block'），则跳过将会话应用于更改
  void executeConfigChangeHooks(
    settingSourceToConfigChangeSource(source),
    path,
  ).then(results => {
    if (hasBlockingResult(results)) {
      logForDebugging(`ConfigChange hook blocked change to ${path}`)
      return
    }
    fanOut(source)
  })
}

/** 处理文件被重新添加（例如在删除并重新创建之后）。取消任何挂起的删除宽限期计时器，并将事件视为更改 */
function handleAdd(path: string): void {
  const source = getSourceForPath(path)
  if (!source) return

  // 取消任何挂起的删除——文件已恢复
  const pendingTimer = pendingDeletions.get(path)
  if (pendingTimer) {
    clearTimeout(pendingTimer)
    pendingDeletions.delete(path)
    logForDebugging(`Cancelled pending deletion of ${path} — file was re-added`)
  }

  // 视为更改（重新读取设置）
  handleChange(path)
}

/** 处理文件被删除。使用宽限期来吸收删除并重新创建模式（例如另一个进程或会话替换文件）。如果在宽限期内重新创建了文件（通过 'add' 或 'change' 事件检测到），则取消删除并视为普通的更改 */
function handleDelete(path: string): void {
  const source = getSourceForPath(path)
  if (!source) return

  logForDebugging(`Detected deletion of ${path}`)

  // 如果此路径已有挂起的删除，则让其继续执行
  if (pendingDeletions.has(path)) return

  /** 执行 timer 对应的业务处理。 */
  const timer = setTimeout(
    (p, src) => {
      pendingDeletions.delete(p)

      // 首先触发 ConfigChange 钩子——如果被阻塞，则跳过应用删除
      void executeConfigChangeHooks(
        settingSourceToConfigChangeSource(src),
        p,
      ).then(results => {
        if (hasBlockingResult(results)) {
          logForDebugging(`ConfigChange hook blocked deletion of ${p}`)
          return
        }
        fanOut(src)
      })
    },
    testOverrides?.deletionGrace ?? DELETION_GRACE_MS,
    path,
    source,
  )
  pendingDeletions.set(path, timer)
}

/** 获取 get Source For Path 对应的数据或状态。 */
function getSourceForPath(path: string): SettingSource | undefined {
  // 规范化路径，因为 chokidar 在 Windows 上使用正斜杠
  const normalizedPath = platformPath.normalize(path)

  // 检查路径是否在 managed-settings.d/ 放置目录内
  const dropInDir = getManagedSettingsDropInDir()
  if (normalizedPath.startsWith(dropInDir + platformPath.sep)) {
    return 'policySettings'
  }

  return SETTING_SOURCES.find(
    source => getSettingsFilePathForSource(source) === normalizedPath,
  )
}

/** 开始轮询 MDM 设置更改（注册表/plist）。获取当前 MDM 设置的快照，并在每个周期进行比较 */
function startMdmPoll(): void {
  // 捕获初始快照（包括管理员 MDM 和用户可写的 HKCU）
  const initial = getMdmSettings()
  const initialHkcu = getHkcuSettings()
  lastMdmSnapshot = jsonStringify({
    mdm: initial.settings,
    hkcu: initialHkcu.settings,
  })

  mdmPollTimer = setInterval(() => {
    if (disposed) return

    void (async () => {
      try {
        const { mdm: current, hkcu: currentHkcu } = await refreshMdmSettings()
        if (disposed) return

        const currentSnapshot = jsonStringify({
          mdm: current.settings,
          hkcu: currentHkcu.settings,
        })

        if (currentSnapshot !== lastMdmSnapshot) {
          lastMdmSnapshot = currentSnapshot
          // 更新缓存，以便同步读取器获取新值
          setMdmSettingsCache(current, currentHkcu)
          logForDebugging('Detected MDM settings change via poll')
          fanOut('policySettings')
        }
      } catch (error) {
        logForDebugging(`MDM poll error: ${errorMessage(error)}`)
      }
    })()
  }, testOverrides?.mdmPollInterval ?? MDM_POLL_INTERVAL_MS)

  // 不要让计时器使进程保持活动状态
  mdmPollTimer.unref()
}

/**
 * 重置设置缓存，然后通知所有监听器。
 *
 * 缓存重置必须在此处进行（单一生产者），而不是在每个监听器（N个消费者）中进行。以前，像 useSettingsChange 和 applySettingsChange 这样的监听器会防御性地重置，因为某些通知路径（文件监视在 :289/340，MDM 轮询在 :385）在遍历监听器之前没有重置。这种防御性导致当订阅了N个监听器时会产生N-way颠簸：每个监听器清除缓存，从磁盘重新读取（填充缓存），然后下一个监听器再次清除它——每个通知进行N次完整的磁盘重载。性能分析显示，当远程托管设置在启动时解析时，在12ms内调用了5次 loadSettingsFromDisk。
 *
 * 通过将重置集中在此处，一个通知 = 一次磁盘重载：第一个调用 getSettingsWithErrors() 的监听器承担缓存未命中并重新填充；所有后续监听器命中缓存。
 */
function fanOut(source: SettingSource): void {
  resetSettingsCache()
  settingsChanged.emit(source)
}

/** 手动通知监听器设置更改。用于程序化设置更改（例如远程托管设置刷新），这些更改不涉及文件系统更改 */
export function notifyChange(source: SettingSource): void {
  logForDebugging(`Programmatic settings change notification for ${source}`)
  fanOut(source)
}

/**
 * 仅用于测试目的重置内部状态。允许在 dispose() 后重新初始化。可选接受计时覆盖以实现更快的测试执行。
 *
 * 关闭监视器并返回关闭 promise，以便 preload 的 afterEach 可以在清除 perTestSettingsDir 之前等待它。否则，chokidar 挂起的 awaitWriteFinish 轮询会在已删除的目录上触发 → ENOENT (#25253)
 */
export function resetForTesting(overrides?: {
  stabilityThreshold?: number
  pollInterval?: number
  mdmPollInterval?: number
  deletionGrace?: number
}): Promise<void> {
  if (mdmPollTimer) {
    clearInterval(mdmPollTimer)
    mdmPollTimer = null
  }
  for (const timer of pendingDeletions.values()) clearTimeout(timer)
  pendingDeletions.clear()
  lastMdmSnapshot = null
  initialized = false
  disposed = false
  testOverrides = overrides ?? null
  const w = watcher
  watcher = null
  return w ? w.close() : Promise.resolve()
}

export const settingsChangeDetector = {
  initialize,
  dispose,
  subscribe,
  notifyChange,
  resetForTesting,
}
