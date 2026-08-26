-- Population-backed registered contract projection proof.
SELECT
  agency,
  COUNT(DISTINCT prime_contract_id) AS contract_count,
  SUM(original_registered_amount) AS sum_original,
  SUM(current_registered_amount) AS sum_current
FROM analytics_registered_contracts
GROUP BY agency
ORDER BY sum_current DESC;
