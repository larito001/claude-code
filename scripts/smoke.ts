import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { builtInCommandNames } from '../src/commands.js'
import { createSdkMcpServer, tool } from '../src/entrypoints/agentSdkTypes.js'
import {
  activateProactive,
  deactivateProactive,
  isProactiveActive,
} from '../src/proactive/index.js'
import { formatCompactSummary, getCompactPrompt } from '../src/services/compact/prompt.js'
import { clearBundledSkills, getBundledSkills } from '../src/skills/bundledSkills.js'
import { initBundledSkills } from '../src/skills/bundled/index.js'
import { getAllBaseTools } from '../src/tools.js'
import { getBuiltInAgents } from '../src/tools/AgentTool/builtInAgents.js'
import { ASYNC_AGENT_ALLOWED_TOOLS } from '../src/constants/tools.js'
import { initBackgroundHousekeepingServices } from '../src/utils/backgroundHousekeeping.js'
import { getApiCredentialConfigurationError } from '../src/utils/apiCredentialValidation.js'
import { getFastModeUnavailableReason } from '../src/utils/fastMode.js'
import { feature } from '../src/utils/features.js'
import {
  clearAllAsyncHooks,
  getPendingAsyncHooks,
} from '../src/utils/hooks/AsyncHookRegistry.js'
import { isFirstPartyAnthropicBaseUrl } from '../src/utils/anthropicUrl.js'
import {
  permissionModeFromString,
  toExternalPermissionMode,
} from '../src/utils/permissions/PermissionMode.js'
import { PluginManifestSchema } from '../src/utils/plugins/schemas.js'
import { TOOL_VALIDATION_CONFIG } from '../src/utils/settings/toolValidationConfig.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

assert(!feature('KAIROS'), 'Unsupported product features must remain disabled')

assert(
  getApiCredentialConfigurationError({
    hasApiKey: false,
    hasApiKeyHelper: false,
  })?.includes('ANTHROPIC_API_KEY'),
  'Missing API key configuration must fail with actionable guidance',
)
assert(
  getApiCredentialConfigurationError({
    hasApiKey: true,
    hasApiKeyHelper: false,
  }) === null,
  'Direct API key configuration was rejected',
)
assert(
  getApiCredentialConfigurationError({
    provider: 'firstParty',
    hasApiKey: false,
    hasApiKeyHelper: true,
  }) === null,
  'apiKeyHelper configuration was rejected',
)
initBackgroundHousekeepingServices()

const baseToolNames = new Set(getAllBaseTools().map(toolDefinition => toolDefinition.name))
for (const toolName of [
  'Agent',
  'AskUserQuestion',
  'Bash',
  'Config',
  'Edit',
  'EnterPlanMode',
  'ExitPlanMode',
  'Glob',
  'Grep',
  'ListMcpResourcesTool',
  'NotebookEdit',
  'Read',
  'ReadMcpResourceTool',
  'SendMessage',
  'Skill',
  'Sleep',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'TaskUpdate',
  'WebFetch',
  'WebSearch',
  'Write',
]) {
  assert(baseToolNames.has(toolName), `Core tool is missing: ${toolName}`)
}
if (process.platform === 'win32') {
  assert(baseToolNames.has('PowerShell'), 'Core tool is missing: PowerShell')
}
assert(
  ASYNC_AGENT_ALLOWED_TOOLS.has('WebSearch'),
  'Async agents cannot use WebSearch',
)
const validateWebSearch = TOOL_VALIDATION_CONFIG.customValidation.WebSearch
assert(validateWebSearch, 'WebSearch permission validation is missing')
assert(validateWebSearch('current prices').valid, 'Valid WebSearch rule was rejected')
assert(!validateWebSearch('price*').valid, 'WebSearch wildcard rule was accepted')

const commandNames = builtInCommandNames()
for (const commandName of [
  'add-dir',
  'agents',
  'clear',
  'compact',
  'config',
  'context',
  'doctor',
  'exit',
  'export',
  'help',
  'hooks',
  'init',
  'mcp',
  'memory',
  'model',
  'permissions',
  'plan',
  'rename',
  'resume',
  'rewind',
  'skills',
  'status',
  'tasks',
  'terminal-setup',
]) {
  assert(commandNames.has(commandName), `Core command is missing: /${commandName}`)
}

