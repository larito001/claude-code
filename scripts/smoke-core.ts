import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const value of values) result.push(value)
  return result
}

function makeHookCommand(command: string) {
  return process.platform === 'win32'
    ? ({ type: 'command', command, shell: 'powershell' } as const)
    : ({ type: 'command', command, shell: 'bash' } as const)
}

const tempRoot = await mkdtemp(join(tmpdir(), 'claude-core-chain-smoke-'))
const tempConfig = join(tempRoot, 'config')
const tempProject = join(tempRoot, 'project')
const previousEnvironment = new Map(
  [
    'FRAMEWORK_CONFIG_DIR',
    'CLAUDE_CODE_ENABLE_TASKS',
    'CLAUDE_CODE_TASK_LIST_ID',
    'CLAUDE_CODE_SIMPLE',
  ].map(name => [name, process.env[name]]),
)

process.env.FRAMEWORK_CONFIG_DIR = tempConfig
process.env.CLAUDE_CODE_ENABLE_TASKS = '1'
process.env.CLAUDE_CODE_TASK_LIST_ID = 'core-chain-smoke'
delete process.env.CLAUDE_CODE_SIMPLE

try {
  await mkdir(tempProject, { recursive: true })

  const [
    {
      setIsInteractive,
      getSessionId,
      setCwdState,
      setOriginalCwd,
      setProjectRoot,
    },
    { getDefaultAppState },
    { createFileStateCacheWithSizeLimit },
    { runWithCwdOverride },
    { FileWriteTool },
    { FileReadTool },
    { FileEditTool },
    { GlobTool },
    { GrepTool },
    { TaskCreateTool },
    { TaskUpdateTool },
    { TaskGetTool },
    { TaskListTool },
    {
      executePreToolHooks,
      executeUserPromptSubmitHooks,
    },
    {
      addSessionHook,
      clearSessionHooks,
    },
    {
      clearAgentDefinitionsCache,
      getAgentDefinitionsWithOverrides,
    },
  ] = await Promise.all([
    import('../src/bootstrap/state.js'),
    import('../src/state/AppStateStore.js'),
    import('../src/utils/fileStateCache.js'),
    import('../src/utils/cwd.js'),
    import('../src/tools/FileWriteTool/FileWriteTool.js'),
    import('../src/tools/FileReadTool/FileReadTool.js'),
    import('../src/tools/FileEditTool/FileEditTool.js'),
    import('../src/tools/GlobTool/GlobTool.js'),
    import('../src/tools/GrepTool/GrepTool.js'),
    import('../src/tools/TaskCreateTool/TaskCreateTool.js'),
    import('../src/tools/TaskUpdateTool/TaskUpdateTool.js'),
    import('../src/tools/TaskGetTool/TaskGetTool.js'),
    import('../src/tools/TaskListTool/TaskListTool.js'),
    import('../src/utils/hooks.js'),
    import('../src/utils/hooks/sessionHooks.js'),
    import('../src/tools/AgentTool/loadAgentsDir.js'),
  ])

  setIsInteractive(false)
  setOriginalCwd(tempProject)
  setProjectRoot(tempProject)
  setCwdState(tempProject)

  let appState = getDefaultAppState()
  appState = {
    ...appState,
    toolPermissionContext: {
      ...appState.toolPermissionContext,
      mode: 'acceptEdits',
    },
  }
  const getAppState = () => appState
  const setAppState = (updater: (previous: typeof appState) => typeof appState) => {
    appState = updater(appState)
  }
  const readFileState = createFileStateCacheWithSizeLimit(100)
  const abortController = new AbortController()
  const tools = [
    FileWriteTool,
    FileReadTool,
    FileEditTool,
    GlobTool,
    GrepTool,
    TaskCreateTool,
    TaskUpdateTool,
    TaskGetTool,
    TaskListTool,
  ]
  const context = {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'smoke-model',
      tools,
      verbose: false,
      thinkingConfig: { type: 'disabled' as const },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    abortController,
    readFileState,
    getAppState,
    setAppState,
    messages: [],
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
  }

  await runWithCwdOverride(tempProject, async () => {
    const sourcePath = join(tempProject, 'src', 'core.ts')
    const stalePath = join(tempProject, 'src', 'stale.ts')
    const initialContent = 'export const framework = "core"\n'

    const writeInput = { file_path: sourcePath, content: initialContent }
    assert(
      (await FileWriteTool.validateInput(writeInput, context)).result,
      'Write validation rejected a new file',
    )
    assert(
      (await FileWriteTool.checkPermissions(writeInput, context)).behavior ===
        'allow',
      'acceptEdits did not allow a project write',
    )
    const writeResult = await FileWriteTool.call(writeInput, context)
    assert(writeResult.data.type === 'create', 'Write did not create the file')
    assert(
      (await readFile(sourcePath, 'utf8')) === initialContent,
      'Write content was not persisted exactly',
    )

    const readInput = { file_path: sourcePath }
    assert(
      (await FileReadTool.validateInput(readInput, context)).result,
      'Read validation rejected a text file',
    )
    assert(
      (await FileReadTool.checkPermissions(readInput, context)).behavior ===
        'allow',
      'Project read permission was not allowed',
    )
    const firstRead = await FileReadTool.call(readInput, context)
    assert(firstRead.data.type === 'text', 'Read did not return text data')
    assert(
      firstRead.data.file.content.includes('framework'),
      'Read lost file content',
    )

    const editInput = {
      file_path: sourcePath,
      old_string: '"core"',
      new_string: '"commercial-core"',
    }
    assert(
      (await FileEditTool.validateInput(editInput, context)).result,
      'Edit validation rejected a file that had been read',
    )
    assert(
      (await FileEditTool.checkPermissions(editInput, context)).behavior ===
        'allow',
      'acceptEdits did not allow a project edit',
    )
    await FileEditTool.call(editInput, context)
    assert(
      (await readFile(sourcePath, 'utf8')).includes('commercial-core'),
      'Edit did not persist the replacement',
    )

    await writeFile(stalePath, 'export const stale = "before"\n')
    await FileReadTool.call({ file_path: stalePath }, context)
    await Bun.sleep(20)
    await writeFile(stalePath, 'export const stale = "outside"\n')
    const staleValidation = await FileEditTool.validateInput(
      {
        file_path: stalePath,
        old_string: '"before"',
        new_string: '"after"',
      },
      context,
    )
    assert(
      !staleValidation.result,
      'Edit did not reject a file modified after it was read',
    )

    const globResult = await GlobTool.call(
      { pattern: '**/*.ts', path: tempProject },
      context,
    )
    assert(
      globResult.data.filenames.some(path =>
        path.endsWith(join('src', 'core.ts')),
      ),
      'Glob did not find the created TypeScript file',
    )
    const grepResult = await GrepTool.call(
      {
        pattern: 'commercial-core',
        path: tempProject,
        output_mode: 'content',
      },
      context,
    )
    assert(
      grepResult.data.content?.includes('commercial-core'),
      'Grep did not find edited content',
    )

    const allowedPermissionContext = appState.toolPermissionContext
    appState = {
      ...appState,
      toolPermissionContext: {
        ...allowedPermissionContext,
        alwaysDenyRules: {
          session: ['Read(src/core.ts)', 'Edit(src/core.ts)'],
        },
      },
    }
    assert(
      (await FileReadTool.checkPermissions(readInput, context)).behavior ===
        'deny',
      'Explicit Read deny rule was not enforced',
    )
    assert(
      (await FileWriteTool.checkPermissions(writeInput, context)).behavior ===
        'deny',
      'Explicit Edit deny rule was not enforced for Write',
    )
    appState = { ...appState, toolPermissionContext: allowedPermissionContext }

    if (process.platform === 'win32') {
      const { PowerShellTool } = await import(
        '../src/tools/PowerShellTool/PowerShellTool.js'
      )
      const commandInput = { command: "Write-Output 'CORE_POWERSHELL_OK'" }
      assert(
        (await PowerShellTool.validateInput(commandInput)).result,
        'PowerShell validation rejected a safe command',
      )
      const commandResult = await PowerShellTool.call(commandInput, context)
      assert(
        commandResult.data.stdout.includes('CORE_POWERSHELL_OK'),
        'PowerShell tool did not execute and capture stdout',
      )
    } else {
      const { BashTool } = await import('../src/tools/BashTool/BashTool.js')
      const commandInput = { command: "printf 'CORE_BASH_OK\\n'" }
      assert(
        (await BashTool.validateInput(commandInput)).result,
        'Bash validation rejected a safe command',
      )
      const commandResult = await BashTool.call(commandInput, context)
      assert(
        commandResult.data.stdout.includes('CORE_BASH_OK'),
        'Bash tool did not execute and capture stdout',
      )
    }
  })

  const sessionId = getSessionId()
  let hookSucceeded = false
  addSessionHook(
    setAppState,
    sessionId,
    'PreToolUse',
    'Read',
    makeHookCommand(
      process.platform === 'win32'
        ? "Write-Output 'CORE_HOOK_OK'"
        : "printf 'CORE_HOOK_OK\\n'",
    ),
    () => {
      hookSucceeded = true
    },
  )
  await collect(
    executePreToolHooks('Read', 'hook-success', {}, context, 'default'),
  )
  assert(hookSucceeded, 'Successful command hook did not execute')
  clearSessionHooks(setAppState, sessionId)

  addSessionHook(
    setAppState,
    sessionId,
    'UserPromptSubmit',
    '',
    makeHookCommand(
      process.platform === 'win32'
        ? `Write-Output '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","sessionTitle":"CORE_HOOK_TITLE"}}'`
        : `printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","sessionTitle":"CORE_HOOK_TITLE"}}'`,
    ),
  )
  const promptHookResults = await collect(
    executeUserPromptSubmitHooks('smoke prompt', 'default', context),
  )
  assert(
    promptHookResults.some(result => result.sessionTitle === 'CORE_HOOK_TITLE'),
    'UserPromptSubmit hook did not return its session title',
  )
  clearSessionHooks(setAppState, sessionId)

  addSessionHook(
    setAppState,
    sessionId,
    'PreToolUse',
    'Read',
    makeHookCommand(
      process.platform === 'win32'
        ? "Write-Error 'CORE_HOOK_BLOCKED'; exit 2"
        : "printf 'CORE_HOOK_BLOCKED\\n' >&2; exit 2",
    ),
  )
  const blockedHookResults = await collect(
    executePreToolHooks('Read', 'hook-block', {}, context, 'default'),
  )
  assert(
    blockedHookResults.some(result =>
      result.blockingError?.blockingError.includes('CORE_HOOK_BLOCKED'),
    ),
    'Exit-code-2 hook did not block the tool call',
  )
  clearSessionHooks(setAppState, sessionId)

  const timeoutHook = {
    ...makeHookCommand(
      process.platform === 'win32'
        ? 'Start-Sleep -Seconds 5'
        : 'sleep 5',
    ),
    timeout: 0.05,
  }
  addSessionHook(
    setAppState,
    sessionId,
    'PreToolUse',
    'Read',
    timeoutHook,
  )
  const timeoutStart = Date.now()
  const timeoutHookResults = await collect(
    executePreToolHooks('Read', 'hook-timeout', {}, context, 'default'),
  )
  assert(Date.now() - timeoutStart < 2_500, 'Hook timeout did not stop promptly')
  assert(
    timeoutHookResults.some(
      result =>
        result.message?.type === 'attachment' &&
        result.message.attachment.type === 'hook_cancelled',
    ),
    'Timed-out hook was not reported as cancelled',
  )
  clearSessionHooks(setAppState, sessionId)

  const created = await TaskCreateTool.call(
    {
      subject: 'Verify core chain',
      description: 'Exercise task persistence and transitions',
      activeForm: 'Verifying core chain',
    },
    context,
  )
  const taskId = created.data.task.id
  assert(taskId === '1', 'Task sequence did not start with the isolated task')
  assert(appState.expandedView === 'tasks', 'Task creation did not update UI state')
  let task = (await TaskGetTool.call({ taskId }, context)).data.task
  assert(task?.status === 'pending', 'Created task was not persisted as pending')
  const running = await TaskUpdateTool.call(
    { taskId, status: 'in_progress', metadata: { smoke: true } },
    context,
  )
  assert(running.data.success, 'Task did not transition to in_progress')
  task = (await TaskGetTool.call({ taskId }, context)).data.task
  assert(task?.status === 'in_progress', 'Task transition was not persisted')
  const listed = await TaskListTool.call({}, context)
  assert(
    listed.data.tasks.some(item => item.id === taskId),
    'Task list did not include the created task',
  )
  const completed = await TaskUpdateTool.call(
    { taskId, status: 'completed' },
    context,
  )
  assert(completed.data.success, 'Task did not transition to completed')
  const deleted = await TaskUpdateTool.call(
    { taskId, status: 'deleted' },
    context,
  )
  assert(deleted.data.success, 'Task cleanup did not delete the task')
  assert(
    (await TaskGetTool.call({ taskId }, context)).data.task === null,
    'Deleted task remained readable',
  )

  const agentDir = join(tempProject, '.claude-code-core-framework', 'agents')
  await mkdir(agentDir, { recursive: true })
  await writeFile(
    join(agentDir, 'smoke-reviewer.md'),
    [
      '---',
      'name: smoke-reviewer',
      'description: Reviews the isolated smoke project',
      'tools: Read, Grep, Glob',
      'model: inherit',
      '---',
      'Review the project without modifying files.',
      '',
    ].join('\n'),
  )
  clearAgentDefinitionsCache()
  const agentDefinitions = await getAgentDefinitionsWithOverrides(tempProject)
  const agentTypes = new Set(
    agentDefinitions.activeAgents.map(agent => agent.agentType),
  )
  assert(agentTypes.has('general-purpose'), 'Built-in agent loading failed')
  assert(agentTypes.has('smoke-reviewer'), 'Custom agent loading failed')
  const customAgent = agentDefinitions.activeAgents.find(
    agent => agent.agentType === 'smoke-reviewer',
  )
  assert(
    customAgent?.tools?.includes('Read') && customAgent.model === 'inherit',
    'Custom agent metadata was not preserved',
  )
} finally {
  for (const [name, value] of previousEnvironment) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await rm(tempRoot, { recursive: true, force: true })
}

console.log('core execution chain smoke: ok')
