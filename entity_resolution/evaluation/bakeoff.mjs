// Pure bake-off measurements. This module consumes scorer outputs and never
// routes links, updates policy, or materializes canonical entities.

import { extractFeatures, FEATURES_VERSION } from "../features/index.mjs";
import { scoreCandidatePairs, scorerIdentity } from "../scorers/index.mjs";
import { routeDecision } from "../policies/index.mjs";

export const BAKEOFF_SCHEMA_VERSION = 1;
export const BAKEOFF_VERSION = "er_scorer_bakeoff_v1";

export const CALIBRATION_BANDS = Object.freeze([
  { id: "0.00-0.50", min: 0, max: 0.5, includeMax: false },
  { id: "0.50-0.75", min: 0.5, max: 0.75, includeMax: false },
  { id: "0.75-0.90", min: 0.75, max: 0.9, includeMax: false },
  { id: "0.90-0.95", min: 0.9, max: 0.95, includeMax: false },
  { id: "0.95-0.99", min: 0.95, max: 0.99, includeMax: false },
  { id: "0.99-1.00", min: 0.99, max: 1, includeMax: true },
]);

function rate(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function nodeId(side = {}) {
  const durable = Array.of(side.source_record_id, side.native_key, side.source_system_id)
    .map(clean)
    .find(Boolean);
  if (durable) return `${clean(side.source_system || "source")}:${durable}`;
  return `${clean(side.source_system || "source")}:${clean(side.display_name)}`;
}

function components(ids, links) {
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (id) => {
    if (parent.get(id) !== id) parent.set(id, find(parent.get(id)));
    return parent.get(id);
  };
  for (const [left, right] of links) {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent.set(b, a.localeCompare(a) <= 0 ? a : b);
  }
  const groups = new Map();
  for (const id of ids) {
    const root = find(id);
    const group = groups.get(root) || [];
    group.push(id);
    groups.set(root, group);
  }
  return [...groups.values()].map((group) => group.sort());
}

function decisionFor(score, row, threshold) {
  const explicit = score?.evidence?.decision;
  const proposed = ["same", "different", "unresolved"].includes(explicit)
    ? explicit
    : score.probability >= threshold ? "same" : "unresolved";
  return routeDecision({
    decision: proposed,
    confidence: score.probability,
    method: score?.evidence?.method,
  }, {
    left: row.left,
    right: row.right,
    entityType: row.entity_type,
  }).decision;
}

export function candidatePairsForGold(cases, candidateIds = null) {
  return cases
    .filter((row) => !candidateIds || candidateIds.has(row.id))
    .map((row) => ({
      pair_id: row.id,
      entity_type: row.entity_type,
      label: row.label,
      left: row.left,
      right: row.right,
      features: extractFeatures(row.left, row.right, { entityType: row.entity_type }),
    }));
}

export function scoreGoldWithScorer(cases, candidateIds, scorer) {
  const candidatePairs = candidatePairsForGold(cases, candidateIds);
  return scoreCandidatePairs({
    features_version: FEATURES_VERSION,
    candidate_pairs: candidatePairs,
  }, scorer);
}

export function calibrationByBand(cases, scores) {
  const labels = new Map(cases.map((row) => [row.id, row.label === "same"]));
  return CALIBRATION_BANDS.map((band) => {
    const rows = scores.filter((score) => {
      const probability = score.probability;
      return probability >= band.min && (band.includeMax ? probability <= band.max : probability < band.max);
    });
    const correct = rows.filter((score) => labels.get(score.pair_id) === true).length;
    const meanScore = rows.length
      ? rows.reduce((sum, row) => sum + row.probability, 0) / rows.length
      : null;
    const empiricalMatchRate = rate(correct, rows.length);
    return {
      band: band.id,
      min: band.min,
      max: band.max,
      n: rows.length,
      correct_matches: correct,
      mean_score: meanScore,
      empirical_match_rate: empiricalMatchRate,
      calibration_error: meanScore == null || empiricalMatchRate == null
        ? null
        : empiricalMatchRate - meanScore,
    };
  });
}

function pairMetrics(cases, scores, candidateIds, threshold) {
  const scoreMap = new Map(scores.map((score) => [score.pair_id, score]));
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let unresolved = 0;
  let goldSame = 0;
  let retainedSame = 0;
  for (const row of cases) {
    const score = scoreMap.get(row.id);
    const decision = score ? decisionFor(score, row, threshold) : "unresolved";
    if (decision === "unresolved") unresolved += 1;
    if (row.label === "same") {
      goldSame += 1;
      if (candidateIds?.has(row.id)) retainedSame += 1;
      if (decision === "same") tp += 1;
      else fn += 1;
    } else if (decision === "same") {
      fp += 1;
    }
  }
  return {
    precision: rate(tp, tp + fp),
    recall: rate(tp, tp + fn),
    candidate_recall: candidateIds ? rate(retainedSame, goldSame) : null,
    unresolved_rate: rate(unresolved, cases.length),
    true_positive: tp,
    false_positive: fp,
    false_negative: fn,
    false_merge: fp,
    false_split: fn,
    threshold,
  };
}

export function clusterMetrics(cases, scores, threshold) {
  const scoreMap = new Map(scores.map((score) => [score.pair_id, score]));
  const ids = [];
  const truthLinks = [];
  const predictedLinks = [];
  for (const row of cases) {
    const left = nodeId(row.left);
    const right = nodeId(row.right);
    ids.push(left, right);
    if (row.label === "same") truthLinks.push([left, right]);
    const score = scoreMap.get(row.id);
    if (score && decisionFor(score, row, threshold) === "same") predictedLinks.push([left, right]);
  }
  const truth = components([...new Set(ids)], truthLinks).filter((group) => group.length > 1);
  const predicted = components([...new Set(ids)], predictedLinks);
  const predictedByNode = new Map();
  predicted.forEach((group, index) => group.forEach((id) => predictedByNode.set(id, index)));
  const fragmented = truth.filter((group) => new Set(group.map((id) => predictedByNode.get(id))).size > 1);
  const violations = cases.filter((row) => row.label === "different" &&
    predictedByNode.get(nodeId(row.left)) === predictedByNode.get(nodeId(row.right)));
  const predictedMulti = predicted.filter((group) => group.length > 1);
  return {
    reference_clusters: truth.length,
    fragmented_reference_clusters: fragmented.length,
    cluster_fragmentation_rate: rate(fragmented.length, truth.length),
    predicted_multi_record_clusters: predictedMulti.length,
    constraint_violations: violations.length,
    constraint_violation_rate: rate(violations.length, cases.filter((row) => row.label === "different").length),
    violated_case_ids: violations.map((row) => row.id).sort(),
  };
}

export function evaluateScorer({
  cases = [],
  candidateIds = null,
  scores = [],
  scorer = null,
  threshold = 0.9,
  incrementalConsistency = null,
  trainingOverlap = false,
} = {}) {
  const metrics = pairMetrics(cases, scores, candidateIds, threshold);
  return {
    status: "measured",
    scorer: scorer ? scorerIdentity(scorer) : null,
    metrics,
    calibration: calibrationByBand(cases, scores),
    clusters: clusterMetrics(cases, scores, threshold),
    score_count: scores.length,
    training_overlap: Boolean(trainingOverlap),
    incremental_consistency: incrementalConsistency || {
      supported: Boolean(scorer?.supports_incremental),
      status: scorer?.supports_incremental ? "not_supplied" : "not_supported",
    },
    scores,
  };
}

export function unavailableContender(name, reason) {
  return {
    status: "not_run",
    scorer: { name },
    reason,
    metrics: null,
    calibration: CALIBRATION_BANDS.map((band) => ({ band: band.id, n: 0 })),
    clusters: null,
    incremental_consistency: { supported: null, status: "not_run" },
    scores: [],
  };
}

export function buildBakeoffReport({
  gold,
  contentHash,
  candidateIds,
  blocker = "token_v0",
  threshold = 0.9,
  contenders = [],
} = {}) {
  const baseline = contenders.find((row) => row.scorer?.name === "conventional_v2");
  const saturated = Boolean(
    baseline?.status === "measured" &&
    baseline.metrics?.precision === 1 &&
    baseline.metrics?.recall === 1,
  );
  const measured = contenders.filter((row) => row.status === "measured");
  return {
    kind: "entity_resolution_scorer_bakeoff",
    bakeoff_version: BAKEOFF_VERSION,
    schema_version: BAKEOFF_SCHEMA_VERSION,
    gold: {
      version: gold.meta.gold_version,
      schema_version: gold.meta.schema_version,
      case_count: gold.cases.length,
      content_hash: contentHash,
      composition: gold.cases.reduce((out, row) => {
        out.by_label[row.label] = (out.by_label[row.label] || 0) + 1;
        out.by_entity_type[row.entity_type] = (out.by_entity_type[row.entity_type] || 0) + 1;
        return out;
      }, { by_label: {}, by_entity_type: {} }),
    },
    candidate_generation: {
      blocker,
      retained_pairs: candidateIds ? candidateIds.size : null,
      gold_same: gold.cases.filter((row) => row.label === "same").length,
    },
    decision_policy: {
      threshold,
      explicit_scorer_decision_precedes_threshold: true,
      production_policy_unchanged: true,
    },
    contenders,
    honesty: {
      gold_is_small: gold.cases.length < 100,
      baseline_pair_metrics_saturated: saturated,
      discriminating_ground: ["unresolved_band", "calibration", "incremental_semantics"],
      no_winner_declared_on_saturated_metrics: saturated,
      measured_contender_count: measured.length,
    },
    recommendation: saturated
      ? {
        decision: "insufficient_evidence",
        text: "Do not switch the production scorer from this bake-off. The 56-case gold set saturates the baseline pair metrics; extend gold with labeled candidates from the unresolved clerical-review stratum, then compare calibration and incremental behavior.",
      }
      : {
        decision: "review_measured_results",
        text: "Review measured contenders against calibration, false merges, false splits, and incremental consistency before changing production scoring.",
      },
  };
}

export function renderBakeoffSummary(report) {
  const rows = report.contenders.map((contender) => {
    if (contender.status !== "measured") {
      return `| ${contender.scorer?.name || "unknown"} | ${contender.status} | — | — | — | — | ${contender.reason || "—"} |`;
    }
    const m = contender.metrics;
    return `| ${contender.scorer.name} | measured | ${m.precision ?? "—"} | ${m.recall ?? "—"} | ${m.unresolved_rate ?? "—"} | ${m.false_merge} | ${m.false_split} |`;
  }).join("\n");
  const calibration = report.contenders
    .filter((contender) => contender.status === "measured")
    .map((contender) => `### ${contender.scorer.name}

| Band | N | Mean score | Empirical match rate | Calibration error |
| --- | ---: | ---: | ---: | ---: |
${contender.calibration
  .map((row) => `| ${row.band} | ${row.n} | ${row.mean_score ?? "—"} | ${row.empirical_match_rate ?? "—"} | ${row.calibration_error ?? "—"} |`)
  .join("\n")}`)
    .join("\n\n");
  return `# Entity-resolution scorer bake-off ${report.bakeoff_version}

Gold **${report.gold.version}** contains **${report.gold.case_count}** labeled pairs. Candidate blocker: **${report.candidate_generation.blocker}**. The production policy and link-not-merge behavior were not changed.

## Comparison

| Scorer | Status | Precision | Recall | Unresolved | False merges | False splits |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
${rows}

## Calibration by score band

The conventional scorer's fixed confidences are shown as scores, not treated as calibrated probabilities. \`empirical_match_rate\` is the observed share of gold-same pairs in each band.

${calibration}

## Recommendation

**${report.recommendation.decision}** — ${report.recommendation.text}

The next discriminating sample should come from the unresolved band through the existing clerical-review path. Record the gold version, feature version, blocker version, scorer artifact hash, and config hash with every rerun.
`;
}
