-- Precomputed subsidy lifecycle per notice (SUB-001).
-- Joins City Record notices to NYCIDA/Build NYC project records. The lifecycle is assembled
-- once and cached in D1, with stale values serving as harmless read-optimized materialization.
-- Rows are filled on demand and pre-warmed daily for recently ingested Award notices (bounded).

CREATE TABLE IF NOT EXISTS subsidy_lifecycle (
  request_id  TEXT PRIMARY KEY,
  agency      TEXT,
  lifecycle   TEXT,             -- JSON: { request_id, project, stage, join, company, place, money, documents, timeline }
  computed_at TEXT              -- ISO timestamp this entry was computed
);
CREATE INDEX IF NOT EXISTS idx_subsidy_lifecycle_agency ON subsidy_lifecycle(agency);
