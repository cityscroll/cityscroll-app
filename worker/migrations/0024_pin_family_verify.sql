-- Append-only operator verdicts for PIN-family Checkbook ↔ PASSPort review.
-- Desk evidence only: these events do not rewrite the public crosswalk.

CREATE TABLE IF NOT EXISTS pin_family_verify_event (
  id                TEXT PRIMARY KEY,
  pair_id           TEXT NOT NULL,
  checkbook_contract_id TEXT NOT NULL,
  passport_contract_id  TEXT NOT NULL,
  actor             TEXT NOT NULL,
  decision          TEXT NOT NULL CHECK (decision IN ('same_contract', 'related_instrument')),
  note              TEXT,
  evidence_version  TEXT NOT NULL,
  evidence_json     TEXT NOT NULL,
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pin_family_verify_pair
  ON pin_family_verify_event(pair_id, created_at);

CREATE TRIGGER IF NOT EXISTS pin_family_verify_no_update
BEFORE UPDATE ON pin_family_verify_event
BEGIN
  SELECT RAISE(ABORT, 'pin_family_verify_event is append-only');
END;

CREATE TRIGGER IF NOT EXISTS pin_family_verify_no_delete
BEFORE DELETE ON pin_family_verify_event
BEGIN
  SELECT RAISE(ABORT, 'pin_family_verify_event is append-only');
END;
