/**
 * Derive the two-artifact tail disagreement record for a shared metric.
 *
 * Both sources are named by repository path with the value each reports. The
 * difference is a retained field (including zero when they agree) so an absent
 * field cannot be read as agreement. A below-floor or otherwise withheld
 * percentile stays withheld: the record never invents a published p95 to make
 * the difference computable.
 */

export const LATTICE_PATH = "docs/evidence/field-coverage-lattice-read-back/read-back.json";
export const READINESS_PATH = "docs/evidence/notice-context-readiness/read-back.json";

export const TAIL_METRIC = {
  metric_id: "component_ready_ms",
  surface_id: "notice",
  component_id: "notice-context",
  percentile: "p95",
};

const roundMs = (value) => (Number.isFinite(value) ? Math.round(value * 10) / 10 : null);

/**
 * @param {{
 *   path: string,
 *   state?: string | null,
 *   sampled_count?: number | null,
 *   p95_ms?: number | null,
 *   reason?: string | null,
 * }} measurement
 */
export function artifactMeasurement(measurement) {
  const state = measurement.state ?? "no_data";
  const sampled = Number.isFinite(measurement.sampled_count) ? measurement.sampled_count : null;
  const p95 = roundMs(measurement.p95_ms);
  const publishesPercentile = state === "measured" && p95 !== null;
  return {
    path: measurement.path,
    state,
    sampled_count: sampled,
    p95_ms: publishesPercentile ? p95 : null,
    percentile_withheld: !publishesPercentile,
    ...(measurement.reason ? { reason: measurement.reason } : {}),
  };
}

/**
 * @param {{
 *   lattice: { state?: string | null, sampled_count?: number | null, p95_ms?: number | null, reason?: string | null },
 *   readiness: { state?: string | null, sampled_count?: number | null, p95_ms?: number | null, reason?: string | null },
 *   repository_revision?: string | null,
 * }} input
 */
export function buildTailArtifactDisagreement(input) {
  const lattice = artifactMeasurement({
    path: LATTICE_PATH,
    state: input.lattice?.state,
    sampled_count: input.lattice?.sampled_count,
    p95_ms: input.lattice?.p95_ms,
    reason: input.lattice?.reason,
  });
  const readiness = artifactMeasurement({
    path: READINESS_PATH,
    state: input.readiness?.state,
    sampled_count: input.readiness?.sampled_count,
    p95_ms: input.readiness?.p95_ms,
    reason: input.readiness?.reason,
  });

  const bothPublish = !lattice.percentile_withheld && !readiness.percentile_withheld;
  let difference_ms = null;
  let agreement = "not_comparable";
  if (bothPublish) {
    difference_ms = roundMs(lattice.p95_ms - readiness.p95_ms);
    agreement = difference_ms === 0 ? "agree" : "disagree";
  }

  return {
    ...TAIL_METRIC,
    artifacts: [lattice, readiness],
    difference_ms,
    agreement,
    percentile_published: bothPublish,
    note: bothPublish
      ? agreement === "agree"
        ? "The two committed artifacts report the same p95; agreement is retained as difference_ms 0."
        : "The two committed artifacts measure the same tail over separate windows; difference_ms is retained beside both values rather than left for the reader to subtract."
      : "At least one artifact withholds its percentile (insufficient_sample, no_data, or below floor), so the disagreement record does not publish a p95 or a numeric difference.",
    ...(input.repository_revision
      ? { repository_revision: input.repository_revision }
      : {}),
  };
}

/**
 * Read the notice-context cell out of a lattice-shaped document.
 * @param {object} lattice
 */
export function latticeNoticeContextMeasurement(lattice) {
  const cell = (lattice?.readiness_by_surface?.notice?.cells || []).find(
    (entry) => entry.metric_id === "component_ready_ms" && entry.component_id === "notice-context",
  );
  if (!cell) {
    return { state: "no_data", sampled_count: null, p95_ms: null, reason: "missing_cell" };
  }
  const state = cell.state ?? "no_data";
  const reason = cell.reason
    ?? (state === "insufficient_sample" ? "below_floor" : null);
  return {
    state,
    sampled_count: cell.sampled_count ?? null,
    p95_ms: cell.percentiles?.p95 ?? null,
    reason,
  };
}

/**
 * Read the primary measurement out of a notice-context-readiness document.
 * @param {object} readiness
 */
export function readinessPrimaryMeasurement(readiness) {
  const primary = readiness?.primary;
  if (!primary) {
    return { state: "no_data", sampled_count: null, p95_ms: null, reason: "missing_primary" };
  }
  const sampled = primary.sampled_count ?? null;
  const floor = primary.sample_floor ?? readiness?.provenance?.sample_floor ?? 30;
  const p95 = primary.p95_ms ?? null;
  if (!Number.isFinite(sampled) || sampled < floor || !Number.isFinite(p95)) {
    return {
      state: "insufficient_sample",
      sampled_count: sampled,
      p95_ms: null,
      reason: "below_floor",
    };
  }
  return {
    state: "measured",
    sampled_count: sampled,
    p95_ms: p95,
  };
}

/**
 * Device-identity keys that must stay absent from the lattice artifact.
 * Bucket keys (device_class, device_classes, device_cells, device_states, devices)
 * remain allowed.
 */
export const FORBIDDEN_DEVICE_IDENTITY_KEYS = [
  "distinct_device",
  "distinct_devices",
  "unique_device",
  "unique_devices",
  "per_device",
  "device_id",
  "device_ids",
  "device_count",
  "device_identity",
];

/**
 * Walk a JSON value and return every object key that matches a forbidden
 * device-identity name (exact key match, case-sensitive).
 * @param {unknown} value
 * @returns {string[]}
 */
export function collectForbiddenDeviceIdentityKeys(value) {
  const found = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      if (FORBIDDEN_DEVICE_IDENTITY_KEYS.includes(key)) found.add(key);
      walk(child);
    }
  };
  walk(value);
  return [...found].sort();
}
