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
});
