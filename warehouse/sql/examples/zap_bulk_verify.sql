-- WH-05 verifying query for ZAP projects full pack.
-- Expect: row_count >> WH-01 fixture (5); boroughs and public_status non-null.

SELECT
  COUNT(*) AS row_count,
  COUNT(DISTINCT project_id) AS distinct_projects,
  COUNT(DISTINCT borough) AS borough_count,
  COUNT(DISTINCT public_status) AS public_status_count,
  SUM(CASE WHEN CAST(ulurp_non AS VARCHAR) = 'ULURP' THEN 1 ELSE 0 END) AS ulurp_count
FROM zap_projects;
