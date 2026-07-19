import { readFile, stat } from 'fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'
import { PluginManifestSchema } from './schemas.js'
import { errorMessage, isENOENT } from '../errors.js'
import { jsonParse } from '../slowOperations.js'

export type ValidationError = {
  path: string
  message: string
  code?: string
}

export type ValidationWarning = {
  path: string
  message: string
}

export type ValidationResult = {
  success: boolean
  errors: ValidationError[]
  warnings: ValidationWarning[]
  filePath: string
  fileType: 'plugin'
}

async function resolveManifestPath(inputPath: string): Promise<string> {
  const absolute = resolve(inputPath)
  try {
    if ((await stat(absolute)).isDirectory()) {
      return join(absolute, '.claude-plugin', 'plugin.json')
    }
  } catch {
    return absolute
  }
  return absolute
}

export async function validatePluginManifest(
  inputPath: string,
): Promise<ValidationResult> {
  const filePath = await resolveManifestPath(inputPath)
  const errors: ValidationError[] = []
  let parsed: unknown
  try {
    parsed = jsonParse(await readFile(filePath, 'utf-8'))
  } catch (error) {
    errors.push({
      path: filePath,
      message: isENOENT(error)
        ? 'Plugin manifest not found'
        : `Unable to read plugin manifest: ${errorMessage(error)}`,
    })
    return { success: false, errors, warnings: [], filePath, fileType: 'plugin' }
  }

  const result = PluginManifestSchema().safeParse(parsed)
  if (!result.success) {
    errors.push(
      ...result.error.issues.map(issue => ({
        path: issue.path.join('.') || 'root',
        message: issue.message,
        code: issue.code,
      })),
    )
  }
  return {
    success: errors.length === 0,
    errors,
    warnings: [],
    filePath,
    fileType: 'plugin',
  }
}

function addDeclaration(
  declarations: string[],
  value: string | string[] | undefined,
): void {
  if (!value) return
  declarations.push(...(Array.isArray(value) ? value : [value]))
}

export async function validatePluginContents(
  pluginRoot: string,
): Promise<ValidationResult[]> {
  const manifestResult = await validatePluginManifest(pluginRoot)
  if (!manifestResult.success) return []

  const manifest = PluginManifestSchema().parse(
    jsonParse(await readFile(manifestResult.filePath, 'utf-8')),
  )
  const declarations: string[] = []
  if (typeof manifest.commands === 'string' || Array.isArray(manifest.commands)) {
    addDeclaration(declarations, manifest.commands)
  } else if (manifest.commands) {
    for (const command of Object.values(manifest.commands)) {
      if (command.source) declarations.push(command.source)
    }
  }
  addDeclaration(declarations, manifest.agents)
  addDeclaration(declarations, manifest.skills)
  addDeclaration(declarations, manifest.outputStyles)
  if (manifest.hooks) {
    for (const hook of Array.isArray(manifest.hooks)
      ? manifest.hooks
      : [manifest.hooks]) {
      if (typeof hook === 'string') declarations.push(hook)
    }
  }
  if (manifest.mcpServers) {
    for (const item of Array.isArray(manifest.mcpServers)
      ? manifest.mcpServers
      : [manifest.mcpServers]) {
      if (typeof item === 'string') declarations.push(item)
    }
  }
  if (manifest.lspServers) {
    for (const item of Array.isArray(manifest.lspServers)
      ? manifest.lspServers
      : [manifest.lspServers]) {
      if (typeof item === 'string') declarations.push(item)
    }
  }

  const resolvedRoot = resolve(pluginRoot)
  const errors: ValidationError[] = []
  await Promise.all(
    declarations.map(async declaration => {
      const fullPath = resolve(resolvedRoot, declaration)
      const rel = relative(resolvedRoot, fullPath)
      if (rel.startsWith('..') || isAbsolute(rel)) {
        errors.push({ path: declaration, message: 'Path escapes plugin root' })
        return
      }
      try {
        await stat(fullPath)
      } catch {
        errors.push({ path: declaration, message: 'Declared component not found' })
      }
    }),
  )

  if (errors.length === 0) return []
  return [
    {
      success: false,
      errors,
      warnings: [],
      filePath: dirname(manifestResult.filePath),
      fileType: 'plugin',
    },
  ]
}

export const validateManifest = validatePluginManifest
