-- Shadow-only semantic events for ontology inventory transitions.
-- A stable transition key makes repeated rehearsals idempotent before promotion.

CREATE TABLE IF NOT EXISTS ontology_delta_shadow_events (
  transition_key TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  dimension TEXT NOT NULL,
  value TEXT NOT NULL,
  first_observed_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  observation_count INTEGER NOT NULL DEFAULT 1,
  event_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ontology_delta_shadow_events_observed
  ON ontology_delta_shadow_events(first_observed_at DESC);
