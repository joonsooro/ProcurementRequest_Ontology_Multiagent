/** The three procurement mutations. Metadata validates input shape; these handlers validate current facts.
 * Approval owns the transaction. Stock row locks serialize allocations made through these handlers;
 * they do not lock external ERP systems or turn the demo caller header into authentication.
 */
import { randomUUID } from 'node:crypto'
import type { Transaction } from 'kysely'
import type { ActionContext } from '../types.ts'
import { auditParams, withActionTransaction } from '../shared/transaction.ts'
import type { ActionParams, Database, JsonValue, ProcurementRequestTable,
  allocateStockDefinition, reallocateReservationDefinition, requestRfqDefinition } from '../../schema.ts'

type Allocation = ActionParams<typeof allocateStockDefinition.parameter_schema>
type Reallocation = ActionParams<typeof reallocateReservationDefinition.parameter_schema>
type Rfq = ActionParams<typeof requestRfqDefinition.parameter_schema>
const epsilon = 1e-9
function requireApproval(context: ActionContext) {
  if (context.authorizedByProposal === undefined) throw new Error('Create and approve a Proposal before executing this action')
}
function positive(quantity: number) {
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('Quantity must be positive and finite')
}
/** Lock the current work and read its demand. JSON IDs remain data, not additional catalog links. */
async function demand(trx: Transaction<Database>, context: ActionContext, requestId: string, materialId: string) {
  const db = trx.withSchema(context.metadataSchema)
  const request = await db.selectFrom('procurement_request').selectAll().where('id','=',requestId).forUpdate().executeTakeFirstOrThrow()
  const work = await db.selectFrom('maintenance_work_order').selectAll().where('id','=',request.work_order_id).forUpdate().executeTakeFirstOrThrow()
  if (!['planned','inProgress'].includes(work.status)) throw new Error('Target work order is not active')
  const requirement = work.required_materials.find(item => item.materialId === materialId)
  if (!requirement) throw new Error('Material is not required by this work order')
  const material = await db.selectFrom('material').selectAll().where('id','=',materialId).executeTakeFirstOrThrow()
  const allocations = await db.selectFrom('reservation').selectAll().where('procurement_request_id','=',requestId)
    .where('required_material_id','=',materialId).where('status','=','active').execute()
  const allocated = allocations.reduce((sum, row) => sum + row.quantity, 0)
  return { db, request, work, material, required: requirement.requiredQuantity, allocated, remaining: requirement.requiredQuantity - allocated }
}
/** Every writer for a stock pool locks the same row before reading its active reservations. */
async function stockState(data: Awaited<ReturnType<typeof demand>>, stockId: string) {
  const stock = await data.db.selectFrom('stock').selectAll().where('id','=',stockId).forUpdate().executeTakeFirstOrThrow()
  if (stock.warehouse_code !== data.work.material_warehouse_code) throw new Error('Stock is in a different warehouse')
  if (stock.material_id !== data.material.id && !data.material.approved_alternative_material_ids.includes(stock.material_id)) {
    throw new Error('Stock material is not the required material or a directly approved alternative')
  }
  const actual = await data.db.selectFrom('material').selectAll().where('id','=',stock.material_id).executeTakeFirstOrThrow()
  if (actual.base_unit !== data.material.base_unit) throw new Error('Alternative units do not match; conversion is not supported')
  const reservations = await data.db.selectFrom('reservation').selectAll().where('stock_id','=',stock.id).where('status','=','active').execute()
  const reserved = reservations.reduce((sum, row) => sum + row.quantity,0)
  if (reserved > stock.on_hand_quantity + epsilon) throw new Error('Stock is over-reserved; reconcile the source facts first')
  return { stock, reservations, free: stock.on_hand_quantity - reserved }
}
async function insertAllocation(data: Awaited<ReturnType<typeof demand>>, stockId: string, quantity: number) {
  const now = new Date()
  return data.db.insertInto('reservation').values({ id: `RES-${randomUUID()}`, procurement_request_id: data.request.id,
    stock_id: stockId, required_material_id: data.material.id, quantity, status:'active', reserved_at:now,
    released_at:null, observed_at:now }).returningAll().executeTakeFirstOrThrow()
}
/** The result is the evidence shown in request history. A failed audit rolls back the mutation too. */
async function record(trx: Transaction<Database>, context: ActionContext, id: string, params: Record<string, JsonValue>, result: Record<string, JsonValue>) {
  await trx.withSchema(context.metadataSchema).insertInto('audit_log').values({
    action_type_id:context.actionTypeId, action_api_name:context.actionApiName, target_type_id:context.objectTypeId,
    target_type_api_name:context.objectTypeApiName, target_id:id, actor:context.callerIdentity ?? context.actor,
    params:auditParams(context,params), result, created_at:new Date(),
  }).execute()
  return result
}
export async function allocateStock(instance: ProcurementRequestTable, params: Allocation | undefined, context: ActionContext) {
  requireApproval(context)
  if (!params) throw new Error('Allocation parameters are required')
  positive(params.quantity)
  return withActionTransaction(context, async trx => {
    const data = await demand(trx,context,instance.id,params.requiredMaterialId)
    const state = await stockState(data,params.stockId)
    if (params.quantity > data.remaining + epsilon) throw new Error('Quantity exceeds the current unmet demand')
    if (params.quantity > state.free + epsilon) throw new Error('Not enough unreserved stock')
    const reservation = await insertAllocation(data,state.stock.id,params.quantity)
    return record(trx,context,instance.id,params,{ reservationId:reservation.id, stockId:state.stock.id,
      requiredMaterialId:data.material.id, actualMaterialId:state.stock.material_id, quantity:params.quantity,
      allocatedBefore:data.allocated, allocatedAfter:data.allocated+params.quantity,
      freeBefore:state.free, freeAfter:state.free-params.quantity, onHandUnchanged:state.stock.on_hand_quantity })
  })
}
export async function reallocateReservation(instance: ProcurementRequestTable, params: Reallocation | undefined, context: ActionContext) {
  requireApproval(context)
  if (!params) throw new Error('Reallocation parameters are required')
  positive(params.quantity)
  return withActionTransaction(context, async trx => {
    const data = await demand(trx,context,instance.id,params.requiredMaterialId)
    const source = await data.db.selectFrom('reservation').selectAll().where('id','=',params.sourceReservationId).executeTakeFirstOrThrow()
    if (source.procurement_request_id === instance.id) throw new Error('Source and destination requests must differ')
    // Lock stock before reservation, using the same order as normal allocations.
    const state = await stockState(data,source.stock_id)
    const currentSource = await data.db.selectFrom('reservation').selectAll().where('id','=',source.id).forUpdate().executeTakeFirstOrThrow()
    if (currentSource.status !== 'active') throw new Error('Source reservation is no longer active')
    const sourceRequest = await data.db.selectFrom('procurement_request').selectAll().where('id','=',source.procurement_request_id).executeTakeFirstOrThrow()
    const sourceWork = await data.db.selectFrom('maintenance_work_order').selectAll().where('id','=',sourceRequest.work_order_id).forUpdate().executeTakeFirstOrThrow()
    if (sourceWork.status !== 'cancelled' || !sourceWork.cancelled_at || !sourceWork.cancellation_reason?.trim()) {
      throw new Error('Source work order has no confirmed cancellation; reservation must be retained')
    }
    if (params.quantity > data.remaining + epsilon) throw new Error('Quantity exceeds the current unmet demand')
    if (params.quantity > state.free + currentSource.quantity + epsilon) throw new Error('Released plus unreserved stock is insufficient')
    // Release the whole obsolete reservation. Any unused remainder becomes free stock; physical stock stays fixed.
    const now = new Date()
    await data.db.updateTable('reservation').set({status:'released',released_at:now,observed_at:now}).where('id','=',source.id).execute()
    const reservation = await insertAllocation(data,state.stock.id,params.quantity)
    return record(trx,context,instance.id,params,{ sourceReservationId:source.id, sourceRequestId:sourceRequest.id,
      sourceWorkOrderId:sourceWork.id, cancellationReason:sourceWork.cancellation_reason, cancelledAt:sourceWork.cancelled_at.toISOString(),
      sourceReservedBefore:currentSource.quantity, sourceReservedAfter:0, reservationId:reservation.id, stockId:state.stock.id,
      requiredMaterialId:data.material.id, quantity:params.quantity, allocatedBefore:data.allocated, allocatedAfter:data.allocated+params.quantity,
      freeBefore:state.free, freeAfter:state.free+currentSource.quantity-params.quantity, onHandUnchanged:state.stock.on_hand_quantity })
  })
}
export async function requestRfq(instance: ProcurementRequestTable, params: Rfq | undefined, context: ActionContext) {
  requireApproval(context)
  // proposal.approve calls this handler internally, so the outer route's caller list alone is insufficient.
  if ((context.callerIdentity ?? context.actor) !== 'buyer-kim') throw new Error('RFQ requires the human buyer reviewer')
  if (!params) throw new Error('RFQ parameters are required')
  positive(params.quantity)
  return withActionTransaction(context, async trx => {
    const data = await demand(trx,context,instance.id,params.requiredMaterialId)
    const deadline = new Date(params.requiredAt)
    if (deadline.getTime() !== data.work.planned_start_at.getTime() || deadline.getTime() <= Date.now()) throw new Error('RFQ deadline must match the current future work start')
    if (Math.abs(params.quantity - data.remaining) > epsilon || data.remaining <= 0) throw new Error('RFQ quantity must equal the current uncovered demand')
    const prior = await data.db.selectFrom('rfq_request').select('id').where('procurement_request_id','=',instance.id).where('required_material_id','=',data.material.id).executeTakeFirst()
    if (prior) throw new Error('An RFQ draft already exists for this requirement; review it before creating another')
    // Before buying, exhaust eligible internal supply. Existing valid reservations remain protected.
    const stocks = await data.db.selectFrom('stock').select('id').where('warehouse_code','=',data.work.material_warehouse_code)
      .where('material_id','in',[data.material.id,...data.material.approved_alternative_material_ids]).orderBy('id').execute()
    for (const candidate of stocks) {
      const state = await stockState(data,candidate.id)
      if (state.free > epsilon) throw new Error('Eligible unreserved stock must be allocated before requesting an RFQ')
      for (const reservation of state.reservations) {
        const owner = await data.db.selectFrom('procurement_request as r').innerJoin('maintenance_work_order as w','w.id','r.work_order_id')
          .select('w.status').where('r.id','=',reservation.procurement_request_id).executeTakeFirstOrThrow()
        if (owner.status === 'cancelled') throw new Error('A cancelled work order still holds eligible stock; review reallocation first')
      }
    }
    const quotation = await data.db.selectFrom('quotation').selectAll().where('id','=',params.quotationId).executeTakeFirstOrThrow()
    if (quotation.material_id !== data.material.id || quotation.supplier_code !== params.supplierCode) throw new Error('Historical quotation does not match the material and supplier')
    const id = `RFQ-${randomUUID()}`
    await data.db.insertInto('rfq_request').values({id,procurement_request_id:instance.id,required_material_id:data.material.id,
      supplier_code:params.supplierCode,quantity:params.quantity,required_at:deadline,warehouse_code:data.work.material_warehouse_code,
      reference_quotation_id:quotation.id,status:'draft',created_by:context.callerIdentity ?? context.actor,
      created_at:new Date(),authorized_by_proposal:context.authorizedByProposal!}).execute()
    return record(trx,context,instance.id,params,{rfqRequestId:id,status:'draft',externalDispatch:false,
      requiredMaterialId:data.material.id,supplierCode:params.supplierCode,quantity:params.quantity,requiredAt:deadline.toISOString(),
      referenceQuotationId:quotation.id,allocatedUnchanged:data.allocated,uncoveredQuantity:data.remaining})
  })
}
