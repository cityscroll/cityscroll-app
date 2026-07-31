// entity_resolution/evaluation — package slot for metrics + gold (er-04).
//
// The offline harness and gold files live under entity_resolution/eval/
// (historical path from er-04). This module re-exports the pure helpers so
// package consumers can import from evaluation/ without knowing the harness CLI.

export {
  loadGold,
  loadPredictions,
  loadCandidates,
  computeMetrics,
} from "../eval/run_metrics.mjs";

/** Package-relative path to the v0 gold set (repo root as cwd). */
export const GOLD_V0_PATH = "entity_resolution/eval/gold_v0.jsonl";
