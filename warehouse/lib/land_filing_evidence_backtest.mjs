/**
 * LDP-28: a cutoff-safe, project-family-grouped historical evaluation of
 * whether the filing-evidence facts LDP-23/24/25/26 already register add
 * stable out-of-sample value, before any of them may be proposed as a
 * prediction feature.
 *
 * Statutory applicability is a selection mechanism, not a treatment: this
 * module never tests whether a filing *causes* an outcome, only whether a
 * feature built from facts that were public at a cutoff separates outcomes
 * observed strictly after that cutoff better than a baseline that has no
 * such fact. A feature that fails that test is reported as a stop, not
 * discarded silently and not forced to a GO -- this module has no code path
 * that can report a verdict other than what the measured out-of-time
 * performance says.
 *
 * Inputs are never live. This module runs entirely over a committed,
 * synthetic evaluation corpus (see warehouse/fixtures/land-filing-evidence
 * -backtest/) built with the real LDP-23/26 contracts and builders
 * (ontology/land_use_filing.mjs, warehouse/lib/land_filing_sequence.mjs), so
 * the harness -- cutoff safety, family grouping, per-family ablation,
 * calibration, subgroup drift, and the GO/stop gate -- is exercised and
 * tested the same way SEQRA-09 and LUP2-C7 exercise theirs, without a
 * network call or a resident-facing claim about a real project.
 *
 * Three feature families, always ablated separately (never combined into one
 * score): report filing facts, package churn, and environmental state. Four
 * outcomes, always scored separately: days to certification, days from
 * noticing to certification, certification within a horizon, and
 * post-certification disposition. This card ships no product score: every
 * report below is per (family, outcome), and `assertNoCombinedScore` refuses
 * any artifact that tries to fold them into one number.
 */
import {
  materializeLandFilingSequence,
  summarizeFilingSequenceObservations,
  isParseableTimestamp,
} from "./land_filing_sequence.mjs";
import { projectLandUseFilingAsOf } from "../../ontology/land_use_filing.mjs";

export const LAND_FILING_EVIDENCE_BACKTEST_SCHEMA = "cityscroll.land_filing_evidence_backtest.v1";
export const LAND_FILING_EVIDENCE_BACKTEST_VERSION = "1.0.0";
export const GATE_VERSION = "ldp28_filing_evidence_backtest_gate.v1";

export class LandFilingEvidenceBacktestError extends Error {
  constructor(message) {
    super(message);
    this.name = "LandFilingEvidenceBacktestError";
  }
}

/** G5/A5: package churn, environmental state and report facts, ablated separately -- never combined. */
export const FEATURE_FAMILIES = Object.freeze([
  "report_filing_facts",
  "package_churn",
  "environmental_state",
]);

/**
 * The card's own outcome vocabulary: kept separate, never collapsed into one
 * target. Withdrawal/inactivity is its own target rather than a third class
 * folded into `post_certification_disposition` -- a withdrawn or inactive
 * project by definition never reaches certification, so "post-certification
 * approval or modification" and "withdrawal or inactivity" describe two
 * different populations (certified rows; every row), not two outcomes of one
 * population, and scoring them as one target would silently conflate them.
 */
export const OUTCOME_TARGETS = Object.freeze([
  "days_to_certification",
  "days_from_noticing_to_certification",
  "certified_within_horizon",
  "post_certification_disposition",
  "withdrawal_or_inactivity",
]);

/** post_certification_disposition's classes, scored only over rows where certification was observed. */
export const POST_CERTIFICATION_DISPOSITION_CLASSES = Object.freeze([
  "approved",
  "modified",
]);

/** Every numeric/boolean feature carries one of these states alongside its value; only these two ever carry a real 0. */
export const OBSERVED_FEATURE_STATES = Object.freeze(["observed_present", "observed_absent"]);
export const MISSING_FEATURE_STATES = Object.freeze(["not_checked", "source_unavailable", "unknown"]);
export const FEATURE_STATES = Object.freeze([...OBSERVED_FEATURE_STATES, ...MISSING_FEATURE_STATES]);

const DAY_MS = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* Negative-rule guards, made callable rather than left as comments    */
/* ------------------------------------------------------------------ */

/**
 * Whole-token scan, not a substring match: a substring rule would flag
 * "discussed" for containing "sue" while missing a camelCase
 * "causesDelay". Mirrors the pattern this repo already uses for SEQRA-09's
 * forbidden-estimate scan (warehouse/lib/seqra_baselines.mjs), applied to
 * this card's own negative rule instead.
 */
export const FORBIDDEN_CAUSAL_TERMS = Object.freeze([
  "causes",
  "caused",
  "causing",
  "cause",
  "leads_to",
  "results_in",
  "due_to",
  "product_score",
  "certification_probability",
  "approval_probability",
  "risk_score",
  "equity_score",
  "displacement_score",
  "harm_score",
  "harm_ranking",
]);

function normalizeForForbiddenScan(text) {
  const collapsed = String(text)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `_${collapsed}_`;
}

export function findForbiddenCausalTerms(text) {
  const normalized = normalizeForForbiddenScan(text);
  return FORBIDDEN_CAUSAL_TERMS.filter((pattern) => normalized.includes(`_${pattern}_`));
}

/**
 * Refuse causal or product-score language anywhere a report names something.
 * This card reports whether a fact separates an outcome measured strictly
 * after its own cutoff; it never claims the fact caused that outcome, and it
 * never ships a single score a caller could read as a product decision.
 */
export function assertNoForbiddenCausalLanguage(names, context = "artifact") {
  const offenders = [];
  for (const name of names) {
    for (const pattern of findForbiddenCausalTerms(name)) offenders.push({ name, pattern });
  }
  if (offenders.length > 0) {
    throw new LandFilingEvidenceBacktestError(`${context}: forbidden causal/product-score term(s) ${JSON.stringify(offenders)}`);
  }
  return { ok: true, checked_count: names.length, patterns: FORBIDDEN_CAUSAL_TERMS };
}

/** A6: the displacement index never enters a feature family this card reports on. */
export function assertNoDisplacementIndexFeature(featureNames) {
  const offenders = featureNames.filter((name) => {
    const normalized = normalizeForForbiddenScan(name);
    return normalized.includes("displacement") || normalized.includes("_dri_");
  });
  if (offenders.length > 0) {
    throw new LandFilingEvidenceBacktestError(`displacement/DRI feature(s) are excluded from every feature family by default: ${JSON.stringify(offenders)}`);
  }
  return { ok: true, offenders: [] };
}

