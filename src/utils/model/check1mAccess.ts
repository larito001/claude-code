import { is1mContextDisabled } from '../context.js'

// API Key 提供商负责校验扩展上下文权限；本地只遵循显式关闭开关，
// 具体模型是否可用由提供商验证。
/** 检查 Opus 是否允许使用一百万 token 上下文。 */
export function checkOpus1mAccess(): boolean {
  return !is1mContextDisabled()
}

/** 检查 check Sonnet1m Access 对应的数据或状态。 */
export function checkSonnet1mAccess(): boolean {
  return !is1mContextDisabled()
}
