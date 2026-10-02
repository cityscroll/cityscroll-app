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
    // Append-only probe ledger. updated_at alone must never be the only field a
    // run changes: every applied slot records itself here, including empty ones.
    slots: [],
    probe_state: "never_run",
    resident_observation_path:
      options.resident_observation_path ||
      "docs/evidence/geography-navigation-release/field-vitals-observation.json",
    note:
      "Synthetic geography-navigation field-vitals aggregate. Resident values live in the sibling " +
      "field-vitals-observation.json and are never pooled into this file.",
  };
}

/**
 * Glanceable aggregate state separable by reading the file alone.
 * - never_run: no slot entry has been recorded
 * - ran_empty: at least one slot ran and none retained observations (reasons on entries)
 * - ran_retained: at least one slot retained observations (delivery anchor set once)
 * @param {object | null | undefined} aggregate
 * @returns {"never_run" | "ran_empty" | "ran_retained"}
 */
export function classifySyntheticProbeState(aggregate) {
  const slots = Array.isArray(aggregate?.slots) ? aggregate.slots : [];
  if (slots.length === 0) return "never_run";
  const retained = slots.some(
    (entry) =>
      entry?.outcome?.retained === true
      || Number(entry?.retained_observation_count) > 0
      || Number(entry?.observations_emitted) > 0,
  );
  if (retained || aggregate?.delivery?.at) return "ran_retained";
  return "ran_empty";
}

/**
 * Per-cell contribution counts a slot claims (zeros when the slot retained nothing).
 * @param {object} slot
 * @returns {Record<string, number>}
 */
export function slotCellContributionCounts(slot) {
  const counts = {};
  for (const metric_id of SYNTHETIC_REQUIRED_METRICS) {
    for (const device_class of SYNTHETIC_REQUIRED_VIEWPORTS) {
      counts[cellKey(metric_id, device_class)] = 0;
    }
  }
  if (Array.isArray(slot?.cells)) {
    for (const cell of slot.cells) {
      const key = cellKey(cell.metric_id, cell.device_class);
      if (key in counts) counts[key] = Number(cell.sampled_count) || 0;
    }
  }
  return counts;
}

/**
 * Derive reached / collected / wrote stages and a reason when the slot retained none.
 * `wrote` is true once the builder records the slot entry into the aggregate ledger.
 * @param {object} slot
 * @returns {{ retained: boolean, stages: { reached: boolean, collected: boolean, wrote: boolean }, reason: string }}
 */
export function deriveSlotOutcome(slot) {
  const failures = Array.isArray(slot?.failures) ? slot.failures : [];
  const unreachable = failures.some((entry) => entry?.reason === "page_unreachable");
  const visitFailed = failures.some((entry) => entry?.reason === "visit_failed");
  const pagesVisited = Number(slot?.pages_visited) || 0;
  const diagnosis = slot?.collection_diagnosis && typeof slot.collection_diagnosis === "object"
    ? slot.collection_diagnosis
    : null;

  let reached = pagesVisited > 0 && !unreachable;
  if (diagnosis && typeof diagnosis.reached === "boolean") {
    reached = diagnosis.reached;
  }

  const marked = Number(slot?.marked_beacons) || 0;
  const emitted = Number(slot?.observations_emitted) || 0;
  const retainedCount = Number(slot?.retained_observation_count) || 0;
  let collected = marked > 0 || emitted > 0 || retainedCount > 0 || slotRetainedObservation(slot);
  if (diagnosis && typeof diagnosis.collected === "boolean") {
    collected = diagnosis.collected;
  }

  let reason;
  if (collected) {
    reason = "retained_observations";
  } else if (typeof diagnosis?.reason === "string" && diagnosis.reason) {
    reason = diagnosis.reason;
  } else if (!reached) {
    if (unreachable) reason = "page_unreachable";
    else if (visitFailed) reason = "visit_failed";
    else if (pagesVisited === 0 && !Array.isArray(slot?.visits)) reason = "unknown";
    else reason = "did_not_reach";
  } else if ((Number(slot?.unmarked_beacons) || 0) > 0) {
    reason = "unmarked_beacons_only";
  } else {
    reason = "reached_but_no_beacons";
  }

  return {
    retained: collected,
    stages: {
      reached,
      collected,
      wrote: true,
    },
    reason,
  };
}

/**
 * Build the append-only ledger entry for one applied probe slot.
 * @param {object} slot
 */