/** This card ships no product score: refuse any report shape that folds families/outcomes into one number. */
export function assertNoCombinedScore(report) {
  const serialized = JSON.stringify(report);
  if (/"(?:combined|overall|composite|unified)_(?:score|risk|probability)"/i.test(serialized)) {
    throw new LandFilingEvidenceBacktestError("report must not carry a combined/overall score field across families or outcomes");
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Project families (G2): union-find over shared BBLs                  */
/* ------------------------------------------------------------------ */

export function buildFilingProjectFamilies(projects) {
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
    if (!project.projectKey) throw new LandFilingEvidenceBacktestError("project.projectKey is required");
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
    const familyId = `land_filing_evidence_backtest_family:${sortedMembers.join("+")}`;
    families.push({ family_id: familyId, member_project_keys: sortedMembers });
    for (const member of sortedMembers) projectToFamily.set(member, familyId);
  }
  families.sort((a, b) => (a.family_id < b.family_id ? -1 : a.family_id > b.family_id ? 1 : 0));
  return { schema: "cityscroll.land_filing_evidence_backtest_project_families.v1", families, projectToFamily };
}

/* ------------------------------------------------------------------ */
/* Rolling-origin folds (G1/G2): a row never trains on its own future,  */
/* and a family never appears on both sides of the same fold.          */
/* ------------------------------------------------------------------ */

export function buildRollingOriginFilingFolds({ rows, folds } = {}) {
  if (!Array.isArray(rows)) throw new LandFilingEvidenceBacktestError("buildRollingOriginFilingFolds requires rows: []");
  if (!Array.isArray(folds) || folds.length === 0) throw new LandFilingEvidenceBacktestError("buildRollingOriginFilingFolds requires a non-empty folds: []");

  const assignments = [];
  for (const fold of folds) {
    if (!fold.foldId) throw new LandFilingEvidenceBacktestError("fold.foldId is required");
    const trainEndMs = Date.parse(fold.trainEnd);
    const testStartMs = Date.parse(fold.testStart);
    const testEndMs = Date.parse(fold.testEnd);
    if (![trainEndMs, testStartMs, testEndMs].every(Number.isFinite)) {
      throw new LandFilingEvidenceBacktestError(`${fold.foldId}: trainEnd/testStart/testEnd must be parseable timestamps`);
    }

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
        row_key: row.rowKey,
        family_id: row.familyId,
        cutoff: row.cutoff,
        split: excluded ? "excluded" : "train",
        excluded_reason: excluded ? "family_train_test_conflict" : null,
      });
    }
    for (const row of testRows) {
      const excluded = conflictFamilies.has(row.familyId);
      assignments.push({
        fold_id: fold.foldId,
        row_key: row.rowKey,
        family_id: row.familyId,
        cutoff: row.cutoff,
        split: excluded ? "excluded" : "test",
        excluded_reason: excluded ? "family_train_test_conflict" : null,
      });
    }
  }
  return assignments;
}

