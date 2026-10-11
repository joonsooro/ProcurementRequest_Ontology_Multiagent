/** Domain dashboard on top of the unchanged one-hop object API.
 * Work-order JSON supplies material IDs; subsequent reads follow registered scalar links.
 * Coverage is calculated for display, never written as a duplicated request status.
 */
import { useEffect, useState } from 'react';
import { Button, Callout, Card, HTMLTable, InputGroup, Spinner, Tag } from '@blueprintjs/core';
import { fetchAudit, fetchInstances, fetchObject } from './api.ts';
import type { AuditEntry } from './api.ts';
import './ProcurementInvestigation.css';
type Row = Record<string,any>;
type RequestView = {request:Row;work:Row;reservations:Row[]};
function linked(row:Row, name:string): Row[] {
  const data = row.links?.[name]?.data;
  return data ? Array.isArray(data) ? data : [data] : [];
}
async function requestView(id:string): Promise<RequestView> {
  const request = await fetchObject('procurementRequest',id) as Row;
  const work = linked(request,'workOrder')[0];
  if (!work) throw new Error(`${id}: No linked maintenance work order.`);
  return {request,work,reservations:linked(request,'reservations')};
}
/** A per-load cache avoids repeated reads without pretending the server recursively returns the whole graph. */
async function contextFor(view:RequestView) {
  const cache = new Map<string,Promise<Row>>();
  const get = (type:string,id:string) => {
    const key=`${type}/${id}`;
    if (!cache.has(key)) cache.set(key,fetchObject(type,id));
    return cache.get(key)!;
  };
  const materials = await Promise.all(view.work.required_materials.map(async (item:Row) => {
    const material = await get('material',item.materialId);
    const alternatives = await Promise.all(material.approved_alternative_material_ids.map((id:string)=>get('material',id)));
    const stocks = await Promise.all([material,...alternatives].flatMap(m=>linked(m,'stocks')).map(async stock=> {
      const current = await get('stock',stock.id);
      const reservations = await Promise.all(linked(current,'reservations').map(async reservation=> {
        const owner = await get('procurementRequest',reservation.procurement_request_id);
        return {...reservation,work:linked(owner,'workOrder')[0]};
      }));
      return {...current,reservations};
    }));
    return {item,material,alternatives,stocks,quotations:linked(material,'quotations')};
  }));
  return materials as {item:Row;material:Row;alternatives:Row[];stocks:Row[];quotations:Row[]}[];
}
const date = (value:unknown) => value ? new Date(String(value)).toISOString().replace('.000Z','Z') : '—';
const allocated = (view:RequestView, materialId:string) => view.reservations.filter(r=>r.status==='active' && r.required_material_id===materialId).reduce((sum,r)=>sum+r.quantity,0);

