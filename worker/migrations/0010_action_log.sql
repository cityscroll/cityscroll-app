-- Versioned, privacy-safe action ledger for product interventions.
-- Rows intentionally contain no actor, email, IP, cookie, or session identifier.

CREATE TABLE IF NOT EXISTS action_log (
  id              TEXT PRIMARY KEY,
  schema_version  TEXT NOT NULL,
  action_type     TEXT NOT NULL,
  object_type     TEXT NOT NULL,
  object_id       TEXT,
  ts              TEXT NOT NULL,
  method          TEXT NOT NULL,
  method_version  TEXT NOT NULL,
  metadata_json   TEXT
);

CREATE INDEX IF NOT EXISTS idx_action_log_type_ts
  ON action_log(action_type, ts);
CREATE INDEX IF NOT EXISTS idx_action_log_object_ts
  ON action_log(object_type, object_id, ts);
