-- Checkpointed operator-triggered digest-shadow repairs. Queue messages carry
-- only the run and digest ids; D1 remains the durable progress ledger.
CREATE TABLE IF NOT EXISTS digest_shadow_rebuild_runs (
  run_id TEXT PRIMARY KEY,
  run_day TEXT NOT NULL,
  requested_digest_ids_json TEXT,
  status TEXT NOT NULL,
  total_count INTEGER NOT NULL DEFAULT 0,
  completed_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  receipt_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS digest_shadow_rebuild_items (
  run_id TEXT NOT NULL,
  digest_id TEXT NOT NULL,
  job_json TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  error TEXT,
  started_at TEXT,
  completed_at TEXT,
  PRIMARY KEY (run_id, digest_id),
  FOREIGN KEY (run_id) REFERENCES digest_shadow_rebuild_runs(run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_digest_shadow_rebuild_items_run_status
  ON digest_shadow_rebuild_items(run_id, status);
