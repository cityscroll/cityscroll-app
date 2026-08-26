-- Registration timing projection proof.
-- Missing dates are excluded from the rate denominator and remain counted separately.
WITH dated AS (
  SELECT
    *,
    CASE
      WHEN start_date IS NOT NULL AND registration_date IS NOT NULL
        THEN date_diff('day', CAST(start_date AS DATE), CAST(registration_date AS DATE))
      ELSE NULL
    END AS lag_days
  FROM analytics_registered_contracts
),
grouped AS (
  SELECT
    COALESCE(agency, 'Unknown / not published') AS agency,
    COUNT(*) AS total_contract_count,
    COUNT(*) FILTER (WHERE lag_days IS NOT NULL) AS eligible_contract_count,
    COUNT(*) FILTER (WHERE lag_days IS NULL) AS missing_date_contract_count,
    COUNT(*) FILTER (WHERE lag_days > 0) AS retroactive_contract_count,
    COUNT(*) FILTER (WHERE lag_days <= 0) AS early_on_time_contract_count,
    quantile_disc(lag_days, 0.50) FILTER (WHERE lag_days IS NOT NULL) AS median_lag_days,
    quantile_disc(lag_days, 0.75) FILTER (WHERE lag_days IS NOT NULL) AS p75_lag_days,
    quantile_disc(lag_days, 0.90) FILTER (WHERE lag_days IS NOT NULL) AS p90_lag_days
  FROM dated
  GROUP BY agency
)
SELECT
  *,
  retroactive_contract_count::DOUBLE / NULLIF(eligible_contract_count, 0) AS retroactive_share,
  missing_date_contract_count::DOUBLE / NULLIF(total_contract_count, 0) AS missing_date_share
FROM grouped
ORDER BY retroactive_share DESC NULLS LAST, agency;
