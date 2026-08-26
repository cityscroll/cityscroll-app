WITH dated AS (
  SELECT
    agency,
    CASE
      WHEN start_date IS NOT NULL AND registration_date IS NOT NULL
        THEN CAST(julianday(registration_date) - julianday(start_date) AS INTEGER)
      ELSE NULL
    END AS lag_days
  FROM contracts
),
ranked AS (
  SELECT
    agency,
    lag_days,
    ROW_NUMBER() OVER (PARTITION BY agency ORDER BY lag_days) AS lag_rank,
    COUNT(*) OVER (PARTITION BY agency) AS lag_count
  FROM dated
  WHERE lag_days IS NOT NULL
),
summary AS (
  SELECT
    agency,
    COUNT(*) AS total_contract_count,
    SUM(CASE WHEN lag_days IS NOT NULL THEN 1 ELSE 0 END) AS eligible_contract_count,
    SUM(CASE WHEN lag_days IS NULL THEN 1 ELSE 0 END) AS missing_date_contract_count,
    SUM(CASE WHEN lag_days > 0 THEN 1 ELSE 0 END) AS retroactive_contract_count,
    SUM(CASE WHEN lag_days <= 0 THEN 1 ELSE 0 END) AS early_on_time_contract_count
  FROM dated
  GROUP BY agency
),
percentiles AS (
  SELECT
    agency,
    MIN(CASE WHEN lag_rank >= CAST(0.50 * lag_count + 0.999999 AS INTEGER) THEN lag_days END) AS median_lag_days,
    MIN(CASE WHEN lag_rank >= CAST(0.75 * lag_count + 0.999999 AS INTEGER) THEN lag_days END) AS p75_lag_days,
    MIN(CASE WHEN lag_rank >= CAST(0.90 * lag_count + 0.999999 AS INTEGER) THEN lag_days END) AS p90_lag_days
  FROM ranked
  GROUP BY agency
)
SELECT
  summary.*,
  retroactive_contract_count * 1.0 / NULLIF(eligible_contract_count, 0) AS retroactive_share,
  missing_date_contract_count * 1.0 / NULLIF(total_contract_count, 0) AS missing_date_share,
  percentiles.median_lag_days,
  percentiles.p75_lag_days,
  percentiles.p90_lag_days
FROM summary
LEFT JOIN percentiles USING (agency)
ORDER BY agency;
