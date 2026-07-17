import React, { useCallback, useState } from 'react'
import TextInput from '../../components/TextInput.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, color, Text, useTheme } from '../../ink.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'

interface ApiKeyStepProps {
  existingApiKey: string | null
  useExistingKey: boolean
  apiKeyOrOAuthToken: string
  onApiKeyChange: (value: string) => void
  onToggleUseExistingKey: (useExisting: boolean) => void
  onSubmit: () => void
  selectedOption?: 'existing' | 'new'
  onSelectOption?: (option: 'existing' | 'new') => void
}

export function ApiKeyStep({
  existingApiKey,
  apiKeyOrOAuthToken,
  onApiKeyChange,
  onSubmit,
  onToggleUseExistingKey,
  selectedOption = existingApiKey ? 'existing' : 'new',
  onSelectOption,
}: ApiKeyStepProps) {
  const [cursorOffset, setCursorOffset] = useState(0)
  const terminalSize = useTerminalSize()
  const [theme] = useTheme()

  const selectExisting = useCallback(() => {
    if (!existingApiKey) return
    onSelectOption?.('existing')
    onToggleUseExistingKey(true)
  }, [existingApiKey, onSelectOption, onToggleUseExistingKey])

  const selectNew = useCallback(() => {
    onSelectOption?.('new')
    onToggleUseExistingKey(false)
  }, [onSelectOption, onToggleUseExistingKey])

  useKeybindings(
    {
      'confirm:previous': selectExisting,
      'confirm:next': selectNew,
      'confirm:yes': onSubmit,
    },
    { context: 'Confirmation', isActive: selectedOption !== 'new' },
  )

  return (
    <>
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>Install GitHub App</Text>
          <Text dimColor>Choose API key</Text>
        </Box>
        {existingApiKey && (
          <Box marginBottom={1}>
            <Text>
              {selectedOption === 'existing'
                ? color('success', theme)('> ')
                : '  '}
              Use your existing Claude Code API key
            </Text>
          </Box>
        )}
        <Box marginBottom={1}>
          <Text>
            {selectedOption === 'new'
              ? color('success', theme)('> ')
              : '  '}
            Enter a new API key
          </Text>
        </Box>
        {selectedOption === 'new' && (
          <TextInput
            value={apiKeyOrOAuthToken}
            onChange={onApiKeyChange}
            onSubmit={onSubmit}
            onPaste={onApiKeyChange}
            focus
            placeholder="sk-ant… (Create a new key at https://platform.claude.com/settings/keys)"
            mask="*"
            columns={terminalSize.columns}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
            showCursor
          />
        )}
      </Box>
      <Box marginLeft={3}>
        <Text dimColor>↑/↓ to select · Enter to continue</Text>
      </Box>
    </>
  )
}
