import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCrossSourceEvidenceIndex,
  buildCrossSourceEvidenceReceipt,
} from "../site/cross_source_evidence_receipt.mjs";
import {
  passportIdentityFromObject,
  prepareCheckbookLookupIndex,
  preparePassportRecordIndex,
  queryCheckbookRowsForPassport,
} from "../site/checkbook_passport_corroboration.mjs";
import {
  procurementObservationIndex,
  procurementProcessEvents,
} from "../site/procurement_process_events.mjs";
import {
  buildProcurementSearchDocuments,
  materializeProcurementSearchDocument,
} from "../site/procurement_search_producer.mjs";
import { buildSharedProcurementReadModel } from "../site/shared_procurement_read_model.mjs";
import { pinKeysShareFamily, pinsShareFamily } from "../site/pin_sibling_grouping.mjs";

const GENERATED_AT = "2026-09-01T00:00:00Z";

function passportRecord(index) {
  const epin = `EPIN${String(index).padStart(6, "0")}`;
  const snapshot = {
    contract_id: `CT-${index}`,
    epin,
    epin_norm: epin,
    title: `Contract ${index}`,
    vendor: `Vendor ${index % 7}`,
    agency: `Agency ${index % 5}`,
    current_amount: 1000 + index,
    start_date: "2026-07-20",
    status: "Registered",
  };
  return {
    source_system: "passport_public_contracts",
    source_system_id: `contract:${epin}:CTR-${index}`,
    content_hash: `materialized:${index}`,
    normalized_snapshot: JSON.stringify(snapshot),
    raw_snapshot: JSON.stringify(snapshot),
    ingested_at: GENERATED_AT,
  };
}

function checkbookRecord(index) {
  const snapshot = {
    id: `CT-${index}`,
    contract_id: `CT-${index}`,
    pin: `EPIN${String(index).padStart(6, "0")}`,
    vendor: `Vendor ${index % 7}`,
    agency: `Agency ${index % 5}`,
    current: 1000 + index,
    registered: "2026-07-20",
    status: "Registered",
    selection_bucket: "new_unique",
  };
  return {
    source_system: "checkbook_contracts",
    source_system_id: `contract:registered:CT-${index}:VENDOR:prime-vendor:2026-07-20`,
    content_hash: `materialized:cb-${index}`,
    normalized_snapshot: JSON.stringify(snapshot),
    raw_snapshot: JSON.stringify(snapshot),
    ingested_at: GENERATED_AT,
  };
}

function lookupRow(index) {
  return {
    contract_id: `CT-${index}`,
    pin: `EPIN${String(index).padStart(6, "0")}`,
    prime_vendor: `Vendor ${index % 7}`,
    agency: `Agency ${index % 5}`,
    current: 1000 + index,
    registered: "2026-07-20",
    status: "Registered",
    vendorRecordType: "Prime",
  };
}

function corpus({ passportCount = 12, checkbookCount = 5 } = {}) {
  const sourceRecords = [];
  for (let index = 0; index < passportCount; index += 1) sourceRecords.push(passportRecord(index));
  for (let index = 0; index < checkbookCount; index += 1) sourceRecords.push(checkbookRecord(index));
  const checkbookLookupRows = [];
  for (let index = 0; index < passportCount; index += 1) checkbookLookupRows.push(lookupRow(index));
  return { sourceRecords, checkbookLookupRows };
}

test("the shared evidence index produces the receipts a per-object index produces", () => {
  const { sourceRecords, checkbookLookupRows } = corpus();
  const model = buildSharedProcurementReadModel({
    sourceRecords,
    checkbookLookupRows,
    generatedAt: GENERATED_AT,
    now: GENERATED_AT,
  });
  assert.ok(model.rows.length >= 12);
  assert.ok(model.rows.some((row) => row.cross_source_evidence_receipt));

  for (const row of model.rows) {
    // A freshly built index per object is the un-shared reference: if the shared
    // index carried state between objects, these would diverge.
    const perObject = buildCrossSourceEvidenceReceipt({
      object: row,
      observations: model.observations,
      acceptedJoins: model.cross_source_identity_joins,
      generatedAt: GENERATED_AT,
      corroboration: row.checkbook_corroboration || null,
      checkbookLookupRows,
      index: buildCrossSourceEvidenceIndex({
        observations: model.observations,
        acceptedJoins: model.cross_source_identity_joins,
        checkbookLookupRows,
      }),
    });
    assert.deepEqual(row.cross_source_evidence_receipt ?? null, perObject ?? null);
  }
});

