/**
 * Notice primary readiness boundary and grouped before/after read-back.
 *
 * Primary readiness for the Notice surface is the edge-rendered primary body,
 * or an honest unavailable terminal, or the client-rendered body when no edge
 * body was delivered. Money history, rules, the client notice read, attachment
 * metadata, notice context, and late property enrichment are deferred owners:
 * they may continue after the primary milestone and must never gate it.
 *
 * Production RUM keeps the existing `notice` surface identity and the
 * page-level `none` component sentinel. This module adds no metric, surface, or
 * component identity; it only groups the observations the collector already
 * reports so a before/after comparison can be read honestly.
 *
 * The projected reduction is carried as an estimate and can never
 * become a measured delta: an insufficient window publishes no percentiles and
 * no delta, and the estimate is always serialized with `measured: false`.
 */

export const NOTICE_PRIMARY_READINESS_SCHEMA = "cityscroll.notice_primary_readiness.v1";
export const NOTICE_PRIMARY_READINESS_EVIDENCE_SCHEMA = "cityscroll.notice_primary_readiness_evidence.v1";

export const NOTICE_PRIMARY_SURFACE_ID = "notice";
// Page-level observations use the canonical component sentinel, not a component record.
export const NOTICE_PRIMARY_COMPONENT_ID = "none";
export const NOTICE_PRIMARY_METRIC_ID = "content_ready_ms";

export const NOTICE_PRIMARY_SAMPLE_FLOOR = 30;

/** Owners that may satisfy primary readiness. Each is a meaningful body or an honest terminal. */
export const NOTICE_PRIMARY_OWNERS = Object.freeze([
  "edge-primary-body",
  "edge-unavailable-terminal",
  "client-fallback-body",
  "client-unavailable-terminal",
]);

/** Owners that must never gate `content_ready_ms`. */
export const NOTICE_PRIMARY_DEFERRED_OWNERS = Object.freeze([
  "money-history",
  "rules",
  "notice-read",
  "attachment-metadata",
  "notice-context",
  "property-action-matter",
]);

/**
 * The projected reduction for this change. It is a planning estimate, not a
 * measurement, and every serializer stamps `measured: false`.
 */
export const NOTICE_PRIMARY_ESTIMATED_REDUCTION_MS = Object.freeze({
  low_ms: 3000,
  high_ms: 7000,
  basis: "planning projection",
  applies_to: "slow devices",
  measured: false,
});

const PRIMARY_RESULT_STATES = new Set(["content", "empty", "unavailable", "error"]);

/** Population dimensions that must match across a before/after comparison. */
export const NOTICE_PRIMARY_POPULATION_KEYS = Object.freeze([
  "device_class",
  "navigation_type",
  "delivery_class",
  "traffic_class",
]);

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

// An absent value stays absent. Number(null) is 0, so a bare Number() coercion
// would render "never settled" as "settled at 0 ms".
function finiteMs(value) {
  if (value == null || value === "") return null;
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
    row.owner || "",
    row.navigation_type || "",
    row.delivery_class || "",
    row.result_state || "",
    row.observed_at || "",
  ].join("|");
}

