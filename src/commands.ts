import addDir from './commands/add-dir/index.js'
import advisor from './commands/advisor.js'
import btw from './commands/btw/index.js'
import clear from './commands/clear/index.js'
import color from './commands/color/index.js'
import copy from './commands/copy/index.js'
import compact from './commands/compact/index.js'
import config from './commands/config/index.js'
import { context, contextNonInteractive } from './commands/context/index.js'
import cost from './commands/cost/index.js'
import diff from './commands/diff/index.js'
import doctor from './commands/doctor/index.js'
import memory from './commands/memory/index.js'
import help from './commands/help/index.js'
import ide from './commands/ide/index.js'
import init from './commands/init.js'
import keybindings from './commands/keybindings/index.js'
import mcp from './commands/mcp/index.js'
import rename from './commands/rename/index.js'
import resume from './commands/resume/index.js'
import review from './commands/review.js'
import skills from './commands/skills/index.js'
import status from './commands/status/index.js'
import tasks from './commands/tasks/index.js'
import securityReview from './commands/security-review.js'
import terminalSetup from './commands/terminalSetup/index.js'
import theme from './commands/theme/index.js'
import vim from './commands/vim/index.js'
import permissions from './commands/permissions/index.js'
import plan from './commands/plan/index.js'
import fast from './commands/fast/index.js'
import hooks from './commands/hooks/index.js'
import files from './commands/files/index.js'
import branch from './commands/branch/index.js'
import agents from './commands/agents/index.js'
import plugin from './commands/plugin/index.js'
import reloadPlugins from './commands/reload-plugins/index.js'
import rewind from './commands/rewind/index.js'
import version from './commands/version.js'
import sandboxToggle from './commands/sandbox-toggle/index.js'
import { logError } from './utils/log.js'
import { toError } from './utils/errors.js'
import { logForDebugging } from './utils/debug.js'
import {
  getSkillDirCommands,
  clearSkillCaches,
  getDynamicSkills,
} from './skills/loadSkillsDir.js'
import { getBundledSkills } from './skills/bundledSkills.js'
import { getBuiltinPluginSkillCommands } from './plugins/builtinPlugins.js'
import {
  getPluginCommands,
  clearPluginCommandCache,
  getPluginSkills,
  clearPluginSkillsCache,
} from './utils/plugins/loadPluginCommands.js'
import memoize from 'lodash-es/memoize.js'
import { getAPIProvider } from './utils/model/providers.js'
import exit from './commands/exit/index.js'
import exportCommand from './commands/export/index.js'
import model from './commands/model/index.js'
import tag from './commands/tag/index.js'
import outputStyle from './commands/output-style/index.js'
import statusline from './commands/statusline.js'
import effort from './commands/effort/index.js'
import { getSettingSourceName } from './utils/settings/constants.js'
import {
  type Command,
  getCommandName,
  isCommandEnabled,
} from './types/command.js'

// 从集中位置重新导出类型
export type {
  Command,
  CommandBase,
  CommandResultDisplay,
  LocalCommandResult,
  LocalJSXCommandContext,
  PromptCommand,
  ResumeEntrypoint,
} from './types/command.js'
export { getCommandName, isCommandEnabled } from './types/command.js'

// 声明为函数，以便在调用 getCommands 之前不执行此操作，因为底层函数会读取配置，而模块初始化期间无法读取配置
const COMMANDS = memoize((): Command[] => [
  addDir,
  advisor,
  agents,
  branch,
  btw,
  clear,
  color,
  compact,
  config,
  copy,
  context,
  contextNonInteractive,
  cost,
  diff,
  doctor,
  effort,
  exit,
  fast,
  files,
  help,
  ide,
  init,
  keybindings,
  mcp,
  memory,
  model,
  outputStyle,
  plugin,
  reloadPlugins,
  rename,
  resume,
  skills,
  status,
  statusline,
  tag,
  theme,
  review,  rewind,
  securityReview,
  terminalSetup,
  vim,
  permissions,
  plan,
  hooks,
  exportCommand,
  sandboxToggle,
  tasks,
  version,
])

/** 执行 built In Command Names 对应的业务处理。 */
export const builtInCommandNames = memoize(
  (): Set<string> =>
    new Set(COMMANDS().flatMap(_ => [_.name, ...(_.aliases ?? [])])),
)

