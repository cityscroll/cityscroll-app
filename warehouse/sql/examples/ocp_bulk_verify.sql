-- WH-02 verifying query for OCP Recent Contract Awards full pack.
-- Expect: row_count >> WH-01 fixture (5); agencies and date span non-null.

SELECT
  COUNT(*) AS row_count,
  COUNT(DISTINCT agency_name) AS agency_count,
  COUNT(DISTINCT pin) AS distinct_pins,
  MIN(CAST(start_date AS DATE)) AS min_start_date,
  MAX(CAST(start_date AS DATE)) AS max_start_date
FROM ocp_recent_contract_awards;
