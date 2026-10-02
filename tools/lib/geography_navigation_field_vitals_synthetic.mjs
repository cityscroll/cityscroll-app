/**
 * Geography-navigation field-vitals synthetic measurement group.
 *
 * The synthetic group is retained separately from the resident observation file.
 * There is no combined / overall / total key across the two groups.
 *
 * Slot cell semantics (settled): each probe slot reports its **own contribution**
 * for the visit it just ran — never a window-to-date census. The field name
 * `cell_contribution_counts` matches that meaning. `applyProbeSlot` accumulates
 * those per-slot contributions into the aggregate cells (and recomputes the
 * required quantile from retained samples) rather than assigning the latest
 * slot's counts over the matrix. A slot with no `cells` array is distinct from
 * a slot whose cells are present but all zero; both yield zero contribution,
 * and any retained observations that do not land in a vital×viewport cell are
 * recorded as `unattributed_observation_count` so "retained N" cannot read as
 * floor progress when no cell moved.
 */

import { createHash } from "node:crypto";

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
 * Empty per-slot contribution matrix (six vital×viewport keys at zero).
 * @returns {Record<string, number>}
 */
export function emptyCellContributionCounts() {
  const counts = {};
  for (const metric_id of SYNTHETIC_REQUIRED_METRICS) {
    for (const device_class of SYNTHETIC_REQUIRED_VIEWPORTS) {
      counts[cellKey(metric_id, device_class)] = 0;
    }
  }
  return counts;
}

/**
 * Sum of per-cell contribution counts.
 * @param {Record<string, number> | null | undefined} counts
 */
export function sumCellContributionCounts(counts) {
  if (!counts || typeof counts !== "object") return 0;
  let total = 0;
  for (const value of Object.values(counts)) {
    total += Number(value) || 0;
  }
  return total;
}

/**
 * p75 (or other fraction) over a finite sample list. Returns null when empty.
 * @param {number[]} values
 * @param {number} [fraction=0.75]
 */
