/**
 * SEQRA-08: the labelled corpus and rolling-origin fold primitives (card
 * acceptance A1-A5, negative rule).
 *
 * This module does not re-derive the review/spatial/institutional joins
 * SEQRA-02, SEQRA-06 and SEQRA-07 already own -- it consumes their outputs
 * (`projectReviewStateAsOf`, `joinProjectLayersAtCutoff`, public_position
 * rows) and turns them into a backtest corpus: as-of feature snapshots,
 * process-path and supplemental-review labels with right-censoring,
 * project-family-grouped rolling-origin folds, and the leakage and
 * denominator receipts a reported metric depends on.
 *
 * Scope note: target E (supplemental review) is built from the two
 * supplemental-review event types SEQRA-02's frozen ontology already
 * defines (`technical_memorandum_issued`, `supplemental_eis_initiated`).
 * A revised-EAS or formal-refusal-to-supplement event type does not yet
 * exist in `SEQRA_REVIEW_EVENT_TYPES`; adding one is an ontology change
 * outside this card's scope, not a gap this module silently papers over.
 *
 * Every function here is pure and order-independent: the same inputs
 * always produce the same output regardless of array order, matching
 * seqra_review_event_log.mjs's own determinism contract (G5, A5).
 */
import { createHash } from "node:crypto";

import { buildAppendOnlyLog, projectReviewStateAsOf } from "./seqra_review_event_log.mjs";
import { joinProjectLayersAtCutoff } from "./seqra_spatial_layer_joins.mjs";

export const SEQRA_LABEL_BUILDER_SCHEMA = "cityscroll.seqra_label_builder.v1";

/** Target A: review path. Matches spec.md's five-category enumeration exactly. */
export const PROCESS_PATH_LABELS = Object.freeze([
  "type_ii",
  "negative_declaration",
  "conditioned_negative_declaration",
  "positive_declaration_eis",
  "unknown_or_incomplete",
]);

/** Target E: supplemental review, evaluated at each of these horizons. */
export const SUPPLEMENTAL_REVIEW_HORIZONS = Object.freeze([
  "within_90_days",
  "within_180_days",
  "before_final_determination",
  "before_implementation_completion",
]);

export const EXCLUSION_REASONS = Object.freeze({
  CONTRADICTION_AT_CUTOFF: "contradiction_at_cutoff",
  FAMILY_TRAIN_TEST_CONFLICT: "family_train_test_conflict",
});

export const CENSOR_REASONS = Object.freeze({
  WINDOW_NOT_YET_OBSERVED: "window_not_yet_observed",
  DETERMINATION_NOT_YET_REACHED: "determination_not_yet_reached",
  IMPLEMENTATION_COMPLETION_NOT_YET_REACHED: "implementation_completion_not_yet_reached",
});

const REVIEW_PATH_EVENT_TYPES = Object.freeze({
  type_ii_classified: "type_ii",
  negative_declaration_issued: "negative_declaration",
  conditioned_negative_declaration_issued: "conditioned_negative_declaration",
  positive_declaration_issued: "positive_declaration_eis",
});

const SUPPLEMENTAL_REVIEW_EVENT_TYPES = Object.freeze([
  "technical_memorandum_issued",
  "supplemental_eis_initiated",
]);

export class SeqraLabelBuilderError extends Error {
  constructor(message) {
    super(message);
    this.name = "SeqraLabelBuilderError";
  }
}

function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SeqraLabelBuilderError(`${field} is required and must be a non-empty string`);
  }
  return value;
}

function requireMs(value, field) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new SeqraLabelBuilderError(`${field} is not a parseable timestamp: ${JSON.stringify(value)}`);
  return ms;
}

