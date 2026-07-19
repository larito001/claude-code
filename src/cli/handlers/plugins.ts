/* eslint-disable custom-rules/no-process-exit -- CLI validation command */
import figures from 'figures'
import { basename, dirname } from 'path'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import {
  type ValidationResult,
  validateManifest,
  validatePluginContents,
} from '../../utils/plugins/validatePlugin.js'
import { cliOk } from '../exit.js'

function printValidationResult(result: ValidationResult): void {
  for (const error of result.errors) {
    console.error(`  ${figures.cross} ${error.path}: ${error.message}`)
  }
  for (const warning of result.warnings) {
    console.warn(`  ${figures.warning} ${warning.path}: ${warning.message}`)
  }
}

export async function pluginValidateHandler(manifestPath: string): Promise<void> {
  try {
    const manifest = await validateManifest(manifestPath)
    console.log(`Validating local plugin manifest: ${manifest.filePath}`)
    printValidationResult(manifest)
    const manifestDirectory = dirname(manifest.filePath)
    const pluginRoot =
      basename(manifestDirectory) === '.claude-plugin'
        ? dirname(manifestDirectory)
        : manifestDirectory
    const content = manifest.success
      ? await validatePluginContents(pluginRoot)
      : []
    for (const result of content) printValidationResult(result)
    if (!manifest.success || content.some(result => !result.success)) {
      console.error(`${figures.cross} Validation failed`)
      process.exit(1)
    }
    cliOk(`${figures.tick} Validation passed`)
  } catch (error) {
    logError(error)
    console.error(`${figures.cross} Validation failed: ${errorMessage(error)}`)
    process.exit(2)
  }
}
