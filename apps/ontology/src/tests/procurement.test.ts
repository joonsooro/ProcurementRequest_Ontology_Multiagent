/** Integration tests exercise the actual catalog, HTTP validation, shared approvals, and SQL transactions.
 * They create/drop only a unique procurement_test_* schema via run-sql; the visible demo stays untouched.
 */
import '../demoClock.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { Hono } from 'hono'
import { sql } from 'kysely'
import { db } from '../db.ts'
import { buildCatalogSql } from '../catalog.ts'
import { buildActionMetadataSql } from '../schema.ts'
import { createObjectRoutes } from '../routes/objects.ts'
import { createActionRoutes } from '../routes/actions.ts'
import { createMetaRoutes } from '../routes/meta.ts'
const schema = `procurement_test_${randomUUID().replaceAll('-','').slice(0,10)}`
const root = fileURLToPath(new URL('../../../../',import.meta.url))
const scoped = db.withSchema(schema)
const app = new Hono().route('/api/objects',createMetaRoutes(db,[schema]))
  .route('/api/objects',createActionRoutes(db,new Set([schema])))
  .route('/api/objects',createObjectRoutes(db,new Set([schema])))
async function apply(text:string) {
  const directory=await mkdtemp(join(tmpdir(),'procurement-test-'))
  try {
    const path=join(directory,'schema.sql');await writeFile(path,text,{mode:0o600})
    const result=spawnSync('pnpm',['run-sql',path],{cwd:root,encoding:'utf8'})
    if(result.status!==0)throw new Error(result.stderr || result.stdout)
  } finally {await rm(directory,{recursive:true,force:true})}
}
async function call(path:string, body?:unknown, caller='buyer-kim') {
  const response=await app.request(`/api/objects${path}`,body===undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json','x-caller-identity':caller},body:JSON.stringify(body)})
  return {status:response.status,data:await response.json() as any}
}
const get = (type:string,id:string)=>call(`/${type}/${id}`)
const approve = (id:number,caller='buyer-kim')=>call(`/proposal/${id}/actions/approve`,{decisionNote:'Approved after checking source evidence'},caller)
const proposalFor = (target:string)=>scoped.selectFrom('proposal').selectAll().where('target_id','=',target).where('proposed_by','=','demo-fixture').executeTakeFirstOrThrow()
async function activeQty(request:string) {
  return (await scoped.selectFrom('reservation').select('quantity').where('procurement_request_id','=',request).where('status','=','active').execute()).reduce((n,r)=>n+r.quantity,0)
}

test('Procurement ontology — isolated PostgreSQL integration',async t=> {
  try {
    const foundation=await readFile(new URL('../db/foundation.sql',import.meta.url),'utf8')
    const demo=await readFile(new URL('../db/demo.sql',import.meta.url),'utf8')
    await apply(foundation.replace(/\bprocurement\b/g,schema)+'\n'+buildCatalogSql(schema)+'\n'+buildActionMetadataSql(schema)+'\n'+demo.replaceAll('procurement.',`${schema}.`))
    await t.test('six domain types plus shared Proposal and FlagLog: every column maps once, PK/title metadata and seven bidirectional scalar links',async()=> {
      const result=await call('/meta/types');assert.equal(result.status,200);assert.equal(result.data.length,8)
      const links=await scoped.selectFrom('link').selectAll().execute();assert.equal(links.length,7)
      for(const type of result.data) {
        const properties=await scoped.selectFrom('property').selectAll().where('object_type_id','=',type.id).execute()
        assert.equal(properties.filter(p=>p.is_primary_key).length,1);assert.equal(properties.filter(p=>p.is_title).length,1)
        const columns=await sql<{column_name:string}>`select column_name from information_schema.columns where table_schema=${schema} and table_name=${type.datasource_table}`.execute(db)
        assert.deepEqual(properties.map(p=>p.datasource_column).sort(),columns.rows.map(r=>r.column_name).sort())
      }
      const request=(await get('procurementRequest','MPR-017')).data
      assert.equal(request.links.workOrder.data.id,'WO-017');assert.equal(request.links.workOrder.data.links,undefined)
      assert.equal((await get('maintenanceWorkOrder','WO-017')).data.links.procurementRequest.data.id,'MPR-017')
      const reservation=(await get('reservation','RES-009')).data
      assert.equal(reservation.links.procurementRequest.data.id,'MPR-009');assert.equal(reservation.links.stock.data.id,'ST-017');assert.equal(reservation.links.requiredMaterial.data.id,'FILTER-01')
      assert.equal((await get('stock','ST-017')).data.links.reservations.data[0].id,'RES-009')
      const material=(await get('material','FILTER-01')).data
      assert.equal(material.links.stocks.data[0].id,'ST-017');assert.equal(material.links.quotations.data[0].id,'Q-FILTER-A');assert.equal(material.links.reservationsForRequirement.data[0].id,'RES-009')
      assert.equal((await get('quotation','Q-FILTER-A')).data.links.material.data.id,'FILTER-01')
      assert.equal((await get('procurementRequest','MPR-009')).data.links.reservations.data[0].id,'RES-009')
      const query=await call('/quotation/query',{filters:[{property:'materialId',op:'eq',value:'BEARING-01'}]});assert.equal(query.data.length,2)
      assert.equal((await get('maintenanceWorkOrder','WO-ALT')).data.required_materials.length,2)
    })
    await t.test('denied and invalid action attempts leave access evidence but no business audit',async()=> {
      const p=await proposalFor('MPR-017')
      assert.equal((await approve(p.id,'planning-agent')).status,403)
      assert.equal((await call(`/proposal/${p.id}/actions/approve`,{unexpected:true})).status,400)
      const access=await scoped.selectFrom('access_log').selectAll().execute()
      assert.deepEqual(access.map(r=>r.decision),['denied','allowed'])
      assert.equal((await scoped.selectFrom('audit_log').selectAll().execute()).length,0)
      assert.equal((await call('/procurementRequest/MPR-017/actions/allocateStock',{requiredMaterialId:'FILTER-01',stockId:'ST-017',quantity:1})).status,400)
    })
    await t.test('pending checks and metadata validation reject duplicate and compound proposals',async()=> {
      const base={type:'procurementRequest.reallocateReservation',targetId:'MPR-017',params:{sourceReservationId:'RES-009',requiredMaterialId:'FILTER-01',quantity:10},rationale:'test',status:'pending',proposedBy:'manual-test',proposedAt:new Date().toISOString()}
      assert.equal((await call('/proposal',base)).status,409)
      assert.equal((await call('/proposal',{...base,type:'procurementRequest.applySupplyPlan'})).status,409)
      assert.equal((await call('/proposal',{...base,status:'approved'})).status,409)
    })
    await t.test('approval rereads cancellation: a changed work order keeps the proposal pending and stock untouched',async()=> {
      await scoped.updateTable('maintenance_work_order').set({status:'planned'}).where('id','=','WO-009').execute()
      const p=await proposalFor('MPR-017');const result=await approve(p.id)
      assert.equal(result.status,400);assert.match(result.data.error,/cancellation/)
      assert.equal(await activeQty('MPR-009'),7);assert.equal(await activeQty('MPR-017'),0)
      assert.equal((await proposalFor('MPR-017')).status,'pending')
      await scoped.updateTable('maintenance_work_order').set({status:'cancelled'}).where('id','=','WO-009').execute()
    })
    await t.test('audit write failure rolls back reservation release, new allocation and proposal decision together',async()=> {
      await apply(`ALTER TABLE ${schema}.audit_log ADD CONSTRAINT test_audit_failure CHECK (action_api_name <> 'reallocateReservation');`)
      const p=await proposalFor('MPR-017');assert.equal((await approve(p.id)).status,400)
      assert.equal(await activeQty('MPR-009'),7);assert.equal(await activeQty('MPR-017'),0);assert.equal((await proposalFor('MPR-017')).status,'pending')
      assert.equal((await scoped.selectFrom('audit_log').selectAll().execute()).length,0)
      await apply(`ALTER TABLE ${schema}.audit_log DROP CONSTRAINT test_audit_failure;`)
    })
    await t.test('reallocate releases seven plus uses five free: ten allocated, two free, physical stock unchanged; repeated approval rejected',async()=> {
      const p=await proposalFor('MPR-017');const result=await approve(p.id)
      assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.freeBefore,5);assert.equal(result.data.freeAfter,2)
      assert.equal(result.data.onHandUnchanged,12);assert.equal(await activeQty('MPR-017'),10);assert.equal(await activeQty('MPR-009'),0)
      assert.equal((await get('reservation','RES-009')).data.status,'released')
      assert.equal((await approve(p.id)).status,400)
      const audit=await scoped.selectFrom('audit_log').selectAll().execute()
      assert.equal(audit.length,2);assert.ok(audit.every(row=>row.actor==='buyer-kim'))
      const inner=audit.find(row=>row.action_api_name==='reallocateReservation')!;assert.equal((inner.params as any).authorizedByProposal,p.id)
    })
    await t.test('approved alternative supplies the required material without duplicating or rewriting demand',async()=> {
      const p=await proposalFor('MPR-ALT');const result=await approve(p.id,'verification-agent')
      assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.actualMaterialId,'FILTER-B');assert.equal(result.data.requiredMaterialId,'FILTER-A')
      assert.equal(await activeQty('MPR-ALT'),12)
      const work=(await get('maintenanceWorkOrder','WO-ALT')).data;assert.deepEqual(work.required_materials[0],{materialId:'FILTER-A',requiredQuantity:10})
    })
    await t.test('RFQ cannot be approved by verification-agent; human records draft only for remaining five',async()=> {
      const p=await proposalFor('MPR-RFQ');assert.equal((await approve(p.id,'verification-agent')).status,400)
      assert.equal((await proposalFor('MPR-RFQ')).status,'escalated')
      const result=await approve(p.id);assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.externalDispatch,false);assert.equal(result.data.quantity,5)
      assert.equal(await activeQty('MPR-RFQ'),5);assert.equal(await activeQty('MPR-LIVE'),7)
      assert.equal((await scoped.selectFrom('rfq_request').selectAll().execute()).length,1)
      assert.equal((await scoped.selectFrom('quotation').selectAll().execute()).length,3)
    })
    await t.test('normal comparison already covered: no proposal or new purchase needed',async()=> {
      assert.equal(await activeQty('MPR-CONTROL'),10);assert.equal(await activeQty('MPR-CANCEL-CONTROL'),0)
      assert.equal((await scoped.selectFrom('proposal').selectAll().where('target_id','=','MPR-CONTROL').execute()).length,0)
    })
    await t.test('manual proposal creation and rejection use catalog mappings without executing a domain mutation',async()=> {
      const created=await call('/proposal',{type:'procurementRequest.allocateStock',targetId:'MPR-CONTROL',params:{requiredMaterialId:'GASKET-01',stockId:'ST-CONTROL',quantity:1},rationale:'Review-only proposal',status:'pending',proposedBy:'manual-test',proposedAt:new Date().toISOString()})
      assert.equal(created.status,201,JSON.stringify(created.data))
      assert.equal((await approve(created.data.id)).status,400) // Already covered demand is rechecked at execution.
      const rejected=await call(`/proposal/${created.data.id}/actions/reject`,{decisionNote:'Already covered; no additional allocation needed'})
      assert.equal(rejected.status,200);assert.equal(await activeQty('MPR-CONTROL'),10)
    })
    await t.test('rerunning bootstrap preserves approved operational state',async()=> {
      await apply(foundation.replace(/\bprocurement\b/g,schema)+'\n'+buildCatalogSql(schema)+'\n'+buildActionMetadataSql(schema)+'\n'+demo.replaceAll('procurement.',`${schema}.`))
      assert.equal((await proposalFor('MPR-017')).status,'approved');assert.equal(await activeQty('MPR-017'),10)
    })
  } finally {
    // Only this randomly named test schema is removed, including if assertions fail.
    try {await apply(`DROP SCHEMA IF EXISTS ${schema} CASCADE;`)} finally {await db.destroy()}
  }
})
