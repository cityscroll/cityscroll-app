import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  RULES_SEMANTIC_LANE_SCHEMA,
  buildRulesSemanticLane,
  renderRulesSemanticLane,
  resolveRulesSemanticLane,
  validateRulesSemanticLane,
} from "../site/rules_semantic_lane.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

const inputs = () => ({
  corpusManifest: readJson("warehouse/manifests/semantic_retrieval_corpus_manifest.json"),
  passageMap: readJson("warehouse/experiments/semantic-layer-trial/source_passage_map.json"),
  retrievalReview: readJson("warehouse/experiments/semantic-layer-trial/receipts/retrieval_review.json"),
  rulesSnapshot: readJson("site/data/rules_domain_observations.json"),
});

test("Rules semantic lane admits only reviewed semantic-only Rules records", () => {
  const artifact = buildRulesSemanticLane(inputs());

  assert.equal(artifact.schema, RULES_SEMANTIC_LANE_SCHEMA);
  assert.equal(artifact.artifact_version, 1);
  assert.equal(artifact.coverage.state, "partial");
  assert.equal(artifact.corpus_manifest.manifest_sha256, inputs().corpusManifest.manifest_sha256);
  assert.deepEqual(
    artifact.candidates.map((candidate) => candidate.rule.request_id),
    ["20260707025", "20260626035"],
  );

  for (const candidate of artifact.candidates) {
    assert.equal(candidate.record_type, "rule");
    assert.equal(candidate.retrieval.method, "reviewed_semantic_only");
    assert.equal(candidate.retrieval.honest_label, "related_language_candidate");
    assert.match(candidate.rule.canonical_url, /^\/notices\/[0-9]+$/);
    assert.equal(candidate.source_passage.text_state, "retained");
    assert.ok(candidate.source_passage.text.includes(candidate.rule.title));
    assert.match(candidate.source_passage.text_sha256, /^[a-f0-9]{64}$/);
    assert.match(candidate.source.source_url, /^https:\/\//);
    assert.doesNotMatch(JSON.stringify(candidate), /semantic_score|\"score\"/);
  }
  assert.equal(validateRulesSemanticLane(artifact), artifact);
});

test("Rules semantic resolution preserves lexical identity and every hard filter", () => {
  const artifact = buildRulesSemanticLane(inputs());
  const query = "rules for keeping pedestrians safe around construction scaffolding";
  const base = {
    query,
    agency: "Buildings",
    process: "adoption",
    geography: "citywide",
    date_from: "2026-07-01",
    date_to: "2026-07-31",
  };

  const matched = resolveRulesSemanticLane(artifact, base);
  assert.equal(matched.state, "matched");
  assert.deepEqual(matched.candidates.map((candidate) => candidate.rule.request_id), ["20260707025"]);

  for (const override of [
    { agency: "Consumer and Worker Protection" },
    { process: "proposal" },
    { geography: "Brooklyn" },
    { date_from: "2026-08-01" },
    { date_to: "2026-06-30" },
  ]) {
    const held = resolveRulesSemanticLane(artifact, { ...base, ...override });
    assert.equal(held.state, "held");
    assert.equal(held.coverage.reason, "hard_filters");
    assert.deepEqual(held.candidates, []);
  }

  const lexicalOwnsCard = resolveRulesSemanticLane(artifact, {
    ...base,
    lexical_request_ids: ["20260707025"],
  });
  assert.equal(lexicalOwnsCard.state, "lexical_only");
  assert.deepEqual(lexicalOwnsCard.candidates, []);
});

test("Rules semantic lane renders a labeled exact passage and canonical rule link", () => {
  const artifact = buildRulesSemanticLane(inputs());
  const projection = resolveRulesSemanticLane(artifact, {
    query: "how to end an automatically renewing service",
  });
  const labels = {
    rules_semantic_heading: "Related-language matches",
    rules_semantic_partial: "Reviewed pilot with partial coverage",
    rules_semantic_match: "Related to your search",
    rules_semantic_source_passage: "Source passage",
    rules_semantic_open_rule: "Open rule",
    rules_semantic_unavailable: "Related-language matches are unavailable.",
    rules_semantic_held: "No related-language matches meet these filters.",
  };
  const html = renderRulesSemanticLane(projection, {
    t: (key) => labels[key] || key,
    escape: (value) => String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;"),
  });

  assert.match(html, /data-rules-semantic-lane="matched"/);
  assert.match(html, /<h3[^>]*>Related-language matches<\/h3>/);
  assert.match(html, /<blockquote[^>]*>DCWP NOA Cancellation of Subscriptions/);
  assert.match(html, /href="\/notices\/20260626035"/);
  assert.match(html, /data-record-type="rule"/);
  assert.doesNotMatch(html, /0\.320181|score/i);

  const unavailable = renderRulesSemanticLane(resolveRulesSemanticLane(null, {
    query: "subscription cancellation",
  }), { t: (key) => labels[key] || key });
  assert.match(unavailable, /data-rules-semantic-lane="unavailable"/);
  assert.match(unavailable, /Related-language matches are unavailable/);
});

test("Rules semantic lane vintage tracks the daily rules snapshot, not the bounded research corpus", () => {
  const built = inputs();
  const artifact = buildRulesSemanticLane(built);

  assert.equal(artifact.rules_snapshot_observed_at, built.rulesSnapshot.retrieved_at);
  assert.equal(artifact.corpus_observed_on, built.corpusManifest.observed_on);

  const refreshedSnapshot = { ...built.rulesSnapshot, retrieved_at: "2026-09-05T00:00:00.000Z" };
  const refreshed = buildRulesSemanticLane({ ...built, rulesSnapshot: refreshedSnapshot });
  assert.equal(refreshed.rules_snapshot_observed_at, "2026-09-05T00:00:00.000Z");
  assert.equal(refreshed.corpus_observed_on, built.corpusManifest.observed_on, "the research corpus vintage does not move with the daily snapshot");
});

test("committed Rules semantic lane artifact is current", () => {
  const check = spawnSync(
    process.execPath,
    [join(ROOT, "tools/build_rules_semantic_lane.mjs"), "--check"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(check.status, 0, check.stderr || check.stdout);
});
