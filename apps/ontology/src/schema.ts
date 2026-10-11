/**
 * Procurement storage contracts and action metadata shared by handlers and the runtime catalog.
 * Instance facts use snake_case; the catalog maps public camelCase names onto them.
 * Required materials and approved alternatives remain properties, not hidden link resolvers.
 */
import type { Generated, Selectable } from 'kysely'
import { ACTIVE_ONTOLOGY_SCHEMA } from './config.ts'

export type JsonValue = boolean | number | string | null | JsonValue[] | { [key: string]: JsonValue }
export type RequiredMaterial = { materialId: string; requiredQuantity: number }

/** One request coordinates all material demand for one work order; demand is stored only there. */
export interface ProcurementRequestTable { id: string; work_order_id: string; requested_at: Date }
/** Current CMMS facts. Cancellation does not imply that ERP reservations have been released. */
export interface MaintenanceWorkOrderTable {
  id: string; description: string; asset_code: string; material_warehouse_code: string
  planned_start_at: Date; planned_end_at: Date | null
  status: 'planned' | 'inProgress' | 'completed' | 'cancelled'
  required_materials: RequiredMaterial[]
  cancelled_at: Date | null; cancellation_reason: string | null; observed_at: Date
}
/** Reusable material identity. All demo quantities use base_unit; alternatives are approved 1:1. */
export interface MaterialTable {
  id: string; name: string; base_unit: string; specification: JsonValue
  approved_alternative_material_ids: string[]
}
/** One homogeneous, usable material pool per warehouse; on-hand includes active reservations. */
export interface StockTable {
  id: string; material_id: string; warehouse_code: string; on_hand_quantity: number; observed_at: Date
}
/** required_material_id identifies demand; stock_id identifies the actual material supplied. */
export interface ReservationTable {
  id: string; procurement_request_id: string; stock_id: string; required_material_id: string
  quantity: number; status: 'active' | 'released'; reserved_at: Date; released_at: Date | null; observed_at: Date
}
/** A historical offer for a material, never implicitly an offer for the current procurement request. */
export interface QuotationTable {
  id: string; material_id: string; supplier_code: string; supplier_name: string
  quoted_quantity: number; unit_price: number; currency: string; shipping_cost: number
  requested_required_at: Date; offered_arrival_at: Date; quoted_at: Date; valid_until: Date | null
}
/** Proposal execution contract: one case-sensitive action, one target, parameter-only JSON. */
export interface ProposalTable {
  id: Generated<number>; type: string; target_id: string; params: JsonValue; rationale: string
  status: 'pending' | 'escalated' | 'approved' | 'rejected'
  proposed_by: string; proposed_at: Date; reviewed_by: string | null; reviewed_at: Date | null; decision_note: string | null
}
export type Proposal = Selectable<ProposalTable>
/** A persistent observation about one request; quantities and demand remain on their owning objects.
 * Open flags are the monitor-to-planner handoff. Resolution is deliberately not automatic on approval.
 */
export interface FlagLogTable {
  id: string; procurement_request_id: string; reason: string
  severity: 'low' | 'medium' | 'high'; status: 'open' | 'resolved' | 'dismissed'
  flagged_by: string; flagged_at: Date; resolved_at: Date | null
}

