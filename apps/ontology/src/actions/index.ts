import { procurementFlag } from './procurement/procurementFlag.ts'
/** Exact public action names dispatch typed handlers; metadata is applied separately from schema.ts. */
import { allocateStock, reallocateReservation, requestRfq } from './procurement/materialActions.ts'
import { createProposalApprove } from './shared/proposalApprove.ts'
import { proposalReject } from './shared/proposalReject.ts'
import { proposalEscalate } from './shared/proposalEscalate.ts'
import { defineActionHandler, type ActionHandler } from './types.ts'
export const actionHandlers: Record<string, ActionHandler> = {
  'procurementRequest.flag':defineActionHandler(procurementFlag),
  'procurementRequest.allocateStock':defineActionHandler(allocateStock),
  'procurementRequest.reallocateReservation':defineActionHandler(reallocateReservation),
  'procurementRequest.requestRfq':defineActionHandler(requestRfq),
}
// The shared approver invokes one inner action in its own transaction and records both audits.
actionHandlers['proposal.approve'] = defineActionHandler(createProposalApprove(actionHandlers))
actionHandlers['proposal.reject'] = defineActionHandler(proposalReject)
actionHandlers['proposal.escalate'] = defineActionHandler(proposalEscalate)
