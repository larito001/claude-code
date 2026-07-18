/**
 * Public SDK facade for framework consumers.
 *
 * Runtime functions and public types come from the maintained Claude Agent
 * SDK dependency. Hook and exit constants remain pinned to this source
 * tree's protocol version so internal registration stays schema-compatible.
 */
export * from '@anthropic-ai/claude-agent-sdk'
export { HOOK_EVENTS, EXIT_REASONS } from './sdk/coreTypes.js'
