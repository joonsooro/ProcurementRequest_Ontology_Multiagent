/** Real-model evaluation, deliberately separate from deterministic tests.
 * Creates a temporary ontology schema/server, runs the public CLI entry points, verifies DB effects,
 * and removes the schema. Logs remain in PMM/runs; the visible demo is never consumed.
 */
import '../demoClock.ts'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile,writeFile,mkdtemp,rm,mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn,spawnSync } from 'node:child_process'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { db } from '../db.ts'
import { buildCatalogSql } from '../catalog.ts'
import { buildActionMetadataSql } from '../schema.ts'
import { createMetaRoutes } from '../routes/meta.ts'
import { createObjectRoutes } from '../routes/objects.ts'
import { createActionRoutes } from '../routes/actions.ts'
const schema=`procurement_eval_${randomUUID().replaceAll('-','').slice(0,10)}`
const root=fileURLToPath(new URL('../../../../',import.meta.url))
const scoped=db.withSchema(schema)
async function apply(sql:string) {
 const dir=await mkdtemp(join(tmpdir(),'procurement-eval-'))
 try {const path=join(dir,'schema.sql');await writeFile(path,sql,{mode:0o600})
 const result=spawnSync('pnpm',['run-sql',path],{cwd:root,encoding:'utf8'})
 if(result.status!==0)throw Error(result.stderr||result.stdout)
 } finally {await rm(dir,{recursive:true,force:true})}
}
const app=new Hono().route('/api/objects',createMetaRoutes(db,[schema]))
 .route('/api/objects',createActionRoutes(db,new Set([schema])))
 .route('/api/objects',createObjectRoutes(db,new Set([schema])))
const server=serve({fetch:app.fetch,port:0,hostname:'127.0.0.1'})
await new Promise<void>(resolve=>server.listening?resolve():server.once('listening',resolve))
const address=server.address();if(!address||typeof address==='string')throw Error('Missing evaluation port')
const url=`http://127.0.0.1:${address.port}`
const summary:Record<string,unknown>={evaluatedAt:new Date().toISOString(),schema,kind:'real Codex SDK CLI evaluation',model:'gpt-6-luna'}
async function run(role:string,prompt?:string) {
 console.log(`Running real ${role} CLI against isolated schema ${schema}`)
 await new Promise<void>((resolve,reject)=> {
  const child=spawn(process.execPath,['--env-file=.env',`apps/agents/src/agents/procurement/${role}.ts`,...(prompt?[prompt]:[])],{
   cwd:root,stdio:'inherit',env:{...process.env,ONTOLOGY_URL:url,HONO_URL:url,AGENT_VIEWER_PORT:'3467'},
  })
  child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(`${role} CLI exited ${code}`)))
 })
}
async function snapshot() {
 return {flags:await scoped.selectFrom('flag_log').selectAll().execute(),proposals:await scoped.selectFrom('proposal').selectAll().execute(),
 reservations:await scoped.selectFrom('reservation').selectAll().execute(),rfqs:await scoped.selectFrom('rfq_request').selectAll().execute(),
 audits:await scoped.selectFrom('audit_log').selectAll().execute(),access:await scoped.selectFrom('access_log').selectAll().execute()}
}
try {
 const foundation=await readFile(new URL('../db/foundation.sql',import.meta.url),'utf8')
 const seed=await readFile(join(root,'seeds/01-procurement-agent-demo.sql'),'utf8')
 await apply(foundation.replace(/\bprocurement\b/g,schema)+'\n'+buildCatalogSql(schema)+'\n'+buildActionMetadataSql(schema)+'\n'+seed.replaceAll('procurement.',`${schema}.`))
 await run('analytics','Explain all planned requests, their material shortfalls and unknown current supplier terms. Cite object IDs. Do not change anything.')
 const analytic=await snapshot();assert.equal(analytic.flags.length,0);assert.equal(analytic.proposals.length,0);assert.equal(analytic.audits.length,0)
 summary.analytics={mutations:0}
 await run('monitoring')
 const monitor=await snapshot();summary.monitoring=monitor
 assert.deepEqual(monitor.flags.map(f=>f.procurement_request_id).sort(),['MPR-017','MPR-ALT','MPR-RFQ'])
 assert.equal(monitor.proposals.length,0)
 await run('planning')
 const plan=await snapshot();summary.planning=plan
 assert.equal(plan.proposals.length,3)
 assert.deepEqual(plan.proposals.map(p=>`${p.target_id}:${p.type}`).sort(),[
 'MPR-017:procurementRequest.reallocateReservation','MPR-ALT:procurementRequest.allocateStock','MPR-RFQ:procurementRequest.requestRfq'])
 assert.ok(plan.proposals.every(p=>p.status==='pending'&&p.proposed_by==='planning-agent'))
 await run('verification')
 const verified=await snapshot();summary.verification=verified
 assert.equal(verified.proposals.filter(p=>p.status==='approved').length,2)
 const rfq=verified.proposals.find(p=>p.type==='procurementRequest.requestRfq')!;assert.equal(rfq.status,'escalated')
 assert.equal(verified.rfqs.length,0)
 const qty=(id:string)=>verified.reservations.filter(r=>r.procurement_request_id===id&&r.status==='active').reduce((sum,r)=>sum+r.quantity,0)
 assert.equal(qty('MPR-ALT'),12);assert.equal(qty('MPR-017'),10);assert.equal(qty('MPR-009'),0);assert.equal(qty('MPR-RFQ'),5);assert.equal(qty('MPR-LIVE'),7)
 // Simulate the same explicit human review call made by the UI. This stays inside the disposable evaluation.
 const response=await app.request(`/api/objects/proposal/${rfq.id}/actions/approve`,{method:'POST',headers:{'content-type':'application/json','x-caller-identity':'buyer-kim'},body:JSON.stringify({decisionNote:'Evaluation buyer: request fresh terms for five bearings; historical quotation is only a reference.'})})
 assert.equal(response.status,200,await response.clone().text());summary.human=await response.json()
 summary.passed=true;console.log('Real-model evaluation passed: read-only analytics, 3 flags + healthy control, 3 proposals, 2 approvals + 1 escalation, human RFQ draft.')
} catch(error) {summary.passed=false;summary.error=error instanceof Error?error.message:String(error);throw error}
finally {
 await mkdir(join(root,'PMM/runs'),{recursive:true})
 await writeFile(join(root,`PMM/runs/evaluation-${schema}.json`),JSON.stringify(summary,null,2)+'\n',{mode:0o600})
 await writeFile(join(root,'PMM/runs/latest-evaluation.json'),JSON.stringify(summary,null,2)+'\n',{mode:0o600})
 await new Promise<void>(resolve=>server.close(()=>resolve()))
 try {await apply(`DROP SCHEMA IF EXISTS ${schema} CASCADE;`)} finally {await db.destroy()}
}
