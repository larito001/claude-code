/**
 * 插件和市场子命令处理器——从main.tsx中提取以实现懒加载。
 * 这些仅在运行`claude plugin *`或`claude plugin marketplace *`时动态导入。
 */
/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handlers intentionally exit */
import figures from 'figures'
import { basename, dirname } from 'path'
import { setUseCoworkPlugins } from '../../bootstrap/state.js'
import {
  disableAllPlugins,
  disablePlugin,
  enablePlugin,
  installPlugin,
  uninstallPlugin,
  updatePluginCli,
  VALID_INSTALLABLE_SCOPES,
  VALID_UPDATE_SCOPES,
} from '../../services/plugins/pluginCliCommands.js'
import { getPluginErrorMessage } from '../../types/plugin.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { clearAllCaches } from '../../utils/plugins/cacheUtils.js'
import {
  isPluginInstalled,
  loadInstalledPluginsV2,
} from '../../utils/plugins/installedPluginsManager.js'
import {
  createPluginId,
  loadMarketplacesWithGracefulDegradation,
} from '../../utils/plugins/marketplaceHelpers.js'
import {
  addMarketplaceSource,
  loadKnownMarketplacesConfig,
  refreshAllMarketplaces,
  refreshMarketplace,
  removeMarketplaceSource,
  saveMarketplaceToSettings,
} from '../../utils/plugins/marketplaceManager.js'
import { loadPluginMcpServers } from '../../utils/plugins/mcpPluginIntegration.js'
import { parseMarketplaceInput } from '../../utils/plugins/parseMarketplaceInput.js'
import {
  parsePluginIdentifier,
  scopeToSettingSource,
} from '../../utils/plugins/pluginIdentifier.js'
import { loadAllPlugins } from '../../utils/plugins/pluginLoader.js'
import type { PluginSource } from '../../utils/plugins/schemas.js'
import {
  type ValidationResult,
  validateManifest,
  validatePluginContents,
} from '../../utils/plugins/validatePlugin.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { plural } from '../../utils/stringUtils.js'
import { cliError, cliOk } from '../exit.js'

// 重新导出以供main.tsx在选项定义中引用
export { VALID_INSTALLABLE_SCOPES, VALID_UPDATE_SCOPES }

/** 用于一致处理市场命令错误的辅助函数。 */
export function handleMarketplaceError(error: unknown, action: string): never {
  logError(error)
  cliError(`${figures.cross} Failed to ${action}: ${errorMessage(error)}`)
}

/** 输出或发送 print Validation Result 对应的数据或状态。 */
function printValidationResult(result: ValidationResult): void {
  if (result.errors.length > 0) {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(
      `${figures.cross} Found ${result.errors.length} ${plural(result.errors.length, 'error')}:\n`,
    )
    result.errors.forEach(error => {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(`  ${figures.pointer} ${error.path}: ${error.message}`)
    })
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log('')
  }
  if (result.warnings.length > 0) {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(
      `${figures.warning} Found ${result.warnings.length} ${plural(result.warnings.length, 'warning')}:\n`,
    )
    result.warnings.forEach(warning => {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(`  ${figures.pointer} ${warning.path}: ${warning.message}`)
    })
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log('')
  }
}

// 插件验证
export async function pluginValidateHandler(
  manifestPath: string,
  options: { cowork?: boolean },
): Promise<void> {
  if (options.cowork) setUseCoworkPlugins(true)
  try {
    const result = await validateManifest(manifestPath)

    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`Validating ${result.fileType} manifest: ${result.filePath}\n`)
    printValidationResult(result)

    // 如果这是一个位于.claude-plugin目录内的插件清单，
    // 同时验证插件的内容文件（技能、代理、命令、
    // 钩子）。无论用户传入的是目录还是直接传入plugin.json
    // 路径，均有效。
    let contentResults: ValidationResult[] = []
    if (result.fileType === 'plugin') {
      const manifestDir = dirname(result.filePath)
      if (basename(manifestDir) === '.claude-plugin') {
        contentResults = await validatePluginContents(dirname(manifestDir))
        for (const r of contentResults) {
          // biome-ignore lint/suspicious/noConsole:: intentional console output
          console.log(`Validating ${r.fileType}: ${r.filePath}\n`)
          printValidationResult(r)
        }
      }
    }

    const allSuccess = result.success && contentResults.every(r => r.success)
    const hasWarnings =
      result.warnings.length > 0 ||
      contentResults.some(r => r.warnings.length > 0)

    if (allSuccess) {
      cliOk(
        hasWarnings
          ? `${figures.tick} Validation passed with warnings`
          : `${figures.tick} Validation passed`,
      )
    } else {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(`${figures.cross} Validation failed`)
      process.exit(1)
    }
  } catch (error) {
    logError(error)
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.error(
      `${figures.cross} Unexpected error during validation: ${errorMessage(error)}`,
    )
    process.exit(2)
  }
}

