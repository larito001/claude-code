import { getSettings_DEPRECATED } from '../settings/settings.js'
import { isModelAlias, isModelFamilyAlias } from './aliases.js'
import { parseUserSpecifiedModel } from './model.js'
import { resolveOverriddenModel } from './modelStrings.js'

/** 通过检查模型名称（或解析后的名称）是否包含家族标识符，判断模型是否属于给定的家族。 */
function modelBelongsToFamily(model: string, family: string): boolean {
  if (model.includes(family)) {
    return true
  }
  // 解析别名（如 "best" → "claude-opus-4-6"）以检查家族归属
  if (isModelAlias(model)) {
    const resolved = parseUserSpecifiedModel(model).toLowerCase()
    return resolved.includes(family)
  }
  return false
}

/**
 * 检查模型名称是否以某个前缀开头，且匹配到名称末尾或 "-"分隔符处。例如 "claude-opus-4-5" 匹配 "claude-opus-4-5-20251101"，但不匹配 "claude-opus-4-50"。
 */
function prefixMatchesModel(modelName: string, prefix: string): boolean {
  if (!modelName.startsWith(prefix)) {
    return false
  }
  return modelName.length === prefix.length || modelName[prefix.length] === '-'
}

/** 检查模型是否匹配允许列表中的版本前缀条目。支持简写如 "opus-4-5"（映射为 "claude-opus-4-5"）和完整前缀如 "claude-opus-4-5"。匹配前先解析输入的别名。 */
function modelMatchesVersionPrefix(model: string, entry: string): boolean {
  // 如果输入模型是别名，则解析为完整名称
  const resolvedModel = isModelAlias(model)
    ? parseUserSpecifiedModel(model).toLowerCase()
    : model

  // 按原样尝试条目（例如 "claude-opus-4-5"）
  if (prefixMatchesModel(resolvedModel, entry)) {
    return true
  }
  // 尝试添加 "claude-" 前缀（例如 "opus-4-5" → "claude-opus-4-5"）
  if (
    !entry.startsWith('claude-') &&
    prefixMatchesModel(resolvedModel, `claude-${entry}`)
  ) {
    return true
  }
  return false
}

/**
 * 检查家族别名是否被允许列表中更具体的条目限制。当允许列表同时包含 "opus" 和 "opus-4-5" 时，具体条目优先——单独 "opus" 是通配符，但 "opus-4-5" 将其限制为仅该版本。
 */
function familyHasSpecificEntries(
  family: string,
  allowlist: string[],
): boolean {
  for (const entry of allowlist) {
    if (isModelFamilyAlias(entry)) {
      continue
    }
    // 检查条目是否是该家族的带版本限定变体，例如 "opus-4-5" 或 "claude-opus-4-5-20251101" 属于 "opus" 家族。必须匹配到分隔符边界（后跟 '-' 或结尾），以避免误匹配如 "opusplan" 匹配 "opus"
    const idx = entry.indexOf(family)
    if (idx === -1) {
      continue
    }
    const afterFamily = idx + family.length
    if (afterFamily === entry.length || entry[afterFamily] === '-') {
      return true
    }
  }
  return false
}

/**
 * 检查模型是否被 settings 中的 availableModels 允许列表允许。如果未设置 availableModels，则允许所有模型。匹配层级：1. 家族别名（"opus", "sonnet", "haiku"）——整个家族的通配符，除非该家族存在更具体的条目（例如 "opus-4-5"）。此时家族通配符被忽略，仅应用具体条目。2. 版本前缀（"opus-4-5", "claude-opus-4-5"）——该版本的任何构建。3. 完整模型ID（"claude-opus-4-5-20251101"）——仅精确匹配
 */
export function isModelAllowed(model: string): boolean {
  const settings = getSettings_DEPRECATED() || {}
  const { availableModels } = settings
  if (!availableModels) {
    return true // 无限制
  }
  if (availableModels.length === 0) {
    return false // 空允许列表阻止所有用户指定的模型
  }

  const resolvedModel = resolveOverriddenModel(model)
  const normalizedModel = resolvedModel.trim().toLowerCase()
  /** 规范化 normalized Allowlist 对应的数据或状态。 */
  const normalizedAllowlist = availableModels.map(m => m.trim().toLowerCase())

  // 直接匹配（别名对别名或全名对全名）。跳过已被具体条目限制的家族别名——例如，在 ["opus", "opus-4-5"] 中的 "opus" 不应直接匹配，因为管理员意图仅限制为 opus 4.5。
  if (normalizedAllowlist.includes(normalizedModel)) {
    if (
      !isModelFamilyAlias(normalizedModel) ||
      !familyHasSpecificEntries(normalizedModel, normalizedAllowlist)
    ) {
      return true
    }
  }

  // 允许列表中的家族级别别名匹配该家族的任何模型，但仅当该家族不存在更具体的条目时。例如 ["opus"] 允许所有 opus，但 ["opus", "opus-4-5"] 仅允许 opus 4.5。
  for (const entry of normalizedAllowlist) {
    if (
      isModelFamilyAlias(entry) &&
      !familyHasSpecificEntries(entry, normalizedAllowlist) &&
      modelBelongsToFamily(normalizedModel, entry)
    ) {
      return true
    }
  }

  // 对于非家族条目，执行双向别名解析。如果模型是别名，解析它并检查解析后的名称是否在列表中
  if (isModelAlias(normalizedModel)) {
    const resolved = parseUserSpecifiedModel(normalizedModel).toLowerCase()
    if (normalizedAllowlist.includes(resolved)) {
      return true
    }
  }

  // 如果允许列表中的任何非家族别名解析为输入的模型
  for (const entry of normalizedAllowlist) {
    if (!isModelFamilyAlias(entry) && isModelAlias(entry)) {
      const resolved = parseUserSpecifiedModel(entry).toLowerCase()
      if (resolved === normalizedModel) {
        return true
      }
    }
  }

  // 版本前缀匹配："opus-4-5" 或 "claude-opus-4-5" 在分隔符边界匹配 "claude-opus-4-5-20251101"
  for (const entry of normalizedAllowlist) {
    if (!isModelFamilyAlias(entry) && !isModelAlias(entry)) {
      if (modelMatchesVersionPrefix(normalizedModel, entry)) {
        return true
      }
    }
  }

  return false
}
