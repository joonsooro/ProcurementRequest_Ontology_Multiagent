/** Ontology catalog: stable public names map to storage columns; only scalar references become links. */
import { ACTIVE_ONTOLOGY_SCHEMA } from './config.ts'
import { sqlLiteral as q, schemaIdentifier } from './schema.ts'

type Field = { api: string; column: string; type: string; required: boolean; primary: boolean; title: boolean }
function fields(spec: string, title = 'id'): Field[] {
  // Compact declarations still spell out exceptional SQL mappings. '?' means nullable/optional on creation.
  return spec.trim().split(/\s+/).map(token => {
    const [name, rawType = 'string'] = token.split(':')
    const [api, explicitColumn] = name!.split('=')
    return { api: api!, column: explicitColumn ?? api!.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`),
      type: rawType.replace('?', ''), required: !rawType.endsWith('?'), primary: api === 'id', title: api === title }
  })
}
export const objectDefinitions = [
  { api: 'procurementRequest', table: 'procurement_request', name: 'Maintenance procurement request',
    description: 'Coordinates multiple materials for one work order. Read demand and schedule through workOrder and allocations through reservations.',
    fields: fields('id workOrderId requestedAt:datetime') },
  { api: 'maintenanceWorkOrder', table: 'maintenance_work_order', name: 'Maintenance work order',
    description: 'One CMMS work order. requiredMaterials contains material IDs and required quantities. Cancellation does not release ERP reservations.',
    fields: fields('id description assetCode materialWarehouseCode plannedStartAt:datetime plannedEndAt:datetime? status:enum requiredMaterials:json cancelledAt:datetime? cancellationReason:string? observedAt:datetime') },
  { api: 'material', table: 'material', name: 'Material',
    description: 'Material specifications, base unit and approved alternative IDs. The ID array is not a catalog link. Only same-unit 1:1 substitution is supported.',
    fields: fields('id name baseUnit specification:json approvedAlternativeMaterialIds:string[]', 'name') },
  { api: 'stock', table: 'stock', name: 'Stock',
    description: 'Usable on-hand stock for one material and warehouse. On-hand includes reservations; subtract active reservations to calculate free stock.',
    fields: fields('id materialId warehouseCode onHandQuantity:number observedAt:datetime') },
  { api: 'reservation', table: 'reservation', name: 'Reservation',
    description: 'Allocation from one stock pool to one required material of one request. Required and supplied materials can differ for approved alternatives.',
    fields: fields('id procurementRequestId stockId requiredMaterialId quantity:number status:enum reservedAt:datetime releasedAt:datetime? observedAt:datetime') },
  { api: 'quotation', table: 'quotation', name: 'Historical quotation',
    description: 'Historical supplier terms for one material. Reference for a new RFQ, not a current price or delivery commitment.',
    fields: fields('id materialId supplierCode supplierName quotedQuantity:number unitPrice:number currency shippingCost:number requestedRequiredAt:datetime offeredArrivalAt:datetime quotedAt:datetime validUntil:datetime?') },
  { api: 'flagLog', table: 'flag_log', name: 'Procurement concern',
    description: 'Persistent evidence from monitoring for one request. Planning reads open flags and creates proposals. Approval does not automatically resolve the observation.',
    fields: fields('id procurementRequestId reason severity:enum status:enum flaggedBy flaggedAt:datetime resolvedAt:datetime?') },
  { api: 'proposal', table: 'proposal', name: 'Proposal', edits: true,
    description: 'One action, target, parameter set and rationale. Approval revalidates current state and removes the item from the review queue only after successful execution.',
    fields: fields('id:number? type targetId params:json rationale status:enum proposedBy proposedAt:datetime reviewedBy:string? reviewedAt:datetime? decisionNote:string?') },
] as const
export const linkDefinitions = [
  { source: 'flagLog', target: 'procurementRequest', via: 'procurementRequestId', api: 'procurementRequest', inverse: 'flags', cardinality: 'many_to_one' },
  { source: 'procurementRequest', target: 'maintenanceWorkOrder', via: 'workOrderId', api: 'workOrder', inverse: 'procurementRequest', cardinality: 'one_to_one' },
  { source: 'reservation', target: 'procurementRequest', via: 'procurementRequestId', api: 'procurementRequest', inverse: 'reservations', cardinality: 'many_to_one' },
  { source: 'reservation', target: 'stock', via: 'stockId', api: 'stock', inverse: 'reservations', cardinality: 'many_to_one' },
  { source: 'reservation', target: 'material', via: 'requiredMaterialId', api: 'requiredMaterial', inverse: 'reservationsForRequirement', cardinality: 'many_to_one' },
  { source: 'stock', target: 'material', via: 'materialId', api: 'material', inverse: 'stocks', cardinality: 'many_to_one' },
  { source: 'quotation', target: 'material', via: 'materialId', api: 'material', inverse: 'quotations', cardinality: 'many_to_one' },
] as const
/** Re-running refreshes catalog definitions, never operational instance facts. UUID identity is retained. */
export function buildCatalogSql(schema: string = ACTIVE_ONTOLOGY_SCHEMA): string {
  const s = schemaIdentifier(schema)
  return ['BEGIN;', ...objectDefinitions.flatMap(object => [
    `INSERT INTO ${s}.object_type (api_name,name,description,schema,datasource_table,edits_enabled)
VALUES (${q(object.api)},${q(object.name)},${q(object.description)},${q(schema)},${q(object.table)},${'edits' in object && object.edits})
ON CONFLICT(api_name) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,schema=EXCLUDED.schema,datasource_table=EXCLUDED.datasource_table,edits_enabled=EXCLUDED.edits_enabled;`,
    ...object.fields.map(field => `INSERT INTO ${s}.property (object_type_id,api_name,name,data_type,required,is_primary_key,is_title,datasource_column)
SELECT id,${q(field.api)},${q(field.api)},${q(field.type)},${field.required},${field.primary},${field.title},${q(field.column)} FROM ${s}.object_type WHERE api_name=${q(object.api)}
ON CONFLICT(object_type_id,api_name) DO UPDATE SET name=EXCLUDED.name,data_type=EXCLUDED.data_type,required=EXCLUDED.required,is_primary_key=EXCLUDED.is_primary_key,is_title=EXCLUDED.is_title,datasource_column=EXCLUDED.datasource_column;`),
  ]), ...linkDefinitions.map(link => `INSERT INTO ${s}.link (api_name,name,inverse_api_name,inverse_name,source_type_id,target_type_id,via_property_id,cardinality)
SELECT ${q(link.api)},${q(link.api)},${q(link.inverse)},${q(link.inverse)},s.id,t.id,p.id,${q(link.cardinality)}
FROM ${s}.object_type s JOIN ${s}.property p ON p.object_type_id=s.id JOIN ${s}.object_type t ON t.api_name=${q(link.target)}
WHERE s.api_name=${q(link.source)} AND p.api_name=${q(link.via)}
ON CONFLICT(source_type_id,api_name) DO UPDATE SET name=EXCLUDED.name,inverse_api_name=EXCLUDED.inverse_api_name,inverse_name=EXCLUDED.inverse_name,target_type_id=EXCLUDED.target_type_id,via_property_id=EXCLUDED.via_property_id,cardinality=EXCLUDED.cardinality;`), 'COMMIT;'].join('\n')
}
