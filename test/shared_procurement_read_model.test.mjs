import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSharedProcurementReadModel,
  procurementReadModelSourceStatus,
} from "../site/shared_procurement_read_model.mjs";

function sourceRecord(sourceSystem, sourceSystemId, snapshot) {
  return {
    source_system: sourceSystem,
    source_system_id: sourceSystemId,
    content_hash: `${sourceSystemId}-hash`,
    normalized_snapshot: JSON.stringify(snapshot),
    raw_snapshot: JSON.stringify(snapshot),
    ingested_at: "2026-08-18T19:46:32Z",
  };
}

const records = [
  sourceRecord("passport_public_contracts", "contract:84126P0001001:CTR-77", {
    ctr_id: "CTR-77",
    epin: "84126P0001001",
    contract_id: "CT1841260001",
    status: "Registered",
  }),
  sourceRecord("checkbook_contracts", "contract:registered:CT1841260001:VENDOR:prime-vendor:2026-07-20", {
    id: "CT1841260001",
    pin: "84126P0001001",
    status: "registered",
  }),
  sourceRecord("checkbook_spending", "payment:CT1841260001:DOC-1:VENDOR:2026-08-01:125", {
    contractId: "CT1841260001",
    id: "DOC-1",
    vendor: "Vendor",
    date: "2026-08-01",
    amount: 125,
  }),
];

const lifecycle = {
  pin: "84126P0001001",
  pin_strategy: "exact",
  ok: true,
  timeline: [
    {
      stage: "award",
      status: "matched",
      source: "city-record",
      date: "2026-06-29",
      detail: {
        request_id: "20260623008",
        title: "Bridge inspection",
        vendor: "HNTB Corporation",
        amount: 13533763,
        pin: "84126P0001001",
      },
    },
    {
      stage: "registered",
      status: "matched",
      source: "checkbook-contracts",
      date: "2026-07-20",
      detail: { contract_id: "CT1841260001", current_amount: 13533763.08 },
    },
    {
      stage: "payment",
      status: "matched",
      source: "checkbook-spending",
      date: "2026-08-01",
      detail: { total_spent: 125, payment_rows: [{ document_id: "DOC-1", amount: 125 }] },
    },
  ],
  amendments: [{ contract_id: "CT1841260001", delta: 0 }],
};

test("shared procurement model aggregates stage observations and preserves lifecycle parity", () => {
  const model = buildSharedProcurementReadModel({
    sourceRecords: records,
    lifecycleRows: [lifecycle],
    generatedAt: "2026-08-18T20:00:00Z",
    now: "2026-08-18T20:01:00Z",
  });
  assert.equal(model.schema, "cityscroll.shared_procurement_read_model.v1");
  assert.equal(model.counts.total, 1);
  assert.equal(model.counts.source_observations, 3);
  assert.ok(model.counts.cross_source_identity_joins > 0);
  assert.equal(model.identity_gate.ok, true);

  const [object] = model.rows;
  assert.deepEqual(object.lifecycle, lifecycle, "existing CROL lifecycle fields survive unchanged");
  assert.ok(object.source_observation_refs.includes("city_record:20260623008"));
  assert.ok(object.source_observation_refs.includes(`checkbook_spending:${records[2].source_system_id}`));
  assert.deepEqual(object.stages.map((stage) => stage.stage), ["award", "registered", "payment"]);
});

test("source failures change coverage only, never surviving object identity or detail", () => {
  const available = buildSharedProcurementReadModel({
    sourceRecords: records,
    lifecycleRows: [lifecycle],
    sourceStatus: { checkbook_spending: { status: "available", reason: null } },
    generatedAt: "2026-08-18T20:00:00Z",
  });
  const failed = buildSharedProcurementReadModel({
    sourceRecords: records,
    lifecycleRows: [lifecycle],
    sourceStatus: { checkbook_spending: { status: "unavailable", reason: "upstream_error" } },
    generatedAt: "2026-08-18T20:00:00Z",
  });

  assert.deepEqual(failed.rows, available.rows);
  assert.equal(procurementReadModelSourceStatus(available, "checkbook_spending"), "available");
  assert.equal(procurementReadModelSourceStatus(failed, "checkbook_spending"), "unavailable");
  assert.equal(failed.sources.checkbook_spending.reason, "upstream_error");
});

test("CROL-negative source rows remain canonical without a City Record lifecycle", () => {
  const model = buildSharedProcurementReadModel({
    sourceRecords: records.slice(0, 2),
    lifecycleRows: [],
    generatedAt: "2026-08-18T20:00:00Z",
  });
  assert.equal(model.rows.length, 1);
  assert.equal(model.rows[0].procurement_id, "procurement:contract:CT1841260001");
  assert.equal(model.rows[0].lifecycle, null);
  assert.deepEqual(model.rows[0].compatibility.city_record_notice_hrefs, []);
});
