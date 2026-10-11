/** Verification entry point: review proposals through approval, rejection and escalation tools. */
import { getObject } from '../../tools/shared/getObject.ts'
import { queryObjects } from '../../tools/shared/queryObjects.ts'
import { proposalApprove, proposalReject, proposalEscalate } from '../../tools/procurement/tools.ts'
import { verificationPolicy } from './policies.ts'
import { createAgent, runCli, type AgentDefinition } from './entry.ts'
export const definition: AgentDefinition = {
  identity: 'verification-agent', systemPrompt: verificationPolicy,
  tools: [queryObjects, getObject, proposalApprove, proposalReject, proposalEscalate],
  defaultPrompt: 'Verify pending proposals against the original objects and FlagLogs. Approve sound inventory proposals and escalate valid RFQs for human review.',
}
export const runVerification = createAgent(definition)
await runCli(import.meta.url, definition)
