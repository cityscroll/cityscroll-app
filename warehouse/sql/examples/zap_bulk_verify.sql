-- WH-05 / cs-pred-08 verifying query for ZAP projects full pack.
-- Expect: row_count >> WH-01 fixture (5), milestone min/max dates, and
-- certification→final-date pairs for duration fitting.

SELECT
  COUNT(*) AS row_count,
  COUNT(DISTINCT project_id) AS distinct_projects,
  COUNT(DISTINCT borough) AS borough_count,
  COUNT(DISTINCT public_status) AS public_status_count,
  SUM(CASE WHEN CAST(ulurp_non AS VARCHAR) = 'ULURP' THEN 1 ELSE 0 END) AS ulurp_count,
  COUNT(current_milestone_date) AS current_milestone_date_count,
  MIN(current_milestone_date) AS current_milestone_date_min,
  MAX(current_milestone_date) AS current_milestone_date_max,
  COUNT(current_envmilestone_date) AS current_envmilestone_date_count,
  MIN(current_envmilestone_date) AS current_envmilestone_date_min,
  MAX(current_envmilestone_date) AS current_envmilestone_date_max,
  COUNT(certified_referred) AS certified_referred_count,
  MIN(certified_referred) AS certified_referred_min,
  MAX(certified_referred) AS certified_referred_max,
  COUNT(approval_date) AS approval_date_count,
  MIN(approval_date) AS approval_date_min,
  MAX(approval_date) AS approval_date_max,
  SUM(
    CASE
      WHEN certified_referred IS NOT NULL
       AND (approval_date IS NOT NULL OR completed_date IS NOT NULL)
      THEN 1 ELSE 0
    END
  ) AS certification_to_final_date_pairs
FROM zap_projects;
