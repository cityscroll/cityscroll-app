-- Resolution-run provenance and append-only link supersession lineage.
-- 0009 is retained as the fresh-database definition; these ALTERs upgrade
-- databases that already applied er-07.

ALTER TABLE resolution_run ADD COLUMN model_artifact_hash TEXT;
ALTER TABLE resolution_run ADD COLUMN gold_version TEXT;
ALTER TABLE resolution_run ADD COLUMN feature_version TEXT;
ALTER TABLE resolution_run ADD COLUMN blocking_version TEXT;
ALTER TABLE resolution_run ADD COLUMN policy_version TEXT;
ALTER TABLE resolution_run ADD COLUMN watermarks_json TEXT;
ALTER TABLE resolution_run ADD COLUMN provenance_json TEXT;
ALTER TABLE entity_link ADD COLUMN supersedes_link_id TEXT REFERENCES entity_link(id);
ALTER TABLE entity_link ADD COLUMN supersession_reason TEXT;

CREATE TABLE IF NOT EXISTS entity_link_supersession (
  id                  TEXT PRIMARY KEY,
  superseding_link_id TEXT NOT NULL REFERENCES entity_link(id),
  superseded_link_id  TEXT NOT NULL REFERENCES entity_link(id),
  reason              TEXT NOT NULL,
  resolution_run_id   TEXT REFERENCES resolution_run(id),
  created_at          TEXT NOT NULL,
  UNIQUE (superseding_link_id, superseded_link_id)
);
CREATE INDEX IF NOT EXISTS idx_entity_link_supersession_new
  ON entity_link_supersession(superseding_link_id);
CREATE INDEX IF NOT EXISTS idx_entity_link_supersession_old
  ON entity_link_supersession(superseded_link_id);
