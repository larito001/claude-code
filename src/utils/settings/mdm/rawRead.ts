/**
 * 用于在不阻塞事件循环的情况下触发 MDM 子进程读取的最小模块。导入最少——仅有 child_process、fs 和 mdmConstants（后者仅导入 os）。
 *
 * 两种使用模式：
 * 1. 启动时：startMdmRawRead() 在 main.tsx 模块评估时触发，结果稍后通过 getMdmRawReadPromise() 消费
 * 2. 轮询/回退：fireRawRead() 按需创建新的读取（由 changeDetector 和 SDK 入口点使用）
 *
 * 原始标准输出由 mdmSettings.ts 通过 consumeRawReadResult() 消费。
 */

import { execFile } from 'child_process'
import { existsSync } from 'fs'
import {
  getMacOSPlistPaths,
  MDM_SUBPROCESS_TIMEOUT_MS,
  PLUTIL_ARGS_PREFIX,
  PLUTIL_PATH,
  WINDOWS_REGISTRY_KEY_PATH_HKCU,
  WINDOWS_REGISTRY_KEY_PATH_HKLM,
  WINDOWS_REGISTRY_VALUE_NAME,
} from './constants.js'

export type RawReadResult = {
  plistStdouts: Array<{ stdout: string; label: string }> | null
  hklmStdout: string | null
  hkcuStdout: string | null
}

let rawReadPromise: Promise<RawReadResult> | null = null

/** 执行 exec File Promise 对应的业务处理。 */
function execFilePromise(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; code: number | null }> {
  return new Promise(resolve => {
    execFile(
      cmd,
      args,
      { encoding: 'utf-8', timeout: MDM_SUBPROCESS_TIMEOUT_MS },
      (err, stdout) => {
        // biome-ignore lint/nursery/noFloatingPromises: resolve() is not a floating promise
        resolve({ stdout: stdout ?? '', code: err ? 1 : 0 })
      },
    )
  })
}

/**
 * 为 MDM 设置触发新的子进程读取并返回原始标准输出。
 * 在 macOS 上：并行对每个 plist 路径启动 plutil，选取第一个获胜者。
 * 在 Windows 上：并行对 HKLM 和 HKCU 启动 reg query。
 * 在 Linux 上：返回空（无 MDM 等效项）。
 */
export function fireRawRead(): Promise<RawReadResult> {
  return (async (): Promise<RawReadResult> => {
    if (process.platform === 'darwin') {
      const plistPaths = getMacOSPlistPaths()

      const allResults = await Promise.all(
        plistPaths.map(async ({ path, label }) => {
          // 快速路径：如果 plist 文件不存在，则跳过 plutil 子进程。启动 plutil 即使立即返回 ENOENT 也需要约 5ms，且非 MDM 机器上永远不会有这些文件。
          // 使用同步 existsSync 以保持导入期间生成的不可变性：execFilePromise 必须是第一个 await，以便 plutil 在事件循环轮询之前启动（参见 main.tsx:3-4）。
          if (!existsSync(path)) {
            return { stdout: '', label, ok: false }
          }
          const { stdout, code } = await execFilePromise(PLUTIL_PATH, [
            ...PLUTIL_ARGS_PREFIX,
            path,
          ])
          return { stdout, label, ok: code === 0 && !!stdout }
        }),
      )

      // 第一个源获胜（数组按优先级排序）
      const winner = allResults.find(r => r.ok)
      return {
        plistStdouts: winner
          ? [{ stdout: winner.stdout, label: winner.label }]
          : [],
        hklmStdout: null,
        hkcuStdout: null,
      }
    }

    if (process.platform === 'win32') {
      const [hklm, hkcu] = await Promise.all([
        execFilePromise('reg', [
          'query',
          WINDOWS_REGISTRY_KEY_PATH_HKLM,
          '/v',
          WINDOWS_REGISTRY_VALUE_NAME,
        ]),
        execFilePromise('reg', [
          'query',
          WINDOWS_REGISTRY_KEY_PATH_HKCU,
          '/v',
          WINDOWS_REGISTRY_VALUE_NAME,
        ]),
      ])
      return {
        plistStdouts: null,
        hklmStdout: hklm.code === 0 ? hklm.stdout : null,
        hkcuStdout: hkcu.code === 0 ? hkcu.stdout : null,
      }
    }

    return { plistStdouts: null, hklmStdout: null, hkcuStdout: null }
  })()
}

/** 在启动时触发一次原始子进程读取。在 main.tsx 模块评估时调用。结果通过 getMdmRawReadPromise() 消费。 */
export function startMdmRawRead(): void {
  if (rawReadPromise) return
  rawReadPromise = fireRawRead()
}

/** 获取启动 promise。如果未调用 startMdmRawRead() 则返回 null。 */
export function getMdmRawReadPromise(): Promise<RawReadResult> | null {
  return rawReadPromise
}