/** Local RFQ execution receipt, not a seventh domain object or a supplier response. No external send occurs. */
export interface RfqRequestTable {
  id: string; procurement_request_id: string; required_material_id: string; supplier_code: string
  quantity: number; required_at: Date; warehouse_code: string; reference_quotation_id: string
  status: 'draft'; created_by: string; created_at: Date; authorized_by_proposal: number
}
interface ObjectTypeTable {
  id: Generated<string>; api_name: string; name: string; description: string | null
  status: string; visibility: string; point_of_contact: string | null; edits_enabled: boolean
  schema: string; datasource_table: string
}
interface PropertyTable {
  id: Generated<string>; api_name: string; name: string; object_type_id: string; data_type: string
  required: boolean; is_title: boolean; is_primary_key: boolean; datasource_column: string
}
interface LinkTable {
  id: Generated<string>; api_name: string; name: string; inverse_api_name: string; inverse_name: string
  source_type_id: string; target_type_id: string; via_property_id: string; cardinality: string
}
interface ActionTypeTable {
  id: Generated<string>; api_name: string; name: string; object_type_id: string
  description: string | null; parameter_schema: JsonValue; allowed_callers: Generated<string[] | null>
}
/** Record the caller-policy decision before input validation; this log does not track execution progress. */
interface AccessLogTable {
  id: Generated<string>; caller_identity: string; action_type: string; target_type: string; target_id: string
  decision: 'allowed' | 'denied'; reason: string; timestamp: Generated<Date>
}
interface AuditLogTable {
  id: Generated<string>; action_type_id: string; action_api_name: string; target_type_id: string
  target_type_api_name: string; target_id: string; actor: string; params: JsonValue | null
  result: JsonValue | null; created_at: Generated<Date>
}
/** Unqualified keys let handlers use withSchema for the active domain or an isolated test schema. */
export interface ProcurementTables {
  procurement_request: ProcurementRequestTable; maintenance_work_order: MaintenanceWorkOrderTable
  material: MaterialTable; stock: StockTable; reservation: ReservationTable
  quotation: QuotationTable; flag_log: FlagLogTable; proposal: ProposalTable; rfq_request: RfqRequestTable
}
export interface Database extends ProcurementTables {
  object_type: ObjectTypeTable; property: PropertyTable; link: LinkTable; action_type: ActionTypeTable
  access_log: AccessLogTable; audit_log: AuditLogTable
  'procurement.procurement_request': ProcurementRequestTable
  'procurement.maintenance_work_order': MaintenanceWorkOrderTable
  'procurement.material': MaterialTable; 'procurement.stock': StockTable
  'procurement.reservation': ReservationTable; 'procurement.quotation': QuotationTable
  'procurement.flag_log': FlagLogTable; 'procurement.proposal': ProposalTable; 'procurement.rfq_request': RfqRequestTable
}

type ParameterProperty = {
  type: 'string' | 'number' | 'integer'; format?: string; enum?: readonly string[]
  minLength?: number; minimum?: number; exclusiveMinimum?: number; description?: string
}
type ParameterSchema = {
  type: 'object'; properties: Readonly<Record<string, ParameterProperty>>
  required: readonly string[]; additionalProperties: false
}
type ParameterValue<P extends ParameterProperty> = P['type'] extends 'number' | 'integer'
  ? number : P extends { enum: readonly (infer E)[] } ? E : string
export type ActionParams<S extends ParameterSchema> = {
  -readonly [K in keyof S['properties'] as K extends S['required'][number] ? K : never]: ParameterValue<S['properties'][K]>
} & { -readonly [K in keyof S['properties'] as K extends S['required'][number] ? never : K]?: ParameterValue<S['properties'][K]> }
type ActionDefinition = {
  objectType: string; api_name: string; name: string; description: string
  parameter_schema: ParameterSchema; allowed_callers?: readonly string[] | null
}
const textId = { type: 'string', minLength: 1 } as const
const quantity = { type: 'number', exclusiveMinimum: 0 } as const

