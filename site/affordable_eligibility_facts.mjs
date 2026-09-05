/**
 * Source-backed affordable-housing eligibility facts (LDP-19).
 *
 * LDP-18 (`land_review_regimes.mjs`) resolves regime eligibility from a
 * caller-supplied `facts` object; it deliberately does not materialize those
 * facts itself. This module is the layer that does: it turns explicit,
 * source-classified evidence into the named per-criterion facts that regime
 * resolution consumes, one statutory criterion at a time.
 *
 * The governing discipline is unknown-by-default: a criterion becomes
 * `known_true` or `known_false` only when an evidence source of an
 * authoritative kind for that specific criterion is supplied. A project
 * title, applicant name, zoning/inclusionary-housing map token, unit count,
 * or reconstructed ranking is never an authoritative source for any
 * criterion here — supplying one leaves the criterion `unknown` rather than
 * silently `false`, and it never silently becomes `true`.
 */

import {
  landReviewRegimeById,
  resolveAppealsRegimeSuccessor,
  resolveLandReviewRegimeEligibility,
} from "./land_review_regimes.mjs";

export const AFFORDABLE_ELIGIBILITY_FACTS_SCHEMA = "cityscroll.affordable_eligibility_facts.v1";

export const AFFORDABLE_ELIGIBILITY_FACT_KEYS = Object.freeze([
  "affordable_housing.section_197f.commission_cycle_listed",
  "affordable_housing.section_197f.qualifying_action_code",
  "affordable_housing.section_666a.hpd_sponsorship_certified",
  "affordable_housing.section_666a.affordability_covenant_recorded",
  "affordable_housing.section_197g.eligible_application_class",
]);

export const AFFORDABLE_ELIGIBILITY_FACT_STATES = Object.freeze([
  "known_true",
  "known_false",
  "unknown",
  "not_yet_effective",
]);

/**
 * The only evidence-source kinds that may resolve each criterion. Anything
 * else — a mapping flag, a title match, an applicant-name heuristic, a
 * reconstructed ranking, a unit-count threshold — is rejected structurally
 * rather than enumerated case by case, so a new proxy shortcut cannot slip
 * in by omission.
 */
export const AUTHORITATIVE_SOURCE_KINDS = Object.freeze({
  "affordable_housing.section_197f.commission_cycle_listed": Object.freeze(["official_commission_cycle_list"]),
  "affordable_housing.section_197f.qualifying_action_code": Object.freeze(["official_action_code_classification"]),
  "affordable_housing.section_666a.hpd_sponsorship_certified": Object.freeze(["hpd_certification_record"]),
  "affordable_housing.section_666a.affordability_covenant_recorded": Object.freeze(["recorded_covenant_document"]),
  "affordable_housing.section_197g.eligible_application_class": Object.freeze(["official_application_classification"]),
});

/**
 * The first official Commission cycle list cannot exist before this date.
 * This is a fact-level operative date, distinct from (and later than) the
 * §197-f regime's own Charter effective date in `land_review_regimes.json`:
 * the regime exists once enacted, but the cycle-list mechanism it depends on
 * has its own later operative milestone. Only the enacted entry applies —
 * a `proposed-rule` entry proposing an earlier start is retained for
 * traceability but is never selected until it is enacted (A10).
 */
export const COMMISSION_CYCLE_OPERATIVE_RULES = Object.freeze([
  Object.freeze({
    rule_id: "commission_cycle_operative_2027",
    source_status: "enacted",
    effective_from: "2027-01-01",
    legal_basis: "NYC Charter § 197-f(b) (first Commission cycle list)",
  }),
]);

/**
 * No official Commission cycle list has been committed to this repository.
 * Callers (and tests) supply hypothetical fixtures through the `cycle_lists`
 * option; this default represents the honest "none published yet" state.
 */
export const OFFICIAL_COMMISSION_CYCLE_LISTS = Object.freeze([]);

