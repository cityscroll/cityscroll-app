-- Batch-computed prediction assertions and their mechanical resolution state.
-- Assertions remain outside the civic event stream. Open rows join realized
-- events exactly by (subject_ref, predicted_event_kind).

CREATE TABLE IF NOT EXISTS prediction_assertion (
  prediction_id             TEXT PRIMARY KEY,
  schema_version            INTEGER NOT NULL CHECK (schema_version = 1),
  subject_ref               TEXT NOT NULL,
  predicted_event_kind      TEXT NOT NULL,
  claim                     TEXT NOT NULL CHECK (claim IN ('timing', 'occurrence')),
  p10                       TEXT NOT NULL,
  p50                       TEXT NOT NULL,
  p90                       TEXT NOT NULL,
  probability               REAL NOT NULL CHECK (probability >= 0 AND probability <= 1),
  basis_json                TEXT NOT NULL,
  model_name                TEXT NOT NULL,
  model_version             TEXT NOT NULL,
  generated_at              TEXT NOT NULL,
  supersedes_prediction_id  TEXT,
  status                    TEXT NOT NULL CHECK (
    status IN ('open', 'resolved_hit', 'resolved_miss', 'expired', 'withdrawn')
  ),
  resolved_by_event_id      TEXT,
  expires_at                TEXT,
  updated_at                TEXT NOT NULL,
  CHECK (p10 <= p50 AND p50 <= p90),
  CHECK (
    (status IN ('resolved_hit', 'resolved_miss') AND resolved_by_event_id IS NOT NULL)
    OR
    (status IN ('open', 'expired', 'withdrawn') AND resolved_by_event_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_prediction_open_join
  ON prediction_assertion(subject_ref, predicted_event_kind)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_prediction_open_expiry
  ON prediction_assertion(expires_at)
  WHERE status = 'open' AND expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_prediction_supersedes
  ON prediction_assertion(supersedes_prediction_id);
