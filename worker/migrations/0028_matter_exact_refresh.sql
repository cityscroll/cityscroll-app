-- Exact-matter refresh roster, fair-schedule state, and operator run receipts.
-- History stays in matter_observation_journal and source_records (migrations
-- 0008 and 0027). These tables are acquisition progress, not a second history store.

CREATE TABLE IF NOT EXISTS matter_refresh_roster (
  matter_key     TEXT PRIMARY KEY,
  source_system  TEXT NOT NULL,
  tenant         TEXT NOT NULL,
  matter_id      TEXT NOT NULL,
  kind           TEXT NOT NULL,
  active         INTEGER NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_matter_refresh_roster_active
  ON matter_refresh_roster(active, kind, matter_id);

CREATE TABLE IF NOT EXISTS matter_refresh_state (
  matter_key                 TEXT PRIMARY KEY,
  last_attempt_at            TEXT,
  last_complete_refresh_at   TEXT,
  acquisition_status         TEXT NOT NULL,
  cursor_json                TEXT,
  retry_after                TEXT,
  due_at                     TEXT,
  visit_seq                  INTEGER NOT NULL DEFAULT 0,
  failure_count              INTEGER NOT NULL DEFAULT 0,
  last_error                 TEXT,
  in_flight_run_id           TEXT
);

CREATE INDEX IF NOT EXISTS idx_matter_refresh_state_due
  ON matter_refresh_state(due_at, visit_seq, last_attempt_at);

CREATE TABLE IF NOT EXISTS matter_refresh_run (
  run_id         TEXT PRIMARY KEY,
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  status         TEXT NOT NULL,
  attempted      INTEGER NOT NULL,
  retained       INTEGER NOT NULL,
  deferred       INTEGER NOT NULL,
  failed         INTEGER NOT NULL,
  request_count  INTEGER NOT NULL,
  receipt_json   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS matter_refresh_lock (
  lock_id      TEXT PRIMARY KEY,
  run_id       TEXT,
  acquired_at  TEXT
);
