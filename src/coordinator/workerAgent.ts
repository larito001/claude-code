import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import { GENERAL_PURPOSE_AGENT } from '../tools/AgentTool/built-in/generalPurposeAgent.js'

const COORDINATOR_WORKER: AgentDefinition = {
  ...GENERAL_PURPOSE_AGENT,
  agentType: 'worker',
  whenToUse:
    'General implementation worker for coordinator mode. Use for substantial research, implementation, and verification tasks.',
  model: 'inherit',
}

export function getCoordinatorAgents(): AgentDefinition[] {
  return [COORDINATOR_WORKER]
}
