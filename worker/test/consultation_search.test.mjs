import assert from "node:assert/strict";
import { test } from "node:test";
import { buildConsultationSearchDocuments } from "../../site/consultation_search_producer.mjs";
import { workerFederatedSearch } from "../src/search.mjs";

function consultationDb() {
  const documents = buildConsultationSearchDocuments().documents;
  return { prepare(sql) {
    let args = [];
    const statement = { bind(...values) { args = values; return statement; }, async first() {
      if (sql.includes("keyword_search_families")) return args[0] === "consultations"
        ? { source: "Retained organizer-linked public consultation rounds", as_of: "2026-09-14T00:00:00.000Z", source_row_count: 4, indexed_count: 4, coverage_json: "[]" } : null;
      return null;
    }, async all() {
      if (sql.includes("keyword_search_fts") && args[0] === "consultations") return { results: documents.map((document) => ({ document_json: JSON.stringify(document) })) };
      return { results: [] };
    } };
    return statement;
  } };
}

test("production-shaped Worker federation serves consultation results from D1", async () => {
  const result = await workerFederatedSearch({ DB: consultationDb() }).execute({ query: "bike parking", limit: 10 });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].object_ref, "consultation:dot-secure-bike-parking");
  assert.equal(result.coverage.by_lens.consultations.state, "matched");
  assert.equal(result.results[0].canonical_href, "/consultations/dot-secure-bike-parking/");
});