export function assertFilingFoldFamilyDisjointness(assignments) {
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

export function splitFilingRowsByFold(rows, assignments, foldId) {
  const byKey = new Map(rows.map((row) => [row.rowKey, row]));
  const train = [];
  const test = [];
  const excluded = [];
  for (const assignment of assignments) {
    if (assignment.fold_id !== foldId) continue;
    const row = byKey.get(assignment.row_key);
    if (!row) continue;
    if (assignment.split === "train") train.push(row);
    else if (assignment.split === "test") test.push(row);
    else excluded.push({ ...row, excluded_reason: assignment.excluded_reason });
  }
  const cmp = (a, b) => (a.rowKey < b.rowKey ? -1 : a.rowKey > b.rowKey ? 1 : 0);
  return { train: train.sort(cmp), test: test.sort(cmp), excluded: excluded.sort(cmp) };
}

/* ------------------------------------------------------------------ */
/* A3/A4: a typed feature value -- absence is never a numeric zero     */
/* ------------------------------------------------------------------ */

export function feature({ family, name, value, state }) {
  if (!FEATURE_FAMILIES.includes(family)) throw new LandFilingEvidenceBacktestError(`unknown feature family ${JSON.stringify(family)}`);
  if (!FEATURE_STATES.includes(state)) throw new LandFilingEvidenceBacktestError(`unknown feature state ${JSON.stringify(state)}`);
  if (MISSING_FEATURE_STATES.includes(state) && value !== null) {
    throw new LandFilingEvidenceBacktestError(`feature ${family}/${name}: state ${state} requires value: null, not a numeric zero`);
  }
  if (OBSERVED_FEATURE_STATES.includes(state) && (value === null || typeof value !== "number" || !Number.isFinite(value))) {
    throw new LandFilingEvidenceBacktestError(`feature ${family}/${name}: state ${state} requires a finite numeric value`);
  }
  return Object.freeze({ family, name, value, state });
}

/**
 * G5/A5: report filing facts -- applicability, document observation, and the
 * not-timely-filed notice, each its own fact. Read directly off the as-of
 * obligation's own typed state (LDP-23's five-state contracts), not
 * re-derived from the materialized sequence's event list, since an absent
 * event there cannot by itself distinguish "checked, nothing found" from
 * "never checked" -- exactly the distinction A3/A4 require this module to
 * preserve.
 */
export function reportFilingFactsFeatures({ obligation = null } = {}) {
  if (!obligation) {
    return [
      feature({ family: "report_filing_facts", name: "applicability_publicly_asserted", value: null, state: "source_unavailable" }),
      feature({ family: "report_filing_facts", name: "report_document_observed", value: null, state: "source_unavailable" }),
      feature({ family: "report_filing_facts", name: "report_not_timely_filed_notice_observed", value: null, state: "source_unavailable" }),
    ];
  }

  const applicabilityState = obligation.applicability?.state ?? "unknown";
  const applicabilityKnown = applicabilityState === "required" || applicabilityState === "not_required";

  const fulfillmentState = obligation.fulfillment?.state ?? "not_checked";
  let reportObservedFeature;
  if (fulfillmentState === "document_observed") {
    reportObservedFeature = feature({ family: "report_filing_facts", name: "report_document_observed", value: 1, state: "observed_present" });
  } else if (fulfillmentState === "not_observed" || fulfillmentState === "publisher_identifies_not_timely_filed") {
    reportObservedFeature = feature({ family: "report_filing_facts", name: "report_document_observed", value: 0, state: "observed_absent" });
  } else {
    reportObservedFeature = feature({ family: "report_filing_facts", name: "report_document_observed", value: null, state: fulfillmentState === "source_unavailable" ? "source_unavailable" : "not_checked" });
  }

  let notTimelyFeature;
  if (fulfillmentState === "publisher_identifies_not_timely_filed") {
    notTimelyFeature = feature({ family: "report_filing_facts", name: "report_not_timely_filed_notice_observed", value: 1, state: "observed_present" });
  } else if (fulfillmentState === "document_observed" || fulfillmentState === "not_observed") {
    notTimelyFeature = feature({ family: "report_filing_facts", name: "report_not_timely_filed_notice_observed", value: 0, state: "observed_absent" });
  } else {
    notTimelyFeature = feature({ family: "report_filing_facts", name: "report_not_timely_filed_notice_observed", value: null, state: fulfillmentState === "source_unavailable" ? "source_unavailable" : "not_checked" });
  }

  return [
    feature({
      family: "report_filing_facts",
      name: "applicability_publicly_asserted",
      value: applicabilityKnown ? 1 : 0,
      state: "observed_present",
    }),
    reportObservedFeature,
    notTimelyFeature,
  ];
}

/** G5/A5: package churn -- observed version count and revision interval, each an observation over the visible manifest, never an inference. */
export function packageChurnFeatures({ sequence, documentsChecked = true } = {}) {
  if (!documentsChecked) {
    return [
      feature({ family: "package_churn", name: "observed_package_version_count", value: null, state: "source_unavailable" }),
      feature({ family: "package_churn", name: "observed_revision_interval_days", value: null, state: "source_unavailable" }),
      feature({ family: "package_churn", name: "package_version_conflict_observed", value: null, state: "source_unavailable" }),
    ];
  }
  const summary = summarizeFilingSequenceObservations(sequence);
  const versionCountFeature = feature({
    family: "package_churn",
    name: "observed_package_version_count",
    value: summary.observed_package_version_count,
    state: "observed_present",
  });
  const hasInterval = summary.observed_revision_interval_days != null;
  const intervalFeature = feature({
    family: "package_churn",
    name: "observed_revision_interval_days",
    value: hasInterval ? summary.observed_revision_interval_days : 0,
    state: hasInterval ? "observed_present" : "observed_absent",
  });
  const conflictFeature = feature({
    family: "package_churn",
    name: "package_version_conflict_observed",
    value: summary.source_conflict_event_ids.length > 0 ? 1 : 0,
    state: "observed_present",
  });
  return [versionCountFeature, intervalFeature, conflictFeature];
}

/** G5/A5: environmental state -- CEQR identity and milestone presence, consumed from the sequence's own environmental events, never re-derived. */
export function environmentalStateFeatures({ sequence, zapRowChecked = true, ceqrJoinChecked = true } = {}) {
  const events = sequence?.events ?? [];
  const identityEvent = events.find((e) => e.event_kind === "environmental_identity_observed") ?? null;
  const milestoneEvents = events.filter((e) => e.event_kind === "environmental_milestone_observed");

  const identityFeature = !zapRowChecked
    ? feature({ family: "environmental_state", name: "environmental_identity_observed", value: null, state: "source_unavailable" })
    : feature({ family: "environmental_state", name: "environmental_identity_observed", value: identityEvent ? 1 : 0, state: identityEvent ? "observed_present" : "observed_absent" });

  const milestoneFeature = !ceqrJoinChecked
    ? feature({ family: "environmental_state", name: "environmental_milestone_count", value: null, state: "source_unavailable" })
    : feature({ family: "environmental_state", name: "environmental_milestone_count", value: milestoneEvents.length, state: "observed_present" });

  const conflictFeature = !zapRowChecked
    ? feature({ family: "environmental_state", name: "environmental_identity_conflict_observed", value: null, state: "not_checked" })
    : feature({
      family: "environmental_state",
      name: "environmental_identity_conflict_observed",
      value: identityEvent?.conflict_state && identityEvent.conflict_state !== "none" ? 1 : 0,
      state: "observed_present",
    });

  return [identityFeature, milestoneFeature, conflictFeature];
}

export function featuresForFamily(familyName, args) {
  if (familyName === "report_filing_facts") return reportFilingFactsFeatures(args);
  if (familyName === "package_churn") return packageChurnFeatures(args);
  if (familyName === "environmental_state") return environmentalStateFeatures(args);
  throw new LandFilingEvidenceBacktestError(`unknown feature family ${JSON.stringify(familyName)}`);
}

/* ------------------------------------------------------------------ */
/* Cutoff-safe row assembly (G1): every included fact is independently */
/* re-checked against the row's own cutoff, never trusted from the    */
/* caller's say-so.                                                   */
/* ------------------------------------------------------------------ */

/**
 * @param {object} opts
 * @param {string} opts.projectKey
 * @param {string[]} [opts.bbls]
 * @param {string} opts.cutoff
 * @param {object|null} [opts.zapRow] a fixture ZAP row; every date field on it must already be <= cutoff (asserted below)
 * @param {string|null} [opts.zapSourceVintage]
 * @param {object[]} [opts.obligations] LDP-23 land_use_filing_obligation.v1 records
 * @param {object[]} [opts.documents] LDP-24 land_use_filing_document.v1 manifest entries
 * @param {object|null} [opts.ceqrJoin]
 * @param {string} opts.materializedAt
 * @param {object} opts.groundTruth strictly-after-cutoff outcome facts: never read by a feature builder
 */
export function buildAsOfFilingBacktestRow({
  projectKey,
  bbls = [],
  cutoff,
  zapRow = null,
  zapSourceVintage = null,
  obligations = [],
  documents = [],
  documentsSourceChecked = true,
  ceqrJoin = null,
  materializedAt,
  groundTruth = {},
} = {}) {
  if (!projectKey) throw new LandFilingEvidenceBacktestError("projectKey is required");
  if (!isParseableTimestamp(cutoff)) throw new LandFilingEvidenceBacktestError("cutoff must be an ISO timestamp");
  const cutoffMs = Date.parse(cutoff);

  // G1: an independent leakage self-check over the ZAP row's own calendar
  // fields -- a fixture whose "current" snapshot leaks a future date is
  // refused here rather than silently scored.
  for (const field of ["app_filed_date", "noticed_date", "certified_referred"]) {
    const value = zapRow?.[field];
    if (value != null && isParseableTimestamp(value) && Date.parse(value) > cutoffMs) {
      throw new LandFilingEvidenceBacktestError(`row ${projectKey}: zapRow.${field} (${value}) is after cutoff (${cutoff}) -- would leak a future fact into the as-of snapshot`);
    }
  }

  const asOf = projectLandUseFilingAsOf({ obligations, documents, cutoff });
  const obligation = asOf.obligations[0] ?? null;
  const documentsChecked = documentsSourceChecked;

  const sequence = materializeLandFilingSequence({
    projectId: projectKey,
    zapRow,
    zapSourceVintage,
    obligations: asOf.obligations,
    documents: asOf.documents,
    ceqrJoin,
    materializedAt,
  });

  // G1 (independent re-check): every materialized event must itself be
  // visible at or before this row's own cutoff.
  for (const event of sequence.events) {
    if (event.available_to_public_at != null && Date.parse(event.available_to_public_at) > cutoffMs) {
      throw new LandFilingEvidenceBacktestError(`row ${projectKey}: event ${event.event_id} became public after cutoff -- temporal leakage`);
    }
  }

  const features = [
    ...reportFilingFactsFeatures({ obligation }),
    ...packageChurnFeatures({ sequence, documentsChecked }),
    ...environmentalStateFeatures({ sequence, zapRowChecked: zapRow != null, ceqrJoinChecked: ceqrJoin != null }),
  ];

  return Object.freeze({
    rowKey: `land_filing_evidence_backtest_row:${projectKey}:${cutoff}`,
    projectKey,
    bbls: Object.freeze([...bbls]),
    cutoff,
    features: Object.freeze(features),
    groundTruth: Object.freeze({ ...groundTruth }),
    subgroup: Object.freeze({
      year: cutoff.slice(0, 4),
      action_type: groundTruth.actionType ?? "unknown",
      borough: bbls[0] ? bbls[0].charAt(0) : "unknown",
      procedure: groundTruth.procedure ?? "unknown",
    }),
  });
}

export function featureValue(row, family, name) {
  const found = row.features.find((f) => f.family === family && f.name === name);
  return found ?? null;
}

/** Coverage: the fraction of rows where every feature in a family carries a real observation, not a missing state. */
export function familyCoverage(rows, familyName) {
  const familyFeatureNames = new Set(rows.flatMap((row) => row.features.filter((f) => f.family === familyName).map((f) => f.name)));
  const perFeature = {};
  for (const name of familyFeatureNames) {
    const present = rows.filter((row) => {
      const f = featureValue(row, familyName, name);
      return f && OBSERVED_FEATURE_STATES.includes(f.state);
    }).length;
    perFeature[name] = { present, total: rows.length, coverage: rows.length > 0 ? present / rows.length : null };
  }
  const rowsFullyObserved = rows.filter((row) => [...familyFeatureNames].every((name) => {
    const f = featureValue(row, familyName, name);
    return f && OBSERVED_FEATURE_STATES.includes(f.state);
  })).length;
  return {
    family: familyName,
    total_rows: rows.length,
    rows_fully_observed: rowsFullyObserved,
    row_coverage: rows.length > 0 ? rowsFullyObserved / rows.length : null,
    per_feature: perFeature,
  };
}

/* ------------------------------------------------------------------ */
/* Design matrices: a family's own features, standardized on train,    */
/* with a "baseline" tier that carries no filing-evidence feature at   */
/* all -- only whether the row has ANY visible obligation, so the      */
/* ablation compares "the family's facts" against "nothing but knowing */
/* the row exists", never against a stronger, unstated comparator.     */
/* ------------------------------------------------------------------ */

export const BASELINE_TIER = "baseline_no_filing_evidence";
export const FULL_TIER = "all_families";

/**
 * A tier's feature set as `{family, name}` specs, never bare names: the
 * FULL_TIER spans every family, so a spec must carry its own family or a
 * lookup would silently collide with another family's feature of the same
 * name.
 */
function tierFeatureSpecs(tier, allFamilyFeatureNames) {
  if (tier === BASELINE_TIER) return [];
  if (tier === FULL_TIER) {
    return FEATURE_FAMILIES.flatMap((family) => (allFamilyFeatureNames[family] ?? []).map((name) => ({ family, name })));
  }
  return (allFamilyFeatureNames[tier] ?? []).map((name) => ({ family: tier, name }));
}

/** Rows usable for a design matrix over a set of feature specs: every named feature must be a real observation. */
function usableRowsForFeatures(rows, specs) {
  if (specs.length === 0) return rows;
  return rows.filter((row) => specs.every((spec) => {
    const f = featureValue(row, spec.family, spec.name);
    return f && OBSERVED_FEATURE_STATES.includes(f.state);
  }));
}

function designRow(row, specs) {
  return specs.map((spec) => featureValue(row, spec.family, spec.name).value);
}

function fitStandardizer(matrix) {
  const columns = matrix[0]?.length ?? 0;
  const means = new Array(columns).fill(0);
  const deviations = new Array(columns).fill(1);
  if (matrix.length === 0) return { means, deviations };
  for (let c = 0; c < columns; c++) {
    let total = 0;
    for (const row of matrix) total += row[c];
    means[c] = total / matrix.length;
    let sumSquares = 0;
    for (const row of matrix) {
      const delta = row[c] - means[c];
      sumSquares += delta * delta;
    }
    const deviation = Math.sqrt(sumSquares / matrix.length);
    deviations[c] = deviation > 1e-9 ? deviation : 1;
  }
  return { means, deviations };
}

function applyStandardizer(matrix, standardizer) {
  return matrix.map((row) => row.map((value, c) => (value - standardizer.means[c]) / standardizer.deviations[c]));
}

/* ------------------------------------------------------------------ */
/* A minimal, deterministic logistic regression: fixed iterations,     */
/* fixed learning rate, full-batch gradient descent from an all-zero   */
/* start. No validation-split early stopping and no randomness.        */
/* ------------------------------------------------------------------ */

export const DEFAULT_LOGISTIC_OPTIONS = Object.freeze({ iterations: 300, learningRate: 0.4, l2Penalty: 1.0 });

export function sigmoid(z) {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

export function fitLogisticRegression({ matrix, labels, options = DEFAULT_LOGISTIC_OPTIONS } = {}) {
  const featureCount = matrix[0]?.length ?? 0;
  const n = matrix.length;
  const weights = new Array(featureCount).fill(0);
  let intercept = 0;
  if (n === 0) return { weights, intercept, feature_count: featureCount, fitted_rows: 0 };
  for (let iteration = 0; iteration < options.iterations; iteration++) {
    let interceptGradient = 0;
    const weightGradients = new Array(featureCount).fill(0);
    for (let i = 0; i < n; i++) {
      const row = matrix[i];
      let score = intercept;
      for (let f = 0; f < featureCount; f++) score += weights[f] * row[f];
      const residual = sigmoid(score) - labels[i];
      interceptGradient += residual;
      for (let f = 0; f < featureCount; f++) weightGradients[f] += residual * row[f];
    }
    intercept -= (options.learningRate * interceptGradient) / n;
    for (let f = 0; f < featureCount; f++) {
      const gradient = weightGradients[f] / n + (options.l2Penalty * weights[f]) / n;
      weights[f] -= options.learningRate * gradient;
    }
  }
  return { weights, intercept, feature_count: featureCount, fitted_rows: n };
}

export function predictLogistic(model, row) {
  let score = model.intercept;
  for (let f = 0; f < model.feature_count; f++) score += model.weights[f] * row[f];
  return sigmoid(score);
}

/* ------------------------------------------------------------------ */
/* A minimal, deterministic ridge linear regression for duration       */
/* targets: closed-form normal equations, small feature counts only.   */
/* ------------------------------------------------------------------ */

function solveSymmetricPositiveDefinite(matrix, vector) {
  const size = vector.length;
  const lower = Array.from({ length: size }, () => new Array(size).fill(0));
  for (let i = 0; i < size; i++) {
    for (let j = 0; j <= i; j++) {
      let total = matrix[i][j];
      for (let k = 0; k < j; k++) total -= lower[i][k] * lower[j][k];
      if (i === j) {
        if (!(total > 0)) throw new LandFilingEvidenceBacktestError("normal-equation matrix is not positive definite; increase l2Penalty");
        lower[i][i] = Math.sqrt(total);
      } else {
        lower[i][j] = total / lower[j][j];
      }
    }
  }
  const forward = new Array(size).fill(0);
  for (let i = 0; i < size; i++) {
    let total = vector[i];
    for (let k = 0; k < i; k++) total -= lower[i][k] * forward[k];
    forward[i] = total / lower[i][i];
  }
  const solution = new Array(size).fill(0);
  for (let i = size - 1; i >= 0; i--) {
    let total = forward[i];
    for (let k = i + 1; k < size; k++) total -= lower[k][i] * solution[k];
    solution[i] = total / lower[i][i];
  }
  return solution;
}

export const DEFAULT_RIDGE_L2 = 1.0;

export function fitRidgeLinearRegression({ matrix, targets, l2Penalty = DEFAULT_RIDGE_L2 } = {}) {
  const featureCount = matrix[0]?.length ?? 0;
  const n = matrix.length;
  if (n === 0) return { weights: new Array(featureCount).fill(0), intercept: 0, feature_count: featureCount, fitted_rows: 0 };
  const size = featureCount + 1;
  const design = matrix.map((row) => [1, ...row]);
  const normal = Array.from({ length: size }, () => new Array(size).fill(0));
  const rhs = new Array(size).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < size; a++) {
      rhs[a] += design[i][a] * targets[i];
      for (let b = 0; b < size; b++) normal[a][b] += design[i][a] * design[i][b];
    }
  }
  for (let a = 1; a < size; a++) normal[a][a] += l2Penalty;
  normal[0][0] += 1e-8;
  const coefficients = solveSymmetricPositiveDefinite(normal, rhs);
  return { weights: coefficients.slice(1), intercept: coefficients[0], feature_count: featureCount, fitted_rows: n };
}

