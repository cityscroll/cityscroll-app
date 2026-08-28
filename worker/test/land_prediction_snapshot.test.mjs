import assert from "node:assert/strict";
import { test } from "node:test";

import baselineFixture from "../../test/fixtures/land_prediction_baseline/v1.json" with { type: "json" };
import {
  LAND_PREDICTION_SNAPSHOT_SCHEMA,
  buildLandPredictionSnapshot,
  resolveHistoricalActorAt,
  validateLandPredictionSnapshot,
} from "../src/lib/land_prediction_snapshot.mjs";

const CUTOFF = "2024-06-01T00:00:00Z";

function feature(snapshot, key) {
  return snapshot.features.find((item) => item.key === key);
}

test("snapshot schema makes application, cutoff, stage, and provenance-bearing features first-class", () => {
  const snapshot = buildLandPredictionSnapshot({
    application_id: baselineFixture.cases[0].project_id,
    prediction_as_of: CUTOFF,
    procedural_stage: "community_board",
    features: [{
      key: "community_board_action",
      value: "conditional_favorable",
      evidence_type: "official_record",
      observed_at: "2024-05-20T12:00:00Z",
      effective_at: "2024-05-20T12:00:00Z",
      source: { url: "https://example.invalid/cb-record", record_id: "cb-1" },
      confidence: 0.8,
    }],
  });

  assert.equal(snapshot.schema_version, 1);
  assert.equal(LAND_PREDICTION_SNAPSHOT_SCHEMA, "cityscroll.land_prediction_snapshot.v1");
  assert.equal(snapshot.application_id, baselineFixture.cases[0].project_id);
  assert.equal(snapshot.prediction_as_of, "2024-06-01T00:00:00.000Z");
  assert.equal(snapshot.procedural_stage, "community_board");
  assert.deepEqual(feature(snapshot, "community_board_action"), {
    key: "community_board_action",
    value: "conditional_favorable",
    state: "known",
    evidence_type: "official_record",
    observed_at: "2024-05-20T12:00:00.000Z",
    effective_at: "2024-05-20T12:00:00.000Z",
    source: { record_id: "cb-1", url: "https://example.invalid/cb-record" },
    confidence: 0.8,
  });
});

test("unknown, no-known-position, and substantive neutral-mixed remain distinct", () => {
  const snapshot = buildLandPredictionSnapshot({
    application_id: "2024A0001",
    prediction_as_of: CUTOFF,
    procedural_stage: "cpc",
    features: [
      { key: "unobserved_signal", value: null },
      {
        key: "member_position",
        state: "no-known-position",
        value: null,
        evidence_type: "position_search",
        observed_at: "2024-05-25",
        source: "public project-record search",
      },
      {
        key: "member_position",
        state: "neutral_mixed",
        value: "mixed_or_unclear",
        evidence_type: "conflicting_project_specific_evidence",
        observed_at: "2024-05-25",
        source: "two project-specific public remarks",
        confidence: 0.5,
      },
      {
        key: "conflicting_action",
        value: "approved",
        evidence_type: "official_record",
        observed_at: "2024-05-25",
        source: "record-a",
      },
      {
        key: "conflicting_action",
        value: "disapproved",
        evidence_type: "official_record",
        observed_at: "2024-05-25",
        source: "record-b",
      },
    ],
  });

  assert.deepEqual(feature(snapshot, "unobserved_signal"), {
    key: "unobserved_signal",
    value: null,
    state: "unknown",
    evidence_type: "unknown",
    observed_at: null,
    effective_at: null,
    source: null,
    confidence: null,
  });
  const positions = snapshot.features.filter((item) => item.key === "member_position");
  assert.deepEqual(positions.map((item) => item.state), ["neutral_mixed", "no_known_position"]);
  assert.equal(positions.find((item) => item.state === "neutral_mixed").value, "mixed_or_unclear");
  assert.equal(positions.find((item) => item.state === "no_known_position").value, null);
  assert.deepEqual(
    snapshot.features.filter((item) => item.key === "conflicting_action").map((item) => item.value),
    ["approved", "disapproved"],
  );
  assert.throws(() => buildLandPredictionSnapshot({
    application_id: "2024A0001",
    prediction_as_of: CUTOFF,
    procedural_stage: "cpc",
    features: [{ key: "bad", state: "unknown", value: "support" }],
  }), /unknown must not carry/);
  assert.throws(() => buildLandPredictionSnapshot({
    application_id: "2024A0001",
    prediction_as_of: CUTOFF,
    procedural_stage: "cpc",
    features: [{ key: "bad", state: "neutral_mixed", value: null, source: "x", observed_at: "2024-05-25" }],
  }), /neutral_mixed must carry/);
});