// 插件列表（第5217–5416行）
export async function pluginListHandler(options: {
  json?: boolean
  available?: boolean
  cowork?: boolean
}): Promise<void> {
  if (options.cowork) setUseCoworkPlugins(true)

  const installedData = loadInstalledPluginsV2()
  const { getPluginEditableScopes } = await import(
    '../../utils/plugins/pluginStartupCheck.js'
  )
  const enabledPlugins = getPluginEditableScopes()

  const pluginIds = Object.keys(installedData.plugins)

  // 一次性加载所有插件。JSON路径和人类可读路径都需要：
  //  - loadErrors（用于显示每个插件的加载失败信息）
  //  - 内联插件（仅会话有效，通过--plugin-dir传入，source='name@inline'），
  //    它们不在installedData.plugins中（V2记账）——必须单独
  //    显示，否则`plugin list`会静默忽略--plugin-dir。
  const {
    enabled: loadedEnabled,
    disabled: loadedDisabled,
    errors: loadErrors,
  } = await loadAllPlugins()
  const allLoadedPlugins = [...loadedEnabled, ...loadedDisabled]
  /** 执行 inline Plugins 对应的业务处理。 */
  const inlinePlugins = allLoadedPlugins.filter(p =>
    p.source.endsWith('@inline'),
  )
  // 路径级别的内联失败（目录不存在、读取清单前的解析错误）使用source='inline[N]'。
  // 清单读取后的插件级别错误使用source='name@inline'。
  // 两者都在会话部分收集——否则它们不可见，因为没有pluginId。
  const inlineLoadErrors = loadErrors.filter(
    e => e.source.endsWith('@inline') || e.source.startsWith('inline['),
  )

  if (options.json) {
    // 创建插件源到已加载插件的映射，以便快速查找
    const loadedPluginMap = new Map(allLoadedPlugins.map(p => [p.source, p]))

    const plugins: Array<{
      id: string
      version: string
      scope: string
      enabled: boolean
      installPath: string
      installedAt?: string
      lastUpdated?: string
      projectPath?: string
      mcpServers?: Record<string, unknown>
      errors?: string[]
    }> = []

    for (const pluginId of pluginIds.sort()) {
      const installations = installedData.plugins[pluginId]
      if (!installations || installations.length === 0) continue

      // 查找此插件的加载错误
      const pluginName = parsePluginIdentifier(pluginId).name
      const pluginErrors = loadErrors
        .filter(
          e =>
            e.source === pluginId || ('plugin' in e && e.plugin === pluginName),
        )
        .map(getPluginErrorMessage)

      for (const installation of installations) {
        // 尝试查找已加载的插件以获取MCP服务器
        const loadedPlugin = loadedPluginMap.get(pluginId)
        let mcpServers: Record<string, unknown> | undefined

        if (loadedPlugin) {
          // 如果尚未缓存，则加载MCP服务器
          const servers =
            loadedPlugin.mcpServers ||
            (await loadPluginMcpServers(loadedPlugin))
          if (servers && Object.keys(servers).length > 0) {
            mcpServers = servers
          }
        }

        plugins.push({
          id: pluginId,
          version: installation.version || 'unknown',
          scope: installation.scope,
          enabled: enabledPlugins.has(pluginId),
          installPath: installation.installPath,
          installedAt: installation.installedAt,
          lastUpdated: installation.lastUpdated,
          projectPath: installation.projectPath,
          mcpServers,
          errors: pluginErrors.length > 0 ? pluginErrors : undefined,
        })
      }
    }

    // 仅会话有效的插件：scope='session'，无安装元数据。
    // 从inlineLoadErrors（不是loadErrors）中筛选，这样具有相同清单名称的已安装插件不会通过e.plugin交叉污染。
    // e.plugin回退捕获了dirName≠manifestName的情况：
    // createPluginFromPath会用`${dirName}@inline`标记错误，但
    // 之后plugin.source会被重新赋值为`${manifest.name}@inline`
    // （pluginLoader.ts中的loadInlinePlugins），因此当开发分支目录如~/code/my-fork/的清单名称为'cool-plugin'时，e.source !== p.source。
    for (const p of inlinePlugins) {
      const servers = p.mcpServers || (await loadPluginMcpServers(p))
      const pErrors = inlineLoadErrors
        .filter(
          e => e.source === p.source || ('plugin' in e && e.plugin === p.name),
        )
        .map(getPluginErrorMessage)
      plugins.push({
        id: p.source,
        version: p.manifest.version ?? 'unknown',
        scope: 'session',
        enabled: p.enabled !== false,
        installPath: p.path,
        mcpServers:
          servers && Object.keys(servers).length > 0 ? servers : undefined,
        errors: pErrors.length > 0 ? pErrors : undefined,
      })
    }
    // 路径级别的内联失败（--plugin-dir /nonexistent）：不存在LoadedPlugin对象，因此上面的循环无法显示它们。
    // 镜像人类可读路径的处理方式，使JSON消费者能看到失败而不是静默忽略。
    for (const e of inlineLoadErrors.filter(e =>
      e.source.startsWith('inline['),
    )) {
      plugins.push({
        id: e.source,
        version: 'unknown',
        scope: 'session',
        enabled: false,
        installPath: 'path' in e ? e.path : '',
        errors: [getPluginErrorMessage(e)],
      })
    }

    // 如果设置了--available，也加载来自市场的可用插件
    if (options.available) {
      const available: Array<{
        pluginId: string
        name: string
        description?: string
        marketplaceName: string
        version?: string
        source: PluginSource
      }> = []

      try {
        const config = await loadKnownMarketplacesConfig()
        const { marketplaces } =
          await loadMarketplacesWithGracefulDegradation(config)

        for (const {
          name: marketplaceName,
          data: marketplace,
        } of marketplaces) {
          if (marketplace) {
            for (const entry of marketplace.plugins) {
              const pluginId = createPluginId(entry.name, marketplaceName)
              // 仅包含尚未安装的插件
              if (!isPluginInstalled(pluginId)) {
                available.push({
                  pluginId,
                  name: entry.name,
                  description: entry.description,
                  marketplaceName,
                  version: entry.version,
                  source: entry.source,
                })
              }
            }
          }
        }
      } catch {
        // 静默忽略市场加载错误
      }

      cliOk(jsonStringify({ installed: plugins, available }, null, 2))
    } else {
      cliOk(jsonStringify(plugins, null, 2))
    }
  }

  if (pluginIds.length === 0 && inlinePlugins.length === 0) {
    // inlineLoadErrors可以在零个内联插件的情况下存在（例如--plugin-dir
    // 指向一个不存在的路径）。不要因此提前退出——继续执行到
    // 会话部分，以便该失败可见。
    if (inlineLoadErrors.length === 0) {
      cliOk(
        'No plugins installed. Use `claude plugin install` to install a plugin.',
      )
    }
  }

  if (pluginIds.length > 0) {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log('Installed plugins:\n')
  }

  for (const pluginId of pluginIds.sort()) {
    const installations = installedData.plugins[pluginId]
    if (!installations || installations.length === 0) continue

    // 查找此插件的加载错误
    const pluginName = parsePluginIdentifier(pluginId).name
    /** 执行 plugin Errors 对应的业务处理。 */
    const pluginErrors = loadErrors.filter(
      e => e.source === pluginId || ('plugin' in e && e.plugin === pluginName),
    )

    for (const installation of installations) {
      const isEnabled = enabledPlugins.has(pluginId)
      const status =
        pluginErrors.length > 0
          ? `${figures.cross} failed to load`
          : isEnabled
            ? `${figures.tick} enabled`
            : `${figures.cross} disabled`
      const version = installation.version || 'unknown'
      const scope = installation.scope

      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(`  ${figures.pointer} ${pluginId}`)
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(`    Version: ${version}`)
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(`    Scope: ${scope}`)
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(`    Status: ${status}`)
      for (const error of pluginErrors) {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(`    Error: ${getPluginErrorMessage(error)}`)
      }
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log('')
    }
  }

  if (inlinePlugins.length > 0 || inlineLoadErrors.length > 0) {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log('Session-only plugins (--plugin-dir):\n')
    for (const p of inlinePlugins) {
      // 与上面JSON路径相同的dirName≠manifestName回退——错误源使用目录基名，但p.source使用清单名称。
      const pErrors = inlineLoadErrors.filter(
        e => e.source === p.source || ('plugin' in e && e.plugin === p.name),
      )
      const status =
        pErrors.length > 0
          ? `${figures.cross} loaded with errors`
          : `${figures.tick} loaded`
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(`  ${figures.pointer} ${p.source}`)
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(`    Version: ${p.manifest.version ?? 'unknown'}`)
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(`    Path: ${p.path}`)
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(`    Status: ${status}`)
      for (const e of pErrors) {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(`    Error: ${getPluginErrorMessage(e)}`)
      }
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log('')
    }
    // 路径级别的失败：不存在LoadedPlugin对象。显示它们，这样
    // `--plugin-dir /typo`就不会静默地什么都不产生。
    for (const e of inlineLoadErrors.filter(e =>
      e.source.startsWith('inline['),
    )) {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(
        `  ${figures.pointer} ${e.source}: ${figures.cross} ${getPluginErrorMessage(e)}\n`,
      )
    }
  }

  cliOk()
}