export function predictLinear(model, row) {
  let score = model.intercept;
  for (let f = 0; f < model.feature_count; f++) score += model.weights[f] * row[f];
  return score;
}

/* ------------------------------------------------------------------ */
/* Calibration, discrimination, and duration scoring                   */
/* ------------------------------------------------------------------ */

export const RELIABILITY_BIN_COUNT = 5;
const PROBABILITY_FLOOR = 1e-9;
function clampProbability(p) {
  if (p < PROBABILITY_FLOOR) return PROBABILITY_FLOOR;
  if (p > 1 - PROBABILITY_FLOOR) return 1 - PROBABILITY_FLOOR;
  return p;
}

export function reliabilityBins(pairs, binCount = RELIABILITY_BIN_COUNT) {
  const bins = Array.from({ length: binCount }, (_, index) => ({
    bin_lower: index / binCount,
    bin_upper: (index + 1) / binCount,
    count: 0,
    mean_predicted: null,
    observed_rate: null,
    predicted_total: 0,
    outcome_total: 0,
  }));
  for (const { probability, outcome } of pairs) {
    let index = Math.floor(probability * binCount);
    if (index >= binCount) index = binCount - 1;
    if (index < 0) index = 0;
    bins[index].count += 1;
    bins[index].predicted_total += probability;
    bins[index].outcome_total += outcome;
  }
  for (const bin of bins) {
    if (bin.count > 0) {
      bin.mean_predicted = bin.predicted_total / bin.count;
      bin.observed_rate = bin.outcome_total / bin.count;
    }
    delete bin.predicted_total;
    delete bin.outcome_total;
  }
  return bins;
}

