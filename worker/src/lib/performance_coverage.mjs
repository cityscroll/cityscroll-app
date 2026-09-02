// The PERF-02 coverage lattice is deliberately separate from the broad metric catalog.
// It names the six field targets and keeps missingness in the read model instead of asking
// a renderer to infer it from the rows Analytics Engine happened to return.

import coverageContract from "../data/performance-coverage-contract.v1.json" with { type: "json" };

export const PERFORMANCE_COVERAGE_SCHEMA = coverageContract.schema;
export const PERFORMANCE_COVERAGE_STATES = Object.freeze([
  "measured",
  "insufficient_sample",
  "no_data",
]);
export const PERFORMANCE_COVERAGE_INSUFFICIENT_REASONS = Object.freeze([
  "window_partial",
  "below_floor",
  "percentiles_missing",
]);
export const PERFORMANCE_COVERAGE_READ_STATUSES = Object.freeze([
  "available",
  "not_read",
  "unavailable",
]);
export const PERFORMANCE_COVERAGE_WINDOW = coverageContract.window;
export const PERFORMANCE_COVERAGE_TRAFFIC_CLASS = coverageContract.traffic_class;
export const PERFORMANCE_COVERAGE_SAMPLE_FLOOR = coverageContract.sample_floor;
export const PERFORMANCE_COVERAGE_SURFACES = Object.freeze(
  coverageContract.surfaces.map((surface) => Object.freeze({
    surface_id: surface.surface_id,
    operator_label: surface.operator_label,
    component_ids: Object.freeze([...surface.component_ids]),
  })),
);
export const PERFORMANCE_COVERAGE_METRICS = Object.freeze(
  coverageContract.readiness_metrics.map((metric) => Object.freeze({ ...metric })),
);
export const PERFORMANCE_COVERAGE_DEVICE_CLASSES = Object.freeze([...coverageContract.device_classes]);
export const PERFORMANCE_ATTRIBUTION_PHASES = Object.freeze(
  coverageContract.attribution_phases.map((phase) => Object.freeze({
    phase_id: phase.phase_id,
    metric_ids: Object.freeze([...phase.metric_ids]),
  })),
);

const SURFACE_IDS = new Set(PERFORMANCE_COVERAGE_SURFACES.map(({ surface_id }) => surface_id));
const DEVICE_CLASSES = new Set(PERFORMANCE_COVERAGE_DEVICE_CLASSES);
const METRIC_IDS = new Set(PERFORMANCE_COVERAGE_METRICS.map(({ metric_id }) => metric_id));
const PHASES_BY_METRIC = new Map(
  PERFORMANCE_ATTRIBUTION_PHASES.flatMap((phase) => phase.metric_ids.map((metric_id) => [metric_id, phase.phase_id])),
);

function finite(value) {
  if (value == null || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integer(value) {
  const number = finite(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function rowValues(row) {
  const value = row?.current && typeof row.current === "object" ? row.current : row || {};
  const percentiles = value.percentiles || row?.percentiles || {};
  return {
    sampled_count: integer(value.sampled_count),
    estimated_count: finite(value.estimated_count),
    percentiles: {
      p50: finite(percentiles.p50 ?? value.p50),
      p75: finite(percentiles.p75 ?? value.p75),
      p95: finite(percentiles.p95 ?? value.p95),
    },
  };
}

/**
 * One classifier is used at the query boundary and again by the admin projection.
 * A retained row is not enough: the window must be complete, the retained-row floor
 * must be met, and all three percentile values must actually be present. A zero is a
 * valid measured percentile; absence is represented by null and a non-measured state.
 */
export function classifyPerformanceCoverage(row, {
  windowStatus = "complete",
  sampleFloor = PERFORMANCE_COVERAGE_SAMPLE_FLOOR,
} = {}) {
  const values = rowValues(row);
  if (values.sampled_count == null || values.sampled_count === 0) {
    return Object.freeze({ state: "no_data", sampled_count: values.sampled_count });
  }
  const insufficient = (reason) => Object.freeze({
    state: "insufficient_sample",
    reason,
    sampled_count: values.sampled_count,
    estimated_count: values.estimated_count,
    sample_floor: sampleFloor,
  });
  if (windowStatus !== "complete") return insufficient("window_partial");
  if (values.sampled_count < sampleFloor) return insufficient("below_floor");
  const { p50, p75, p95 } = values.percentiles;
  if (p50 == null || p75 == null || p95 == null || p50 > p75 || p75 > p95) {
    return insufficient("percentiles_missing");
  }
  return Object.freeze({
    state: "measured",
    sampled_count: values.sampled_count,
    estimated_count: values.estimated_count,
    percentiles: Object.freeze({ p50, p75, p95 }),
  });
}

function cell({ dimensions, row, windowStatus, sampleFloor }) {
  const classification = classifyPerformanceCoverage(row, { windowStatus, sampleFloor });
  return {
    ...dimensions,
    state: classification.state,
    sampled_count: classification.sampled_count ?? null,
    estimated_count: classification.estimated_count ?? null,
    ...(classification.state === "measured" ? { percentiles: classification.percentiles } : {}),
    ...(classification.state === "insufficient_sample"
      ? { reason: classification.reason, sample_floor: sampleFloor }
      : {}),
  };
}

function seriesRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    ...row,
    ...(row?.dimensions || {}),
    ...(row?.current ? { ...row.current } : {}),
  }));
}

