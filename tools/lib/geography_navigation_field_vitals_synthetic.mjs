/**
 * Geography-navigation field-vitals synthetic measurement group.
 *
 * The synthetic group is retained separately from the resident observation file.
 * There is no combined / overall / total key across the two groups.
 */

export const GEOGRAPHY_NAVIGATION_FIELD_VITALS_SYNTHETIC_SCHEMA =
  "cityscroll.geography_navigation_field_vitals_synthetic_aggregate.v1";

export const GEOGRAPHY_NAVIGATION_FIELD_VITALS_SYNTHETIC_SAMPLE_FLOOR = 30;

export const SYNTHETIC_REQUIRED_METRICS = Object.freeze(["lcp_ms", "inp_ms", "cls_score"]);
export const SYNTHETIC_REQUIRED_VIEWPORTS = Object.freeze(["desktop", "mobile"]);

export const SYNTHETIC_BUDGETS = Object.freeze({
  lcp_ms: 2500,
  inp_ms: 200,
  cls_score: 0.1,
});

const FORBIDDEN_CROSS_GROUP_KEYS = Object.freeze([
  "combined",
  "overall",
  "total",
  "grand_total",
  "pooled",
  "merged_groups",
]);

/** Keys that look like cross-group totals but are explicit non-pooling flags. */
const ALLOWED_COMBINED_FLAG_KEYS = Object.freeze(["combined_with_other_groups"]);

/**
 * @param {string} metricId
 * @param {string} deviceClass
 */
export function cellKey(metricId, deviceClass) {
  return `${metricId}::${deviceClass}`;
}

/**
 * Empty per-cell row for a vital×viewport matrix cell.
 * @param {{ metric_id: string, device_class: string, surface_id?: string }} args
 */
export function emptySyntheticCell({ metric_id, device_class, surface_id = "near-you" }) {
  const budget = SYNTHETIC_BUDGETS[metric_id];
  if (budget == null) {
    throw new Error(`unknown metric_id: ${metric_id}`);
  }
  if (!SYNTHETIC_REQUIRED_VIEWPORTS.includes(device_class)) {
    throw new Error(`unknown device_class: ${device_class}`);
  }
  return {
    surface_id,
    metric_id,
    device_class,
    measurement_group: "synthetic",
    traffic_class: "synthetic",
    sampled_count: 0,
    status: "no_data",
    quantile: 0.75,
    quantile_value: null,
    percentile_withheld: true,
    budget,
    pass: null,
  };
}

/** Build the six required near-you synthetic cells. */
export function buildEmptySyntheticCells(surfaceId = "near-you") {
  const cells = [];
  for (const metric_id of SYNTHETIC_REQUIRED_METRICS) {
    for (const device_class of SYNTHETIC_REQUIRED_VIEWPORTS) {
      cells.push(emptySyntheticCell({ metric_id, device_class, surface_id: surfaceId }));
    }
  }
  return cells;
}

/**
 * Group-level delivery/anchor for the synthetic measurement group.
 * merge_commit and pull_request are explicitly null (probe slot, not a delivery).
 * `trigger` is captured at run time by the scheduled producer (`schedule` or
 * `workflow_dispatch`), and stays null until the first retaining slot.
 * @param {{ at?: string | null, slot_id?: string | null, source?: string, trigger?: string | null }} [args]
 */
export function syntheticGroupDelivery({
  at = null,
  slot_id = null,
  source = "unset",
  trigger = null,
} = {}) {
  return {
    kind: "first_probe_slot",
    at,
    slot_id,
    source,
    trigger,
    merge_commit: null,
    pull_request: null,
    note: "First synthetic probe slot that retained an observation.",
  };
}

/**
 * @param {object} [options]
 */
