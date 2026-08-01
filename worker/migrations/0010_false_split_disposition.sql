-- Append-only operator dispositions for false-split evidence review (er-14).
-- These events are desk evidence only: they do not update entity_link or merge records.

CREATE TABLE IF NOT EXISTS false_split_disposition_event (
  id                TEXT PRIMARY KEY,
  pair_id           TEXT NOT NULL,
  left_record_id    TEXT NOT NULL,
  right_record_id   TEXT NOT NULL,
  actor             TEXT NOT NULL,
  decision          TEXT NOT NULL CHECK (decision IN ('same', 'different', 'defer')),
  note              TEXT,
  evidence_version  TEXT NOT NULL,
  evidence_json     TEXT NOT NULL,
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_false_split_disposition_pair
  ON false_split_disposition_event(pair_id, created_at);

CREATE TRIGGER IF NOT EXISTS false_split_disposition_no_update
BEFORE UPDATE ON false_split_disposition_event
BEGIN
  SELECT RAISE(ABORT, 'false_split_disposition_event is append-only');
END;

CREATE TRIGGER IF NOT EXISTS false_split_disposition_no_delete
BEFORE DELETE ON false_split_disposition_event
BEGIN
  SELECT RAISE(ABORT, 'false_split_disposition_event is append-only');
END;
