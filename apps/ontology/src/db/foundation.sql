-- Create procurement instance storage and the shared ontology catalog without resetting existing data.
-- Idempotent bootstrap: existing operational rows are never deleted or overwritten.
BEGIN;
CREATE SCHEMA IF NOT EXISTS procurement;

CREATE TABLE IF NOT EXISTS procurement.object_type (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), api_name text NOT NULL UNIQUE, name text NOT NULL,
  description text, status text NOT NULL DEFAULT 'active', visibility text NOT NULL DEFAULT 'visible',
  point_of_contact text, edits_enabled boolean NOT NULL DEFAULT false,
  schema text NOT NULL, datasource_table text NOT NULL
);
CREATE TABLE IF NOT EXISTS procurement.property (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), object_type_id uuid NOT NULL REFERENCES procurement.object_type(id),
  api_name text NOT NULL, name text NOT NULL, data_type text NOT NULL, required boolean NOT NULL,
  is_title boolean NOT NULL DEFAULT false, is_primary_key boolean NOT NULL DEFAULT false,
  datasource_column text NOT NULL, UNIQUE (object_type_id, api_name), UNIQUE (object_type_id, datasource_column)
);
CREATE TABLE IF NOT EXISTS procurement.link (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), api_name text NOT NULL, name text NOT NULL,
  inverse_api_name text NOT NULL, inverse_name text NOT NULL,
  source_type_id uuid NOT NULL REFERENCES procurement.object_type(id),
  target_type_id uuid NOT NULL REFERENCES procurement.object_type(id),
  via_property_id uuid NOT NULL REFERENCES procurement.property(id),
  cardinality text NOT NULL CHECK (cardinality IN ('one_to_one','many_to_one','one_to_many','many_to_many')),
  UNIQUE (source_type_id, api_name)
);
CREATE TABLE IF NOT EXISTS procurement.action_type (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), object_type_id uuid NOT NULL REFERENCES procurement.object_type(id),
  api_name text NOT NULL, name text NOT NULL, description text, parameter_schema jsonb NOT NULL,
  allowed_callers text[], UNIQUE (object_type_id, api_name)
);
CREATE TABLE IF NOT EXISTS procurement.access_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), caller_identity text NOT NULL,
  action_type text NOT NULL, target_type text NOT NULL, target_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('allowed','denied')), reason text NOT NULL,
  timestamp timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS procurement.audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), action_type_id uuid NOT NULL REFERENCES procurement.action_type(id),
  action_api_name text NOT NULL, target_type_id uuid NOT NULL REFERENCES procurement.object_type(id),
  target_type_api_name text NOT NULL, target_id text NOT NULL, actor text NOT NULL,
  params jsonb, result jsonb, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS procurement.material (
  id text PRIMARY KEY, name text NOT NULL, base_unit text NOT NULL,
  specification jsonb NOT NULL CHECK (jsonb_typeof(specification) = 'object'),
  approved_alternative_material_ids text[] NOT NULL DEFAULT '{}',
  CHECK (NOT id = ANY(approved_alternative_material_ids))
);
COMMENT ON TABLE procurement.material IS 'One reusable material identity. Alternative IDs are properties read by callers; the one-hop resolver does not traverse arrays.';

-- Structural validation keeps the agreed JSON model. It does not manufacture JSON-path catalog links.
CREATE OR REPLACE FUNCTION procurement.valid_required_materials(items jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(items) IS DISTINCT FROM 'array' THEN false ELSE
    jsonb_array_length(items) > 0
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(items) e WHERE
      jsonb_typeof(e) IS DISTINCT FROM 'object'
      OR jsonb_typeof(e->'materialId') IS DISTINCT FROM 'string'
      OR coalesce(length(e->>'materialId'),0) = 0
      OR NOT CASE WHEN jsonb_typeof(e->'requiredQuantity') = 'number'
        THEN (e->>'requiredQuantity')::numeric > 0 ELSE false END)
    AND (SELECT count(*) = count(DISTINCT e->>'materialId') FROM jsonb_array_elements(items) e)
  END;
