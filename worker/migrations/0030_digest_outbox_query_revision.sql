-- Query-revision columns for precise-watch edit continuity.
--
-- Queued membership belongs to a watch and an expression revision. An edit that
-- changes the canonical text_query re-evaluates unsent rows for that watch
-- before provider submit. Cancelled membership keeps a structured reason in
-- suppression_json; last_error stays the short reason code so existing operator
-- and watch-removed cancels keep working. Delivered rows remain tombstones.
--
-- Additive and nullable: enqueue without a revision still succeeds. The
-- provider-submit cutoff is the last current-revision read after evaluation
-- and attach, immediately before reserveDeliveryOccasion + sendEmail.

ALTER TABLE digest_outbox_items ADD COLUMN query_revision TEXT;
ALTER TABLE digest_outbox_items ADD COLUMN suppression_json TEXT;
