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

export {
  CLERICAL_AUDIT_SCHEMA_VERSION,
  buildClericalAudit,
  formatAuditJsonl,
  formatLabelSheet,
  parseLabelSheet,
  promoteLabelsToGold,
} from "../eval/clerical_audit.mjs";

/** Package-relative path to the v0 gold set (repo root as cwd). */
export const GOLD_V0_PATH = "entity_resolution/eval/gold_v0.jsonl";

export {
  AUTHORITY_LABEL,
  AUTHORITY_VERSION,
  buildAuthorityReport,
  computeAuthorityMetrics,
  deriveAuthorityCases,
  latestSourceRecords,
  loadSourceRecords,
  predictAuthorityCases,
} from "./authority.mjs";

/** Representative source_records rows for authority-harness characterization. */
export const AUTHORITY_FIXTURE_V0_PATH =
  "entity_resolution/eval/fixtures/source_records_authority_v0.jsonl";

export {
  DEFAULT_COMPONENT_SAMPLE_SIZE,
  ENTITY_COMPONENT_SCHEMA_VERSION,
  buildEntityComponentReport,
} from "./entity_components.mjs";