// 市场添加（第5433–5487行）
export async function marketplaceAddHandler(
  source: string,
  options: { cowork?: boolean; sparse?: string[]; scope?: string },
): Promise<void> {
  if (options.cowork) setUseCoworkPlugins(true)
  try {
    const parsed = await parseMarketplaceInput(source)

    if (!parsed) {
      cliError(
        `${figures.cross} Invalid marketplace source format. Try: owner/repo, https://..., or ./path`,
      )
    }

    if ('error' in parsed) {
      cliError(`${figures.cross} ${parsed.error}`)
    }

    // 验证作用域
    const scope = options.scope ?? 'user'
    if (scope !== 'user' && scope !== 'project' && scope !== 'local') {
      cliError(
        `${figures.cross} Invalid scope '${scope}'. Use: user, project, or local`,
      )
    }
    const settingSource = scopeToSettingSource(scope)

    let marketplaceSource = parsed

    if (options.sparse && options.sparse.length > 0) {
      if (
        marketplaceSource.source === 'github' ||
        marketplaceSource.source === 'git'
      ) {
        marketplaceSource = {
          ...marketplaceSource,
          sparsePaths: options.sparse,
        }
      } else {
        cliError(
          `${figures.cross} --sparse is only supported for github and git marketplace sources (got: ${marketplaceSource.source})`,
        )
      }
    }

    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log('Adding marketplace...')

    const { name, alreadyMaterialized, resolvedSource } =
      await addMarketplaceSource(marketplaceSource, message => {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(message)
      })

    // 将意图写入指定作用域的设置中
    saveMarketplaceToSettings(name, { source: resolvedSource }, settingSource)

    clearAllCaches()

    let sourceType: string = marketplaceSource.source
    if (marketplaceSource.source === 'github') {
      sourceType =
        marketplaceSource.repo
    }

    cliOk(
      alreadyMaterialized
        ? `${figures.tick} Marketplace '${name}' already on disk — declared in ${scope} settings`
        : `${figures.tick} Successfully added marketplace: ${name} (declared in ${scope} settings)`,
    )
  } catch (error) {
    handleMarketplaceError(error, 'add marketplace')
  }
}

