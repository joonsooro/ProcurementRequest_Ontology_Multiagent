/** One registry supplies both the runtime allowlist and MCP dispatch, preventing name drift. */
import { executeGetObject, getObjectInput } from './getObject.ts'
import { executeQueryObjects, queryObjectsInput } from './queryObjects.ts'
import { procurementTools, type OntologyTool } from '../procurement/tools.ts'
export const ontologyTools: OntologyTool[] = [
  {name:'get_object',description:'Read an object and its one-hop catalog links. Linked rows do not recursively include their own links.',schema:getObjectInput,execute:args=>executeGetObject(getObjectInput.parse(args))},
  {name:'query_objects',description:'Filter object rows using public camelCase property names. Result rows use catalog storage column names; list results do not include links.',schema:queryObjectsInput,execute:args=>executeQueryObjects(queryObjectsInput.parse(args))},
  ...procurementTools,
]
