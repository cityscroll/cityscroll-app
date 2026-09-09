import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CITED_RETRIEVAL_RESPONSE_SCHEMA,
  projectCitedRetrievalResponse,
  retrieveCitedPassages,
} from "../src/cited_retrieval.mjs";
import { retrieveTypedCandidates } from "../src/semantic_candidates.mjs";

test("cited retrieval returns typed, versioned passages with exact manifest joins", () => {
  const response = retrieveCitedPassages({
    query: "energy conservation",
    filters: { source_family: "city_record_notice" },
    limit: 5,
  });

  assert.equal(response.schema, CITED_RETRIEVAL_RESPONSE_SCHEMA);
  assert.equal(response.contract_version, 1);
  assert.equal(response.query, "energy conservation");
  assert.equal(response.retrieval.method, "lexical_fallback_v1");
  assert.equal(response.retrieval.corpus.schema, "cityscroll.semantic_retrieval.corpus_manifest.v1");
  assert.match(response.retrieval.corpus.manifest_sha256, /^[a-f0-9]{64}$/);
  assert.equal(response.retrieval.index.schema, "cityscroll.semantic_retrieval.source_passage_map.v1");
  assert.match(response.retrieval.index.version, /^[a-f0-9]{64}$/);
  assert.equal(response.coverage.state, "partial");

  const citation = response.citations.find(({ source }) => (
    source.id === "city_record_notice:20260715041"
  ));
  assert.ok(citation);
  assert.deepEqual(citation.source, {
    id: "city_record_notice:20260715041",
    family: "city_record_notice",
    native_id: "20260715041",
    url: "https://a856-cityrecord.nyc.gov/RequestDetail/20260715041",
    canonical_href: "/notices/20260715041",
    title: "Amendments to Rules Relating to the Energy Conservation Code",
  });
  assert.equal(citation.passage.id, "city_record_notice:20260715041:p0001");
  assert.equal(citation.passage.boundary.unit, "utf16_code_unit");
  assert.equal(citation.passage.boundary.start, 0);
  assert.equal(citation.passage.text.length, citation.passage.boundary.end);
  assert.equal(citation.coverage_state, "partial");
  assert.equal(citation.freshness.state, "observed");
  assert.deepEqual(citation.exact_join_evidence, {
    state: "matched",
    method: "candidate_source_passage_manifest_exact_id_v1",
    candidate_id: "city_record_notice:20260715041:p0001",
    source_record_id: "city_record_notice:20260715041",
    passage_id: "city_record_notice:20260715041:p0001",
  });

  assert.doesNotMatch(
    JSON.stringify(response),
    /"(?:answer|synthesis|action|legal_conclusion|graph_edge|relationship)"\s*:/i,
  );
});

test("missing exact-join evidence is explicit unknown, never inferred", () => {
  const candidates = retrieveTypedCandidates({
    query: "energy conservation",
    filters: { source_family: "city_record_notice" },
    limit: 1,
  });
  const response = projectCitedRetrievalResponse(candidates, {
    passageMap: {
      schema: candidates.index.schema,
      map_sha256: candidates.index.version,
      by_candidate_id: {},
      sources: [],
      passages: [],
    },
  });

  assert.equal(response.citations.length, 1);
  assert.deepEqual(response.citations[0].exact_join_evidence, {
    state: "unknown",
    method: null,
    candidate_id: response.citations[0].citation_id,
    source_record_id: null,
    passage_id: null,
  });
});

test("artifact-version drift cannot produce matched citation evidence", () => {
  const candidates = retrieveTypedCandidates({
    query: "energy conservation",
    filters: { source_family: "city_record_notice" },
    limit: 1,
  });
  candidates.index.version = "0".repeat(64);
  const response = projectCitedRetrievalResponse(candidates);

  assert.equal(response.citations.length, 1);
  assert.equal(response.citations[0].exact_join_evidence.state, "unknown");
  assert.equal(response.citations[0].exact_join_evidence.method, null);
});

test("empty and nonempty retrieval preserve each retained family's date and coverage bounds", () => {
  for (const query of ["energy conservation", "unmatchedxylophonezz"]) {
    const candidates = retrieveTypedCandidates({ query });
    const response = projectCitedRetrievalResponse(candidates);
    const corpus = response.hard_scope.corpus;
    assert.deepEqual(corpus, candidates.hard_scope.corpus);
    assert.equal(corpus.observed_on, "2026-08-04");
    assert.notEqual(corpus.observed_on, "2024-08-04");
    assert.equal(corpus.coverage.state, "partial");
    assert.equal(corpus.record_count, 122);
    assert.equal(corpus.passage_count, 238);
    assert.deepEqual(corpus.source_families.map((family) => family.source_family), ["attachment_text", "city_record_notice", "community_board_minutes"]);
    assert.equal(corpus.source_families.reduce((sum, family) => sum + family.record_count, 0), corpus.record_count);
    for (const family of corpus.source_families) {
      assert.equal(family.observed_on, corpus.observed_on);
      assert.equal(family.coverage.state, "partial");
      assert.ok(family.coverage.boundary);
      assert.ok(family.source_published_at_min <= family.source_published_at_max);
    }
    if (query === "unmatchedxylophonezz") assert.deepEqual(response.citations, []);
    else assert.ok(response.citations.length > 0);
  }
});