/** All three domain actions execute only through a reviewed Proposal; the handlers enforce this too. */
export const allocateStockDefinition = {
  objectType: 'procurementRequest', api_name: 'allocateStock', name: 'Allocate stock',
  description: 'Allocate free stock of the required material or an approved alternative. Requires Proposal approval.',
  allowed_callers: ['buyer-kim', 'verification-agent'],
  parameter_schema: { type: 'object', properties: { requiredMaterialId: textId, stockId: textId, quantity },
    required: ['requiredMaterialId', 'stockId', 'quantity'], additionalProperties: false },
} as const satisfies ActionDefinition
export const reallocateReservationDefinition = {
  objectType: 'procurementRequest', api_name: 'reallocateReservation', name: 'Reallocate cancelled-work reservation',
  description: 'Release one active reservation of a confirmed cancelled work order and allocate from the same stock pool, including free stock.',
  allowed_callers: ['buyer-kim', 'verification-agent'],
  parameter_schema: { type: 'object', properties: { sourceReservationId: textId, requiredMaterialId: textId, quantity },
    required: ['sourceReservationId', 'requiredMaterialId', 'quantity'], additionalProperties: false },
} as const satisfies ActionDefinition
export const requestRfqDefinition = {
  objectType: 'procurementRequest', api_name: 'requestRfq', name: 'Request shortage RFQ',
  description: 'Record an RFQ draft for the current shortage after human approval. Historical quotations are references; no external dispatch or purchase occurs.',
  allowed_callers: ['buyer-kim'],
  parameter_schema: { type: 'object', properties: {
    requiredMaterialId: textId, supplierCode: textId, quantity,
    requiredAt: { type: 'string', format: 'date-time' }, quotationId: textId,
  }, required: ['requiredMaterialId', 'supplierCode', 'quantity', 'requiredAt', 'quotationId'], additionalProperties: false },
} as const satisfies ActionDefinition
export const proposalApproveDefinition = {
  objectType: 'proposal', api_name: 'approve', name: 'Approve',
  description: 'Execute the stored action and mark the proposal approved only if the complete transaction succeeds.',
  allowed_callers: ['buyer-kim', 'verification-agent'],
  parameter_schema: { type: 'object', properties: { decisionNote: { type: 'string' } }, required: [], additionalProperties: false },
} as const satisfies ActionDefinition
export const proposalRejectDefinition = {
  ...proposalApproveDefinition, api_name: 'reject', name: 'Reject', description: 'Reject the proposal and record the review reason without executing the business action.',
} as const satisfies ActionDefinition
export const proposalEscalateDefinition = {
  objectType: 'proposal', api_name: 'escalate', name: 'Escalate to human review',
  description: 'Record why human review is required without executing the proposed action.', allowed_callers: ['buyer-kim', 'verification-agent'],
  parameter_schema: { type: 'object', properties: { note: { type: 'string', minLength: 1 } }, required: ['note'], additionalProperties: false },
} as const satisfies ActionDefinition
/** Record observations directly without Proposal approval; flagging does not allocate stock. */
export const procurementFlagDefinition = {
  objectType: 'procurementRequest', api_name: 'flag', name: 'Record procurement concern',
  description: 'Create an open FlagLog with evidence, without changing demand or reservations. Reuse an existing open flag for this request.',
  allowed_callers: ['monitoring-agent', 'buyer-kim'],
  parameter_schema: { type: 'object', properties: {
    reason: { type: 'string', minLength: 1 }, severity: { type: 'string', enum: ['low','medium','high'] },
  }, required: ['reason','severity'], additionalProperties: false },
} as const satisfies ActionDefinition
export const actionDefinitions = [procurementFlagDefinition, allocateStockDefinition, reallocateReservationDefinition, requestRfqDefinition,
  proposalApproveDefinition, proposalRejectDefinition, proposalEscalateDefinition] as const

/** SQL literals are escaped for a generated migration file; never use these helpers for request queries. */
export function sqlLiteral(value: unknown): string { return `'${String(value).replaceAll("'", "''")}'` }
export function schemaIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error('Invalid schema identifier')
  return `"${value}"`
}
/** The action definitions above are the single source of truth for metadata and handler parameter types. */
export function buildActionMetadataSql(schema = ACTIVE_ONTOLOGY_SCHEMA as string): string {
  const s = schemaIdentifier(schema)
  return ['BEGIN;', ...actionDefinitions.map(action => `
INSERT INTO ${s}.action_type (object_type_id, api_name, name, description, parameter_schema, allowed_callers)
SELECT id, ${sqlLiteral(action.api_name)}, ${sqlLiteral(action.name)}, ${sqlLiteral(action.description)},
  ${sqlLiteral(JSON.stringify(action.parameter_schema))}::jsonb,
  ARRAY[${action.allowed_callers.map(sqlLiteral).join(',')}]::text[]
FROM ${s}.object_type WHERE api_name = ${sqlLiteral(action.objectType)}
ON CONFLICT (object_type_id, api_name) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description,
  parameter_schema=EXCLUDED.parameter_schema, allowed_callers=EXCLUDED.allowed_callers;`), 'COMMIT;'].join('\n')
}
