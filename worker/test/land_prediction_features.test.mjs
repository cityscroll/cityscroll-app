import assert from "node:assert/strict";
import { test } from "node:test";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  INSTITUTIONAL_FEATURE_KEYS,
  LAND_PREDICTION_FEATURE_VECTOR_SCHEMA,
  buildLandPredictionFeatureVector,
  canonicalApplicationType,
  canonicalProceduralStage,
  validateLandPredictionFeatureVector,
} from "../src/lib/land_prediction_features.mjs";
import { buildLandMemberStance } from "../src/lib/land_prediction_member_stance.mjs";
import { buildLandPredictionSnapshot } from "../src/lib/land_prediction_snapshot.mjs";
import { LAND_PREDICTION_ACTOR_RESOLUTION_SCHEMA } from "../src/lib/land_prediction_actor_resolution.mjs";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../test/fixtures/land_prediction_features");

function loadFixture(name) {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"));
}

const AS_OF = "2024-06-01T00:00:00Z";

function source(id) {
  return { url: `https://example.invalid/${id}`, record_id: id };
}

function observation(key, value, id, overrides = {}) {
  return {
    key,
    value,
    evidence_type: "official_record",
    observed_at: "2024-05-20T00:00:00Z",
    effective_at: "2024-05-20T00:00:00Z",
    source: source(id),
    confidence: 0.8,
    ...overrides,
  };
}

function snapshot(features = [], stage = "cpc") {
  return buildLandPredictionSnapshot({
    application_id: "2024A0001",
    prediction_as_of: AS_OF,
    procedural_stage: stage,
    features,
  });
}

function stance(direction = "support") {
  return buildLandMemberStance({
    application_id: "2024A0001",
    member_id: "official:123",
    as_of: AS_OF,
    evidence: [{
      evidence_id: "stance-1",
      application_id: "2024A0001",
      member_id: "official:123",
      direction,
      evidence_type: "direct_public_statement",
      source: source("stance-1"),
      source_language: `The member expressed ${direction}.`,
      observed_at: "2024-05-25T00:00:00Z",
      effective_at: "2024-05-25T00:00:00Z",
      confidence: 0.9,
    }],
  });
}

function feature(vector, key) {
  return vector.features.filter((item) => item.key === key);
}

test("normalizes formal signals and C4 stance into one provenance-bearing layer", () => {
  const vector = buildLandPredictionFeatureVector({
    snapshot: snapshot([
      observation("application_type", "zoning_map_amendment", "application-1"),
      observation("community_board_recommendation", "favorable", "cb-1"),
      observation("borough_president_action", "favorable", "bp-1"),
      observation("cpc_recommendation", "favorable", "cpc-rec-1"),
      observation("cpc_disposition", "approved", "cpc-disp-1"),
      observation("cpc_vote", "6-0", "cpc-vote-1"),
      observation("council_subcommittee_action", "referred", "subcommittee-1"),
      observation("land_use_committee_action", "recommended", "committee-1"),
      observation("modifications", "height_condition", "condition-1"),
    ]),
    member_stance: stance(),
  });

  assert.equal(vector.schema, LAND_PREDICTION_FEATURE_VECTOR_SCHEMA);
  assert.deepEqual(vector.historical_actors, []);
  assert.deepEqual(INSTITUTIONAL_FEATURE_KEYS.every((key) => feature(vector, key).length > 0), true);
  assert.equal(feature(vector, "community_board_action")[0].value, "favorable");
  assert.equal(feature(vector, "local_council_member_stance")[0].value, "support");
  assert.deepEqual(feature(vector, "local_council_member_stance")[0].evidence_ids, ["stance-1"]);
  assert.equal(feature(vector, "local_council_member_stance")[0].evidence[0].source.record_id, "stance-1");
  assert.deepEqual(vector.stage_interactions, [{
    feature_key: "local_council_member_stance",
    stage: "cpc",
    interaction_key: "local_council_member_stance@cpc",
    estimation: "learnable_stage_interaction",
  }]);
});

test("sparse applications retain every candidate with explicit unknown missingness", () => {
  const vector = buildLandPredictionFeatureVector({ snapshot: snapshot([], "community_board") });
  assert.equal(vector.features.length, INSTITUTIONAL_FEATURE_KEYS.length);
  for (const key of INSTITUTIONAL_FEATURE_KEYS) {
    const row = feature(vector, key)[0];
    if (key === "procedural_stage") {
      assert.equal(row.state, "known");
      assert.equal(row.value, "community_board");
    } else {
      assert.deepEqual(row, {
        key,
        value: null,
        state: "unknown",
        evidence_type: "not_available_at_cutoff",
        observed_at: null,
        effective_at: null,
        source: null,
        confidence: null,
        evidence: [],
        evidence_ids: [],
      });
    }
  }
  assert.doesNotThrow(() => validateLandPredictionFeatureVector(vector));
});

