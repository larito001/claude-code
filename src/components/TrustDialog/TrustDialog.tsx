import { homedir } from 'node:os'
import React from 'react'
import { setSessionTrustAccepted } from '../../bootstrap/state.js'
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js'
import { Box, Link, Text } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import {
  checkHasTrustDialogAccepted,
  saveCurrentProjectConfig,
} from '../../utils/config.js'
import { getCwd } from '../../utils/cwd.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { gracefulShutdownSync } from '../../utils/gracefulShutdown.js'
import { Select } from '../CustomSelect/index.js'
import { PermissionDialog } from '../permissions/PermissionDialog.js'

type Props = {
  /** 在信任确认完成或已提前确认时继续启动流程。 */
  onDone(): void
}

/** 显示工作区信任确认，并将非主目录项目的选择持久化。 */
export function TrustDialog({ onDone }: Props): React.ReactNode {
  const hasAccepted = checkHasTrustDialogAccepted()
  /** 连续按下退出快捷键时终止当前进程。 */
  const exitState = useExitOnCtrlCDWithKeybindings(() =>
    gracefulShutdownSync(1),
  )

  /** 处理用户的信任选择。 */
  function handleChange(value: 'enable_all' | 'exit'): void {
    if (value === 'exit') {
      gracefulShutdownSync(1)
      return
    }

    if (homedir() === getCwd()) {
      // 主目录的信任只在当前会话生效，避免永久信任过宽目录。
      setSessionTrustAccepted(true)
    } else {
      saveCurrentProjectConfig(current => ({
        ...current,
        hasTrustDialogAccepted: true,
      }))
    }
    onDone()
  }

  useKeybinding(
    'confirm:no',
    () => gracefulShutdownSync(0),
    { context: 'Confirmation' },
  )

  React.useEffect(() => {
    if (!hasAccepted) return undefined
    const timer = setTimeout(onDone, 0)
    return () => clearTimeout(timer)
  }, [hasAccepted, onDone])

  if (hasAccepted) return null

  return (
    <PermissionDialog
      color="warning"
      titleColor="warning"
      title="Accessing workspace:"
    >
      <Box flexDirection="column" gap={1} paddingTop={1}>
        <Text bold>{getFsImplementation().cwd()}</Text>
        <Text>
          Quick safety check: Is this a project you created or one you trust?
          (Like your own code, a well-known open source project, or work from your
          team). If not, take a moment to review what&apos;s in this folder first.
        </Text>
        <Text>
          Claude Code will be able to read, edit, and execute files here.
        </Text>
        <Text dimColor>
          <Link url="https://code.claude.com/docs/en/security">
            Security guide
          </Link>
        </Text>
        <Select
          options={[
            { label: 'Yes, I trust this folder', value: 'enable_all' },
            { label: 'No, exit', value: 'exit' },
          ]}
          onChange={(value: string) =>
            handleChange(value as 'enable_all' | 'exit')
          }
          onCancel={() => handleChange('exit')}
        />
        <Text dimColor>
          {exitState.pending ? (
            <>Press {exitState.keyName} again to exit</>
          ) : (
            <>Enter to confirm · Esc to cancel</>
          )}
        </Text>
      </Box>
    </PermissionDialog>
  )
}
