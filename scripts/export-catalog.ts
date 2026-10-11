/** Export an inspectable documentation snapshot from the same definitions used to populate metadata. */
import { writeFile } from 'node:fs/promises'
import { objectDefinitions, linkDefinitions } from '../apps/ontology/src/catalog.ts'
import { actionDefinitions } from '../apps/ontology/src/schema.ts'
await writeFile(new URL('../PMM/catalog-reference.json',import.meta.url),JSON.stringify({objects:objectDefinitions,links:linkDefinitions,actions:actionDefinitions},null,2)+'\n')
console.log('Wrote PMM/catalog-reference.json from catalog.ts and schema.ts')
