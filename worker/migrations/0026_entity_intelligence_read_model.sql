-- D1 keyed read model for entity intelligence.
-- Data is refreshed by tools/build_worker_d1_read_models.mjs during deployment.

CREATE TABLE IF NOT EXISTS entity_intelligence_meta (
  id TEXT PRIMARY KEY,
  generated_at TEXT,
  observation_count INTEGER NOT NULL,
  entity_count INTEGER NOT NULL,
  multi_domain_count INTEGER NOT NULL,
  summary_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entity_intelligence_entities (
  entity_ref TEXT PRIMARY KEY,
  kind TEXT,
  display_name TEXT,
  payload TEXT NOT NULL,
  payload_encoding TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entity_intelligence_subject_refs (
  subject_ref TEXT NOT NULL,
  entity_ref TEXT NOT NULL,
  relation TEXT NOT NULL,
  confidence TEXT NOT NULL,
  link_json TEXT NOT NULL,
  PRIMARY KEY (subject_ref, entity_ref, relation, confidence)
);

CREATE INDEX IF NOT EXISTS idx_entity_intelligence_subject_refs_subject
  ON entity_intelligence_subject_refs(subject_ref);

CREATE TABLE IF NOT EXISTS entity_intelligence_graph_links (
  to_ref TEXT NOT NULL,
  from_ref TEXT NOT NULL,
  link_type TEXT NOT NULL,
  link_json TEXT NOT NULL,
  PRIMARY KEY (to_ref, from_ref, link_type)
);

CREATE INDEX IF NOT EXISTS idx_entity_intelligence_graph_links_to
  ON entity_intelligence_graph_links(to_ref, link_type);
