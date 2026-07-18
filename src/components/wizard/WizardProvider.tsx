import React, { createContext, useCallback, useEffect, useMemo, useState } from 'react'
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js'
import type { WizardContextValue, WizardProviderProps } from './types.js'

export const WizardContext = createContext<WizardContextValue<Record<string, unknown>> | null>(null)

export function WizardProvider<
  T extends Record<string, unknown> = Record<string, unknown>,
>({
  steps,
  initialData = {} as T,
  onComplete,
  onCancel,
  children,
  title,
  showStepCounter = true,
}: WizardProviderProps<T>): React.ReactNode {
  const [currentStepIndex, setCurrentStepIndex] = useState(0)
  const [wizardData, setWizardData] = useState<T>(initialData)
  const [isCompleted, setIsCompleted] = useState(false)
  const [navigationHistory, setNavigationHistory] = useState<number[]>([])

  useExitOnCtrlCDWithKeybindings()

  useEffect(() => {
    if (isCompleted) onComplete(wizardData)
  }, [isCompleted, onComplete, wizardData])

  const goNext = useCallback(() => {
    if (currentStepIndex < steps.length - 1) {
      setNavigationHistory(previous => [...previous, currentStepIndex])
      setCurrentStepIndex(previous => previous + 1)
      return
    }
    setIsCompleted(true)
  }, [currentStepIndex, steps.length])

  const goBack = useCallback(() => {
    const previousStep = navigationHistory.at(-1)
    if (previousStep !== undefined) {
      setNavigationHistory(previous => previous.slice(0, -1))
      setCurrentStepIndex(previousStep)
      return
    }
    if (currentStepIndex > 0) {
      setCurrentStepIndex(previous => previous - 1)
      return
    }
    onCancel?.()
  }, [currentStepIndex, navigationHistory, onCancel])

  const goToStep = useCallback(
    (index: number) => {
      if (index < 0 || index >= steps.length || index === currentStepIndex) return
      setNavigationHistory(previous => [...previous, currentStepIndex])
      setCurrentStepIndex(index)
    },
    [currentStepIndex, steps.length],
  )

  const cancel = useCallback(() => {
    setNavigationHistory([])
    onCancel?.()
  }, [onCancel])

  const updateWizardData = useCallback((updates: Partial<T>) => {
    setWizardData(previous => ({ ...previous, ...updates }))
  }, [])

  const contextValue = useMemo<WizardContextValue<T>>(
    () => ({
      currentStepIndex,
      totalSteps: steps.length,
      wizardData,
      setWizardData,
      updateWizardData,
      goNext,
      goBack,
      goToStep,
      cancel,
      title,
      showStepCounter,
    }),
    [
      cancel,
      currentStepIndex,
      goBack,
      goNext,
      goToStep,
      showStepCounter,
      steps.length,
      title,
      updateWizardData,
      wizardData,
    ],
  )

  const CurrentStepComponent = steps[currentStepIndex]
  if (!CurrentStepComponent || isCompleted) return null

  return (
    <WizardContext.Provider
      value={contextValue as WizardContextValue<Record<string, unknown>>}
    >
      {children ?? <CurrentStepComponent />}
    </WizardContext.Provider>
  )
}