export function buildSlotLedgerEntry(slot) {
  const slotId = slot?.run_key || slot?.slot_id || null;
  if (!slotId) {
    throw new Error("probe slot requires run_key or slot_id to record itself");
  }
  const outcome = deriveSlotOutcome(slot);
  const finishedAt = slot?.finished_at || slot?.observed_at || null;
  return {
    slot_id: slotId,
    run_id: slot?.github_run_id || slot?.run_id || null,
    run_attempt: slot?.github_run_attempt || slot?.run_attempt || null,
    trigger: slot?.trigger ?? null,
    started_at: slot?.started_at || null,
    finished_at: finishedAt,
    observed_at: slot?.observed_at || finishedAt,
    pages_listed: Number(slot?.pages_listed) || 0,
    pages_visited: Number(slot?.pages_visited) || 0,
    observations_emitted: Number(slot?.observations_emitted) || 0,
    retained_observation_count: Number(slot?.retained_observation_count) || 0,
    marked_beacons: Number(slot?.marked_beacons) || 0,
    unmarked_beacons: Number(slot?.unmarked_beacons) || 0,
    cell_contribution_counts: slotCellContributionCounts(slot),
    probe_status: slot?.status || null,
    outcome,
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
 * Every slot records itself in `slots` (including empty ones with an outcome reason).
 * A slot that retains nothing does not advance or set the delivery anchor.
 * The first slot that retains an observation sets the first_probe_slot delivery once.
 *
 * @param {object} aggregate
 * @param {object} slot
 * @returns {object}
 */
export function applyProbeSlot(aggregate, slot) {
  if (!aggregate || aggregate.schema !== GEOGRAPHY_NAVIGATION_FIELD_VITALS_SYNTHETIC_SCHEMA) {
    throw new Error("applyProbeSlot requires a synthetic field-vitals aggregate");
  }
  const next = normalizeSyntheticAggregate(aggregate);
  const retained = slotRetainedObservation(slot);
  const entry = buildSlotLedgerEntry(slot);

  const existingIndex = next.slots.findIndex((row) => row?.slot_id === entry.slot_id);
  if (existingIndex >= 0) next.slots[existingIndex] = entry;
  else next.slots.push(entry);

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

  next.updated_at = slot?.observed_at || entry.finished_at || next.updated_at || null;
  next.probe_state = classifySyntheticProbeState(next);
  return next;
}

/**
 * Fill the slot ledger / probe_state on aggregates written before those fields existed.
 * @param {object} document
 * @returns {object}
 */
export function normalizeSyntheticAggregate(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("normalizeSyntheticAggregate requires an aggregate object");
  }
  const next = structuredClone(document);
  if (!Array.isArray(next.slots)) next.slots = [];
  next.probe_state = classifySyntheticProbeState(next);
  return next;
}

/**
 * Parse an unmerged automation-branch aggregate (the open refresh-PR tip).
 * @param {string} text
 * @returns {object}
 */
export function loadPendingSyntheticAggregate(text) {
  const document = normalizeSyntheticAggregate(JSON.parse(text));
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
  if (!Array.isArray(base.slots)) base.slots = [];
  if (!pending || typeof pending !== "object") {
    base.probe_state = classifySyntheticProbeState(base);
    return base;
  }

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

  // Union slot ledger entries by slot_id so an open empty/retaining tip is not lost.
  const slotById = new Map((base.slots || []).map((entry) => [entry.slot_id, structuredClone(entry)]));
  for (const entry of pendingDoc.slots || []) {
    if (!entry?.slot_id) continue;
    if (!slotById.has(entry.slot_id)) slotById.set(entry.slot_id, structuredClone(entry));
  }
  base.slots = [...slotById.values()];
  base.probe_state = classifySyntheticProbeState(base);
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
    "slots",
    "probe_state",
  ];
  for (const field of requiredTop) {
    if (!(field in document) || document[field] == null) {
      return { ok: false, reason: "missing_required_field", missing_field: field, state: "invalid" };
    }
  }
  if (!Array.isArray(document.slots)) {
    return { ok: false, reason: "missing_required_field", missing_field: "slots", state: "invalid" };
  }
  const expectedState = classifySyntheticProbeState(document);
  if (document.probe_state !== expectedState) {
    return {
      ok: false,
      reason: "probe_state_mismatch",
      missing_field: "probe_state",
      state: "invalid",
    };
  }
  for (const [index, entry] of document.slots.entries()) {
    if (!entry || typeof entry !== "object") {
      return { ok: false, reason: "invalid_slot_entry", missing_field: `slots[${index}]`, state: "invalid" };
    }
    for (const field of ["slot_id", "trigger", "outcome", "cell_contribution_counts"]) {
      if (!(field in entry) || entry[field] == null) {
        return {
          ok: false,
          reason: "missing_required_field",
          missing_field: `slots[${index}].${field}`,
          state: "invalid",
        };
      }
    }
    const outcome = entry.outcome;
    if (typeof outcome !== "object" || outcome == null || Array.isArray(outcome)) {
      return {
        ok: false,
        reason: "missing_required_field",
        missing_field: `slots[${index}].outcome`,
        state: "invalid",
      };
    }
    for (const field of ["retained", "stages", "reason"]) {
      if (!(field in outcome)) {
        return {
          ok: false,
          reason: "missing_required_field",
          missing_field: `slots[${index}].outcome.${field}`,
          state: "invalid",
        };
      }
    }
    const stages = outcome.stages;
    if (!stages || typeof stages !== "object") {
      return {
        ok: false,
        reason: "missing_required_field",
        missing_field: `slots[${index}].outcome.stages`,
        state: "invalid",
      };
    }
    for (const field of ["reached", "collected", "wrote"]) {
      if (!(field in stages)) {
        return {
          ok: false,
          reason: "missing_required_field",
          missing_field: `slots[${index}].outcome.stages.${field}`,
          state: "invalid",
        };
      }
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