export function emptySyntheticAggregate(options = {}) {
  return {
    schema: GEOGRAPHY_NAVIGATION_FIELD_VITALS_SYNTHETIC_SCHEMA,
    measurement_group: "synthetic",
    traffic_class: "synthetic",
    surface_id: options.surface_id || "near-you",
    sample_floor: GEOGRAPHY_NAVIGATION_FIELD_VITALS_SYNTHETIC_SAMPLE_FLOOR,
    required_quantile: 0.75,
    required_metrics: [...SYNTHETIC_REQUIRED_METRICS],
    required_viewports: [...SYNTHETIC_REQUIRED_VIEWPORTS],
    budgets: { ...SYNTHETIC_BUDGETS },
    dataset: "crol_rum_observations_v1",
    combined_with_other_groups: false,
    delivery: syntheticGroupDelivery(),
    cells: buildEmptySyntheticCells(options.surface_id || "near-you"),
    resident_observation_path:
      options.resident_observation_path ||
      "docs/evidence/geography-navigation-release/field-vitals-observation.json",
    note:
      "Synthetic geography-navigation field-vitals aggregate. Resident values live in the sibling " +
      "field-vitals-observation.json and are never pooled into this file.",
  };
}

/**
 * Classify a cell from a sampled count and optional quantile value.
 * @param {{ metric_id: string, device_class: string, sampled_count: number, quantile_value?: number | null, surface_id?: string }} args
 */
export function classifySyntheticCell({
  metric_id,
  device_class,
  sampled_count,
  quantile_value = null,
  surface_id = "near-you",
}) {
  const base = emptySyntheticCell({ metric_id, device_class, surface_id });
  const n = Number(sampled_count) || 0;
  const floor = GEOGRAPHY_NAVIGATION_FIELD_VITALS_SYNTHETIC_SAMPLE_FLOOR;
  const budget = base.budget;

  if (n <= 0) {
    return { ...base, sampled_count: 0, status: "no_data", quantile_value: null, percentile_withheld: true, pass: null };
  }
  if (n < floor) {
    return {
      ...base,
      sampled_count: n,
      status: "insufficient_sample",
      quantile_value: null,
      percentile_withheld: true,
      pass: null,
      reason: "below_floor",
    };
  }
  const value = typeof quantile_value === "number" && Number.isFinite(quantile_value) ? quantile_value : null;
  if (value == null) {
    throw new Error(`quantile_value required when sampled_count >= sample_floor (${metric_id}/${device_class})`);
  }
  return {
    ...base,
    sampled_count: n,
    status: "available",
    quantile_value: value,
    percentile_withheld: false,
    pass: value <= budget,
    reason: null,
  };
}

/**
 * Whether a probe slot result retained any observation (load-bearing for the anchor).
 * @param {{ observations_emitted?: number, retained_observation_count?: number, cells?: object[] } | null | undefined} slot
 */
export function slotRetainedObservation(slot) {
  if (!slot || typeof slot !== "object") return false;
  if (Number(slot.retained_observation_count) > 0) return true;
  if (Number(slot.observations_emitted) > 0) return true;
  if (Array.isArray(slot.cells) && slot.cells.some((cell) => Number(cell?.sampled_count) > 0)) {
    return true;
  }
  return false;
}

/**
 * Apply one probe slot to an aggregate.
 * A slot that retains nothing does not advance or set the delivery.
 * The first slot that retains an observation sets the first_probe_slot delivery.
 *
 * @param {object} aggregate
 * @param {object} slot
 * @returns {object}
 */