export function expectedCalibrationError(bins, total) {
  if (total === 0) return null;
  let error = 0;
  for (const bin of bins) {
    if (bin.count === 0) continue;
    error += (bin.count / total) * Math.abs(bin.observed_rate - bin.mean_predicted);
  }
  return error;
}

export function logLoss(predictions, outcomes) {
  if (predictions.length === 0) return null;
  let total = 0;
  for (let i = 0; i < predictions.length; i++) total += -Math.log(clampProbability(outcomes[i] === 1 ? predictions[i] : 1 - predictions[i]));
  return total / predictions.length;
}

export function brierScore(predictions, outcomes) {
  if (predictions.length === 0) return null;
  let total = 0;
  for (let i = 0; i < predictions.length; i++) {
    const delta = predictions[i] - outcomes[i];
    total += delta * delta;
  }
  return total / predictions.length;
}

/** Mann-Whitney-form rank AUC: the probability a random positive outranks a random negative, ties split. */
export function rankAUC(predictions, outcomes) {
  const positives = [];
  const negatives = [];
  for (let i = 0; i < predictions.length; i++) (outcomes[i] === 1 ? positives : negatives).push(predictions[i]);
  if (positives.length === 0 || negatives.length === 0) return null;
  let wins = 0;
  for (const p of positives) {
    for (const n of negatives) {
      if (p > n) wins += 1;
      else if (p === n) wins += 0.5;
    }
  }
  return wins / (positives.length * negatives.length);
}

export function scoreBinary({ predictions, outcomes }) {
  const n = predictions.length;
  if (n === 0) {
    return { scored_rows: 0, log_loss: null, brier_score: null, auc: null, expected_calibration_error: null, reliability_bins: reliabilityBins([]) };
  }
  const pairs = predictions.map((probability, i) => ({ probability, outcome: outcomes[i] }));
  const bins = reliabilityBins(pairs);
  return {
    scored_rows: n,
    log_loss: logLoss(predictions, outcomes),
    brier_score: brierScore(predictions, outcomes),
    auc: rankAUC(predictions, outcomes),
    expected_calibration_error: expectedCalibrationError(bins, n),
    reliability_bins: bins,
  };
}

export function concordanceIndex(predictedDays, durations, events) {
  let concordant = 0;
  let comparable = 0;
  let tied = 0;
  for (let i = 0; i < durations.length; i++) {
    if (events[i] !== 1) continue;
    for (let j = 0; j < durations.length; j++) {
      if (i === j || durations[j] <= durations[i]) continue;
      comparable += 1;
      if (predictedDays[i] < predictedDays[j]) concordant += 1;
      else if (predictedDays[i] === predictedDays[j]) tied += 1;
    }
  }
  if (comparable === 0) return { concordance: null, comparable_pairs: 0 };
  return { concordance: (concordant + 0.5 * tied) / comparable, comparable_pairs: comparable };
}

/** Kaplan-Meier median: the documented naive comparator for a duration target, honest about censoring unlike a plain mean. */
export function kaplanMeierMedian(durations, events) {
  const rows = durations.map((duration, index) => ({ duration, event: events[index] })).sort((a, b) => (a.duration - b.duration) || (b.event - a.event));
  let atRisk = rows.length;
  let survival = 1;
  for (let i = 0; i < rows.length; i++) {
    const time = rows[i].duration;
    let deaths = 0;
    let leaving = 0;
    let j = i;
    while (j < rows.length && rows[j].duration === time) {
      if (rows[j].event === 1) deaths += 1;
      leaving += 1;
      j += 1;
    }
    if (deaths > 0 && atRisk > 0) survival *= 1 - deaths / atRisk;
    if (survival <= 0.5) return time;
    atRisk -= leaving;
    i = j - 1;
  }
  return null;
}

export function scoreDuration({ predictedDays, durations, events }) {
  const n = durations.length;
  const uncensoredIndexes = [];
  for (let i = 0; i < n; i++) if (events[i] === 1) uncensoredIndexes.push(i);
  const concordance = concordanceIndex(predictedDays, durations, events);
  if (uncensoredIndexes.length === 0) {
    return { scored_rows: n, uncensored_rows: 0, mean_absolute_error_days: null, ...concordance };
  }
  let totalAbsoluteError = 0;
  for (const i of uncensoredIndexes) totalAbsoluteError += Math.abs(durations[i] - predictedDays[i]);
  return {
    scored_rows: n,
    uncensored_rows: uncensoredIndexes.length,
    mean_absolute_error_days: totalAbsoluteError / uncensoredIndexes.length,
    ...concordance,
  };
}

/* ------------------------------------------------------------------ */
/* Outcome extraction: strictly post-cutoff facts, read only here --   */
/* never inside a feature builder.                                    */
/* ------------------------------------------------------------------ */

export function outcomeLabelOf(target, row, { horizonDays } = {}) {
  const gt = row.groundTruth;
  const filedAtMs = isParseableTimestamp(gt.filedAt) ? Date.parse(gt.filedAt) : null;
  const noticedAtMs = isParseableTimestamp(gt.noticedAt) ? Date.parse(gt.noticedAt) : null;
  const certifiedAtMs = isParseableTimestamp(gt.certifiedAt) ? Date.parse(gt.certifiedAt) : null;
  const observationHorizonMs = isParseableTimestamp(gt.observationHorizon) ? Date.parse(gt.observationHorizon) : null;

  if (target === "days_to_certification") {
    if (filedAtMs == null) return { included: false, reason: "no_filed_date" };
    if (certifiedAtMs != null) return { included: true, duration_days: Math.max(1, Math.round((certifiedAtMs - filedAtMs) / DAY_MS)), event: 1 };
    if (observationHorizonMs == null) return { included: false, reason: "no_observation_horizon" };
    return { included: true, duration_days: Math.max(1, Math.round((observationHorizonMs - filedAtMs) / DAY_MS)), event: 0 };
  }

  if (target === "days_from_noticing_to_certification") {
    if (noticedAtMs == null) return { included: false, reason: "not_yet_noticed_at_cutoff" };
    if (certifiedAtMs != null) return { included: true, duration_days: Math.max(1, Math.round((certifiedAtMs - noticedAtMs) / DAY_MS)), event: 1 };
    if (observationHorizonMs == null) return { included: false, reason: "no_observation_horizon" };
    return { included: true, duration_days: Math.max(1, Math.round((observationHorizonMs - noticedAtMs) / DAY_MS)), event: 0 };
  }

  if (target === "certified_within_horizon") {
    if (filedAtMs == null || !Number.isFinite(horizonDays)) return { included: false, reason: "no_filed_date_or_horizon" };
    const horizonMs = filedAtMs + horizonDays * DAY_MS;
    if (certifiedAtMs != null) return { included: true, label: certifiedAtMs <= horizonMs ? 1 : 0 };
    if (observationHorizonMs != null && observationHorizonMs >= horizonMs) return { included: true, label: 0 };
    return { included: false, reason: "window_not_yet_observed" };
  }

  if (target === "post_certification_disposition") {
    // Population: rows where certification was observed only -- "approval"
    // and "modification" are properties of what happened after
    // certification, and have no meaning for a row that never certified.
    if (certifiedAtMs == null) return { included: false, reason: "not_yet_certified" };
    if (!gt.postCertificationDisposition) return { included: false, reason: "no_disposition_source" };
    if (!POST_CERTIFICATION_DISPOSITION_CLASSES.includes(gt.postCertificationDisposition)) {
      return { included: false, reason: "disposition_outside_scored_classes" };
    }
    return { included: true, label: gt.postCertificationDisposition };
  }

  if (target === "withdrawal_or_inactivity") {
    // Population: every row with a determinate answer -- certified rows are
    // definitionally not withdrawn/inactive, and a pending row counts only
    // once its own ground truth records an explicit determination; a merely
    // stale pending row with no such determination is censored, never
    // assumed withdrawn.
    if (gt.withdrawnOrInactive === true) return { included: true, label: 1 };
    if (gt.withdrawnOrInactive === false) return { included: true, label: 0 };
    return { included: false, reason: "not_yet_determinable" };
  }

  throw new LandFilingEvidenceBacktestError(`unknown outcome target ${JSON.stringify(target)}`);
}