test("future evidence is excluded and becomes explicit unknown at the cutoff", () => {
  const snapshot = buildLandPredictionSnapshot({
    application_id: "2024A0002",
    prediction_as_of: CUTOFF,
    procedural_stage: "council",
    features: [
      {
        key: "council_action",
        value: "approved",
        evidence_type: "official_record",
        observed_at: "2024-06-02T00:00:00Z",
        source: "future record",
        confidence: 1,
      },
      {
        key: "published_schedule",
        value: "council hearing scheduled",
        evidence_type: "official_record",
        observed_at: "2024-05-20T00:00:00Z",
        effective_at: "2024-06-10T00:00:00Z",
        source: "published calendar",
      },
    ],
  });

  assert.deepEqual(feature(snapshot, "council_action"), {
    key: "council_action",
    value: null,
    state: "unknown",
    evidence_type: "not_available_at_cutoff",
    observed_at: null,
    effective_at: null,
    source: null,
    confidence: null,
  });
  assert.equal(feature(snapshot, "published_schedule").value, "council hearing scheduled");
  assert.equal(snapshot.features.some((item) => item.source === "future record"), false);
  assert.throws(() => validateLandPredictionSnapshot({
    ...snapshot,
    features: [{
      ...feature(snapshot, "published_schedule"),
      observed_at: "2024-06-02T00:00:00.000Z",
    }],
  }), /after prediction_as_of/);
});

test("same inputs produce byte-identical snapshots independent of evidence order", () => {
  const input = {
    application_id: "2024A0003",
    prediction_as_of: CUTOFF,
    procedural_stage: "pre_certification",
    features: [
      {
        key: "z_signal",
        value: { b: 2, a: 1 },
        evidence_type: "derived",
        effective_at: "2024-05-01",
        source: { z: "z", a: "a" },
      },
      {
        key: "a_signal",
        value: "support",
        evidence_type: "direct_public_statement",
        observed_at: "2024-04-01",
        source: "statement-1",
      },
    ],
  };
  const left = buildLandPredictionSnapshot(input);
  const right = buildLandPredictionSnapshot({ ...input, features: [...input.features].reverse() });
  assert.equal(JSON.stringify(left), JSON.stringify(right));
});

test("historical actor seam always receives prediction_as_of and never falls back to current officeholder", () => {
  let request = null;
  const actor = resolveHistoricalActorAt({ role: "local_council_member" }, CUTOFF, (candidate) => {
    request = candidate;
    return {
      resolution: "resolved",
      actor_id: "official:123",
      observed_at: "2024-05-01",
      effective_at: "2022-01-01",
      source: "historical-term-record",
    };
  });
  assert.equal(request.as_of, "2024-06-01T00:00:00.000Z");
  assert.equal(actor.actor_id, "official:123");
  assert.equal(actor.as_of, "2024-06-01T00:00:00.000Z");

  const unresolved = buildLandPredictionSnapshot({
    application_id: "2024A0004",
    prediction_as_of: CUTOFF,
    procedural_stage: "council",
    historical_actors: [{ role: "local_council_member" }],
  });
  assert.deepEqual(unresolved.historical_actors[0], {
    role: "local_council_member",
    actor_id: null,
    resolution: "unknown",
    as_of: "2024-06-01T00:00:00.000Z",
    observed_at: null,
    effective_at: null,
    source: null,
  });
});
