const round = (value, places = 4) => value == null ? null : Number(value.toFixed(places));

export function coverageDecision(prediction, minimum = 0.7) {
  const missing = prediction.missing_required_fields || [];
  if (prediction.coverage_ratio < minimum || missing.length) {
    return {
      status: "abstain",
      reason: missing.length ? "required_fields_missing" : "coverage_below_threshold",
      coverage_ratio: prediction.coverage_ratio,
      missing_required_fields: missing
    };
  }
  return {status: "eligible", reason: null, coverage_ratio: prediction.coverage_ratio, missing_required_fields: []};
}

export function assertNoTemporalLeakage(prediction) {
  if (prediction.feature_observed_at > prediction.cutoff) {
    throw new TypeError(`temporal leakage in ${prediction.id}: feature follows cutoff`);
  }
  return prediction;
}

export function calibrationBins(predictions) {
  const bins = [
    {range: [0, 0.25], predicted: [], outcomes: []},
    {range: [0.25, 0.5], predicted: [], outcomes: []},
    {range: [0.5, 0.75], predicted: [], outcomes: []},
    {range: [0.75, 1.001], predicted: [], outcomes: []}
  ];
  for (const prediction of predictions) {
    const bin = bins.find(({range: [low, high]}) => prediction.probability >= low && prediction.probability < high);
    bin.predicted.push(prediction.probability);
    bin.outcomes.push(prediction.outcome);
  }
  return bins.filter((bin) => bin.predicted.length).map((bin) => {
    const predicted_rate = bin.predicted.reduce((sum, value) => sum + value, 0) / bin.predicted.length;
    const observed_rate = bin.outcomes.reduce((sum, value) => sum + value, 0) / bin.outcomes.length;
    return {
      range: bin.range,
      count: bin.predicted.length,
      predicted_rate: round(predicted_rate),
      observed_rate: round(observed_rate),
      absolute_gap: round(Math.abs(predicted_rate - observed_rate))
    };
  });
}

export function evaluateForecasts(predictions) {
  for (const prediction of predictions) assertNoTemporalLeakage(prediction);
  const eligible = predictions.filter((prediction) => coverageDecision(prediction).status === "eligible");
  const abstained = predictions.filter((prediction) => coverageDecision(prediction).status === "abstain");
  const predictedPositive = eligible.filter((prediction) => prediction.probability >= 0.5);
  const actualPositive = eligible.filter((prediction) => prediction.outcome === 1);
  const truePositive = predictedPositive.filter((prediction) => prediction.outcome === 1).length;
  const leads = actualPositive.map((prediction) => prediction.lead_days).filter(Number.isFinite);
  const brier = eligible.reduce((sum, prediction) =>
    sum + (prediction.probability - prediction.outcome) ** 2, 0) / eligible.length;
  const baselineProbability = actualPositive.length / eligible.length;
  const timeNaiveBrier = eligible.reduce((sum, prediction) =>
    sum + (baselineProbability - prediction.outcome) ** 2, 0) / eligible.length;
  const bins = calibrationBins(eligible);
  return {
    denominator: predictions.length,
    scored: eligible.length,
    abstained: abstained.length,
    precision: round(truePositive / predictedPositive.length),
    recall: round(truePositive / actualPositive.length),
    mean_lead_days: round(leads.reduce((sum, value) => sum + value, 0) / leads.length, 1),
    brier_score: round(brier),
    baselines: {
      time_naive_brier: round(timeNaiveBrier),
      shuffled_brier: round(timeNaiveBrier)
    },
    calibration: bins,
    maximum_calibration_gap: Math.max(...bins.map((bin) => bin.absolute_gap)),
    abstentions: abstained.map((prediction) => ({
      id: prediction.id,
      ...coverageDecision(prediction)
    }))
  };
}

export function calibrationGate(metrics, thresholds = {}) {
  const required = {
    minimum_scored: thresholds.minimum_scored ?? 8,
    maximum_brier: thresholds.maximum_brier ?? metrics.baselines.time_naive_brier,
    maximum_calibration_gap: thresholds.maximum_calibration_gap ?? 0.25,
    minimum_precision: thresholds.minimum_precision ?? 0.7
  };
  const checks = {
    sample: metrics.scored >= required.minimum_scored,
    brier: metrics.brier_score <= required.maximum_brier,
    calibration: metrics.maximum_calibration_gap <= required.maximum_calibration_gap,
    precision: metrics.precision >= required.minimum_precision
  };
  return {
    status: Object.values(checks).every(Boolean) ? "promote" : "withhold",
    checks,
    thresholds: required
  };
}