/* ------------------------------------------------------------------ */
/* Per-tier fit+score for one (family, outcome) over one fold           */
/* ------------------------------------------------------------------ */

function fitAndScoreBinaryTier({ tier, specs, trainRows, testRows, target, horizonDays }) {
  const usableTrain = usableRowsForFeatures(trainRows, specs);
  const labelledTrain = usableTrain.map((row) => ({ row, label: outcomeLabelOf(target, row, { horizonDays }) })).filter((e) => e.label.included);
  const usableTest = usableRowsForFeatures(testRows, specs);
  const labelledTest = usableTest.map((row) => ({ row, label: outcomeLabelOf(target, row, { horizonDays }) })).filter((e) => e.label.included);

  const trainMatrixRaw = labelledTrain.map((e) => designRow(e.row, specs));
  const standardizer = fitStandardizer(trainMatrixRaw);
  const trainMatrix = applyStandardizer(trainMatrixRaw, standardizer);
  const trainLabels = labelledTrain.map((e) => e.label.label);
  const prevalence = trainLabels.length > 0 ? trainLabels.reduce((a, b) => a + b, 0) / trainLabels.length : 0.5;

  const model = trainMatrix.length > 0 ? fitLogisticRegression({ matrix: trainMatrix, labels: trainLabels }) : null;
  const testMatrix = applyStandardizer(labelledTest.map((e) => designRow(e.row, specs)), standardizer);
  const testLabels = labelledTest.map((e) => e.label.label);
  const predictions = model ? testMatrix.map((row) => predictLogistic(model, row)) : testMatrix.map(() => prevalence);
  const comparatorPredictions = testMatrix.map(() => prevalence);

  return {
    tier,
    feature_names: specs.map((spec) => `${spec.family}.${spec.name}`),
    train_rows: labelledTrain.length,
    test_rows: labelledTest.length,
    baseline: scoreBinary({ predictions, outcomes: testLabels }),
    comparator: scoreBinary({ predictions: comparatorPredictions, outcomes: testLabels }),
    pooling: { predictions, comparator_predictions: comparatorPredictions, outcomes: testLabels },
  };
}

function fitAndScoreDurationTier({ tier, specs, trainRows, testRows, target, horizonDays }) {
  const usableTrain = usableRowsForFeatures(trainRows, specs);
  const labelledTrain = usableTrain.map((row) => ({ row, label: outcomeLabelOf(target, row, { horizonDays }) })).filter((e) => e.label.included);
  const usableTest = usableRowsForFeatures(testRows, specs);
  const labelledTest = usableTest.map((row) => ({ row, label: outcomeLabelOf(target, row, { horizonDays }) })).filter((e) => e.label.included);

  const trainMatrixRaw = labelledTrain.map((e) => designRow(e.row, specs));
  const standardizer = fitStandardizer(trainMatrixRaw);
  const trainMatrix = applyStandardizer(trainMatrixRaw, standardizer);
  const trainDurations = labelledTrain.map((e) => e.label.duration_days);
  const trainEvents = labelledTrain.map((e) => e.label.event);
  const comparatorMedian = kaplanMeierMedian(trainDurations, trainEvents) ?? (trainDurations.length ? trainDurations.reduce((a, b) => a + b, 0) / trainDurations.length : 0);

  const model = trainMatrix.length > 0 ? fitRidgeLinearRegression({ matrix: trainMatrix, targets: trainDurations }) : null;
  const testMatrix = applyStandardizer(labelledTest.map((e) => designRow(e.row, specs)), standardizer);
  const testDurations = labelledTest.map((e) => e.label.duration_days);
  const testEvents = labelledTest.map((e) => e.label.event);
  const predictedDays = model ? testMatrix.map((row) => Math.max(1, predictLinear(model, row))) : testMatrix.map(() => comparatorMedian);
  const comparatorDays = testMatrix.map(() => comparatorMedian);

  return {
    tier,
    feature_names: specs.map((spec) => `${spec.family}.${spec.name}`),
    train_rows: labelledTrain.length,
    test_rows: labelledTest.length,
    baseline: scoreDuration({ predictedDays, durations: testDurations, events: testEvents }),
    comparator: scoreDuration({ predictedDays: comparatorDays, durations: testDurations, events: testEvents }),
    pooling: { predictedDays, comparatorDays, durations: testDurations, events: testEvents },
  };
}

function fitAndScoreCategoricalTier({ tier, specs, trainRows, testRows, target, horizonDays }) {
  // One-vs-rest per class, each its own binary logistic fit -- never
  // collapsed into a single multi-class score, matching the card's own
  // negative rule against a single combined product score.
  const perClass = {};
  for (const className of POST_CERTIFICATION_DISPOSITION_CLASSES) {
    const usableTrain = usableRowsForFeatures(trainRows, specs);
    const labelledTrain = usableTrain.map((row) => ({ row, label: outcomeLabelOf(target, row, { horizonDays }) })).filter((e) => e.label.included);
    const usableTest = usableRowsForFeatures(testRows, specs);
    const labelledTest = usableTest.map((row) => ({ row, label: outcomeLabelOf(target, row, { horizonDays }) })).filter((e) => e.label.included);

    const trainMatrixRaw = labelledTrain.map((e) => designRow(e.row, specs));
    const standardizer = fitStandardizer(trainMatrixRaw);
    const trainMatrix = applyStandardizer(trainMatrixRaw, standardizer);
    const trainLabels = labelledTrain.map((e) => (e.label.label === className ? 1 : 0));
    const prevalence = trainLabels.length > 0 ? trainLabels.reduce((a, b) => a + b, 0) / trainLabels.length : 0.5;

    const model = trainMatrix.length > 0 ? fitLogisticRegression({ matrix: trainMatrix, labels: trainLabels }) : null;
    const testMatrix = applyStandardizer(labelledTest.map((e) => designRow(e.row, specs)), standardizer);
    const testLabels = labelledTest.map((e) => (e.label.label === className ? 1 : 0));
    const predictions = model ? testMatrix.map((row) => predictLogistic(model, row)) : testMatrix.map(() => prevalence);
    const comparatorPredictions = testMatrix.map(() => prevalence);

    perClass[className] = {
      train_rows: labelledTrain.length,
      test_rows: labelledTest.length,
      baseline: scoreBinary({ predictions, outcomes: testLabels }),
      comparator: scoreBinary({ predictions: comparatorPredictions, outcomes: testLabels }),
      pooling: { predictions, comparator_predictions: comparatorPredictions, outcomes: testLabels },
    };
  }
  return { tier, feature_names: specs.map((spec) => `${spec.family}.${spec.name}`), per_class: perClass };
}

const TARGET_KIND = Object.freeze({
  days_to_certification: "duration",
  days_from_noticing_to_certification: "duration",
  certified_within_horizon: "binary",
  post_certification_disposition: "categorical",
  withdrawal_or_inactivity: "binary",
});

