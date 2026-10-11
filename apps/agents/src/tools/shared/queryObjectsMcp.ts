/** MCP bridge: each process exposes only the tools selected for that agent role. */
import { createInterface } from 'node:readline'
import { z } from 'zod'
import { ontologyTools } from './toolRegistry.ts'
const definitions = ontologyTools.map(tool=>({name:tool.name,description:tool.description,inputSchema:z.toJSONSchema(tool.schema)}))
let allowed = new Set<string>()
try {
  const value: unknown = JSON.parse(process.env.ONTOLOGY_ALLOWED_TOOLS ?? '[]')
  if (Array.isArray(value)) allowed = new Set(value.filter((item): item is string => typeof item === 'string'))
} catch { /* Invalid configuration grants no tools. */ }
const input = createInterface({input:process.stdin,crlfDelay:Infinity})
input.on('line', async line => {
  let request: {id?:string|number; method:string; params?:Record<string,unknown>}
  try { request = JSON.parse(line) } catch { return }
  if (request.id === undefined) return
  const send = (body: unknown) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,...body as object})+'\n')
  try {
    if (request.method === 'initialize') {
      send({result:{protocolVersion:request.params?.protocolVersion ?? '2024-11-05',capabilities:{tools:{}},serverInfo:{name:'ontology-query',version:'1.0.0'}}}); return
    }
    if (request.method === 'tools/list') { send({result:{tools:definitions.filter(tool=>allowed.has(tool.name))}}); return }
    const name = request.params?.name
    if (request.method !== 'tools/call' || typeof name !== 'string' || !allowed.has(name)) throw new Error('Tool is not allowed')
    const args = request.params?.arguments
    const tool = ontologyTools.find(tool=>tool.name===name)
    if (!tool) throw new Error('Unknown tool')
    const value = await tool.execute(args)
    send({result:{content:[{type:'text',text:JSON.stringify(value)}]}})
  } catch (error) { send({error:{code:-32603,message:error instanceof Error ? error.message : 'Tool failed'}}) }
})
