-- Entity resolution decision tables (er-07).
-- Opt-in dual-write only: ENTITY_LINK_DUAL_WRITE === true enables the shadow
-- writer for exact-stem auto cases (method=vendor_stem_v1). No public consumer
-- reads these tables yet.
-- Dialect: SQLite / Cloudflare D1. Sketch origin: docs/entity-resolution/schema-sketch.sql
--
-- source_record_id is a soft reference (TEXT). Production City Record snapshots
-- live in source_records (er-02 composite PK); callers supply a stable id such as
-- city_record:<request_id>:<content_hash>. Hard FK omitted so the er-02 shape
-- can evolve without blocking link writes.

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
  source_record_id    TEXT NOT NULL,
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
CREATE INDEX IF NOT EXISTS idx_entity_link_source
  ON entity_link(source_record_id);
