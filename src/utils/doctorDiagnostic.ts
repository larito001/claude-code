import { readFile, realpath } from 'fs/promises'
import { isInBundledMode } from './bundledMode.js'
import { getCwd } from './cwd.js'
import { getPlatform } from './platform.js'
import { getRipgrepStatus } from './ripgrep.js'
import { SandboxManager } from './sandbox/sandbox-adapter.js'
import { getManagedFilePath } from './settings/managedPath.js'
import { CUSTOMIZATION_SURFACES } from './settings/types.js'
import { jsonParse } from './slowOperations.js'
import { join } from 'path'

export type DiagnosticWarning = { issue: string; fix: string }

export type DiagnosticInfo = {
  runtimeMode: 'development' | 'bundled' | 'source'
  version: string
  runtimePath: string
  invokedBinary: string
  warnings: DiagnosticWarning[]
  ripgrepStatus: {
    working: boolean
    mode: 'system' | 'builtin' | 'embedded'
    systemPath: string | null
  }
}

function getRuntimeMode(): DiagnosticInfo['runtimeMode'] {
  if (process.env.NODE_ENV === 'development') return 'development'
  return isInBundledMode() ? 'bundled' : 'source'
}

async function getRuntimePath(): Promise<string> {
  if (process.env.NODE_ENV === 'development') return getCwd()
  if (isInBundledMode()) {
    try {
      return await realpath(process.execPath)
    } catch {
      return process.execPath || 'unknown'
    }
  }
  return process.argv[1] || process.argv[0] || 'unknown'
}

async function detectManagedSettingsWarnings(): Promise<DiagnosticWarning[]> {
  try {
    const raw = await readFile(
      join(getManagedFilePath(), 'managed-settings.json'),
      'utf-8',
    )
    const parsed: unknown = jsonParse(raw)
    const field =
      parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>).strictPluginOnlyCustomization
        : undefined

    if (field === undefined || typeof field === 'boolean') return []
    if (!Array.isArray(field)) {
      return [
        {
          issue:
            'managed-settings.json: strictPluginOnlyCustomization has an invalid value',
          fix: `Set it to true or an array of: ${CUSTOMIZATION_SURFACES.join(', ')}.`,
        },
      ]
    }

    const unknown = field.filter(
      value =>
        typeof value === 'string' &&
        !(CUSTOMIZATION_SURFACES as readonly string[]).includes(value),
    )
    return unknown.length === 0
      ? []
      : [
          {
            issue: `managed-settings.json contains unknown customization surfaces: ${unknown.join(', ')}`,
            fix: `Use supported surfaces: ${CUSTOMIZATION_SURFACES.join(', ')}.`,
          },
        ]
  } catch {
    return []
  }
}

function detectLinuxGlobPatternWarnings(): DiagnosticWarning[] {
  if (getPlatform() !== 'linux') return []
  const patterns = SandboxManager.getLinuxGlobPatternWarnings()
  if (patterns.length === 0) return []
  const preview = patterns.slice(0, 3).join(', ')
  const suffix = patterns.length > 3 ? ` (${patterns.length - 3} more)` : ''
  return [
    {
      issue: 'Glob patterns in sandbox permission rules are not fully supported on Linux',
      fix: `Edit/Read patterns will be ignored: ${preview}${suffix}.`,
    },
  ]
}

export async function getDoctorDiagnostic(): Promise<DiagnosticInfo> {
  const ripgrep = getRipgrepStatus()
  return {
    runtimeMode: getRuntimeMode(),
    version: MACRO.VERSION || 'unknown',
    runtimePath: await getRuntimePath(),
    invokedBinary: process.argv[1] || process.execPath || 'unknown',
    warnings: [
      ...(await detectManagedSettingsWarnings()),
      ...detectLinuxGlobPatternWarnings(),
    ],
    ripgrepStatus: {
      working: ripgrep.working ?? true,
      mode: ripgrep.mode,
      systemPath: ripgrep.mode === 'system' ? ripgrep.path : null,
    },
  }
}
