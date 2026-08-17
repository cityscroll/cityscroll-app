import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  SEMANTIC_CANDIDATE_METHOD,
  SEMANTIC_CANDIDATE_RESPONSE_SCHEMA,
  SEMANTIC_CIVIC_OBJECT_FAMILIES,
  normalizeSemanticCandidateResponse,
  topicCandidateTitle,
} from "../site/semantic_topic_search.mjs";

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const manifest = readJson("../warehouse/manifests/semantic_retrieval_corpus_manifest.json");
const passageMap = readJson("../warehouse/experiments/semantic-layer-trial/source_passage_map.json");

function realCandidate(sourceRecordId = "city_record_notice:20260715041") {
  const source = passageMap.sources.find((row) => row.source_record_id === sourceRecordId);
  const passage = passageMap.passages.find((row) => row.source_record_id === sourceRecordId);
  assert.ok(source && passage, `missing real source passage ${sourceRecordId}`);
  const searchableText = `${source.title || ""} ${passage.text || ""}`.toLowerCase();
  const matchedTerm = searchableText.includes("energy")
    ? "energy"
    : searchableText.match(/[a-z0-9]+/)?.[0];
  return {
    candidate_id: passage.candidate_id,
    civic_object_family: source.civic_object_family,
    source: {
      id: source.source_record_id,
      family: source.source_family,
      native_id: source.source_native_id,
      title: source.title,
      url: source.source_url,
      canonical_href: source.source_family === "city_record_notice"
        ? `/notices/${encodeURIComponent(source.source_native_id)}`
        : null,
    },
    passage: {
      id: passage.passage_id,
      text: passage.text,
      text_state: passage.text_state,
      boundary: passage.boundary,
    },
    method: SEMANTIC_CANDIDATE_METHOD,
    matched_terms: [matchedTerm],
    hard_scope_state: "matched",
    coverage_state: "partial",
    freshness: source.freshness,
  };
}

function response(candidates = [realCandidate()]) {
  return {
    schema: SEMANTIC_CANDIDATE_RESPONSE_SCHEMA,
    query: "energy conservation",
    method: SEMANTIC_CANDIDATE_METHOD,
    corpus: {
      schema: manifest.schema,
      manifest_version: manifest.manifest_version,
      manifest_sha256: manifest.manifest_sha256,
      content_sha256: manifest.corpus_sha256,
      observed_on: manifest.observed_on,
    },
    index: {
      schema: passageMap.schema,
      version: passageMap.map_sha256,
      corpus_sha256: passageMap.corpus_sha256,
      observed_on: passageMap.observed_on,
    },
    hard_scope: { state: "unscoped", filters: {} },
    coverage: { state: manifest.coverage.state, boundary: manifest.coverage.boundary },
    candidates,
  };
}

test("topic search accepts the versioned sr5 envelope and groups source-backed civic objects", () => {
  const normalized = normalizeSemanticCandidateResponse(response(), {
    expectedQuery: "energy conservation",
  });

  assert.equal(normalized.state, "typed");
  assert.equal(normalized.method, SEMANTIC_CANDIDATE_METHOD);
  assert.equal(normalized.corpus.manifest_sha256, manifest.manifest_sha256);
  assert.deepEqual(normalized.groups.map((group) => group.id), SEMANTIC_CIVIC_OBJECT_FAMILIES);
  const rules = normalized.groups.find((group) => group.id === "rules");
  assert.equal(rules.candidates.length, 1);
  assert.equal(rules.candidates[0].source.url, "https://a856-cityrecord.nyc.gov/RequestDetail/20260715041");
  assert.equal(rules.candidates[0].source.canonical_href, "/notices/20260715041");
  assert.deepEqual(rules.candidates[0].matched_terms, ["energy"]);
  assert.equal(topicCandidateTitle(rules.candidates[0]), "Amendments to Rules Relating to the Energy Conservation Code");
  assert.equal(rules.candidates[0].civic_object_family, "rules");
});

test("topic search keeps source provenance while clustering by civic object", () => {
  const candidates = [
    realCandidate("city_record_notice:20260715041"),
    realCandidate("attachment_text:20240515016%23attachment-37470"),
    realCandidate("community_board_minutes:queens-cb-08%3A2026-06-10%3Aminutes"),
  ];
  const normalized = normalizeSemanticCandidateResponse(response(candidates), {
    expectedQuery: "energy conservation",
  });
  assert.deepEqual(
    normalized.groups.filter((group) => group.candidates.length).map((group) => [
      group.id,
      group.candidates.map((candidate) => candidate.source.family),
    ]),
    [
      ["land", ["attachment_text"]],
      ["rules", ["city_record_notice"]],
      ["meetings", ["community_board_minutes"]],
    ],
  );
});

test("semantic City Record candidates stay clustered by civic object", () => {
  const rule = {
    ...realCandidate("city_record_notice:20260715041"),
    civic_object_family: "rules",
  };
  const meeting = {
    ...realCandidate("city_record_notice:20260723022"),
    civic_object_family: "meetings",
  };
  const normalized = normalizeSemanticCandidateResponse(response([rule, meeting]), {
    expectedQuery: "energy conservation",
  });

  assert.equal(normalized.state, "typed");
  assert.deepEqual(
    normalized.groups.filter((group) => group.candidates.length).map((group) => [
      group.id,
      group.candidates.map((candidate) => candidate.source.native_id),
    ]),
    [
      ["rules", ["20260715041"]],
      ["meetings", ["20260723022"]],
    ],
  );
});

test("topic search fails closed on stale, mismatched, unsafe, or scored candidate data", () => {
  const cases = [
    { ...response(), schema: "cityscroll.semantic_retrieval.candidate_response.v2" },
    { ...response(), query: "different query" },
    { ...response(), method: "semantic_passage_v1" },
    { ...response(), corpus: { ...response().corpus, manifest_version: 2 } },
    { ...response(), corpus: { ...response().corpus, manifest_sha256: "f".repeat(64) } },
    { ...response(), index: { ...response().index, schema: "unknown" } },
    { ...response(), index: { ...response().index, version: "f".repeat(64) } },
    response([{ ...realCandidate(), score: 0.99 }]),
    response([{
      ...realCandidate(),
      source: { ...realCandidate().source, url: "javascript:alert(1)" },
    }]),
    response([{
      ...realCandidate(),
      source: { ...realCandidate().source, family: "rules" },
    }]),
    response([{
      ...realCandidate(),
      civic_object_family: "not-a-civic-object",
    }]),
    response([{
      ...realCandidate(),
      source: { ...realCandidate().source, canonical_href: "/notices/not-the-source-id" },
    }]),
    response([{
      ...realCandidate(),
      matched_terms: ["not present in this source"],
    }]),
  ];

  for (const payload of cases) {
    assert.equal(
      normalizeSemanticCandidateResponse(payload, { expectedQuery: "energy conservation" }).state,
      "invalid",
    );
  }
});

test("a retained passage is required; unavailable text carries an explicit evidence limit", () => {
  const missingText = realCandidate();
  missingText.passage = { ...missingText.passage, text: null, text_state: "unknown" };
  const normalized = normalizeSemanticCandidateResponse(response([missingText]), {
    expectedQuery: "energy conservation",
  });
  const candidate = normalized.groups.find((group) => group.id === "rules").candidates[0];
  assert.equal(candidate.passage.text, null);
  assert.equal(candidate.evidence_limit, "Source passage text is unavailable for this candidate.");
});
