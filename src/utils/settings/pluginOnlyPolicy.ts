import { getSettingsForSource } from './settings.js'
import type { CUSTOMIZATION_SURFACES } from './types.js'

export type CustomizationSurface = (typeof CUSTOMIZATION_SURFACES)[number]

/**
 * 检查一个定制表面是否被管理的 strictPluginOnlyCustomization 策略锁定为仅限插件源。"锁定"意味着该表面跳过用户级别(~/.claude/*)和项目级别(.claude/*)的源。托管(policySettings)和插件提供的源始终加载——策略是管理员设置的，所以托管源已经是管理员控制的，插件通过 strictKnownMarketplaces 单独门控。true 锁定所有四个表面；数组形式仅锁定列出的那些。缺失/未定义 → 没有锁定（默认）。
 */
export function isRestrictedToPluginOnly(
  surface: CustomizationSurface,
): boolean {
  const policy =
    getSettingsForSource('policySettings')?.strictPluginOnlyCustomization
  if (policy === true) return true
  if (Array.isArray(policy)) return policy.includes(surface)
  return false
}

/**
 * 绕过 strictPluginOnlyCustomization 的源。管理员信任因为：plugin — 由 strictKnownMarketplaces 单独门控；policySettings — 来自托管设置，由定义管理员控制；内置/内建/捆绑 — 随 CLI 提供，不是用户编写的。其他所有（userSettings, projectSettings, localSettings, flagSettings, mcp, undefined）是用户控制的，当相关表面被锁定时被阻止。涵盖 AgentDefinition.source（带连字符的 'built-in'）和 Command.source（不带连字符的 'builtin'，加上 'bundled'）。
 */
const ADMIN_TRUSTED_SOURCES: ReadonlySet<string> = new Set([
  'plugin',
  'policySettings',
  'built-in',
  'builtin',
  'bundled',
])

/**
 * 定制源是否在 strictPluginOnlyCustomization 下被管理员信任。在 Frontmatter 钩子注册和类似的逐项检查中使用，这些检查项带有源标签但表面的文件系统加载器已经运行。调用点的模式：const allowed = !isRestrictedToPluginOnly(surface) || isSourceAdminTrusted(item.source); if (item.hooks && allowed) { register(...) }
 */
export function isSourceAdminTrusted(source: string | undefined): boolean {
  return source !== undefined && ADMIN_TRUSTED_SOURCES.has(source)
}
