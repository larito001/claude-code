import { feature } from 'src/utils/features.js'
import memoize from 'lodash-es/memoize.js'
import {
  isFeatureEnabled,
  getFeatureValue,
} from 'src/services/featureConfig.js'
import { getIsNonInteractiveSession, getSdkBetas } from '../bootstrap/state.js'
import {
  CLAUDE_CODE_20250219_BETA_HEADER,
  CONTEXT_1M_BETA_HEADER,
  CONTEXT_MANAGEMENT_BETA_HEADER,
  INTERLEAVED_THINKING_BETA_HEADER,
  PROMPT_CACHING_SCOPE_BETA_HEADER,
  REDACT_THINKING_BETA_HEADER,
  STRUCTURED_OUTPUTS_BETA_HEADER,
  TOKEN_EFFICIENT_TOOLS_BETA_HEADER,
} from '../constants/betas.js'
import { has1mContext } from './context.js'
import { isEnvDefinedFalsy, isEnvTruthy } from './envUtils.js'
import { getCanonicalName } from './model/model.js'
import { getInitialSettings } from './settings/settings.js'

/**
 * SDK-provided betas that are allowed for API key users.
 * Only betas in this list can be passed via SDK options.
 */
const ALLOWED_SDK_BETAS = [CONTEXT_1M_BETA_HEADER]

/**
 * Filter betas to only include those in the allowlist.
 * Returns allowed and disallowed betas separately.
 */
function partitionBetasByAllowlist(betas: string[]): {
  allowed: string[]
  disallowed: string[]
} {
  const allowed: string[] = []
  const disallowed: string[] = []
  for (const beta of betas) {
    if (ALLOWED_SDK_BETAS.includes(beta)) {
      allowed.push(beta)
    } else {
      disallowed.push(beta)
    }
  }
  return { allowed, disallowed }
}

/**
 * Filter SDK betas to only include allowed ones.
 * Warns about disallowed betas and returns only the supported headers.
 */
export function filterAllowedSdkBetas(
  sdkBetas: string[] | undefined,
): string[] | undefined {
  if (!sdkBetas || sdkBetas.length === 0) {
    return undefined
  }

  const { allowed, disallowed } = partitionBetasByAllowlist(sdkBetas)
  for (const beta of disallowed) {
    // biome-ignore lint/suspicious/noConsole: intentional warning
    console.warn(
      `Warning: Beta header '${beta}' is not allowed. Only the following betas are supported: ${ALLOWED_SDK_BETAS.join(', ')}`,
    )
  }
  return allowed.length > 0 ? allowed : undefined
}

export function modelSupportsISP(model: string): boolean {
  const canonical = getCanonicalName(model)
  return !canonical.includes('claude-3-')
}

// Context management is supported on Claude 4+ models
export function modelSupportsContextManagement(model: string): boolean {
  const canonical = getCanonicalName(model)
  return !canonical.includes('claude-3-')
}

// @[MODEL LAUNCH]: Add the new model ID to this list if it supports structured outputs.
export function modelSupportsStructuredOutputs(model: string): boolean {
  const canonical = getCanonicalName(model)
  return (
    canonical.includes('claude-sonnet-4-6') ||
    canonical.includes('claude-sonnet-4-5') ||
    canonical.includes('claude-opus-4-1') ||
    canonical.includes('claude-opus-4-5') ||
    canonical.includes('claude-opus-4-6') ||
    canonical.includes('claude-haiku-4-5')
  )
}

// @[MODEL LAUNCH]: Add the new model if it supports auto mode (specifically PI probes) — ask in #proj-claude-code-safety-research.
export function modelSupportsAutoMode(model: string): boolean {
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    const m = getCanonicalName(model)
    // local feature configuration override: tengu_auto_mode_config.allowModels force-enables
    // auto mode for listed models, bypassing the denylist/allowlist below.
    // Exact model IDs (e.g. "claude-strudel-v6-p") match only that model;
    // canonical names (e.g. "claude-strudel") match the whole family.
    const config = getFeatureValue<{
      allowModels?: string[]
    }>('tengu_auto_mode_config', {})
    const rawLower = model.toLowerCase()
    if (
      config?.allowModels?.some(
        am => am.toLowerCase() === rawLower || am.toLowerCase() === m,
      )
    ) {
      return true
    }
    // Supported public-model allowlist (firstParty already checked above).
    return /^claude-(opus|sonnet)-4-6/.test(m)
  }
  return false
}

/**
 * Get the tool search beta header used by the API-key backend.
 */
/**
 * Check if experimental betas should be included.
 * These are betas that are only available on firstParty provider
 * and may not be supported by proxies or other providers.
 */
export function shouldIncludeFirstPartyOnlyBetas(): boolean {
  return (
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS)
  )
}

/**
 * Global-scope prompt caching is an experimental direct-API capability.
 */
export function shouldUseGlobalCacheScope(): boolean {
  return (
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS)
  )
}

