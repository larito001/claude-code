import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Ajv } from 'ajv'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function includesMarker(value: unknown, marker: string): boolean {
  return JSON.stringify(value).includes(marker)
}

const tempRoot = await mkdtemp(join(tmpdir(), 'claude-extensions-smoke-'))
const tempConfig = join(tempRoot, 'config')
const tempProject = join(tempRoot, 'project')
const pluginRoot = join(tempRoot, 'core-extension')
const dependentPluginRoot = join(tempRoot, 'dependent-extension')
const missingPluginRoot = join(tempRoot, 'missing-plugin')
const mcpFixture = resolve(import.meta.dir, 'fixtures/mcp-smoke-server.ts')
const previousEnvironment = new Map(
  ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_SIMPLE', 'LOCAL_PLUGIN_SMOKE_VALUE'].map(name => [
    name,
    process.env[name],
  ]),
)

process.env.CLAUDE_CONFIG_DIR = tempConfig
delete process.env.CLAUDE_CODE_SIMPLE
process.env.LOCAL_PLUGIN_SMOKE_VALUE = 'LOCAL_PLUGIN_ENV_OK'

try {
  await Promise.all([
    mkdir(join(tempProject, '.claude', 'skills', 'framework-quality'), {
      recursive: true,
    }),
    mkdir(join(pluginRoot, '.claude-plugin'), { recursive: true }),
    mkdir(join(pluginRoot, 'commands'), { recursive: true }),
    mkdir(join(pluginRoot, 'agents'), { recursive: true }),
    mkdir(join(pluginRoot, 'skills', 'quality'), { recursive: true }),
    mkdir(join(pluginRoot, 'hooks'), { recursive: true }),
    mkdir(join(pluginRoot, 'output-styles'), { recursive: true }),
    mkdir(join(dependentPluginRoot, '.claude-plugin'), { recursive: true }),
  ])

  await Promise.all([
    writeFile(
      join(tempProject, '.claude', 'skills', 'framework-quality', 'SKILL.md'),
      [
        '---',
        'name: framework-quality',
        'description: Verify the framework quality chain',
        'allowed-tools: Read, Grep',
        '---',
        'PROJECT_SKILL_OK $ARGUMENTS',
      ].join('\n'),
    ),
    writeFile(
      join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify(
        {
          name: 'core-extension',
          version: '1.0.0',
          description: 'Extension-chain smoke plugin',
        },
        null,
        2,
      ),
    ),
    writeFile(
      join(pluginRoot, 'commands', 'hello.md'),
      [
        '---',
        'description: Exercise a plugin command',
        'allowed-tools: Read',
        '---',
        'PLUGIN_COMMAND_OK $ARGUMENTS',
      ].join('\n'),
    ),
    writeFile(
      join(pluginRoot, 'agents', 'reviewer.md'),
      [
        '---',
        'name: reviewer',
        'description: Review the commercial framework',
        'tools: Read, Grep',
        'model: inherit',
        '---',
        'PLUGIN_AGENT_OK ${CLAUDE_PLUGIN_ROOT}',
      ].join('\n'),
    ),
    writeFile(
      join(pluginRoot, 'skills', 'quality', 'SKILL.md'),
      [
        '---',
        'name: quality',
        'description: Verify a commercial extension skill',
        'allowed-tools: Read, Grep',
        '---',
        'PLUGIN_SKILL_OK ${CLAUDE_SKILL_DIR} $ARGUMENTS',
      ].join('\n'),
    ),
    writeFile(
      join(pluginRoot, 'hooks', 'hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: 'echo LOCAL_PLUGIN_HOOK_OK' }] },
          ],
        },
      }),
    ),
    writeFile(
      join(pluginRoot, 'output-styles', 'commercial.md'),
      [
        '---',
        'name: commercial',
        'description: Commercial framework output style',
        '---',
        'LOCAL_PLUGIN_OUTPUT_STYLE_OK',
      ].join('\n'),
    ),
    writeFile(
      join(pluginRoot, '.mcp.json'),
      JSON.stringify({
        local: {
          type: 'stdio',
          command: process.execPath,
          args: [
            '${CLAUDE_PLUGIN_ROOT}/server.ts',
            '${CLAUDE_PLUGIN_DATA}',
            '${LOCAL_PLUGIN_SMOKE_VALUE}',
          ],
        },
      }),
    ),
    writeFile(
      join(pluginRoot, '.lsp.json'),
      JSON.stringify({
        local: {
          command: process.execPath,
          args: ['${CLAUDE_PLUGIN_ROOT}/language-server.ts'],
          extensionToLanguage: { '.core': 'core' },
          env: { SMOKE_VALUE: '${LOCAL_PLUGIN_SMOKE_VALUE}' },
        },
      }),
    ),
    writeFile(
      join(dependentPluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'dependent-extension',
        dependencies: ['missing-local-extension'],
      }),
    ),
  ])

  const [
    {
      setCwdState,
      setInlinePlugins,
      setIsInteractive,
      setOriginalCwd,
      setProjectRoot,
    },
    { getDefaultAppState },
    { createFileStateCacheWithSizeLimit },
    { createAssistantMessage },
    {
      clearServerCache,
      connectToServer,
      fetchCommandsForClient,
      fetchResourcesForClient,
      fetchToolsForClient,
    },
    {
      clearPluginCache,
      loadAllPluginsCacheOnly,
    },
    {
      clearPluginCommandCache,
      clearPluginSkillsCache,
      getPluginCommands,
      getPluginSkills,
    },
    { clearPluginAgentCache, loadPluginAgents },
    { getPluginMcpServers },
    { getPluginLspServers },
    { clearPluginOutputStyleCache, loadPluginOutputStyles },
    { clearCommandsCache, getCommands },
    { SkillTool },
    { enableConfigs },
    { normalizeMcpServerForPlatform },
  ] = await Promise.all([
    import('../src/bootstrap/state.js'),
    import('../src/state/AppStateStore.js'),
    import('../src/utils/fileStateCache.js'),
    import('../src/utils/messages.js'),
    import('../src/services/mcp/client.js'),
    import('../src/utils/plugins/pluginLoader.js'),
    import('../src/utils/plugins/loadPluginCommands.js'),
    import('../src/utils/plugins/loadPluginAgents.js'),
    import('../src/utils/plugins/mcpPluginIntegration.js'),
    import('../src/utils/plugins/lspPluginIntegration.js'),
    import('../src/utils/plugins/loadPluginOutputStyles.js'),
    import('../src/commands.js'),
    import('../src/tools/SkillTool/SkillTool.js'),
    import('../src/utils/config.js'),
    import('../src/services/mcp/config.js'),
  ])

  enableConfigs()
  setIsInteractive(false)
  setOriginalCwd(tempProject)
  setProjectRoot(tempProject)
  setCwdState(tempProject)
  setInlinePlugins([pluginRoot, dependentPluginRoot, missingPluginRoot])
  clearPluginCache('extension-chain smoke setup')
  clearPluginCommandCache()
  clearPluginSkillsCache()
  clearPluginAgentCache()
  clearPluginOutputStyleCache()
  clearCommandsCache()

  const windowsNpx = normalizeMcpServerForPlatform(
    {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@example/mcp-server'],
    },
    'windows',
  )
  assert(
    'command' in windowsNpx &&
      /(?:^|[\\/])cmd(?:\.exe)?$/i.test(windowsNpx.command) &&
      windowsNpx.args?.slice(-3).join('\0') ===
        ['npx', '-y', '@example/mcp-server'].join('\0'),
    'Windows npx MCP command was not normalized through cmd.exe',
  )
  const linuxNpx = normalizeMcpServerForPlatform(
    { type: 'stdio', command: 'npx', args: ['server'] },
    'linux',
  )
  assert(
    'command' in linuxNpx && linuxNpx.command === 'npx',
    'Non-Windows MCP command was changed unexpectedly',
  )

  const mcpConfig = {
    type: 'stdio' as const,
    command: process.execPath,
    args: ['run', mcpFixture],
    scope: 'dynamic' as const,
  }
  const connection = await connectToServer('core-smoke', mcpConfig)
  assert(
    connection.type === 'connected',
    `MCP stdio server did not connect: ${
      connection.type === 'failed' ? connection.error : connection.type
    }`,
  )
  assert(
    connection.serverInfo?.name === 'core-smoke-server',
    'MCP initialization lost server metadata',
  )

  const [mcpTools, mcpResources, mcpCommands] = await Promise.all([
    fetchToolsForClient(connection),
    fetchResourcesForClient(connection),
    fetchCommandsForClient(connection),
  ])
  const echoTool = mcpTools.find(tool => tool.name === 'mcp__core-smoke__echo')
  assert(echoTool, 'MCP tool discovery lost the echo tool')
  assert(echoTool.isReadOnly(), 'MCP read-only annotation was not preserved')
  assert(
    mcpResources.some(
      resource =>
        resource.server === 'core-smoke' &&
        resource.uri === 'smoke://framework',
    ),
    'MCP resource discovery lost server ownership',
  )
  const mcpPrompt = mcpCommands.find(
    command => command.name === 'mcp__core-smoke__core-review',
  )
  assert(mcpPrompt?.type === 'prompt', 'MCP prompt discovery failed')

  let appState = getDefaultAppState()
  appState = {
    ...appState,
    mcp: { ...appState.mcp, commands: mcpCommands },
  }
  const getAppState = () => appState
  const setAppState = (updater: (previous: typeof appState) => typeof appState) => {
    appState = updater(appState)
  }
  const context = {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'smoke-model',
      tools: [echoTool, SkillTool],
      verbose: false,
      thinkingConfig: { type: 'disabled' as const },
      mcpClients: [connection],
      mcpResources: { 'core-smoke': mcpResources },
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(100),
    getAppState,
    setAppState,
    messages: [],
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  }
  const parentMessage = createAssistantMessage({
    content: [
      {
        type: 'tool_use',
        id: 'extensions-smoke-tool-use',
        name: 'Skill',
        input: { skill: 'core-extension:quality' },
      },
    ],
  })

  assert(echoTool.inputJSONSchema, 'MCP tool lost its JSON input schema')
  const validateEcho = new Ajv().compile(echoTool.inputJSONSchema)
  assert(validateEcho({ value: 'framework' }), 'MCP schema rejected valid input')
  assert(!validateEcho({}), 'MCP schema accepted missing required input')
  const echoResult = await echoTool.call(
    { value: 'framework' },
    context,
    undefined,
    parentMessage,
  )
  assert(
    includesMarker(echoResult.data, 'framework'),
    `MCP tool call did not return the server response: ${JSON.stringify(
      echoResult.data,
    )}`,
  )
  assert(
    includesMarker(echoResult.mcpMeta, 'framework'),
    'MCP structured content metadata was not preserved',
  )
  let invalidCallRejected = false
  try {
    await echoTool.call({}, context, undefined, parentMessage)
  } catch (error) {
    invalidCallRejected = String(error).includes('value must be a string')
  }
  assert(
    invalidCallRejected,
    'MCP server did not reject an invalid direct tool call',
  )
  const resourceResult = await connection.client.readResource({
    uri: 'smoke://framework',
  })
  assert(
    includesMarker(resourceResult, 'MCP_RESOURCE_OK'),
    'MCP resource read did not reach the server',
  )
  const promptResult = await mcpPrompt.getPromptForCommand('repository', context)
  assert(
    includesMarker(promptResult, 'MCP_PROMPT_OK:repository'),
    'MCP prompt execution did not reach the server',
  )

  const pluginResult = await loadAllPluginsCacheOnly()
  const plugin = pluginResult.enabled.find(item => item.name === 'core-extension')
  assert(plugin, 'Inline plugin was not enabled')
  assert(
    pluginResult.errors.some(error => error.type === 'path-not-found'),
    'Missing inline plugin did not produce an isolated load error',
  )
  assert(
    pluginResult.disabled.some(item => item.name === 'dependent-extension') &&
      pluginResult.errors.some(error => error.type === 'dependency-unsatisfied'),
    'Missing local dependency did not demote only the dependent plugin',
  )
  assert(
    plugin.hooksConfig?.SessionStart?.some(matcher =>
      matcher.hooks.some(hook =>
        'command' in hook && hook.command.includes('LOCAL_PLUGIN_HOOK_OK'),
      ),
    ),
    'Local plugin hooks were not loaded',
  )
  const integrationErrors: typeof pluginResult.errors = []
  const [pluginMcpServers, pluginLspServers, pluginOutputStyles] =
    await Promise.all([
      getPluginMcpServers(plugin, integrationErrors),
      getPluginLspServers(plugin, integrationErrors),
      loadPluginOutputStyles(),
    ])
  const localPluginMcp = pluginMcpServers?.['plugin:core-extension:local']
  assert(
    localPluginMcp &&
      'args' in localPluginMcp &&
      localPluginMcp.args?.some(arg =>
        arg.replace(/\\/g, '/').includes(pluginRoot.replace(/\\/g, '/')),
      ) &&
      localPluginMcp.args?.some(arg =>
        arg.replace(/\\/g, '/').includes('/plugin-data/local-core-extension'),
      ) &&
      localPluginMcp.args?.includes('LOCAL_PLUGIN_ENV_OK'),
    'Local plugin MCP configuration did not expand root and environment values',
  )
  const localPluginLsp = pluginLspServers?.['plugin:core-extension:local']
  assert(
    localPluginLsp?.args?.some(arg =>
      arg.replace(/\\/g, '/').includes(pluginRoot.replace(/\\/g, '/')),
    ) && localPluginLsp.env?.SMOKE_VALUE === 'LOCAL_PLUGIN_ENV_OK',
    'Local plugin LSP configuration did not expand root and environment values',
  )
  assert(
    integrationErrors.length === 0,
    `Local plugin integration produced errors: ${JSON.stringify(integrationErrors)}`,
  )
  assert(
    pluginOutputStyles.some(
      style =>
        style.name === 'core-extension:commercial' &&
        style.prompt.includes('LOCAL_PLUGIN_OUTPUT_STYLE_OK'),
    ),
    'Local plugin output style was not loaded',
  )
  const [pluginCommands, pluginSkills, pluginAgents] = await Promise.all([
    getPluginCommands(),
    getPluginSkills(),
    loadPluginAgents(),
  ])
  const pluginCommand = pluginCommands.find(
    command => command.name === 'core-extension:hello',
  )
  const pluginSkill = pluginSkills.find(
    command => command.name === 'core-extension:quality',
  )
  const pluginAgent = pluginAgents.find(
    agent => agent.agentType === 'core-extension:reviewer',
  )
  assert(pluginCommand?.type === 'prompt', 'Plugin command was not loaded')
  assert(pluginSkill?.type === 'prompt', 'Plugin skill was not loaded')
  assert(pluginAgent, 'Plugin agent was not loaded')
  assert(
    includesMarker(
      await pluginCommand.getPromptForCommand('commercial', context),
      'PLUGIN_COMMAND_OK commercial',
    ),
    'Plugin command arguments were not substituted',
  )
  assert(
    pluginAgent.getSystemPrompt().includes('PLUGIN_AGENT_OK') &&
      pluginAgent
        .getSystemPrompt()
        .replace(/\\/g, '/')
        .includes(pluginRoot.replace(/\\/g, '/')),
    `Plugin agent root substitution failed: ${pluginAgent.getSystemPrompt()}`,
  )

  const commands = await getCommands(tempProject)
  assert(
    commands.some(command => command.name === 'framework-quality'),
    'Project skill was not discovered',
  )
  assert(
    commands.some(command => command.name === 'core-extension:quality'),
    'Plugin skill was not merged into the command registry',
  )

  const skillInput = { skill: 'core-extension:quality', args: 'commercial' }
  assert(
    (await SkillTool.validateInput(skillInput, context)).result,
    'SkillTool rejected a loaded plugin skill',
  )
  assert(
    (await SkillTool.checkPermissions(skillInput, context)).behavior === 'ask',
    'Third-party plugin skill bypassed the initial trust boundary',
  )
  appState = {
    ...appState,
    toolPermissionContext: {
      ...appState.toolPermissionContext,
      alwaysAllowRules: {
        ...appState.toolPermissionContext.alwaysAllowRules,
        session: [
          ...(appState.toolPermissionContext.alwaysAllowRules.session ?? []),
          'Skill(core-extension:quality)',
        ],
      },
    },
  }
  assert(
    (await SkillTool.checkPermissions(skillInput, context)).behavior === 'allow',
    'Explicit plugin-skill permission was not enforced',
  )
  const skillResult = await SkillTool.call(
    skillInput,
    context,
    undefined,
    parentMessage,
  )
  assert(skillResult.data.success, 'SkillTool did not complete successfully')
  assert(
    includesMarker(skillResult.newMessages, 'PLUGIN_SKILL_OK') &&
      includesMarker(skillResult.newMessages, 'commercial') &&
      includesMarker(skillResult.newMessages, 'extensions-smoke-tool-use'),
    'SkillTool did not inject the expanded skill prompt with tool-use linkage',
  )
  assert(
    !(await SkillTool.validateInput({ skill: 'missing-skill' }, context)).result,
    'SkillTool accepted an unknown skill',
  )

  const failedConfig = {
    type: 'stdio' as const,
    command: `missing-mcp-binary-${Date.now()}`,
    args: [],
    scope: 'dynamic' as const,
  }
  const failedConnection = await connectToServer('missing-smoke', failedConfig)
  assert(
    failedConnection.type === 'failed',
    'MCP missing-command failure was not contained as a failed connection',
  )

  await Promise.all([
    clearServerCache('core-smoke', mcpConfig),
    clearServerCache('missing-smoke', failedConfig),
  ])
  console.log('Extension smoke passed: MCP + plugins + skills')
} finally {
  for (const [name, value] of previousEnvironment) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await rm(tempRoot, { recursive: true, force: true })
}
