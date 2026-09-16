CREATE TABLE IF NOT EXISTS ops_emergency_deliveries (
  signature           TEXT PRIMARY KEY,
  payload_json        TEXT NOT NULL,
  state               TEXT NOT NULL
                      CHECK (state IN ('in-flight', 'indeterminate', 'rejected', 'accepted')),
  claim_token         TEXT,
  claim_expires_at    TEXT,
  first_attempted_at  TEXT NOT NULL,
  last_attempted_at   TEXT NOT NULL,
  retry_until         TEXT NOT NULL,
  attempt_count       INTEGER NOT NULL DEFAULT 1,
  resolved_at         TEXT,
  provider_id         TEXT,
  error_reason        TEXT
);
