/** Read-only analytics entry point: expose query tools for evidence-based explanations. */
import { getObject } from '../../tools/shared/getObject.ts'
import { queryObjects } from '../../tools/shared/queryObjects.ts'
import { analyticsPolicy } from './policies.ts'
import { createAgent, runCli, type AgentDefinition } from './entry.ts'
export const definition: AgentDefinition = {
  identity: 'procurement-analytics-agent', systemPrompt: analyticsPolicy,
  tools: [queryObjects, getObject],
  defaultPrompt: 'Explain current coverage and procurement evidence for the planned maintenance requests. Cite object IDs and distinguish facts from options.',
}
export const runAnalytics = createAgent(definition)
await runCli(import.meta.url, definition)
