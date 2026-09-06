-- Observed-revision baseline for exact Council-matter Following watches.
-- Confirmation writes the retained observations already present so preexisting
-- history cannot enqueue catch-up updates. Removal marks the row inactive;
-- a later refollow inserts a new active baseline.

CREATE TABLE IF NOT EXISTS matter_watch_baseline (
  baseline_id            TEXT PRIMARY KEY,
  watch_id               TEXT NOT NULL,
  subscriber_id          TEXT NOT NULL,
  matter_ref             TEXT NOT NULL,
  matter_scope_version   INTEGER NOT NULL,
  baseline_acquired_at   TEXT NOT NULL,
  observation_ids_json   TEXT NOT NULL,
  confirmed_at           TEXT NOT NULL,
  status                 TEXT NOT NULL,
  removed_at             TEXT,
  created_at             TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_matter_watch_active
  ON matter_watch_baseline(subscriber_id, matter_ref)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_matter_watch_watch_id
  ON matter_watch_baseline(watch_id);
