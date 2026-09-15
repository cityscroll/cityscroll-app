import assert from "node:assert/strict";
import { test } from "node:test";
import { admitSearchDocument, SEARCH_DOCUMENT_DOMAINS, SEARCH_DOCUMENT_OBJECT_TYPES } from "../site/search_document_contract.mjs";
import { buildConsultationSearchDocuments } from "../site/consultation_search_producer.mjs";
import { buildSearchRenderPlan } from "../site/search_render_plan.mjs";
import { buildSearchLensHandoffHref, searchFamilyForResult } from "../site/search_lens_handoff.mjs";
import { CONSULTATION_VARIANT_FIXTURE } from "./fixtures/consultation_search_dedup.mjs";

test("consultation rounds are admitted as a complete canonical search family", () => {
  assert.ok(SEARCH_DOCUMENT_OBJECT_TYPES.includes("consultation"));
  assert.ok(SEARCH_DOCUMENT_DOMAINS.includes("participation"));
  const corpus = buildConsultationSearchDocuments();
  assert.equal(corpus.coverage.state, "matched");
  assert.deepEqual(corpus.documents.map((row) => row.title), [
    "Fast Buses: Central Brooklyn", "Secure Bike Parking",
    "Brooklyn CB14 district needs, FY2028", "Bloomingdale Library and Housing",
  ]);
  assert.ok(corpus.documents.every((row) => admitSearchDocument(row).document));
  assert.ok(corpus.documents.every((row) => searchFamilyForResult(row) === "consultations"));
});

test("rendering, safe handoff, archive status, and failed retrieval stay explicit", () => {
  const corpus = buildConsultationSearchDocuments();
  const keyword = { match_mode: "keyword", results: corpus.documents.map((document) => ({ ...document, entity_type: document.object_type })) };
  const plan = buildSearchRenderPlan({ state: "legacy", payload: keyword, coverage: { lanes: [{ id: "consultations", status: "matched" }] } });
  assert.equal(plan.families.find((family) => family.id === "consultations").items.length, 4);
  const archived = corpus.documents.find((row) => row.title.includes("FY2028"));
  assert.equal(archived.provenance.lifecycle.state, "closed");
  assert.match(buildSearchLensHandoffHref(archived, { query: "budget", resolved_term: { canonical_tokens: ["budget"] } }, "/search/?q=budget"), /^\/consultations\/\?.*q=budget/);
  const failed = buildSearchRenderPlan({ state: "combined", keyword: null, semantic: { groups: [] }, keywordCoverage: { lanes: [{ id: "consultations", status: "unknown" }] } });
  assert.ok(failed.incomplete_families.includes("consultations"));
});

test("one canonical result survives map, shortlink, and language variants", () => {
  const corpus = buildConsultationSearchDocuments(CONSULTATION_VARIANT_FIXTURE);
  assert.deepEqual(corpus.documents.map((row) => row.object_ref), ["consultation:bloomingdale-library-and-housing"]);
  assert.equal(corpus.coverage.indexed_count, 1);
  assert.equal(new Set(corpus.documents.map((row) => row.object_ref)).size, corpus.documents.length);
});
