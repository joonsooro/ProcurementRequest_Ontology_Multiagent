/** Monitoring entry point: read procurement evidence and record concerns through the flag tool. */
import { getObject } from '../../tools/shared/getObject.ts'
import { queryObjects } from '../../tools/shared/queryObjects.ts'
import { procurementFlag } from '../../tools/procurement/tools.ts'
import { monitoringPolicy } from './policies.ts'
import { createAgent, runCli, type AgentDefinition } from './entry.ts'
export const definition: AgentDefinition = {
  identity: 'monitoring-agent', systemPrompt: monitoringPolicy,
  tools: [queryObjects, getObject, procurementFlag],
  defaultPrompt: 'Scan all planned maintenance requests. Report each as a supported concern or healthy. Persist supported concerns as FlagLogs without choosing interventions.',
}
export const runMonitoring = createAgent(definition)
await runCli(import.meta.url, definition)