// marketplace list（第5497–5565行）
export async function marketplaceListHandler(options: {
  json?: boolean
  cowork?: boolean
}): Promise<void> {
  if (options.cowork) setUseCoworkPlugins(true)
  try {
    const config = await loadKnownMarketplacesConfig()
    const names = Object.keys(config)

    if (options.json) {
      /** 执行 marketplaces 对应的业务处理。 */
      const marketplaces = names.sort().map(name => {
        const marketplace = config[name]
        const source = marketplace?.source
        return {
          name,
          source: source?.source,
          ...(source?.source === 'github' && { repo: source.repo }),
          ...(source?.source === 'git' && { url: source.url }),
          ...(source?.source === 'url' && { url: source.url }),
          ...(source?.source === 'directory' && { path: source.path }),
          ...(source?.source === 'file' && { path: source.path }),
          installLocation: marketplace?.installLocation,
        }
      })
      cliOk(jsonStringify(marketplaces, null, 2))
    }

    if (names.length === 0) {
      cliOk('No marketplaces configured')
    }

    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log('Configured marketplaces:\n')
    names.forEach(name => {
      const marketplace = config[name]
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(`  ${figures.pointer} ${name}`)

      if (marketplace?.source) {
        const src = marketplace.source
        if (src.source === 'github') {
          // biome-ignore lint/suspicious/noConsole:: intentional console output
          console.log(`    Source: GitHub (${src.repo})`)
        } else if (src.source === 'git') {
          // biome-ignore lint/suspicious/noConsole:: intentional console output
          console.log(`    Source: Git (${src.url})`)
        } else if (src.source === 'url') {
          // biome-ignore lint/suspicious/noConsole:: intentional console output
          console.log(`    Source: URL (${src.url})`)
        } else if (src.source === 'directory') {
          // biome-ignore lint/suspicious/noConsole:: intentional console output
          console.log(`    Source: Directory (${src.path})`)
        } else if (src.source === 'file') {
          // biome-ignore lint/suspicious/noConsole:: intentional console output
          console.log(`    Source: File (${src.path})`)
        }
      }
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log('')
    })

    cliOk()
  } catch (error) {
    handleMarketplaceError(error, 'list marketplaces')
  }
}

