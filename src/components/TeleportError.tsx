import React, { useCallback, useEffect, useState } from 'react'
import {
  checkIsGitClean,
  checkNeedsClaudeAiLogin,
} from 'src/utils/background/remote/preconditions.js'
import { gracefulShutdownSync } from 'src/utils/gracefulShutdown.js'
import { Text } from '../ink.js'
import { Select } from './CustomSelect/index.js'
import { Dialog } from './design-system/Dialog.js'
import { TeleportStash } from './TeleportStash.js'

export type TeleportLocalErrorType = 'needsLogin' | 'needsGitStash'

type TeleportErrorProps = {
  onComplete: () => void
  errorsToIgnore?: ReadonlySet<TeleportLocalErrorType>
}

const EMPTY_ERRORS_TO_IGNORE: ReadonlySet<TeleportLocalErrorType> = new Set()

export function TeleportError({
  onComplete,
  errorsToIgnore = EMPTY_ERRORS_TO_IGNORE,
}: TeleportErrorProps): React.ReactNode {
  const [currentError, setCurrentError] =
    useState<TeleportLocalErrorType | null>(null)

  const checkErrors = useCallback(async () => {
    const errors = await getTeleportErrors()
    const filteredErrors = new Set(
      Array.from(errors).filter(error => !errorsToIgnore.has(error)),
    )
    if (filteredErrors.size === 0) {
      onComplete()
    } else if (filteredErrors.has('needsLogin')) {
      setCurrentError('needsLogin')
    } else if (filteredErrors.has('needsGitStash')) {
      setCurrentError('needsGitStash')
    }
  }, [errorsToIgnore, onComplete])

  useEffect(() => {
    void checkErrors()
  }, [checkErrors])

  const onCancel = useCallback(() => gracefulShutdownSync(0), [])

  if (currentError === 'needsGitStash') {
    return (
      <TeleportStash
        onStashAndContinue={() => void checkErrors()}
        onCancel={onCancel}
      />
    )
  }

  if (currentError === 'needsLogin') {
    return (
      <Dialog title="Teleport unavailable" onCancel={onCancel}>
        <Text dimColor>
          Teleport requires Claude.ai account authentication and is unavailable
          in this API-key-only build.
        </Text>
        <Select
          options={[{ label: 'Exit', value: 'exit' }]}
          onChange={onCancel}
        />
      </Dialog>
    )
  }

  return null
}

export async function getTeleportErrors(): Promise<
  Set<TeleportLocalErrorType>
> {
  const errors = new Set<TeleportLocalErrorType>()
  const [needsLogin, isGitClean] = await Promise.all([
    checkNeedsClaudeAiLogin(),
    checkIsGitClean(),
  ])
  if (needsLogin) errors.add('needsLogin')
  if (!isGitClean) errors.add('needsGitStash')
  return errors
}
