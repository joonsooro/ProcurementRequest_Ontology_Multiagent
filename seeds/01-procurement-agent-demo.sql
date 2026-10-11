-- Synthetic, deliberately contrasted examples. Dates are narrative fixtures, not customer evidence.
-- Run only via the explicit demo:reset command. There are NO pre-authored flags, proposals or audits.
BEGIN;
-- Explicit demo reset, limited to this project's procurement instance/history tables.
-- Catalog definitions and the original manufacturing database are not touched.
TRUNCATE procurement.rfq_request, procurement.audit_log, procurement.access_log,
 procurement.proposal, procurement.flag_log, procurement.reservation, procurement.quotation,
 procurement.stock, procurement.procurement_request, procurement.maintenance_work_order,
 procurement.material RESTART IDENTITY;
INSERT INTO procurement.material VALUES
 ('FILTER-A','Standard filter A','EA','{"spec":"F100"}',ARRAY['FILTER-B']),
 ('FILTER-B','Approved alternative filter B','EA','{"spec":"F100-compatible","substitutionRatio":"1:1"}','{}'),
 ('FILTER-01','Reallocation filter','EA','{"spec":"F200"}','{}'),
 ('SEAL-01','Pump seal','EA','{"size":"25mm"}','{}'),
 ('BEARING-01','Replacement bearing','EA','{"size":"6205"}','{}'),
 ('GASKET-01','Control gasket','EA','{"size":"G50"}','{}')
ON CONFLICT DO NOTHING;
INSERT INTO procurement.maintenance_work_order
(id,description,asset_code,material_warehouse_code,planned_start_at,planned_end_at,status,required_materials,cancelled_at,cancellation_reason,observed_at) VALUES
 ('WO-ALT','Filter and seal replacement / approved alternative available','PUMP-01','WH-P1','2026-10-15T09:00Z','2026-10-15T12:00Z','planned','[{"materialId":"FILTER-A","requiredQuantity":10},{"materialId":"SEAL-01","requiredQuantity":2}]',NULL,NULL,'2026-10-10T08:00Z'),
 ('WO-017','Filter replacement / current expedited schedule','PUMP-17','WH-P1','2026-10-15T09:00Z','2026-10-15T12:00Z','planned','[{"materialId":"FILTER-01","requiredQuantity":10}]',NULL,NULL,'2026-10-10T08:00Z'),
 ('WO-009','Cancelled filter maintenance / ERP reservation still active','PUMP-09','WH-P1','2026-10-20T09:00Z',NULL,'cancelled','[{"materialId":"FILTER-01","requiredQuantity":7}]','2026-10-09T12:00Z','CMMS: work cancelled after confirmed equipment retirement','2026-10-10T08:00Z'),
 ('WO-RFQ','Bearing replacement / uncovered demand','PUMP-30','WH-P1','2026-10-15T09:00Z',NULL,'planned','[{"materialId":"BEARING-01","requiredQuantity":10}]',NULL,NULL,'2026-10-10T08:00Z'),
 ('WO-LIVE','Active bearing maintenance / reservation must be retained','PUMP-31','WH-P1','2026-10-10T07:00Z','2026-10-14T12:00Z','inProgress','[{"materialId":"BEARING-01","requiredQuantity":7}]',NULL,NULL,'2026-10-10T08:00Z'),
 ('WO-CONTROL','Healthy control / cancellation and reallocation already reflected','PUMP-40','WH-P1','2026-10-15T09:00Z',NULL,'planned','[{"materialId":"GASKET-01","requiredQuantity":10}]',NULL,NULL,'2026-10-10T08:00Z'),
 ('WO-CANCEL-CONTROL','Healthy control / cancellation and release both reflected','PUMP-41','WH-P1','2026-10-20T09:00Z',NULL,'cancelled','[{"materialId":"GASKET-01","requiredQuantity":7}]','2026-10-09T12:00Z','ERP reservation released after CMMS cancellation','2026-10-10T08:00Z')
ON CONFLICT DO NOTHING;
INSERT INTO procurement.procurement_request VALUES
 ('MPR-ALT','WO-ALT','2026-10-08T09:00Z'),('MPR-017','WO-017','2026-10-08T09:00Z'),('MPR-009','WO-009','2026-10-08T09:00Z'),
 ('MPR-RFQ','WO-RFQ','2026-10-08T09:00Z'),('MPR-LIVE','WO-LIVE','2026-10-08T09:00Z'),('MPR-CONTROL','WO-CONTROL','2026-10-08T09:00Z'),('MPR-CANCEL-CONTROL','WO-CANCEL-CONTROL','2026-10-08T09:00Z')
ON CONFLICT DO NOTHING;
INSERT INTO procurement.stock VALUES
 ('ST-ALT','FILTER-B','WH-P1',12,'2026-10-10T08:00Z'),('ST-SEAL','SEAL-01','WH-P1',2,'2026-10-10T08:00Z'),
 ('ST-017','FILTER-01','WH-P1',12,'2026-10-10T08:00Z'),('ST-RFQ','BEARING-01','WH-P1',12,'2026-10-10T08:00Z'),('ST-CONTROL','GASKET-01','WH-P1',12,'2026-10-10T08:00Z')
ON CONFLICT DO NOTHING;
INSERT INTO procurement.reservation VALUES
 ('RES-SEAL','MPR-ALT','ST-SEAL','SEAL-01',2,'active','2026-10-08T10:00Z',NULL,'2026-10-10T08:00Z'),
 ('RES-009','MPR-009','ST-017','FILTER-01',7,'active','2026-10-08T10:00Z',NULL,'2026-10-10T08:00Z'),
 ('RES-LIVE','MPR-LIVE','ST-RFQ','BEARING-01',7,'active','2026-10-08T10:00Z',NULL,'2026-10-10T08:00Z'),
 ('RES-RFQ-5','MPR-RFQ','ST-RFQ','BEARING-01',5,'active','2026-10-09T10:00Z',NULL,'2026-10-10T08:00Z'),
 ('RES-CONTROL-OLD','MPR-CANCEL-CONTROL','ST-CONTROL','GASKET-01',7,'released','2026-10-08T10:00Z','2026-10-09T13:00Z','2026-10-10T08:00Z'),
 ('RES-CONTROL','MPR-CONTROL','ST-CONTROL','GASKET-01',10,'active','2026-10-09T13:00Z',NULL,'2026-10-10T08:00Z')
ON CONFLICT DO NOTHING;
-- A/B offers belong to historical material sourcing. Their old delivery dates cannot authorize today's purchase.
INSERT INTO procurement.quotation VALUES
 ('Q-BEAR-A','BEARING-01','SUP-A','Supplier A',10,40,'EUR',10,'2026-09-20T09:00Z','2026-09-18T09:00Z','2026-09-10T09:00Z','2026-09-19T09:00Z'),
 ('Q-BEAR-B','BEARING-01','SUP-B','Supplier B',10,48,'EUR',15,'2026-09-20T09:00Z','2026-09-14T09:00Z','2026-09-10T09:00Z','2026-09-19T09:00Z'),
 ('Q-FILTER-A','FILTER-01','SUP-A','Supplier A',10,20,'EUR',10,'2026-09-20T09:00Z','2026-09-18T09:00Z','2026-09-10T09:00Z','2026-09-19T09:00Z')
ON CONFLICT DO NOTHING;

COMMIT;
