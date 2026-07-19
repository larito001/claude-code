import figures from 'figures'
import React, { useEffect, useMemo, useState } from 'react'
import { KeybindingWarnings } from '../components/KeybindingWarnings.js'
import { McpParsingWarnings } from '../components/mcp/McpParsingWarnings.js'
import { Pane } from '../components/design-system/Pane.js'
import { PressEnterToContinue } from '../components/PressEnterToContinue.js'
import { SandboxDoctorSection } from '../components/sandbox/SandboxDoctorSection.js'
import { ValidationErrorsList } from '../components/ValidationErrorsList.js'
import { useSettingsErrors } from '../hooks/notifs/useSettingsErrors.js'
import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js'
import { Box, Text } from '../ink.js'
import { useKeybindings } from '../keybindings/useKeybinding.js'
import { useAppState } from '../state/AppState.js'
import { getPluginErrorMessage } from '../types/plugin.js'
import { getModelMaxOutputTokens } from '../utils/context.js'
import {
  type ContextWarnings,
  checkContextWarnings,
} from '../utils/doctorContextWarnings.js'
import {
  type DiagnosticInfo,
  getDoctorDiagnostic,
} from '../utils/doctorDiagnostic.js'
import { validateBoundedIntEnvVar } from '../utils/envValidation.js'
import { BASH_MAX_OUTPUT_DEFAULT, BASH_MAX_OUTPUT_UPPER_LIMIT } from '../utils/shell/outputLimits.js'
import { TASK_MAX_OUTPUT_DEFAULT, TASK_MAX_OUTPUT_UPPER_LIMIT } from '../utils/task/outputFormatting.js'
import type { CommandResultDisplay } from '../commands.js'

type Props = {
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void
}

