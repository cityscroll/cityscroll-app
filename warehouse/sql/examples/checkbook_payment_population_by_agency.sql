-- AP-08: independent Checkbook payment population, not the bounded graph collector.
SELECT
  agency,
  COUNT(*) AS transaction_count,
  ROUND(SUM(check_amount), 2) AS net_check_amount
FROM checkbook_payment_population
GROUP BY agency
ORDER BY net_check_amount DESC;
