/**
 * Notice-context readiness boundary and grouped read-back.
 *
 * Primary owner work is the context host plus any attachment chip already on
 * the notice row. Flags, award, related-attachment, mandate, table, lookup,
 * and late attachment hydration are optional enrichments: they may continue
 * after the owner milestone and must not gate it. Production RUM keeps the
 * existing notice-context identity; branch timings are grouped separately and
 * never become record identifiers.
 */

export const NOTICE_CONTEXT_READINESS_SCHEMA = "cityscroll.notice_context_readiness.v1";
export const NOTICE_CONTEXT_READINESS_EVIDENCE_SCHEMA = "cityscroll.notice_context_readiness_evidence.v1";

export const NOTICE_CONTEXT_SURFACE_ID = "notice";
export const NOTICE_CONTEXT_COMPONENT_ID = "notice-context";
export const NOTICE_CONTEXT_PRIMARY_METRIC_ID = "component_ready_ms";
export const NOTICE_CONTEXT_BRANCH_METRIC_ID = "notice_context_branch_ms";

export const NOTICE_CONTEXT_SAMPLE_FLOOR = 30;
export const NOTICE_CONTEXT_P75_BUDGET_MS = 2500;
export const NOTICE_CONTEXT_P95_BUDGET_MS = 5000;

export const NOTICE_CONTEXT_PRIMARY_OWNERS = Object.freeze([
  "row-host",
  "already-available-attachment-chip",
]);

export const NOTICE_CONTEXT_OPTIONAL_BRANCHES = Object.freeze([
  "flags",
  "award",
  "related",
  "mandate",
  "tables",
]);

export const NOTICE_CONTEXT_OPTIONAL_LATE_OWNERS = Object.freeze([
  "attachment",
  "lookup",
]);

const PRIMARY_RESULT_STATES = new Set(["content", "empty", "unavailable", "error"]);
const FORBIDDEN_EVIDENCE_KEYS = Object.freeze([
  "request_id",
  "notice_id",
  "pathname",
  "url",
  "selector",
  "email",
]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function noticeContextPrimaryResultState(hasPrimaryHtml) {
  return hasPrimaryHtml ? "content" : "empty";
}

export function isNoticeContextOptionalBranch(label) {
  const value = String(label || "");
  return NOTICE_CONTEXT_OPTIONAL_BRANCHES.includes(value)
    || NOTICE_CONTEXT_OPTIONAL_LATE_OWNERS.includes(value);
}

function finiteMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function percentile(sorted, q) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * q;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function roundMs(value) {
  return value == null ? null : Math.round(value * 10) / 10;
}

function observationKey(row) {
  if (row.trace_key) return String(row.trace_key);
  return [
    row.metric_id || "",
    row.surface_id || "",
    row.component_id || "",
    row.branch || "",
    row.navigation_type || "",
    row.delivery_class || "",
    row.result_state || "",
    row.observed_at || "",
  ].join("|");
}

export function dedupeNoticeContextObservations(rows = []) {
  const seen = new Set();
  const kept = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const key = observationKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(row);
  }
  return kept;
}

function summarizeGroup(rows, {
  metricId,
  surfaceId,
  componentId,
  branch = null,
  windowComplete,
  sampleFloor = NOTICE_CONTEXT_SAMPLE_FLOOR,
} = {}) {
  const durations = rows
    .map((row) => finiteMs(row.value ?? row.duration_ms))
    .filter((value) => value != null)
    .sort((a, b) => a - b);
  const sampledCount = durations.length;
  const complete = windowComplete === true;
  const sufficient = complete && sampledCount >= sampleFloor;
  const p50 = sufficient ? roundMs(percentile(durations, 0.5)) : null;
  const p75 = sufficient ? roundMs(percentile(durations, 0.75)) : null;
  const p95 = sufficient ? roundMs(percentile(durations, 0.95)) : null;
  let sloState = "insufficient_sample";
  if (sufficient) {
    sloState = p75 <= NOTICE_CONTEXT_P75_BUDGET_MS && p95 <= NOTICE_CONTEXT_P95_BUDGET_MS
      ? "pass"
      : "needs-work";
  }
  return {
    metric_id: metricId,
    surface_id: surfaceId,
    component_id: componentId,
    branch,
    sampled_count: sampledCount,
    window_complete: complete,
    sample_floor: sampleFloor,
    p50_ms: p50,
    p75_ms: p75,
    p95_ms: p95,
    slo_state: sloState,
    p75_budget_ms: NOTICE_CONTEXT_P75_BUDGET_MS,
    p95_budget_ms: NOTICE_CONTEXT_P95_BUDGET_MS,
  };
}

