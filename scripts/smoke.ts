import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
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
import { getClaudeDesktopConfigPath } from '../src/utils/claudeDesktop.js'
import { initBackgroundHousekeepingServices } from '../src/utils/backgroundHousekeeping.js'
import { getFastModeUnavailableReason } from '../src/utils/fastMode.js'
import { feature } from '../src/utils/features.js'
import {
  clearAllAsyncHooks,
  getPendingAsyncHooks,
} from '../src/utils/hooks/AsyncHookRegistry.js'
import {
  getAPIProvider,
  isFirstPartyAnthropicBaseUrl,
} from '../src/utils/model/providers.js'
import {
  permissionModeFromString,
  toExternalPermissionMode,
} from '../src/utils/permissions/PermissionMode.js'
import {
  buildPluginId,
  parsePluginIdentifier,
} from '../src/utils/plugins/pluginIdentifier.js'
import { getSystemDirectories } from '../src/utils/systemDirectories.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

assert(feature('MCP_SKILLS'), 'MCP skills must be enabled in the core profile')
assert(feature('HOOK_PROMPTS'), 'Hook prompts must be enabled in the core profile')
assert(!feature('KAIROS'), 'Unsupported product features must remain disabled')

initBackgroundHousekeepingServices()

const baseToolNames = new Set(getAllBaseTools().map(toolDefinition => toolDefinition.name))
for (const toolName of ['Read', 'Edit', 'Write', 'Bash', 'Agent', 'Skill']) {
  assert(baseToolNames.has(toolName), `Core tool is missing: ${toolName}`)
}

const commandNames = builtInCommandNames()
for (const commandName of [
  'compact',
  'hooks',
  'mcp',
  'permissions',
  'plugin',
  'resume',
]) {
  assert(commandNames.has(commandName), `Core command is missing: /${commandName}`)
}

const agentTypes = new Set(getBuiltInAgents().map(agent => agent.agentType))
for (const agentType of ['general-purpose', 'Explore', 'Plan']) {
  assert(agentTypes.has(agentType), `Core agent is missing: ${agentType}`)
}

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

const parsedPlugin = parsePluginIdentifier('example@marketplace')
assert(
  parsedPlugin.name === 'example' && parsedPlugin.marketplace === 'marketplace',
  'Plugin identifier parsing is broken',
)
assert(
  buildPluginId(parsedPlugin.name, parsedPlugin.marketplace) ===
    'example@marketplace',
  'Plugin identifier formatting is broken',
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

const windowsDirectories = getSystemDirectories({
  platform: 'windows',
  homedir: 'C:\\Users\\fallback',
  env: { USERPROFILE: 'D:\\Profiles\\framework' },
})
assert(isAbsolute(windowsDirectories.HOME), 'Windows home path is not absolute')
assert(
  windowsDirectories.DESKTOP === join('D:\\Profiles\\framework', 'Desktop'),
  'Windows system-directory mapping is broken',
)

if (process.platform === 'win32') {
  const desktopConfigPath = await getClaudeDesktopConfigPath()
  assert(
    basename(desktopConfigPath) === 'claude_desktop_config.json',
    'Native Windows Claude Desktop MCP config path is broken',
  )
}

const providerEnvironmentNames = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_ENABLE_FAST_MODE',
  'ANTHROPIC_BASE_URL',
] as const
const originalProviderEnvironment = new Map(
  providerEnvironmentNames.map(name => [name, process.env[name]]),
)
try {
  for (const name of providerEnvironmentNames) delete process.env[name]
  assert(getAPIProvider() === 'firstParty', 'Default API provider is incorrect')
  process.env.CLAUDE_CODE_USE_BEDROCK = '1'
  assert(getAPIProvider() === 'bedrock', 'Bedrock provider selection is broken')
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  process.env.CLAUDE_CODE_USE_VERTEX = '1'
  assert(getAPIProvider() === 'vertex', 'Vertex provider selection is broken')
  delete process.env.CLAUDE_CODE_USE_VERTEX
  process.env.CLAUDE_CODE_USE_FOUNDRY = '1'
  assert(getAPIProvider() === 'foundry', 'Foundry provider selection is broken')
  delete process.env.CLAUDE_CODE_USE_FOUNDRY

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
  for (const [name, value] of originalProviderEnvironment) {
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
