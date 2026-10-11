/** Persist a procurement concern and its audit record in one transaction.
 * Only the observation changes. The request lock and partial unique index prevent duplicate open flags.
 */
import { randomUUID } from 'node:crypto'
import { procurementFlagDefinition, type ActionParams, type ProcurementRequestTable } from '../../schema.ts'
import type { ActionContext } from '../types.ts'
import { withActionTransaction } from '../shared/transaction.ts'

type FlagParams = ActionParams<typeof procurementFlagDefinition.parameter_schema>
export async function procurementFlag(instance: ProcurementRequestTable, params: FlagParams | undefined, context: ActionContext) {
  if (!params?.reason?.trim() || !procurementFlagDefinition.parameter_schema.properties.severity.enum.includes(params.severity)) {
    throw new Error('A non-empty reason and severity (low, medium, high) are required')
  }
  return withActionTransaction(context, async trx => {
    const db = trx.withSchema(context.metadataSchema)
    await db.selectFrom('procurement_request').select('id').where('id','=',instance.id).forUpdate().executeTakeFirstOrThrow()
    const existing = await db.selectFrom('flag_log').selectAll().where('procurement_request_id','=',instance.id).where('status','=','open').executeTakeFirst()
    if (existing) return { ...existing, reused: true }
    const now = new Date()
    const actor = context.callerIdentity ?? context.actor
    const flag = await db.insertInto('flag_log').values({ id: `FL-${randomUUID()}`, procurement_request_id: instance.id,
      reason: params.reason.trim(), severity: params.severity, status:'open', flagged_by:actor, flagged_at:now, resolved_at:null,
    }).returningAll().executeTakeFirstOrThrow()
    await db.insertInto('audit_log').values({ action_type_id:context.actionTypeId, action_api_name:context.actionApiName,
      target_type_id:context.objectTypeId, target_type_api_name:context.objectTypeApiName, target_id:instance.id,
      actor, params:{reason:params.reason,severity:params.severity},
      result:{flagLogId:flag.id,procurementRequestId:instance.id,severity:flag.severity,status:flag.status},created_at:now,
    }).execute()
    return { ...flag, reused: false }
  })
}
