import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  PREDICTION_SCHEMA,
  applyPredictionSupersession,
  buildPrediction,
  predictionBand,
  predictionClaimLayer,
  predictionDeliveryKey,
  predictionDeliveryTransition,
  resolvePredictions,
  validatePrediction,
} from "../src/lib/prediction_contract.mjs";
import {
  PREDICTION_TABLE_COLUMNS,
  buildPredictionView,
  expireOpenPredictionsD1,
  predictionKvKey,
  resolveOpenPredictionsForEvent,
  writePredictionsToD1,
  writePredictionViewsToKv,
} from "../src/lib/prediction_store.mjs";

const migration = readFileSync(
  new URL("../migrations/0011_prediction_assertions.sql", import.meta.url),
  "utf8",
);

function prediction(overrides = {}) {
  return buildPrediction({
    subject_ref: "rules:R-2026-123",
    predicted_event_kind: "rules.adoption",
    claim: "timing",
    predicted_window: {
      p10: "2026-09-01",
      p50: "2026-09-24",
      p90: "2026-11-15",
    },
    probability: 0.62,
    basis: {
      method: "phase_duration_ecdf",
      n: 214,
      train_from: "2019-01-01",
      train_to: "2026-06-30",
      cohort: "agency:dep · rules.comment_close→rules.adoption",
      evidence_event_ids: ["cte:evidence-1", "cte:evidence-2"],
      statute_ref: null,
    },
    model_name: "rules_adoption_lag",
    model_version: "1.0.0",
    generated_at: "2026-08-02T13:00:00Z",
    supersedes_prediction_id: null,
    status: "open",
    resolved_by_event_id: null,
    ...overrides,
  });
}

function d1(db) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          const statement = db.prepare(sql);
          return {
            async run() { return statement.run(...args); },
            async all() { return { results: statement.all(...args) }; },
          };
        },
      };
    },
  };
}

test("cityscroll.prediction.v0 validates the complete assertion and claim-layer wiring", () => {
  const built = prediction();
  assert.equal(PREDICTION_SCHEMA, "cityscroll.prediction.v0");
  assert.equal(built.schema_version, 1);
  assert.match(built.prediction_id, /^pred:[a-f0-9]{24}$/);
  assert.equal(validatePrediction(built), built);

  const claim = predictionClaimLayer(built);
  assert.equal(claim.classification, "derived_conclusion");
  assert.deepEqual(claim.evidence_assertion_ids, built.basis.evidence_event_ids);
  assert.equal(claim.fact, "prediction");
});

test("contract fails closed on unregistered event kinds and source-clock fields", () => {
  assert.throws(
    () => prediction({ predicted_event_kind: "rules.predicted_adoption" }),
    /unknown predicted_event_kind/,
  );

  for (const clock of [
    "valid_at",
    "valid_from",
    "valid_to",
    "published_at",
    "observed_at",
    "processed_at",
  ]) {
    assert.throws(
      () => prediction({ [clock]: "2026-08-02" }),
      new RegExp(`prediction must not carry source clock ${clock}`),
    );
  }

  assert.throws(
    () => prediction({ basis: { ...prediction().basis, observed_at: "2026-08-02" } }),
    /prediction must not carry source clock observed_at/,
  );
});

test("band grammar uses p50 thresholds and p90 for overdue", () => {
  const base = prediction();
  assert.equal(predictionBand(base, { now: "2026-06-25" }), "far");
  assert.equal(predictionBand(base, { now: "2026-06-26" }), "approaching");
  assert.equal(predictionBand(base, { now: "2026-09-10" }), "imminent");
  assert.equal(predictionBand(base, { now: "2026-11-15" }), "imminent");
  assert.equal(predictionBand(base, { now: "2026-11-16" }), "overdue");
});

test("delivery keys change only when a fixture sweep crosses a band", () => {
  const assertions = [
    prediction({ predicted_window: { p10: "2026-09-01", p50: "2026-09-24", p90: "2026-11-15" } }),
    prediction({ predicted_window: { p10: "2026-09-03", p50: "2026-09-28", p90: "2026-11-19" } }),
    prediction({ predicted_window: { p10: "2026-08-10", p50: "2026-08-14", p90: "2026-09-01" } }),
  ];
  const now = "2026-08-02";

  assert.equal(predictionBand(assertions[0], { now }), "approaching");
  assert.equal(predictionBand(assertions[1], { now }), "approaching");
  assert.equal(predictionBand(assertions[2], { now }), "imminent");
  assert.equal(predictionDeliveryKey(assertions[0], { now }),
    "pred:rules:R-2026-123:rules.adoption:approaching");
  assert.equal(predictionDeliveryTransition(assertions[0], assertions[1], { now }), null);
  assert.equal(
    predictionDeliveryTransition(assertions[1], assertions[2], { now }),
    "pred:rules:R-2026-123:rules.adoption:imminent",
  );
});

