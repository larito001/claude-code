import type { ZodIssueCode } from 'zod/v4'

// v4 ZodIssueCode 是一个值，不是类型——请使用 typeof 获取其类型
type ZodIssueCodeType = (typeof ZodIssueCode)[keyof typeof ZodIssueCode]

export type ValidationTip = {
  suggestion?: string
  docLink?: string
}

export type TipContext = {
  path: string
  code: ZodIssueCodeType | string
  expected?: string
  received?: unknown
  enumValues?: string[]
  message?: string
  value?: unknown
}

type TipMatcher = {
  /** 判断是否满足 matches 对应的数据或状态。 */
  matches: (context: TipContext) => boolean
  tip: ValidationTip
}

const DOCUMENTATION_BASE = 'https://code.claude.com/docs/en'

const TIP_MATCHERS: TipMatcher[] = [
  {
    /** 判断是否满足 matches 对应的数据或状态。 */
    matches: (ctx): boolean =>
      ctx.path === 'permissions.defaultMode' && ctx.code === 'invalid_value',
    tip: {
      suggestion:
        'Valid modes: "acceptEdits" (ask before file changes), "plan" (analysis only), "bypassPermissions" (auto-accept all), or "default" (standard behavior)',
      docLink: `${DOCUMENTATION_BASE}/iam#permission-modes`,
    },
  },
  {
    /** 判断是否满足 matches 对应的数据或状态。 */
    matches: (ctx): boolean =>
      ctx.path === 'apiKeyHelper' && ctx.code === 'invalid_type',
    tip: {
      suggestion:
        'Provide a shell command that outputs your API key to stdout. The script should output only the API key. Example: "/bin/generate_temp_api_key.sh"',
    },
  },
  {
    /** 判断是否满足 matches 对应的数据或状态。 */
    matches: (ctx): boolean =>
      ctx.path === 'cleanupPeriodDays' &&
      ctx.code === 'too_small' &&
      ctx.expected === '0',
    tip: {
      suggestion:
        'Must be 0 or greater. Set a positive number for days to retain transcripts (default is 30). Setting 0 disables session persistence entirely: no transcripts are written and existing transcripts are deleted at startup.',
    },
  },
  {
    /** 判断是否满足 matches 对应的数据或状态。 */
    matches: (ctx): boolean =>
      ctx.path.startsWith('env.') && ctx.code === 'invalid_type',
    tip: {
      suggestion:
        'Environment variables must be strings. Wrap numbers and booleans in quotes. Example: "DEBUG": "true", "PORT": "3000"',
      docLink: `${DOCUMENTATION_BASE}/settings#environment-variables`,
    },
  },
  {
    /** 判断是否满足 matches 对应的数据或状态。 */
    matches: (ctx): boolean =>
      (ctx.path === 'permissions.allow' || ctx.path === 'permissions.deny') &&
      ctx.code === 'invalid_type' &&
      ctx.expected === 'array',
    tip: {
      suggestion:
        'Permission rules must be in an array. Format: ["Tool(specifier)"]. Examples: ["Bash(npm run build)", "Edit(docs/**)", "Read(~/.zshrc)"]. Use * for wildcards.',
    },
  },
  {
    /** 判断是否满足 matches 对应的数据或状态。 */
    matches: (ctx): boolean =>
      ctx.path.includes('hooks') && ctx.code === 'invalid_type',
    tip: {
      suggestion:
        // gh-31187 / CC-282: 之前的示例显示了 {"matcher": {"tools": ["BashTool"]}}
        // — 一种在 schema 中从未存在过的对象格式（matcher 是 z.string()，
        // 一直如此）。用户复制了提示中的示例，再次遇到相同的验证错误。
        // 请参阅 hooks.ts 中的 matchesPattern()：matcher 是精确匹配、
        // 管道分隔（"Edit|Write"）或正则表达式。空字符串或 "*" 匹配所有。
        'Hooks use a matcher + hooks array. The matcher is a string: a tool name ("Bash"), pipe-separated list ("Edit|Write"), or empty to match all. Example: {"PostToolUse": [{"matcher": "Edit|Write", "hooks": [{"type": "command", "command": "echo Done"}]}]}',
    },
  },
  {
    /** 判断是否满足 matches 对应的数据或状态。 */
    matches: (ctx): boolean =>
      ctx.code === 'invalid_type' && ctx.expected === 'boolean',
    tip: {
      suggestion:
        'Use true or false without quotes. Example: "includeCoAuthoredBy": true',
    },
  },
  {
    /** 判断是否满足 matches 对应的数据或状态。 */
    matches: (ctx): boolean => ctx.code === 'unrecognized_keys',
    tip: {
      suggestion:
        'Check for typos or refer to the documentation for valid fields',
      docLink: `${DOCUMENTATION_BASE}/settings`,
    },
  },
  {
    /** 判断是否满足 matches 对应的数据或状态。 */
    matches: (ctx): boolean =>
      ctx.code === 'invalid_value' && ctx.enumValues !== undefined,
    tip: {
      suggestion: undefined,
    },
  },
  {
    /** 判断是否满足 matches 对应的数据或状态。 */
    matches: (ctx): boolean =>
      ctx.code === 'invalid_type' &&
      ctx.expected === 'object' &&
      ctx.received === null &&
      ctx.path === '',
    tip: {
      suggestion:
        'Check for missing commas, unmatched brackets, or trailing commas. Use a JSON validator to identify the exact syntax error.',
    },
  },
  {
    /** 判断是否满足 matches 对应的数据或状态。 */
    matches: (ctx): boolean =>
      ctx.path === 'permissions.additionalDirectories' &&
      ctx.code === 'invalid_type',
    tip: {
      suggestion:
        'Must be an array of directory paths. Example: ["~/projects", "/tmp/workspace"]. You can also use --add-dir flag or /add-dir command',
      docLink: `${DOCUMENTATION_BASE}/iam#working-directories`,
    },
  },
]

const PATH_DOC_LINKS: Record<string, string> = {
  permissions: `${DOCUMENTATION_BASE}/iam#configuring-permissions`,
  env: `${DOCUMENTATION_BASE}/settings#environment-variables`,
  hooks: `${DOCUMENTATION_BASE}/hooks`,
}

/** 获取 get Validation Tip 对应的数据或状态。 */
export function getValidationTip(context: TipContext): ValidationTip | null {
  /** 执行 matcher 对应的业务处理。 */
  const matcher = TIP_MATCHERS.find(m => m.matches(context))

  if (!matcher) return null

  const tip: ValidationTip = { ...matcher.tip }

  if (
    context.code === 'invalid_value' &&
    context.enumValues &&
    !tip.suggestion
  ) {
    tip.suggestion = `Valid values: ${context.enumValues.map(v => `"${v}"`).join(', ')}`
  }

  // 基于路径前缀添加文档链接
  if (!tip.docLink && context.path) {
    const pathPrefix = context.path.split('.')[0]
    if (pathPrefix) {
      tip.docLink = PATH_DOC_LINKS[pathPrefix]
    }
  }

  return tip
}
