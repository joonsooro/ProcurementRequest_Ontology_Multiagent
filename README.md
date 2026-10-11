# Maintenance Procurement Ontology

A maintenance procurement application where people and agents evaluate stock, approved alternatives, reservations held by cancelled work, and historical quotations before proposing a purchase.

The ontology is **relational data + a metadata catalog + executable business rules**. PostgreSQL stores facts; the catalog describes their meaning; shared server code provides queries, relationship navigation, and actions. There is no separate graph database.

**How the layers fit together**

```text
Dashboard / Agent tools
          │ HTTP
          ▼
Hono routes → Ontology runtime → Kysely + pg → PostgreSQL on Neon
              │
              ├─ Resolve object, property, and link metadata
              └─ Validate and dispatch registered action handlers
```

| Component | Responsibility |
| --- | --- |
| Hono | Receive HTTP requests and return responses. |
| Ontology runtime | Interpret the catalog, resolve relationships, enforce action rules, and coordinate approvals. |
| Kysely + `pg` | Build SQL and execute it through the PostgreSQL connection. They do not create the schema or supply business rules. |
| PostgreSQL | Store instances, metadata, and logs; enforce constraints, transactions, and row locks. |
| Neon | Host PostgreSQL. |

**Business objects and ownership**

A `ProcurementRequest` covers **one maintenance work order and potentially several materials**. Related objects own their facts:

| Object | What one instance represents |
| --- | --- |
| ProcurementRequest | A request linked to its maintenance work order. |
| MaintenanceWorkOrder | The work, schedule, required-materials JSON, and cancellation evidence. |
| Material | A material's identity, specification, base unit, and approved alternative IDs. |
| Stock | A material's on-hand quantity at a warehouse. |
| Reservation | A quantity of stock allocated to a request and a particular material requirement. |
| Quotation | Historical supplier terms for a material, including quantity, price, and delivery date. |
| FlagLog | A recorded concern about a request that needs planning attention. |
| Proposal | One proposed action, target object, parameter set, rationale, and review state. |

Cancelling work does **not** automatically release reservations: the discrepancy remains visible for review and reallocation. Reservations change allocations, not physical on-hand quantity.

**The catalog makes tables discoverable**

Each object needs an instance table **and** metadata. A table alone is invisible to the ontology API.

| Metadata table | Meaning | Example |
| --- | --- | --- |
| `object_type` | Object name and backing schema/table. | `procurementRequest` → `procurement.procurement_request` |
| `property` | Public property name, storage column, type, requiredness, primary key, and display title. | `workOrderId` → `work_order_id` |
| `link` | Source reference property, target type, cardinality, and forward/inverse names. | Request → work order; work order → request |
| `action_type` | Action name, target type, input JSON Schema, and caller policy. | `procurementRequest.reallocateReservation` |

A database foreign key enforces referential integrity. A catalog link describes navigation. Registering a link does not create a foreign key.

**One read interface for the dashboard and agents**

```http
GET  /api/objects/:type
POST /api/objects/:type/query
GET  /api/objects/:type/:id
```

The catalog resolves the backing table and filter columns. Detail reads also return forward and inverse relationships in `links`, such as a request's work order and reservations.

Expansion is **one hop**. Required-materials JSON and alternative-ID arrays do not create automatic links; agents explicitly query their referenced objects. Filters use public property names; current instance responses retain storage names such as `work_order_id`.

**Actions turn decisions into controlled changes**

```http
POST /api/objects/:type/:id/actions/:actionName
```

An action needs metadata in [`schema.ts`](apps/ontology/src/schema.ts) and a function in the [handler registry](apps/ontology/src/actions/index.ts). The route uses metadata for authorization and validation; the handler implements business rules. TypeScript checks development-time code; JSON Schema validates incoming parameters at runtime.

For stock allocation, reservation reallocation, and RFQ requests, execution requires a Proposal:

1. A planner submits the action, target, parameters, and rationale.
2. Approval locks the Proposal and revalidates its parameters and caller policy.
3. The handler reads current demand, stock, and reservations inside the same database transaction and checks business constraints.
4. Business changes, successful-action audit records, and the approval decision commit together. Any failure rolls them back together.

Handlers share the approval's database transaction. Row locks coordinate competing changes while allowing ordinary reads; fresh validation prevents reliance on the planner's earlier snapshot.

For resolved actions, `access_log` records attempts before input validation; `audit_log` records successful changes inside the transaction. Failed attempts therefore remain traceable. Caller headers provide demo attribution, not production authentication.

**Agent workflow**

The read-only analytics agent explains evidence. Monitoring creates FlagLogs; planning reads them and creates Proposals; verification approves eligible inventory actions or escalates RFQ decisions to a person. Agents use the shared ontology API rather than direct SQL. FlagLogs are not automatically resolved by approval, and an RFQ action currently creates a local draft rather than contacting a supplier.

**Demo time configuration**

Set `DEMO_NOW` in the root `.env` to an ISO timestamp. The server anchors its clock to that date and advances with elapsed time; agents use the same configured reference date. Restart the server, agent processes, and frontend dev server after changing it.

**Where to read the implementation**

- [Database foundation](apps/ontology/src/db/foundation.sql): instance tables, metadata tables, and constraints.
- [Catalog definitions](apps/ontology/src/catalog.ts): objects, properties, and links.
- [Object routes](apps/ontology/src/routes/objects.ts) and [action routes](apps/ontology/src/routes/actions.ts): metadata-driven reads and invocation.
- [Procurement handlers](apps/ontology/src/actions/procurement/materialActions.ts) and [Proposal approval](apps/ontology/src/actions/shared/proposalApprove.ts): current-state validation and atomic execution.
- [Agents](apps/agents/src/agents/procurement): role definitions and policies.

Extensions require table + catalog entries, or action metadata + registered handler. Schema changes use SQL, not Kysely's TypeScript types.