test("resolution exact-joins registered events and resolves timing hit/miss", () => {
  const hit = prediction({ subject_ref: "rules:hit" });
  const miss = prediction({ subject_ref: "rules:miss" });
  const occurrence = prediction({
    subject_ref: "rules:occurrence",
    claim: "occurrence",
  });
  const wrongKind = prediction({ subject_ref: "rules:wrong-kind" });

  const events = [
    {
      event_id: "cte:hit",
      subject_ref: "rules:hit",
      event_kind: "rules.adoption",
      valid_at: "2026-10-02",
    },
    {
      event_id: "cte:miss",
      subject_ref: "rules:miss",
      event_kind: "rules.adoption",
      valid_at: "2026-12-01",
    },
    {
      event_id: "cte:occurrence",
      subject_ref: "rules:occurrence",
      event_kind: "rules.adoption",
      published_at: "2026-12-01",
    },
    {
      event_id: "cte:not-an-exact-kind",
      subject_ref: "rules:wrong-kind",
      event_kind: "rules.effective",
      valid_at: "2026-10-02",
    },
  ];

  const resolved = resolvePredictions([hit, miss, occurrence, wrongKind], events, {
    now: "2026-12-02",
  });
  assert.deepEqual(resolved.map((row) => [row.subject_ref, row.status, row.resolved_by_event_id]), [
    ["rules:hit", "resolved_hit", "cte:hit"],
    ["rules:miss", "resolved_miss", "cte:miss"],
    ["rules:occurrence", "resolved_hit", "cte:occurrence"],
    ["rules:wrong-kind", "open", null],
  ]);
});

test("timing resolution supports grace and expiry uses a per-domain horizon", () => {
  const outside = prediction({ subject_ref: "rules:grace" });
  const [withGrace] = resolvePredictions([outside], [{
    event_id: "cte:grace",
    subject_ref: "rules:grace",
    event_kind: "rules.adoption",
    valid_at: "2026-11-18",
  }], { graceDays: 3 });
  assert.equal(withGrace.status, "resolved_hit");

  const expired = prediction({ subject_ref: "rules:expired" });
  const landStillOpen = prediction({
    subject_ref: "project:open",
    predicted_event_kind: "land.zap_disposition",
  });
  const rows = resolvePredictions([expired, landStillOpen], [], {
    now: "2026-10-02T13:00:01Z",
    horizonDaysByDomain: { rules: 60, land: 365 },
  });
  assert.equal(rows[0].status, "expired");
  assert.equal(rows[1].status, "open");
});

test("prediction id is stable, model-version changes chain through supersedes", () => {
  const first = prediction();
  const identical = prediction();
  assert.equal(first.prediction_id, identical.prediction_id);

  const second = prediction({
    model_version: "1.1.0",
    supersedes_prediction_id: first.prediction_id,
  });
  assert.notEqual(first.prediction_id, second.prediction_id);
  assert.equal(second.supersedes_prediction_id, first.prediction_id);

  const retained = applyPredictionSupersession([first], second);
  assert.equal(retained[0].status, "open");
  assert.equal(retained[1].supersedes_prediction_id, first.prediction_id);

  const retracted = applyPredictionSupersession([first], second, { retractSuperseded: true });
  assert.equal(retracted[0].status, "withdrawn");
  assert.equal(retracted[1].status, "open");
});

test("batch views are claim-labeled and written to subject-scoped KV keys", async () => {
  const rows = [prediction(), prediction({ subject_ref: "rules:R-2026-456" })];
  const view = buildPredictionView(rows, { generatedAt: "2026-08-02T14:00:00Z" });
  assert.equal(view.schema, "cityscroll.prediction.view.v0");
  assert.equal(view.predictions[0].claim_layer.classification, "derived_conclusion");

  const writes = new Map();
  const kv = {
    async put(key, value) { writes.set(key, value); },
  };
  const result = await writePredictionViewsToKv(kv, rows, {
    generatedAt: "2026-08-02T14:00:00Z",
  });
  assert.deepEqual(result, { subjects: 2, predictions: 2 });
  assert.ok(writes.has(predictionKvKey("rules:R-2026-123")));
  assert.equal(JSON.parse(writes.get(predictionKvKey("rules:R-2026-123"))).predictions.length, 1);
});

test("D1 migration preserves the assertion and resolution-join shape", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(migration);
  const columns = db.prepare("PRAGMA table_info(prediction_assertion)").all().map((row) => row.name);
  for (const column of PREDICTION_TABLE_COLUMNS) {
    assert.ok(columns.includes(column), `missing ${column}`);
  }
  const indexes = db.prepare("PRAGMA index_list(prediction_assertion)").all().map((row) => row.name);
  assert.ok(indexes.includes("idx_prediction_open_join"));
  assert.ok(indexes.includes("idx_prediction_open_expiry"));
  db.close();
});

test("D1 batch storage resolves exact joins and expires configured horizons", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(migration);
  const db = d1(sqlite);
  const hit = prediction({ subject_ref: "rules:d1-hit" });
  const expiring = prediction({ subject_ref: "rules:d1-expired" });
  await writePredictionsToD1(db, [hit, expiring], {
    now: "2026-08-02T14:00:00Z",
    horizonDaysByDomain: { rules: 60 },
  });

  const resolved = await resolveOpenPredictionsForEvent(db, {
    event_id: "cte:d1-hit",
    subject_ref: "rules:d1-hit",
    event_kind: "rules.adoption",
    valid_at: "2026-10-02",
  }, { now: "2026-10-02T13:00:00Z" });
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].status, "resolved_hit");

  // A later batch rerun may still carry the open assertion. Closed lifecycle
  // state is monotonic and must not be reopened by that stale materialization.
  await writePredictionsToD1(db, [hit], {
    now: "2026-10-02T13:30:00Z",
    horizonDaysByDomain: { rules: 60 },
  });

  await expireOpenPredictionsD1(db, { now: "2026-10-02T14:00:01Z" });
  const statuses = sqlite.prepare(
    "SELECT subject_ref, status, resolved_by_event_id FROM prediction_assertion ORDER BY subject_ref",
  ).all().map((row) => ({ ...row }));
  assert.deepEqual(statuses, [
    { subject_ref: "rules:d1-expired", status: "expired", resolved_by_event_id: null },
    { subject_ref: "rules:d1-hit", status: "resolved_hit", resolved_by_event_id: "cte:d1-hit" },
  ]);
  sqlite.close();
});
