-- Durable append store for civic-time event envelopes (shared clocks + kinds).
-- Writes are gated by env CIVIC_TIME_EVENT_WRITE === "true" (default off).
-- Flag off keeps the pure adapter seam only: no table consumers, no public reads.
-- Idempotent on event_id (subject + kind + source_revision). Source-null clocks stay null.

CREATE TABLE IF NOT EXISTS civic_time_events (
  event_id              TEXT PRIMARY KEY,
  schema_version        INTEGER NOT NULL,
  subject_ref           TEXT NOT NULL,
  event_kind            TEXT NOT NULL,
  valid_at              TEXT,
  valid_from            TEXT,
  valid_to              TEXT,
  published_at          TEXT,
  observed_at           TEXT,
  processed_at          TEXT,
  source_record_ref     TEXT NOT NULL,
  source_revision       TEXT NOT NULL,
  payload_hash          TEXT NOT NULL,
  materializer_name     TEXT NOT NULL,
  materializer_version  TEXT NOT NULL,
  run_id                TEXT NOT NULL,
  status                TEXT,
  confidence            REAL,
  supersedes_event_id   TEXT,
  source_field          TEXT,
  envelope_json         TEXT NOT NULL,
  written_at            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_civic_time_events_subject
  ON civic_time_events(subject_ref, event_kind);

CREATE INDEX IF NOT EXISTS idx_civic_time_events_kind
  ON civic_time_events(event_kind);

CREATE INDEX IF NOT EXISTS idx_civic_time_events_source
  ON civic_time_events(source_record_ref, source_revision);