/** 获取 get Skills 对应的数据或状态。 */
async function getSkills(cwd: string): Promise<{
  skillDirCommands: Command[]
  pluginSkills: Command[]
  bundledSkills: Command[]
  builtinPluginSkills: Command[]
}> {
  try {
    const [skillDirCommands, pluginSkills] = await Promise.all([
      getSkillDirCommands(cwd).catch(err => {
        logError(toError(err))
        logForDebugging(
          'Skill directory commands failed to load, continuing without them',
        )
        return []
      }),
      getPluginSkills().catch(err => {
        logError(toError(err))
        logForDebugging('Plugin skills failed to load, continuing without them')
        return []
      }),
    ])
    // 捆绑的技能在启动时同步注册
    const bundledSkills = getBundledSkills()
    // 内置插件技能来自已启用的内置插件
    const builtinPluginSkills = getBuiltinPluginSkillCommands()
    logForDebugging(
      `getSkills returning: ${skillDirCommands.length} skill dir commands, ${pluginSkills.length} plugin skills, ${bundledSkills.length} bundled skills, ${builtinPluginSkills.length} builtin plugin skills`,
    )
    return {
      skillDirCommands,
      pluginSkills,
      bundledSkills,
      builtinPluginSkills,
    }
  } catch (err) {
    // 已经在 Promise 层面捕获，但为保险起见，这不应发生。
    logError(toError(err))
    logForDebugging('Unexpected error in getSkills, returning empty')
    return {
      skillDirCommands: [],
      pluginSkills: [],
      bundledSkills: [],
      builtinPluginSkills: [],
    }
  }
}

/**
 * 根据声明的 API 提供者需求过滤命令。没有 `availability` 的命令被视为通用。此操作在 `isEnabled()` 之前运行，因此提供者限制的命令会隐藏，无论特性标记状态如何。
 * 未记忆化，因为提供者环境变量可能在调用间变化，因此每次 getCommands() 调用都必须重新评估。
 */
/** 执行 meets Availability Requirement 对应的业务处理。 */
export function meetsAvailabilityRequirement(cmd: Command): boolean {
  if (!cmd.availability) return true
  return cmd.availability.includes(getAPIProvider())
}

/** 加载所有命令来源（技能、插件、工作流）。按 cwd 记忆化，因为加载成本高（磁盘 I/O、动态导入）。 */
/** 获取 load All Commands 对应的数据或状态。 */
const loadAllCommands = memoize(async (cwd: string): Promise<Command[]> => {
  const [
    { skillDirCommands, pluginSkills, bundledSkills, builtinPluginSkills },
    pluginCommands,
  ] = await Promise.all([
    getSkills(cwd),
    getPluginCommands(),
  ])

  return [
    ...bundledSkills,
    ...builtinPluginSkills,
    ...skillDirCommands,
    ...pluginCommands,
    ...pluginSkills,
    ...COMMANDS(),
  ]
})

/** 返回当前用户可用的命令。昂贵的加载已记忆化，但 availability 和 isEnabled 检查每次调用都重新运行，因此运行时更改立即生效。 */
/** 获取 get Commands 对应的数据或状态。 */
export async function getCommands(cwd: string): Promise<Command[]> {
  const allCommands = await loadAllCommands(cwd)

  // 获取在文件操作期间发现的动态技能
  const dynamicSkills = getDynamicSkills()

  // 构建不含动态技能的基础命令
  /** 执行 base Commands 对应的业务处理。 */
  const baseCommands = allCommands.filter(
    _ => meetsAvailabilityRequirement(_) && isCommandEnabled(_),
  )

  if (dynamicSkills.length === 0) {
    return baseCommands
  }

  // 去重动态技能——仅当不存在时才添加
  const baseCommandNames = new Set(baseCommands.map(c => c.name))
  /** 执行 unique Dynamic Skills 对应的业务处理。 */
  const uniqueDynamicSkills = dynamicSkills.filter(
    s =>
      !baseCommandNames.has(s.name) &&
      meetsAvailabilityRequirement(s) &&
      isCommandEnabled(s),
  )

  if (uniqueDynamicSkills.length === 0) {
    return baseCommands
  }

  // 在插件技能之后但内置命令之前插入动态技能
  const builtInNames = new Set(COMMANDS().map(c => c.name))
  /** 添加或注册 insert Index 对应的数据或状态。 */
  const insertIndex = baseCommands.findIndex(c => builtInNames.has(c.name))

  if (insertIndex === -1) {
    return [...baseCommands, ...uniqueDynamicSkills]
  }

  return [
    ...baseCommands.slice(0, insertIndex),
    ...uniqueDynamicSkills,
    ...baseCommands.slice(insertIndex),
  ]
}

/** 仅清除命令的记忆化缓存，不清除技能缓存。当添加动态技能以使缓存的命令列表失效时使用此方法。 */
/** 删除或清理 clear Command Memoization Caches 对应的数据或状态。 */
export function clearCommandMemoizationCaches(): void {
  loadAllCommands.cache?.clear?.()
  getSkillToolCommands.cache?.clear?.()
  getSlashCommandToolSkills.cache?.clear?.()
}

/** 删除或清理 clear Commands Cache 对应的数据或状态。 */
export function clearCommandsCache(): void {
  clearCommandMemoizationCaches()
  clearPluginCommandCache()
  clearPluginSkillsCache()
  clearSkillCaches()
}

