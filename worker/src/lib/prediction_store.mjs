// Batch-side storage adapters for precomputed prediction assertion views.
// No request path performs inference; callers materialize assertions to KV and
// D1, then resolve open rows by exact civic-event identity.

import {
  PREDICTION_SCHEMA_VERSION,
  predictionClaimLayer,
  predictionHorizonAt,
  resolvePredictions,
  validatePrediction,
} from "./prediction_contract.mjs";

export const PREDICTION_VIEW_SCHEMA = "cityscroll.prediction.view.v0";
export const PREDICTION_KV_PREFIX = "prediction:v0:";
export const PREDICTION_TABLE_COLUMNS = Object.freeze([
  "prediction_id",
  "schema_version",
  "subject_ref",
  "predicted_event_kind",
  "claim",
  "p10",
  "p50",
  "p90",
  "probability",
  "basis_json",
  "model_name",
  "model_version",
  "generated_at",
  "supersedes_prediction_id",
  "status",
  "resolved_by_event_id",
  "expires_at",
  "updated_at",
]);

export function predictionKvKey(subjectRef) {
  const value = String(subjectRef || "").trim();
  if (!value) throw new TypeError("subject_ref is required for a prediction KV key");
  return `${PREDICTION_KV_PREFIX}${value}`;
}

export function buildPredictionView(predictions = [], opts = {}) {
  const generatedAt = String(opts.generatedAt || new Date().toISOString());
  if (!Number.isFinite(Date.parse(generatedAt))) throw new TypeError("generatedAt must be an ISO timestamp");
  const rows = (Array.isArray(predictions) ? predictions : [])
    .map((assertion) => {
      validatePrediction(assertion);
      return { assertion, claim_layer: predictionClaimLayer(assertion) };
    })
    .sort((left, right) => left.assertion.prediction_id.localeCompare(right.assertion.prediction_id));
  return {
    schema: PREDICTION_VIEW_SCHEMA,
    schema_version: PREDICTION_SCHEMA_VERSION,
    generated_at: new Date(generatedAt).toISOString(),
    predictions: rows,
  };
}

/** Materialize one compact JSON view per subject, following the existing fc:* shape. */
export async function writePredictionViewsToKv(kv, predictions = [], opts = {}) {
  if (!kv?.put) throw new TypeError("prediction KV writer requires a put-capable store");
  const bySubject = new Map();
  for (const prediction of (Array.isArray(predictions) ? predictions : [])) {
    validatePrediction(prediction);
    const rows = bySubject.get(prediction.subject_ref) || [];
    rows.push(prediction);
    bySubject.set(prediction.subject_ref, rows);
  }
  for (const [subjectRef, rows] of bySubject) {
    const options = {};
    if (Number.isSafeInteger(opts.expirationTtl) && opts.expirationTtl > 0) {
      options.expirationTtl = opts.expirationTtl;
    }
    await kv.put(
      predictionKvKey(subjectRef),
      JSON.stringify(buildPredictionView(rows, opts)),
      options,
    );
  }
  return { subjects: bySubject.size, predictions: [...bySubject.values()].reduce((n, rows) => n + rows.length, 0) };
}

const UPSERT_SQL = `INSERT INTO prediction_assertion
  (prediction_id, schema_version, subject_ref, predicted_event_kind, claim,
   p10, p50, p90, probability, basis_json, model_name, model_version,
   generated_at, supersedes_prediction_id, status, resolved_by_event_id,
   expires_at, updated_at)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
 ON CONFLICT(prediction_id) DO UPDATE SET
   probability=CASE WHEN prediction_assertion.status = 'open' THEN excluded.probability ELSE prediction_assertion.probability END,
   basis_json=CASE WHEN prediction_assertion.status = 'open' THEN excluded.basis_json ELSE prediction_assertion.basis_json END,
   p10=CASE WHEN prediction_assertion.status = 'open' THEN excluded.p10 ELSE prediction_assertion.p10 END,
   p50=CASE WHEN prediction_assertion.status = 'open' THEN excluded.p50 ELSE prediction_assertion.p50 END,
   p90=CASE WHEN prediction_assertion.status = 'open' THEN excluded.p90 ELSE prediction_assertion.p90 END,
   status=CASE WHEN prediction_assertion.status = 'open' THEN excluded.status ELSE prediction_assertion.status END,
   resolved_by_event_id=CASE WHEN prediction_assertion.status = 'open' THEN excluded.resolved_by_event_id ELSE prediction_assertion.resolved_by_event_id END,
   expires_at=CASE WHEN prediction_assertion.status = 'open' THEN COALESCE(excluded.expires_at, prediction_assertion.expires_at) ELSE prediction_assertion.expires_at END,
   updated_at=excluded.updated_at`;

