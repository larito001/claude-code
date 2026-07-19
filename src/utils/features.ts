const DEFAULT_FEATURES = new Set<string>([
  'AUTO_THEME',
  'BASH_CLASSIFIER',
  'COMPACTION_REMINDERS',
  'EXTRACT_MEMORIES',
  'HISTORY_PICKER',
  'HOOK_PROMPTS',
  'MCP_RICH_OUTPUT',
  'MCP_SKILLS',
  'MESSAGE_ACTIONS',
  'POWERSHELL_AUTO_MODE',
  'QUICK_SEARCH',
  'TEAMMEM',
  'TRANSCRIPT_CLASSIFIER',
  'TREE_SITTER_BASH',
  'ULTRATHINK',
])

const OPTIONAL_FEATURES = new Set<string>([
  'AGENT_TRIGGERS',
  'AGENT_MEMORY_SNAPSHOT',
  'AWAY_SUMMARY',
  'BREAK_CACHE_COMMAND',
  'COORDINATOR_MODE',
  'DUMP_SYSTEM_PROMPT',
  'FORK_SUBAGENT',
  'HARD_FAIL',
  'MAGIC_DOCS',
  'MCP_INSTRUCTIONS_DELTA',
  'NEW_INIT',
  'PERFETTO_TRACING',
  'PROMPT_CACHE_BREAK_DETECTION',
  'PROACTIVE',
  'SESSION_MEMORY',
  'SESSION_MEMORY_COMPACT',
  'SESSION_BACKGROUNDING',
  'SESSION_TRANSCRIPT',
  'SLOW_OPERATION_LOGGING',
  'STREAMLINED_OUTPUT',
  'TERMINAL_PANEL',
  'TOKEN_BUDGET',
  'UNATTENDED_RETRY',
  'VERIFICATION_AGENT',
])

function readFeatureList(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map(name => name.trim())
      .filter(Boolean),
  )
}

const ENABLED_FEATURES = readFeatureList(process.env.CLAUDE_CODE_FEATURES)
const DISABLED_FEATURES = readFeatureList(
  process.env.CLAUDE_CODE_DISABLE_FEATURES,
)

/**
 * Runtime feature switch used by the framework and downstream extensions.
 * Defaults are limited to complete, locally supported capabilities.
 */
export function feature(name: string): boolean {
  if (!DEFAULT_FEATURES.has(name) && !OPTIONAL_FEATURES.has(name)) return false
  if (DISABLED_FEATURES.has(name)) return false
  return DEFAULT_FEATURES.has(name) || ENABLED_FEATURES.has(name)
}

export function getDefaultFeatures(): readonly string[] {
  return [...DEFAULT_FEATURES]
}

export function getOptionalFeatures(): readonly string[] {
  return [...OPTIONAL_FEATURES]
}
