import assert from "node:assert/strict";
import { test } from "node:test";

import {
  STANCE_DIRECTIONS,
  STANCE_EVIDENCE_TYPES,
  appendLandMemberStanceEvidence,
  buildLandMemberStance,
  validateLandMemberStance,
} from "../src/lib/land_prediction_member_stance.mjs";

const AS_OF = "2024-06-01T00:00:00Z";

function evidence(overrides = {}) {
  return {
    evidence_id: "statement-1",
    application_id: "2024A0001",
    member_id: "official:123",
    direction: "support",
    evidence_type: "direct_public_statement",
    source: { url: "https://example.invalid/statement-1", record_id: "statement-1" },
    source_language: "The member said the application should move forward.",
    observed_at: "2024-05-20T12:00:00Z",
    effective_at: "2024-05-20T12:00:00Z",
    confidence: 0.9,
    ...overrides,
  };
}

function stance(rows = [], overrides = {}) {
  return buildLandMemberStance({
    application_id: "2024A0001",
    member_id: "official:123",
    as_of: AS_OF,
    evidence: rows,
    ...overrides,
  });
}

test("schema exposes the bounded direction and evidence vocabularies", () => {
  assert.deepEqual(STANCE_DIRECTIONS, ["support", "oppose", "conditional", "mixed_or_unclear", "unknown"]);
  assert.deepEqual(STANCE_EVIDENCE_TYPES, [
    "direct_public_statement",
    "hearing_or_meeting_remarks",
    "requested_project_modification",
    "official_press_release_or_newsletter",
    "project_specific_legislative_or_committee_action",
    "reputable_reporting",
  ]);
});

test("non-unknown stance is inspectable, timestamped, and exactly application-associated", () => {
  const record = stance([evidence()]);
  assert.equal(record.resolution.direction, "support");
  assert.equal(record.resolution.confidence, 0.9);
  assert.deepEqual(record.resolution.selected_evidence_ids, ["statement-1"]);
  assert.equal(record.evidence[0].application_id, record.application_id);
  assert.equal(record.evidence[0].source.url, "https://example.invalid/statement-1");
  assert.equal(record.evidence[0].observed_at, "2024-05-20T12:00:00.000Z");
  assert.equal(record.evidence[0].source_language.length > 0, true);
  assert.equal(validateLandMemberStance(record).resolution.direction, "support");
});

test("unknown is explicit and never converted into neutral or mixed", () => {
  const record = stance([]);
  assert.equal(record.resolution.direction, "unknown");
  assert.equal(record.resolution.confidence, null);
  assert.equal(record.resolution.reason, "no_evidence");

  const explicitUnknown = stance([evidence({
    evidence_id: "unclear-1",
    direction: "unknown",
    evidence_type: "reputable_reporting",
    source_language: "The article did not establish a position.",
  })]);
  assert.equal(explicitUnknown.resolution.direction, "unknown");
  assert.equal(explicitUnknown.resolution.reason, "latest_unknown");
  assert.notEqual(explicitUnknown.resolution.direction, "mixed_or_unclear");
});

test("same-clock conflicting evidence resolves deterministically and preserves every row", () => {
  const record = stance([
    evidence({
      evidence_id: "oppose-1",
      direction: "oppose",
      evidence_type: "hearing_or_meeting_remarks",
      source: "hearing-record-1",
      source_language: "The member opposed the application.",
    }),
    evidence({
      evidence_id: "conditional-1",
      direction: "conditional",
      evidence_type: "requested_project_modification",
      source: "modification-letter-1",
      source_language: "The member requested a condition before support.",
    }),
  ]);
  assert.equal(record.resolution.direction, "mixed_or_unclear");
  assert.equal(record.resolution.confidence, null);
  assert.deepEqual(record.resolution.selected_evidence_ids, ["conditional-1", "oppose-1"]);
  assert.deepEqual(record.resolution.history.map((row) => [row.evidence_id, row.status]), [
    ["conditional-1", "current"],
    ["oppose-1", "current"],
  ]);
  assert.equal(record.evidence.length, 2);
});

test("later evidence supersedes earlier evidence without deleting history", () => {
  const original = stance([evidence()]);
  const updated = appendLandMemberStanceEvidence(original, [evidence({
    evidence_id: "oppose-2",
    direction: "oppose",
    evidence_type: "official_press_release_or_newsletter",
    source: { url: "https://example.invalid/press-2" },
    source_language: "The member opposed the revised application.",
    observed_at: "2024-05-30T12:00:00Z",
    effective_at: "2024-05-30T12:00:00Z",
    confidence: 0.8,
  })]);
  assert.equal(updated.resolution.direction, "oppose");
  assert.deepEqual(updated.resolution.selected_evidence_ids, ["oppose-2"]);
  assert.deepEqual(updated.resolution.history.map((row) => [row.evidence_id, row.status]), [
    ["statement-1", "superseded"],
    ["oppose-2", "current"],
  ]);
  assert.equal(updated.evidence.length, 2);
  assert.equal(updated.evidence.some((row) => row.evidence_id === "statement-1"), true);
});

test("prohibited proxy evidence, future evidence, and identity mismatches fail closed", () => {
  assert.throws(() => stance([evidence({
    evidence_id: "party-1",
    evidence_type: "party_platform",
  })]), /unsupported stance evidence type/);
  const future = stance([evidence({
    observed_at: "2024-06-02T00:00:00Z",
  })]);
  assert.equal(future.resolution.direction, "unknown");
  assert.equal(future.evidence.length, 0);
  const futureEffective = stance([evidence({
    effective_at: "2024-06-10T00:00:00Z",
  })]);
  assert.equal(futureEffective.resolution.direction, "support");
  assert.equal(futureEffective.evidence.length, 1);
  assert.throws(() => stance([evidence({
    application_id: "2024A9999",
  })]), /exactly match application_id/);
  assert.throws(() => stance([evidence({
    source: { note: "not inspectable" },
  })]), /inspectable locator/);
  assert.throws(() => stance([evidence({
    direction: "neutral",
  })]), /unsupported stance direction/);
  assert.throws(() => stance([], { member_id: "person:123" }), /official:\{PersonId\}/);
});

test("history order and output are independent of input order", () => {
  const rows = [
    evidence({ evidence_id: "later", observed_at: "2024-05-30", effective_at: "2024-05-30" }),
    evidence({ evidence_id: "earlier", observed_at: "2024-05-20", effective_at: "2024-05-20" }),
  ];
  const left = stance(rows);
  const right = stance([...rows].reverse());
  assert.deepEqual(left, right);
  assert.deepEqual(left.resolution.history.map((row) => row.evidence_id), ["earlier", "later"]);
  assert.equal(left.resolution.direction, "support");
});
