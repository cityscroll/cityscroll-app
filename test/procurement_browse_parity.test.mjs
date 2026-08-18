import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  contractSearchDocumentToMoneyRow,
  mergeContractSearchRows,
} from "../site/contract_search_bridge.mjs";
import { buildProcurementSearchDocuments } from "../site/procurement_search_producer.mjs";
import { filterMoneySnapshot } from "../site/resident_snapshot_queries.mjs";
import { buildSharedProcurementReadModel } from "../site/shared_procurement_read_model.mjs";

const cohort = JSON.parse(readFileSync(
  new URL("./fixtures/procurement_search/golden_cohort.json", import.meta.url),
  "utf8",
));
const corpus = buildProcurementSearchDocuments(buildSharedProcurementReadModel({
  sourceRecords: cohort.source_records,
  generatedAt: cohort.generated_at,
}));

test("Browse bridge emits source-independent rows and does not manufacture Award shape", () => {
  const negativeDocument = corpus.documents.find((document) => (
    document.object_ref === "procurement:contract:CT101520271400806"
  ));
  const row = contractSearchDocumentToMoneyRow(negativeDocument);
  assert.equal(row.procurement_id, negativeDocument.object_ref);
  assert.equal(row.canonical_href, negativeDocument.canonical_href);
  assert.deepEqual(row.procurement_stages, ["registered"]);
  assert.equal(row.primary_stage, "registered");
  assert.equal(Object.hasOwn(row, "request_id"), false);
  assert.equal(Object.hasOwn(row, "type_of_notice_description"), false);
});

test("Browse merge deduplicates canonical identity while retaining CROL notice evidence", () => {
  const rows = mergeContractSearchRows([], [corpus.documents[0], ...corpus.documents]);
  assert.equal(rows.length, 2);
  const positive = rows.find((row) => row.procurement_id === "procurement:contract:CT1841260001");
  assert.equal(positive.request_id, "20260623008");
  assert.match(positive.notice_evidence[0].additional_description_1, /retained/);
});

test("Browse filters canonical rows by typed stage", () => {
  const rows = mergeContractSearchRows([], corpus.documents);
  assert.deepEqual(
    filterMoneySnapshot(rows, { mode: "award", stages: ["registered"], limit: 20 })
      .map((row) => row.procurement_id).sort(),
    ["procurement:contract:CT101520271400806", "procurement:contract:CT1841260001"],
  );
  assert.deepEqual(filterMoneySnapshot(rows, {
    mode: "award",
    stages: ["solicitation"],
    limit: 20,
  }), []);
});