function bindPrediction(db, prediction, opts = {}) {
  const expiresAt = predictionHorizonAt(prediction, opts);
  const updatedAt = new Date(opts.now ?? Date.now()).toISOString();
  return db.prepare(UPSERT_SQL).bind(
    prediction.prediction_id,
    prediction.schema_version,
    prediction.subject_ref,
    prediction.predicted_event_kind,
    prediction.claim,
    prediction.predicted_window.p10,
    prediction.predicted_window.p50,
    prediction.predicted_window.p90,
    prediction.probability,
    JSON.stringify(prediction.basis),
    prediction.model_name,
    prediction.model_version,
    prediction.generated_at,
    prediction.supersedes_prediction_id,
    prediction.status,
    prediction.resolved_by_event_id,
    expiresAt,
    updatedAt,
  );
}

/** Batch-upsert precomputed assertions; this function never runs a model. */
export async function writePredictionsToD1(db, predictions = [], opts = {}) {
  if (!db?.prepare) throw new TypeError("prediction D1 writer requires a database");
  const statements = (Array.isArray(predictions) ? predictions : []).map((prediction) => {
    validatePrediction(prediction);
    return bindPrediction(db, prediction, opts);
  });
  if (statements.length && typeof db.batch === "function") {
    await db.batch(statements);
  } else {
    for (const statement of statements) await statement.run();
  }
  return { written: statements.length };
}

function predictionFromRow(row) {
  return validatePrediction({
    schema_version: row.schema_version,
    prediction_id: row.prediction_id,
    subject_ref: row.subject_ref,
    predicted_event_kind: row.predicted_event_kind,
    claim: row.claim,
    predicted_window: { p10: row.p10, p50: row.p50, p90: row.p90 },
    probability: row.probability,
    basis: JSON.parse(row.basis_json),
    model_name: row.model_name,
    model_version: row.model_version,
    generated_at: row.generated_at,
    supersedes_prediction_id: row.supersedes_prediction_id,
    status: row.status,
    resolved_by_event_id: row.resolved_by_event_id,
  });
}

/** Resolve the exact open rows for one realized event and persist their outcomes. */
export async function resolveOpenPredictionsForEvent(db, event, opts = {}) {
  if (!db?.prepare) throw new TypeError("prediction resolver requires a database");
  const query = await db.prepare(
    `SELECT * FROM prediction_assertion
      WHERE status = 'open' AND subject_ref = ? AND predicted_event_kind = ?`,
  ).bind(event.subject_ref, event.event_kind).all();
  const rows = (query?.results || []).map(predictionFromRow);
  const resolved = resolvePredictions(rows, [event], opts);
  await writePredictionsToD1(db, resolved, opts);
  return resolved;
}

/** Expire rows whose batch-computed per-domain horizon has passed. */
export async function expireOpenPredictionsD1(db, opts = {}) {
  if (!db?.prepare) throw new TypeError("prediction expiry requires a database");
  const now = new Date(opts.now ?? Date.now()).toISOString();
  return db.prepare(
    `UPDATE prediction_assertion
        SET status = 'expired', resolved_by_event_id = NULL, updated_at = ?
      WHERE status = 'open' AND expires_at IS NOT NULL AND expires_at < ?`,
  ).bind(now, now).run();
}
