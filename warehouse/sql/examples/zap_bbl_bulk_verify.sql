-- WH-06 verifying query for ZAP BBL full pack.
-- Expect: row_count >> fixture; distinct projects and BBLs non-null.

SELECT
  COUNT(*) AS row_count,
  COUNT(DISTINCT project_id) AS distinct_projects,
  COUNT(DISTINCT CAST(bbl AS VARCHAR)) AS distinct_bbls,
  SUM(CASE WHEN CAST(bbl AS VARCHAR) IS NULL OR CAST(bbl AS VARCHAR) = '' THEN 1 ELSE 0 END) AS null_bbl_count
FROM zap_bbl;
