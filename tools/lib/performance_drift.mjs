import { createHash } from "node:crypto";

import performanceInventory from "../../worker/src/data/performance-operator-labels.v1.json" with { type: "json" };
import {
  buildPerformanceCoverageLattice,
  classifyPerformanceCoverage,
} from "../../worker/src/lib/performance_coverage.mjs";

export const PERFORMANCE_DRIFT_SCHEMA = "cityscroll.performance.drift_overlay.v1";
export const PERFORMANCE_CANDIDATE_SCHEMA = "cityscroll.performance.drift_candidate.v1";
export const PERFORMANCE_DRIFT_SOURCE = "rum-daily";
export const PERFORMANCE_SAMPLE_FLOOR = 30;
export const PERFORMANCE_WINDOW = "7d";
export const PERFORMANCE_METRICS = Object.freeze([
  "content_ready_ms",
  "component_ready_ms",
]);
export const PERFORMANCE_SLO = Object.freeze({
  p75_good_ms: 2500,
  p95_good_ms: 5000,
  p75_transition_ms: 5000,
  p95_transition_ms: 10000,
});
export const INSTRUMENTED_SURFACES = Object.freeze(
  performanceInventory.surfaces
    .filter((surface) => surface.lifecycle_state === "instrumented")
    .map((surface) => surface.surface_id)
    .sort(),
);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function hashEvidence(value) {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function iso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function currentWindow(snapshot, now) {
  const current = snapshot?.retention?.current;
  if (current?.requested_start && current?.requested_end) {
    return {
      start: iso(current.requested_start),
      end: iso(current.requested_end),
      status: current.status || "unknown",
    };
  }
  const end = new Date(now);
  const start = new Date(end.getTime() - 7 * 86400000);
  return { start: start.toISOString(), end: end.toISOString(), status: "unknown" };
}

function baselineWindow(baseline) {
  if (!baseline?.window?.start || !baseline?.window?.end) return null;
  return {
    start: iso(baseline.window.start),
    end: iso(baseline.window.end),
    status: baseline.window.status || "stored",
  };
}

function metricTier(p75, p95) {
  if (p75 <= PERFORMANCE_SLO.p75_good_ms && p95 <= PERFORMANCE_SLO.p95_good_ms) return "good";
  if (p75 <= PERFORMANCE_SLO.p75_transition_ms && p95 <= PERFORMANCE_SLO.p95_transition_ms) return "needs-work";
  return "fail";
}

function metricReasons(p75, p95) {
  return [
    ...(p75 > PERFORMANCE_SLO.p75_good_ms ? ["p75-over-good"] : []),
    ...(p95 > PERFORMANCE_SLO.p95_good_ms ? ["p95-over-good"] : []),
    ...(p75 > PERFORMANCE_SLO.p75_transition_ms ? ["p75-over-transition"] : []),
    ...(p95 > PERFORMANCE_SLO.p95_transition_ms ? ["p95-over-transition"] : []),
  ];
}

function statusFor(snapshot, series, instrumented, window, sampleFloor) {
  if (!instrumented) return "uninstrumented";
  if (snapshot?.status === "unavailable") return "unavailable";
  const state = classifyPerformanceCoverage(series?.current, {
    windowStatus: window.status,
    sampleFloor,
  }).state;
  if (state === "measured") return "flowing";
  if (state === "insufficient_sample") return "insufficient_sample";
  return "no_data";
}

function findSeries(snapshot, surfaceId, metricId) {
  return (snapshot?.series || []).find((row) => (
    row?.dimensions?.surface_id === surfaceId
    && row?.dimensions?.metric_id === metricId
  )) || null;
}

function findBaseline(baseline, surfaceId, metricId) {
  return baseline?.records?.[`${surfaceId}|${metricId}`] || null;
}

function relativeChange(current, previous) {
  if (!Number.isFinite(previous) || previous === 0) return null;
  return (current - previous) / previous;
}

function driftFor(values, baselineRecord) {
  if (!baselineRecord) {
    return {
      status: "no-baseline",
      p75: null,
      p95: null,
      triggers: [],
    };
  }
  const percentiles = {};
  const triggers = [];
  for (const percentile of ["p50", "p75", "p95"]) {
    const current = values[`${percentile}_ms`];
    const baseline = baselineRecord[`${percentile}_ms`];
    const delta = Number.isFinite(current) && Number.isFinite(baseline) ? current - baseline : null;
    const relative = delta == null ? null : relativeChange(current, baseline);
    percentiles[percentile] = {
      current_ms: current,
      baseline_ms: baseline,
      delta_ms: delta,
      relative_change: relative,
    };
    if (relative != null && relative >= 0.2) triggers.push(`${percentile}-20-percent`);
  }
  const currentTier = values.slo_state;
  const previousTier = baselineRecord.slo_state;
  const tierRank = { good: 0, "needs-work": 1, fail: 2 };
  if (tierRank[currentTier] != null && tierRank[previousTier] != null
    && tierRank[currentTier] > tierRank[previousTier]) {
    triggers.push("slo-tier-worsened");
  }
  return {
    status: "compared",
    p75: percentiles.p75,
    p95: percentiles.p95,
    previous_slo_state: previousTier || null,
    triggers: [...new Set(triggers)],
  };
}

function metricEvidence({
  snapshot,
  series,
  baseline,
  surface,
  metricId,
  instrumented,
  window,
  trafficClass = "production",
  measurementOrigin = "field",
}) {
  const sampleFloor = snapshot?.sample_floor || PERFORMANCE_SAMPLE_FLOOR;
  const dataStatus = statusFor(snapshot, series, instrumented, window, sampleFloor);
  const current = series?.current || {};
  const distribution = current.percentiles || {};
  const hasPercentiles = dataStatus === "flowing"
    && window.status === "complete"
    && Number.isSafeInteger(current.sampled_count)
    && current.sampled_count >= sampleFloor
    && Number.isFinite(distribution.p50)
    && Number.isFinite(distribution.p75)
    && Number.isFinite(distribution.p95);
  const values = hasPercentiles
    ? {
      p50_ms: distribution.p50,
      p75_ms: distribution.p75,
      p95_ms: distribution.p95,
      slo_state: metricTier(distribution.p75, distribution.p95),
    }
    : { slo_state: instrumented ? "needs-data" : "coverage-gap" };
  const baselineRecord = hasPercentiles ? findBaseline(baseline, surface.surface_id, metricId) : null;
  const drift = hasPercentiles ? driftFor(values, baselineRecord) : {
    status: "not-comparable",
    p75: null,
    p95: null,
    triggers: [],
  };
  const evidence = {
    surface_id: surface.surface_id,
    metric_id: metricId,
    traffic_class: trafficClass,
    measurement_origin: measurementOrigin,
    card_id: `cityscroll-snappiness/surface-${surface.surface_id}`,
    data_status: dataStatus,
    slo_state: values.slo_state,
    sampled_count: Number.isSafeInteger(current.sampled_count) ? current.sampled_count : null,
    estimated_count: Number.isFinite(current.estimated_count) ? current.estimated_count : null,
    latest_observation_at: series?.latest_observation_at || null,
    window,
    baseline_window: baselineRecord ? baselineWindow(baseline) : null,
    drift,
    ...(hasPercentiles ? {
      p50_ms: values.p50_ms,
      p75_ms: values.p75_ms,
      p95_ms: values.p95_ms,
      slo_reasons: metricReasons(values.p75_ms, values.p95_ms),
    } : {}),
  };
  return { ...evidence, evidence_hash: hashEvidence(evidence) };
}

function worstSlo(metrics) {
  if (metrics.some((metric) => metric.slo_state === "fail")) return "fail";
  if (metrics.some((metric) => metric.slo_state === "needs-work")) return "needs-work";
  if (metrics.some((metric) => metric.slo_state === "coverage-gap")) return "coverage-gap";
  if (metrics.some((metric) => metric.slo_state === "needs-data")) return "needs-data";
  return "good";
}

function worstDataStatus(metrics) {
  const order = ["unavailable", "no_data", "insufficient_sample", "uninstrumented", "flowing"];
  return metrics.map((metric) => metric.data_status).sort((a, b) => order.indexOf(a) - order.indexOf(b))[0] || "no_data";
}

export function buildDriftOverlay(snapshot, {
  baseline = null,
  labSnapshot = null,
  generation = null,
  now = new Date(),
  sourceRun = null,
} = {}) {
  const generatedAt = new Date(now).toISOString();
  const window = currentWindow(snapshot, now);
  const surfaces = performanceInventory.surfaces.map((surface) => {
    const instrumented = surface.lifecycle_state === "instrumented";
    const metrics = PERFORMANCE_METRICS.map((metricId) => metricEvidence({
      snapshot,
      series: findSeries(snapshot, surface.surface_id, metricId),
      baseline,
      surface,
      metricId,
      instrumented,
      window,
      trafficClass: "production",
      measurementOrigin: "field",
    }));
    return {
      card_id: `cityscroll-snappiness/surface-${surface.surface_id}`,
      surface_id: surface.surface_id,
      operator_label: surface.operator_label,
      lifecycle_state: surface.lifecycle_state,
      data_status: worstDataStatus(metrics),
      slo_state: worstSlo(metrics),
      metrics: Object.fromEntries(metrics.map((metric) => [metric.metric_id, metric])),
    };
  });
  const overlayBody = {
    schema: PERFORMANCE_DRIFT_SCHEMA,
    source: PERFORMANCE_DRIFT_SOURCE,
    generated_at: generatedAt,
    source_run: sourceRun,
    query_status: snapshot?.status || "unavailable",
    query_hash: hashEvidence({
      query: snapshot?.query || null,
      retention: snapshot?.retention || null,
      sample_floor: snapshot?.sample_floor || PERFORMANCE_SAMPLE_FLOOR,
    }),
    sample_floor: snapshot?.sample_floor || PERFORMANCE_SAMPLE_FLOOR,
    window,
    baseline_window: baselineWindow(baseline),
    slo: PERFORMANCE_SLO,
    sampling: snapshot?.sampling || null,
    data_health: snapshot?.data_health || null,
    field: {
      traffic_class: "production",
      measurement_origin: "field",
    },
    coverage: snapshot?.coverage_lattice || buildPerformanceCoverageLattice({
      readinessRows: snapshot?.series,
      windowStatus: snapshot?.retention?.current?.status || "complete",
      sampleFloor: snapshot?.sample_floor || PERFORMANCE_SAMPLE_FLOOR,
      readStatus: snapshot?.status === "unavailable" ? "unavailable" : "available",
    }),
    lab: buildLabEvidence(labSnapshot, now),
    generation: generation || null,
    surfaces,
    enforcement: {
      mode: "human-review-only",
      ci_gate: false,
      auto_merge: false,
      ownership_changes: false,
    },
  };
  return {
    ...overlayBody,
    evidence_hash: hashEvidence(overlayBody),
  };
}

function buildLabEvidence(snapshot, now) {
  const window = currentWindow(snapshot, now);
  const surfaces = performanceInventory.surfaces.map((surface) => {
    const instrumented = surface.lifecycle_state === "instrumented";
    const metrics = PERFORMANCE_METRICS.map((metricId) => metricEvidence({
      snapshot,
      series: findSeries(snapshot, surface.surface_id, metricId),
      baseline: null,
      surface,
      metricId,
      instrumented,
      window,
      trafficClass: "lab",
      measurementOrigin: "controlled",
    }));
    return {
      surface_id: surface.surface_id,
      operator_label: surface.operator_label,
      lifecycle_state: surface.lifecycle_state,
      data_status: worstDataStatus(metrics),
      slo_state: worstSlo(metrics),
      metrics: Object.fromEntries(metrics.map((metric) => [metric.metric_id, metric])),
    };
  });
  return {
    traffic_class: "lab",
    measurement_origin: "controlled",
    query_status: snapshot?.status || "unavailable",
    query_hash: hashEvidence({
      query: snapshot?.query || null,
      retention: snapshot?.retention || null,
      sample_floor: snapshot?.sample_floor || PERFORMANCE_SAMPLE_FLOOR,
    }),
    sample_floor: snapshot?.sample_floor || PERFORMANCE_SAMPLE_FLOOR,
    window,
    surfaces,
  };
}

function candidateFor(metric, trigger, overlay) {
  const evidence = {
    source: PERFORMANCE_DRIFT_SOURCE,
    source_run: overlay.source_run,
    surface_id: metric.surface_id,
    metric_id: metric.metric_id,
    card_id: metric.card_id,
    data_status: metric.data_status,
    slo_state: metric.slo_state,
    p75_ms: metric.p75_ms,
    p95_ms: metric.p95_ms,
    sampled_count: metric.sampled_count,
    latest_observation_at: metric.latest_observation_at,
    baseline_window: metric.baseline_window,
    drift: metric.drift,
    evidence_hash: metric.evidence_hash,
    trigger,
    suggested_owner: `cityscroll-snappiness/surface-${metric.surface_id}`,
  };
  const id = `cityscroll-snappiness/candidate-${metric.surface_id}-${metric.metric_id}-${trigger}`;
  return {
    schema: PERFORMANCE_CANDIDATE_SCHEMA,
    id,
    title: `Review ${metric.surface_id} ${metric.metric_id} performance ${trigger}`,
    status: "proposed",
    dimension: "performance-drift",
    rank_score: metric.slo_state === "fail" ? 100 : 80,
    emitted_by: "performance_drift_daily",
    policy_version: "v1",
    evidence,
    needs_human: true,
    verify: "human review required; this candidate never gates CI or changes ownership",
    demo_win: `A human-reviewed change can improve ${metric.surface_id} ${metric.metric_id} without automatic enforcement.`,
    content_hash: hashEvidence({ id, evidence }),
  };
}

export function buildCandidates(overlay) {
  const candidates = [];
  for (const surface of overlay.surfaces || []) {
    for (const metric of Object.values(surface.metrics || {})) {
      if (metric.data_status !== "flowing") continue;
      if (["needs-work", "fail"].includes(metric.slo_state)) {
        candidates.push(candidateFor(metric, "slo-breach", overlay));
      }
      for (const trigger of metric.drift?.triggers || []) {
        candidates.push(candidateFor(metric, `regression-${trigger}`, overlay));
      }
    }
  }
  return candidates;
}

export function buildBaseline(overlay) {
  const records = {};
  for (const surface of overlay.surfaces || []) {
    for (const metric of Object.values(surface.metrics || {})) {
      if (metric.data_status !== "flowing") continue;
      records[`${surface.surface_id}|${metric.metric_id}`] = {
        surface_id: surface.surface_id,
        metric_id: metric.metric_id,
        p50_ms: metric.p50_ms,
        p75_ms: metric.p75_ms,
        p95_ms: metric.p95_ms,
        slo_state: metric.slo_state,
        sampled_count: metric.sampled_count,
        latest_observation_at: metric.latest_observation_at,
      };
    }
  }
  return {
    schema: "cityscroll.performance.drift_baseline.v1",
    source: PERFORMANCE_DRIFT_SOURCE,
    generated_at: overlay.generated_at,
    window: overlay.window,
    records,
  };
}

export function unavailableSnapshot(reason, now = new Date()) {
  return {
    schema: "cityscroll.performance.query_result.v1",
    status: "unavailable",
    unavailable_reason: reason,
    sample_floor: PERFORMANCE_SAMPLE_FLOOR,
    series: [],
    freshness: { status: "unavailable", queried_at: new Date(now).toISOString() },
    data_health: { status: "unavailable", reason },
  };
}
