-- Durable, transactional checkpoints for bounded D1 read-model publication.
-- Each marker is committed in the same D1 import transaction as its batch.

CREATE TABLE IF NOT EXISTS d1_publication_batches (
  batch_id TEXT PRIMARY KEY,
  checkpoint_id TEXT NOT NULL UNIQUE,
  generation INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  model_id TEXT NOT NULL,
  partition_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  op_count INTEGER NOT NULL,
  estimated_application_writes INTEGER NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_d1_publication_batches_generation
  ON d1_publication_batches(generation, model_id, partition_id, ordinal);
