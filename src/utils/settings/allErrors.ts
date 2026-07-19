/**
 * 将设置验证错误与MCP配置错误合并。
 *
 * 此模块的存在是为了打破循环依赖：
 *   settings.ts → mcp/config.ts → settings.ts
 *
 * 将MCP错误聚合移至此模块（一个同时导入settings.ts和mcp/config.ts但不被两者导入的叶子模块），循环被消除。
 */

import { getMcpConfigsByScope } from '../../services/mcp/config.js'
import { getSettingsWithErrors } from './settings.js'
import type { SettingsWithErrors } from './validation.js'

/**
 * 获取包含所有验证错误的合并设置，包括MCP配置错误。
 *
 * 当需要全部错误（设置+MCP）时，使用此函数代替getSettingsWithErrors()。底层getSettingsWithErrors()不再包含MCP错误以避免循环依赖。
 */
export function getSettingsWithAllErrors(): SettingsWithErrors {
  const result = getSettingsWithErrors()
  // 'dynamic' 作用域没有返回错误；它会抛出异常并在CLI启动时设置。
  const scopes = ['user', 'project', 'local'] as const
  /** 执行 mcp Errors 对应的业务处理。 */
  const mcpErrors = scopes.flatMap(scope => getMcpConfigsByScope(scope).errors)
  return {
    settings: result.settings,
    errors: [...result.errors, ...mcpErrors],
  }
}
