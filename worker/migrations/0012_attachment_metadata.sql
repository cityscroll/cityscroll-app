-- T0 attachment metadata. Binary files remain at City Record; this table stores
-- only the discovery metadata produced by the host-side batch collector.
CREATE TABLE IF NOT EXISTS notice_attachments (
  request_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  title TEXT,
  url TEXT NOT NULL,
  content_type TEXT,
  bytes INTEGER,
  source TEXT NOT NULL CHECK (source IN ('dataset', 'portal')),
  observed_at TEXT NOT NULL,
  PRIMARY KEY (request_id, document_id)
);

CREATE INDEX IF NOT EXISTS idx_notice_attachments_request
  ON notice_attachments(request_id);

CREATE TABLE IF NOT EXISTS attachment_ingest_receipts (
  run_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  notices_seen INTEGER NOT NULL,
  notices_scraped INTEGER NOT NULL,
  attachments_found INTEGER NOT NULL,
  source_cliff_policy TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE VIEW IF NOT EXISTS notice_attachment_rollup AS
SELECT
  request_id,
  COUNT(*) AS n_attachments,
  json_group_array(json_object(
    'request_id', request_id,
    'document_id', document_id,
    'title', title,
    'url', url,
    'content_type', content_type,
    'bytes', bytes,
    'source', source
  )) AS attachments_json
FROM notice_attachments
GROUP BY request_id;