// marketplace remove（第5576–5598行）
export async function marketplaceRemoveHandler(
  name: string,
  options: { cowork?: boolean },
): Promise<void> {
  if (options.cowork) setUseCoworkPlugins(true)
  try {
    await removeMarketplaceSource(name)
    clearAllCaches()


    cliOk(`${figures.tick} Successfully removed marketplace: ${name}`)
  } catch (error) {
    handleMarketplaceError(error, 'remove marketplace')
  }
}

// marketplace update（第5609–5672行）
export async function marketplaceUpdateHandler(
  name: string | undefined,
  options: { cowork?: boolean },
): Promise<void> {
  if (options.cowork) setUseCoworkPlugins(true)
  try {
    if (name) {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(`Updating marketplace: ${name}...`)

      await refreshMarketplace(name, message => {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(message)
      })

      clearAllCaches()


      cliOk(`${figures.tick} Successfully updated marketplace: ${name}`)
    } else {
      const config = await loadKnownMarketplacesConfig()
      const marketplaceNames = Object.keys(config)

      if (marketplaceNames.length === 0) {
        cliOk('No marketplaces configured')
      }

      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(`Updating ${marketplaceNames.length} marketplace(s)...`)

      await refreshAllMarketplaces()
      clearAllCaches()


      cliOk(
        `${figures.tick} Successfully updated ${marketplaceNames.length} marketplace(s)`,
      )
    }
  } catch (error) {
    handleMarketplaceError(error, 'update marketplace(s)')
  }
}

// plugin install（第5690–5721行）
export async function pluginInstallHandler(
  plugin: string,
  options: { scope?: string; cowork?: boolean },
): Promise<void> {
  if (options.cowork) setUseCoworkPlugins(true)
  const scope = options.scope || 'user'
  if (options.cowork && scope !== 'user') {
    cliError('--cowork can only be used with user scope')
  }
  if (
    !VALID_INSTALLABLE_SCOPES.includes(
      scope as (typeof VALID_INSTALLABLE_SCOPES)[number],
    )
  ) {
    cliError(
      `Invalid scope: ${scope}. Must be one of: ${VALID_INSTALLABLE_SCOPES.join(', ')}.`,
    )
  }
  const { name, marketplace } = parsePluginIdentifier(plugin)

  await installPlugin(plugin, scope as 'user' | 'project' | 'local')
}

