/**
 * Retained RUM measurement groups and the single-group read-back projection.
 *
 * A read-back answers a question about one population. The retained dataset now
 * holds two that matter to a Notice performance question: resident traffic, which
 * is people using the deployed site, and synthetic traffic, which is a scheduled
 * probe visiting a fixed page list on the same deployed site. They answer
 * different questions, fill at different rates, and open their windows at
 * different moments, so this module keeps them apart by construction:
 *
 * - every projection names its group in the output, on every row;
 * - each group carries its own sample floor and its own window anchor;
 * - there is no function here that pools two groups into one distribution, and
 *   `compareMeasurementGroups` refuses a cross-group comparison by name.
 *
 * The group is read from the `traffic_class` dimension the collector already
 * retains. Nothing here classifies an observation; it only partitions on the
 * marker the measuring client set for itself.
 */

export const RUM_MEASUREMENT_GROUP_SCHEMA = "cityscroll.rum_measurement_group_read_back.v1";
export const RUM_MEASUREMENT_GROUP_SAMPLE_FLOOR = 30;

export const RUM_MEASUREMENT_GROUPS = Object.freeze({
  resident: Object.freeze({
    group: "resident",
    label: "resident",
    traffic_class: "production",
    sample_floor: RUM_MEASUREMENT_GROUP_SAMPLE_FLOOR,
    anchor_kind: "delivery_merge",
    measures: "What people using the deployed site experienced, on their own devices and networks.",
    cannot_claim: Object.freeze([
      "a controlled comparison: the device, network, and page mix move on their own",
    ]),
  }),
  synthetic: Object.freeze({
    group: "synthetic",
    label: "synthetic",
    traffic_class: "synthetic",
    sample_floor: RUM_MEASUREMENT_GROUP_SAMPLE_FLOOR,
    anchor_kind: "first_probe_slot",
    measures: "What the deployed surface does for a fixed page list under one fixed device and network profile.",
    cannot_claim: Object.freeze([
      "resident experience: the population is a scheduled probe, not people",
      "a device or network distribution: the profile is fixed by the probe",
      "a page-popularity weighting: every listed page is visited equally often",
    ]),
  }),
});

const TRAFFIC_CLASS_TO_GROUP = new Map(
  Object.values(RUM_MEASUREMENT_GROUPS).map((group) => [group.traffic_class, group.group]),
);

export function measurementGroupNames() {
  return Object.keys(RUM_MEASUREMENT_GROUPS);
}

export function resolveMeasurementGroup(name) {
  const group = RUM_MEASUREMENT_GROUPS[String(name || "")];
  if (!group) {
    throw new Error(`unknown measurement group: ${name} (expected one of ${measurementGroupNames().join(", ")})`);
  }
  return group;
}

/** The group a retained traffic class belongs to, or null when it belongs to none. */
export function measurementGroupForTrafficClass(trafficClass) {
  return TRAFFIC_CLASS_TO_GROUP.get(String(trafficClass || "")) || null;
}

/**
 * Split rows by their retained traffic class. A row whose class belongs to no
 * declared group lands in `unassigned` rather than being folded into one, so an
 * unrecognised marker can never inflate a group it was not measured for.
 */
