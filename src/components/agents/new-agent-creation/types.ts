import type { AgentMemoryScope } from '../../../tools/AgentTool/agentMemory.js'
import type { AgentColorName } from '../../../tools/AgentTool/agentColorManager.js'
import type { AgentDefinition } from '../../../tools/AgentTool/loadAgentsDir.js'
import type { SettingSource } from '../../../utils/settings/constants.js'
import type { generateAgent } from '../generateAgent.js'

export type AgentWizardData = Record<string, unknown> & {
  location?: SettingSource
  method?: 'generate' | 'manual'
  generationPrompt?: string
  agentType?: string
  whenToUse?: string
  systemPrompt?: string
  selectedTools?: string[]
  selectedModel?: string
  selectedColor?: AgentColorName
  selectedMemory?: AgentMemoryScope
  generatedAgent?: Awaited<ReturnType<typeof generateAgent>>
  finalAgent?: AgentDefinition
  wasGenerated?: boolean
  isGenerating?: boolean
}
