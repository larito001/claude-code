import { feature } from 'src/utils/features.js'
import type { UUID } from 'crypto'
import { randomUUID } from 'crypto'
import uniqBy from 'lodash-es/uniqBy.js'
import { logForDebugging } from 'src/utils/debug.js'
import { getProjectRoot, getSessionId } from '../../bootstrap/state.js'
import { getCommand, getSkillToolCommands, hasCommand } from '../../commands.js'
import {
  DEFAULT_AGENT_PROMPT,
  enhanceSystemPromptWithEnvDetails,
} from '../../constants/prompts.js'
import type { QuerySource } from '../../constants/querySource.js'
import { getSystemContext, getUserContext } from '../../context.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { query } from '../../query.js'
import { getFeatureValue } from '../../services/featureConfig.js'
import { cleanupAgentTracking } from '../../services/api/promptCacheBreakDetection.js'
import {
  connectToServer,
  fetchToolsForClient,
} from '../../services/mcp/client.js'
import { getMcpConfigByName } from '../../services/mcp/config.js'
import type {
  MCPServerConnection,
  ScopedMcpServerConfig,
} from '../../services/mcp/types.js'
import type { Tool, Tools, ToolUseContext } from '../../Tool.js'
import { killShellTasksForAgent } from '../../tasks/LocalShellTask/killShellTasks.js'
import type { Command } from '../../types/command.js'
import type { AgentId } from '../../types/ids.js'
import type {
  AssistantMessage,
  Message,
  ProgressMessage,
  RequestStartEvent,
  StreamEvent,
  SystemCompactBoundaryMessage,
  TombstoneMessage,
  ToolUseSummaryMessage,
  UserMessage,
} from '../../types/message.js'
import { createAttachmentMessage } from '../../utils/attachments.js'
import { AbortError } from '../../utils/errors.js'
import {
  cloneFileStateCache,
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from '../../utils/fileStateCache.js'
import {
  type CacheSafeParams,
  createSubagentContext,
} from '../../utils/forkedAgent.js'
import { registerFrontmatterHooks } from '../../utils/hooks/registerFrontmatterHooks.js'
import { clearSessionHooks } from '../../utils/hooks/sessionHooks.js'
import { executeSubagentStartHooks } from '../../utils/hooks.js'
import { createUserMessage } from '../../utils/messages.js'
import { getAgentModel } from '../../utils/model/agent.js'
import type { ModelAlias } from '../../utils/model/aliases.js'
import {
  clearAgentTranscriptSubdir,
  recordSidechainTranscript,
  setAgentTranscriptSubdir,
  writeAgentMetadata,
} from '../../utils/sessionStorage.js'
import {
  isRestrictedToPluginOnly,
  isSourceAdminTrusted,
} from '../../utils/settings/pluginOnlyPolicy.js'
import {
  asSystemPrompt,
  type SystemPrompt,
} from '../../utils/systemPromptType.js'
import {
  isPerfettoTracingEnabled,
  registerAgent as registerPerfettoAgent,
  unregisterAgent as unregisterPerfettoAgent,
} from '../../utils/telemetry/perfettoTracing.js'
import type { ContentReplacementState } from '../../utils/toolResultStorage.js'
import { createAgentId } from '../../utils/uuid.js'
import { resolveAgentTools } from './agentToolUtils.js'
import { type AgentDefinition, isBuiltInAgent } from './loadAgentsDir.js'

/**
 * 初始化代理特定的MCP服务器
 * 代理可以在其前置元数据中定义自己的MCP服务器，这些服务器是对父级MCP客户端的补充。这些服务器在代理启动时连接，在代理结束时清理。
 *
 * @param agentDefinition 包含可选的mcpServers的代理定义
 * @param parentClients 从父级上下文继承的MCP客户端
 * @returns 合并后的客户端（父级+代理特定）、代理MCP工具和清理函数
 */
async function initializeAgentMcpServers(
  agentDefinition: AgentDefinition,
  parentClients: MCPServerConnection[],
): Promise<{
  clients: MCPServerConnection[]
  tools: Tools
  /** 规范化 cleanup 对应的数据或状态。 */
  cleanup: () => Promise<void>
}> {
  // 如果没有定义代理特定的服务器，则按原样返回父级客户端
  if (!agentDefinition.mcpServers?.length) {
    return {
      clients: parentClients,
      tools: [],
      /** 规范化 cleanup 对应的数据或状态。 */
      cleanup: async () => {},
    }
  }

  // 当MCP锁定为仅插件模式时，仅对USER-CONTROLLED代理跳过前置元数据MCP服务器。插件、内置和policySettings代理是管理员信任的——它们的前置元数据MCP属于管理员批准的表面。阻止它们（就像初次实现那样）会破坏合法需要MCP的插件代理，与“插件提供的始终加载”相矛盾。
  const agentIsAdminTrusted = isSourceAdminTrusted(agentDefinition.source)
  if (isRestrictedToPluginOnly('mcp') && !agentIsAdminTrusted) {
    logForDebugging(
      `[Agent: ${agentDefinition.agentType}] Skipping MCP servers: strictPluginOnlyCustomization locks MCP to plugin-only (agent source: ${agentDefinition.source})`,
    )
    return {
      clients: parentClients,
      tools: [],
      /** 规范化 cleanup 对应的数据或状态。 */
      cleanup: async () => {},
    }
  }

  const agentClients: MCPServerConnection[] = []
  // 跟踪哪些客户端是新建的（内联定义）vs. 从父级共享的
  // 只有当代理结束时才应清理新建的客户端
  const newlyCreatedClients: MCPServerConnection[] = []
  const agentTools: Tool[] = []

  for (const spec of agentDefinition.mcpServers) {
    let config: ScopedMcpServerConfig | null = null
    let name: string
    let isNewlyCreated = false

    if (typeof spec === 'string') {
      // 按名称引用——在现有的MCP配置中查找
      // 这使用记忆化的connectToServer，所以我们可能得到一个共享的客户端
      name = spec
      config = getMcpConfigByName(spec)
      if (!config) {
        logForDebugging(
          `[Agent: ${agentDefinition.agentType}] MCP server not found: ${spec}`,
          { level: 'warn' },
        )
        continue
      }
    } else {
      // 内联定义为 { [name]: config }
      // 这些是代理特定的服务器，应该被清理
      const entries = Object.entries(spec)
      if (entries.length !== 1) {
        logForDebugging(
          `[Agent: ${agentDefinition.agentType}] Invalid MCP server spec: expected exactly one key`,
          { level: 'warn' },
        )
        continue
      }
      const [serverName, serverConfig] = entries[0]!
      name = serverName
      config = {
        ...serverConfig,
        scope: 'dynamic' as const,
      } as ScopedMcpServerConfig
      isNewlyCreated = true
    }

    // 连接到服务器
    const client = await connectToServer(name, config)
    agentClients.push(client)
    if (isNewlyCreated) {
      newlyCreatedClients.push(client)
    }

    // 如果已连接，则获取工具
    if (client.type === 'connected') {
      const tools = await fetchToolsForClient(client)
      agentTools.push(...tools)
      logForDebugging(
        `[Agent: ${agentDefinition.agentType}] Connected to MCP server '${name}' with ${tools.length} tools`,
      )
    } else {
      logForDebugging(
        `[Agent: ${agentDefinition.agentType}] Failed to connect to MCP server '${name}': ${client.type}`,
        { level: 'warn' },
      )
    }
  }

  // 为代理特定服务器创建清理函数
  // 只清理新建的客户端（内联定义），不清理共享/引用的客户端
  // 共享的客户端（通过字符串名称引用）是记忆化的，并被父级上下文使用
  const cleanup = async () => {
    for (const client of newlyCreatedClients) {
      if (client.type === 'connected') {
        try {
          await client.cleanup()
        } catch (error) {
          logForDebugging(
            `[Agent: ${agentDefinition.agentType}] Error cleaning up MCP server '${client.name}': ${error}`,
            { level: 'warn' },
          )
        }
      }
    }
  }

  // 返回合并后的客户端（父级+代理特定）和代理工具
  return {
    clients: [...parentClients, ...agentClients],
    tools: agentTools,
    cleanup,
  }
}

type QueryMessage =
  | StreamEvent
  | RequestStartEvent
  | Message
  | ToolUseSummaryMessage
  | TombstoneMessage

/**
 * 类型守卫，用于检查来自query()的消息是否为可记录的Message类型。
 * 匹配我们要记录的类型：assistant、user、progress或system compact_boundary。
 */
function isRecordableMessage(
  msg: QueryMessage,
): msg is
  | AssistantMessage
  | UserMessage
  | ProgressMessage
  | SystemCompactBoundaryMessage {
  return (
    msg.type === 'assistant' ||
    msg.type === 'user' ||
    msg.type === 'progress' ||
    (msg.type === 'system' &&
      'subtype' in msg &&
      msg.subtype === 'compact_boundary')
  )
}

/** 执行 run Agent 对应的数据或状态。 */
export async function* runAgent({
  agentDefinition,
  promptMessages,
  toolUseContext,
  canUseTool,
  isAsync,
  canShowPermissionPrompts,
  forkContextMessages,
  querySource,
  override,
  model,
  maxTurns,
  preserveToolUseResults,
  availableTools,
  allowedTools,
  onCacheSafeParams,
  contentReplacementState,
  useExactTools,
  worktreePath,
  description,
  transcriptSubdir,
  onQueryProgress,
}: {
  agentDefinition: AgentDefinition
  promptMessages: Message[]
  toolUseContext: ToolUseContext
  canUseTool: CanUseToolFn
  isAsync: boolean
  /**
   * 此代理是否可以显示权限提示。默认为 !isAsync。
   * 对于异步运行但共享终端的进程内队友，设置为true。
   */
  canShowPermissionPrompts?: boolean
  forkContextMessages?: Message[]
  querySource: QuerySource
  override?: {
    userContext?: { [k: string]: string }
    systemContext?: { [k: string]: string }
    systemPrompt?: SystemPrompt
    abortController?: AbortController
    agentId?: AgentId
  }
  model?: ModelAlias
  maxTurns?: number
  /** 为具有可查看对话记录的子代理保留消息上的toolUseResult */
  preserveToolUseResults?: boolean
  /**
   * 为工作代理预计算的工具池。由调用者（AgentTool.tsx）计算，以避免runAgent和tools.ts之间的循环依赖。
   * 始终包含根据工作者自己的权限模式组装的完整工具池，独立于父级的工具限制。
   */
  availableTools: Tools
  /**
   * 要添加到代理会话允许规则中的工具权限规则。
   * 提供时，替换所有允许规则，使代理仅拥有明确列出的权限（父级审批不会渗入）。
   */
  allowedTools?: string[]
  /**
   * 在构造代理的系统提示、上下文和工具之后，用CacheSafeParams调用的可选回调。
   * 由背景摘要使用，以分岔代理的对话用于定期进度摘要。
   */
  onCacheSafeParams?: (params: CacheSafeParams) => void
  /**
   * 从恢复的侧链对话记录重建的替换状态，以便相同的工具结果被重新替换（提示缓存稳定性）。
   * 省略时，createSubagentContext克隆父级状态。
   */
  contentReplacementState?: ContentReplacementState
  /**
   * 为true时，直接使用availableTools而不通过resolveAgentTools()过滤。还继承父级的thinkingConfig和isNonInteractiveSession，而不是覆盖它们。由fork子代理路径使用，以为提示缓存命中产生字节相同的API请求前缀。
   */
  useExactTools?: boolean
  /** 若代理以隔离方式生成："worktree"时的工作树路径。持久化到元数据，以便恢复可以恢复正确的cwd。 */
  worktreePath?: string
  /** 来自AgentTool输入的原始任务描述。持久化到元数据，以便恢复的代理通知可以显示原始描述。 */
  description?: string
  /** subagents/下的可选子目录，用于将此代理的对话记录与相关的对话记录分组（例如，工作流子代理的workflows/<runId>）。 */
  transcriptSubdir?: string
  /** 在query()产生的每条消息上调用的可选回调——包括runAgent否则会丢弃的stream_event增量。用于在长时间的单块流（例如，思考）期间检测活跃性，在此类流中超过60秒没有产生助手消息。 */
  onQueryProgress?: () => void
}): AsyncGenerator<Message, void> {
  // 跟踪子代理使用情况以进行特性发现

  const appState = toolUseContext.getAppState()
  const permissionMode = appState.toolPermissionContext.mode
  // 始终共享到根AppState存储的通道。当*父级*本身是异步代理（嵌套异步→异步）时，toolUseContext.setAppState是无操作，因此会话作用域的写入（钩子、bash任务）必须通过此通道。
  const rootSetAppState =
    toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState

  const resolvedAgentModel = getAgentModel(
    agentDefinition.model,
    toolUseContext.options.mainLoopModel,
    model,
    permissionMode,
  )

  const agentId = override?.agentId ? override.agentId : createAgentId()

  // 如果请求，将此代理的记录路由到分组子目录中（例如，工作流子代理写入 subagents/workflows/<runId>/）。
  if (transcriptSubdir) {
    setAgentTranscriptSubdir(agentId, transcriptSubdir)
  }

  // 在 Perfetto 跟踪中注册代理以实现层级可视化。
  if (isPerfettoTracingEnabled()) {
    const parentId = toolUseContext.agentId ?? getSessionId()
    registerPerfettoAgent(agentId, agentDefinition.agentType, parentId)
  }

  // 处理上下文共享的消息分叉。从父消息中过滤掉不完整的工具调用以避免 API 错误。
  const contextMessages: Message[] = forkContextMessages
    ? filterIncompleteToolCalls(forkContextMessages)
    : []
  const initialMessages: Message[] = [...contextMessages, ...promptMessages]

  const agentReadFileState =
    forkContextMessages !== undefined
      ? cloneFileStateCache(toolUseContext.readFileState)
      : createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)

  const [baseUserContext, baseSystemContext] = await Promise.all([
    override?.userContext ?? getUserContext(),
    override?.systemContext ?? getSystemContext(),
  ])

  // 只读代理（Explore, Plan）不对来自 CLAUDE.md 的 commit/PR/lint 规则进行操作——主代理拥有完整上下文并解释它们的输出。在此处丢弃 claudeMd 可在 3400 万+ 次 Explore 生成中每周节省约 5-15 Gtok。来自调用者的显式 override.userContext 保持原样。开关默认 true；设置 tengu_slim_subagent_claudemd=false 以还原。
  const shouldOmitClaudeMd =
    agentDefinition.omitClaudeMd &&
    !override?.userContext &&
    getFeatureValue('tengu_slim_subagent_claudemd', true)
  const { claudeMd: _omittedClaudeMd, ...userContextNoClaudeMd } =
    baseUserContext
  const resolvedUserContext = shouldOmitClaudeMd
    ? userContextNoClaudeMd
    : baseUserContext

  // Explore/Plan 是只读搜索代理——父会话启动时的 gitStatus（最多 40KB，明确标记为过期）是多余的。如果它们需要 git 信息，它们会自己运行 `git status` 并获取新数据。在整个网络中每周节省约 1-3 Gtok。
  const { gitStatus: _omittedGitStatus, ...systemContextNoGit } =
    baseSystemContext
  const resolvedSystemContext =
    agentDefinition.agentType === 'Explore' ||
    agentDefinition.agentType === 'Plan'
      ? systemContextNoGit
      : baseSystemContext

  // 如果代理定义了权限模式，则覆盖该模式。但是，如果父模式处于 bypassPermissions 或 acceptEdits 模式，则不要覆盖——这些模式应始终优先。对于异步代理，还要设置 shouldAvoidPermissionPrompts，因为它们无法显示 UI。
  const agentPermissionMode = agentDefinition.permissionMode
  /** 执行 agent Get App State 对应的业务处理。 */
  const agentGetAppState = () => {
    const state = toolUseContext.getAppState()
    let toolPermissionContext = state.toolPermissionContext

    // 如果代理定义了权限模式则覆盖（除非父模式是 bypassPermissions, acceptEdits 或 auto）。
    if (
      agentPermissionMode &&
      state.toolPermissionContext.mode !== 'bypassPermissions' &&
      state.toolPermissionContext.mode !== 'acceptEdits' &&
      !(
        feature('TRANSCRIPT_CLASSIFIER') &&
        state.toolPermissionContext.mode === 'auto'
      )
    ) {
      toolPermissionContext = {
        ...toolPermissionContext,
        mode: agentPermissionMode,
      }
    }

    // 为无法显示 UI 的代理设置自动拒绝提示的标志。如果提供了显式的 canShowPermissionPrompts 则使用它，否则：- bubble 模式：始终显示提示（冒泡到父终端）- 默认：!isAsync（同步代理显示提示，异步代理不显示）。
    const shouldAvoidPrompts =
      canShowPermissionPrompts !== undefined
        ? !canShowPermissionPrompts
        : agentPermissionMode === 'bubble'
          ? false
          : isAsync
    if (shouldAvoidPrompts) {
      toolPermissionContext = {
        ...toolPermissionContext,
        shouldAvoidPermissionPrompts: true,
      }
    }

    // 对于可以显示提示的后台代理，在显示权限对话框之前等待自动检查（分类器，权限钩子）。由于这些是后台代理，等待是可以接受的——只有在自动检查无法解决权限时才应中断用户。这适用于 bubble 模式（始终）和显式的 canShowPermissionPrompts。
    if (isAsync && !shouldAvoidPrompts) {
      toolPermissionContext = {
        ...toolPermissionContext,
        awaitAutomatedChecksBeforeDialog: true,
      }
    }

    // 作用域工具权限：当提供了 allowedTools 时，将它们用作会话规则。重要：保留 cliArg 规则（来自 SDK 的 --allowedTools），因为这些是来自 SDK 消费者的显式权限，应适用于所有代理。仅清除来自父级的会话级规则以防止意外泄漏。
    if (allowedTools !== undefined) {
      toolPermissionContext = {
        ...toolPermissionContext,
        alwaysAllowRules: {
          // 保留来自 --allowedTools 的 SDK 级权限。
          cliArg: state.toolPermissionContext.alwaysAllowRules.cliArg,
          // 使用提供的 allowedTools 作为会话级权限。
          session: [...allowedTools],
        },
      }
    }

    // 如果代理定义了努力级别则覆盖。
    const effortValue =
      agentDefinition.effort !== undefined
        ? agentDefinition.effort
        : state.effortValue

    if (
      toolPermissionContext === state.toolPermissionContext &&
      effortValue === state.effortValue
    ) {
      return state
    }
    return {
      ...state,
      toolPermissionContext,
      effortValue,
    }
  }

  const resolvedTools = useExactTools
    ? availableTools
    : resolveAgentTools(agentDefinition, availableTools, isAsync).resolvedTools

  const additionalWorkingDirectories = Array.from(
    appState.toolPermissionContext.additionalWorkingDirectories.keys(),
  )

  const baseAgentSystemPrompt = override?.systemPrompt
    ? override.systemPrompt
    : asSystemPrompt(
        await getAgentSystemPrompt(
          agentDefinition,
          toolUseContext,
          resolvedAgentModel,
          additionalWorkingDirectories,
        ),
      )
  const agentSystemPrompt = toolUseContext.options.appendSubagentSystemPrompt
    ? asSystemPrompt([
        ...baseAgentSystemPrompt,
        toolUseContext.options.appendSubagentSystemPrompt,
      ])
    : baseAgentSystemPrompt

  // 确定 abortController：- 显式覆盖优先 - 异步代理获得新的未链接控制器（独立运行）- 同步代理共享父级的控制器。
  const agentAbortController = override?.abortController
    ? override.abortController
    : isAsync
      ? new AbortController()
      : toolUseContext.abortController

  // 执行 SubagentStart 钩子并收集额外上下文。
  const additionalContexts: string[] = []
  for await (const hookResult of executeSubagentStartHooks(
    agentId,
    agentDefinition.agentType,
    agentAbortController.signal,
  )) {
    if (
      hookResult.additionalContexts &&
      hookResult.additionalContexts.length > 0
    ) {
      additionalContexts.push(...hookResult.additionalContexts)
    }
  }

  // 将 SubagentStart 钩子上下文作为用户消息添加（与 SessionStart/UserPromptSubmit 一致）。
  if (additionalContexts.length > 0) {
    const contextMessage = createAttachmentMessage({
      type: 'hook_additional_context',
      content: additionalContexts,
      hookName: 'SubagentStart',
      toolUseID: randomUUID(),
      hookEvent: 'SubagentStart',
    })
    initialMessages.push(contextMessage)
  }

  // 注册代理的前置钩子（作用域于代理生命周期）。传递 isAgent=true 以将 Stop 钩子转换为 SubagentStop（因为子代理触发 SubagentStop）。前置钩子的管理信任门相同：仅在 ["hooks"] 下（技能/代理未锁定），用户代理仍然加载——在此处已知来源处阻止它们的前置钩子注册，而不是在执行时全面阻止所有会话钩子（这也会杀死插件代理的钩子）。
  const hooksAllowedForThisAgent =
    !isRestrictedToPluginOnly('hooks') ||
    isSourceAdminTrusted(agentDefinition.source)
  if (agentDefinition.hooks && hooksAllowedForThisAgent) {
    registerFrontmatterHooks(
      rootSetAppState,
      agentId,
      agentDefinition.hooks,
      `agent '${agentDefinition.agentType}'`,
      true, // isAgent - converts Stop to SubagentStop
    )
  }

  // 从代理前置元数据预加载技能。
  const skillsToPreload = agentDefinition.skills ?? []
  if (skillsToPreload.length > 0) {
    const allSkills = await getSkillToolCommands(getProjectRoot())

    // 过滤有效技能并警告缺失的技能。
    const validSkills: Array<{
      skillName: string
      skill: (typeof allSkills)[0] & { type: 'prompt' }
    }> = []

    for (const skillName of skillsToPreload) {
      // 解析技能名称，尝试多种策略：1. 精确匹配（hasCommand 检查 name, userFacingName, aliases）2. 使用代理的插件前缀完全限定（例如 "my-skill" → "plugin:my-skill"）3. 针对插件命名空间的技能进行 ":skillName" 后缀匹配。
      const resolvedName = resolveSkillName(
        skillName,
        allSkills,
        agentDefinition,
      )
      if (!resolvedName) {
        logForDebugging(
          `[Agent: ${agentDefinition.agentType}] Warning: Skill '${skillName}' specified in frontmatter was not found`,
          { level: 'warn' },
        )
        continue
      }

      const skill = getCommand(resolvedName, allSkills)
      if (skill.type !== 'prompt') {
        logForDebugging(
          `[Agent: ${agentDefinition.agentType}] Warning: Skill '${skillName}' is not a prompt-based skill`,
          { level: 'warn' },
        )
        continue
      }
      validSkills.push({ skillName, skill })
    }

    // 同时加载所有技能内容并添加到初始消息中。
    const { formatSkillLoadingMetadata } = await import(
      '../../utils/processUserInput/processSlashCommand.js'
    )
    const loaded = await Promise.all(
      validSkills.map(async ({ skillName, skill }) => ({
        skillName,
        skill,
        content: await skill.getPromptForCommand('', toolUseContext),
      })),
    )
    for (const { skillName, skill, content } of loaded) {
      logForDebugging(
        `[Agent: ${agentDefinition.agentType}] Preloaded skill '${skillName}'`,
      )

      // 添加命令消息元数据，以便 UI 显示正在加载哪个技能。
      const metadata = formatSkillLoadingMetadata(
        skillName,
        skill.progressMessage,
      )

      initialMessages.push(
        createUserMessage({
          content: [{ type: 'text', text: metadata }, ...content],
          isMeta: true,
        }),
      )
    }
  }

  // 初始化代理特定的 MCP 服务器（对父级服务器是叠加的）。
  const {
    clients: mergedMcpClients,
    tools: agentMcpTools,
    cleanup: mcpCleanup,
  } = await initializeAgentMcpServers(
    agentDefinition,
    toolUseContext.options.mcpClients,
  )

  // 合并代理 MCP 工具与已解析的代理工具，按名称去重。resolvedTools 已经去重（请参见 resolveAgentTools），因此当没有代理特定的 MCP 工具时，跳过展开 + uniqBy 的开销。
  const allTools =
    agentMcpTools.length > 0
      ? uniqBy([...resolvedTools, ...agentMcpTools], 'name')
      : resolvedTools

  // 构建特定于代理的选项
  const agentOptions: ToolUseContext['options'] = {
    isNonInteractiveSession: useExactTools
      ? toolUseContext.options.isNonInteractiveSession
      : isAsync
        ? true
        : (toolUseContext.options.isNonInteractiveSession ?? false),
    appendSystemPrompt: toolUseContext.options.appendSystemPrompt,
    appendSubagentSystemPrompt:
      toolUseContext.options.appendSubagentSystemPrompt,
    tools: allTools,
    commands: [],
    debug: toolUseContext.options.debug,
    verbose: toolUseContext.options.verbose,
    mainLoopModel: resolvedAgentModel,
    // 对于分叉子代理（useExactTools路径），继承思维配置以匹配父级的API请求前缀，以便提示缓存命中。对于常规子代理，禁用思维以控制输出token成本。
    thinkingConfig: useExactTools
      ? toolUseContext.options.thinkingConfig
      : { type: 'disabled' as const },
    mcpClients: mergedMcpClients,
    mcpResources: toolUseContext.options.mcpResources,
    agentDefinitions: toolUseContext.options.agentDefinitions,
    // 分叉子代理（useExactTools路径）需要context.options上的querySource，用于AgentTool.tsx call()中的递归分叉防护——它检查options.querySource === 'agent:builtin:fork'。这可在自动压缩（autocompact）中存活（autocompact重写消息，而不是context.options）。没有这个，防护读取undefined，只有消息扫描回退触发——autocompact通过替换分叉样板消息来破坏该回退。
    ...(useExactTools && { querySource }),
  }

  // 使用共享辅助函数创建子代理上下文
  // - 同步代理与父级共享setAppState、setResponseLength、abortController
  // - 异步代理完全隔离（但有显式未链接的abortController）
  const agentToolUseContext = createSubagentContext(toolUseContext, {
    options: agentOptions,
    agentId,
    agentType: agentDefinition.agentType,
    messages: initialMessages,
    readFileState: agentReadFileState,
    abortController: agentAbortController,
    getAppState: agentGetAppState,
    // 同步代理与父级共享这些回调
    shareSetAppState: !isAsync,
    shareSetResponseLength: true, // Both sync and async contribute to response metrics
    criticalSystemReminder_EXPERIMENTAL:
      agentDefinition.criticalSystemReminder_EXPERIMENTAL,
    contentReplacementState,
  })

  // 为具有可查看转录（进程内队友）的子代理保留工具使用结果
  if (preserveToolUseResults) {
    agentToolUseContext.preserveToolUseResults = true
  }

  // 为后台摘要（提示缓存共享）公开缓存安全参数
  if (onCacheSafeParams) {
    onCacheSafeParams({
      systemPrompt: agentSystemPrompt,
      userContext: resolvedUserContext,
      systemContext: resolvedSystemContext,
      toolUseContext: agentToolUseContext,
      forkContextMessages: initialMessages,
    })
  }

  // 在查询循环开始前记录初始消息，以及agentType，以便在省略subagent_type时恢复可以正确路由。两次写入都是即发即忘——持久化失败不应阻塞代理。
  void recordSidechainTranscript(initialMessages, agentId).catch(_err =>
    logForDebugging(`Failed to record sidechain transcript: ${_err}`),
  )
  void writeAgentMetadata(agentId, {
    agentType: agentDefinition.agentType,
    ...(worktreePath && { worktreePath }),
    ...(description && { description }),
  }).catch(_err => logForDebugging(`Failed to write agent metadata: ${_err}`))

  // 跟踪最后记录的消息UUID，用于父链连续性
  let lastRecordedUuid: UUID | null = initialMessages.at(-1)?.uuid ?? null

  try {
    for await (const message of query({
      messages: initialMessages,
      systemPrompt: agentSystemPrompt,
      userContext: resolvedUserContext,
      systemContext: resolvedSystemContext,
      canUseTool,
      toolUseContext: agentToolUseContext,
      querySource,
      maxTurns: maxTurns ?? agentDefinition.maxTurns,
    })) {
      onQueryProgress?.()
      // 将子代理API请求开始转发到父级的指标显示，以便在子代理执行期间更新TTFT/OTPS。
      if (
        message.type === 'stream_event' &&
        message.event.type === 'message_start' &&
        message.ttftMs != null
      ) {
        toolUseContext.pushApiMetricsEntry?.(message.ttftMs)
        continue
      }

      // 产生附件消息（例如structured_output）而不记录它们
      if (message.type === 'attachment') {
        // 处理来自query.ts的最大轮次达到信号
        if (message.attachment.type === 'max_turns_reached') {
          logForDebugging(
            `[Agent
: $
{
  agentDefinition.agentType
}
] Reached max turns limit ($
{
  message.attachment.maxTurns
}
)`,
          )
          break
        }
        yield message
        continue
      }

      if (isRecordableMessage(message)) {
        // 仅记录具有正确父级的新消息（每条消息O(1)）
        await recordSidechainTranscript(
          [message],
          agentId,
          lastRecordedUuid,
        ).catch(err =>
          logForDebugging(`Failed to record sidechain transcript: ${err}`),
        )
        if (message.type !== 'progress') {
          lastRecordedUuid = message.uuid
        }
        yield message
      }
    }

    if (agentAbortController.signal.aborted) {
      throw new AbortError()
    }

    // 如果提供了回调则运行（仅内置代理有回调）
    if (isBuiltInAgent(agentDefinition) && agentDefinition.callback) {
      agentDefinition.callback()
    }
  } finally {
    // 清理特定于代理的MCP服务器（在正常完成、中止或错误时运行）
    await mcpCleanup()
    // 清理代理的会话钩子
    if (agentDefinition.hooks) {
      clearSessionHooks(rootSetAppState, agentId)
    }
    // 清理此代理的提示缓存跟踪状态
    if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
      cleanupAgentTracking(agentId)
    }
    // 释放克隆的文件状态缓存内存
    agentToolUseContext.readFileState.clear()
    // 释放克隆的分叉上下文消息
    initialMessages.length = 0
    // 释放perfetto代理注册表项
    unregisterPerfettoAgent(agentId)
    // 释放转录子目录映射
    clearAgentTranscriptSubdir(agentId)
    // 释放此代理的待办事项条目。没有这个，每个调用TodoWrite的子代理都会在AppState.todos中永久留下一个键（即使所有项目完成，值也是[]但键保留）。鲸鱼会话生成数百个代理；每个孤立键都是一个会累积的小泄漏。
    rootSetAppState(prev => {
      if (!(agentId in prev.todos)) return prev
      const { [agentId]: _removed, ...todos } = prev.todos
      return { ...prev, todos }
    })
    // 杀死此代理生成的所有后台bash任务。没有这个，一旦主会话最终退出，`run_in_background` shell循环（例如测试夹具fake-logs.sh）会作为PPID=1的僵尸进程存活，超过代理的寿命。
    killShellTasksForAgent(agentId, toolUseContext.getAppState, rootSetAppState)
  }
}

