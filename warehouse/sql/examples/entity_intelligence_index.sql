-- Warehouse entity-intelligence edge index (query shape).
--
-- Pure JS materializes the same columns into
-- warehouse/receipts/proof/wh_entity_intelligence_index_latest.json
-- (and the product lookup via tools/build_entity_intelligence.mjs).
-- When edge rows are registered as a DuckDB view (future parquet pack),
-- this query powers root → multi-domain fan-out without live SODA.
--
-- Fixture path (no DuckDB required):
--   node warehouse/lib/entity_intelligence_index.mjs --from-fixture --limit 200
--
-- Intended DuckDB usage (after edge parquet is registered as
-- entity_intelligence_edge):
--
--   warehouse/.venv/bin/python warehouse/scripts/query.py \
--     --sql-file warehouse/sql/examples/entity_intelligence_index.sql

-- Per-root coverage: how many domains and join-key edge types land on each entity.
SELECT
  root_ref,
  root_kind,
  COUNT(*) AS edge_count,
  COUNT(DISTINCT domain) AS domains_touched,
  COUNT(DISTINCT link_type) AS link_types,
  SUM(
    CASE
      WHEN link_type IN (
        'sited_on_parcel',
        'shares_authority_key',
        'references_contract',
        'payment_on_contract',
        'paid_to_vendor',
        'contract_published_by_agency'
      ) THEN 1
      ELSE 0
    END
  ) AS join_key_edges
FROM entity_intelligence_edge
GROUP BY 1, 2
ORDER BY domains_touched DESC, edge_count DESC, root_ref
LIMIT 40;

-- Example: Parks agency spine (money + land + rules + meetings + join keys)
-- SELECT link_type, domain, from_ref, to_ref, source_system, source_record_id
-- FROM entity_intelligence_edge
-- WHERE root_ref = 'agency:id:parks-and-recreation'
-- ORDER BY domain, link_type
-- LIMIT 50;
