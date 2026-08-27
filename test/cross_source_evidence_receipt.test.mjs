import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCrossSourceEvidenceReceipt,
  renderCrossSourceEvidenceReceipt,
} from "../site/cross_source_evidence_receipt.mjs";
import { renderProcurementDocument } from "../site/procurement_document.mjs";
import { buildSharedProcurementReadModel } from "../site/shared_procurement_read_model.mjs";

function observation(sourceSystem, sourceSystemId, snapshot, ingestedAt = "2026-08-20T12:00:00Z") {
  return {
    source_system: sourceSystem,
    source_system_id: sourceSystemId,
    source_observation_ref: `${sourceSystem}:${sourceSystemId}`,
    ingested_at: ingestedAt,
    snapshot,
  };
}

const passport = observation("passport_public_contracts", "contract:EPIN-1:CTR-1", {
  contract_id: "CT-1",
  epin: "EPIN-1",
  title: "Bridge inspection",
  vendor: "HNTB Corporation",
  current_amount: 100000,
  start_date: "2026-07-20T00:00:00Z",
});
const checkbook = observation("checkbook_contracts", "registered:CT-1", {
  id: "CT-1",
  pin: "EPIN-1",
  title: "Bridge inspection",
  vendor: "HNTB Corporation",
  current: 102500,
  registered: "2026-07-20",
});
const exactJoin = {
  status: "accepted",
  basis: "exact_contract_id",
  matched_value: "CT1",
  procurement_id: "procurement:contract:CT1",
  left_source_observation_ref: passport.source_observation_ref,
  right_source_observation_ref: checkbook.source_observation_ref,
};

test("exact procurement joins produce a source-named receipt with per-fact provenance", () => {
  const receipt = buildCrossSourceEvidenceReceipt({
    object: { procurement_id: "procurement:contract:CT1" },
    observations: [passport, checkbook],
    acceptedJoins: [exactJoin],
    sourceStatus: {
      passport_public_contracts: { status: "available" },
      checkbook_contracts: { status: "partial" },
    },
    generatedAt: "2026-08-21T00:00:00Z",
  });

  assert.equal(receipt.schema, "cityscroll.cross_source_evidence_receipt.v1");
  assert.equal(receipt.status, "disagreement");
  assert.deepEqual(receipt.sources.map((source) => source.source_name), [
    "PASSPort Public contracts",
    "Checkbook NYC",
  ]);
  assert.equal(receipt.sources[1].coverage, "partial");
  assert.equal(receipt.sources[0].source_native_id, "contract:EPIN-1:CTR-1");
  assert.equal(receipt.joins[0].basis_label, "Exact contract ID");

  const amount = receipt.facts.find((fact) => fact.key === "amount");
  assert.equal(amount.status, "disagrees");
  assert.deepEqual(amount.assertions.map((assertion) => assertion.assertion), ["$100,000", "$102,500"]);
  assert.ok(amount.assertions.every((assertion) => assertion.provenance.source_record_id));
  assert.ok(amount.assertions.every((assertion) => assertion.provenance.as_of === "2026-08-20T12:00:00Z"));
  assert.match(renderCrossSourceEvidenceReceipt(receipt), /Each publisher's value is shown as reported/);
  assert.match(renderCrossSourceEvidenceReceipt(receipt), /publisher field: current_amount/);
});

test("OCP exact request-id joins retain both source assertions without collapsing disagreements", () => {
  const city = observation("city_record", "20260720001", {
    request_id: "20260720001",
    contract_amount: 999999,
    start_date: "2026-07-15",
  });
  const ocp = observation("ocp-recent-awards", "award:20260720001", {
    request_id: "20260720001",
    contract_amount: 250000,
    start_date: "2026-07-30",
  });
  const receipt = buildCrossSourceEvidenceReceipt({
    object: { subject_ref: "notice:20260720001" },
    observations: [city, ocp],
    acceptedJoins: [{
      status: "matched",
      join_key: "request_id",
      left_source_observation_ref: city.source_observation_ref,
      right_source_observation_ref: ocp.source_observation_ref,
    }],
  });

  assert.equal(receipt.status, "disagreement");
  assert.equal(receipt.sources.find((source) => source.source_system === "ocp-recent-awards").source_name, "Recent Contract Awards (OCP)");
  assert.equal(receipt.facts.find((fact) => fact.key === "amount").status, "disagrees");
  assert.deepEqual(receipt.facts.find((fact) => fact.key === "date").assertions.map((assertion) => assertion.assertion), [
    "2026-07-15", "2026-07-30",
  ]);
});

test("fuzzy, rejected, ambiguous, and unknown observations never get the same-record receipt", () => {
  const cases = [
    { status: "accepted", basis: "vendor_amount_date" },
    { status: "needs_review", basis: "exact_contract_id" },
    { status: "ambiguous", basis: "exact_request_id" },
    { status: "unknown", basis: "exact_request_id" },
  ];
  for (const state of cases) {
    assert.equal(buildCrossSourceEvidenceReceipt({
      object: { procurement_id: "procurement:contract:CT1" },
      observations: [passport, checkbook],
      acceptedJoins: [{ ...exactJoin, ...state }],
    }), null, `${state.status}/${state.basis} must stay out of the receipt`);
  }
});

test("the shared procurement model materializes and serves the receipt on the canonical page", () => {
  const records = [
    { ...passport, normalized_snapshot: JSON.stringify(passport.snapshot), raw_snapshot: JSON.stringify(passport.snapshot) },
    { ...checkbook, normalized_snapshot: JSON.stringify(checkbook.snapshot), raw_snapshot: JSON.stringify(checkbook.snapshot) },
  ];
  const model = buildSharedProcurementReadModel({
    sourceRecords: records,
    generatedAt: "2026-08-21T00:00:00Z",
  });
  const object = model.rows[0];
  assert.ok(object.cross_source_evidence_receipt);
  const html = renderProcurementDocument(object, model.observations);
  assert.match(html, /data-cross-source-evidence-receipt="1"/);
  assert.match(html, /Also recorded in PASSPort Public contracts and Checkbook NYC/);
  assert.match(html, /Sources disagree/);
});
