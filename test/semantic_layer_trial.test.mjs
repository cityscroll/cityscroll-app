import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  publicationValidationFinding,
  redactForPublication,
} from "../warehouse/experiments/semantic-layer-trial/build_corpus.mjs";
import {
  SOURCE_PASSAGE_MAP_SCHEMA,
  buildSourcePassageMap,
  resolveSourcePassageCandidate,
  validateSourcePassageMap,
} from "../warehouse/lib/source_passage_map.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TRIAL = join(ROOT, "warehouse/experiments/semantic-layer-trial");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

test("semantic trial corpus and receipts retain the fixed evaluation boundary", () => {
  const corpus = readJson(join(TRIAL, "corpus.json"));
  const retrieval = readJson(join(TRIAL, "receipts/retrieval_review.json"));
  const costs = readJson(join(TRIAL, "receipts/costs.json"));

  assert.equal(corpus.document_count, 122);
  assert.equal(retrieval.query_count, 30);
  assert.equal(retrieval.corpus.documents, 122);
  assert.equal(retrieval.corpus.chunks, 238);
  assert.equal(costs.model.id, "sentence-transformers/all-MiniLM-L6-v2");
  assert.equal(costs.model.dimensions_measured, 384);
  assert.equal(costs.build.metered_api_calls, 0);
  assert.equal(costs.build.metered_cost_usd, 0);
  assert.ok(
    corpus.documents.some((row) => row.publication_redactions?.meeting_credential > 0),
    "the fixture should retain counts for ingest-time meeting-credential redactions",
  );
  assert.ok(
    corpus.documents.every((row) => !/[?&]p[w]d=|\b(?:passcode|password|access code)\b/i.test(row.text)),
    "the committed corpus must not retain meeting credentials",
  );

  for (const query of retrieval.queries) {
    for (const results of Object.values(query.methods)) {
      for (const result of results) {
        assert.equal(result.honest_label, "retrieval_candidate");
      }
    }
  }
});

