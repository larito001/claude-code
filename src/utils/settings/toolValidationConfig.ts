/**
 * 工具验证配置
 *
 * 大多数工具无需配置——基础验证自动生效。
 * 仅当工具具有特殊模式要求时，才在此处添加。
 */

export type ToolValidationConfig = {
  /** 接受文件glob模式（如 *.ts, src/**）的工具 */
  filePatternTools: string[]

  /** 接受bash通配符模式（*可出现在任意位置）及旧版 :* 前缀语法的工具 */
  bashPrefixTools: string[]

  /** 针对特定工具的自定义验证规则 */
  customValidation: {
    [toolName: string]: (content: string) => {
      valid: boolean
      error?: string
      suggestion?: string
      examples?: string[]
    }
  }
}

export const TOOL_VALIDATION_CONFIG: ToolValidationConfig = {
  // 文件模式工具（接受 *.ts, src/** 等）
  filePatternTools: [
    'Read',
    'Write',
    'Edit',
    'Glob',
    'NotebookRead',
    'NotebookEdit',
  ],

  // Bash通配符工具（接受任意位置的*，以及旧的 command:* 语法）
  bashPrefixTools: ['Bash'],

  // 自定义验证（仅在需要时）
  customValidation: {

    // WebFetch 使用 domain: 前缀进行基于主机名的权限控制
    WebFetch: content => {
      // 检查是否尝试使用URL格式
      if (content.includes('://') || content.startsWith('http')) {
        return {
          valid: false,
          error: 'WebFetch permissions use domain format, not URLs',
          suggestion: 'Use "domain:hostname" format',
          examples: [
            'WebFetch(domain:example.com)',
            'WebFetch(domain:github.com)',
          ],
        }
      }

      // 必须以 domain: 前缀开头
      if (!content.startsWith('domain:')) {
        return {
          valid: false,
          error: 'WebFetch permissions must use "domain:" prefix',
          suggestion: 'Use "domain:hostname" format',
          examples: [
            'WebFetch(domain:example.com)',
            'WebFetch(domain:*.google.com)',
          ],
        }
      }

      // 允许在域名模式中使用通配符
      // 有效示例：domain:*.example.com、domain:example.* 等
      return { valid: true }
    },
  },
}

// 检查工具是否使用文件模式的辅助函数
export function isFilePatternTool(toolName: string): boolean {
  return TOOL_VALIDATION_CONFIG.filePatternTools.includes(toolName)
}

// 检查工具是否使用bash前缀模式的辅助函数
export function isBashPrefixTool(toolName: string): boolean {
  return TOOL_VALIDATION_CONFIG.bashPrefixTools.includes(toolName)
}

// 获取工具自定义验证的辅助函数
export function getCustomValidation(toolName: string) {
  return TOOL_VALIDATION_CONFIG.customValidation[toolName]
}
