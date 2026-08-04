-- 06:00 ET digest dress rehearsal: durable private summary + rendered previews.
-- The public send ledger remains in ALERT_STATE; these rows are operator-only.

CREATE TABLE IF NOT EXISTS digest_shadow_runs (
  run_day TEXT PRIMARY KEY,
  ran_at TEXT NOT NULL,
  status TEXT NOT NULL,
  digest_count INTEGER NOT NULL,
  total_items INTEGER NOT NULL,
  summary_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS digest_shadow_previews (
  run_day TEXT NOT NULL,
  digest_id TEXT NOT NULL,
  recipient_redacted TEXT,
  subject TEXT NOT NULL,
  html TEXT NOT NULL,
  item_count INTEGER NOT NULL,
  watch_counts_json TEXT NOT NULL,
  PRIMARY KEY (run_day, digest_id),
  FOREIGN KEY (run_day) REFERENCES digest_shadow_runs(run_day) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_digest_shadow_previews_day
  ON digest_shadow_previews(run_day);
