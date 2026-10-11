/** Use one active PostgreSQL schema consistently across catalog lookup, object reads and actions. */
export const ACTIVE_ONTOLOGY_SCHEMA = 'procurement' as const
export const INSTANCE_SCHEMAS: ReadonlySet<string> = new Set([ACTIVE_ONTOLOGY_SCHEMA])
