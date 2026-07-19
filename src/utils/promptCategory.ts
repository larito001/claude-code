import type { QuerySource } from 'src/constants/querySource.js'
import {
  DEFAULT_OUTPUT_STYLE_NAME,
  OUTPUT_STYLE_CONFIG,
} from '../constants/outputStyles.js'
import { getInitialSettings } from './settings/settings.js'

/**
 * Determines the query source for agent execution.
 *
 * @param agentType - The type/name of the agent
 * @param isBuiltInAgent - Whether this is a built-in agent or custom
 * @returns The agent prompt category string
 */
export function getQuerySourceForAgent(
  agentType: string | undefined,
  isBuiltInAgent: boolean,
): QuerySource {
  if (isBuiltInAgent) {
    // TODO: avoid this cast
    return agentType
      ? (`agent:builtin:${agentType}` as QuerySource)
      : 'agent:default'
  } else {
    return 'agent:custom'
  }
}

/**
 * Determines the query source based on output style settings.
 *
 * @returns The prompt category string or undefined for default
 */
export function getQuerySourceForREPL(): QuerySource {
  const settings = getInitialSettings()
  const style = settings?.outputStyle ?? DEFAULT_OUTPUT_STYLE_NAME

  if (style === DEFAULT_OUTPUT_STYLE_NAME) {
    return 'repl_main_thread'
  }

  // All styles in OUTPUT_STYLE_CONFIG are built-in
  const isBuiltIn = style in OUTPUT_STYLE_CONFIG
  return isBuiltIn
    ? (`repl_main_thread:outputStyle:${style}` as QuerySource)
    : 'repl_main_thread:outputStyle:custom'
}