test("source-passage candidates serialize to one typed source and exact retained boundary", () => {
  const corpus = readJson(join(TRIAL, "corpus.json"));
  const serialized = readFileSync(join(TRIAL, "source_passage_map.json"), "utf8");
  const passageMap = JSON.parse(serialized);

  assert.equal(passageMap.schema, SOURCE_PASSAGE_MAP_SCHEMA);
  assert.equal(passageMap.source_count, corpus.document_count);
  assert.equal(passageMap.passage_count, 238);
  assert.equal(passageMap.unknown_passage_count, 0);
  assert.equal(validateSourcePassageMap(passageMap), passageMap);

  const candidateIds = Object.keys(passageMap.by_candidate_id);
  assert.equal(candidateIds.length, passageMap.passage_count);
  assert.equal(new Set(candidateIds).size, candidateIds.length);

  for (const candidateId of candidateIds) {
    const resolved = resolveSourcePassageCandidate(passageMap, candidateId);
    assert.equal(resolved.candidate_id, candidateId);
    assert.equal(resolved.source.source_record_id, resolved.passage.source_record_id);
    assert.equal(resolved.source.source_family, resolved.passage.source_family);
    assert.match(resolved.source.source_url, /^https:\/\//);
    assert.equal(resolved.source.coverage.state, "partial");
    assert.equal(resolved.source.freshness.state, "observed");

    const corpusRow = corpus.documents.find((row) => (
      row.id === resolved.source.source_native_id
      && row.kind === resolved.source.source_family
    ));
    assert.ok(corpusRow, `missing corpus source for ${candidateId}`);
    const { start, end, unit } = resolved.passage.boundary;
    assert.equal(unit, "utf16_code_unit");
    assert.equal(resolved.passage.text_state, "retained");
    assert.equal(resolved.passage.text, corpusRow.text.slice(start, end));
  }

  const roundTrip = JSON.parse(JSON.stringify(passageMap));
  const example = resolveSourcePassageCandidate(roundTrip, candidateIds.at(-1));
  assert.equal(example.source.source_url, passageMap.sources.at(-1).source_url);
  assert.deepEqual(example.source.freshness, passageMap.sources.at(-1).freshness);
  assert.deepEqual(example.source.coverage, passageMap.sources.at(-1).coverage);
});

test("missing source text stays unknown and cannot manufacture graph identities", () => {
  const passageMap = buildSourcePassageMap({
    schema: "cityscroll.semantic_layer_trial.corpus.v1",
    observed_on: "2026-08-04",
    selection: {},
    documents: [{
      id: "missing-text",
      kind: "city_record_notice",
      title: "Source record without retained text",
      published_at: null,
      source: {
        system: "NYC City Record",
        url: "https://a856-cityrecord.nyc.gov/RequestDetail/missing-text",
      },
    }],
  });
  const candidateId = Object.keys(passageMap.by_candidate_id)[0];
  const resolved = resolveSourcePassageCandidate(passageMap, candidateId);

  assert.equal(resolved.passage.text_state, "unknown");
  assert.equal(resolved.passage.text, null);
  assert.deepEqual(resolved.passage.boundary, {
    unit: "utf16_code_unit",
    start: null,
    end: null,
  });
  assert.equal(resolved.source.coverage.state, "unknown");
  assert.equal(resolved.source.freshness.state, "unknown");
  assert.equal(resolveSourcePassageCandidate(passageMap, "missing"), null);

  const serialized = JSON.stringify(passageMap);
  for (const forbidden of ["entity_id", "mandate_id", "subject_ref", "graph_edge", "cross_spine_edge"]) {
    assert.equal(serialized.includes(`\"${forbidden}\"`), false);
  }
});

test("corpus sanitization is idempotent and diagnostics identify the exact failure", () => {
  const raw = "meeting number (access code) 26373696969 and password retained-value";
  const first = redactForPublication(raw);
  const second = redactForPublication(first.text);

  assert.equal(second.text, first.text);
  assert.deepEqual(second.counts, {
    email: 0,
    phone: 0,
    meeting_credential: 0,
    place_name: 0,
  });
  assert.equal(publicationValidationFinding({ id: "clean", text: first.text }), null);
  assert.deepEqual(
    publicationValidationFinding({ id: "notice-1", text: "Password: example-placeholder" }),
    {
      record_id: "notice-1",
      rule: "meeting_credential_marker",
      match: "Password: example-placeholder",
    },
  );
});

test("learned retrieval does not claim uplift beyond the ranked lexical baseline", () => {
  const receipt = readJson(join(TRIAL, "receipts/retrieval_review.json"));
  const { bm25, semantic, hybrid_rrf: hybrid } = receipt.metrics;

  assert.equal(bm25.precision_at_5_macro, 0.24);
  assert.equal(semantic.precision_at_5_macro, 0.24);
  assert.equal(hybrid.precision_at_5_macro, 0.2467);
  assert.equal(hybrid.queries_with_relevant_at_5, bm25.queries_with_relevant_at_5);
  assert.ok(hybrid.mrr_at_5 < bm25.mrr_at_5);
});

test("semantic joins remain review candidates and do not clear the usefulness gate", () => {
  const receipt = readJson(join(TRIAL, "receipts/join_candidate_review.json"));
  const decision = readJson(join(TRIAL, "receipts/decision.json"));

  assert.equal(receipt.production_wiring, false);
  assert.equal(receipt.candidate_generation.candidates_proposed, 1);
  assert.equal(receipt.candidate_generation.candidates_surviving_review, 1);
  assert.equal(receipt.candidate_generation.clears_usefulness_threshold, false);
  assert.equal(receipt.review_cost.seconds_per_accepted_candidate, 47);
  assert.ok(receipt.candidates.every((row) => row.honest_label === "join_candidate_only"));
  assert.ok(receipt.candidates.every((row) => row.production_edge_authorized === false));
  assert.equal(decision.decision_hook, "not-worth-it");
  assert.equal(decision.production_wiring_in_trial, false);
});

test("offline checks validate without model dependencies or network access", () => {
  const corpusCheck = spawnSync(
    process.execPath,
    [join(TRIAL, "build_corpus.mjs"), "--check"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(corpusCheck.status, 0, corpusCheck.stderr);

  const receiptCheck = spawnSync(
    "python3",
    [join(TRIAL, "trial.py"), "--check"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(receiptCheck.status, 0, receiptCheck.stderr);

  const passageMapCheck = spawnSync(
    process.execPath,
    [join(ROOT, "tools/build_source_passage_map.mjs"), "--check"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(passageMapCheck.status, 0, passageMapCheck.stderr);
});
