import { z } from 'zod/v4'
import { mcpInfoFromString } from '../../services/mcp/mcpStringUtils.js'
import { lazySchema } from '../lazySchema.js'
import { permissionRuleValueFromString } from '../permissions/permissionRuleParser.js'
import { capitalize } from '../stringUtils.js'
import {
  getCustomValidation,
  isBashPrefixTool,
  isFilePatternTool,
} from './toolValidationConfig.js'

/** 检查给定索引处的字符是否被转义（前面有奇数个反斜杠）。 */
function isEscaped(str: string, index: number): boolean {
  let backslashCount = 0
  let j = index - 1
  while (j >= 0 && str[j] === '\\') {
    backslashCount++
    j--
  }
  return backslashCount % 2 !== 0
}

/** 统计字符串中未转义字符的出现次数。如果字符前面有奇数个反斜杠，则视为转义。 */
function countUnescapedChar(str: string, char: string): number {
  let count = 0
  for (let i = 0; i < str.length; i++) {
    if (str[i] === char && !isEscaped(str, i)) {
      count++
    }
  }
  return count
}

/** 检查字符串是否包含未转义的空括号"()"。仅当"("和")"都未转义且相邻时返回true。 */
function hasUnescapedEmptyParens(str: string): boolean {
  for (let i = 0; i < str.length - 1; i++) {
    if (str[i] === '(' && str[i + 1] === ')') {
      // 检查左括号是否未转义
      if (!isEscaped(str, i)) {
        return true
      }
    }
  }
  return false
}

