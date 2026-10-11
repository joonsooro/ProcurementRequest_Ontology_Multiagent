## Conventions

- Use `pnpm add` to install libraries.
Don't add packages by writing them directly into a `package.json`.
- The Neon Postgres connection string lives in `DATABASE_URL` in `.env` at the repository root.
- We use Node 22+, which can natively run `.ts` files without `tsx`, using `node --env-file=.env <file>.ts`.
- Kysely is used as a runtime query builder only, not as a migration or schema management tool. Schema changes go through SQL files applied with `pnpm run-sql`.
- Instance-table primary keys are text, holding domain IDs like `MPR-017` and `WO-017`. Generated Reservation, FlagLog and RFQ identifiers are prefixed text IDs; Proposal uses a database-generated integer ID.
- Use only this project's root DATABASE_URL. Do not use or reset databases belonging to other projects. The active ontology schema is `procurement`.
- The ontology server's clock is anchored to the system-level override date `DEMO_NOW`. The process's current time starts at the configured demo date and advances from there.
- When adding variables to .env, use 'echo 'KEY=VALUE' >> .env' rather than editing the file. Editing exposes existing secrets in the diff and sends them through tool calls
- Run agent files with the project root .env file.
- Keep action metadata and JSON Schema definitions in `apps/ontology/src/schema.ts` and derive handler parameter types from them. Apply with `pnpm apply-action-schema`, which generates temporary SQL outside seeds directories and invokes `pnpm run-sql` using the root `.env`. Do not use files in any seeds directory unless explicitly requested.
- An action has two halves: a handler in `apps/ontology/src/actions/...` and an `action_type` metadata row holding its `parameter_schema` (JSON Schema). The invoke route reads the metadata to validate and dispatch, so a handler with no row is unreachable and its audit write fails. Add both together, apply the metadata INSERT via a temporary SQL file applied with `run-sql` (not the read-only Neon MCP), and keep the schema and the handler's params in sync.
- A new object type has two halves: an instance table in the target ontology schema and metadata rows ('object_type' + 'property' rows, plus 'link' rows if it references other types). The generic routes discover types from 'object_type', read columns from 'property', and resolve links from 'link'. A table with no metadata is invisible to the API and UI. Add both together in a temporary SQL file applied with 'run-sql'.

# Explain coding and data modeling intent

By default, include clear comments when adding or changing code and data models.

- Explain each module's purpose, significant functions, and non-obvious control flow. Describe why an approach is needed, not just what the syntax does.
- Explain data modeling choices: what an entity represents, why fields and relationships exist, identifier strategy, lifecycle states, optionality, defaults, constraints, and API-to-storage name mappings.
- Explain boundaries and guarantees that affect behavior, such as validation, transaction ownership, rollback, concurrency, caller identity, and audit attribution.
- When behavior is delegated to a shared helper, make that delegation and its purpose clear at the call site.
- Keep comments accurate and update them with implementation changes. Describe actual guarantees and limitations rather than intended behavior that the code does not enforce.
- Use plain language and readable formatting. Focus comments on intent and decisions; avoid repeating obvious assignments or commenting every line.
- Keep strict JSON and generated files valid. Explain their intent in related source/configuration comments where their format does not support comments.

# Build for scalable extension

- Design shared code to accept typed configuration/context objects rather than hardcoded user or domain values or growing lists of positional arguments. Keep concrete values at the owning UI or application boundary so new callers and capabilities can reuse the implementation without rewriting it. Apply this proportionately to current needs; do not add speculative abstraction.

## Procurement scope

- The six domain types are ProcurementRequest, MaintenanceWorkOrder, Material, Stock, Reservation, and Quotation. Proposal and the request-linked FlagLog support the agent workflow.
- One request covers one work order's multiple materials. WorkOrder owns requiredMaterials JSON; do not duplicate demand/date/cancellation fields into Reservation.
- Links resolve scalar reference properties only. JSON IDs and alternative ID arrays are read and queried explicitly by callers.
- Allocation, reallocation and RFQ mutations require Proposal approval. Monitoring records observations directly through ProcurementRequest.flag; this must not change stock or demand. One Proposal carries one action and one target. RFQ creates a local draft and does not send externally.
- The actor header is demo policy attribution, not authentication. Do not describe it as production authorization.
- Implemented roles are analytics (read-only), monitoring (FlagLog), planning (Proposal creation), and verification (review). Only a human buyer approves RFQs.
- Use English for code comments, metadata, data, UI, prompts, logs and documentation.
- The explicit demo:reset command applies seeds/01-procurement-agent-demo.sql. It creates facts only: no prewritten flags or proposals. The legacy db/demo.sql is a regression-test fixture, not the public agent demo.
- Apply the foundation with `pnpm setup:procurement`. It preserves operational rows; it is not a reset command.
- Keep private working notes, model references, execution logs and verification reports in the Git-ignored PMM directory.
