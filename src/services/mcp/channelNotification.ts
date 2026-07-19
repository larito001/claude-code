import type { ServerCapabilities } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod/v4'
import { type ChannelEntry, getAllowedChannels } from '../../bootstrap/state.js'
import { CHANNEL_TAG } from '../../constants/xml.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { escapeXmlAttr } from '../../utils/xml.js'
import { getFeatureValue } from '../featureConfig.js'

export const ChannelMessageNotificationSchema = lazySchema(() =>
  z.object({
    method: z.literal('notifications/claude/channel'),
    params: z.object({
      content: z.string(),
      meta: z.record(z.string(), z.string()).optional(),
    }),
  }),
)

export const CHANNEL_PERMISSION_METHOD =
  'notifications/claude/channel/permission'
export const ChannelPermissionNotificationSchema = lazySchema(() =>
  z.object({
    method: z.literal(CHANNEL_PERMISSION_METHOD),
    params: z.object({
      request_id: z.string(),
      behavior: z.enum(['allow', 'deny']),
    }),
  }),
)

export const CHANNEL_PERMISSION_REQUEST_METHOD =
  'notifications/claude/channel/permission_request'
export type ChannelPermissionRequestParams = {
  request_id: string
  tool_name: string
  description: string
  input_preview: string
}

const SAFE_META_KEY = /^[a-zA-Z_][a-zA-Z0-9_]*$/

export function wrapChannelMessage(
  serverName: string,
  content: string,
  meta?: Record<string, string>,
): string {
  const attrs = Object.entries(meta ?? {})
    .filter(([key]) => SAFE_META_KEY.test(key))
    .map(([key, value]) => ` ${key}="${escapeXmlAttr(value)}"`)
    .join('')
  return `<${CHANNEL_TAG} source="${escapeXmlAttr(serverName)}"${attrs}>\n${content}\n</${CHANNEL_TAG}>`
}

export type ChannelGateResult =
  | { action: 'register' }
  | {
      action: 'skip'
      kind: 'capability' | 'disabled' | 'session'
      reason: string
    }

export function findChannelEntry(
  serverName: string,
  channels: readonly ChannelEntry[],
): ChannelEntry | undefined {
  return channels.find(channel => channel.name === serverName)
}

/** Require both runtime availability and an explicit per-session server opt-in. */
export function gateChannelServer(
  serverName: string,
  capabilities: ServerCapabilities | undefined,
): ChannelGateResult {
  if (!capabilities?.experimental?.['claude/channel']) {
    return {
      action: 'skip',
      kind: 'capability',
      reason: 'server did not declare claude/channel capability',
    }
  }
  if (!getFeatureValue('tengu_harbor', false)) {
    return {
      action: 'skip',
      kind: 'disabled',
      reason: 'channels feature is not currently available',
    }
  }
  if (!findChannelEntry(serverName, getAllowedChannels())) {
    return {
      action: 'skip',
      kind: 'session',
      reason: `server ${serverName} not in --channels list for this session`,
    }
  }
  return { action: 'register' }
}