export function applyProbeSlot(aggregate, slot) {
  if (!aggregate || aggregate.schema !== GEOGRAPHY_NAVIGATION_FIELD_VITALS_SYNTHETIC_SCHEMA) {
    throw new Error("applyProbeSlot requires a synthetic field-vitals aggregate");
  }
  const next = structuredClone(aggregate);
  const retained = slotRetainedObservation(slot);

  if (Array.isArray(slot?.cells)) {
    const byKey = new Map(next.cells.map((cell) => [cellKey(cell.metric_id, cell.device_class), cell]));
    for (const incoming of slot.cells) {
      const key = cellKey(incoming.metric_id, incoming.device_class);
      const classified = classifySyntheticCell({
        metric_id: incoming.metric_id,
        device_class: incoming.device_class,
        sampled_count: incoming.sampled_count,
        quantile_value: incoming.quantile_value,
        surface_id: incoming.surface_id || next.surface_id,
      });
      byKey.set(key, classified);
    }
    next.cells = SYNTHETIC_REQUIRED_METRICS.flatMap((metric_id) =>
      SYNTHETIC_REQUIRED_VIEWPORTS.map((device_class) => {
        const key = cellKey(metric_id, device_class);
        return byKey.get(key) || emptySyntheticCell({ metric_id, device_class, surface_id: next.surface_id });
      }),
    );
  }

  if (retained) {
    const existingAt = next.delivery?.at;
    if (!existingAt) {
      next.delivery = syntheticGroupDelivery({
        at: slot.observed_at || slot.retained_at || null,
        slot_id: slot.run_key || slot.slot_id || null,
        source: "first_retained_observation",
        trigger: slot.trigger ?? null,
      });
    }
  }

  next.updated_at = slot?.observed_at || next.updated_at || null;
  return next;
}

/**
 * Parse an unmerged automation-branch aggregate (the open refresh-PR tip).
 * @param {string} text
 * @returns {object}
 */
export function loadPendingSyntheticAggregate(text) {
  const document = JSON.parse(text);
  const read = readSyntheticAggregate(document);
  if (!read.ok) {
    throw new Error(
      `pending synthetic aggregate invalid: ${read.reason} missing_field=${read.missing_field}`,
    );
  }
  return read.document;
}

/**
 * Fold a still-open automation-branch aggregate under the committed tip so an
 * overlapping run does not rebuild from main alone and drop the unmerged slot.
 * Prefer the pending tip when it retains a first-probe delivery the committed
 * tip lacks; otherwise keep the committed tip (pending absent or empty).
 *
 * @param {object | null | undefined} committed
 * @param {object | null | undefined} pending
 * @returns {object}
 */
export function foldPendingSyntheticAggregate(committed, pending) {
  const base = committed && typeof committed === "object"
    ? structuredClone(committed)
    : emptySyntheticAggregate();
  if (!pending || typeof pending !== "object") return base;

  const pendingRead = readSyntheticAggregate(pending);
  if (!pendingRead.ok) {
    throw new Error(
      `pending synthetic aggregate invalid: ${pendingRead.reason} missing_field=${pendingRead.missing_field}`,
    );
  }
  const pendingDoc = pendingRead.document;
  const pendingSlot = pendingDoc.delivery?.slot_id;
  const baseSlot = base.delivery?.slot_id;

  // Open-branch tip already carries the unmerged retaining slot: use it whole.
  if (pendingSlot && pendingSlot !== baseSlot) {
    return structuredClone(pendingDoc);
  }
  if (pendingDoc.delivery?.at && !base.delivery?.at) {
    return structuredClone(pendingDoc);
  }

  // Same first-slot identity (or neither retaining): keep committed cells, but
  // never let pending cell counts fall below what the open branch already held.
  const byKey = new Map(
    (base.cells || []).map((cell) => [cellKey(cell.metric_id, cell.device_class), cell]),
  );
  for (const incoming of pendingDoc.cells || []) {
    const key = cellKey(incoming.metric_id, incoming.device_class);
    const current = byKey.get(key);
    if (!current || Number(incoming.sampled_count) > Number(current.sampled_count)) {
      byKey.set(key, structuredClone(incoming));
    }
  }
  base.cells = SYNTHETIC_REQUIRED_METRICS.flatMap((metric_id) =>
    SYNTHETIC_REQUIRED_VIEWPORTS.map((device_class) => {
      const key = cellKey(metric_id, device_class);
      return byKey.get(key) || emptySyntheticCell({ metric_id, device_class, surface_id: base.surface_id });
    }),
  );
  return base;
}