export function ProcurementInvestigation({initialRequestId}:{initialRequestId:string|null}) {
  const [views,setViews] = useState<RequestView[]>([]);
  const [selected,setSelected] = useState<string|null>(initialRequestId);
  const [search,setSearch] = useState('');
  const [details,setDetails] = useState<Awaited<ReturnType<typeof contextFor>>>([]);
  const [audit,setAudit] = useState<AuditEntry[]>([]);
  const [loading,setLoading] = useState(true);
  const [error,setError] = useState<string|null>(null);
  const [revision,setRevision] = useState(0);
  const view = views.find(v=>v.request.id===selected);
  useEffect(()=> {
    let active=true; setLoading(true);setError(null);
    fetchInstances('procurementRequest').then(rows=>Promise.all(rows.map(row=>requestView(String(row.id)))))
      .then(rows=>{if(active){setViews(rows);if(!selected)setSelected(rows[0]?.request.id ?? null);}})
      .catch(e=>active&&setError(e.message)).finally(()=>active&&setLoading(false));
    return ()=>{active=false;};
  },[revision]);
  useEffect(()=> {
    if(!view)return;
    let active=true;setDetails([]);setAudit([]);setError(null);
    Promise.all([contextFor(view),fetchAudit('procurementRequest',view.request.id)])
      .then(([context,history])=>{if(active){setDetails(context);setAudit(history);}}).catch(e=>active&&setError(e.message));
    return ()=>{active=false;};
  },[view]);
  const activeViews = views.filter(v=>['planned','inProgress'].includes(v.work.status));
  const shortageCount = activeViews.filter(v=>v.work.required_materials.some((item:Row)=>allocated(v,item.materialId)<item.requiredQuantity)).length;
  const staleReservations = views.filter(v=>v.work.status==='cancelled').reduce((count,v)=>count+v.reservations.filter(r=>r.status==='active').length,0);
  const shown=views.filter(v=>`${v.request.id} ${v.work.id} ${v.work.description}`.toLowerCase().includes(search.toLowerCase()));
  return <main className="procurement-dashboard">
    <header><div><h1>Maintenance Procurement</h1><p>Compare demand with actual allocations. Narrative date: 2026-10-10. All data is synthetic.</p></div><Button icon="refresh" onClick={()=>setRevision(n=>n+1)}>Refresh current state</Button></header>
    <div className="procurement-metrics"><Card><span>Active maintenance requests</span><strong>{activeViews.length}</strong></Card><Card><span>Requests with uncovered demand</span><strong>{shortageCount}</strong></Card><Card><span>Active reservations for cancelled work</span><strong>{staleReservations}</strong></Card></div>
    {error&&<Callout intent="danger">{error}</Callout>}
    {loading?<Spinner/>:<div className="procurement-layout"><aside>
      <InputGroup leftIcon="search" placeholder="Search requests or work orders: WO-017 / WO-009" value={search} onChange={e=>setSearch(e.target.value)}/>
      {shown.map(v=><button key={v.request.id} className={`request-row ${v.request.id===selected?'selected':''}`} onClick={()=>setSelected(v.request.id)}>
        <strong>{v.request.id}</strong><span>{v.work.id} · {v.work.status}</span>
        <small>{v.work.required_materials.map((item:Row)=>`${item.materialId}: ${allocated(v,item.materialId)}/${item.requiredQuantity}`).join(' · ')}</small>
      </button>)}
    </aside><section>{view&&<>
      <Card><h2>{view.request.id} <Tag>{view.work.id}</Tag></h2><p>{view.work.description}</p>
        <p>Work status <strong>{view.work.status}</strong> · Warehouse {view.work.material_warehouse_code} · Scheduled start {date(view.work.planned_start_at)}</p>
        {view.work.status==='cancelled'&&<Callout intent="warning" title="Work cancellation evidence">{view.work.cancellation_reason} · {date(view.work.cancelled_at)}<p>Reservations are separate ERP facts. Check whether active reservations remain below.</p></Callout>}
        <p className="muted">CMMS observed at {date(view.work.observed_at)}. Schedule and demand are read from the linked work order.</p>
        <HTMLTable striped><thead><tr><th>Required material</th><th>Required quantity</th><th>Active allocation</th><th>Uncovered</th></tr></thead><tbody>{view.work.required_materials.map((item:Row)=><tr key={item.materialId}><td>{item.materialId}</td><td>{item.requiredQuantity}</td><td>{allocated(view,item.materialId)}</td><td>{Math.max(0,item.requiredQuantity-allocated(view,item.materialId))}</td></tr>)}</tbody></HTMLTable>
        {view.work.status==='cancelled'&&<p>Historical demand of cancelled work is shown for comparison, not as new procurement demand.</p>}
      </Card>
      <Card><h3>Monitoring concerns</h3>{linked(view.request,'flags').length ? linked(view.request,'flags').map(flag=><div key={flag.id}><p><strong>{flag.id}</strong> <Tag>{flag.severity}</Tag> <Tag>{flag.status}</Tag></p><p>{flag.reason}</p><small>{flag.flagged_by} · {date(flag.flagged_at)}</small></div>) : <p>No monitoring concerns recorded.</p>}</Card>
      <Card><h3>Reservation history</h3><HTMLTable striped><thead><tr><th>Reservation</th><th>Stock</th><th>Required material</th><th>Quantity</th><th>Status</th></tr></thead><tbody>{view.reservations.map(r=><tr key={r.id}><td>{r.id}</td><td>{r.stock_id}</td><td>{r.required_material_id}</td><td>{r.quantity}</td><td>{r.status}</td></tr>)}</tbody></HTMLTable>{!view.reservations.length&&<p>No allocations recorded.</p>}</Card>
      {!details.length&&!error&&<Spinner size={20}/>}
      {details.map(({item,material,alternatives,stocks,quotations})=><Card key={item.materialId}>
        <h3>{material.name} · {material.id} <Tag>{material.base_unit}</Tag></h3><p>Approved alternatives: {alternatives.map(m=>`${m.name} (${m.id})`).join(', ')||'None'} · 1:1, same unit</p>
        <h4>Related stock and reservations for other work</h4>
        {stocks.map(stock=>{const active=stock.reservations.filter((r:Row)=>r.status==='active');const reserved=active.reduce((s:number,r:Row)=>s+r.quantity,0);return <div className="stock-block" key={stock.id}>
          <strong>{stock.id} · {stock.material_id} · {stock.warehouse_code}</strong><p>On hand {stock.on_hand_quantity} · Active reservations {reserved} · Free {stock.on_hand_quantity-reserved}</p>
          {stock.reservations.map((r:Row)=><p key={r.id}><Button small minimal onClick={()=>{setSelected(r.procurement_request_id);setSearch('');}}>{r.work?.id} / {r.procurement_request_id}</Button> {r.quantity} units · reservation {r.status} · work {r.work?.status}{r.work?.status==='cancelled'&&` — ${r.work.cancellation_reason}`}</p>)}
        </div>})}{!stocks.length&&<p>No required-material or alternative stock recorded</p>}
        <h4>Historical quotations for this material</h4><p className="muted">These are historical terms. Request a new quote to confirm price and delivery for the current quantity and deadline.</p>
        <HTMLTable striped><thead><tr><th>Quotation / supplier</th><th>Quoted quantity</th><th>Unit price / shipping</th><th>Historical offered arrival</th><th>Quote valid until</th></tr></thead><tbody>{quotations.map(q=><tr key={q.id}><td>{q.id}<br/>{q.supplier_name}</td><td>{q.quoted_quantity}</td><td>{q.unit_price} / {q.shipping_cost} {q.currency}</td><td>{date(q.offered_arrival_at)}</td><td>{date(q.valid_until)}</td></tr>)}</tbody></HTMLTable>
      </Card>)}
      <Card><h3>Action and RFQ history</h3><p>Successful action results and authorizing Proposal IDs. An RFQ draft does not mean external dispatch or secured material.</p>{audit.map((entry,i)=><details key={i} open={i===0}><summary>{entry.action} · {entry.actor} · {date(entry.timestamp)}</summary><pre>{JSON.stringify({params:entry.params,result:entry.result},null,2)}</pre></details>)}{!audit.length&&<p>No actions executed for this request.</p>}</Card>
    </>}</section></div>}
  </main>;
}
