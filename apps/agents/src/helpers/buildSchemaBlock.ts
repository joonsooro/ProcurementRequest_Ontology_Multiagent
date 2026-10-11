/**
 * Convert live ontology metadata into readable agent prompt context.
 * This gives the model the current API names, property types, relationships, and action names.
 */
// These are the fields needed for prompt rendering, rather than the full database-row types.
type ObjectType = {
  id: string
  api_name: string
  name: string
  description: string | null
}

type Property = {
  api_name: string
  name: string
  datasource_column: string
  data_type: string
  required: boolean
  is_title: boolean
  is_primary_key: boolean
}

type Link = {
  api_name: string
  name: string
  inverse_api_name: string
  inverse_name: string
  source_type_id: string
  target_type_id: string
  cardinality: string
}

type Action = {
  api_name: string
  name: string
  description: string | null
}

type TypeDetail = {
  properties: Property[]
  links: { outbound: Link[]; inbound: Link[] }
  actions: Action[]
}

function ontologyBaseUrl(): string {
  return (process.env.ONTOLOGY_URL ?? process.env.HONO_URL ?? 'http://localhost:3000').replace(/\/$/, '')
}

/** Preserve exact API names and useful qualifiers in the readable schema description. */
function formatProperty(property: Property): string {
  const qualifiers = [
    property.required ? 'required' : null,
    property.is_title ? 'title' : null,
    property.is_primary_key ? 'primary key' : null,
  ].filter(Boolean)
  const suffix = qualifiers.length ? ` — ${qualifiers.join(', ')}` : ''
  return `- ${property.name} (\`${property.api_name}\`): ${property.data_type}${suffix}; response field: \`${property.datasource_column}\``
}

/** Resolve relationship UUID references into labels the model can use in queries. */
function typeLabel(type: ObjectType | undefined): string {
  return type ? `${type.name} (\`${type.api_name}\`)` : 'unknown object type'
}

/**
 * Loads ontology metadata and turns it into concise, human-readable context for
 * an agent system prompt. Metadata is rendered as text rather than exposed as
 * raw JSON so the available types and relationships are easy to reason about.
 */
export async function buildSchemaBlock(): Promise<string> {
  const baseUrl = ontologyBaseUrl()
  const listResponse = await fetch(`${baseUrl}/api/objects/meta/types`)
  if (!listResponse.ok) {
    throw new Error(`Could not load ontology schema: HTTP ${listResponse.status}`)
  }

  const types = await listResponse.json() as ObjectType[]
  const typesById = new Map(types.map((type) => [type.id, type]))
  // Type details are independent HTTP reads, so load them in parallel after listing the catalog.
  const details = await Promise.all(types.map(async (type) => {
    const response = await fetch(`${baseUrl}/api/objects/meta/types/${encodeURIComponent(type.api_name)}`)
    if (!response.ok) {
      throw new Error(`Could not load metadata for ${type.api_name}: HTTP ${response.status}`)
    }
    return { type, detail: await response.json() as TypeDetail }
  }))

  const descriptions = details.map(({ type, detail }) => {
    const lines = [`## ${type.name} (\`${type.api_name}\`)`]
    if (type.description) lines.push(type.description)

    lines.push('Properties:')
    lines.push(...(detail.properties.length
      ? detail.properties.map(formatProperty)
      : ['- None']))

    // Present forward and inverse relationship names with the correct direction and related type.
    const links = [
      ...detail.links.outbound.map((link) => `- ${link.name} (\`${link.api_name}\`) → ${typeLabel(typesById.get(link.target_type_id))}; ${link.cardinality}`),
      ...detail.links.inbound.map((link) => `- ${link.inverse_name} (\`${link.inverse_api_name}\`) ← ${typeLabel(typesById.get(link.source_type_id))}; ${link.cardinality}`),
    ]
    lines.push('Links:')
    lines.push(...(links.length ? links : ['- None']))

    // Listing action metadata supplies context; the runtime tool allowlist separately determines executable tools.
    lines.push('Available actions:')
    lines.push(...(detail.actions.length
      ? detail.actions.map((action) => `- ${action.name} (\`${action.api_name}\`)${action.description ? `: ${action.description}` : ''}`)
      : ['- None']))

    return lines.join('\n')
  })

  return ['Ontology schema:', 'Filters use public api_name; responses use datasource_column. get_object resolves one hop, query_objects returns rows only. WorkOrder.required_materials is an array of {materialId, requiredQuantity}; use each materialId to get Material. approved_alternative_material_ids is an ID array, not a catalog link. Use only the tools explicitly provided, regardless of action names listed here.', ...descriptions].join('\n\n')
}
