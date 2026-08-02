-- Example warehouse query seam (WH-01).
-- App path later: node warehouse/lib/query.mjs --sql-file warehouse/sql/examples/ocp_awards_by_agency.sql
-- Replaces live SODA fan-out for offline / batch analysis; Worker still serves cached read models.

SELECT
  agency_name,
  COUNT(*) AS award_count,
  ROUND(SUM(TRY_CAST(contract_amount AS DOUBLE)), 2) AS total_amount
FROM ocp_recent_contract_awards
GROUP BY 1
ORDER BY award_count DESC, agency_name;
