/** These are tool-contract tests, not a claim that an LLM chose the correct business plan. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { procurementFlag, proposeAllocateStock, proposeReallocateReservation, proposeRequestRfq, proposalApprove } from './tools.ts'
import { definition as analytics } from '../../agents/procurement/analytics.ts'
import { definition as monitoring } from '../../agents/procurement/monitoring.ts'
import { definition as planning } from '../../agents/procurement/planning.ts'
import { definition as verification } from '../../agents/procurement/verification.ts'

test('roles receive distinct read, observe, propose and review capabilities', () => {
  const names = (role: typeof analytics) => role.tools.map(t => t.name).sort()
  assert.deepEqual(names(analytics), ['get_object','query_objects'])
  assert.deepEqual(names(monitoring), ['get_object','procurement_flag','query_objects'])
  assert.deepEqual(names(planning), ['get_object','propose_allocate_stock','propose_reallocate_reservation','propose_request_rfq','query_objects'])
  assert.deepEqual(names(verification), ['get_object','proposal_approve','proposal_escalate','proposal_reject','query_objects'])
})

test('MCP refuses a write not allowed for a read-only role before reaching HTTP', () => {
  const result = spawnSync(process.execPath, ['apps/agents/src/tools/shared/queryObjectsMcp.ts'], {
    encoding:'utf8', env:{...process.env,ONTOLOGY_ALLOWED_TOOLS:'["get_object","query_objects"]'},
    input: [
      {jsonrpc:'2.0',id:1,method:'tools/list'},
      {jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'proposal_approve',arguments:{proposalId:1,decisionNote:'unsupported'}}},
    ].map(v=>JSON.stringify(v)).join('\n')+'\n',
  })
  assert.equal(result.status,0,result.stderr)
  const responses = result.stdout.trim().split('\n').map(line=>JSON.parse(line))
  assert.deepEqual(responses.find(r=>r.id===1).result.tools.map((t:any)=>t.name).sort(),['get_object','query_objects'])
  assert.match(responses.find(r=>r.id===2).error.message,/not allowed/)
})

test('fixed proposal tools keep routing outside params and attach the runtime identity', async () => {
  const previousFetch=globalThis.fetch, previousEnv={...process.env}
  const sent: {url:string; headers:Headers; body:any}[]=[]
  try {
    process.env.ONTOLOGY_URL='http://ontology.test';process.env.CALLER_IDENTITY='planning-agent'
    globalThis.fetch=async (input,init)=> {
      sent.push({url:String(input),headers:new Headers(init?.headers),body:JSON.parse(String(init?.body))})
      return Response.json({id:sent.length},{status:201})
    }
    await proposeAllocateStock.execute({requestId:'MPR-ALT',requiredMaterialId:'FILTER-A',stockId:'ST-ALT',quantity:10,rationale:'FL-1: 10 required, 0 covered; 12 free.'})
    await proposeReallocateReservation.execute({requestId:'MPR-017',sourceReservationId:'RES-009',requiredMaterialId:'FILTER-01',quantity:10,rationale:'FL-2: confirmed cancellation; 5 + 7 - 10 = 2 free.'})
    await proposeRequestRfq.execute({requestId:'MPR-RFQ',requiredMaterialId:'BEARING-01',supplierCode:'SUP-B',quantity:5,requiredAt:'2026-10-15T09:00:00Z',quotationId:'Q-BEAR-B',rationale:'FL-3: 10 - 5 = 5 uncovered; historical reference only.'})
    assert.deepEqual(sent.map(s=>s.body.type),['procurementRequest.allocateStock','procurementRequest.reallocateReservation','procurementRequest.requestRfq'])
    for(const item of sent) {
      assert.equal(item.url,'http://ontology.test/api/objects/proposal')
      assert.equal(item.headers.get('x-caller-identity'),'planning-agent')
      assert.equal(item.body.proposedBy,'planning-agent');assert.equal(item.body.status,'pending')
      assert.equal(item.body.params.requestId,undefined);assert.equal(item.body.params.rationale,undefined)
    }
  } finally { globalThis.fetch=previousFetch;process.env=previousEnv }
})

test('invalid tool inputs fail before HTTP and API errors remain visible', async () => {
  const previousFetch=globalThis.fetch,previousEnv={...process.env};let calls=0
  try {
    process.env.ONTOLOGY_URL='http://ontology.test';process.env.CALLER_IDENTITY='verification-agent'
    globalThis.fetch=async()=> {calls++;return Response.json({error:'Stored parameters are invalid'},{status:400})}
    assert.throws(()=>proposeAllocateStock.execute({requestId:'MPR-ALT',requiredMaterialId:'FILTER-A',stockId:'ST-ALT',quantity:0,rationale:'invalid'}))
    assert.throws(()=>procurementFlag.execute({requestId:'MPR-ALT',reason:' ',severity:'medium'}))
    assert.equal(calls,0)
    await assert.rejects(proposalApprove.execute({proposalId:1,decisionNote:'FL-1 evidence reviewed'}),/HTTP 400: Stored parameters are invalid/)
    assert.equal(calls,1)
  } finally { globalThis.fetch=previousFetch;process.env=previousEnv }
})