export function partitionRowsByMeasurementGroup(rows = []) {
  const out = { unassigned: [] };
  for (const name of measurementGroupNames()) out[name] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const group = row && typeof row === "object"
      ? measurementGroupForTrafficClass(row.traffic_class)
      : null;
    if (group) out[group].push(row);
    else out.unassigned.push(row);
  }
  return out;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isoOrNull(value) {
  if (value == null || value === "") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function roundMs(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

function checkedFloor(value, fallback) {
  if (value == null || value === "") return fallback;
  const floor = Number(value);
  if (!Number.isSafeInteger(floor) || floor < 1 || floor > 10_000) {
    throw new Error(`invalid sample floor: ${value}`);
  }
  return floor;
}

/**
 * The earliest retained observation across a snapshot's series.
 *
 * For the synthetic group this is the first probe slot that reached the dataset,
 * which is exactly the anchor the contract asks for. It is only usable while the
 * install is inside the retention window; at the retention edge the true first
 * slot may be older and the projection says so rather than guessing.
 */
export function earliestRetainedObservation(snapshot) {
  const stamps = (snapshot?.series || [])
    .map((entry) => isoOrNull(entry?.first_observation_at))
    .filter(Boolean)
    .sort();
  return stamps[0] || null;
}

function resolveAnchor(group, snapshot, declaredAnchor) {
  const declared = isoOrNull(declaredAnchor);
  if (declared) {
    return { kind: group.anchor_kind, at: declared, source: "declared", at_retention_edge: false };
  }
  const derived = earliestRetainedObservation(snapshot);
  if (!derived) {
    return { kind: group.anchor_kind, at: null, source: "unset", at_retention_edge: false };
  }
  const availableSince = isoOrNull(snapshot?.retention?.current?.available_since);
  // Within a day of the retention edge the derived anchor may be the edge itself
  // rather than the first slot, so the projection reports it as uncertain.
  const atEdge = Boolean(availableSince)
    && Date.parse(derived) - Date.parse(availableSince) < 24 * 60 * 60 * 1000;
  return {
    kind: group.anchor_kind,
    at: derived,
    source: "first_retained_observation",
    at_retention_edge: atEdge,
  };
}

function dimensionsOf(entry) {
  const dimensions = isRecord(entry?.dimensions) ? entry.dimensions : {};
  return {
    metric_id: dimensions.metric_id ?? null,
    surface_id: dimensions.surface_id ?? null,
    component_id: dimensions.component_id ?? null,
  };
}

function classifyRow(distribution, { floor, windowComplete, anchorSatisfied, anchorSource }) {
  if (anchorSource === "unset") return "anchor_unset";
  if (!anchorSatisfied) return "window_precedes_anchor";
  if (!windowComplete) return "window_incomplete";
  const sampled = Number.isSafeInteger(distribution?.sampled_count) ? distribution.sampled_count : 0;
  if (sampled < floor) return "insufficient_sample";
  const percentiles = distribution?.percentiles;
  if (!isRecord(percentiles) || ["p50", "p75", "p95"].some((key) => !Number.isFinite(percentiles[key]))) {
    return "insufficient_sample";
  }
  return "sufficient";
}

/**
 * Project one snapshot as a labelled read-back for exactly one group.
 *
 * Percentiles are published only when the group's own floor is met inside a
 * complete window that begins at or after the group's own anchor. Every other
 * state names itself and withholds the percentiles rather than rounding up.
 */
export function projectMeasurementGroupReadBack({
  group: groupName,
  snapshot,
  anchor = null,
  sampleFloor = null,
  queriedAt = null,
} = {}) {
  const group = resolveMeasurementGroup(groupName);
  const floor = checkedFloor(sampleFloor, group.sample_floor);
  const retention = snapshot?.retention?.current || {};
  const windowStart = isoOrNull(retention.requested_start);
  const windowEnd = isoOrNull(retention.requested_end);
  const resolvedAnchor = resolveAnchor(group, snapshot, anchor);
  const windowComplete = retention.status === "complete";
  const anchorSatisfied = Boolean(resolvedAnchor.at)
    && Boolean(windowStart)
    && Date.parse(windowStart) >= Date.parse(resolvedAnchor.at);

  const readTrafficClass = snapshot?.query?.filters?.traffic_class || null;
  const groups = (snapshot?.series || []).map((entry) => {
    const distribution = entry?.current || {};
    const sufficiency = classifyRow(distribution, {
      floor,
      windowComplete,
      anchorSatisfied,
      anchorSource: resolvedAnchor.source,
    });
    const sufficient = sufficiency === "sufficient";
    return {
      measurement_group: group.group,
      label: group.label,
      traffic_class: group.traffic_class,
      ...dimensionsOf(entry),
      sample_floor: floor,
      sampled_count: Number.isSafeInteger(distribution.sampled_count) ? distribution.sampled_count : 0,
      estimated_count: Number.isFinite(distribution.estimated_count) ? distribution.estimated_count : null,
      sufficiency,
      p50_ms: sufficient ? roundMs(distribution.percentiles?.p50) : null,
      p75_ms: sufficient ? roundMs(distribution.percentiles?.p75) : null,
      p95_ms: sufficient ? roundMs(distribution.percentiles?.p95) : null,
      first_observation_at: isoOrNull(entry?.first_observation_at),
      latest_observation_at: isoOrNull(entry?.latest_observation_at),
    };
  });

  return {
    schema: RUM_MEASUREMENT_GROUP_SCHEMA,
    measurement_group: group.group,
    label: group.label,
    traffic_class: group.traffic_class,
    measures: group.measures,
    cannot_claim: [...group.cannot_claim],
    // A read-back names one group and holds one group's rows. Two groups are two
    // documents; nothing here produces a pooled distribution.
    combined_with_other_groups: false,
    read_traffic_class: readTrafficClass,
    query_status: snapshot?.status || "unavailable",
    queried_at: isoOrNull(queriedAt) || isoOrNull(snapshot?.freshness?.queried_at),
    sample_floor: floor,
    anchor: resolvedAnchor,
    window: {
      requested_start: windowStart,
      requested_end: windowEnd,
      status: retention.status || "unavailable",
      complete: windowComplete,
      begins_at_or_after_anchor: anchorSatisfied,
    },
    groups,
  };
}

/**
 * Two read-backs are comparable only when they name the same group. A resident
 * distribution and a synthetic distribution measure different populations, so a
 * cross-group comparison is refused by name rather than produced with a caveat.
 */
export function compareMeasurementGroups(before, after) {
  if (!isRecord(before) || !isRecord(after)) {
    return { state: "not_comparable", reason: "a comparison needs two read-backs" };
  }
  if (before.measurement_group !== after.measurement_group) {
    return {
      state: "not_comparable",
      reason: `percentiles are never combined across measurement groups: ${before.measurement_group} and ${after.measurement_group} are separate populations`,
      groups: [before.measurement_group, after.measurement_group],
    };
  }
  return { state: "comparable", measurement_group: before.measurement_group, label: before.label };
}

/** Structural check for a labelled single-group read-back. */
export function validateMeasurementGroupReadBack(document) {
  const errors = [];
  if (!isRecord(document) || document.schema !== RUM_MEASUREMENT_GROUP_SCHEMA) {
    return { ok: false, errors: ["missing measurement group read-back"] };
  }
  let group = null;
  try {
    group = resolveMeasurementGroup(document.measurement_group);
  } catch (error) {
    return { ok: false, errors: [String(error.message)] };
  }
  if (document.label !== group.label) errors.push("the read-back must carry its group label");
  if (document.traffic_class !== group.traffic_class) {
    errors.push("the read-back must name the traffic class its group is retained under");
  }
  if (document.combined_with_other_groups !== false) {
    errors.push("a read-back must never be combined across measurement groups");
  }
  if (document.read_traffic_class != null && document.read_traffic_class !== group.traffic_class) {
    errors.push("the read filtered a traffic class the read-back does not belong to");
  }
  for (const row of document.groups || []) {
    if (row.measurement_group !== group.group || row.label !== group.label) {
      errors.push("every row must carry the group label");
    }
    if (row.sufficiency !== "sufficient"
      && (row.p50_ms != null || row.p75_ms != null || row.p95_ms != null)) {
      errors.push(`${row.metric_id}/${row.surface_id}: percentiles published without a sufficient window`);
    }
    if (row.sufficiency === "sufficient" && row.sampled_count < row.sample_floor) {
      errors.push(`${row.metric_id}/${row.surface_id}: sufficient below its own floor`);
    }
  }
  return { ok: errors.length === 0, errors };
}
