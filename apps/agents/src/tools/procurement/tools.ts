/** Fixed, per-action tools restrict writes to explicitly supported business operations. Models never choose arbitrary HTTP routes.
 * Proposal routing/provenance stay outside params. All writes use the audited ontology API.
 */
import { z } from 'zod'

function baseUrl() {
  const value = process.env.ONTOLOGY_URL ?? process.env.HONO_URL
  if (!value) throw new Error('ONTOLOGY_URL must be set')
  return value.replace(/\/$/, '')
}
async function post(path: string, body: unknown) {
  const identity = process.env.CALLER_IDENTITY
  if (!identity) throw new Error('CALLER_IDENTITY must be set by the agent runtime')
  const response = await fetch(`${baseUrl()}/api/objects/${path}`, {
    method: 'POST', headers: { 'content-type':'application/json', 'x-caller-identity':identity }, body: JSON.stringify(body),
  })
  const result: unknown = await response.json().catch(() => null)
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${result && typeof result === 'object' && 'error' in result ? result.error : 'Ontology write failed'}`)
  return result
}
async function propose(action: string, requestId: string, params: Record<string,string|number>, rationale: string) {
  // The server replaces proposedAt with its advancing demo clock and owns the generated ID.
  return post('proposal', { type:`procurementRequest.${action}`, targetId:requestId, params, rationale,
    status:'pending', proposedBy:process.env.CALLER_IDENTITY, proposedAt:process.env.DEMO_NOW ?? new Date().toISOString() })
}
export type OntologyTool = { name: string; description: string; schema: z.ZodType; execute: (args: unknown) => Promise<unknown> }
function defineTool<T extends z.ZodType>(name: string, description: string, schema: T, run: (input: z.infer<T>) => Promise<unknown>): OntologyTool {
  return { name, description, schema, execute: args => run(schema.parse(args)) }
}
const id = z.string().trim().min(1)
const rationale = z.string().trim().min(1).describe('English rationale citing the open FlagLog, request and source object IDs; distinguish facts from inference.')
const quantity = z.number().positive().finite()
const proposalId = z.number().int().positive()

export const procurementFlag = defineTool('procurement_flag',
  'Record one evidence-backed procurement concern. This creates an open FlagLog, not an allocation or Proposal. An existing open request flag is reused.',
  z.object({requestId:id, reason:rationale, severity:z.enum(['low','medium','high'])}).strict(),
  ({requestId,reason,severity}) => post(`procurementRequest/${encodeURIComponent(requestId)}/actions/flag`,{reason,severity}))
export const proposeAllocateStock = defineTool('propose_allocate_stock',
  'Create one pending allocateStock Proposal for free stock of the required or approved alternative material. Does not allocate yet.',
  z.object({requestId:id, requiredMaterialId:id, stockId:id, quantity, rationale}).strict(),
  ({requestId,requiredMaterialId,stockId,quantity,rationale}) => propose('allocateStock',requestId,{requiredMaterialId,stockId,quantity},rationale))
export const proposeReallocateReservation = defineTool('propose_reallocate_reservation',
  'Propose releasing the entire obsolete source reservation and allocating quantity to the target request from that same stock pool, including free stock. Source work must have confirmed cancellation.',
  z.object({requestId:id, sourceReservationId:id, requiredMaterialId:id, quantity, rationale}).strict(),
  ({requestId,sourceReservationId,requiredMaterialId,quantity,rationale}) => propose('reallocateReservation',requestId,{sourceReservationId,requiredMaterialId,quantity},rationale))
export const proposeRequestRfq = defineTool('propose_request_rfq',
  'Propose an RFQ draft for the current uncovered quantity after checking internal supply. Historical quotation is a reference only. Human approval is mandatory.',
  z.object({requestId:id, requiredMaterialId:id, supplierCode:id, quantity, requiredAt:z.iso.datetime({offset:true}), quotationId:id, rationale}).strict(),
  ({requestId,requiredMaterialId,supplierCode,quantity,requiredAt,quotationId,rationale}) => propose('requestRfq',requestId,{requiredMaterialId,supplierCode,quantity,requiredAt,quotationId},rationale))
export const proposalApprove = defineTool('proposal_approve',
  'Approve a pending Proposal and execute the stored action atomically. Verification agents may approve stock actions only; RFQs and escalated items require a human.',
  z.object({proposalId,decisionNote:rationale}).strict(),
  ({proposalId,decisionNote}) => post(`proposal/${proposalId}/actions/approve`,{decisionNote}))
export const proposalReject = defineTool('proposal_reject',
  'Reject a clearly invalid or obsolete Proposal with evidence. Does not run the proposed action.',
  z.object({proposalId,decisionNote:rationale}).strict(),
  ({proposalId,decisionNote}) => post(`proposal/${proposalId}/actions/reject`,{decisionNote}))
export const proposalEscalate = defineTool('proposal_escalate',
  'Move a pending Proposal to human review. Always escalate a valid RFQ; identify missing decisive evidence for uncertain stock proposals.',
  z.object({proposalId,note:rationale}).strict(),
  ({proposalId,note}) => post(`proposal/${proposalId}/actions/escalate`,{note}))
export const procurementTools = [procurementFlag,proposeAllocateStock,proposeReallocateReservation,proposeRequestRfq,proposalApprove,proposalReject,proposalEscalate]