export const getAllModelBetas = memoize((model: string): string[] => {
  const betaHeaders = []
  const isHaiku = getCanonicalName(model).includes('haiku')
  const includeFirstPartyOnlyBetas = shouldIncludeFirstPartyOnlyBetas()

  if (!isHaiku) {
    betaHeaders.push(CLAUDE_CODE_20250219_BETA_HEADER)
  }
  if (has1mContext(model)) {
    betaHeaders.push(CONTEXT_1M_BETA_HEADER)
  }
  if (
    !isEnvTruthy(process.env.DISABLE_INTERLEAVED_THINKING) &&
    modelSupportsISP(model)
  ) {
    betaHeaders.push(INTERLEAVED_THINKING_BETA_HEADER)
  }

  // Skip the API-side Haiku thinking summarizer — the summary is only used
  // for ctrl+o display, which interactive users rarely open. The API returns
  // redacted_thinking blocks instead; AssistantRedactedThinkingMessage already
  // renders those as a stub. SDK / print-mode keep summaries because callers
  // may iterate over thinking content. Users can opt back in via settings.json
  // showThinkingSummaries.
  if (
    includeFirstPartyOnlyBetas &&
    modelSupportsISP(model) &&
    !getIsNonInteractiveSession() &&
    getInitialSettings().showThinkingSummaries !== true
  ) {
    betaHeaders.push(REDACT_THINKING_BETA_HEADER)
  }


  // Add context management beta for explicit tool clearing or thinking preservation.
  const toolClearingEnabled = isEnvTruthy(
    process.env.USE_API_CONTEXT_MANAGEMENT,
  )

  const thinkingPreservationEnabled = modelSupportsContextManagement(model)

  if (
    shouldIncludeFirstPartyOnlyBetas() &&
    (toolClearingEnabled || thinkingPreservationEnabled)
  ) {
    betaHeaders.push(CONTEXT_MANAGEMENT_BETA_HEADER)
  }
  // Add strict tool use beta if experiment is enabled.
  // Gate on includeFirstPartyOnlyBetas: CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
  // already strips schema.strict from tool bodies at api.ts's choke point, but
  // this header was escaping that kill switch. Proxy gateways that look like
  // API-compatible reject this header with 400.
  // github.com/deshaw/anthropic-issues/issues/5
  const strictToolsEnabled =
    isFeatureEnabled('tengu_tool_pear')
  // 3P default: false. API rejects strict + token-efficient-tools together
  // (tool_use.py:139), so these are mutually exclusive — strict wins.
  const tokenEfficientToolsEnabled =
    !strictToolsEnabled &&
    getFeatureValue('tengu_amber_json_tools', false)
  if (
    includeFirstPartyOnlyBetas &&
    modelSupportsStructuredOutputs(model) &&
    strictToolsEnabled
  ) {
    betaHeaders.push(STRUCTURED_OUTPUTS_BETA_HEADER)
  }
  // JSON tool_use format (FC v3) — ~4.5% output token reduction vs ANTML.
  // Sends the v2 header (2026-03-28) added in anthropics/anthropic#337072 to
  // isolate this client from existing v1 senders.
  if (
    includeFirstPartyOnlyBetas &&
    tokenEfficientToolsEnabled
  ) {
    betaHeaders.push(TOKEN_EFFICIENT_TOOLS_BETA_HEADER)
  }

  // Always send the beta header for 1P. The header is a no-op without a scope field.
  if (includeFirstPartyOnlyBetas) {
    betaHeaders.push(PROMPT_CACHING_SCOPE_BETA_HEADER)
  }

  // If ANTHROPIC_BETAS is set, split it by commas and add to betaHeaders.
  // This is an explicit user opt-in, so honor it regardless of model.
  if (process.env.ANTHROPIC_BETAS) {
    betaHeaders.push(
      ...process.env.ANTHROPIC_BETAS.split(',')
        .map(_ => _.trim())
        .filter(Boolean),
    )
  }
  return betaHeaders
})

export const getModelBetas = memoize((model: string): string[] => {
  return getAllModelBetas(model)
})

/**
 * Merge SDK-provided betas with auto-detected model betas.
 * SDK betas are read from global state (set via setSdkBetas in main.tsx).
 * The betas are pre-filtered by filterAllowedSdkBetas, which validates the
 * allowlist and emits warnings for unsupported values.
 *
 * @param options.isAgenticQuery - When true, ensures the beta headers needed
 *   for agentic queries are present. For non-Haiku models these are already
 *   included by getAllModelBetas(); for Haiku they're excluded since
 *   non-agentic calls (compaction, classifiers, token estimation) don't need them.
 */
export function getMergedBetas(
  model: string,
  options?: { isAgenticQuery?: boolean },
): string[] {
  const baseBetas = [...getModelBetas(model)]

  // Agentic queries always need the Claude Code beta header.
  // For non-Haiku models these are already in baseBetas; for Haiku they're
  // excluded by getAllModelBetas() since non-agentic Haiku calls don't need them.
  if (options?.isAgenticQuery) {
    if (!baseBetas.includes(CLAUDE_CODE_20250219_BETA_HEADER)) {
      baseBetas.push(CLAUDE_CODE_20250219_BETA_HEADER)
    }
  }

  const sdkBetas = getSdkBetas()

  if (!sdkBetas || sdkBetas.length === 0) {
    return baseBetas
  }

  // Merge SDK betas without duplicates (already filtered by filterAllowedSdkBetas)
  return [...baseBetas, ...sdkBetas.filter(b => !baseBetas.includes(b))]
}

export function clearBetasCaches(): void {
  getAllModelBetas.cache?.clear?.()
  getModelBetas.cache?.clear?.()
}
