import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildSharedProcurementReadModel,
  procurementReadModelSourceStatus,
} from "../site/shared_procurement_read_model.mjs";
import {
  hasExactContractPaymentEvidence,
  paymentEvidenceFromLifecycle,
} from "../site/procurement_payment_place_context.mjs";

const emmonsLifecycle = JSON.parse(
  readFileSync(new URL("./fixtures/exact-contract-payment-place/emmons_lifecycle.json", import.meta.url), "utf8"),
);
const placeFactsMaterialization = JSON.parse(
  readFileSync(new URL("./fixtures/exact-contract-payment-place/place_facts.json", import.meta.url), "utf8"),
);

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

test("exact-contract lifecycle payments and notice place facts attach without collapsing lines", () => {
  const emmonsRecords = [
    sourceRecord("passport_public_contracts", "contract:07124E0044001:5050251", {
      ctr_id: "5050251",
      epin: "07124E0044001",
      contract_id: "CT107120258801626",
      status: "Registered",
      award_amount: 10869881,
      start_date: "10/11/2023",
      end_date: "06/30/2026",
    }),
    sourceRecord("checkbook_contracts", "contract:registered:CT107120258801626:BHRAGS:prime-vendor:2024-08-28", {
      id: "CT107120258801626",
      pin: "07124E0044001",
      status: "registered",
      original_amount: 10869881,
      current_amount: 10869881,
      spent: 7385672.19,
      start_date: "2023-10-11",
      end_date: "2026-06-30",
    }),
    sourceRecord("city_record", "20240829105", {
      request_id: "20240829105",
      pin: "07124E0044001",
      short_title: "City Sanctuary Facility for Families with Children, Comfort Inn Sheepsheads Bay",
      vendor_name: "BHRAGS HOME CARE CORP",
      contract_amount: "10869881",
      type_of_notice_description: "Award",
      additional_description_1: "<p>Located at 3218 Emmons Avenue, Brooklyn, NY 11235; 60 units.</p>",
    }),
  ];
  const model = buildSharedProcurementReadModel({
    sourceRecords: emmonsRecords,
    lifecycleRows: [emmonsLifecycle],
    placeFactsMaterialization,
    generatedAt: "2026-09-14T13:10:41.533Z",
  });
  assert.equal(model.rows.length, 1);
  const [object] = model.rows;
  assert.equal(object.procurement_id, "procurement:contract:CT107120258801626");
  assert.ok(object.lifecycle);
  assert.equal(object.lifecycle.checkbook_acquisition.observed_at, "2026-09-14T13:10:41.533Z");
  assert.equal(object.lifecycle.checkbook_acquisition.payment_as_of, "2026-08-06");
  assert.ok(hasExactContractPaymentEvidence(object.lifecycle));
  const evidence = paymentEvidenceFromLifecycle(object.lifecycle);
  assert.equal(evidence.total_payments, 31);
  assert.equal(evidence.total_spent, 7385672.19);
  assert.equal(evidence.latest_payment_date, "2026-08-06");
  assert.equal(evidence.latest_payment_amount, 66216.68);
  assert.equal(evidence.payment_rows.length, 12);
  assert.equal(evidence.payment_rows_capped, true);
  const dual = evidence.payment_rows.filter((row) => row.document_id === "20270016167-1-DSB-EFT");
  assert.equal(dual.length, 2);
  assert.deepEqual(dual.map((row) => row.amount).sort((a, b) => a - b), [54214.14, 66591.17]);
  const displayedSum = evidence.payment_rows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  assert.notEqual(displayedSum, evidence.total_spent);
  assert.ok(Array.isArray(object.place_facts));
  assert.equal(object.place_facts.length, 1);
  assert.equal(object.place_facts[0].address, "3218 Emmons Avenue, Brooklyn");
  assert.equal(object.place_facts[0].units, 60);
  assert.equal(object.place_facts[0].request_id, "20240829105");
});

test("accepted City Record notice hrefs reverse into the shared subject lookup", async () => {
  const { buildNoticeProcurementSubjectsLookup } = await import("../site/notice_subject_projection.mjs");
  const model = buildSharedProcurementReadModel({
    sourceRecords: records,
    lifecycleRows: [lifecycle],
    generatedAt: "2026-08-18T20:00:00Z",
  });
  assert.ok(model.rows[0].compatibility.city_record_notice_hrefs.includes("/notices/20260623008"));
  const lookup = buildNoticeProcurementSubjectsLookup(model.rows, {
    generatedAt: model.generated_at,
  });
  assert.equal(lookup.by_notice["20260623008"]?.[0]?.procurement_id, model.rows[0].procurement_id);
  assert.equal(
    lookup.by_notice["20260623008"]?.[0]?.href,
    model.rows[0].compatibility.canonical_href,
  );
});
