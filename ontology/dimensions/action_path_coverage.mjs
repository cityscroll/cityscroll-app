// Dimension: action-path
// Evidence-measurement of grounded Action Path coverage. Emits cards only for
// policy violations (cross-board inference, broad fallback, synthetic coverage,
// unknown-as-zero). Missing actions are valid and are not queued as defects.

import { makeDimensionCard } from "./shared.mjs";
import {
  ACTION_PATH_COVERAGE_DIMENSION,
  actionPathCoverageFindings,
  measureActionPathCoverage,
} from "../action_path_coverage.mjs";

export const DIMENSION_ID = ACTION_PATH_COVERAGE_DIMENSION;

function metricMap(receipt) {
  const out = {};
  for (const [key, cell] of Object.entries(receipt.metrics || {})) {
    out[key] = cell?.value ?? null;
    out[`${key}_basis`] = cell?.basis || "unknown";
  }
  out.classification_counts = Object.fromEntries(
    Object.entries(receipt.classifications || {}).map(([name, ids]) => [name, ids.length]),
  );
  out.cross_board_inference_violations = receipt.gate?.cross_board_inference_violations ?? 0;
  out.reward_button_density = false;
  return out;
}

/**
 * @param {object} input
 * @param {object[]} [input.action_path_coverage_rows]
 * @param {object} [input.action_path_coverage]
 */
export function evaluateActionPathCoverage(input = {}) {
  const rows = Array.isArray(input.action_path_coverage_rows)
    ? input.action_path_coverage_rows
    : Array.isArray(input.action_path_coverage?.rows)
      ? input.action_path_coverage.rows
      : [];
  const receipt = input.action_path_coverage?.schema
    ? input.action_path_coverage
    : measureActionPathCoverage(rows);
  const findings = rows.length
    ? actionPathCoverageFindings(receipt, { requireAllClasses: true })
    : [];

  const cards = [];
  const violations = Number(receipt.gate?.cross_board_inference_violations || 0);
  if (violations > 0) {
    cards.push(makeDimensionCard({
      dimension: DIMENSION_ID,
      slug: "cross-board-inference",
      title: "Stop Community Board policy inheritance across boards",
      rank_score: 95,
      evidence: {
        kind: "cross-board-inference",
        count: violations,
        rows: (receipt.rows || []).filter((row) => row.cross_board_inference).map((row) => row.id),
      },
      verify: "node --test test/action_path_coverage.test.mjs",
      demo_win: "Each board keeps only its own source-qualified participation path.",
      context: [
        "ontology/action_path_coverage.mjs",
        "site/community_board_participation.mjs",
      ],
      lesson_class: "action-path-cross-board-inference",
    }));
  }
  if (receipt.gate?.broad_fallback === true) {
    cards.push(makeDimensionCard({
      dimension: DIMENSION_ID,
      slug: "broad-fallback",
      title: "Remove unsupported Action Path broadening",
      rank_score: 94,
      evidence: { kind: "broad-fallback" },
      verify: "node --test test/action_path_coverage.test.mjs",
      demo_win: "A continuation stays on the exact subject or is omitted.",
      context: ["ontology/action_path_coverage.mjs", "site/action_path_v0.mjs"],
      lesson_class: "action-path-broad-fallback",
    }));
  }
  if (findings.some((row) => /unknown into zero|button density|synthetic/i.test(row.message))
    || receipt.gate?.synthetic_action_reward === true
    || receipt.reward_button_density === true) {
    cards.push(makeDimensionCard({
      dimension: DIMENSION_ID,
      slug: "synthetic-action-coverage",
      title: "Stop treating synthetic or dense action buttons as coverage",
      rank_score: 90,
      evidence: { kind: "synthetic-action-reward" },
      verify: "node --test test/action_path_coverage.test.mjs",
      demo_win: "Coverage stays grounded in retained targets, continuations, and current sources.",
      context: ["ontology/action_path_coverage.mjs"],
      lesson_class: "action-path-synthetic-coverage",
    }));
  }

  return {
    dimension: DIMENSION_ID,
    metrics: metricMap(receipt),
    cards,
    receipt,
  };
}
