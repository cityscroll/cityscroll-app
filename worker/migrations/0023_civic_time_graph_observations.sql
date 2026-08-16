-- Append-only belief-time history for the bounded procurement-notice graph.
-- The civic-time writer flag gates writes. Exact notice→contract observations
-- retain prior versions; processing time is not a membership clock.

CREATE TABLE IF NOT EXISTS civic_time_graph_observations (
  observation_id             TEXT PRIMARY KEY,
  schema_version             TEXT NOT NULL,
  case_family                TEXT NOT NULL,
  root_ref                   TEXT NOT NULL,
  assertion_key              TEXT NOT NULL,
  link_type                  TEXT NOT NULL,
  from_ref                   TEXT NOT NULL,
  to_ref                     TEXT NOT NULL,
  source_record_ref          TEXT NOT NULL,
  source_revision            TEXT NOT NULL,
  written_at                 TEXT NOT NULL,
  supersedes_observation_id  TEXT,
  publication_tier           TEXT NOT NULL,
  observation_json           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_civic_time_graph_root
  ON civic_time_graph_observations(case_family, root_ref, written_at);

CREATE INDEX IF NOT EXISTS idx_civic_time_graph_assertion
  ON civic_time_graph_observations(root_ref, assertion_key, written_at);
