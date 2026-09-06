-- Indexed matter-observation projection over immutable source_records.
-- Raw publisher and bootstrap payloads stay in source_records (migration 0008).
-- These tables are a revision-aware read model and repair receipts, not a
-- second raw evidence store. Rows are append-only; a later snapshot never
-- deletes a retained observation.

CREATE TABLE IF NOT EXISTS matter_observation_journal (
  observation_id         TEXT PRIMARY KEY,
  source_system          TEXT NOT NULL,
  tenant                 TEXT NOT NULL,
  matter_id              TEXT NOT NULL,
  event_id               TEXT NOT NULL,
  native_event_item_id   TEXT,
  publisher_action_id    TEXT,
  event_time             TEXT,
  observed_at            TEXT NOT NULL,
  acquired_at            TEXT NOT NULL,
  identity_granularity   TEXT NOT NULL,
  source_record_ref      TEXT NOT NULL,
  raw_payload_hash       TEXT NOT NULL,
  semantic_revision      TEXT NOT NULL,
  notice_references_json TEXT NOT NULL,
  title                  TEXT,
  action_name            TEXT,
  vote_binding_status    TEXT NOT NULL,
  vote_event_item_id     TEXT,
  provenance_json        TEXT NOT NULL,
  public_hearing_key     TEXT NOT NULL,
  superseded_by          TEXT,
  created_at             TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_matter_observation_matter
  ON matter_observation_journal(source_system, tenant, matter_id, event_id);

CREATE INDEX IF NOT EXISTS idx_matter_observation_hearing
  ON matter_observation_journal(public_hearing_key);

CREATE INDEX IF NOT EXISTS idx_matter_observation_item
  ON matter_observation_journal(native_event_item_id);

CREATE TABLE IF NOT EXISTS matter_observation_repair (
  repair_id          TEXT PRIMARY KEY,
  signature          TEXT NOT NULL UNIQUE,
  kind               TEXT NOT NULL,
  observed_at        TEXT NOT NULL,
  last_seen_at       TEXT NOT NULL,
  occurrence_count   INTEGER NOT NULL,
  last_good_generation TEXT,
  detail_json        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS matter_observation_generation (
  generation_id    TEXT PRIMARY KEY,
  status           TEXT NOT NULL,
  acquired_at      TEXT NOT NULL,
  source_vintage   TEXT,
  matter_count     INTEGER NOT NULL,
  appearance_count INTEGER NOT NULL,
  receipt_json     TEXT NOT NULL
);
