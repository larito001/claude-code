import chokidar, { type FSWatcher } from 'chokidar'
import { isAbsolute, join } from 'path'
import { registerCleanup } from '../cleanupRegistry.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import {
  executeCwdChangedHooks,
  executeFileChangedHooks,
  type HookOutsideReplResult,
} from '../hooks.js'
import { clearCwdEnvFiles } from '../sessionEnvironment.js'
import { getHooksConfigFromSnapshot } from './hooksConfigSnapshot.js'

let watcher: FSWatcher | null = null
let currentCwd: string
let dynamicWatchPaths: string[] = []
let dynamicWatchPathsSorted: string[] = []
let initialized = false
let notifyCallback: ((text: string, isError: boolean) => void) | null = null
let unregisterCleanup: (() => void) | null = null
let restartQueue = Promise.resolve()

/** 设置并保存 set Env Hook Notifier 对应的数据或状态。 */
export function setEnvHookNotifier(
  cb: ((text: string, isError: boolean) => void) | null,
): void {
  notifyCallback = cb
}

/** 执行 initialize File Changed Watcher 对应的业务处理。 */
export function initializeFileChangedWatcher(cwd: string): void {
  if (initialized) return
  initialized = true
  currentCwd = cwd
  unregisterCleanup ??= registerCleanup(dispose)

  const config = getHooksConfigFromSnapshot()
  const paths = resolveWatchPaths(config)
  if (paths.length === 0) return

  startWatching(paths)
}

/** 确定 resolve Watch Paths 对应的数据或状态。 */
function resolveWatchPaths(
  config?: ReturnType<typeof getHooksConfigFromSnapshot>,
): string[] {
  const matchers = (config ?? getHooksConfigFromSnapshot())?.FileChanged ?? []

  // 匹配器字段：在cwd中监视的文件名，管道分隔（例如".envrc|.env"）
  const staticPaths: string[] = []
  for (const m of matchers) {
    if (!m.matcher) continue
    for (const name of m.matcher.split('|').map(s => s.trim())) {
      if (!name) continue
      staticPaths.push(isAbsolute(name) ? name : join(currentCwd, name))
    }
  }

  // 将静态匹配器路径与来自钩子输出的动态路径组合
  return [...new Set([...staticPaths, ...dynamicWatchPaths])]
}

/** 启动或启用 start Watching 对应的数据或状态。 */
function startWatching(paths: string[]): void {
  logForDebugging(`FileChanged: watching ${paths.length} paths`)
  watcher = chokidar.watch(paths, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 200 },
    ignorePermissionErrors: true,
  })
  watcher.on('change', p => handleFileEvent(p, 'change'))
  watcher.on('add', p => handleFileEvent(p, 'add'))
  watcher.on('unlink', p => handleFileEvent(p, 'unlink'))
}

/** 处理 handle File Event 对应的数据或状态。 */
function handleFileEvent(
  path: string,
  event: 'change' | 'add' | 'unlink',
): void {
  logForDebugging(`FileChanged: ${event} ${path}`)
  void executeFileChangedHooks(path, event)
    .then(({ results, watchPaths, systemMessages }) => {
      if (watchPaths.length > 0) {
        updateWatchPaths(watchPaths)
      }
      for (const msg of systemMessages) {
        notifyCallback?.(msg, false)
      }
      for (const r of results) {
        if (!r.succeeded && r.output) {
          notifyCallback?.(r.output, true)
        }
      }
    })
    .catch(e => {
      const msg = errorMessage(e)
      logForDebugging(`FileChanged hook failed: ${msg}`, {
        level: 'error',
      })
      notifyCallback?.(msg, true)
    })
}

/** 更新 update Watch Paths 对应的数据或状态。 */
export function updateWatchPaths(paths: string[]): void {
  if (!initialized) return
  const sorted = [...new Set(paths)].sort()
  if (
    sorted.length === dynamicWatchPathsSorted.length &&
    sorted.every((p, i) => p === dynamicWatchPathsSorted[i])
  ) {
    return
  }
  dynamicWatchPaths = sorted
  dynamicWatchPathsSorted = sorted
  void scheduleRestart()
}

/** 执行 restart Watching 对应的业务处理。 */
async function restartWatching(): Promise<void> {
  const previousWatcher = watcher
  watcher = null
  if (previousWatcher) {
    await previousWatcher.close()
  }
  if (!initialized) return
  const paths = resolveWatchPaths()
  if (paths.length > 0) {
    startWatching(paths)
  }
}

/** 串行执行监听器重启，避免快速配置变更创建多个并行 watcher。 */
function scheduleRestart(): Promise<void> {
  restartQueue = restartQueue.then(restartWatching).catch(error => {
    logForDebugging(`FileChanged watcher restart failed: ${errorMessage(error)}`, {
      level: 'error',
    })
  })
  return restartQueue
}

/** 处理 on Cwd Changed For Hooks 对应的数据或状态。 */
export async function onCwdChangedForHooks(
  oldCwd: string,
  newCwd: string,
): Promise<void> {
  if (oldCwd === newCwd) return

  // 从当前快照重新评估，以便捕获会话中的钩子更改
  const config = getHooksConfigFromSnapshot()
  const currentHasEnvHooks =
    (config?.CwdChanged?.length ?? 0) > 0 ||
    (config?.FileChanged?.length ?? 0) > 0
  currentCwd = newCwd

  if (!currentHasEnvHooks) {
    dynamicWatchPaths = []
    dynamicWatchPathsSorted = []
    if (initialized) await scheduleRestart()
    return
  }

  await clearCwdEnvFiles()
  const hookResult = await executeCwdChangedHooks(oldCwd, newCwd).catch(e => {
    const msg = errorMessage(e)
    logForDebugging(`CwdChanged hook failed: ${msg}`, {
      level: 'error',
    })
    notifyCallback?.(msg, true)
    return {
      results: [] as HookOutsideReplResult[],
      watchPaths: [] as string[],
      systemMessages: [] as string[],
    }
  })
  dynamicWatchPaths = hookResult.watchPaths
  dynamicWatchPathsSorted = hookResult.watchPaths.slice().sort()
  for (const msg of hookResult.systemMessages) {
    notifyCallback?.(msg, false)
  }
  for (const r of hookResult.results) {
    if (!r.succeeded && r.output) {
      notifyCallback?.(r.output, true)
    }
  }

  // 根据新的cwd重新解析匹配器路径
  if (initialized) {
    await scheduleRestart()
  }
}

/** 删除或清理 dispose 对应的数据或状态。 */
async function dispose(): Promise<void> {
  initialized = false
  await restartQueue
  const previousWatcher = watcher
  watcher = null
  await previousWatcher?.close()
  dynamicWatchPaths = []
  dynamicWatchPathsSorted = []
  notifyCallback = null
  unregisterCleanup?.()
  unregisterCleanup = null
}

/** 重置或恢复 reset File Changed Watcher For Testing 对应的数据或状态。 */
export async function resetFileChangedWatcherForTesting(): Promise<void> {
  await dispose()
}
