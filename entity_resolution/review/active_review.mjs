// Read-only active-review ordering for the clerical entity-resolution trays.
// This ranks work; it never changes matcher decisions, thresholds, or links.

import { scorePair } from "../matchers/index.mjs";

export const ACTIVE_REVIEW_VERSION = "active_information_gain_v1";
export const REVIEW_THRESHOLD = 0.85;

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function recordIds(item) {
  return [item?.left?.id, item?.right?.id].map(String).filter(Boolean);
}

function conflictCount(features = {}, evidence = {}) {
  const featureConflicts = [
    "pin_epin_conflict", "contract_id_conflict", "hard_id_conflict",
    "legal_form_conflict", "agency_place_conflict",
  ].filter((key) => features[key] === true).length;
  const assertionConflicts = Array.isArray(evidence.assertion_interpretation?.conflicts)
    ? evidence.assertion_interpretation.conflicts.length
    : 0;
  return featureConflicts + assertionConflicts;
}

function componentSizes(items) {
  const parent = new Map();
  const find = (id) => {
    if (!parent.has(id)) parent.set(id, id);
    let root = parent.get(id);
    while (parent.get(root) !== root) root = parent.get(root);
    let current = id;
    while (parent.get(current) !== current) {
      const next = parent.get(current);
      parent.set(current, root);
      current = next;
    }
    return root;
  };
  const join = (left, right) => {
    const a = find(left); const b = find(right);
    if (a !== b) parent.set(a, b);
  };
  for (const item of items) {
    const ids = recordIds(item);
    if (ids.length === 2) join(ids[0], ids[1]);
  }
  const counts = new Map();
  for (const id of parent.keys()) {
    const root = find(id);
    counts.set(root, (counts.get(root) || 0) + 1);
  }
  return new Map([...parent.keys()].map((id) => [id, counts.get(find(id)) || 1]));
}

function priorityFor(item, componentSize) {
  const features = item.evidence?.comparison_features || {};
  const matcher = scorePair(item.left, item.right, features, { entityType: item.entity_type || "vendor" });
  const confidence = finite(matcher.confidence, finite(item.confidence, 0));
  const margin = Math.abs(REVIEW_THRESHOLD - confidence);
  const marginScore = Math.max(0, 1 - Math.min(1, margin / REVIEW_THRESHOLD));
  const conflicts = conflictCount(features, item.evidence);
  const conflictScore = Math.min(1, conflicts / 3);
  const fragmentationScore = Math.min(1, Math.max(0, componentSize - 1) / 4);
  const informationGain = Number((
    marginScore * 0.55 + conflictScore * 0.30 + fragmentationScore * 0.15
  ).toFixed(6));
  return {
    version: ACTIVE_REVIEW_VERSION,
    information_gain: informationGain,
    matcher: {
      decision: matcher.decision,
      confidence: matcher.confidence,
      method: matcher.method,
      margin: Number(margin.toFixed(6)),
      margin_score: Number(marginScore.toFixed(6)),
    },
    feature_conflict: {
      count: conflicts,
      score: Number(conflictScore.toFixed(6)),
    },
    component_fragmentation: {
      records: componentSize,
      score: Number(fragmentationScore.toFixed(6)),
    },
  };
}

/** Return both the active order and the pre-change FIFO order for measurement. */
export function rankActiveReviewItems(items = []) {
  const input = Array.isArray(items) ? items.filter(Boolean) : [];
  const components = componentSizes(input);
  // The caller supplies the pre-change queue order. This makes the baseline
  // explicit instead of reconstructing a potentially different FIFO policy.
  const baseline = [...input];
  const baselineRank = new Map(baseline.map((item, index) => [item.id, index]));
  return input.map((item) => ({
    item,
    baseline_rank: baselineRank.get(item.id) ?? input.length,
    priority: priorityFor(item, Math.max(
      components.get(String(item?.left?.id)) || 1,
      components.get(String(item?.right?.id)) || 1,
    )),
  })).sort((a, b) => b.priority.information_gain - a.priority.information_gain
    || a.baseline_rank - b.baseline_rank
    || String(a.item.id).localeCompare(String(b.item.id)));
}

export function activeReviewItems(items = []) {
  return rankActiveReviewItems(items).map(({ item, baseline_rank, priority }, active_rank) => ({
    ...item,
    review_priority: priority,
    review_order: { strategy: ACTIVE_REVIEW_VERSION, active_rank, baseline_rank },
  }));
}