/** 验证权限规则格式和内容 */
export function validatePermissionRule(rule: string): {
  valid: boolean
  error?: string
  suggestion?: string
  examples?: string[]
} {
  // 空规则检查
  if (!rule || rule.trim() === '') {
    return { valid: false, error: 'Permission rule cannot be empty' }
  }

  // 首先检查括号匹配（只计数未转义的括号）
  const openCount = countUnescapedChar(rule, '(')
  const closeCount = countUnescapedChar(rule, ')')
  if (openCount !== closeCount) {
    return {
      valid: false,
      error: 'Mismatched parentheses',
      suggestion:
        'Ensure all opening parentheses have matching closing parentheses',
    }
  }

  // 检查空括号（考虑转义）
  if (hasUnescapedEmptyParens(rule)) {
    const toolName = rule.substring(0, rule.indexOf('('))
    if (!toolName) {
      return {
        valid: false,
        error: 'Empty parentheses with no tool name',
        suggestion: 'Specify a tool name before the parentheses',
      }
    }
    return {
      valid: false,
      error: 'Empty parentheses',
      suggestion: `Either specify a pattern or use just "${toolName}" without parentheses`,
      examples: [`${toolName}`, `${toolName}(some-pattern)`],
    }
  }

  // 解析规则
  const parsed = permissionRuleValueFromString(rule)

  // MCP验证 - 必须在通用工具验证之前完成
  const mcpInfo = mcpInfoFromString(parsed.toolName)
  if (mcpInfo) {
    // MCP规则支持服务器级、工具级和通配符权限
    // 有效格式：
    // - mcp__server（服务器级，所有工具）
    // - mcp__server__*（通配符，所有工具 - 等同于服务器级）
    // - mcp__server__tool（特定工具）

    // MCP规则不能有任何模式/内容（括号）
    // 同时检查解析内容和原始字符串，因为解析器会将
    // 独立通配符（例如"mcp__server(*)"）规范化为未定义的ruleContent
    if (parsed.ruleContent !== undefined || countUnescapedChar(rule, '(') > 0) {
      return {
        valid: false,
        error: 'MCP rules do not support patterns in parentheses',
        suggestion: `Use "${parsed.toolName}" without parentheses, or use "mcp__${mcpInfo.serverName}__*" for all tools`,
        examples: [
          `mcp__${mcpInfo.serverName}`,
          `mcp__${mcpInfo.serverName}__*`,
          mcpInfo.toolName && mcpInfo.toolName !== '*'
            ? `mcp__${mcpInfo.serverName}__${mcpInfo.toolName}`
            : undefined,
        ].filter(Boolean) as string[],
      }
    }

    return { valid: true } // 有效的MCP规则
  }

  // 工具名验证（对于非MCP工具）
  if (!parsed.toolName || parsed.toolName.length === 0) {
    return { valid: false, error: 'Tool name cannot be empty' }
  }

  // 检查工具名是否以大写字母开头（标准工具）
  if (parsed.toolName[0] !== parsed.toolName[0]?.toUpperCase()) {
    return {
      valid: false,
      error: 'Tool names must start with uppercase',
      suggestion: `Use "${capitalize(String(parsed.toolName))}"`,
    }
  }

  // 首先检查自定义验证规则
  const customValidation = getCustomValidation(parsed.toolName)
  if (customValidation && parsed.ruleContent !== undefined) {
    const customResult = customValidation(parsed.ruleContent)
    if (!customResult.valid) {
      return customResult
    }
  }

  // Bash特定验证
  if (isBashPrefixTool(parsed.toolName) && parsed.ruleContent !== undefined) {
    const content = parsed.ruleContent

    // 检查常见的:*错误 - :*必须位于末尾（旧前缀语法）
    if (content.includes(':*') && !content.endsWith(':*')) {
      return {
        valid: false,
        error: 'The :* pattern must be at the end',
        suggestion:
          'Move :* to the end for prefix matching, or use * for wildcard matching',
        examples: [
          'Bash(npm run:*) - prefix matching (legacy)',
          'Bash(npm run *) - wildcard matching',
        ],
      }
    }

    // 检查没有前缀的:*
    if (content === ':*') {
      return {
        valid: false,
        error: 'Prefix cannot be empty before :*',
        suggestion: 'Specify a command prefix before :*',
        examples: ['Bash(npm:*)', 'Bash(git:*)'],
      }
    }

    // 注意：我们不验证引号平衡，因为bash引用规则很复杂。类似 `grep '"'` 的命令存在有效的非平衡双引号。创建意外引号不匹配模式的用户会在匹配不如预期时发现问题。

    // 通配符现在允许在任何位置，以实现灵活的模式匹配。
    // 有效通配符模式示例：
    // - "npm *" 匹配 "npm install"、"npm run test" 等。
    // - "* install" 匹配 "npm install"、"yarn install" 等。
    // - "git * main" 匹配 "git checkout main"、"git push main" 等。
    // - "npm * --save" 匹配 "npm install foo --save" 等。
    //
    // 为了向后兼容，旧版 :* 语法继续有效：
    // - "npm:*" 匹配 "npm" 或 "npm <anything>"（带单词边界的前缀匹配）
  }

  // 文件工具验证
  if (isFilePatternTool(parsed.toolName) && parsed.ruleContent !== undefined) {
    const content = parsed.ruleContent

    // 检查文件模式中的:*（来自Bash模式的常见错误）
    if (content.includes(':*')) {
      return {
        valid: false,
        error: 'The ":*" syntax is only for Bash prefix rules',
        suggestion: 'Use glob patterns like "*" or "**" for file matching',
        examples: [
          `${parsed.toolName}(*.ts) - matches .ts files`,
          `${parsed.toolName}(src/**) - matches all files in src`,
          `${parsed.toolName}(**/*.test.ts) - matches test files`,
        ],
      }
    }

    // 警告通配符不在边界处
    if (
      content.includes('*') &&
      !content.match(/^\*|\*$|\*\*|\/\*|\*\.|\*\)/) &&
      !content.includes('**')
    ) {
      // 这是一个宽松的检查 - 中间的某些通配符在某些情况下可能有效，但通常表示混淆
      return {
        valid: false,
        error: 'Wildcard placement might be incorrect',
        suggestion: 'Wildcards are typically used at path boundaries',
        examples: [
          `${parsed.toolName}(*.js) - all .js files`,
          `${parsed.toolName}(src/*) - all files directly in src`,
          `${parsed.toolName}(src/**) - all files recursively in src`,
        ],
      }
    }
  }

  return { valid: true }
}

/** 权限规则数组的自定义Zod架构 */
export const PermissionRuleSchema = lazySchema(() =>
  z.string().superRefine((val, ctx) => {
    const result = validatePermissionRule(val)
    if (!result.valid) {
      let message = result.error!
      if (result.suggestion) {
        message += `. ${result.suggestion}`
      }
      if (result.examples && result.examples.length > 0) {
        message += `. Examples: ${result.examples.join(', ')}`
      }
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message,
        params: { received: val },
      })
    }
  }),
)