function fitAndScoreTier(args) {
  const kind = TARGET_KIND[args.target];
  if (kind === "binary") return fitAndScoreBinaryTier(args);
  if (kind === "duration") return fitAndScoreDurationTier(args);
  if (kind === "categorical") return fitAndScoreCategoricalTier(args);
  throw new LandFilingEvidenceBacktestError(`unknown outcome target ${JSON.stringify(args.target)}`);
}

/* ------------------------------------------------------------------ */
/* A9/A8: promotion-gate thresholds and the signed GO/stop verdict      */
/* ------------------------------------------------------------------ */

export const PROMOTION_GATE_THRESHOLDS = Object.freeze({
  min_folds: 2,
  min_row_coverage: 0.5,
  min_test_rows_per_fold: 3,
  min_incremental_lift: 0.01,
  max_expected_calibration_error: 0.25,
  max_subgroup_metric_spread: 0.4,
});

function primaryMetricOf(kind, report) {
  if (kind === "binary") return { name: "log_loss", lowerIsBetter: true, value: report?.log_loss ?? null };
  if (kind === "duration") return { name: "concordance", lowerIsBetter: false, value: report?.concordance ?? null };
  return null;
}

/**
 * A signed GO/stop verdict: an explicit attestation object, never a bare
 * boolean. Every promotion-gate condition is checked independently and every
 * reason a stop fired is recorded -- there is no path that reports GO
 * without every condition having actually held, and reporting stop is always
 * a valid, accepted outcome.
 */
export function evaluatePromotionGate({ familyName, target, coverage, foldCount, minTestRowsAcrossFolds, incrementalLift, calibrationError, calibrationApplicable = true, subgroupSpread, thresholds = PROMOTION_GATE_THRESHOLDS }) {
  const reasons = [];
  if (foldCount < thresholds.min_folds) reasons.push(`fewer than ${thresholds.min_folds} out-of-time folds were evaluated (${foldCount})`);
  if (minTestRowsAcrossFolds < thresholds.min_test_rows_per_fold) reasons.push(`at least one fold's test split has fewer than ${thresholds.min_test_rows_per_fold} scored rows (${minTestRowsAcrossFolds})`);
  if (coverage == null || coverage < thresholds.min_row_coverage) reasons.push(`row coverage ${coverage == null ? "unmeasured" : coverage.toFixed(3)} is below ${thresholds.min_row_coverage}`);
  if (incrementalLift == null) reasons.push("incremental lift over the baseline tier is unmeasured");
  else if (incrementalLift < thresholds.min_incremental_lift) reasons.push(`incremental lift over the baseline tier ${incrementalLift.toFixed(4)} is below ${thresholds.min_incremental_lift}`);
  // A duration target has no probability to calibrate in this module's
  // minimal scoring stack (no survival-quantile calibration is fitted), so
  // the calibration threshold is not applied to it -- an inapplicable check
  // must never silently become an unsatisfiable one.
  if (calibrationApplicable) {
    if (calibrationError == null) reasons.push("expected calibration error is unmeasured");
    else if (calibrationError > thresholds.max_expected_calibration_error) reasons.push(`expected calibration error ${calibrationError.toFixed(4)} exceeds ${thresholds.max_expected_calibration_error}`);
  }
  if (subgroupSpread != null && subgroupSpread > thresholds.max_subgroup_metric_spread) reasons.push(`subgroup metric spread ${subgroupSpread.toFixed(4)} exceeds ${thresholds.max_subgroup_metric_spread}`);

  return Object.freeze({
    schema: "cityscroll.land_filing_evidence_backtest_promotion_verdict.v1",
    family: familyName,
    target,
    decision: reasons.length === 0 ? "go" : "stop",
    reasons: Object.freeze(reasons),
    thresholds,
    gate_version: GATE_VERSION,
    signed_by: "ldp28-filing-evidence-backtest-gate",
  });
}

/* ------------------------------------------------------------------ */
/* Subgroup / drift breakdown                                          */
/* ------------------------------------------------------------------ */