test("an explicit evidence index matches the index the receipt builds for itself", () => {
  const { sourceRecords, checkbookLookupRows } = corpus();
  const model = buildSharedProcurementReadModel({
    sourceRecords,
    checkbookLookupRows,
    generatedAt: GENERATED_AT,
    now: GENERATED_AT,
  });
  const index = buildCrossSourceEvidenceIndex({
    observations: model.observations,
    acceptedJoins: model.cross_source_identity_joins,
    checkbookLookupRows,
  });
  for (const row of model.rows) {
    const args = {
      object: row,
      observations: model.observations,
      acceptedJoins: model.cross_source_identity_joins,
      generatedAt: GENERATED_AT,
      checkbookLookupRows,
    };
    assert.deepEqual(
      buildCrossSourceEvidenceReceipt({ ...args, index }) ?? null,
      buildCrossSourceEvidenceReceipt(args) ?? null,
    );
  }
});

test("the prepared Checkbook lookup index selects the rows the direct query selects", () => {
  const rows = [];
  for (let index = 0; index < 40; index += 1) rows.push(lookupRow(index));
  rows.push({ ...lookupRow(3), contract_id: "CT-3A", pin: "EPIN000003A100" });
  const index = prepareCheckbookLookupIndex(rows);
  const identities = [
    { contract_id: "CT-3", epin: "EPIN000003" },
    { contract_id: "CT-39", epin: "EPIN000039" },
    { contract_id: null, epin: "EPIN000003" },
    { contract_id: "CT-3", epin: null },
    { contract_id: "MISSING", epin: "NOTHINGHERE" },
    {},
  ];
  for (const identity of identities) {
    assert.deepEqual(
      queryCheckbookRowsForPassport(identity, rows, index),
      queryCheckbookRowsForPassport(identity, rows),
      `mismatch for ${JSON.stringify(identity)}`,
    );
  }
});

test("the prepared PASSPort record index resolves the identity the linear scan resolves", () => {
  const { sourceRecords, checkbookLookupRows } = corpus();
  const model = buildSharedProcurementReadModel({
    sourceRecords,
    checkbookLookupRows,
    generatedAt: GENERATED_AT,
    now: GENERATED_AT,
  });
  const index = preparePassportRecordIndex(sourceRecords);
  for (const row of model.rows) {
    assert.deepEqual(
      passportIdentityFromObject(row, sourceRecords, index),
      passportIdentityFromObject(row, sourceRecords),
    );
  }
});

test("the shared observation index yields the same process events as a per-object scan", () => {
  const { sourceRecords, checkbookLookupRows } = corpus();
  const model = buildSharedProcurementReadModel({
    sourceRecords,
    checkbookLookupRows,
    generatedAt: GENERATED_AT,
    now: GENERATED_AT,
  });
  const index = procurementObservationIndex(model.observations);
  for (const row of model.rows) {
    assert.deepEqual(
      procurementProcessEvents(row, model.observations, index),
      procurementProcessEvents(row, model.observations),
    );
  }
});

test("the shared search-document index yields the same documents as a per-object index", () => {
  const { sourceRecords, checkbookLookupRows } = corpus();
  const model = buildSharedProcurementReadModel({
    sourceRecords,
    checkbookLookupRows,
    generatedAt: GENERATED_AT,
    now: GENERATED_AT,
  });
  const corpusDocuments = buildProcurementSearchDocuments(model);
  assert.ok(corpusDocuments.documents.length >= 12);
  const byRef = new Map(corpusDocuments.documents.map((document) => [document.object_ref, document]));
  for (const row of model.rows) {
    const direct = materializeProcurementSearchDocument(row, model);
    assert.deepEqual(byRef.get(row.procurement_id) ?? null, direct ?? null);
  }
});

test("the normalized PIN-family predicate agrees with the string predicate", () => {
  const pairs = [
    ["EPIN000003", "EPIN000003"],
    ["EPIN000003", "EPIN000003A100"],
    ["ep in-000003", "EPIN000003"],
    ["EPIN000003A100", "EPIN000004A100"],
    ["SHORT", "SHORT"],
    ["", "EPIN000003"],
    [null, undefined],
  ];
  for (const [left, right] of pairs) {
    const normalize = (value) => String(value ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    assert.equal(
      pinKeysShareFamily(normalize(left), normalize(right)),
      pinsShareFamily(left, right),
      `mismatch for ${JSON.stringify([left, right])}`,
    );
  }
});