function clean(value) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text || null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonicalDay(value) {
  const text = clean(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

function baseFact(key, extra = {}) {
  return {
    schema: AFFORDABLE_ELIGIBILITY_FACTS_SCHEMA,
    key,
    value: null,
    state: "unknown",
    reason: "no_source_supplied",
    evidence: [],
    source: null,
    observed_at: null,
    ...extra,
  };
}

function knownFact(key, { value, source, observed_at, evidence_id, note = null }) {
  return {
    schema: AFFORDABLE_ELIGIBILITY_FACTS_SCHEMA,
    key,
    value,
    state: value ? "known_true" : "known_false",
    reason: null,
    evidence: [{
      evidence_id: clean(evidence_id) || `${key}:${clean(observed_at) || "unknown"}`,
      source,
      observed_at: observed_at || null,
      note,
    }],
    source,
    observed_at: observed_at || null,
  };
}

/** A criterion resolves `unknown` unless an authoritative source is supplied. Never `false` by default (A5, A11). */
function rejectNonAuthoritativeSource(key, source) {
  const allowed = AUTHORITATIVE_SOURCE_KINDS[key];
  if (!allowed) throw new TypeError(`unsupported affordable eligibility fact key: ${key}`);
  if (!isPlainObject(source) || !clean(source.kind)) {
    return baseFact(key, { reason: "no_source_supplied" });
  }
  if (!allowed.includes(source.kind)) {
    return baseFact(key, { reason: `source_kind_not_authoritative:${source.kind}`, source: { ...source } });
  }
  return null;
}

/** §666-a / §197-f / §197-g "simple" documentary facts: one authoritative source kind, an explicit boolean, or unknown. */
function materializeDocumentaryFact(key, { source } = {}) {
  const rejected = rejectNonAuthoritativeSource(key, source);
  if (rejected) return rejected;
  if (source.value !== true && source.value !== false) {
    return baseFact(key, { reason: "authoritative_source_missing_determination", source: { ...source } });
  }
  return knownFact(key, {
    value: source.value,
    source: { ...source },
    observed_at: source.observed_at || null,
    evidence_id: source.record_id || source.evidence_id,
    note: source.statement || null,
  });
}

/** Tag a non-authoritative reconstructed ranking for traceability. It never satisfies the official criterion (A7). */
export function recordReconstructedCommissionCycleCandidate(candidate = {}) {
  return {
    kind: "reconstructed_candidate",
    authoritative: false,
    ...candidate,
  };
}

function operativeCommissionCycleRule(referenceDay) {
  return COMMISSION_CYCLE_OPERATIVE_RULES
    .filter((rule) => rule.source_status === "enacted")
    .find((rule) => referenceDay && referenceDay >= rule.effective_from) || null;
}

function cycleListInForce(filingDay, cycleLists) {
  return (cycleLists || [])
    .filter((list) => list.source_status === "enacted")
    .find((list) => filingDay >= list.effective_from && (!list.effective_to || filingDay <= list.effective_to))
    || null;
}

/**
 * §197-f commission-cycle-listed fact. Gated by the fact-level operative
 * date (A6, A10) ahead of any source check, and resolved only against the
 * cycle list actually in force on the filing date (A8), never today's list
 * and never a reconstructed ranking (A7).
 */
export function materializeCommissionCycleListedFact({
  project_id,
  filing_date,
  source = null,
  reconstructed_candidate = null,
  cycle_lists = OFFICIAL_COMMISSION_CYCLE_LISTS,
} = {}) {
  const key = "affordable_housing.section_197f.commission_cycle_listed";
  const projectId = clean(project_id) || "unknown-project";
  const filingDay = canonicalDay(filing_date);
  const reconstructed = reconstructed_candidate ? recordReconstructedCommissionCycleCandidate(reconstructed_candidate) : null;

  const rule = operativeCommissionCycleRule(filingDay);
  if (!rule) {
    return {
      ...baseFact(key, { reason: "commission_cycle_not_yet_operative", state: "not_yet_effective" }),
      reconstructed_candidate: reconstructed,
    };
  }

  const rejected = rejectNonAuthoritativeSource(key, source);
  if (rejected) return { ...rejected, reconstructed_candidate: reconstructed };

  const list = cycleListInForce(filingDay, cycle_lists);
  if (!list) {
    return {
      ...baseFact(key, { reason: "no_official_cycle_list_in_force_for_filing_date" }),
      reconstructed_candidate: reconstructed,
    };
  }

  const listed = (list.listed_project_ids || []).includes(projectId);
  return {
    ...knownFact(key, {
      value: listed,
      source: { kind: source.kind, cycle_id: list.cycle_id, version: list.version, published_at: list.published_at },
      observed_at: list.published_at,
      evidence_id: `${list.cycle_id}:${list.version}:${projectId}`,
      note: listed
        ? `${projectId} appears in Commission cycle list ${list.cycle_id} v${list.version}`
        : `${projectId} is absent from Commission cycle list ${list.cycle_id} v${list.version}`,
    }),
    reconstructed_candidate: reconstructed,
  };
}

export function materializeQualifyingActionCodeFact({ source } = {}) {
  return materializeDocumentaryFact("affordable_housing.section_197f.qualifying_action_code", { source });
}

export function materializeHpdSponsorshipCertifiedFact({ source } = {}) {
  return materializeDocumentaryFact("affordable_housing.section_666a.hpd_sponsorship_certified", { source });
}

export function materializeAffordabilityCovenantRecordedFact({ source } = {}) {
  return materializeDocumentaryFact("affordable_housing.section_666a.affordability_covenant_recorded", { source });
}

/**
 * §197-g eligible-application-class fact. Modeled as a single named
 * statutory sub-criterion — whether the application directly facilitates
 * affordable housing — decided only by an explicit Commission
 * classification, never by an inclusionary-housing map designation, a
 * title, an applicant name, or a unit count (A4, A5).
 */
export function materializeDirectlyFacilitatesAffordableHousingFact({ source } = {}) {
  return materializeDocumentaryFact("affordable_housing.section_197g.eligible_application_class", { source });
}

const FACT_MATERIALIZERS = Object.freeze({
  "affordable_housing.section_197f.commission_cycle_listed": materializeCommissionCycleListedFact,
  "affordable_housing.section_197f.qualifying_action_code": materializeQualifyingActionCodeFact,
  "affordable_housing.section_666a.hpd_sponsorship_certified": materializeHpdSponsorshipCertifiedFact,
  "affordable_housing.section_666a.affordability_covenant_recorded": materializeAffordabilityCovenantRecordedFact,
  "affordable_housing.section_197g.eligible_application_class": materializeDirectlyFacilitatesAffordableHousingFact,
});

/** Every criterion in a materialized fact set carries inspectable evidence, or is honestly unknown (A11). */
export function assertInspectableEvidence(fact) {
  if (fact.state === "known_true" || fact.state === "known_false") {
    if (!fact.source || !Array.isArray(fact.evidence) || !fact.evidence.length) {
      throw new TypeError(`fact ${fact.key} is ${fact.state} without inspectable evidence`);
    }
  }
  return fact;
}

/**
 * Materialize every statutory criterion for one regime and derive the
 * regime's overall status from LDP-18's resolver. Each criterion is
 * evaluated independently; the aggregate never treats a missing criterion
 * as a disqualifying `false`.
 */
export function materializeAffordableEligibilityFacts({
  regime_id,
  project_id,
  prediction_as_of = null,
  filing_date = null,
  criteria = {},
} = {}) {
  const regime = landReviewRegimeById(regime_id);
  if (!regime) {
    throw new TypeError(`unknown regime_id: ${regime_id}`);
  }
  const facts = regime.eligibility_fact_keys.map((key) => {
    const materialize = FACT_MATERIALIZERS[key];
    if (!materialize) throw new TypeError(`no materializer registered for ${key}`);
    const input = criteria[key] || {};
    const fact = assertInspectableEvidence(materialize({
      project_id,
      filing_date: filing_date || prediction_as_of,
      prediction_as_of,
      ...input,
    }));
    return fact;
  });

  const resolvedFacts = Object.fromEntries(
    facts
      .filter((fact) => fact.state === "known_true" || fact.state === "known_false")
      .map((fact) => [fact.key, fact.value]),
  );

  return {
    schema: AFFORDABLE_ELIGIBILITY_FACTS_SCHEMA,
    regime_id: regime.regime_id,
    project_id: clean(project_id),
    prediction_as_of: prediction_as_of || null,
    filing_date: filing_date || null,
    facts,
    regime_eligibility: resolveLandReviewRegimeEligibility({
      regime_id: regime.regime_id,
      facts: resolvedFacts,
      prediction_as_of,
    }),
  };
}

/**
 * §197-g carries a review posture that exists before any Council action:
 * `potential_review_eligibility` reflects only the application-class fact.
 * The `actual_trigger` is never materialized as jurisdiction until the
 * qualifying Council disposition itself exists — an unchanged approval, or
 * no vote yet, resolves the actual trigger to "none" even when the
 * application class is independently known eligible (A1, A2, A3).
 */
export function resolveAffordableAppealsReviewEligibility({
  project_id,
  prediction_as_of = null,
  eligible_application_class_source = null,
  council_disposition = null,
  base_procedure_id,
  base_stage_id,
} = {}) {
  const classFact = assertInspectableEvidence(materializeDirectlyFacilitatesAffordableHousingFact({
    source: eligible_application_class_source,
  }));

  const potentialReviewEligibility = resolveLandReviewRegimeEligibility({
    regime_id: "affordable_housing_appeals_197g",
    facts: classFact.state === "known_true" || classFact.state === "known_false"
      ? { "affordable_housing.section_197g.eligible_application_class": classFact.value }
      : {},
    prediction_as_of,
  });

  const actualTrigger = resolveAppealsRegimeSuccessor({
    procedure_id: base_procedure_id,
    stage_id: base_stage_id,
    facts: {
      ...(council_disposition ? { council_disposition } : {}),
      ...(classFact.state === "known_true" || classFact.state === "known_false"
        ? { "affordable_housing.section_197g.eligible_application_class": classFact.value }
        : {}),
    },
    prediction_as_of,
  });

  return {
    schema: AFFORDABLE_ELIGIBILITY_FACTS_SCHEMA,
    project_id: clean(project_id),
    prediction_as_of: prediction_as_of || null,
    eligible_application_class: classFact,
    potential_review_eligibility: potentialReviewEligibility,
    actual_trigger: actualTrigger,
  };
}