export function Doctor({ onDone }: Props): React.ReactNode {
  const agentDefinitions = useAppState(state => state.agentDefinitions)
  const tools = useAppState(state => state.mcp.tools) ?? []
  const toolPermissionContext = useAppState(
    state => state.toolPermissionContext,
  )
  const pluginErrors = useAppState(state => state.plugins.errors)
  const [diagnostic, setDiagnostic] = useState<DiagnosticInfo | null>(null)
  const [contextWarnings, setContextWarnings] =
    useState<ContextWarnings | null>(null)
  const validationErrors = useSettingsErrors()
  const settingsErrors = validationErrors.filter(
    error => error.mcpErrorMetadata === undefined,
  )

  useExitOnCtrlCDWithKeybindings()

  const envValidationErrors = useMemo(() => {
    const variables = [
      {
        name: 'BASH_MAX_OUTPUT_LENGTH',
        default: BASH_MAX_OUTPUT_DEFAULT,
        upperLimit: BASH_MAX_OUTPUT_UPPER_LIMIT,
      },
      {
        name: 'TASK_MAX_OUTPUT_LENGTH',
        default: TASK_MAX_OUTPUT_DEFAULT,
        upperLimit: TASK_MAX_OUTPUT_UPPER_LIMIT,
      },
      {
        name: 'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
        ...getModelMaxOutputTokens('claude-opus-4-6'),
      },
    ]
    return variables
      .map(variable => ({
        name: variable.name,
        ...validateBoundedIntEnvVar(
          variable.name,
          process.env[variable.name],
          variable.default,
          variable.upperLimit,
        ),
      }))
      .filter(result => result.status !== 'valid')
  }, [])

  useEffect(() => {
    let cancelled = false
    void getDoctorDiagnostic().then(nextDiagnostic => {
      if (!cancelled) setDiagnostic(nextDiagnostic)
    })
    void checkContextWarnings(
      tools,
      {
        activeAgents: agentDefinitions.activeAgents,
        allAgents: agentDefinitions.allAgents,
        failedFiles: agentDefinitions.failedFiles,
      },
      async () => toolPermissionContext,
    ).then(nextContextWarnings => {
      if (!cancelled) setContextWarnings(nextContextWarnings)
    })
    return () => {
      cancelled = true
    }
  }, [agentDefinitions, toolPermissionContext, tools])

  const dismiss = (): void => {
    onDone('Diagnostics dismissed', { display: 'system' })
  }
  useKeybindings(
    { 'confirm:yes': dismiss, 'confirm:no': dismiss },
    { context: 'Confirmation' },
  )

  if (!diagnostic) {
    return (
      <Pane>
        <Text dimColor>Checking runtime health…</Text>
      </Pane>
    )
  }

  const searchSource =
    diagnostic.ripgrepStatus.mode === 'system'
      ? diagnostic.ripgrepStatus.systemPath || 'system'
      : diagnostic.ripgrepStatus.mode

  return (
    <Pane>
      <Box flexDirection="column">
        <Text bold>Diagnostics</Text>
        <Text>└ Runtime: {diagnostic.runtimeMode} ({diagnostic.version})</Text>
        <Text>└ Path: {diagnostic.runtimePath}</Text>
        <Text>└ Invoked: {diagnostic.invokedBinary}</Text>
        <Text>
          └ Search: {diagnostic.ripgrepStatus.working ? 'OK' : 'Not working'} ({searchSource})
        </Text>
        {diagnostic.warnings.map((warning, index) => (
          <Box key={index} flexDirection="column" marginTop={1}>
            <Text color="warning">Warning: {warning.issue}</Text>
            <Text>Fix: {warning.fix}</Text>
          </Box>
        ))}
      </Box>

      {settingsErrors.length > 0 && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Invalid Settings</Text>
          <ValidationErrorsList errors={settingsErrors} />
        </Box>
      )}

      <SandboxDoctorSection />
      <McpParsingWarnings />
      <KeybindingWarnings />

      {envValidationErrors.length > 0 && (
        <Box flexDirection="column">
          <Text bold>Environment Variables</Text>
          {envValidationErrors.map(validation => (
            <Text key={validation.name}>
              └ {validation.name}:{' '}
              <Text color={validation.status === 'capped' ? 'warning' : 'error'}>
                {validation.message}
              </Text>
            </Text>
          ))}
        </Box>
      )}

      {agentDefinitions.failedFiles && agentDefinitions.failedFiles.length > 0 && (
        <Box flexDirection="column">
          <Text bold color="error">Agent Parse Errors</Text>
          {agentDefinitions.failedFiles.map((file, index) => (
            <Text key={index} dimColor>└ {file.path}: {file.error}</Text>
          ))}
        </Box>
      )}

      {pluginErrors.length > 0 && (
        <Box flexDirection="column">
          <Text bold color="error">Plugin Errors</Text>
          {pluginErrors.map((error, index) => (
            <Text key={index} dimColor>
              └ {error.source || 'unknown'}
              {'plugin' in error && error.plugin ? ` [${error.plugin}]` : ''}: {getPluginErrorMessage(error)}
            </Text>
          ))}
        </Box>
      )}

      {contextWarnings?.unreachableRulesWarning && (
        <Box flexDirection="column">
          <Text bold color="warning">Unreachable Permission Rules</Text>
          <Text color="warning">
            └ {figures.warning} {contextWarnings.unreachableRulesWarning.message}
          </Text>
          {contextWarnings.unreachableRulesWarning.details.map((detail, index) => (
            <Text key={index} dimColor>  └ {detail}</Text>
          ))}
        </Box>
      )}

      {contextWarnings &&
        (contextWarnings.claudeMdWarning ||
          contextWarnings.agentWarning ||
          contextWarnings.mcpWarning) && (
          <Box flexDirection="column">
            <Text bold>Context Usage Warnings</Text>
            {[
              contextWarnings.claudeMdWarning,
              contextWarnings.agentWarning,
              contextWarnings.mcpWarning,
            ].map((warning, index) =>
              warning ? (
                <React.Fragment key={index}>
                  <Text color="warning">└ {figures.warning} {warning.message}</Text>
                  {warning.details.map((detail, detailIndex) => (
                    <Text key={detailIndex} dimColor>  └ {detail}</Text>
                  ))}
                </React.Fragment>
              ) : null,
            )}
          </Box>
        )}

      <Box>
        <PressEnterToContinue />
      </Box>
    </Pane>
  )
}