test("future evidence remains unknown at the requested historical cutoff", () => {
  const vector = buildLandPredictionFeatureVector({
    snapshot: snapshot([
      observation("cpc_vote", "approved", "future-vote", { observed_at: "2024-06-02T00:00:00Z" }),
    ]),
  });
  assert.deepEqual(feature(vector, "cpc_vote")[0].state, "unknown");
  assert.equal(feature(vector, "cpc_vote")[0].source, null);
  assert.equal(vector.features.some((item) => item.source?.record_id === "future-vote"), false);
});

test("stage changes expose a learnable interaction without a fixed stance outcome rule", () => {
  const support = buildLandPredictionFeatureVector({ snapshot: snapshot([], "community_board"), member_stance: stance("support") });
  const oppose = buildLandPredictionFeatureVector({ snapshot: snapshot([], "council"), member_stance: stance("oppose") });
  assert.equal(feature(support, "local_council_member_stance")[0].value, "support");
  assert.equal(feature(oppose, "local_council_member_stance")[0].value, "oppose");
  assert.equal(support.stage_interactions[0].interaction_key, "local_council_member_stance@community_board");
  assert.equal(oppose.procedural_stage, "city_council");
  assert.equal(oppose.stage_interactions[0].interaction_key, "local_council_member_stance@city_council");
  assert.equal(Object.hasOwn(feature(support, "local_council_member_stance")[0], "veto"), false);
  assert.equal(Object.hasOwn(feature(oppose, "local_council_member_stance")[0], "veto"), false);
});

test("stance conflicts preserve the selected evidence trace", () => {
  const conflicted = buildLandMemberStance({
    application_id: "2024A0001",
    member_id: "official:123",
    as_of: AS_OF,
    evidence: [
      {
        evidence_id: "oppose-1",
        application_id: "2024A0001",
        member_id: "official:123",
        direction: "oppose",
        evidence_type: "hearing_or_meeting_remarks",
        source: source("oppose-1"),
        source_language: "The member opposed the application.",
        observed_at: "2024-05-25T00:00:00Z",
        effective_at: "2024-05-25T00:00:00Z",
        confidence: 0.8,
      },
      {
        evidence_id: "conditional-1",
        application_id: "2024A0001",
        member_id: "official:123",
        direction: "conditional",
        evidence_type: "requested_project_modification",
        source: source("conditional-1"),
        source_language: "The member requested a condition.",
        observed_at: "2024-05-25T00:00:00Z",
        effective_at: "2024-05-25T00:00:00Z",
        confidence: 0.7,
      },
    ],
  });
  const vector = buildLandPredictionFeatureVector({ snapshot: snapshot([], "cpc"), member_stance: conflicted });
  const row = feature(vector, "local_council_member_stance")[0];
  assert.equal(row.state, "neutral_mixed");
  assert.deepEqual(row.evidence_ids, ["conditional-1", "oppose-1"]);
  assert.deepEqual(row.evidence.map((item) => item.evidence_id), ["conditional-1", "oppose-1"]);
});

test("same source observations produce a deterministic vector regardless of input order", () => {
  const features = [
    observation("land_use_committee_action", "recommended", "committee-1"),
    observation("application_type", "zoning_map_amendment", "application-1"),
  ];
  const left = buildLandPredictionFeatureVector({ snapshot: snapshot(features) });
  const right = buildLandPredictionFeatureVector({ snapshot: snapshot([...features].reverse()) });
  assert.equal(JSON.stringify(left), JSON.stringify(right));
});

test("direct signal inputs use the C2 builder and require evidence for populated signals", () => {
  const vector = buildLandPredictionFeatureVector({
    application_id: "2024A0001",
    prediction_as_of: AS_OF,
    procedural_stage: "pre_certification",
    signals: {
      application_type: observation("application_type", "zoning_map_amendment", "application-1"),
      community_board_action: observation("community_board_action", "no_known_position", "cb-search-1", {
        state: "no_known_position",
        value: null,
      }),
    },
  });
  assert.equal(feature(vector, "application_type")[0].value, "zoning_map_amendment");
  assert.equal(feature(vector, "community_board_action")[0].state, "no_known_position");
  assert.throws(() => buildLandPredictionFeatureVector({
    application_id: "2024A0001",
    prediction_as_of: AS_OF,
    procedural_stage: "pre_certification",
    signals: { cpc_vote: { value: "approved", observed_at: "2024-05-20T00:00:00Z" } },
  }), /source is required/);
});

