import figures from 'figures'
import { relative } from 'path'
import * as React from 'react'
import { Box, Text } from '../ink.js'
import type { AgentDefinitionsResult } from '../tools/AgentTool/loadAgentsDir.js'
import {
  getLargeMemoryFiles,
  MAX_MEMORY_CHARACTER_COUNT,
  type MemoryFileInfo,
} from './claudemd.js'
import type { getGlobalConfig } from './config.js'
import { getCwd } from './cwd.js'
import { formatNumber } from './format.js'
import {
  getTerminalIdeType,
  isSupportedJetBrainsTerminal,
  toIDEDisplayName,
} from './ide.js'
import { isJetBrainsPluginInstalledCachedSync } from './jetbrains.js'
import {
  AGENT_DESCRIPTIONS_THRESHOLD,
  getAgentDescriptionsTotalTokens,
} from './statusNoticeHelpers.js'

export type StatusNoticeType = 'warning' | 'info'

export type StatusNoticeContext = {
  config: ReturnType<typeof getGlobalConfig>
  agentDefinitions?: AgentDefinitionsResult
  memoryFiles: MemoryFileInfo[]
}

export type StatusNoticeDefinition = {
  id: string
  type: StatusNoticeType
  isActive: (context: StatusNoticeContext) => boolean
  render: (context: StatusNoticeContext) => React.ReactNode
}

const largeMemoryFilesNotice: StatusNoticeDefinition = {
  id: 'large-memory-files',
  type: 'warning',
  isActive: context => getLargeMemoryFiles(context.memoryFiles).length > 0,
  render: context => (
    <>
      {getLargeMemoryFiles(context.memoryFiles).map(file => {
        const displayPath = file.path.startsWith(getCwd())
          ? relative(getCwd(), file.path)
          : file.path
        return (
          <Box key={file.path} flexDirection="row">
            <Text color="warning">{figures.warning}</Text>
            <Text color="warning">
              Large <Text bold>{displayPath}</Text> will impact performance (
              {formatNumber(file.content.length)} chars &gt;{' '}
              {formatNumber(MAX_MEMORY_CHARACTER_COUNT)})
              <Text dimColor> · /memory to edit</Text>
            </Text>
          </Box>
        )
      })}
    </>
  ),
}

const largeAgentDescriptionsNotice: StatusNoticeDefinition = {
  id: 'large-agent-descriptions',
  type: 'warning',
  isActive: context =>
    getAgentDescriptionsTotalTokens(context.agentDefinitions) >
    AGENT_DESCRIPTIONS_THRESHOLD,
  render: context => (
    <Box flexDirection="row">
      <Text color="warning">{figures.warning}</Text>
      <Text color="warning">
        Large cumulative agent descriptions will impact performance (~
        {formatNumber(
          getAgentDescriptionsTotalTokens(context.agentDefinitions),
        )}{' '}
        tokens &gt; {formatNumber(AGENT_DESCRIPTIONS_THRESHOLD)})
        <Text dimColor> · /agents to manage</Text>
      </Text>
    </Box>
  ),
}

const jetbrainsPluginNotice: StatusNoticeDefinition = {
  id: 'jetbrains-plugin-install',
  type: 'info',
  isActive: context => {
    if (!isSupportedJetBrainsTerminal()) return false
    if (!(context.config.autoInstallIdeExtension ?? true)) return false
    const ideType = getTerminalIdeType()
    return ideType !== null && !isJetBrainsPluginInstalledCachedSync(ideType)
  },
  render: () => {
    const ideType = getTerminalIdeType()
    const ideName = toIDEDisplayName(ideType)
    return (
      <Box flexDirection="row" gap={1} marginLeft={1}>
        <Text color="ide">{figures.arrowUp}</Text>
        <Text>
          Install the <Text color="ide">{ideName}</Text> plugin from the
          JetBrains plugin page:{' '}
          <Text bold>
            https://docs.claude.com/s/claude-code-jetbrains
          </Text>
        </Text>
      </Box>
    )
  },
}

export const statusNoticeDefinitions: StatusNoticeDefinition[] = [
  largeMemoryFilesNotice,
  largeAgentDescriptionsNotice,
  jetbrainsPluginNotice,
]

export function getActiveNotices(
  context: StatusNoticeContext,
): StatusNoticeDefinition[] {
  return statusNoticeDefinitions.filter(notice => notice.isActive(context))
}
