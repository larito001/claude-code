import memoize from 'lodash-es/memoize.js'

// 这确保您以ISO格式获取LOCAL日期
export function getLocalISODate(): string {
  // 允许在测试和下游集成中使用确定性日期
  if (process.env.CLAUDE_CODE_OVERRIDE_DATE) {
    return process.env.CLAUDE_CODE_OVERRIDE_DATE
  }

  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

// 为提示缓存稳定性进行记忆化——在会话开始时捕获一次日期。
// 主要交互路径通过 context.ts 中的 memoize(getUserContext) 获得此行为；简单模式（--bare）按请求调用 getSystemPrompt，需要显式的记忆化日期以避免在午夜时破坏缓存的提示前缀。
// 当午夜过去时，getDateChangeAttachments 将新日期附加到尾部（尽管简单模式禁用了附件，因此权衡是：午夜后的陈旧日期 vs. ~整个对话缓存破坏——陈旧获胜）。
export const getSessionStartDate = memoize(getLocalISODate)

// 返回用户本地时区的“Month YYYY”（例如“February 2026”）。
// 每月变化，而非每天——在工具提示中使用以最小化缓存破坏。
/** 获取 get Local Month Year 对应的数据或状态。 */
export function getLocalMonthYear(): string {
  const date = process.env.CLAUDE_CODE_OVERRIDE_DATE
    ? new Date(process.env.CLAUDE_CODE_OVERRIDE_DATE)
    : new Date()
  return date.toLocaleString('en-US', { month: 'long', year: 'numeric' })
}
