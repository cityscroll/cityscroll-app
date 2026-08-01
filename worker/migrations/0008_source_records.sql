-- Immutable source-record snapshots for replayable entity-resolution inputs.
-- Each importer has an independent, off-by-default dual-write flag.
-- Stores full payloads for identity re-runs and content-hash based replay detection.

CREATE TABLE IF NOT EXISTS source_records (
  source_system      TEXT NOT NULL,
  source_system_id   TEXT NOT NULL,
  content_hash       TEXT NOT NULL,
  raw_snapshot       TEXT NOT NULL, -- publisher payload JSON
  normalized_snapshot TEXT NOT NULL, -- importer-normalized row JSON
  ingested_at        TEXT NOT NULL,
  PRIMARY KEY (source_system, source_system_id, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_source_records_source_lookup ON source_records(source_system, source_system_id);