/** 过滤掉具有不完整工具调用（使用但无结果）的助手消息。这可以防止在发送带有孤立工具调用的消息时出现API错误。 */
export function filterIncompleteToolCalls(messages: Message[]): Message[] {
  // 构建一组有结果的工具使用ID
  const toolUseIdsWithResults = new Set<string>()

  for (const message of messages) {
    if (message?.type === 'user') {
      const userMessage = message as UserMessage
      const content = userMessage.message.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            toolUseIdsWithResults.add(block.tool_use_id)
          }
        }
      }
    }
  }

  // 过滤掉包含无结果工具调用的助手消息
  return messages.filter(message => {
    if (message?.type === 'assistant') {
      const assistantMessage = message as AssistantMessage
      const content = assistantMessage.message.content
      if (Array.isArray(content)) {
        // 检查此助手消息是否包含无结果的工具使用
        const hasIncompleteToolCall = content.some(
          block =>
            block.type === 'tool_use' &&
            block.id &&
            !toolUseIdsWithResults.has(block.id),
        )
        // 排除包含不完整工具调用的消息
        return !hasIncompleteToolCall
      }
    }
    // 保留所有非助手消息和不包含工具调用的助手消息
    return true
  })
}

/** 获取 get Agent System Prompt 对应的数据或状态。 */
async function getAgentSystemPrompt(
  agentDefinition: AgentDefinition,
  toolUseContext: Pick<ToolUseContext, 'options'>,
  resolvedAgentModel: string,
  additionalWorkingDirectories: string[],
): Promise<string[]> {
  try {
    const agentPrompt = agentDefinition.getSystemPrompt({ toolUseContext })
    const prompts = [agentPrompt]

    return await enhanceSystemPromptWithEnvDetails(
      prompts,
      resolvedAgentModel,
      additionalWorkingDirectories,
    )
  } catch (_error) {
    return enhanceSystemPromptWithEnvDetails(
      [DEFAULT_AGENT_PROMPT],
      resolvedAgentModel,
      additionalWorkingDirectories,
    )
  }
}