function addDays(isoDate, days) {
  const ms = requireMs(isoDate, "isoDate") + days * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// Stable keys for this card's own derived products. None of these are
// commissioned core-ontology entities (see seqra_ontology_spec.mjs's fifteen
// fixed types), so -- following seqra_spatial_stable_keys.mjs's precedent --
// they live here rather than growing the frozen ontology.
// ---------------------------------------------------------------------------

/** `project_family:{sha256-prefix-of-sorted-member-project-keys}` */
export function buildProjectFamilyKey(memberProjectKeys) {
  if (!Array.isArray(memberProjectKeys) || memberProjectKeys.length === 0) {
    throw new SeqraLabelBuilderError("buildProjectFamilyKey requires a non-empty array of project keys");
  }
  const sorted = [...memberProjectKeys].sort();
  return `project_family:${sha256Hex(sorted.join("|")).slice(0, 16)}`;
}

/** `label_row:{target_name}:{review_key}:{horizon_or_none}` */
export function buildLabelRowKey({ targetName, reviewKey, horizon = null } = {}) {
  requireNonEmptyString(targetName, "targetName");
  requireNonEmptyString(reviewKey, "reviewKey");
  return `label_row:${targetName}:${reviewKey}:${horizon ?? "none"}`;
}

// ---------------------------------------------------------------------------
// A3: project-family grouping. Two projects are the same family when they
// share at least one BBL -- a resubmission, phasing, or amendment of the
// same site is the near-duplicate this exists to catch. Deterministic
// union-find: root selection is by string comparison, never insertion
// order, so member ordering never changes the resulting family_id.
// ---------------------------------------------------------------------------
export function buildProjectFamilies(projects) {
  const parent = new Map();
  function find(key) {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(key) !== root) {
      const next = parent.get(key);
      parent.set(key, root);
      key = next;
    }
    return root;
  }
  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  }

  for (const project of projects) {
    requireNonEmptyString(project.projectKey, "project.projectKey");
    parent.set(project.projectKey, project.projectKey);
  }
  const projectsByBbl = new Map();
  for (const project of projects) {
    for (const bbl of project.bbls ?? []) {
      if (!projectsByBbl.has(bbl)) projectsByBbl.set(bbl, []);
      projectsByBbl.get(bbl).push(project.projectKey);
    }
  }
  for (const members of projectsByBbl.values()) {
    for (let i = 1; i < members.length; i++) union(members[0], members[i]);
  }

  const membersByRoot = new Map();
  for (const project of projects) {
    const root = find(project.projectKey);
    if (!membersByRoot.has(root)) membersByRoot.set(root, []);
    membersByRoot.get(root).push(project.projectKey);
  }

  const families = [];
  const projectToFamily = new Map();
  for (const members of membersByRoot.values()) {
    const sortedMembers = [...members].sort();
    const familyId = buildProjectFamilyKey(sortedMembers);
    families.push({ family_id: familyId, member_project_keys: sortedMembers });
    for (const member of sortedMembers) projectToFamily.set(member, familyId);
  }
  families.sort((a, b) => (a.family_id < b.family_id ? -1 : a.family_id > b.family_id ? 1 : 0));
  return { schema: "cityscroll.seqra_project_families.v1", families, projectToFamily };
}

// ---------------------------------------------------------------------------
// G1 / A1: as-of feature snapshot, and an independent leakage audit that
// re-checks every record actually included rather than trusting the
// upstream builders' own cutoff discipline blindly.
// ---------------------------------------------------------------------------

/**
 * Independently re-verify that nothing included in a snapshot became public
 * after `cutoff`. This is deliberately redundant with `projectReviewStateAsOf`
 * (which filters by `available_to_public_at` before this ever runs) and
 * `joinProjectLayersAtCutoff` (which is cutoff-safe by construction): a
 * receipt that only asserts "the builder we trust says so" is not a receipt.
 */
export function auditFeatureLeakage({ cutoff, includedEvents = [], includedPositions = [], includedSpatialFeatures = [] } = {}) {
  const cutoffMs = requireMs(cutoff, "cutoff");
  const violations = [];
  let checkedCount = 0;

  for (const event of includedEvents) {
    checkedCount += 1;
    const ms = Date.parse(event.available_to_public_at);
    if (!Number.isFinite(ms) || ms > cutoffMs) {
      violations.push({ kind: "review_event", key: event.event_key, available_to_public_at: event.available_to_public_at });
    }
  }
  for (const position of includedPositions) {
    checkedCount += 1;
    const ms = Date.parse(position.available_to_public_at);
    if (!Number.isFinite(ms) || ms > cutoffMs) {
      violations.push({ kind: "public_position", key: position.position_key, available_to_public_at: position.available_to_public_at });
    }
  }
  for (const feature of includedSpatialFeatures) {
    checkedCount += 1;
    const ms = Date.parse(feature.layer_vintage_effective_start);
    if (Number.isFinite(ms) && ms > cutoffMs) {
      violations.push({ kind: "spatial_feature", key: feature.feature_key, available_to_public_at: feature.layer_vintage_effective_start });
    }
  }

  return {
    schema: "cityscroll.seqra_label_feature_leakage_audit.v1",
    cutoff,
    checked_count: checkedCount,
    violation_count: violations.length,
    violations,
  };
}