test("validation rejects a populated feature with no evidence trace", () => {
  const vector = buildLandPredictionFeatureVector({ snapshot: snapshot([]) });
  const application = feature(vector, "application_type")[0];
  assert.throws(() => validateLandPredictionFeatureVector({
    ...vector,
    features: vector.features.map((row) => row.key === "application_type"
      ? { ...row, state: "known", value: "zoning_map_amendment", source: source("missing-trace"), evidence: [], evidence_ids: [] }
      : row),
  }), /evidence trace/);
  assert.equal(application.state, "unknown");
});

function vectorFromFixture(fixture, stage = fixture.procedural_stage) {
  const snapshot = buildLandPredictionSnapshot({
    application_id: fixture.application_id,
    prediction_as_of: fixture.prediction_as_of,
    procedural_stage: stage,
    features: fixture.features || [],
    historical_actors: fixture.historical_actors || [],
  });
  return buildLandPredictionFeatureVector({
    snapshot,
    member_stance: fixture.stance ? buildLandMemberStance(fixture.stance) : null,
  });
}

test("fixture pack recreates complete, sparse, cutoff, conflicting, unknown, and multi-stage vectors", () => {
  const complete = vectorFromFixture(loadFixture("complete.json"));
  assert.equal(complete.procedural_stage, "cpc");
  assert.equal(feature(complete, "application_type")[0].value, "rezoning");
  assert.equal(feature(complete, "local_council_member_stance")[0].value, "support");
  assert.equal(complete.historical_actors[0].actor_id, "official:123");
  assert.equal(complete.stage_interactions[0].interaction_key, "local_council_member_stance@cpc");
  assert.deepEqual(JSON.parse(JSON.stringify(complete)), JSON.parse(JSON.stringify(vectorFromFixture(loadFixture("complete.json")))));

  const sparse = vectorFromFixture(loadFixture("sparse.json"));
  assert.equal(sparse.features.length, INSTITUTIONAL_FEATURE_KEYS.length);
  for (const key of INSTITUTIONAL_FEATURE_KEYS) {
    if (key === "procedural_stage") continue;
    assert.equal(feature(sparse, key)[0].state, "unknown");
    assert.equal(feature(sparse, key)[0].value, null);
  }

  const cutoff = vectorFromFixture(loadFixture("cutoff_boundary.json"));
  assert.equal(feature(cutoff, "cpc_vote")[0].value, "approved");
  assert.equal(feature(cutoff, "land_use_committee_action")[0].state, "unknown");
  assert.equal(cutoff.features.some((item) => item.source?.record_id === "after-cutoff"), false);

  const conflicted = vectorFromFixture(loadFixture("conflicting.json"));
  assert.equal(feature(conflicted, "local_council_member_stance")[0].state, "neutral_mixed");
  assert.deepEqual(feature(conflicted, "local_council_member_stance")[0].evidence_ids, ["conditional-1", "oppose-1"]);

  const unknown = vectorFromFixture(loadFixture("unknown.json"));
  assert.equal(feature(unknown, "local_council_member_stance")[0].state, "unknown");
  assert.equal(unknown.historical_actors[0].resolution, "unknown");

  const multi = loadFixture("multi_stage.json");
  const byStage = multi.stages.map((stage) => vectorFromFixture(multi, stage));
  assert.deepEqual(byStage.map((row) => row.procedural_stage), multi.canonical_stages);
  assert.deepEqual(byStage.map((row) => row.stage_interactions[0].interaction_key), multi.expect.interaction_keys);
  assert.equal(feature(byStage[0], "local_council_member_stance")[0].value, "support");
  assert.equal(feature(byStage[1], "local_council_member_stance")[0].value, "support");
});

test("populated features carry cutoff, identity, relation, and observation traces", () => {
  const vector = vectorFromFixture(loadFixture("complete.json"));
  for (const row of vector.features) {
    if (row.state === "unknown") continue;
    assert.ok(row.evidence.length > 0);
    for (const item of row.evidence) {
      assert.equal(item.cutoff, vector.prediction_as_of);
      assert.equal(Object.hasOwn(item, "identity"), true);
      assert.equal(Object.hasOwn(item, "relation"), true);
      assert.equal(Object.hasOwn(item, "observation"), true);
    }
  }
  const stance = feature(vector, "local_council_member_stance")[0];
  assert.equal(stance.evidence[0].identity, "official:123");
  assert.equal(stance.evidence[0].relation, "local_council_member_stance");
  assert.equal(stance.evidence[0].observation, "stance-1");
});