/**
 * 将 AppState.mcp.commands 过滤为 MCP 提供的技能（prompt 类型、模型可调用、从 MCP 加载）。这些位于 getCommands() 之外，因此需要 MCP 技能在其技能索引中的调用者会单独传递它们。
 */
/** 获取 get Mcp Skill Commands 对应的数据或状态。 */
export function getMcpSkillCommands(
  mcpCommands: readonly Command[],
): readonly Command[] {
  return mcpCommands.filter(
    cmd =>
      cmd.type === 'prompt' &&
      cmd.loadedFrom === 'mcp' &&
      !cmd.disableModelInvocation,
  )
}

// SkillTool 显示模型可以调用的所有基于 prompt 的命令，包括技能（来自 /skills/）和命令（来自 /commands/）。
/** 获取 get Skill Tool Commands 对应的数据或状态。 */
export const getSkillToolCommands = memoize(
  async (cwd: string): Promise<Command[]> => {
    const allCommands = await getCommands(cwd)
    return allCommands.filter(
      cmd =>
        cmd.type === 'prompt' &&
        !cmd.disableModelInvocation &&
        cmd.source !== 'builtin' &&
        // 始终包含来自 /skills/ 目录的技能、捆绑技能以及旧 /commands/ 条目（如果缺少 frontmatter，它们都会从第一行自动派生描述）。插件/MCP 命令仍需显式描述才能在列表中显示。
        (cmd.loadedFrom === 'bundled' ||
          cmd.loadedFrom === 'skills' ||
          cmd.loadedFrom === 'commands_DEPRECATED' ||
          cmd.hasUserSpecifiedDescription ||
          cmd.whenToUse),
    )
  },
)

// 过滤命令，只包含技能。技能是为模型提供专用能力的命令。它们通过 loadedFrom 为 'skills'、'plugin' 或 'bundled'，或设置 disableModelInvocation 来标识。
/** 获取 get Slash Command Tool Skills 对应的数据或状态。 */
export const getSlashCommandToolSkills = memoize(
  async (cwd: string): Promise<Command[]> => {
    try {
      const allCommands = await getCommands(cwd)
      return allCommands.filter(
        cmd =>
          cmd.type === 'prompt' &&
          cmd.source !== 'builtin' &&
          (cmd.hasUserSpecifiedDescription || cmd.whenToUse) &&
          (cmd.loadedFrom === 'skills' ||
            cmd.loadedFrom === 'plugin' ||
            cmd.loadedFrom === 'bundled' ||
            cmd.disableModelInvocation),
      )
    } catch (error) {
      logError(toError(error))
      // 返回空数组而非抛出异常——技能不是关键部分。这可以防止技能加载失败破坏整个系统。
      logForDebugging('Returning empty skills array due to load failure')
      return []
    }
  },
)

/**
 * 在远程模式（--remote）下安全使用的命令。这些仅影响本地 TUI 状态，不依赖本地文件系统、git、shell、IDE、MCP 或其他本地执行上下文。
 * 用于两处：
 */
/** 获取 find Command 对应的数据或状态。 */
export function findCommand(
  commandName: string,
  commands: Command[],
): Command | undefined {
  return commands.find(
    _ =>
      _.name === commandName ||
      getCommandName(_) === commandName ||
      _.aliases?.includes(commandName),
  )
}

/** 判断是否满足 has Command 对应的数据或状态。 */
export function hasCommand(commandName: string, commands: Command[]): boolean {
  return findCommand(commandName, commands) !== undefined
}

/** 获取 get Command 对应的数据或状态。 */
export function getCommand(commandName: string, commands: Command[]): Command {
  const command = findCommand(commandName, commands)
  if (!command) {
    throw ReferenceError(
      `Command ${commandName} not found. Available commands: ${commands
        .map(_ => {
          const name = getCommandName(_)
          return _.aliases ? `${name} (aliases: ${_.aliases.join(', ')})` : name
        })
        .sort((a, b) => a.localeCompare(b))
        .join(', ')}`,
    )
  }

  return command
}

/**
 * 格式化命令的描述及其来源注释，用于面向用户的UI。在自动补全、帮助屏幕和其他用户需要查看命令来源的地方使用此功能。
 *
 * 对于面向模型的提示（如 SkillTool），请直接使用 cmd.description。
 */
export function formatDescriptionWithSource(cmd: Command): string {
  if (cmd.type !== 'prompt') {
    return cmd.description
  }

  if (cmd.kind === 'workflow') {
    return `${cmd.description} (workflow)`
  }

  if (cmd.source === 'plugin') {
    const pluginName = cmd.pluginInfo?.pluginManifest.name
    if (pluginName) {
      return `(${pluginName}) ${cmd.description}`
    }
    return `${cmd.description} (plugin)`
  }

  if (cmd.source === 'builtin' || cmd.source === 'mcp') {
    return cmd.description
  }

  if (cmd.source === 'bundled') {
    return `${cmd.description} (bundled)`
  }

  return `${cmd.description} (${getSettingSourceName(cmd.source)})`
}