/**
 * Build the as-of feature snapshot for one review at one cutoff. Returns
 * `{ ok: false, reason, contradictions }` when the review's own event log
 * is contradictory as of the cutoff (never a guessed state), matching
 * `projectReviewStateAsOf`'s own contract.
 */
export function buildAsOfFeatureSnapshot({
  reviewKey,
  cutoff,
  events = [],
  publicPositions = [],
  bblHistory = null,
  spatialLayerRegistry = null,
  spatialLayerTypes = undefined,
} = {}) {
  requireNonEmptyString(reviewKey, "reviewKey");
  requireNonEmptyString(cutoff, "cutoff");
  const cutoffMs = requireMs(cutoff, "cutoff");

  const log = buildAppendOnlyLog(events);
  const reviewState = projectReviewStateAsOf(log.events, { reviewKey, cutoff });
  if (!reviewState.ok) {
    return { ok: false, reason: EXCLUSION_REASONS.CONTRADICTION_AT_CUTOFF, contradictions: reviewState.contradictions };
  }

  const includedEvents = log.events.filter(
    (event) => event.review_key === reviewKey && Date.parse(event.available_to_public_at) <= cutoffMs,
  );
  const includedPositions = publicPositions.filter(
    (position) => position.review_key === reviewKey && Date.parse(position.available_to_public_at) <= cutoffMs,
  );

  let spatial = null;
  if (bblHistory && spatialLayerRegistry) {
    // joinProjectLayersAtCutoff (SEQRA-06) takes a date-only cutoff; this
    // module's own cutoff is a full ISO instant, matching review events'
    // available_to_public_at precision, so it is truncated only for this call.
    spatial = joinProjectLayersAtCutoff({
      history: bblHistory,
      cutoff: cutoff.slice(0, 10),
      layerRegistry: spatialLayerRegistry,
      ...(spatialLayerTypes ? { layerTypes: spatialLayerTypes } : {}),
    });
  }

  const leakageAudit = auditFeatureLeakage({
    cutoff,
    includedEvents,
    includedPositions,
    includedSpatialFeatures: spatial?.features ?? [],
  });

  return {
    ok: true,
    schema: SEQRA_LABEL_BUILDER_SCHEMA,
    review_key: reviewKey,
    cutoff,
    review_state: reviewState,
    positions: includedPositions,
    spatial,
    leakage_audit: leakageAudit,
  };
}

// ---------------------------------------------------------------------------
// Target A: review path (a categorical label, not a survival target --
// "unknown_or_incomplete" is spec.md's own fifth category for a review that
// has not yet reached a classifying milestone, so it needs no separate
// censoring flag the way target E does).
// ---------------------------------------------------------------------------

/** Pure function of an already-computed `projectReviewStateAsOf` result. */
export function classifyReviewPathLabel(reviewState) {
  if (!reviewState || reviewState.ok !== true) {
    throw new SeqraLabelBuilderError("classifyReviewPathLabel requires an ok:true projectReviewStateAsOf result");
  }
  const classifying = reviewState.milestones.filter((milestone) => milestone.event_type in REVIEW_PATH_EVENT_TYPES);
  if (classifying.length === 0) return "unknown_or_incomplete";
  // Milestones are already chronologically sorted (projectReviewStateAsOf
  // derives them from sortReviewEvents); the latest classifying event wins,
  // so a later escalation (e.g. a conditioned negative declaration revisited
  // into a positive declaration) is never masked by an earlier one.
  return REVIEW_PATH_EVENT_TYPES[classifying[classifying.length - 1].event_type];
}

// ---------------------------------------------------------------------------
// Target E: supplemental review, right-censored (G2, A2, negative rule).
// This reads the FULL event log (not cutoff-filtered) because the label is
// the ground-truth outcome, not a feature -- what may never happen is a
// post-cutoff event entering the feature snapshot, not the label.
// ---------------------------------------------------------------------------

function supplementalReviewOccurredInWindow(fullEvents, reviewKey, windowStartMsExclusive, windowEndMsInclusive) {
  return fullEvents.some((event) => {
    if (event.review_key !== reviewKey) return false;
    if (!SUPPLEMENTAL_REVIEW_EVENT_TYPES.includes(event.event_type)) return false;
    const ms = Date.parse(event.effective_at);
    return Number.isFinite(ms) && ms > windowStartMsExclusive && ms <= windowEndMsInclusive;
  });
}

