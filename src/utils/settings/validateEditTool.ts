import type { ValidationResult } from 'src/Tool.js'
import { isClaudeSettingsPath } from '../permissions/filesystem.js'
import { validateSettingsFileContent } from './validation.js'

/**
 * 验证设置文件编辑，确保结果符合SettingsSchema。
 * 这被FileEditTool用于避免代码重复。
 *
 * @param filePath - 被编辑的文件路径
 * @param originalContent - 编辑前的原始文件内容
 * @param getUpdatedContent - 返回应用编辑后内容的闭包
 * @returns 验证结果，如果验证失败则包含错误详情
 */
export function validateInputForSettingsFileEdit(
  filePath: string,
  originalContent: string,
  getUpdatedContent: () => string,
): Extract<ValidationResult, { result: false }> | null {
  // 仅验证Claude设置文件
  if (!isClaudeSettingsPath(filePath)) {
    return null
  }

  // 检查当前文件（编辑前）是否符合schema
  const beforeValidation = validateSettingsFileContent(originalContent)

  if (!beforeValidation.isValid) {
    // 如果编辑前版本无效，允许编辑（不阻止）
    return null
  }

  // 如果编辑前版本有效，确保编辑后版本也有效
  const updatedContent = getUpdatedContent()
  const afterValidation = validateSettingsFileContent(updatedContent)

  if (!afterValidation.isValid) {
    return {
      result: false,
      message: `Claude Code settings.json validation failed after edit:\n${afterValidation.error}\n\nFull schema:\n${afterValidation.fullSchema}\nIMPORTANT: Do not update the env unless explicitly instructed to do so.`,
      errorCode: 10,
    }
  }

  return null
}
