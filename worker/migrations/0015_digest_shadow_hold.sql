-- Scoped, expiring delivery holds derived only from digest-shadow affected_digest_ids.
-- The state row is an operator receipt; enforcement recomputes from the source run and overrides.

CREATE TABLE IF NOT EXISTS digest_shadow_hold_states (
  run_day TEXT PRIMARY KEY,
  contract TEXT NOT NULL,
  evaluated_at TEXT NOT NULL,
  source_status TEXT NOT NULL,
  delivery_policy TEXT NOT NULL,
  cutoff_at TEXT NOT NULL,
  delivery_boundary_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  state_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS digest_shadow_hold_overrides (
  run_day TEXT NOT NULL,
  digest_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (run_day, digest_id),
  FOREIGN KEY (run_day) REFERENCES digest_shadow_runs(run_day) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_digest_shadow_hold_overrides_day
  ON digest_shadow_hold_overrides(run_day);
