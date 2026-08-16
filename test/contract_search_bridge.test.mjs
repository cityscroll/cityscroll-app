import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  contractSearchDocumentToMoneyRow,
  mergeContractSearchRows,
} from "../site/contract_search_bridge.mjs";

function cityRecordDocument(pin, requestId, title) {
  return {
    schema: "cityscroll.search_document.v1",
    object_ref: `procurement:${pin}`,
    object_type: "procurement",
    domain: "contracts",
    canonical_href: `/browse/contracts/?mode=award&q=${pin}`,
    title,
    summary: `Public comment notice for contract ${pin}.`,
    search_text: `${title} ${pin}`,
    source_family: "city_record_notice",
    source_observation_refs: [`notice:${requestId}`],
    process_role: "award",
    classification: { method: "canonical_procurement_projection", basis: "stable identifier" },
    provenance: { producer: "city_record_search_document.v1" },
    outcome: "indexed",
    coverage_state: "matched",
  };
}

test("current D1 contract SearchDocuments recover Browse award rows for regressed PINs", () => {
  const documents = [
    cityRecordDocument(
      "05626S0012",
      "20260807032",
      "Fixed Wing aircraft program management support services.",
    ),
    cityRecordDocument(
      "05626W0023001",
      "20260731016",
      "Fire Alarm Maintenance and Repair for the boroughs of Manhattan & Bronx",
    ),
  ];
  const rows = documents.map(contractSearchDocumentToMoneyRow);
  assert.deepEqual(rows.map((row) => row.pin), ["05626S0012", "05626W0023001"]);
  assert.deepEqual(rows.map((row) => row.request_id), ["20260807032", "20260731016"]);
  assert.ok(rows.every((row) => row.type_of_notice_description === "Award"));

  const merged = mergeContractSearchRows([
    { request_id: "old", pin: "OLD-1", type_of_notice_description: "Award" },
  ], documents);
  assert.deepEqual(merged.map((row) => row.request_id), ["old", "20260807032", "20260731016"]);
});

test("the Browse bridge rejects evidence-only notices and inconsistent contract identity", () => {
  const valid = cityRecordDocument("05626S0012", "20260807032", "Fixed Wing aircraft support");
  assert.equal(contractSearchDocumentToMoneyRow({ ...valid, outcome: "evidence_only" }), null);
  assert.equal(contractSearchDocumentToMoneyRow({ ...valid, domain: null }), null);
  assert.equal(contractSearchDocumentToMoneyRow({
    ...valid,
    provenance: {
      browse_record: { request_id: "20260807032", pin: "OTHER" },
      producer: "fixture",
    },
  }), null);
});

test("the Contracts award query path augments the bounded resident snapshot from universal search", () => {
  const source = readFileSync(new URL("../site/app/money-list.mjs", import.meta.url), "utf8");
  assert.match(source, /workerFetch\(`\/search\?q=\$\{encodeURIComponent\(key\)\}`/);
  assert.match(source, /kw&&\(mode==="award"\|\|mode==="archive"\)/);
  assert.match(source, /mergeContractSearchRows\(retainedRows,searchDocuments\)/);
});
