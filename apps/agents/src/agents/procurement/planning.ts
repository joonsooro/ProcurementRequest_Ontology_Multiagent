/** Planning entry point: read flagged requests and propose actions without executing them. */
import { getObject } from '../../tools/shared/getObject.ts'
import { queryObjects } from '../../tools/shared/queryObjects.ts'
import { proposeAllocateStock, proposeReallocateReservation, proposeRequestRfq } from '../../tools/procurement/tools.ts'
import { planningPolicy } from './policies.ts'
import { createAgent, runCli, type AgentDefinition } from './entry.ts'
export const definition: AgentDefinition = {
  identity: 'planning-agent', systemPrompt: planningPolicy,
  tools: [queryObjects, getObject, proposeAllocateStock, proposeReallocateReservation, proposeRequestRfq],
  defaultPrompt: 'Read open FlagLogs and source evidence. Create one supported, independent procurement action Proposal per uncovered material; skip equivalent pending/escalated proposals.',
}
export const runPlanning = createAgent(definition)
await runCli(import.meta.url, definition)
