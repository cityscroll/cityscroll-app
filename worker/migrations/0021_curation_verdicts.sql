-- Append-only backstage curation verdicts for entity-resolution edges.
-- Public readers do not query this relation.

CREATE TABLE IF NOT EXISTS curation_verdict_receipt (
  id                     TEXT PRIMARY KEY,
  schema_version         TEXT NOT NULL,
  actor                  TEXT NOT NULL,
  decision               TEXT NOT NULL CHECK (decision IN ('ACCEPT', 'REJECT', 'REVIEW')),
  target_kind            TEXT NOT NULL,
  target_id              TEXT NOT NULL,
  target_json            TEXT NOT NULL,
  evidence_refs_json     TEXT NOT NULL,
  model_version          TEXT NOT NULL,
  rule_version           TEXT NOT NULL,
  review_policy_json     TEXT NOT NULL,
  effect_json            TEXT NOT NULL,
  reverses_receipt_id    TEXT REFERENCES curation_verdict_receipt(id),
  created_at             TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_curation_verdict_target
  ON curation_verdict_receipt(target_kind, target_id, created_at);
CREATE INDEX IF NOT EXISTS idx_curation_verdict_reversal
  ON curation_verdict_receipt(reverses_receipt_id);

CREATE TRIGGER IF NOT EXISTS curation_verdict_no_update
BEFORE UPDATE ON curation_verdict_receipt
BEGIN
  SELECT RAISE(ABORT, 'curation_verdict_receipt is append-only');
END;

CREATE TRIGGER IF NOT EXISTS curation_verdict_no_delete
BEFORE DELETE ON curation_verdict_receipt
BEGIN
  SELECT RAISE(ABORT, 'curation_verdict_receipt is append-only');
END;
