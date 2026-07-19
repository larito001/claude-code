import type { SettingSource } from './constants.js'
import type { SettingsJson } from './types.js'
import type { SettingsWithErrors, ValidationError } from './validation.js'

let sessionSettingsCache: SettingsWithErrors | null = null

/** 获取 get Session Settings Cache 对应的数据或状态。 */
export function getSessionSettingsCache(): SettingsWithErrors | null {
  return sessionSettingsCache
}

/** 设置并保存 set Session Settings Cache 对应的数据或状态。 */
export function setSessionSettingsCache(value: SettingsWithErrors): void {
  sessionSettingsCache = value
}

/**
 * getSettingsForSource 的每个源缓存。与合并后的 sessionSettingsCache 一起失效——触发 resetSettingsCache() 的同一批操作（设置写入、--add-dir、插件初始化、钩子刷新）。
 */
const perSourceCache = new Map<SettingSource, SettingsJson | null>()

/** 获取 get Cached Settings For Source 对应的数据或状态。 */
export function getCachedSettingsForSource(
  source: SettingSource,
): SettingsJson | null | undefined {
  // undefined = 缓存未命中；null = 缓存“该源无设置”
  return perSourceCache.has(source) ? perSourceCache.get(source) : undefined
}

/** 设置并保存 set Cached Settings For Source 对应的数据或状态。 */
export function setCachedSettingsForSource(
  source: SettingSource,
  value: SettingsJson | null,
): void {
  perSourceCache.set(source, value)
}

/**
 * parseSettingsFile 的路径键缓存。getSettingsForSource 和 loadSettingsFromDisk 在启动时都会对相同路径调用 parseSettingsFile——此举对磁盘读取 + zod 解析进行去重。
 */
type ParsedSettings = {
  settings: SettingsJson | null
  errors: ValidationError[]
}
const parseFileCache = new Map<string, ParsedSettings>()

/** 获取 get Cached Parsed File 对应的数据或状态。 */
export function getCachedParsedFile(path: string): ParsedSettings | undefined {
  return parseFileCache.get(path)
}

/** 设置并保存 set Cached Parsed File 对应的数据或状态。 */
export function setCachedParsedFile(path: string, value: ParsedSettings): void {
  parseFileCache.set(path, value)
}

/** 重置或恢复 reset Settings Cache 对应的数据或状态。 */
export function resetSettingsCache(): void {
  sessionSettingsCache = null
  perSourceCache.clear()
  parseFileCache.clear()
}

/** 插件设置基础层，用于设置级联。pluginLoader 在加载插件后写入此处；loadSettingsFromDisk 将其作为最低优先级基础读取。 */
let pluginSettingsBase: Record<string, unknown> | undefined

/** 获取 get Plugin Settings Base 对应的数据或状态。 */
export function getPluginSettingsBase(): Record<string, unknown> | undefined {
  return pluginSettingsBase
}

/** 设置并保存 set Plugin Settings Base 对应的数据或状态。 */
export function setPluginSettingsBase(
  settings: Record<string, unknown> | undefined,
): void {
  pluginSettingsBase = settings
}

/** 删除或清理 clear Plugin Settings Base 对应的数据或状态。 */
export function clearPluginSettingsBase(): void {
  pluginSettingsBase = undefined
}
