/**
 * Characterization: complementary person-row precision receipt for live
 * Council meeting-outcomes by_person retention (flywheel crank materialization).
 * Authoritative vote-bearing sample + product gates live in
 * test/meeting_person_votes.test.mjs and
 * site/data/legistar_sources/verification_receipts/meeting_person_votes_2026-08-11.json.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  classifyNotPublishedClaim,
  computeNotPublishedRate,
  evaluateNotPublishedClaims,
} from "../ontology/dimensions/not_published_rate.mjs";

const ROOT = new URL("..", import.meta.url);
const receipt = JSON.parse(
  readFileSync(new URL("site/data/legistar_sources/verification_receipts/meeting_person_votes_materialization_2026-08-11.json", ROOT), "utf8"),
);
const samples = JSON.parse(
  readFileSync(new URL("ontology/fixtures/dimensions/not_published_claim_samples.json", ROOT), "utf8"),
);

test("materialization kill sample clears usefulness and precision gates", () => {
  assert.equal(receipt.schema, "cityscroll.metric_receipt.v1");
  assert.equal(receipt.metric, "meeting_person_votes_materialization_rate");
  assert.equal(receipt.measured_at, "2026-08-11");
  const m = receipt.measurement;
  assert.equal(m.matched_council_hearings, 16);
  assert.equal(m.with_nonempty_by_person, 6);
  assert.equal(m.usefulness_rate, 0.375);
  assert.equal(m.usefulness_pass, true);
  assert.ok(m.usefulness_rate >= receipt.gates.usefulness_threshold);
  assert.equal(m.person_rows_reviewed, 388);
  assert.equal(m.person_rows_valid, 388);
  assert.equal(m.precision_rate, 1);
  assert.equal(m.precision_pass, true);
  assert.ok(m.precision_rate >= receipt.gates.precision_floor);
  assert.match(String(receipt.verdict), /SHIP|KEEP LIVE/i);
  assert.equal(receipt.examples.demo_notice_id, "20260706036");
  assert.equal(receipt.examples.demo_person_id, "7801");
});

test("flywheel claim sample for meeting-person-votes is healthy (not red flag)", () => {
  const claim = samples.claims.find((c) => c.id === "meeting-person-votes");
  assert.ok(claim);
  assert.equal(claim.sample.classification_hint, "healthy");
  assert.ok(claim.sample.non_null_examples >= 1);
  assert.match(
    claim.sample.public_source_evidence,
    /meeting_person_votes_2026-08-11|by_person/,
  );

  const rate = computeNotPublishedRate(claim.sample);
  assert.ok(rate.n >= 10);
  assert.ok(rate.rate < 0.85);

  const classified = classifyNotPublishedClaim(rate, claim);
  assert.equal(classified.red_flag, false);
  assert.equal(classified.classification, "healthy");

  const evaled = evaluateNotPublishedClaims(samples.claims);
  const finding = evaled.findings.find((f) => f.claim_id === "meeting-person-votes");
  assert.ok(finding);
  assert.equal(finding.red_flag, false);
  assert.equal(finding.classification, "healthy");
  assert.equal(evaled.metrics.red_flags, 0);
});
