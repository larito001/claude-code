import {
  clearBetaHeaderLatches,
  clearSystemPromptSectionState,
  getSystemPromptSectionCache,
  setSystemPromptSectionCacheEntry,
} from '../bootstrap/state.js'

type ComputeFn = () => string | null | Promise<string | null>

type SystemPromptSection = {
  name: string
  compute: ComputeFn
  cacheBreak: boolean
}

/**
 * 创建一个记忆化的系统提示部分。
 * 计算一次，缓存直到 /clear 或 /compact。
 */
export function systemPromptSection(
  name: string,
  compute: ComputeFn,
): SystemPromptSection {
  return { name, compute, cacheBreak: false }
}

/**
 * 创建一个易变的系统提示部分，每次轮次重新计算。
 * 当值变化时，这将破坏提示缓存。
 * 需要解释为什么必须破坏缓存的原因。
 */
export function DANGEROUS_uncachedSystemPromptSection(
  name: string,
  compute: ComputeFn,
  _reason: string,
): SystemPromptSection {
  return { name, compute, cacheBreak: true }
}

/** 解析所有系统提示部分，返回提示字符串。 */
export async function resolveSystemPromptSections(
  sections: SystemPromptSection[],
): Promise<(string | null)[]> {
  const cache = getSystemPromptSectionCache()

  return Promise.all(
    sections.map(async s => {
      if (!s.cacheBreak && cache.has(s.name)) {
        return cache.get(s.name) ?? null
      }
      const value = await s.compute()
      setSystemPromptSectionCacheEntry(s.name, value)
      return value
    }),
  )
}

/**
 * 清除所有系统提示部分状态。在 /clear 和 /compact 时调用。
 * 还会重置测试版头锁，以便新对话获得对 AFK/fast-mode/cache-editing 头的新评估。
 */
export function clearSystemPromptSections(): void {
  clearSystemPromptSectionState()
  clearBetaHeaderLatches()
}