// plugin uninstall（第5738–5769行）
export async function pluginUninstallHandler(
  plugin: string,
  options: { scope?: string; cowork?: boolean; keepData?: boolean },
): Promise<void> {
  if (options.cowork) setUseCoworkPlugins(true)
  const scope = options.scope || 'user'
  if (options.cowork && scope !== 'user') {
    cliError('--cowork can only be used with user scope')
  }
  if (
    !VALID_INSTALLABLE_SCOPES.includes(
      scope as (typeof VALID_INSTALLABLE_SCOPES)[number],
    )
  ) {
    cliError(
      `Invalid scope: ${scope}. Must be one of: ${VALID_INSTALLABLE_SCOPES.join(', ')}.`,
    )
  }
  const { name, marketplace } = parsePluginIdentifier(plugin)

  await uninstallPlugin(
    plugin,
    scope as 'user' | 'project' | 'local',
    options.keepData,
  )
}

// plugin enable（第5783–5818行）
export async function pluginEnableHandler(
  plugin: string,
  options: { scope?: string; cowork?: boolean },
): Promise<void> {
  if (options.cowork) setUseCoworkPlugins(true)
  let scope: (typeof VALID_INSTALLABLE_SCOPES)[number] | undefined
  if (options.scope) {
    if (
      !VALID_INSTALLABLE_SCOPES.includes(
        options.scope as (typeof VALID_INSTALLABLE_SCOPES)[number],
      )
    ) {
      cliError(
        `Invalid scope "${options.scope}". Valid scopes: ${VALID_INSTALLABLE_SCOPES.join(', ')}`,
      )
    }
    scope = options.scope as (typeof VALID_INSTALLABLE_SCOPES)[number]
  }
  if (options.cowork && scope !== undefined && scope !== 'user') {
    cliError('--cowork can only be used with user scope')
  }

  // --cowork 始终在用户作用域下操作
  if (options.cowork && scope === undefined) {
    scope = 'user'
  }

  const { name, marketplace } = parsePluginIdentifier(plugin)

  await enablePlugin(plugin, scope)
}

// plugin disable（第5833–5902行）
export async function pluginDisableHandler(
  plugin: string | undefined,
  options: { scope?: string; cowork?: boolean; all?: boolean },
): Promise<void> {
  if (options.all && plugin) {
    cliError('Cannot use --all with a specific plugin')
  }

  if (!options.all && !plugin) {
    cliError('Please specify a plugin name or use --all to disable all plugins')
  }

  if (options.cowork) setUseCoworkPlugins(true)

  if (options.all) {
    if (options.scope) {
      cliError('Cannot use --scope with --all')
    }


    await disableAllPlugins()
    return
  }

  let scope: (typeof VALID_INSTALLABLE_SCOPES)[number] | undefined
  if (options.scope) {
    if (
      !VALID_INSTALLABLE_SCOPES.includes(
        options.scope as (typeof VALID_INSTALLABLE_SCOPES)[number],
      )
    ) {
      cliError(
        `Invalid scope "${options.scope}". Valid scopes: ${VALID_INSTALLABLE_SCOPES.join(', ')}`,
      )
    }
    scope = options.scope as (typeof VALID_INSTALLABLE_SCOPES)[number]
  }
  if (options.cowork && scope !== undefined && scope !== 'user') {
    cliError('--cowork can only be used with user scope')
  }

  // --cowork 始终在用户作用域下操作
  if (options.cowork && scope === undefined) {
    scope = 'user'
  }

  const { name, marketplace } = parsePluginIdentifier(plugin!)

  await disablePlugin(plugin!, scope)
}

// plugin update（第5918–5948行）
export async function pluginUpdateHandler(
  plugin: string,
  options: { scope?: string; cowork?: boolean },
): Promise<void> {
  if (options.cowork) setUseCoworkPlugins(true)
  const { name, marketplace } = parsePluginIdentifier(plugin)

  let scope: (typeof VALID_UPDATE_SCOPES)[number] = 'user'
  if (options.scope) {
    if (
      !VALID_UPDATE_SCOPES.includes(
        options.scope as (typeof VALID_UPDATE_SCOPES)[number],
      )
    ) {
      cliError(
        `Invalid scope "${options.scope}". Valid scopes: ${VALID_UPDATE_SCOPES.join(', ')}`,
      )
    }
    scope = options.scope as (typeof VALID_UPDATE_SCOPES)[number]
  }
  if (options.cowork && scope !== 'user') {
    cliError('--cowork can only be used with user scope')
  }

  await updatePluginCli(plugin, scope)
}