export function subgroupBreakdown({ rows, target, specs, model, standardizer, horizonDays, groupKey }) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.subgroup[groupKey] ?? "unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const kind = TARGET_KIND[target];
  const out = [];
  for (const [key, groupRows] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const usable = usableRowsForFeatures(groupRows, specs);
    const labelled = usable.map((row) => ({ row, label: outcomeLabelOf(target, row, { horizonDays }) })).filter((e) => e.label.included);
    if (labelled.length === 0) {
      out.push({ group: key, rows: groupRows.length, scored_rows: 0, metric: null });
      continue;
    }
    const matrix = applyStandardizer(labelled.map((e) => designRow(e.row, specs)), standardizer);
    if (kind === "binary") {
      const predictions = model ? matrix.map((row) => predictLogistic(model, row)) : matrix.map(() => 0.5);
      const outcomes = labelled.map((e) => e.label.label);
      const score = scoreBinary({ predictions, outcomes });
      out.push({ group: key, rows: groupRows.length, scored_rows: labelled.length, metric: score.log_loss, auc: score.auc });
    } else if (kind === "duration") {
      const predictedDays = model ? matrix.map((row) => Math.max(1, predictLinear(model, row))) : matrix.map(() => 0);
      const durations = labelled.map((e) => e.label.duration_days);
      const events = labelled.map((e) => e.label.event);
      const score = scoreDuration({ predictedDays, durations, events });
      out.push({ group: key, rows: groupRows.length, scored_rows: labelled.length, metric: score.concordance });
    } else {
      out.push({ group: key, rows: groupRows.length, scored_rows: labelled.length, metric: null });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Top-level: evaluate one (family, outcome) across every fold          */
/* ------------------------------------------------------------------ */

export function evaluateFeatureFamilyForOutcome({
  familyName,
  target,
  rows,
  assignments,
  folds,
  horizonDays = 365,
  subgroupKeys = ["year", "action_type", "borough", "procedure"],
} = {}) {
  if (!FEATURE_FAMILIES.includes(familyName)) throw new LandFilingEvidenceBacktestError(`unknown feature family ${JSON.stringify(familyName)}`);
  if (!OUTCOME_TARGETS.includes(target)) throw new LandFilingEvidenceBacktestError(`unknown outcome target ${JSON.stringify(target)}`);

  const allFamilyFeatureNames = {};
  for (const family of FEATURE_FAMILIES) {
    allFamilyFeatureNames[family] = [...new Set(rows.flatMap((row) => row.features.filter((f) => f.family === family).map((f) => f.name)))].sort();
  }
  const tiers = [BASELINE_TIER, familyName, FULL_TIER];

  const coverage = familyCoverage(rows, familyName);

  const perFoldByTier = {};
  for (const tier of tiers) perFoldByTier[tier] = [];

  for (const fold of folds) {
    const { train, test } = splitFilingRowsByFold(rows, assignments, fold.foldId);
    for (const tier of tiers) {
      const specs = tierFeatureSpecs(tier, allFamilyFeatureNames);
      const evaluation = fitAndScoreTier({ tier, specs, trainRows: train, testRows: test, target, horizonDays });
      perFoldByTier[tier].push({ fold_id: fold.foldId, ...evaluation });
    }
  }

  const kind = TARGET_KIND[target];
  const pooledByTier = {};
  for (const tier of tiers) {
    if (kind === "categorical") {
      const perClassPooled = {};
      for (const className of POST_CERTIFICATION_DISPOSITION_CLASSES) {
        const predictions = [];
        const comparatorPredictions = [];
        const outcomes = [];
        for (const fold of perFoldByTier[tier]) {
          predictions.push(...fold.per_class[className].pooling.predictions);
          comparatorPredictions.push(...fold.per_class[className].pooling.comparator_predictions);
          outcomes.push(...fold.per_class[className].pooling.outcomes);
        }
        perClassPooled[className] = {
          baseline: scoreBinary({ predictions, outcomes }),
          comparator: scoreBinary({ predictions: comparatorPredictions, outcomes }),
        };
      }
      pooledByTier[tier] = { per_class: perClassPooled };
      continue;
    }
    if (kind === "duration") {
      const predictedDays = [];
      const comparatorDays = [];
      const durations = [];
      const events = [];
      for (const fold of perFoldByTier[tier]) {
        predictedDays.push(...fold.pooling.predictedDays);
        comparatorDays.push(...fold.pooling.comparatorDays);
        durations.push(...fold.pooling.durations);
        events.push(...fold.pooling.events);
      }
      pooledByTier[tier] = {
        baseline: scoreDuration({ predictedDays, durations, events }),
        comparator: scoreDuration({ predictedDays: comparatorDays, durations, events }),
      };
      continue;
    }
    const predictions = [];
    const comparatorPredictions = [];
    const outcomes = [];
    for (const fold of perFoldByTier[tier]) {
      predictions.push(...fold.pooling.predictions);
      comparatorPredictions.push(...fold.pooling.comparator_predictions);
      outcomes.push(...fold.pooling.outcomes);
    }
    pooledByTier[tier] = {
      baseline: scoreBinary({ predictions, outcomes }),
      comparator: scoreBinary({ predictions: comparatorPredictions, outcomes }),
    };
  }

  /** One-vs-rest per class is never combined into a single label prediction, but "did this family help at all" still needs one comparable number: the mean of each class's own log loss, lower is better, same as the binary primary metric. */
  function categoricalPrimaryMetric(pooledTierEntry) {
    const perClassLogLoss = POST_CERTIFICATION_DISPOSITION_CLASSES
      .map((className) => pooledTierEntry?.per_class?.[className]?.baseline?.log_loss)
      .filter((value) => value != null);
    if (perClassLogLoss.length === 0) return { name: "mean_per_class_log_loss", lowerIsBetter: true, value: null };
    return { name: "mean_per_class_log_loss", lowerIsBetter: true, value: perClassLogLoss.reduce((a, b) => a + b, 0) / perClassLogLoss.length };
  }

  const primary = kind === "categorical"
    ? categoricalPrimaryMetric(pooledByTier[familyName])
    : primaryMetricOf(kind, pooledByTier[familyName]?.baseline);
  const baselineMetric = kind === "categorical"
    ? categoricalPrimaryMetric(pooledByTier[BASELINE_TIER])?.value ?? null
    : primaryMetricOf(kind, pooledByTier[BASELINE_TIER]?.baseline)?.value ?? null;
  const familyMetric = primary?.value ?? null;
  let incrementalLift = null;
  if (baselineMetric != null && familyMetric != null && primary) {
    incrementalLift = primary.lowerIsBetter ? baselineMetric - familyMetric : familyMetric - baselineMetric;
  }

  // A duration target has no fitted probability in this module's minimal
  // scoring stack, so calibration is not applicable to it at all -- the
  // promotion gate is told so explicitly rather than reading a permanent
  // null as "unmeasured" and stopping every duration target by construction.
  const calibrationApplicable = kind !== "duration";
  let calibrationError = null;
  if (kind === "binary") {
    calibrationError = pooledByTier[familyName]?.baseline?.expected_calibration_error ?? null;
  } else if (kind === "categorical") {
    const perClassErrors = POST_CERTIFICATION_DISPOSITION_CLASSES
      .map((className) => pooledByTier[familyName]?.per_class?.[className]?.baseline?.expected_calibration_error)
      .filter((value) => value != null);
    calibrationError = perClassErrors.length > 0 ? perClassErrors.reduce((a, b) => a + b, 0) / perClassErrors.length : null;
  }

  // Subgroup drift, fit fresh on the full corpus's own rolling-origin folds'
  // final fold train split, at this family's own tier -- the report a
  // reader would act on if this family were ever proposed.
  const lastFold = folds[folds.length - 1];
  const { train: lastTrain } = splitFilingRowsByFold(rows, assignments, lastFold.foldId);
  const specsForFamily = tierFeatureSpecs(familyName, allFamilyFeatureNames);
  const usableLastTrain = usableRowsForFeatures(lastTrain, specsForFamily);
  let subgroupModel = null;
  let subgroupStandardizer = { means: [], deviations: [] };
  const subgroupReports = {};
  if (kind !== "categorical" && usableLastTrain.length > 0) {
    const labelledLastTrain = usableLastTrain.map((row) => ({ row, label: outcomeLabelOf(target, row, { horizonDays }) })).filter((e) => e.label.included);
    const matrixRaw = labelledLastTrain.map((e) => designRow(e.row, specsForFamily));
    subgroupStandardizer = fitStandardizer(matrixRaw);
    const matrix = applyStandardizer(matrixRaw, subgroupStandardizer);
    if (kind === "binary") {
      subgroupModel = matrix.length > 0 ? fitLogisticRegression({ matrix, labels: labelledLastTrain.map((e) => e.label.label) }) : null;
    } else if (kind === "duration") {
      subgroupModel = matrix.length > 0 ? fitRidgeLinearRegression({ matrix, targets: labelledLastTrain.map((e) => e.label.duration_days) }) : null;
    }
    const { test: lastTest } = splitFilingRowsByFold(rows, assignments, lastFold.foldId);
    for (const groupKey of subgroupKeys) {
      subgroupReports[groupKey] = subgroupBreakdown({ rows: lastTest, target, specs: specsForFamily, model: subgroupModel, standardizer: subgroupStandardizer, horizonDays, groupKey });
    }
  }
  let subgroupSpread = null;
  if (kind !== "categorical") {
    const allMetricValues = Object.values(subgroupReports).flat().map((g) => g.metric).filter((v) => v != null);
    if (allMetricValues.length > 1) subgroupSpread = Math.max(...allMetricValues) - Math.min(...allMetricValues);
  }

  const foldTestCounts = perFoldByTier[familyName].map((fold) => (kind === "categorical" ? Math.min(...Object.values(fold.per_class).map((c) => c.test_rows)) : fold.test_rows));
  const minTestRowsAcrossFolds = foldTestCounts.length > 0 ? Math.min(...foldTestCounts) : 0;

  const promotionVerdict = evaluatePromotionGate({
    familyName,
    target,
    coverage: coverage.row_coverage,
    foldCount: folds.length,
    minTestRowsAcrossFolds,
    incrementalLift,
    calibrationError,
    calibrationApplicable,
    subgroupSpread,
  });

  return Object.freeze({
    schema: LAND_FILING_EVIDENCE_BACKTEST_SCHEMA,
    family: familyName,
    target,
    kind,
    unit_description: kind === "duration" ? "days, right-censored at the fixture's own observation horizon" : "one row per as-of project snapshot",
    coverage,
    per_fold: perFoldByTier,
    pooled: pooledByTier,
    primary_metric: primary?.name ?? null,
    ablation: {
      baseline_tier: BASELINE_TIER,
      family_tier: familyName,
      full_tier: FULL_TIER,
      baseline_metric: baselineMetric,
      family_metric: familyMetric,
      incremental_lift_over_baseline: incrementalLift,
    },
    calibration_error: calibrationError,
    calibration_applicable: calibrationApplicable,
    subgroup: subgroupReports,
    subgroup_metric_spread: subgroupSpread,
    promotion_verdict: promotionVerdict,
  });
}