export function dedupeNoticePrimaryObservations(rows = []) {
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

/** Only page-level Notice readiness observations belong in the primary group. */
export function isNoticePrimaryObservation(row) {
  return isRecord(row)
    && row.metric_id === NOTICE_PRIMARY_METRIC_ID
    && row.surface_id === NOTICE_PRIMARY_SURFACE_ID
    && row.component_id === NOTICE_PRIMARY_COMPONENT_ID
    && PRIMARY_RESULT_STATES.has(row.result_state);
}

export function isNoticePrimaryDeferredOwner(owner) {
  return NOTICE_PRIMARY_DEFERRED_OWNERS.includes(String(owner || ""));
}

function populationOf(rows) {
  const population = {};
  for (const key of NOTICE_PRIMARY_POPULATION_KEYS) {
    const values = [...new Set(rows.map((row) => row[key]).filter(Boolean).map(String))].sort();
    population[key] = values;
  }
  return population;
}

/**
 * Lab traces and production field observations are both legitimate evidence and
 * must never be collapsed into one another. A mixed group is named as mixed
 * rather than silently resolved.
 */
function measurementClassOf(rows) {
  const classes = [...new Set(rows.map((row) => row.traffic_class).filter(Boolean).map(String))];
  if (!classes.length) return "unknown";
  if (classes.length > 1) return "mixed";
  return classes[0] === "production" ? "field" : classes[0];
}

function resultStateCounts(rows) {
  const counts = {};
  for (const state of PRIMARY_RESULT_STATES) counts[state] = 0;
  for (const row of rows) counts[row.result_state] += 1;
  return counts;
}

/**
 * Summarize one side of the comparison. Percentiles stay null unless the window
 * is complete and the sample floor is met, so an undersized window can never be
 * read as a result.
 */
export function summarizeNoticePrimaryGroup(observations = [], {
  label,
  windowComplete = false,
  window = null,
  sampleFloor = NOTICE_PRIMARY_SAMPLE_FLOOR,
  revision = null,
} = {}) {
  const rows = dedupeNoticePrimaryObservations(observations).filter(isNoticePrimaryObservation);
  const durations = rows
    .map((row) => finiteMs(row.value ?? row.duration_ms))
    .filter((value) => value != null)
    .sort((a, b) => a - b);
  const sampledCount = durations.length;
  const complete = windowComplete === true;
  const sufficient = complete && sampledCount >= sampleFloor;
  return {
    label: String(label || ""),
    metric_id: NOTICE_PRIMARY_METRIC_ID,
    surface_id: NOTICE_PRIMARY_SURFACE_ID,
    component_id: NOTICE_PRIMARY_COMPONENT_ID,
    sampled_count: sampledCount,
    window_complete: complete,
    sample_floor: sampleFloor,
    sufficiency: sufficient ? "sufficient" : "insufficient_sample",
    p50_ms: sufficient ? roundMs(percentile(durations, 0.5)) : null,
    p75_ms: sufficient ? roundMs(percentile(durations, 0.75)) : null,
    p95_ms: sufficient ? roundMs(percentile(durations, 0.95)) : null,
    result_states: resultStateCounts(rows),
    population: populationOf(rows),
    measurement_class: measurementClassOf(rows),
    window: window || null,
    revision: revision ? String(revision) : null,
  };
}

function samePopulation(before, after) {
  return NOTICE_PRIMARY_POPULATION_KEYS.every((key) => (
    JSON.stringify(before.population[key]) === JSON.stringify(after.population[key])
  ));
}

function deltaOf(before, after, key) {
  if (before[key] == null || after[key] == null) return null;
  return roundMs(before[key] - after[key]);
}

/**
 * Compare the before and after groups. A delta is published only when both
 * sides are sufficient AND describe the same population; otherwise the delta is
 * null with a named reason. The estimate never fills that hole.
 */
export function compareNoticePrimaryReadiness(before, after) {
  const comparable = before.sufficiency === "sufficient" && after.sufficiency === "sufficient";
  const matched = samePopulation(before, after);
  let state = "measured";
  let reason = null;
  if (!comparable) {
    state = "insufficient_sample";
    reason = "before/after windows must both be complete and meet the sample floor";
  } else if (!matched) {
    state = "population_mismatch";
    reason = "before/after groups describe different measurement populations";
  }
  const measured = state === "measured";
  return {
    state,
    reason,
    measurement_class: before.measurement_class === after.measurement_class
      ? before.measurement_class
      : "mixed",
    metric_id: NOTICE_PRIMARY_METRIC_ID,
    surface_id: NOTICE_PRIMARY_SURFACE_ID,
    component_id: NOTICE_PRIMARY_COMPONENT_ID,
    population_matched: matched,
    delta_p50_ms: measured ? deltaOf(before, after, "p50_ms") : null,
    delta_p75_ms: measured ? deltaOf(before, after, "p75_ms") : null,
    delta_p95_ms: measured ? deltaOf(before, after, "p95_ms") : null,
  };
}

export function projectNoticePrimaryReadiness({
  beforeObservations = [],
  afterObservations = [],
  beforeWindowComplete = false,
  afterWindowComplete = false,
  beforeWindow = null,
  afterWindow = null,
  beforeRevision = null,
  afterRevision = null,
  ownerCallTiming = [],
  sampleFloor = NOTICE_PRIMARY_SAMPLE_FLOOR,
  fieldBaseline = null,
} = {}) {
  const before = summarizeNoticePrimaryGroup(beforeObservations, {
    label: "before",
    windowComplete: beforeWindowComplete,
    window: beforeWindow,
    revision: beforeRevision,
    sampleFloor,
  });
  const after = summarizeNoticePrimaryGroup(afterObservations, {
    label: "after",
    windowComplete: afterWindowComplete,
    window: afterWindow,
    revision: afterRevision,
    sampleFloor,
  });

  return {
    schema: NOTICE_PRIMARY_READINESS_EVIDENCE_SCHEMA,
    version: 1,
    primary_owners: [...NOTICE_PRIMARY_OWNERS],
    deferred_owners: [...NOTICE_PRIMARY_DEFERRED_OWNERS],
    identity: {
      metric_id: NOTICE_PRIMARY_METRIC_ID,
      surface_id: NOTICE_PRIMARY_SURFACE_ID,
      component_id: NOTICE_PRIMARY_COMPONENT_ID,
      new_rum_identity: false,
      record_identifiers: false,
    },
    before,
    after,
    comparison: compareNoticePrimaryReadiness(before, after),
    // The projected range. Never a measurement, never a delta.
    estimate: { ...NOTICE_PRIMARY_ESTIMATED_REDUCTION_MS },
    owner_call_timing: dedupeNoticePrimaryObservations(ownerCallTiming).map((row) => ({
      trace: String(row.trace || ""),
      owner: String(row.owner || ""),
      deferred: isNoticePrimaryDeferredOwner(row.owner),
      called_at_ms: finiteMs(row.called_at_ms),
      settled_at_ms: finiteMs(row.settled_at_ms),
      blocking: row.blocking === true,
    })),
    field_baseline: fieldBaseline && isRecord(fieldBaseline)
      ? {
        source: String(fieldBaseline.source || ""),
        surface_id: NOTICE_PRIMARY_SURFACE_ID,
        component_id: NOTICE_PRIMARY_COMPONENT_ID,
        sampled_count: Number(fieldBaseline.sampled_count) || 0,
        estimated_count: Number(fieldBaseline.estimated_count) || 0,
        p50_ms: finiteMs(fieldBaseline.p50_ms),
        p75_ms: finiteMs(fieldBaseline.p75_ms),
        p95_ms: finiteMs(fieldBaseline.p95_ms),
        window: fieldBaseline.window || null,
        predates_owner_boundary: fieldBaseline.predates_owner_boundary === true,
        not_a_result: true,
      }
      : null,
  };
}

export function validateNoticePrimaryReadinessEvidence(evidence) {
  const errors = [];
  if (!isRecord(evidence) || evidence.schema !== NOTICE_PRIMARY_READINESS_EVIDENCE_SCHEMA) {
    return { ok: false, errors: ["missing notice primary readiness evidence"] };
  }
  const serialized = JSON.stringify(evidence);
  for (const key of FORBIDDEN_EVIDENCE_KEYS) {
    if (serialized.includes(key)) errors.push(`evidence leaked ${key}`);
  }

  if (evidence.identity?.new_rum_identity !== false) {
    errors.push("evidence must keep the existing notice surface identity");
  }
  for (const side of ["before", "after"]) {
    const group = evidence[side];
    if (!isRecord(group)) {
      errors.push(`missing ${side} group`);
      continue;
    }
    if (
      group.metric_id !== NOTICE_PRIMARY_METRIC_ID
      || group.surface_id !== NOTICE_PRIMARY_SURFACE_ID
      || group.component_id !== NOTICE_PRIMARY_COMPONENT_ID
    ) {
      errors.push(`${side} group must keep the notice content_ready_ms identity`);
    }
    if (group.sufficiency === "insufficient_sample"
      && (group.p50_ms != null || group.p75_ms != null || group.p95_ms != null)) {
      errors.push(`${side} group must not publish percentiles below the sample floor`);
    }
    if (group.sufficiency === "sufficient"
      && (group.window_complete !== true || group.sampled_count < group.sample_floor)) {
      errors.push(`${side} group cannot be sufficient without a complete window and the sample floor`);
    }
  }

  const comparison = evidence.comparison;
  if (!isRecord(comparison)) {
    errors.push("missing comparison");
  } else if (comparison.state !== "measured") {
    for (const key of ["delta_p50_ms", "delta_p75_ms", "delta_p95_ms"]) {
      if (comparison[key] != null) errors.push(`${key} published without a measured comparison`);
    }
    if (!comparison.reason) errors.push("an unmeasured comparison must name its reason");
  } else if (comparison.population_matched !== true) {
    errors.push("a measured comparison requires a matched population");
  } else if (comparison.measurement_class === "mixed") {
    errors.push("a measured comparison cannot mix lab and field measurement classes");
  }

  const estimate = evidence.estimate;
  if (!isRecord(estimate) || estimate.measured !== false) {
    errors.push("the projected reduction must be marked measured: false");
  }
  // The estimate must never be substituted for the measured delta.
  if (isRecord(estimate) && isRecord(comparison) && comparison.state !== "measured") {
    for (const key of ["delta_p50_ms", "delta_p75_ms", "delta_p95_ms"]) {
      if (comparison[key] === estimate.low_ms || comparison[key] === estimate.high_ms) {
        errors.push("the estimated range cannot stand in for a measured delta");
      }
    }
  }

  if (evidence.field_baseline && evidence.field_baseline.not_a_result !== true) {
    errors.push("the field baseline must not be presented as a result");
  }

  // A deferred owner that reports itself as blocking contradicts the boundary.
  for (const entry of evidence.owner_call_timing || []) {
    if (entry.deferred === true && entry.blocking === true) {
      errors.push(`deferred owner ${entry.owner} must not block primary readiness`);
    }
    if (entry.deferred === false && !NOTICE_PRIMARY_OWNERS.includes(entry.owner)) {
      errors.push(`unknown primary owner ${entry.owner}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function buildNoticePrimaryReadinessEvidence(input) {
  const evidence = projectNoticePrimaryReadiness(input || {});
  const validation = validateNoticePrimaryReadinessEvidence(evidence);
  if (!validation.ok) {
    const error = new Error(validation.errors.join("; "));
    error.validation = validation;
    throw error;
  }
  return evidence;
}
