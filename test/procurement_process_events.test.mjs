import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizePassportRfxState,
  procurementProcessEvents,
  renderProcurementProcessEvents,
} from "../site/procurement_process_events.mjs";
import { procurementSourceRecordsFromMaterializations } from "../tools/build_shared_procurement_read_model.mjs";
import { buildSharedProcurementReadModel } from "../site/shared_procurement_read_model.mjs";
import { renderProcurementDocument } from "../site/procurement_document.mjs";

function sourceRecord(sourceSystem, sourceSystemId, snapshot, contentHash = `hash:${sourceSystemId}`) {
  return {
    source_system: sourceSystem,
    source_system_id: sourceSystemId,
    content_hash: contentHash,
    normalized_snapshot: JSON.stringify(snapshot),
    raw_snapshot: JSON.stringify(snapshot),
    ingested_at: "2026-08-18T19:46:32Z",
  };
}

function rfx(status, epin, rfpId, dueDate = "2026-09-18") {
  return sourceRecord("passport_public_rfx", `rfx:${epin}:${rfpId}`, {
    rfp_id: rfpId,
    epin,
    procurement_name: "Bridge inspection",
    agency: "Department of Transportation",
    rfx_status: status,
    release_date: "2026-08-01",
    due_date: dueDate,
  });
}

test("shared materialization carries PASSPort RFx observations with a receipt", () => {
  const records = procurementSourceRecordsFromMaterializations({
    generated_at: "2026-08-18T20:00:00Z",
    receipts: { passport_join: "site/data/passport_sources/verification_receipts/passport_public_2026-07-30.json" },
    rows: { passport_rfx: [{
      rfp_id: "1001",
      epin: "84126M0001001",
      rfx_status: "Released",
      release_date: "08/01/2026",
      due_date: "09/18/2026",
    }] },
  }, { rows: [] });
  const record = records.find((entry) => entry.source_system === "passport_public_rfx");
  assert.equal(record.source_system_id, "rfx:84126M0001001:1001");
  assert.equal(record.source_receipt_ref, "site/data/passport_sources/verification_receipts/passport_public_2026-07-30.json");
});

test("Released and Responses Received become explicit process events while legacy solicitation remains", () => {
  const model = buildSharedProcurementReadModel({
    sourceRecords: [rfx("Released", "EPIN-OPEN", "1001"), rfx("Responses Received", "EPIN-EVAL", "1002")],
    generatedAt: "2026-08-18T20:00:00Z",
    now: "2099-01-01T00:00:00Z",
  });
  assert.equal(model.rows.length, 2);
  const open = model.rows.find((row) => row.identity_keys.epins.includes("EPINOPEN"));
  const evaluation = model.rows.find((row) => row.identity_keys.epins.includes("EPINEVAL"));
  assert.deepEqual(open.stages.map((stage) => stage.stage), ["solicitation"]);
  assert.deepEqual(evaluation.stages.map((stage) => stage.stage), ["solicitation"]);
  assert.deepEqual(open.process_events.map(({ state, state_basis, publisher_state, deadline }) => ({
    state, state_basis, publisher_state, deadline,
  })), [{ state: "open", state_basis: "explicit", publisher_state: "Released", deadline: "2026-09-18" }]);
  assert.deepEqual(evaluation.process_events.map(({ state, state_basis, publisher_state, deadline }) => ({
    state, state_basis, publisher_state, deadline,
  })), [{ state: "evaluation", state_basis: "explicit", publisher_state: "Responses Received", deadline: "2026-09-18" }]);
  assert.match(renderProcurementProcessEvents(open.process_events), />Open<\/strong> · Observed 2026-08-01 · Due 2026-09-18/);
  assert.match(renderProcurementProcessEvents(evaluation.process_events), /Evaluation · responses no longer accepted/);
});

test("deadline expiry never changes the publisher-backed state", () => {
  const model = buildSharedProcurementReadModel({
    sourceRecords: [rfx("Released", "EPIN-EXPIRED", "1003", "2020-01-01")],
    generatedAt: "2099-01-01T00:00:00Z",
    now: "2099-01-01T00:00:00Z",
  });
  assert.equal(model.rows[0].process_events[0].state, "open");
  assert.equal(model.rows[0].process_events[0].deadline, "2020-01-01");
});

test("unknown and absent statuses fail closed", () => {
  assert.deepEqual(normalizePassportRfxState("Publisher changed this"), {
    state: "unknown",
    publisher_state: "Publisher changed this",
    state_basis: "explicit",
  });
  assert.equal(normalizePassportRfxState(" ").state, "unknown");
  const model = buildSharedProcurementReadModel({
    sourceRecords: [rfx("Publisher changed this", "EPIN-UNKNOWN", "1004"), rfx(null, "EPIN-ABSENT", "1005")],
    generatedAt: "2026-08-18T20:00:00Z",
  });
  assert.deepEqual(model.rows.map((row) => row.process_events[0].state), ["unknown", "unknown"]);
  assert.equal(model.rows.find((row) => row.identity_keys.epins.includes("EPINABSENT"))
    .process_events[0].state_basis, "deterministic_projection");
});

test("Selections Made never copies an RFx vendor, but accepts one distinct public observation", () => {
  const selection = rfx("Selections Made", "EPIN-SELECTION", "1006");
  const withoutVendor = buildSharedProcurementReadModel({
    sourceRecords: [sourceRecord("passport_public_rfx", selection.source_system_id, {
      ...JSON.parse(selection.normalized_snapshot),
      vendor: "Vendor from RFx (not independently observed)",
    })],
    generatedAt: "2026-08-18T20:00:00Z",
  });
  assert.equal(Object.hasOwn(withoutVendor.rows[0].process_events[0], "vendor_ref"), false);
  assert.doesNotMatch(renderProcurementDocument(withoutVendor.rows[0], withoutVendor.observations), /Vendor from RFx/);

  const withVendor = buildSharedProcurementReadModel({
    sourceRecords: [selection, sourceRecord("passport_public_contracts", "contract:EPIN-SELECTION:CTR-1", {
      epin: "EPIN-SELECTION",
      ctr_id: "CTR-1",
      contract_id: "CT-1",
      vendor: "Public Vendor",
      status: "Pending",
    })],
    generatedAt: "2026-08-18T20:00:00Z",
  });
  assert.equal(withVendor.rows[0].process_events[0].vendor_ref, "Public Vendor");
});