function findRow(rows, predicate) {
  return rows.find(predicate) || null;
}

function readinessCells(rows, windowStatus, sampleFloor) {
  const normalized = seriesRows(rows);
  return PERFORMANCE_COVERAGE_SURFACES.flatMap((surface) => [
    cell({
      dimensions: {
        surface_id: surface.surface_id,
        metric_id: "content_ready_ms",
        component_id: "none",
      },
      row: findRow(normalized, (row) => row.surface_id === surface.surface_id
        && row.metric_id === "content_ready_ms" && (row.component_id || "none") === "none"),
      windowStatus,
      sampleFloor,
    }),
    ...surface.component_ids.map((component_id) => cell({
      dimensions: {
        surface_id: surface.surface_id,
        metric_id: "component_ready_ms",
        component_id,
      },
      row: findRow(normalized, (row) => row.surface_id === surface.surface_id
        && row.metric_id === "component_ready_ms" && row.component_id === component_id),
      windowStatus,
      sampleFloor,
    })),
  ]);
}

function deviceCells(rows, windowStatus, sampleFloor) {
  const normalized = seriesRows(rows);
  return PERFORMANCE_COVERAGE_SURFACES.flatMap((surface) =>
    PERFORMANCE_COVERAGE_METRICS.flatMap(({ metric_id }) =>
      PERFORMANCE_COVERAGE_DEVICE_CLASSES.map((device_class) => cell({
        dimensions: { surface_id: surface.surface_id, metric_id, device_class },
        row: findRow(normalized, (candidate) => candidate.surface_id === surface.surface_id
          && candidate.metric_id === metric_id && candidate.device_class === device_class),
        windowStatus,
        sampleFloor,
      }))));
}

function phaseCells(rows, windowStatus, sampleFloor) {
  const normalized = seriesRows(rows);
  return PERFORMANCE_COVERAGE_SURFACES.flatMap((surface) => PERFORMANCE_ATTRIBUTION_PHASES.flatMap((phase) =>
    phase.metric_ids.map((metric_id) => cell({
      dimensions: { surface_id: surface.surface_id, phase_id: phase.phase_id, metric_id },
      row: findRow(normalized, (candidate) => candidate.surface_id === surface.surface_id
        && candidate.metric_id === metric_id),
      windowStatus,
      sampleFloor,
    }))));
}

function stateCounts(cells) {
  return Object.fromEntries(PERFORMANCE_COVERAGE_STATES.map((state) => [
    state,
    cells.filter((cellValue) => cellValue.state === state).length,
  ]));
}

/** Build every registered PERF-02 cell, including groups absent from the SQL response. */
export function buildPerformanceCoverageLattice({
  readinessRows = [],
  deviceRows = [],
  phaseRows = [],
  window = PERFORMANCE_COVERAGE_WINDOW,
  trafficClass = PERFORMANCE_COVERAGE_TRAFFIC_CLASS,
  windowStatus = "complete",
  sampleFloor = PERFORMANCE_COVERAGE_SAMPLE_FLOOR,
  readStatus = "available",
} = {}) {
  const readiness = readinessCells(readinessRows, windowStatus, sampleFloor);
  const devices = deviceCells(deviceRows, windowStatus, sampleFloor);
  const phases = phaseCells(phaseRows, windowStatus, sampleFloor);
  return {
    schema: PERFORMANCE_COVERAGE_SCHEMA,
    version: 1,
    read_status: readStatus,
    window,
    window_status: windowStatus,
    traffic_class: trafficClass,
    sample_floor: sampleFloor,
    dimensions: {
      surfaces: PERFORMANCE_COVERAGE_SURFACES.map(({ surface_id, operator_label }) => ({ surface_id, operator_label })),
      readiness_metrics: PERFORMANCE_COVERAGE_METRICS,
      device_classes: PERFORMANCE_COVERAGE_DEVICE_CLASSES,
      attribution_phases: PERFORMANCE_ATTRIBUTION_PHASES,
    },
    readiness: { state_counts: stateCounts(readiness), cells: readiness },
    devices: { state_counts: stateCounts(devices), cells: devices },
    phases: { state_counts: stateCounts(phases), cells: phases },
  };
}

export function attributionPhaseForMetric(metricId) {
  return PHASES_BY_METRIC.get(metricId) || null;
}

export function isPerformanceCoverageSurface(surfaceId) {
  return SURFACE_IDS.has(surfaceId);
}

export function isPerformanceCoverageDeviceClass(deviceClass) {
  return DEVICE_CLASSES.has(deviceClass);
}

export function isPerformanceCoverageMetric(metricId) {
  return METRIC_IDS.has(metricId) || PERFORMANCE_ATTRIBUTION_PHASES.some((phase) => phase.metric_ids.includes(metricId));
}
