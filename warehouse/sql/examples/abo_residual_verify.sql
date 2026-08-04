-- RC-4 proof: the measured bridge is below threshold and publishes no edge.
SELECT
  m.total,
  m.joined,
  m.join_rate,
  m.fuzzy_precision,
  m.ambiguous,
  m.gate_status,
  m.materialize,
  (SELECT count(*) FROM abo_residual_notice) AS residual_notices,
  (SELECT count(*) FROM abo_residual_candidate) AS reviewed_candidates,
  (SELECT count(*) FROM abo_residual_match) AS materialized_matches
FROM abo_residual_measurement m;