test("action-family and phase-spine maps normalize codes without inventing families", () => {
  assert.equal(canonicalApplicationType("ZM"), "rezoning");
  assert.equal(canonicalApplicationType("zoning_map_amendment"), "zoning_map_amendment");
  assert.equal(canonicalProceduralStage("council"), "city_council");
  assert.equal(canonicalProceduralStage("Community Board Referral"), "community_board");
  const vector = buildLandPredictionFeatureVector({
    snapshot: snapshot([
      observation("application_type", "ZM", "zm-1"),
    ], "council"),
  });
  assert.equal(vector.procedural_stage, "city_council");
  assert.equal(feature(vector, "application_type")[0].value, "rezoning");
  assert.equal(feature(vector, "procedural_stage")[0].value, "city_council");
});

test("historical actor identity binds stance and never substitutes a current member", () => {
  const historical = {
    role: "local_council_member",
    actor_id: "official:123",
    resolution: "resolved",
    observed_at: "2022-01-02T00:00:00Z",
    effective_at: "2022-01-01T00:00:00Z",
    source: source("term-123"),
  };
  const currentMemberStance = buildLandMemberStance({
    application_id: "2024A0001",
    member_id: "official:999",
    as_of: AS_OF,
    evidence: [{
      evidence_id: "current-1",
      application_id: "2024A0001",
      member_id: "official:999",
      direction: "oppose",
      evidence_type: "direct_public_statement",
      source: source("current-1"),
      source_language: "The current member opposed the application.",
      observed_at: "2024-05-25T00:00:00Z",
      effective_at: "2024-05-25T00:00:00Z",
      confidence: 0.9,
    }],
  });
  const mismatched = buildLandPredictionFeatureVector({
    snapshot: buildLandPredictionSnapshot({
      application_id: "2024A0001",
      prediction_as_of: AS_OF,
      procedural_stage: "city_council",
      features: [],
      historical_actors: [historical],
    }),
    member_stance: currentMemberStance,
  });
  assert.equal(feature(mismatched, "local_council_member_stance")[0].state, "unknown");
  assert.equal(feature(mismatched, "local_council_member_stance")[0].value, null);
  assert.equal(feature(mismatched, "local_council_member_stance")[0].evidence_type, "historical_actor_identity_mismatch");

  const vacant = buildLandPredictionFeatureVector({
    snapshot: buildLandPredictionSnapshot({
      application_id: "2024A0001",
      prediction_as_of: AS_OF,
      procedural_stage: "city_council",
      features: [],
      historical_actors: [{
        role: "local_council_member",
        resolution: "vacant",
        observed_at: "2022-01-02T00:00:00Z",
        effective_at: "2022-01-01T00:00:00Z",
        source: source("vacancy-1"),
      }],
    }),
    member_stance: stance(),
  });
  assert.equal(feature(vacant, "local_council_member_stance")[0].state, "unknown");
  assert.equal(feature(vacant, "local_council_member_stance")[0].evidence_type, "historical_actor_vacant");
  assert.equal(vacant.historical_actors[0].resolution, "vacant");
});

test("a supplied C3 actor resolution is cutoff-bound and schema-checked", () => {
  const vector = buildLandPredictionFeatureVector({
    snapshot: snapshot([], "cpc"),
    actor_resolution: {
      schema: LAND_PREDICTION_ACTOR_RESOLUTION_SCHEMA,
      application_id: "2024A0001",
      prediction_as_of: AS_OF,
      historical_actors: [{
        role: "local_council_member",
        actor_id: "official:123",
        resolution: "resolved",
        as_of: "2024-06-01T00:00:00.000Z",
        observed_at: "2022-01-02T00:00:00.000Z",
        effective_at: "2022-01-01T00:00:00.000Z",
        source: source("term-123"),
      }],
    },
    member_stance: stance(),
  });
  assert.equal(vector.historical_actors[0].actor_id, "official:123");
  assert.equal(feature(vector, "local_council_member_stance")[0].value, "support");
  assert.throws(() => buildLandPredictionFeatureVector({
    snapshot: snapshot([], "cpc"),
    actor_resolution: {
      schema: LAND_PREDICTION_ACTOR_RESOLUTION_SCHEMA,
      application_id: "other",
      prediction_as_of: AS_OF,
      historical_actors: [],
    },
  }), /application_id/);
});

test("no stage encodes a member veto; interactions remain learnable metadata", () => {
  for (const stage of ["community_board", "cpc", "council"]) {
    const vector = buildLandPredictionFeatureVector({
      snapshot: snapshot([], stage),
      member_stance: stance("oppose"),
    });
    const row = feature(vector, "local_council_member_stance")[0];
    assert.equal(row.value, "oppose");
    assert.equal(Object.hasOwn(row, "veto"), false);
    assert.equal(row.source.veto, undefined);
    assert.equal(vector.stage_interactions[0].estimation, "learnable_stage_interaction");
    assert.match(vector.stage_interactions[0].interaction_key, /^local_council_member_stance@/);
  }
});
