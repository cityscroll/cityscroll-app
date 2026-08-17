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
    /(?:answer|synthesis|action|legal_conclusion|graph_edge|relationship)/i,
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
