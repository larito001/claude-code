import { feature } from 'src/utils/features.js'
import type { ToolPermissionContext } from '../../Tool.js'

export const PROMPT_PREFIX = 'prompt:'

export type ClassifierResult = {
  matches: boolean
  matchedDescription?: string
  confidence: 'high' | 'medium' | 'low'
  reason: string
}

export type ClassifierBehavior = 'deny' | 'ask' | 'allow'

export function extractPromptDescription(
  ruleContent: string | undefined,
): string | null {
  if (!ruleContent) return null
  const trimmed = ruleContent.trim()
  if (!trimmed.toLowerCase().startsWith(PROMPT_PREFIX)) return null
  const description = trimmed.slice(PROMPT_PREFIX.length).trim()
  return description || null
}

export function createPromptRuleContent(description: string): string {
  return `${PROMPT_PREFIX} ${description.trim()}`
}

export function isClassifierPermissionsEnabled(): boolean {
  return feature('BASH_CLASSIFIER') ? true : false
}

function getPromptDescriptions(
  rules: ToolPermissionContext['alwaysAllowRules'],
): string[] {
  return [...new Set(Object.values(rules).flatMap(sourceRules =>
    (sourceRules ?? []).flatMap(rule => {
      const description = extractPromptDescription(rule)
      return description ? [description] : []
    }),
  ))]
}

export function getBashPromptDenyDescriptions(
  context: ToolPermissionContext,
): string[] {
  return getPromptDescriptions(context.alwaysDenyRules)
}

export function getBashPromptAskDescriptions(
  context: ToolPermissionContext,
): string[] {
  return getPromptDescriptions(context.alwaysAskRules)
}

export function getBashPromptAllowDescriptions(
  context: ToolPermissionContext,
): string[] {
  return getPromptDescriptions(context.alwaysAllowRules)
}

export async function classifyBashCommand(
  command: string,
  _cwd: string,
  descriptions: string[],
  _behavior: ClassifierBehavior,
  signal: AbortSignal,
  _isNonInteractiveSession: boolean,
): Promise<ClassifierResult> {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException('Aborted', 'AbortError')
  }

  const normalizedCommand = normalizeForMatch(command)
  const matchedDescription = descriptions.find(description => {
    const normalizedDescription = normalizeForMatch(description)
    return normalizedDescription.length >= 4 &&
      normalizedCommand.includes(normalizedDescription)
  })

  if (matchedDescription) {
    return {
      matches: true,
      matchedDescription,
      confidence: 'high',
      reason: 'The normalized command contains the configured prompt rule.',
    }
  }

  return {
    matches: false,
    confidence: 'low',
    reason: 'No conservative local match was found.',
  }
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

export async function generateGenericDescription(
  command: string,
  specificDescription: string | undefined,
  signal: AbortSignal,
): Promise<string | null> {
  if (signal.aborted) return null
  const description = specificDescription?.trim()
  if (description) return description
  const normalized = command.replace(/\s+/g, ' ').trim()
  return normalized ? `run: ${normalized.slice(0, 160)}` : null
}