const agentTypes = new Set(getBuiltInAgents().map(agent => agent.agentType))
for (const agentType of ['general-purpose', 'Explore', 'Plan']) {
  assert(agentTypes.has(agentType), `Core agent is missing: ${agentType}`)
}
const guideAgent = getBuiltInAgents().find(
  agent => agent.agentType === 'claude-code-guide',
)
assert(guideAgent, 'Claude Code guide agent is missing')
assert(
  guideAgent.tools?.includes('WebSearch'),
  'Claude Code guide agent cannot use WebSearch',
)

clearBundledSkills()
initBundledSkills()
const bundledSkillNames = new Set(getBundledSkills().map(skill => skill.name))
for (const skillName of ['debug', 'remember', 'simplify', 'skillify']) {
  assert(bundledSkillNames.has(skillName), `Bundled skill is missing: ${skillName}`)
}

assert(permissionModeFromString('plan') === 'plan', 'Plan permission mode is unavailable')
assert(
  permissionModeFromString('not-a-mode') === 'default',
  'Invalid permission modes must fall back safely',
)
assert(
  toExternalPermissionMode('acceptEdits') === 'acceptEdits',
  'Permission mode conversion is broken',
)

clearAllAsyncHooks()
assert(getPendingAsyncHooks().length === 0, 'Async hook registry did not reset')

assert(
  PluginManifestSchema().safeParse({
    name: 'local-extension',
    dependencies: ['shared-tools'],
  }).success,
  'Local plugin manifest rejected a name-only dependency',
)
assert(
  !PluginManifestSchema().safeParse({
    name: 'local-extension',
    dependencies: ['shared-tools@remote-store'],
  }).success,
  'Local plugin manifest accepted a remote dependency identifier',
)

const compactPrompt = getCompactPrompt('Preserve architecture decisions')
assert(
  compactPrompt.includes('Preserve architecture decisions'),
  'Compact prompt lost custom instructions',
)
const formattedSummary = formatCompactSummary(
  '<analysis>draft only</analysis><summary>durable state</summary>',
)
assert(
  formattedSummary === 'Summary:\ndurable state',
  'Compact summary formatting is broken',
)

const apiEnvironmentNames = [
  'CLAUDE_CODE_ENABLE_FAST_MODE',
  'ANTHROPIC_BASE_URL',
] as const
const originalApiEnvironment = new Map(
  apiEnvironmentNames.map(name => [name, process.env[name]]),
)
try {
  for (const name of apiEnvironmentNames) delete process.env[name]

  assert(isFirstPartyAnthropicBaseUrl(), 'Default Anthropic URL was rejected')
  process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
  assert(
    !isFirstPartyAnthropicBaseUrl(),
    'Compatible third-party API URL was classified as first-party',
  )
  assert(
    getFastModeUnavailableReason()?.includes('requires the Anthropic API'),
    'Compatible API endpoints must not receive Anthropic Fast Mode prefetches',
  )
} finally {
  for (const [name, value] of originalApiEnvironment) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

activateProactive('smoke')
assert(isProactiveActive(), 'Proactive state did not activate')
deactivateProactive()
assert(!isProactiveActive(), 'Proactive state did not deactivate')

const ping = tool(
  'ping',
  'Framework smoke tool',
  { value: z.number() },
  async ({ value }) => ({
    content: [{ type: 'text', text: String(value) }],
  }),
)
const server = createSdkMcpServer({ name: 'framework-smoke', tools: [ping] })
assert(server.type === 'sdk', 'SDK MCP server was not created')

const tempMemory = await mkdtemp(join(tmpdir(), 'claude-core-smoke-'))
process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = tempMemory
try {
  const { writeSessionTranscriptSegment } = await import(
    '../src/services/sessionTranscript/sessionTranscript.js'
  )
  await writeSessionTranscriptSegment([
    {
      type: 'user',
      uuid: 'smoke-user',
      message: { content: 'smoke transcript' },
    },
  ])
  const now = new Date()
  const yyyy = now.getFullYear().toString()
  const mm = (now.getMonth() + 1).toString().padStart(2, '0')
  const dd = now.getDate().toString().padStart(2, '0')
  const log = await readFile(
    join(tempMemory, 'logs', yyyy, mm, `${yyyy}-${mm}-${dd}.md`),
    'utf8',
  )
  assert(log.includes('smoke transcript'), 'Session transcript was not persisted')
} finally {
  delete process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
  await rm(tempMemory, { recursive: true, force: true })
}

console.log('framework smoke: ok')