/**
 * Retained first-probe slots present on the pending tip but absent from proposed.
 * @param {object | null | undefined} pending
 * @param {object | null | undefined} proposed
 * @returns {{ slot_id: string, at: string | null, trigger: string | null }[]}
 */
export function retainedSlotsDropped(pending, proposed) {
  const pendingSlot = pending?.delivery?.slot_id;
  if (!pendingSlot) return [];
  const proposedSlot = proposed?.delivery?.slot_id;
  if (proposedSlot === pendingSlot) return [];
  return [
    {
      slot_id: pendingSlot,
      at: pending?.delivery?.at ?? null,
      trigger: pending?.delivery?.trigger ?? null,
    },
  ];
}

/**
 * Positive control: a publish that would drop a still-open automation-branch
 * first-probe slot fails instead of force-updating the quieter tip.
 * @param {object | null | undefined} pending
 * @param {object | null | undefined} proposed
 */
export function assertSyntheticAggregateRetainsPending(pending, proposed) {
  if (!pending) return;
  const dropped = retainedSlotsDropped(pending, proposed);
  if (!dropped.length) return;
  const names = dropped
    .map((entry) => `${entry.slot_id} (${entry.trigger || "unknown"}, ${entry.at || "no-time"})`)
    .join("; ");
  throw new Error(`synthetic field-vitals aggregate would drop retained slot(s): ${names}`);
}

/**
 * Refuse an aggregate missing required per-cell fields; name the missing field.
 * @param {unknown} document
 * @returns {{ ok: true, document: object } | { ok: false, reason: string, missing_field: string | null, state: 'absent' | 'unread' | 'invalid' }}
 */
export function readSyntheticAggregate(document) {
  if (document == null) {
    return { ok: false, reason: "aggregate_absent", missing_field: null, state: "absent" };
  }
  if (typeof document !== "object" || Array.isArray(document)) {
    return { ok: false, reason: "aggregate_unread", missing_field: null, state: "unread" };
  }
  if (document.schema !== GEOGRAPHY_NAVIGATION_FIELD_VITALS_SYNTHETIC_SCHEMA) {
    return {
      ok: false,
      reason: "unexpected_schema",
      missing_field: "schema",
      state: "invalid",
    };
  }

  const requiredTop = [
    "measurement_group",
    "traffic_class",
    "sample_floor",
    "required_metrics",
    "required_viewports",
    "budgets",
    "delivery",
    "cells",
  ];
  for (const field of requiredTop) {
    if (!(field in document) || document[field] == null) {
      return { ok: false, reason: "missing_required_field", missing_field: field, state: "invalid" };
    }
  }

  if (document.measurement_group !== "synthetic" || document.traffic_class !== "synthetic") {
    return {
      ok: false,
      reason: "measurement_group_mismatch",
      missing_field: "measurement_group",
      state: "invalid",
    };
  }

  const delivery = document.delivery;
  if (typeof delivery !== "object" || delivery == null || Array.isArray(delivery)) {
    return { ok: false, reason: "missing_required_field", missing_field: "delivery", state: "invalid" };
  }
  for (const field of ["kind", "merge_commit", "pull_request", "trigger"]) {
    if (!(field in delivery)) {
      return { ok: false, reason: "missing_required_field", missing_field: `delivery.${field}`, state: "invalid" };
    }
  }
  if (delivery.merge_commit !== null || delivery.pull_request !== null) {
    return {
      ok: false,
      reason: "delivery_must_null_merge_fields",
      missing_field: "delivery.merge_commit",
      state: "invalid",
    };
  }
  if (delivery.kind !== "first_probe_slot") {
    return { ok: false, reason: "unexpected_delivery_kind", missing_field: "delivery.kind", state: "invalid" };
  }

  if (!Array.isArray(document.cells)) {
    return { ok: false, reason: "missing_required_field", missing_field: "cells", state: "invalid" };
  }

  const requiredCellFields = [
    "surface_id",
    "metric_id",
    "device_class",
    "measurement_group",
    "traffic_class",
    "sampled_count",
    "status",
    "quantile",
    "quantile_value",
    "budget",
    "pass",
  ];

  const seen = new Set();
  for (const [index, cell] of document.cells.entries()) {
    if (!cell || typeof cell !== "object") {
      return { ok: false, reason: "invalid_cell", missing_field: `cells[${index}]`, state: "invalid" };
    }
    for (const field of requiredCellFields) {
      if (!(field in cell)) {
        return {
          ok: false,
          reason: "missing_required_field",
          missing_field: `cells[${index}].${field}`,
          state: "invalid",
        };
      }
    }
    seen.add(cellKey(cell.metric_id, cell.device_class));
  }

  for (const metric_id of SYNTHETIC_REQUIRED_METRICS) {
    for (const device_class of SYNTHETIC_REQUIRED_VIEWPORTS) {
      const key = cellKey(metric_id, device_class);
      if (!seen.has(key)) {
        return {
          ok: false,
          reason: "missing_required_cell",
          missing_field: `cells[${key}]`,
          state: "invalid",
        };
      }
    }
  }

  const forbidden = findForbiddenCrossGroupKeys(document);
  if (forbidden.length) {
    return {
      ok: false,
      reason: "forbidden_cross_group_key",
      missing_field: forbidden[0],
      state: "invalid",
    };
  }

  return { ok: true, document };
}

