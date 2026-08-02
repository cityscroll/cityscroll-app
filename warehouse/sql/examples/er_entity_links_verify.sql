-- WH-04 verifying query: batch ER entity links joined to OCP awards (vendor spine).
-- Run after:
--   warehouse/.venv/bin/python warehouse/scripts/er_batch_run.py --from-fixture --limit 25 --force-headroom
--
-- warehouse/.venv/bin/python warehouse/scripts/query.py \
--   --sql-file warehouse/sql/examples/er_entity_links_verify.sql
--
-- Companion counts (run separately if needed):
--   SELECT COUNT(*) FROM er_entity_link;
--   SELECT COUNT(*) FROM er_canonical_entity;
--   SELECT canonical_entity_id, COUNT(*) AS n FROM er_entity_link
--     WHERE entity_type = 'vendor' GROUP BY 1 HAVING COUNT(*) >= 2;

SELECT
  l.canonical_entity_id,
  COUNT(DISTINCT l.source_record_id) AS source_records,
  COUNT(*) AS link_rows,
  MIN(l.method) AS sample_method,
  MIN(l.confidence) AS min_confidence,
  MAX(l.confidence) AS max_confidence
FROM er_entity_link l
WHERE l.decision = 'auto_link'
  AND l.entity_type = 'vendor'
GROUP BY 1
ORDER BY source_records DESC, l.canonical_entity_id
LIMIT 30;
