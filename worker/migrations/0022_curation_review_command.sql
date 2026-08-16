-- Idempotency receipt for one authoritative curation-review command.
-- The referenced disposition and verdict are inserted before this row in the
-- same D1 batch; the batch is the all-or-nothing commit boundary.

CREATE TABLE IF NOT EXISTS curation_review_command (
  id                    TEXT PRIMARY KEY,
  schema_version        TEXT NOT NULL,
  pair_id               TEXT NOT NULL,
  assertion_id          TEXT NOT NULL,
  disposition_event_id  TEXT NOT NULL UNIQUE
    REFERENCES false_split_disposition_event(id),
  verdict_receipt_id    TEXT NOT NULL UNIQUE
    REFERENCES curation_verdict_receipt(id),
  payload_json          TEXT NOT NULL,
  created_at            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_curation_review_command_pair
  ON curation_review_command(pair_id, created_at);
CREATE INDEX IF NOT EXISTS idx_curation_review_command_assertion
  ON curation_review_command(assertion_id, created_at);

CREATE TRIGGER IF NOT EXISTS curation_review_command_no_update
BEFORE UPDATE ON curation_review_command
BEGIN
  SELECT RAISE(ABORT, 'curation_review_command is append-only');
END;

CREATE TRIGGER IF NOT EXISTS curation_review_command_no_delete
BEFORE DELETE ON curation_review_command
BEGIN
  SELECT RAISE(ABORT, 'curation_review_command is append-only');
END;
