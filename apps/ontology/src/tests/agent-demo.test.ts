/** Deterministic integration checks for the new seed and the real HTTP/action pipeline.
 * This checks persisted effects and rollback; separate recorded CLI runs evaluate model behavior.
 */
import '../demoClock.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
import {Hono} from 'hono'
import {db} from '../db.ts'
import {buildCatalogSql} from '../catalog.ts'
import {buildActionMetadataSql} from '../schema.ts'
import {createObjectRoutes} from '../routes/objects.ts'
import {createActionRoutes} from '../routes/actions.ts'
import {createMetaRoutes} from '../routes/meta.ts'
const schema=`procurement_agent_test_${randomUUID().replaceAll('-','').slice(0,10)}`
const root=fileURLToPath(new URL('../../../../',import.meta.url))
const scoped=db.withSchema(schema)
const app=new Hono().route('/api/objects',createMetaRoutes(db,[schema]))
 .route('/api/objects',createActionRoutes(db,new Set([schema])))
 .route('/api/objects',createObjectRoutes(db,new Set([schema])))
async function apply(text:string) {
 const dir=await mkdtemp(join(tmpdir(),'procurement-agent-test-'))
 try {const file=join(dir,'setup.sql');await writeFile(file,text,{mode:0o600})
 const result=spawnSync('pnpm',['run-sql',file],{cwd:root,encoding:'utf8'})
 if(result.status!==0)throw Error(result.stderr||result.stdout)
 } finally {await rm(dir,{recursive:true,force:true})}
}
async function call(path:string,body?:unknown,caller='buyer-kim') {
 const response=await app.request(`/api/objects${path}`,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json','x-caller-identity':caller},body:JSON.stringify(body)})
 return {status:response.status,data:await response.json() as any}
}
const flag=(id:string,caller='monitoring-agent')=>call(`/procurementRequest/${id}/actions/flag`,{severity:'medium',reason:`${id}: current work demand exceeds active allocations; source evidence reviewed.`},caller)
const decision=(id:number,action:string,caller='verification-agent')=>call(`/proposal/${id}/actions/${action}`,action==='escalate'?{note:'Historical quotation needs human confirmation.'}:{decisionNote:'Flag and current source objects independently checked.'},caller)
const active=async(id:string)=>(await scoped.selectFrom('reservation').select('quantity').where('procurement_request_id','=',id).where('status','=','active').execute()).reduce((sum,r)=>sum+r.quantity,0)
async function propose(id:string,type:string,params:unknown,flagId:string) {
 const r=await call('/proposal',{type:`procurementRequest.${type}`,targetId:id,params,rationale:`${flagId}: verified source IDs and exact current uncovered demand.`,status:'pending',proposedBy:'planning-agent',proposedAt:new Date().toISOString()},'planning-agent')
 assert.equal(r.status,201,JSON.stringify(r.data));return r.data.id as number
}
test('FlagLog and independent agent demo scenarios',async t=> {
 try {
 const foundation=await readFile(new URL('../db/foundation.sql',import.meta.url),'utf8')
 const seed=await readFile(join(root,'seeds/01-procurement-agent-demo.sql'),'utf8')
 await apply(foundation.replace(/\bprocurement\b/g,schema)+'\n'+buildCatalogSql(schema)+'\n'+buildActionMetadataSql(schema)+'\n'+seed.replaceAll('procurement.',`${schema}.`))
 const flags=new Map<string,string>();const proposals=new Map<string,number>()
 await t.test('seed has four planned requests and no prewritten flags, proposals or audits',async()=> {
  assert.equal((await scoped.selectFrom('maintenance_work_order').selectAll().where('status','=','planned').execute()).length,4)
  for(const table of ['flag_log','proposal','audit_log'] as const)assert.equal((await scoped.selectFrom(table).selectAll().execute()).length,0)
  assert.equal(await active('MPR-CONTROL'),10)
  assert.equal(await active('MPR-RFQ'),5)
 })
 await t.test('flag writes are role-restricted, audited, linked both ways and deduplicated concurrently',async()=> {
  assert.equal((await flag('MPR-ALT','planning-agent')).status,403)
  const results=await Promise.all([flag('MPR-ALT'),flag('MPR-ALT')])
  assert.ok(results.every(r=>r.status===200));assert.equal(results[0]!.data.id,results[1]!.data.id)
  flags.set('MPR-ALT',results[0]!.data.id)
  for(const id of ['MPR-017','MPR-RFQ']) {const r=await flag(id);assert.equal(r.status,200);flags.set(id,r.data.id)}
  assert.equal((await scoped.selectFrom('flag_log').selectAll().execute()).length,3)
  const audits=await scoped.selectFrom('audit_log').selectAll().execute();assert.equal(audits.length,3)
  assert.ok(audits.every(a=>a.actor==='monitoring-agent'&&a.action_api_name==='flag'))
  const id=flags.get('MPR-017')!
  assert.equal((await call(`/flagLog/${id}`)).data.links.procurementRequest.data.id,'MPR-017')
  assert.equal((await call('/procurementRequest/MPR-017')).data.links.flags.data[0].id,id)
  assert.equal((await call('/procurementRequest/MPR-CONTROL')).data.links.flags.data.length,0)
  assert.equal(await active('MPR-ALT'),2);assert.equal(await active('MPR-017'),0)
 })
 await t.test('three separate action proposals leave business facts untouched',async()=> {
  proposals.set('MPR-ALT',await propose('MPR-ALT','allocateStock',{requiredMaterialId:'FILTER-A',stockId:'ST-ALT',quantity:10},flags.get('MPR-ALT')!))
  proposals.set('MPR-017',await propose('MPR-017','reallocateReservation',{sourceReservationId:'RES-009',requiredMaterialId:'FILTER-01',quantity:10},flags.get('MPR-017')!))
  proposals.set('MPR-RFQ',await propose('MPR-RFQ','requestRfq',{requiredMaterialId:'BEARING-01',supplierCode:'SUP-B',quantity:5,requiredAt:'2026-10-15T09:00:00Z',quotationId:'Q-BEAR-B'},flags.get('MPR-RFQ')!))
  assert.equal((await scoped.selectFrom('proposal').selectAll().where('status','=','pending').execute()).length,3)
  assert.equal(await active('MPR-017'),0);assert.equal(await active('MPR-009'),7)
 })
 await t.test('a metadata change makes stored params stale and approval rolls back',async()=> {
  const action=await scoped.selectFrom('action_type').selectAll().where('api_name','=','allocateStock').executeTakeFirstOrThrow()
  const changed={...(action.parameter_schema as Record<string,any>),required:['requiredMaterialId','stockId','quantity','newRequiredEvidence']}
  await scoped.updateTable('action_type').set({parameter_schema:changed}).where('id','=',action.id).execute()
  try {
   const r=await decision(proposals.get('MPR-ALT')!,'approve');assert.equal(r.status,400);assert.match(r.data.error,/Stored parameters/)
   assert.equal(await active('MPR-ALT'),2)
   assert.equal((await scoped.selectFrom('proposal').selectAll().where('id','=',proposals.get('MPR-ALT')!).executeTakeFirstOrThrow()).status,'pending')
  } finally {await scoped.updateTable('action_type').set({parameter_schema:action.parameter_schema}).where('id','=',action.id).execute()}
 })
 await t.test('concurrent human and agent approvals execute one allocation and one audit pair',async()=> {
  const id=proposals.get('MPR-ALT')!
  const results=await Promise.all([decision(id,'approve'),decision(id,'approve','buyer-kim')])
  assert.deepEqual(results.map(r=>r.status).sort(),[200,400]);assert.equal(await active('MPR-ALT'),12)
  assert.equal((await scoped.selectFrom('audit_log').selectAll().where('action_api_name','=','allocateStock').execute()).length,1)
  assert.equal((await scoped.selectFrom('audit_log').selectAll().where('action_api_name','=','approve').execute()).length,1)
 })
 await t.test('verification approves reallocation but escalates RFQ without executing it',async()=> {
  const r=await decision(proposals.get('MPR-017')!,'approve');assert.equal(r.status,200,JSON.stringify(r.data))
  assert.equal(r.data.freeBefore,5);assert.equal(r.data.freeAfter,2);assert.equal(await active('MPR-009'),0);assert.equal(await active('MPR-017'),10)
  const rfq=proposals.get('MPR-RFQ')!;assert.equal((await decision(rfq,'approve')).status,400)
  assert.equal((await decision(rfq,'escalate')).status,200)
  assert.equal((await scoped.selectFrom('rfq_request').selectAll().execute()).length,0)
  assert.equal(await active('MPR-LIVE'),7);assert.equal(await active('MPR-RFQ'),5)
  assert.equal((await decision(rfq,'approve')).status,400)
 })
 await t.test('human confirms the RFQ draft; quotes, active source reservation and shortage are unchanged',async()=> {
  const r=await decision(proposals.get('MPR-RFQ')!,'approve','buyer-kim')
  assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.externalDispatch,false);assert.equal(r.data.quantity,5)
  assert.equal((await scoped.selectFrom('rfq_request').selectAll().execute()).length,1)
  assert.equal(await active('MPR-RFQ'),5);assert.equal(await active('MPR-LIVE'),7)
  assert.equal((await scoped.selectFrom('flag_log').selectAll().where('status','=','open').execute()).length,3)
 })
 await t.test('approval versus rejection allows only one decision and no contradictory effects',async()=> {
  await scoped.updateTable('reservation').set({quantity:9}).where('id','=','RES-CONTROL').execute()
  const id=await propose('MPR-CONTROL','allocateStock',{requiredMaterialId:'GASKET-01',stockId:'ST-CONTROL',quantity:1},'test-only review race')
  const results=await Promise.all([decision(id,'approve'),decision(id,'reject','buyer-kim')])
  assert.deepEqual(results.map(r=>r.status).sort(),[200,400])
  const row=await scoped.selectFrom('proposal').selectAll().where('id','=',id).executeTakeFirstOrThrow()
  assert.equal(await active('MPR-CONTROL'),row.status==='approved'?10:9)
 })
 } finally {try {await apply(`DROP SCHEMA IF EXISTS ${schema} CASCADE;`)} finally {await db.destroy()}}
})