/**
 * `horizon` selects the window end:
 *   within_90_days / within_180_days     -- cutoff + N days
 *   before_final_determination           -- `determinationDate` (null if not yet issued)
 *   before_implementation_completion     -- `implementationCompletionDate` (null if not yet reached)
 *
 * When the window's end is not yet knowable as of `observationHorizon` (the
 * corpus's own data-completeness horizon, i.e. "now" for backtest purposes),
 * this returns `{ label: null, censored: true, reason }` rather than
 * defaulting to a negative -- the open-review-as-non-event bug this card
 * exists to close (G2, A2, negative rule).
 */
export function classifySupplementalReviewLabel({
  reviewKey,
  cutoff,
  horizon,
  fullEvents = [],
  determinationDate = null,
  implementationCompletionDate = null,
  observationHorizon,
} = {}) {
  requireNonEmptyString(reviewKey, "reviewKey");
  requireNonEmptyString(cutoff, "cutoff");
  requireNonEmptyString(observationHorizon, "observationHorizon");
  if (!SUPPLEMENTAL_REVIEW_HORIZONS.includes(horizon)) {
    throw new SeqraLabelBuilderError(`horizon must be one of ${SUPPLEMENTAL_REVIEW_HORIZONS.join(", ")}, got ${JSON.stringify(horizon)}`);
  }
  const cutoffMs = requireMs(cutoff, "cutoff");
  const observationHorizonMs = requireMs(observationHorizon, "observationHorizon");

  let windowEnd = null;
  let censorReason = null;
  if (horizon === "within_90_days") windowEnd = addDays(cutoff, 90);
  else if (horizon === "within_180_days") windowEnd = addDays(cutoff, 180);
  else if (horizon === "before_final_determination") {
    windowEnd = determinationDate;
    censorReason = CENSOR_REASONS.DETERMINATION_NOT_YET_REACHED;
  } else if (horizon === "before_implementation_completion") {
    windowEnd = implementationCompletionDate;
    censorReason = CENSOR_REASONS.IMPLEMENTATION_COMPLETION_NOT_YET_REACHED;
  }

  if (windowEnd == null) {
    return { label: null, censored: true, reason: censorReason, window_end: null };
  }
  const windowEndMs = requireMs(windowEnd, "windowEnd");
  if (windowEndMs > observationHorizonMs) {
    return { label: null, censored: true, reason: CENSOR_REASONS.WINDOW_NOT_YET_OBSERVED, window_end: windowEnd };
  }

  const occurred = supplementalReviewOccurredInWindow(fullEvents, reviewKey, cutoffMs, windowEndMs);
  return { label: occurred ? 1 : 0, censored: false, reason: null, window_end: windowEnd };
}

// ---------------------------------------------------------------------------
// G3 / A3: rolling-origin folds, grouped by project family. A family that
// would appear on both sides of one fold's train/test boundary is excluded
// from that fold entirely (both sides), with an audited reason -- never
// resolved by silently keeping one side and dropping the other, which would
// hide which rows moved.
// ---------------------------------------------------------------------------

/**
 * `rows`: `{ reviewKey, familyId, cutoff }[]`.
 * `folds`: `{ foldId, trainEnd, testStart, testEnd }[]` (ISO dates;
 * `trainEnd` inclusive, test window is `(testStart, testEnd]`).
 *
 * Returns one assignment per (fold, row) pair the row's cutoff falls into,
 * sorted deterministically by (fold_id, review_key) -- never by input
 * array order, satisfying G5/A5's reproducibility requirement together
 * with `folds` and `rows` both being explicit, recorded inputs.
 */
