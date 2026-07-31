-- Entity resolution schema sketch (unapplied).
-- Authoritative decision record: docs/adr/entity-resolution-taxonomy.md
-- DO NOT apply to production D1 until a dual-write card lands a real migration.
-- Dialect: SQLite / Cloudflare D1.
--
-- Core tables:
--   source_record, canonical_entity, entity_link, candidate_pair, resolution_run
-- entity_link carries decision, confidence, method (plus matcher_version, evidence).

CREATE TABLE IF NOT EXISTS resolution_run (
  id               TEXT PRIMARY KEY,
  method           TEXT NOT NULL,
  matcher_version  TEXT NOT NULL,
  config_hash      TEXT,
  entity_type      TEXT,
  scope_note       TEXT,
  started_at       TEXT NOT NULL,
  finished_at      TEXT,
  metrics_json     TEXT,
  status           TEXT NOT NULL DEFAULT 'running'
);

CREATE TABLE IF NOT EXISTS source_record (
  id               TEXT PRIMARY KEY,
  source_system    TEXT NOT NULL,
  native_key       TEXT NOT NULL,
  entity_type_hint TEXT,
  raw_json         TEXT NOT NULL,
  normalized_json  TEXT,
  content_hash     TEXT NOT NULL,
  observed_at      TEXT,
  ingested_at      TEXT NOT NULL,
  UNIQUE (source_system, native_key, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_source_record_system_key
  ON source_record(source_system, native_key);
CREATE INDEX IF NOT EXISTS idx_source_record_hash
  ON source_record(content_hash);

CREATE TABLE IF NOT EXISTS canonical_entity (
  id               TEXT PRIMARY KEY,
  entity_type      TEXT NOT NULL,
  display_name     TEXT NOT NULL,
  attrs_json       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_canonical_entity_type
  ON canonical_entity(entity_type);

CREATE TABLE IF NOT EXISTS entity_link (
  id                  TEXT PRIMARY KEY,
  source_record_id    TEXT NOT NULL REFERENCES source_record(id),
  canonical_entity_id TEXT,
  decision            TEXT NOT NULL,
  confidence          REAL,
  method              TEXT NOT NULL,
  matcher_version     TEXT NOT NULL,
  evidence_json       TEXT,
  resolution_run_id   TEXT REFERENCES resolution_run(id),
  review_status       TEXT,
  created_at          TEXT NOT NULL,
  UNIQUE (source_record_id, method, matcher_version, decision, canonical_entity_id)
);
CREATE INDEX IF NOT EXISTS idx_entity_link_canonical
  ON entity_link(canonical_entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_link_decision
  ON entity_link(decision);
CREATE INDEX IF NOT EXISTS idx_entity_link_run
  ON entity_link(resolution_run_id);

CREATE TABLE IF NOT EXISTS candidate_pair (
  id                TEXT PRIMARY KEY,
  resolution_run_id TEXT NOT NULL REFERENCES resolution_run(id),
  left_source_id    TEXT NOT NULL REFERENCES source_record(id),
  right_source_id   TEXT NOT NULL REFERENCES source_record(id),
  blocking_key      TEXT,
  score             REAL,
  features_json     TEXT,
  created_at        TEXT NOT NULL,
  UNIQUE (resolution_run_id, left_source_id, right_source_id)
);
CREATE INDEX IF NOT EXISTS idx_candidate_pair_run
  ON candidate_pair(resolution_run_id);
CREATE INDEX IF NOT EXISTS idx_candidate_pair_block
  ON candidate_pair(blocking_key);