/**
 * Walk a document for forbidden combined/overall/total keys (object keys only).
 * @param {unknown} value
 * @param {string} [path]
 * @returns {string[]}
 */
export function findForbiddenCrossGroupKeys(value, path = "") {
  const found = [];
  if (!value || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      found.push(...findForbiddenCrossGroupKeys(entry, `${path}[${index}]`));
    });
    return found;
  }
  for (const [key, child] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (
      !ALLOWED_COMBINED_FLAG_KEYS.includes(key)
      && FORBIDDEN_CROSS_GROUP_KEYS.some((forbidden) => lower === forbidden || lower.startsWith(`${forbidden}_`))
    ) {
      found.push(path ? `${path}.${key}` : key);
    }
    found.push(...findForbiddenCrossGroupKeys(child, path ? `${path}.${key}` : key));
  }
  return found;
}

/**
 * Assert resident near-you honesty still holds in the sibling observation file.
 * @param {object} residentObservation
 */
export function assertResidentNearYouHonesty(residentObservation) {
  if (!residentObservation || typeof residentObservation !== "object") {
    throw new Error("resident observation missing");
  }
  const nearYou = (residentObservation.observations || []).filter((row) => row.surface_id === "near-you");
  const byKey = new Map(nearYou.map((row) => [cellKey(row.metric_id, row.device_class), row]));
  const expect = [
    ["lcp_ms", "desktop", 2, "insufficient_sample"],
    ["lcp_ms", "mobile", 0, "no_data"],
    ["inp_ms", "desktop", 0, "no_data"],
    ["inp_ms", "mobile", 0, "no_data"],
    ["cls_score", "desktop", 2, "insufficient_sample"],
    ["cls_score", "mobile", 0, "no_data"],
  ];
  for (const [metric_id, device_class, count, status] of expect) {
    const row = byKey.get(cellKey(metric_id, device_class));
    if (!row) throw new Error(`missing resident cell ${metric_id}/${device_class}`);
    if (row.sampled_count !== count) {
      throw new Error(`resident ${metric_id}/${device_class} sampled_count=${row.sampled_count} expected ${count}`);
    }
    if (row.status !== status) {
      throw new Error(`resident ${metric_id}/${device_class} status=${row.status} expected ${status}`);
    }
    if (row.quantile_value != null) {
      throw new Error(`resident ${metric_id}/${device_class} must withhold quantile_value below floor`);
    }
  }
  return true;
}