export function buildRollingOriginFolds({ rows, folds } = {}) {
  if (!Array.isArray(rows)) throw new SeqraLabelBuilderError("buildRollingOriginFolds requires rows: []");
  if (!Array.isArray(folds) || folds.length === 0) throw new SeqraLabelBuilderError("buildRollingOriginFolds requires a non-empty folds: []");

  const assignments = [];
  for (const fold of folds) {
    requireNonEmptyString(fold.foldId, "fold.foldId");
    const trainEndMs = requireMs(fold.trainEnd, "fold.trainEnd");
    const testStartMs = requireMs(fold.testStart, "fold.testStart");
    const testEndMs = requireMs(fold.testEnd, "fold.testEnd");

    const trainRows = rows.filter((row) => Date.parse(row.cutoff) <= trainEndMs);
    const testRows = rows.filter((row) => {
      const ms = Date.parse(row.cutoff);
      return ms > testStartMs && ms <= testEndMs;
    });

    const trainFamilies = new Set(trainRows.map((row) => row.familyId));
    const testFamilies = new Set(testRows.map((row) => row.familyId));
    const conflictFamilies = new Set([...testFamilies].filter((familyId) => trainFamilies.has(familyId)));

    for (const row of trainRows) {
      const excluded = conflictFamilies.has(row.familyId);
      assignments.push({
        fold_id: fold.foldId,
        review_key: row.reviewKey,
        family_id: row.familyId,
        cutoff: row.cutoff,
        split: excluded ? "excluded" : "train",
        excluded_reason: excluded ? EXCLUSION_REASONS.FAMILY_TRAIN_TEST_CONFLICT : null,
      });
    }
    for (const row of testRows) {
      const excluded = conflictFamilies.has(row.familyId);
      assignments.push({
        fold_id: fold.foldId,
        review_key: row.reviewKey,
        family_id: row.familyId,
        cutoff: row.cutoff,
        split: excluded ? "excluded" : "test",
        excluded_reason: excluded ? EXCLUSION_REASONS.FAMILY_TRAIN_TEST_CONFLICT : null,
      });
    }
  }

  assignments.sort((a, b) => {
    if (a.fold_id !== b.fold_id) return a.fold_id < b.fold_id ? -1 : 1;
    if (a.review_key !== b.review_key) return a.review_key < b.review_key ? -1 : 1;
    return 0;
  });
  return assignments;
}

/** Assert no family appears on both sides of the same fold (A3, as a callable invariant rather than only an inline exclusion). */
export function assertFoldFamilyDisjointness(assignments) {
  const byFold = new Map();
  for (const assignment of assignments) {
    if (!byFold.has(assignment.fold_id)) byFold.set(assignment.fold_id, { train: new Set(), test: new Set() });
    const bucket = byFold.get(assignment.fold_id);
    if (assignment.split === "train") bucket.train.add(assignment.family_id);
    if (assignment.split === "test") bucket.test.add(assignment.family_id);
  }
  const violations = [];
  for (const [foldId, bucket] of byFold) {
    for (const familyId of bucket.test) {
      if (bucket.train.has(familyId)) violations.push({ fold_id: foldId, family_id: familyId });
    }
  }
  return { ok: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// G4 / A4: population, prevalence and exclusion-reason receipts.
// ---------------------------------------------------------------------------

/**
 * `labelRows`: `{ reviewKey, label, censored, excludedReason }[]` -- every
 * row a fold assignment named for this (target, fold, split), including
 * excluded ones, so `population` is always the honest denominator before
 * any exclusion is applied.
 */
export function summarizeTargetFoldPopulation({ targetName, foldId, split, labelRows = [] } = {}) {
  requireNonEmptyString(targetName, "targetName");
  requireNonEmptyString(foldId, "foldId");
  requireNonEmptyString(split, "split");

  const excludedByReason = {};
  const eligible = [];
  for (const row of labelRows) {
    if (row.excludedReason) {
      excludedByReason[row.excludedReason] = (excludedByReason[row.excludedReason] ?? 0) + 1;
    } else {
      eligible.push(row);
    }
  }
  const censored = eligible.filter((row) => row.censored);
  const labeled = eligible.filter((row) => !row.censored);

  const labelCounts = {};
  for (const row of labeled) {
    const key = String(row.label);
    labelCounts[key] = (labelCounts[key] ?? 0) + 1;
  }
  const prevalence = {};
  for (const [key, count] of Object.entries(labelCounts)) {
    prevalence[key] = labeled.length > 0 ? count / labeled.length : null;
  }

  return {
    schema: "cityscroll.seqra_label_fold_population.v1",
    target_name: targetName,
    fold_id: foldId,
    split,
    population: labelRows.length,
    excluded_by_reason: excludedByReason,
    eligible_population: eligible.length,
    censored_count: censored.length,
    labeled_population: labeled.length,
    label_counts: labelCounts,
    prevalence,
  };
}

export function stringifyLabelBuilderValue(value) {
  return `${JSON.stringify(stable(value), null, 2)}\n`;
}

export { stable as stableForTest };