export function computeSyntheticQuantile(values, fraction = 0.75) {
  const sorted = (Array.isArray(values) ? values : [])
    .filter((value) => typeof value === "number" && Number.isFinite(value))
    .sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

/**
 * Project retained RUM observations into the six vital×viewport cells.
 * An observation attributes to exactly one cell when its metric_id is one of
 * the three required vitals and its device_class is desktop or mobile; every
 * other retained observation is unattributed (never silently dropped).
 *
 * @param {object[] | null | undefined} observations
 * @param {{ surface_id?: string }} [options]
 * @returns {{ cells: object[], unattributed_observation_count: number, attributed_observation_count: number }}
 */
export function projectObservationsToSyntheticCells(observations, options = {}) {
  const surfaceId = options.surface_id || "near-you";
  const samplesByKey = new Map();
  for (const metric_id of SYNTHETIC_REQUIRED_METRICS) {
    for (const device_class of SYNTHETIC_REQUIRED_VIEWPORTS) {
      samplesByKey.set(cellKey(metric_id, device_class), []);
    }
  }

  let unattributed = 0;
  let attributed = 0;
  const rows = Array.isArray(observations) ? observations : [];
  for (const row of rows) {
    if (!row || typeof row !== "object") {
      unattributed += 1;
      continue;
    }
    const metricId = row.metric_id;
    const deviceClass = row.device_class;
    const value = row.value;
    const key = cellKey(metricId, deviceClass);
    if (
      SYNTHETIC_REQUIRED_METRICS.includes(metricId)
      && SYNTHETIC_REQUIRED_VIEWPORTS.includes(deviceClass)
      && typeof value === "number"
      && Number.isFinite(value)
      && value >= 0
    ) {
      samplesByKey.get(key).push(value);
      attributed += 1;
    } else {
      unattributed += 1;
    }
  }

  const cells = SYNTHETIC_REQUIRED_METRICS.flatMap((metric_id) =>
    SYNTHETIC_REQUIRED_VIEWPORTS.map((device_class) => {
      const key = cellKey(metric_id, device_class);
      const samples = samplesByKey.get(key);
      return {
        metric_id,
        device_class,
        surface_id: surfaceId,
        sampled_count: samples.length,
        samples: [...samples],
        quantile_value: null,
      };
    }),
  );

  return {
    cells,
    unattributed_observation_count: unattributed,
    attributed_observation_count: attributed,
  };
}

/**
 * Resolve a slot's contribution cells and attribution source.
 *
 * Distinguishes:
 * - `slot_cells`: payload carried a cells array (even when every count is 0)
 * - `projected_from_observations`: no cells array; projected from observations[]
 * - `cells_absent`: neither cells nor observations — contribution is zero and
 *   every retained observation is unattributed
 *
 * @param {object} slot
 * @returns {{
 *   cells: object[],
 *   counts: Record<string, number>,
 *   samples: Record<string, number[]>,
 *   attribution_source: "slot_cells" | "projected_from_observations" | "cells_absent",
 *   unattributed_observation_count: number,
 * }}
 */
export function resolveSlotContribution(slot) {
  const counts = emptyCellContributionCounts();
  const samples = {};
  for (const key of Object.keys(counts)) samples[key] = [];

  const retained = Number(slot?.retained_observation_count) || Number(slot?.observations_emitted) || 0;
  const surfaceId = slot?.surface_id || "near-you";

  let cells;
  let attributionSource;
  let unattributed;

  if (Array.isArray(slot?.cells)) {
    attributionSource = "slot_cells";
    cells = slot.cells;
    for (const cell of cells) {
      const key = cellKey(cell?.metric_id, cell?.device_class);
      if (!(key in counts)) continue;
      const n = Number(cell?.sampled_count) || 0;
      counts[key] = n;
      const cellSamples = Array.isArray(cell?.samples)
        ? cell.samples.filter((value) => typeof value === "number" && Number.isFinite(value))
        : [];
      samples[key] = cellSamples;
    }
    if (typeof slot?.unattributed_observation_count === "number" && Number.isFinite(slot.unattributed_observation_count)) {
      unattributed = Math.max(0, Number(slot.unattributed_observation_count));
    } else {
      unattributed = Math.max(0, retained - sumCellContributionCounts(counts));
    }
  } else if (Array.isArray(slot?.observations)) {
    attributionSource = "projected_from_observations";
    const projected = projectObservationsToSyntheticCells(slot.observations, { surface_id: surfaceId });
    cells = projected.cells;
    for (const cell of cells) {
      const key = cellKey(cell.metric_id, cell.device_class);
      counts[key] = Number(cell.sampled_count) || 0;
      samples[key] = Array.isArray(cell.samples) ? [...cell.samples] : [];
    }
    unattributed = projected.unattributed_observation_count;
  } else {
    attributionSource = "cells_absent";
    cells = [];
    unattributed = Math.max(0, retained);
  }

  return {
    cells,
    counts,
    samples,
    attribution_source: attributionSource,
    unattributed_observation_count: unattributed,
  };
}

/**
 * Per-cell contribution counts a slot claims (zeros when the slot retained nothing
 * attributable). Uses {@link resolveSlotContribution} so observation-only slots
 * still project, and cells-absent slots stay explicitly zero.
 * @param {object} slot
 * @returns {Record<string, number>}
 */
export function slotCellContributionCounts(slot) {
  return resolveSlotContribution(slot).counts;
}

/**
 * Retained observations that did not land in a vital×viewport cell.
 * @param {object} slot
 * @returns {number}
 */
export function slotUnattributedObservationCount(slot) {
  return resolveSlotContribution(slot).unattributed_observation_count;
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
 * Native (live) applies omit provenance; back-filled applies attach it via
 * {@link withSlotProvenance} / {@link applyProbeSlot} options so the marker's
 * presence is the distinction.
 * @param {object} slot
 */
export function buildSlotLedgerEntry(slot) {
  const slotId = slot?.run_key || slot?.slot_id || null;
  if (!slotId) {
    throw new Error("probe slot requires run_key or slot_id to record itself");
  }
  const outcome = deriveSlotOutcome(slot);
  const finishedAt = slot?.finished_at || slot?.observed_at || null;
  const contribution = resolveSlotContribution(slot);
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
    cell_contribution_counts: contribution.counts,
    cell_samples: contribution.samples,
    unattributed_observation_count: contribution.unattributed_observation_count,
    attribution_source: contribution.attribution_source,
    probe_status: slot?.status || null,
    outcome,
  };
}

/**
 * Recompute aggregate cells by summing every slot's per-visit contribution.
 * Slot payloads are contributions, not window censuses; this is the accumulate path.
 * @param {object} aggregate
 * @returns {object}
 */
export function recomputeAggregateCellsFromSlots(aggregate) {
  if (!aggregate || typeof aggregate !== "object") {
    throw new Error("recomputeAggregateCellsFromSlots requires an aggregate");
  }
  const counts = emptyCellContributionCounts();
  const samples = {};
  for (const key of Object.keys(counts)) samples[key] = [];

  for (const entry of Array.isArray(aggregate.slots) ? aggregate.slots : []) {
    const contrib = entry?.cell_contribution_counts || emptyCellContributionCounts();
    for (const [key, value] of Object.entries(contrib)) {
      if (key in counts) counts[key] += Number(value) || 0;
    }
    const entrySamples = entry?.cell_samples || {};
    for (const [key, values] of Object.entries(entrySamples)) {
      if (!(key in samples) || !Array.isArray(values)) continue;
      for (const value of values) {
        if (typeof value === "number" && Number.isFinite(value)) samples[key].push(value);
      }
    }
  }

  const surfaceId = aggregate.surface_id || "near-you";
  const floor = Number(aggregate.sample_floor) || GEOGRAPHY_NAVIGATION_FIELD_VITALS_SYNTHETIC_SAMPLE_FLOOR;
  aggregate.cells = SYNTHETIC_REQUIRED_METRICS.flatMap((metric_id) =>
    SYNTHETIC_REQUIRED_VIEWPORTS.map((device_class) => {
      const key = cellKey(metric_id, device_class);
      const n = counts[key];
      const cellSamples = samples[key];
      let quantile_value = null;
      if (n >= floor && cellSamples.length > 0) {
        quantile_value = computeSyntheticQuantile(cellSamples, aggregate.required_quantile || 0.75);
      }
      return classifySyntheticCell({
        metric_id,
        device_class,
        sampled_count: n,
        quantile_value,
        surface_id: surfaceId,
        samples: cellSamples,
      });
    }),
  );
  return aggregate;
}

/**
 * Fill attribution fields on legacy ledger entries that predate them.
 * @param {object} entry
 * @returns {object}
 */
export function normalizeSlotLedgerEntry(entry) {
  if (!entry || typeof entry !== "object") return entry;
  const next = { ...entry };
  if (!next.cell_contribution_counts || typeof next.cell_contribution_counts !== "object") {
    next.cell_contribution_counts = emptyCellContributionCounts();
  } else {
    const filled = emptyCellContributionCounts();
    for (const key of Object.keys(filled)) {
      filled[key] = Number(next.cell_contribution_counts[key]) || 0;
    }
    next.cell_contribution_counts = filled;
  }
  if (!next.cell_samples || typeof next.cell_samples !== "object") {
    next.cell_samples = Object.fromEntries(
      Object.keys(next.cell_contribution_counts).map((key) => [key, []]),
    );
  }
  if (
    typeof next.unattributed_observation_count !== "number"
    || !Number.isFinite(next.unattributed_observation_count)
  ) {
    const retained = Number(next.retained_observation_count) || Number(next.observations_emitted) || 0;
    next.unattributed_observation_count = Math.max(
      0,
      retained - sumCellContributionCounts(next.cell_contribution_counts),
    );
  }
  if (!next.attribution_source) {
    const contributed = sumCellContributionCounts(next.cell_contribution_counts);
    if (contributed > 0) next.attribution_source = "slot_cells";
    else if ((Number(next.retained_observation_count) || 0) > 0) next.attribution_source = "cells_absent";
    else next.attribution_source = "cells_absent";
  }
  return next;
}

/** @param {string | Uint8Array | Buffer} bytesOrString */
export function sha256Digest(bytesOrString) {
  return `sha256:${createHash("sha256").update(bytesOrString).digest("hex")}`;
}

/**
 * Stable JSON for digests: sorted object keys, arrays keep order, no whitespace.
 * @param {unknown} value
 */
export function canonicalizeForDigest(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeForDigest(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalizeForDigest(value[key])}`).join(",")}}`;
}

/** Strip provenance so native and back-filled entries share one core shape. */
export function slotValuesWithoutProvenance(entry) {
  if (!entry || typeof entry !== "object") return entry;
  const { provenance: _drop, ...rest } = entry;
  return rest;
}

/**
 * Ledger fields frozen into back-fill digests. Additive attribution fields
 * (`cell_samples`, `unattributed_observation_count`, `attribution_source`) are
 * verified in tests and on apply, but must not invalidate historical
 * `values_sha256` digests written before those fields existed.
 * @param {object} entry
 */
export function slotValuesForDigest(entry) {
  const rest = slotValuesWithoutProvenance(entry);
  if (!rest || typeof rest !== "object") return rest;
  const {
    cell_samples: _samples,
    unattributed_observation_count: _unattributed,
    attribution_source: _source,
    ...core
  } = rest;
  return core;
}

/** Digest of the ledger values taken from an artifact (never of the entry-with-provenance). */
export function digestSlotLedgerValues(entry) {
  return sha256Digest(canonicalizeForDigest(slotValuesForDigest(entry)));
}

export function digestArtifactBytes(bytes) {
  return sha256Digest(bytes);
}

/**
 * Provenance for a slot written from a workflow artifact rather than a live apply.
 * Native slots omit this object; presence of `writing: "back_filled"` is the marker.
 *
 * When the artifact has already expired, set `verifiable: false` and name why —
 * never invent a digest from the entry itself (a self-digest proves nothing).
 *
 * @param {object} args
 */
export function buildBackFilledSlotProvenance({
  artifactId = null,
  artifactName = null,
  runId,
  runAttempt = null,
  repository = "cityscroll/cityscroll-app",
  memberPath = "slot.json",
  artifactSha256 = null,
  valuesSha256 = null,
  retrievedAt = null,
  expiresAt = null,
  verifiable = true,
  unverifiableReason = null,
} = {}) {
  const artifact = {
    kind: "github_actions_workflow_artifact",
    repository,
    run_id: runId != null ? String(runId) : null,
    run_attempt: runAttempt != null ? String(runAttempt) : null,
    artifact_id: artifactId != null ? String(artifactId) : null,
    artifact_name: artifactName,
    member_path: memberPath,
    expires_at: expiresAt,
  };

  if (!verifiable) {
    return {
      writing: "back_filled",
      verifiable: false,
      unverifiable_reason: unverifiableReason || "workflow_artifact_expired",
      artifact,
      retrieved_at: retrievedAt,
      artifact_sha256: null,
      values_sha256: null,
    };
  }

  if (!artifactSha256 || !valuesSha256) {
    throw new Error("verifiable back-fill provenance requires artifact_sha256 and values_sha256");
  }
  if (!artifactId || !artifactName || runId == null) {
    throw new Error("verifiable back-fill provenance requires artifact id, name, and run id");
  }

  const normalize = (digest) =>
    String(digest).startsWith("sha256:") ? String(digest) : `sha256:${digest}`;

  return {
    writing: "back_filled",
    verifiable: true,
    unverifiable_reason: null,
    artifact,
    retrieved_at: retrievedAt,
    artifact_sha256: normalize(artifactSha256),
    values_sha256: normalize(valuesSha256),
  };
}

/** Attach provenance onto a ledger entry. Native entries never call this. */
export function withSlotProvenance(entry, provenance) {
  if (!entry || typeof entry !== "object") {
    throw new Error("withSlotProvenance requires a ledger entry");
  }
  if (!provenance || typeof provenance !== "object" || provenance.writing !== "back_filled") {
    throw new Error('withSlotProvenance requires provenance.writing === "back_filled"');
  }
  return { ...entry, provenance };
}

/**
 * Verify a back-filled entry against the artifact member it claims.
 * Altering a back-filled value without updating the digest fails closed.
 *
 * @param {object} entry
 * @param {string | Uint8Array | Buffer} artifactBytes
 * @param {object | null} [artifactJson]
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function verifyBackFilledSlotAgainstArtifact(entry, artifactBytes, artifactJson = null) {
  const provenance = entry?.provenance;
  if (!provenance || provenance.writing !== "back_filled") {
    return { ok: false, reason: "not_back_filled" };
  }
  if (provenance.verifiable === false) {
    return { ok: false, reason: "recorded_unverifiable" };
  }
  if (!provenance.artifact_sha256 || !provenance.values_sha256) {
    return { ok: false, reason: "missing_digests" };
  }

  // Refuse a digest of the full entry (including provenance): that is a self-digest.
  const fullEntryDigest = sha256Digest(canonicalizeForDigest(entry));
  if (provenance.values_sha256 === fullEntryDigest) {
    return { ok: false, reason: "self_digest_of_full_entry" };
  }

  const artifactDigest = digestArtifactBytes(artifactBytes);
  if (artifactDigest !== provenance.artifact_sha256) {
    return { ok: false, reason: "artifact_digest_mismatch" };
  }

  const text =
    typeof artifactBytes === "string"
      ? artifactBytes
      : Buffer.from(artifactBytes).toString("utf8");
  const parsed = artifactJson ?? JSON.parse(text);
  const expectedEntry = buildSlotLedgerEntry(parsed);
  const expectedValuesDigest = digestSlotLedgerValues(expectedEntry);
  if (expectedValuesDigest !== provenance.values_sha256) {
    return { ok: false, reason: "values_digest_mismatch" };
  }

  const actualCore = slotValuesForDigest(entry);
  const expectedCore = slotValuesForDigest(expectedEntry);
  if (canonicalizeForDigest(actualCore) !== canonicalizeForDigest(expectedCore)) {
    return { ok: false, reason: "entry_values_mutated" };
  }

  return { ok: true };
}

/**
 * Classify a cell from a sampled count and optional quantile value.
 * Below the floor the percentile stays withheld. At or above the floor the
 * quantile is published when a finite value (or recomputed samples) is present;
 * a missing quantile at the floor withholds rather than inventing a pass/fail.
 * @param {{ metric_id: string, device_class: string, sampled_count: number, quantile_value?: number | null, surface_id?: string, samples?: number[] }} args
 */
export function classifySyntheticCell({
  metric_id,
  device_class,
  sampled_count,
  quantile_value = null,
  surface_id = "near-you",
  samples = null,
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
  let value = typeof quantile_value === "number" && Number.isFinite(quantile_value) ? quantile_value : null;
  if (value == null && Array.isArray(samples) && samples.length > 0) {
    value = computeSyntheticQuantile(samples, 0.75);
  }
  if (value == null) {
    return {
      ...base,
      sampled_count: n,
      status: "insufficient_sample",
      quantile_value: null,
      percentile_withheld: true,
      pass: null,
      reason: "quantile_samples_missing",
    };
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
 * Pass `options.provenance` only for a back-filled apply so the ledger marks the
 * entry; native workflow applies omit it and stay marker-free.
 *
 * @param {object} aggregate
 * @param {object} slot
 * @param {{ provenance?: object }} [options]
 * @returns {object}
 */
export function applyProbeSlot(aggregate, slot, options = {}) {
  if (!aggregate || aggregate.schema !== GEOGRAPHY_NAVIGATION_FIELD_VITALS_SYNTHETIC_SCHEMA) {
    throw new Error("applyProbeSlot requires a synthetic field-vitals aggregate");
  }
  const next = normalizeSyntheticAggregate(aggregate);
  const retained = slotRetainedObservation(slot);
  let entry = buildSlotLedgerEntry(slot);
  if (options?.provenance) {
    entry = withSlotProvenance(entry, options.provenance);
  }

  // Replace-by-slot_id keeps re-applies idempotent: cells are recomputed from the
  // full ledger, so a repeated slot_id does not double-count its contribution.
  const existingIndex = next.slots.findIndex((row) => row?.slot_id === entry.slot_id);
  if (existingIndex >= 0) next.slots[existingIndex] = entry;
  else next.slots.push(entry);

  recomputeAggregateCellsFromSlots(next);

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
  next.slots = next.slots.map((entry) => normalizeSlotLedgerEntry(entry));
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

  const pendingNormalized = normalizeSyntheticAggregate(pending);
  const pendingRead = readSyntheticAggregate(pendingNormalized);
  if (!pendingRead.ok) {
    throw new Error(
      `pending synthetic aggregate invalid: ${pendingRead.reason} missing_field=${pendingRead.missing_field}`,
    );
  }
  const pendingDoc = pendingRead.document;
  const pendingSlot = pendingDoc.delivery?.slot_id;
  const baseSlot = base.delivery?.slot_id;

  // Open-branch tip already carries the unmerged retaining slot: use it whole,
  // with cells recomputed from its slot contributions.
  if (pendingSlot && pendingSlot !== baseSlot) {
    const whole = structuredClone(pendingDoc);
    recomputeAggregateCellsFromSlots(whole);
    whole.probe_state = classifySyntheticProbeState(whole);
    return whole;
  }
  if (pendingDoc.delivery?.at && !base.delivery?.at) {
    const whole = structuredClone(pendingDoc);
    recomputeAggregateCellsFromSlots(whole);
    whole.probe_state = classifySyntheticProbeState(whole);
    return whole;
  }

  // Union slot ledger entries by slot_id so an open empty/retaining tip is not lost.
  // Cells are recomputed from the unioned contributions (accumulate), never by
  // taking max(committed, pending) assignment.
  const slotById = new Map(
    (base.slots || []).map((entry) => [entry.slot_id, normalizeSlotLedgerEntry(structuredClone(entry))]),
  );
  for (const entry of pendingDoc.slots || []) {
    if (!entry?.slot_id) continue;
    if (!slotById.has(entry.slot_id)) {
      slotById.set(entry.slot_id, normalizeSlotLedgerEntry(structuredClone(entry)));
    }
  }
  base.slots = [...slotById.values()];
  recomputeAggregateCellsFromSlots(base);
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
  // Fill additive attribution fields on legacy ledger rows before validating so
  // a tip that predates those fields still reads without rewriting the file.
  document.slots = document.slots.map((entry) => normalizeSlotLedgerEntry(entry));
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
    for (const field of [
      "slot_id",
      "trigger",
      "outcome",
      "cell_contribution_counts",
      "unattributed_observation_count",
    ]) {
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