export function projectNoticeContextReadiness({
  primaryObservations = [],
  branchObservations = [],
  windowComplete = false,
  baseline = null,
  sampleFloor = NOTICE_CONTEXT_SAMPLE_FLOOR,
} = {}) {
  const primaryRows = dedupeNoticeContextObservations(primaryObservations).filter((row) => (
    row.metric_id === NOTICE_CONTEXT_PRIMARY_METRIC_ID
    && row.surface_id === NOTICE_CONTEXT_SURFACE_ID
    && row.component_id === NOTICE_CONTEXT_COMPONENT_ID
    && PRIMARY_RESULT_STATES.has(row.result_state)
  ));
  const branchRows = dedupeNoticeContextObservations(branchObservations).filter((row) => (
    isNoticeContextOptionalBranch(row.branch)
    && row.surface_id === NOTICE_CONTEXT_SURFACE_ID
    && row.component_id === NOTICE_CONTEXT_COMPONENT_ID
  ));

  const primary = summarizeGroup(primaryRows, {
    metricId: NOTICE_CONTEXT_PRIMARY_METRIC_ID,
    surfaceId: NOTICE_CONTEXT_SURFACE_ID,
    componentId: NOTICE_CONTEXT_COMPONENT_ID,
    windowComplete,
    sampleFloor,
  });

  const optionalBranches = [...NOTICE_CONTEXT_OPTIONAL_BRANCHES, ...NOTICE_CONTEXT_OPTIONAL_LATE_OWNERS]
    .map((branch) => summarizeGroup(
      branchRows.filter((row) => row.branch === branch),
      {
        metricId: NOTICE_CONTEXT_BRANCH_METRIC_ID,
        surfaceId: NOTICE_CONTEXT_SURFACE_ID,
        componentId: NOTICE_CONTEXT_COMPONENT_ID,
        branch,
        windowComplete,
        sampleFloor,
      },
    ));

  const evidence = {
    schema: NOTICE_CONTEXT_READINESS_EVIDENCE_SCHEMA,
    version: 1,
    primary_owners: [...NOTICE_CONTEXT_PRIMARY_OWNERS],
    optional_branches: [...NOTICE_CONTEXT_OPTIONAL_BRANCHES, ...NOTICE_CONTEXT_OPTIONAL_LATE_OWNERS],
    privacy: {
      record_identifiers: false,
      new_rum_identity: false,
      production_metric: NOTICE_CONTEXT_PRIMARY_METRIC_ID,
      branch_metric: NOTICE_CONTEXT_BRANCH_METRIC_ID,
      branch_metric_ingested: false,
    },
    primary,
    branches: optionalBranches,
    baseline: baseline && isRecord(baseline)
      ? {
        source: String(baseline.source || ""),
        sampled_count: Number(baseline.sampled_count) || 0,
        p50_ms: finiteMs(baseline.p50_ms),
        p75_ms: finiteMs(baseline.p75_ms),
        p95_ms: finiteMs(baseline.p95_ms),
        window: baseline.window || null,
        predates_owner_boundary: baseline.predates_owner_boundary === true,
        not_a_pass: true,
      }
      : null,
  };
  return evidence;
}

export function validateNoticeContextReadinessEvidence(evidence) {
  const errors = [];
  if (!isRecord(evidence) || evidence.schema !== NOTICE_CONTEXT_READINESS_EVIDENCE_SCHEMA) {
    return { ok: false, errors: ["missing notice-context readiness evidence"] };
  }
  const serialized = JSON.stringify(evidence);
  for (const key of FORBIDDEN_EVIDENCE_KEYS) {
    if (serialized.includes(key)) errors.push(`evidence leaked ${key}`);
  }
  if (evidence.privacy?.new_rum_identity !== false) {
    errors.push("evidence must keep the existing notice-context identity");
  }
  if (evidence.privacy?.branch_metric_ingested !== false) {
    errors.push("optional branch timings must not enter the production allowlist");
  }
  const primary = evidence.primary;
  if (!isRecord(primary) || primary.component_id !== NOTICE_CONTEXT_COMPONENT_ID) {
    errors.push("primary group must use notice-context");
  }
  if (primary?.slo_state === "pass" && (
    primary.window_complete !== true
    || primary.sampled_count < NOTICE_CONTEXT_SAMPLE_FLOOR
  )) {
    errors.push("pass requires a complete window and the sample floor");
  }
  if (primary?.slo_state === "insufficient_sample") {
    if (primary.p75_ms != null || primary.p95_ms != null) {
      errors.push("insufficient samples must not publish percentiles");
    }
  }
  if (evidence.baseline && evidence.baseline.not_a_pass !== true) {
    errors.push("historical baseline must not be presented as a pass");
  }
  return { ok: errors.length === 0, errors };
}

export function buildNoticeContextReadinessEvidence(input) {
  const evidence = projectNoticeContextReadiness(input || {});
  const validation = validateNoticeContextReadinessEvidence(evidence);
  if (!validation.ok) {
    const error = new Error(validation.errors.join("; "));
    error.validation = validation;
    throw error;
  }
  return evidence;
}