$$;
CREATE TABLE IF NOT EXISTS procurement.maintenance_work_order (
  id text PRIMARY KEY, description text NOT NULL, asset_code text NOT NULL, material_warehouse_code text NOT NULL,
  planned_start_at timestamptz NOT NULL, planned_end_at timestamptz,
  status text NOT NULL CHECK (status IN ('planned','inProgress','completed','cancelled')),
  required_materials jsonb NOT NULL CHECK (procurement.valid_required_materials(required_materials)),
  cancelled_at timestamptz, cancellation_reason text, observed_at timestamptz NOT NULL,
  CHECK (planned_end_at IS NULL OR planned_end_at >= planned_start_at),
  CHECK (status <> 'cancelled' OR (cancelled_at IS NOT NULL AND coalesce(length(trim(cancellation_reason)),0) > 0))
);
COMMENT ON COLUMN procurement.maintenance_work_order.required_materials IS 'Authoritative current demand: one materialId/requiredQuantity entry per material. IDs are checked by actions; this JSON has no automatic FK/link traversal.';
CREATE TABLE IF NOT EXISTS procurement.procurement_request (
  id text PRIMARY KEY, work_order_id text NOT NULL UNIQUE REFERENCES procurement.maintenance_work_order(id),
  requested_at timestamptz NOT NULL
);
COMMENT ON TABLE procurement.procurement_request IS 'One work order material bundle, not one material line. Latest demand/date/cancellation is read from the linked work order.';
CREATE TABLE IF NOT EXISTS procurement.stock (
  id text PRIMARY KEY, material_id text NOT NULL REFERENCES procurement.material(id), warehouse_code text NOT NULL,
  on_hand_quantity double precision NOT NULL CHECK (on_hand_quantity >= 0 AND on_hand_quantity < 'Infinity'::float8),
  observed_at timestamptz NOT NULL, UNIQUE(material_id, warehouse_code)
);
CREATE TABLE IF NOT EXISTS procurement.reservation (
  id text PRIMARY KEY, procurement_request_id text NOT NULL REFERENCES procurement.procurement_request(id),
  stock_id text NOT NULL REFERENCES procurement.stock(id), required_material_id text NOT NULL REFERENCES procurement.material(id),
  quantity double precision NOT NULL CHECK (quantity > 0 AND quantity < 'Infinity'::float8),
  status text NOT NULL CHECK (status IN ('active','released')),
  reserved_at timestamptz NOT NULL, released_at timestamptz, observed_at timestamptz NOT NULL,
  CHECK ((status = 'released') = (released_at IS NOT NULL))
);
COMMENT ON TABLE procurement.reservation IS 'Independent ERP allocation fact. Cancelled work can retain an active reservation. Physical stock is not decremented by reservation.';
COMMENT ON COLUMN procurement.reservation.required_material_id IS 'Demand material being covered; actual supplied material is read through Stock and may be an approved alternative.';
CREATE TABLE IF NOT EXISTS procurement.quotation (
  id text PRIMARY KEY, material_id text NOT NULL REFERENCES procurement.material(id),
  supplier_code text NOT NULL, supplier_name text NOT NULL,
  quoted_quantity double precision NOT NULL CHECK (quoted_quantity > 0 AND quoted_quantity < 'Infinity'::float8),
  unit_price double precision NOT NULL CHECK (unit_price >= 0 AND unit_price < 'Infinity'::float8),
  currency text NOT NULL, shipping_cost double precision NOT NULL CHECK (shipping_cost >= 0 AND shipping_cost < 'Infinity'::float8),
  requested_required_at timestamptz NOT NULL, offered_arrival_at timestamptz NOT NULL,
  quoted_at timestamptz NOT NULL, valid_until timestamptz,
  CHECK (valid_until IS NULL OR valid_until >= quoted_at)
);
COMMENT ON TABLE procurement.quotation IS 'Historical supplier terms for a material; no FK to the current request. Historical arrival promises are not current commitments or delivery performance.';

-- FlagLog persists a concern while demand, stock and reservation facts remain on their owning objects.
CREATE TABLE IF NOT EXISTS procurement.flag_log (
  id text PRIMARY KEY,
  procurement_request_id text NOT NULL REFERENCES procurement.procurement_request(id),
  reason text NOT NULL CHECK (length(trim(reason)) > 0),
  severity text NOT NULL CHECK (severity IN ('low','medium','high')),
  status text NOT NULL CHECK (status IN ('open','resolved','dismissed')),
  flagged_by text NOT NULL, flagged_at timestamptz NOT NULL, resolved_at timestamptz,
  CHECK ((status = 'open' AND resolved_at IS NULL) OR (status <> 'open' AND resolved_at IS NOT NULL))
);
-- One open request-level concern avoids repeated flags while planning/review is outstanding.
CREATE UNIQUE INDEX IF NOT EXISTS flag_log_open_request_idx
  ON procurement.flag_log(procurement_request_id) WHERE status = 'open';
COMMENT ON TABLE procurement.flag_log IS 'Monitoring evidence linked to its request; no automatic resolution on approval.';

-- Proposal uses a generated integer ID; the six domain types use text IDs suitable for source-system references.
CREATE TABLE IF NOT EXISTS procurement.proposal (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  type text NOT NULL, target_id text NOT NULL, params jsonb NOT NULL CHECK (jsonb_typeof(params)='object'),
  rationale text NOT NULL CHECK (length(trim(rationale))>0),
  status text NOT NULL CHECK (status IN ('pending','escalated','approved','rejected')),
  proposed_by text NOT NULL, proposed_at timestamptz NOT NULL,
  reviewed_by text, reviewed_at timestamptz, decision_note text
);
-- A local RFQ execution record is deliberately not registered as an extra business object.
-- It does not represent a sent message, a supplier response, a purchase order, or secured material.
CREATE TABLE IF NOT EXISTS procurement.rfq_request (
  id text PRIMARY KEY, procurement_request_id text NOT NULL REFERENCES procurement.procurement_request(id),
  required_material_id text NOT NULL REFERENCES procurement.material(id), supplier_code text NOT NULL,
  quantity double precision NOT NULL CHECK (quantity > 0 AND quantity < 'Infinity'::float8), required_at timestamptz NOT NULL,
  warehouse_code text NOT NULL, reference_quotation_id text NOT NULL REFERENCES procurement.quotation(id),
  status text NOT NULL CHECK (status='draft'), created_by text NOT NULL, created_at timestamptz NOT NULL,
  authorized_by_proposal integer NOT NULL UNIQUE REFERENCES procurement.proposal(id)
);
CREATE INDEX IF NOT EXISTS reservation_stock_active_idx ON procurement.reservation(stock_id) WHERE status='active';
CREATE INDEX IF NOT EXISTS reservation_request_idx ON procurement.reservation(procurement_request_id);
CREATE INDEX IF NOT EXISTS reservation_required_material_idx ON procurement.reservation(required_material_id);
CREATE INDEX IF NOT EXISTS quotation_material_idx ON procurement.quotation(material_id);
CREATE INDEX IF NOT EXISTS proposal_review_idx ON procurement.proposal(status, target_id);
CREATE INDEX IF NOT EXISTS audit_target_idx ON procurement.audit_log(target_type_api_name, target_id, created_at DESC);
COMMIT;