/**
 * 从智能体 frontmatter 中将技能名称解析为已注册的命令名称。
 *
 * 插件技能使用带命名空间的名字注册（例如 "my-plugin:my-skill"），
 * 但智能体以裸名称引用它们（例如 "my-skill"）。此函数尝试多种解析策略：
 *
 * 1. 通过 hasCommand(name, userFacingName, aliases) 精确匹配
 * 2. 添加智能体的插件名称作为前缀（例如 "my-skill" → "my-plugin:my-skill"）
 * 3. 后缀匹配——查找名称以 ":skillName" 结尾的任何命令
 */
function resolveSkillName(
  skillName: string,
  allSkills: Command[],
  agentDefinition: AgentDefinition,
): string | null {
  // 1. 直接匹配
  if (hasCommand(skillName, allSkills)) {
    return skillName
  }

  // 2. 尝试添加智能体的插件名称作为前缀
  // 插件智能体的 agentType 形如 "pluginName:agentName"
  const pluginPrefix = agentDefinition.agentType.split(':')[0]
  if (pluginPrefix) {
    const qualifiedName = `${pluginPrefix}:${skillName}`
    if (hasCommand(qualifiedName, allSkills)) {
      return qualifiedName
    }
  }

  // 3. 后缀匹配——查找名称以 ":skillName" 结尾的技能
  const suffix = `:${skillName}`
  /** 执行 match 对应的业务处理。 */
  const match = allSkills.find(cmd => cmd.name.endsWith(suffix))
  if (match) {
    return match.name
  }

  return null
}
