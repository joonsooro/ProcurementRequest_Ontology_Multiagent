/** Submission checks avoid duplicate review work. This read-before-insert check is best effort,
 * not a reservation lock: competing submissions can race; execution still revalidates under row locks.
 */
import { Validator, type Schema } from '@cfworker/json-schema'
import type { Kysely } from 'kysely'
import type { Database } from '../../schema.ts'
export async function validateProposalSubmission(database: Kysely<Database>, schema: string, input: Record<string, unknown>) {
  const db = database.withSchema(schema)
  if (input.status !== 'pending' || input.reviewedBy != null || input.reviewedAt != null || input.decisionNote != null) {
    throw new Error('New proposals must be pending with no review fields; use decision actions afterward')
  }
  const type = String(input.type)
  if (!['procurementRequest.allocateStock','procurementRequest.reallocateReservation','procurementRequest.requestRfq'].includes(type)) {
    throw new Error('A proposal must name one supported procurement action')
  }
  if (typeof input.rationale !== 'string' || !input.rationale.trim()) throw new Error('Proposal rationale is required')
  const target = await db.selectFrom('procurement_request').select('id').where('id','=',String(input.targetId)).executeTakeFirst()
  if (!target) throw new Error('Proposal target request not found')
  const action = await db.selectFrom('action_type as a').innerJoin('object_type as o','o.id','a.object_type_id')
    .select('a.parameter_schema').where('o.api_name','=','procurementRequest').where('a.api_name','=',type.split('.')[1]!).executeTakeFirstOrThrow()
  if (!new Validator(action.parameter_schema as Schema,'2020-12',false).validate(input.params).valid) throw new Error('Proposal action parameters are invalid')
  const params = input.params as Record<string, unknown>
  const unfinished = await db.selectFrom('proposal').selectAll().where('status','in',['pending','escalated']).execute()
  // A source reservation and the same stock pool cannot be promised twice in the ordinary sequential demo flow.
  async function pool(value: Record<string,unknown>): Promise<string | undefined> {
    if (typeof value.stockId === 'string') return value.stockId
    if (typeof value.sourceReservationId === 'string') {
      return (await db.selectFrom('reservation').select('stock_id').where('id','=',value.sourceReservationId).executeTakeFirst())?.stock_id
    }
  }
  const candidatePool = await pool(params)
  for (const proposal of unfinished) {
    const other = proposal.params as Record<string,unknown>
    if (proposal.target_id === target.id && other.requiredMaterialId === params.requiredMaterialId) throw new Error(`Proposal ${proposal.id} already awaits review for this requirement`)
    if (candidatePool && candidatePool === await pool(other)) throw new Error(`Proposal ${proposal.id} already awaits review for this stock pool`)
  }
}
