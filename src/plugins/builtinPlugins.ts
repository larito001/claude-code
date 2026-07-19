/**
 * 内置插件注册表
 *
 * 管理 CLI 自带的、用户可通过 /plugin UI 启用/禁用的内置插件。
 *
 * 内置插件与捆绑技能（src/skills/bundled/）的区别在于：
 * - 它们出现在 /plugin UI 的“内置”部分
 * - 用户可启用/禁用它们（持久化到用户设置）
 * - 它们可提供多个组件（技能、钩子、MCP 服务器）
 *
 * 插件 ID 使用 `{name}@builtin` 格式，以区别于市场插件（`{name}@{marketplace}`）。
 */

import type { Command } from '../commands.js'
import type { BundledSkillDefinition } from '../skills/bundledSkills.js'
import type { BuiltinPluginDefinition, LoadedPlugin } from '../types/plugin.js'
import { getSettings_DEPRECATED } from '../utils/settings/settings.js'

const BUILTIN_PLUGINS: Map<string, BuiltinPluginDefinition> = new Map()

export const BUILTIN_MARKETPLACE_NAME = 'builtin'

/** 注册一个内置插件。在启动时从 initBuiltinPlugins() 调用此函数。 */
export function registerBuiltinPlugin(
  definition: BuiltinPluginDefinition,
): void {
  BUILTIN_PLUGINS.set(definition.name, definition)
}

/** 检查插件 ID 是否表示内置插件（以 @builtin 结尾）。 */
export function isBuiltinPluginId(pluginId: string): boolean {
  return pluginId.endsWith(`@${BUILTIN_MARKETPLACE_NAME}`)
}

/** 按名称获取特定的内置插件定义。用于 /plugin UI 显示技能/钩子/MCP 列表而无需市场查找。 */
/** 获取 get Builtin Plugin Definition 对应的数据或状态。 */
export function getBuiltinPluginDefinition(
  name: string,
): BuiltinPluginDefinition | undefined {
  return BUILTIN_PLUGINS.get(name)
}

/**
 * 获取所有注册的内置插件作为 LoadedPlugin 对象，根据用户设置分为启用/禁用（默认以 defaultEnabled 回退）。返回 false 的 isAvailable() 的插件将被完全忽略。
 */
/** 获取 get Builtin Plugins 对应的数据或状态。 */
export function getBuiltinPlugins(): {
  enabled: LoadedPlugin[]
  disabled: LoadedPlugin[]
} {
  const settings = getSettings_DEPRECATED()
  const enabled: LoadedPlugin[] = []
  const disabled: LoadedPlugin[] = []

  for (const [name, definition] of BUILTIN_PLUGINS) {
    if (definition.isAvailable && !definition.isAvailable()) {
      continue
    }

    const pluginId = `${name}@${BUILTIN_MARKETPLACE_NAME}`
    const userSetting = settings?.enabledPlugins?.[pluginId]
    // 启用状态：用户偏好 > 插件默认 > true
    const isEnabled =
      userSetting !== undefined
        ? userSetting === true
        : (definition.defaultEnabled ?? true)

    const plugin: LoadedPlugin = {
      name,
      manifest: {
        name,
        description: definition.description,
        version: definition.version,
      },
      path: BUILTIN_MARKETPLACE_NAME, // sentinel — no filesystem path
      source: pluginId,
      repository: pluginId,
      enabled: isEnabled,
      isBuiltin: true,
      hooksConfig: definition.hooks,
      mcpServers: definition.mcpServers,
    }

    if (isEnabled) {
      enabled.push(plugin)
    } else {
      disabled.push(plugin)
    }
  }

  return { enabled, disabled }
}

/** 从已启用的内置插件中获取技能作为 Command 对象。来自禁用插件的技能不会被返回。 */
/** 获取 get Builtin Plugin Skill Commands 对应的数据或状态。 */
export function getBuiltinPluginSkillCommands(): Command[] {
  const { enabled } = getBuiltinPlugins()
  const commands: Command[] = []

  for (const plugin of enabled) {
    const definition = BUILTIN_PLUGINS.get(plugin.name)
    if (!definition?.skills) continue
    for (const skill of definition.skills) {
      commands.push(skillDefinitionToCommand(skill))
    }
  }

  return commands
}

/** 清除内置插件注册表（用于测试）。 */
/** 删除或清理 clear Builtin Plugins 对应的数据或状态。 */
export function clearBuiltinPlugins(): void {
  BUILTIN_PLUGINS.clear()
}

// --

/** 执行 skill Definition To Command 对应的业务处理。 */
function skillDefinitionToCommand(definition: BundledSkillDefinition): Command {
  return {
    type: 'prompt',
    name: definition.name,
    description: definition.description,
    hasUserSpecifiedDescription: true,
    allowedTools: definition.allowedTools ?? [],
    argumentHint: definition.argumentHint,
    whenToUse: definition.whenToUse,
    model: definition.model,
    disableModelInvocation: definition.disableModelInvocation ?? false,
    userInvocable: definition.userInvocable ?? true,
    contentLength: 0,
    // 'bundled' 而非 'builtin' — Command.source 中的 'builtin' 表示硬编码的斜杠命令（/help, /clear）。使用 'bundled' 可将这些技能保留在 Skill 工具列表和提示截断豁免中。用户可切换的方面通过 LoadedPlugin.isBuiltin 跟踪。
    source: 'bundled',
    loadedFrom: 'bundled',
    hooks: definition.hooks,
    context: definition.context,
    agent: definition.agent,
    isEnabled: definition.isEnabled ?? (() => true),
    isHidden: !(definition.userInvocable ?? true),
    progressMessage: 'running',
    getPromptForCommand: definition.getPromptForCommand,
  }
}
