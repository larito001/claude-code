/**
 * User-Agent 字符串辅助方法。
 *
 * 仅依赖轻量版本读取器，使 SDK 打包代码无需引入 auth.ts 及其传递依赖。
 */

import { getRuntimeVersion } from './runtimeVersion.js'

/** 生成标准 Claude Code User-Agent。 */
export function getClaudeCodeUserAgent(): string {
  return `claude-code/${getRuntimeVersion()}`
}
