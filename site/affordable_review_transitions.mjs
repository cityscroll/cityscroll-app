/**
 * Source-qualified affordable-housing review transitions (LDP-20).
 *
 * LDP-19 (`affordable_eligibility_facts.mjs`) resolves whether an appeals or
 * targeted-project branch is legally *available*. Availability is not
 * invocation: a qualifying Council disposition on an eligible application
 * makes the Board of Standards and Appeals appeals path available, but that
 * says nothing about whether anyone actually asked for it. This module is
 * the layer that materializes the actual, source-qualified transitions of an
 * invoked review — a request, a call-up, a hearing, a decision — and keeps
 * them structurally separate from the underlying availability.
 *
 * The governing discipline is the same unknown-by-default posture as LDP-19,
 * extended from facts to events: a transition event exists in `events` only
 * when a caller-supplied claim carries a confirmed, exact-joined,
 * governing-rule-in-force source. A claim that fails any of those checks is
 * never silently dropped; it is retained in `rejected_claims` with the
 * reason, so a coverage gap or an insufficient call-up is inspectable rather
 * than invisible. Absence of any qualifying claim is never read as proof
 * that nothing happened: the `status` field distinguishes "no qualifying
 * trigger exists" (`no_trigger`), "a trigger exists but no one has checked
 * whether it was invoked" (`not_observed`), "checked, and nothing was
 * invoked" (`eligible_but_not_invoked`), "invoked, not yet decided"
 * (`invoked_unresolved`), and "decided" (`resolved`).
 */

import {
  landReviewRegimeById,
  resolveAppealsRegimeSuccessor,
  resolveLandReviewRegimeEligibility,
} from "./land_review_regimes.mjs";
import { materializeDirectlyFacilitatesAffordableHousingFact } from "./affordable_eligibility_facts.mjs";

export const AFFORDABLE_REVIEW_TRANSITIONS_SCHEMA = "cityscroll.affordable_review_transitions.v1";

export const REVIEW_MECHANISM_KINDS = Object.freeze(["appeals_board_197g", "targeted_project_666a"]);

/** The appeals (§197-g) transition vocabulary. `review_available` is not an event kind here — see `review_available` below. */
export const APPEALS_TRANSITION_KINDS = Object.freeze([
  "review_requested_by_applicant",
  "called_up_by_members",
  "public_meeting",
  "affirms_council",
  "reverses_disapproval",
  "removes_council_modification",
  "deemed_affirmed",
]);

/** The targeted-project (§666-a) board-application transition vocabulary. */
export const TARGETED_PROJECT_TRANSITION_KINDS = Object.freeze([
  "filed",
  "local_review",
  "board_hearing",
  "approved",
  "denied",
  "extended",
]);

const APPEALS_INVOCATION_KINDS = Object.freeze(["review_requested_by_applicant", "called_up_by_members"]);
const APPEALS_MEETING_KINDS = Object.freeze(["public_meeting"]);
const APPEALS_DECISION_KINDS = Object.freeze([
  "affirms_council",
  "reverses_disapproval",
  "removes_council_modification",
  "deemed_affirmed",
]);

const TARGETED_PROJECT_PROCESS_KINDS = Object.freeze(["local_review", "board_hearing"]);
const TARGETED_PROJECT_DECISION_KINDS = Object.freeze(["approved", "denied", "extended"]);

/** A transition's overall review posture. Never inferred from the world's silence — only from what was actually checked. */
export const REVIEW_TRANSITION_STATUSES = Object.freeze([
  "no_trigger",
  "not_observed",
  "eligible_but_not_invoked",
  "invoked_unresolved",
  "resolved",
]);

/** How confirmed the underlying source record is. Only `confirmed` sources may materialize an actual event (A6, A7). */
export const TRANSITION_EVIDENCE_SOURCE_STATUSES = Object.freeze(["confirmed", "reported", "draft"]);

/** Exact-identity join methods. A transition claim must name one; approximate joins (title, address, applicant-name similarity) are not representable here (A9). */
export const TRANSITION_JOIN_METHODS = Object.freeze([
  "application_id_exact_match",
  "board_application_id_exact_match",
  "council_action_id_exact_match",
]);

const APPEALS_JOIN_METHODS = Object.freeze(
  TRANSITION_JOIN_METHODS.filter((method) => method !== "board_application_id_exact_match"),
);
const TARGETED_PROJECT_JOIN_METHODS = Object.freeze(
  TRANSITION_JOIN_METHODS.filter((method) => method === "board_application_id_exact_match"),
);

/**
 * Implementing-rule versions governing how the §197-g appeals procedure is
 * actually run (as distinct from the Charter provision itself, which
 * `land_review_regimes.json` already dates). Only an `enacted` or
 * `adopted-rule` version governs; a `proposed-rule` entry is retained for
 * traceability but can never become the operative version by being appended
 * with an earlier date (A10, mirrors LDP-19's `COMMISSION_CYCLE_OPERATIVE_RULES`).
 */
export const APPEALS_IMPLEMENTING_RULE_VERSIONS = Object.freeze([
  Object.freeze({
    rule_version_id: "bsa_197g_procedures_v1",
    source_status: "adopted-rule",
    effective_from: "2025-12-02",
    legal_basis: "Board of Standards and Appeals rules of practice implementing NYC Charter § 197-g",
  }),
]);

/** No implementing-rule version has been committed for the standalone §666-a board-application path; it runs on the Charter provision alone. */
export const TARGETED_PROJECT_IMPLEMENTING_RULE_VERSIONS = Object.freeze([]);

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

function operativeImplementingRule(versions, referenceDay) {
  return versions
    .filter((rule) => rule.source_status === "enacted" || rule.source_status === "adopted-rule")
    .filter((rule) => referenceDay && referenceDay >= rule.effective_from)
    .sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1))[0] || null;
}

function validSource(source) {
  return isPlainObject(source)
    && clean(source.source_id)
    && clean(source.url)
    && TRANSITION_EVIDENCE_SOURCE_STATUSES.includes(source.status);
}

function rejected(kind, reason, claim = null) {
  return { kind: clean(kind), reason, claim: claim ? { ...claim } : null };
}

/**
 * Validate the fields every materialized transition event must carry
 * regardless of mechanism: an exact application/board-application
 * identifier, an actor, an observation date, a confirmed source with an
 * identifier and URL, an exact join method, and the stage the event moves
 * between. Returns `null` when the claim is well-formed; otherwise a
 * rejection reason string.
 */
function validateCommonClaimShape(claim, { expectedApplicationId, allowedJoinMethods }) {
  if (!isPlainObject(claim)) return "claim_not_an_object";
  if (clean(claim.application_id) !== expectedApplicationId) return "application_id_not_exact_match";
  if (!isPlainObject(claim.actor) || !clean(claim.actor.kind)) return "missing_actor";
  if (!canonicalDay(claim.observed_at)) return "missing_or_invalid_observed_at";
  if (!validSource(claim.source)) return "missing_or_unconfirmed_source";
  if (claim.source.status !== "confirmed") return "source_not_confirmed";
  if (!allowedJoinMethods.includes(claim.join_method)) return "join_method_not_exact";
  return null;
}

function materializeEvent(kind, claim, { prior_stage_id, resulting_stage_id, rule_version, extra = {} }) {
  return {
    schema: AFFORDABLE_REVIEW_TRANSITIONS_SCHEMA,
    kind,
    application_id: clean(claim.application_id),
    actor: { ...claim.actor },
    observed_at: claim.observed_at,
    source: { ...claim.source },
    join_method: claim.join_method,
    prior_stage_id: prior_stage_id || null,
    resulting_stage_id: resulting_stage_id || null,
    rule_version: rule_version ? { ...rule_version } : null,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Appeals-board (§197-g) transitions
// ---------------------------------------------------------------------------

function materializeCalledUpMembers(claim) {
  const members = Array.isArray(claim.members) ? claim.members : [];
  const valid = members.filter((member) => isPlainObject(member)
    && clean(member.member_id)
    && validSource(member.source)
    && member.source.status === "confirmed");
  const distinctMemberIds = new Set(valid.map((member) => clean(member.member_id)));
  const distinctSourceIds = new Set(valid.map((member) => clean(member.source.source_id)));
  if (distinctMemberIds.size < 2 || distinctSourceIds.size < 2) {
    return { ok: false, reason: "insufficient_call_up_evidence" };
  }
  return { ok: true, members: valid.map((member) => ({ ...member, source: { ...member.source } })) };
}

function materializeAppealsInvocation(claim, ctx) {
  const shapeError = validateCommonClaimShape(claim, ctx);
  if (shapeError) return { event: null, rejection: rejected(claim?.kind, shapeError, claim) };

  if (claim.kind === "review_requested_by_applicant") {
    if (claim.within_statutory_window !== true) {
      return { event: null, rejection: rejected(claim.kind, "not_asserted_within_statutory_window", claim) };
    }
    return {
      event: materializeEvent("review_requested_by_applicant", claim, ctx),
      rejection: null,
    };
  }

  if (claim.kind === "called_up_by_members") {
    const callUp = materializeCalledUpMembers(claim);
    if (!callUp.ok) return { event: null, rejection: rejected(claim.kind, callUp.reason, claim) };
    return {
      event: materializeEvent("called_up_by_members", claim, { ...ctx, extra: { members: callUp.members } }),
      rejection: null,
    };
  }

  return { event: null, rejection: rejected(claim?.kind, "unsupported_invocation_kind", claim) };
}

function materializeAppealsMeeting(claim, ctx) {
  const shapeError = validateCommonClaimShape(claim, ctx);
  if (shapeError) return { event: null, rejection: rejected(claim?.kind, shapeError, claim) };
  return { event: materializeEvent("public_meeting", claim, ctx), rejection: null };
}

function materializeAppealsDecision(claim, ctx) {
  const shapeError = validateCommonClaimShape(claim, ctx);
  if (shapeError) return { event: null, rejection: rejected(claim?.kind, shapeError, claim) };

  if (claim.kind === "removes_council_modification") {
    const modifications = Array.isArray(claim.modifications_removed) ? claim.modifications_removed : [];
    const named = modifications.filter((entry) => clean(entry?.modification_id) && clean(entry?.description));
    if (!named.length) {
      return { event: null, rejection: rejected(claim.kind, "no_source_backed_modifications_named", claim) };
    }
    return {
      event: materializeEvent("removes_council_modification", claim, {
        ...ctx,
        extra: { modifications_removed: named.map((entry) => ({ ...entry })) },
      }),
      rejection: null,
    };
  }

  if (!APPEALS_DECISION_KINDS.includes(claim.kind)) {
    return { event: null, rejection: rejected(claim?.kind, "unsupported_decision_kind", claim) };
  }
  return { event: materializeEvent(claim.kind, claim, ctx), rejection: null };
}

/**
 * Materialize the actual, source-qualified transitions of an §197-g appeals
 * review from caller-supplied claims. Availability (from LDP-19) is never
 * itself an event: `review_available` here is a derived descriptive field,
 * never entered into `events`, so eligibility alone can never manufacture a
 * proceeding (A1).
 */
export function materializeAppealsReviewTransitions({
  project_id,
  base_procedure_id,
  base_stage_id,
  council_disposition = null,
  eligible_application_class_source = null,
  prediction_as_of = null,
  invocation_claims = [],
  meeting_claims = [],
  decision_claims = [],
  coverage = null,
} = {}) {
  const regime = landReviewRegimeById("affordable_housing_appeals_197g");
  const applicationId = clean(project_id);
  const predictionDay = canonicalDay(prediction_as_of);

  const classFact = materializeDirectlyFacilitatesAffordableHousingFact({ source: eligible_application_class_source });
  const potentialReviewEligibility = resolveLandReviewRegimeEligibility({
    regime_id: regime.regime_id,
    facts: classFact.state === "known_true" || classFact.state === "known_false"
      ? { "affordable_housing.section_197g.eligible_application_class": classFact.value }
      : {},
    prediction_as_of,
  });
  const trigger = resolveAppealsRegimeSuccessor({
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

  const reviewAvailable = {
    available: trigger.status === "potential" || trigger.status === "confirmed",
    reason: trigger.reason,
    to_stage_id: trigger.to_stage_id,
  };

  // A8: fixtures dated before the regime's effective date can never emit
  // events, regardless of what claims are supplied (LDP-19's resolver
  // already reports `not_yet_effective`, but a caller could still pass
  // claims dated in that window — those are rejected explicitly below).
  const notYetEffective = predictionDay && regime.effective_from && predictionDay < regime.effective_from;

  if (trigger.status === "none" || notYetEffective) {
    return {
      schema: AFFORDABLE_REVIEW_TRANSITIONS_SCHEMA,
      mechanism: "appeals_board_197g",
      project_id: applicationId,
      prediction_as_of: prediction_as_of || null,
      potential_review_eligibility: potentialReviewEligibility,
      trigger,
      review_available: notYetEffective ? { available: false, reason: "not_yet_effective", to_stage_id: null } : reviewAvailable,
      status: "no_trigger",
      coverage: coverage ? { ...coverage } : { checked: false, reason: "no_qualifying_trigger" },
      events: [],
      rejected_claims: [],
    };
  }

  const ruleVersion = operativeImplementingRule(APPEALS_IMPLEMENTING_RULE_VERSIONS, predictionDay);
  const ctx = {
    expectedApplicationId: applicationId,
    allowedJoinMethods: APPEALS_JOIN_METHODS,
    prior_stage_id: base_stage_id,
    resulting_stage_id: trigger.to_stage_id,
    rule_version: ruleVersion,
  };

  const rejectedClaims = [];
  const invocationEvents = [];
  for (const claim of invocation_claims) {
    const observedDay = canonicalDay(claim?.observed_at);
    if (observedDay && regime.effective_from && observedDay < regime.effective_from) {
      rejectedClaims.push(rejected(claim?.kind, "observed_before_regime_effective_date", claim));
      continue;
    }
    if (!APPEALS_INVOCATION_KINDS.includes(claim?.kind)) {
      rejectedClaims.push(rejected(claim?.kind, "unsupported_invocation_kind", claim));
      continue;
    }
    const { event, rejection } = materializeAppealsInvocation(claim, ctx);
    if (event) invocationEvents.push(event);
    if (rejection) rejectedClaims.push(rejection);
  }

  const meetingEvents = [];
  for (const claim of meeting_claims || []) {
    if (!APPEALS_MEETING_KINDS.includes(claim?.kind)) {
      rejectedClaims.push(rejected(claim?.kind, "unsupported_meeting_kind", claim));
      continue;
    }
    const { event, rejection } = materializeAppealsMeeting(claim, ctx);
    if (event) meetingEvents.push(event);
    if (rejection) rejectedClaims.push(rejection);
  }

  const decisionEvents = [];
  const hasInvocation = invocationEvents.length > 0;
  for (const claim of (decision_claims || []).filter((c) => APPEALS_DECISION_KINDS.includes(c?.kind))) {
    if (!hasInvocation) {
      rejectedClaims.push(rejected(claim?.kind, "no_invocation_precedes_this_decision", claim));
      continue;
    }
    const { event, rejection } = materializeAppealsDecision(claim, ctx);
    if (event) decisionEvents.push(event);
    if (rejection) rejectedClaims.push(rejection);
  }

  const events = [...invocationEvents, ...meetingEvents, ...decisionEvents];

  let status;
  if (decisionEvents.length) status = "resolved";
  else if (invocationEvents.length) status = "invoked_unresolved";
  else if (coverage && coverage.checked === true) status = "eligible_but_not_invoked";
  else status = "not_observed";

  return {
    schema: AFFORDABLE_REVIEW_TRANSITIONS_SCHEMA,
    mechanism: "appeals_board_197g",
    project_id: applicationId,
    prediction_as_of: prediction_as_of || null,
    potential_review_eligibility: potentialReviewEligibility,
    trigger,
    review_available: reviewAvailable,
    status,
    coverage: coverage ? { ...coverage } : { checked: false, reason: "no_coverage_assertion_supplied" },
    events,
    rejected_claims: rejectedClaims,
  };
}

// ---------------------------------------------------------------------------
// Targeted affordable-housing project (§666-a) board-application transitions
// ---------------------------------------------------------------------------

/**
 * Materialize the actual transitions of a §666-a targeted-project board
 * application from caller-supplied claims. `board_application_id` must be
 * supplied and exact: a project identifier, title, or address is never an
 * acceptable substitute (A9) — this function throws if it is absent so a
 * caller cannot silently fall back to a looser join.
 */
export function materializeTargetedProjectTransitions({
  board_application_id,
  prediction_as_of = null,
  filing_claim = null,
  process_claims = [],
  decision_claim = null,
  coverage = null,
} = {}) {
  const boardApplicationId = clean(board_application_id);
  if (!boardApplicationId) {
    throw new TypeError("materializeTargetedProjectTransitions requires an exact board_application_id");
  }

  const regime = landReviewRegimeById("targeted_affordable_housing_project_666a");
  const predictionDay = canonicalDay(prediction_as_of);
  const notYetEffective = predictionDay && regime.effective_from && predictionDay < regime.effective_from;

  const filingStageId = regime.entry_stage?.stage_id || null;
  const hearingStageId = (regime.stages || []).find((stage) => stage.stage_id.endsWith(".public_hearing"))?.stage_id || null;

  if (notYetEffective) {
    return {
      schema: AFFORDABLE_REVIEW_TRANSITIONS_SCHEMA,
      mechanism: "targeted_project_666a",
      board_application_id: boardApplicationId,
      prediction_as_of: prediction_as_of || null,
      status: "no_trigger",
      coverage: coverage ? { ...coverage } : { checked: false, reason: "not_yet_effective" },
      events: [],
      rejected_claims: [],
    };
  }

  const rejectedClaims = [];
  const events = [];

  const filingCtx = {
    expectedApplicationId: boardApplicationId,
    allowedJoinMethods: TARGETED_PROJECT_JOIN_METHODS,
    prior_stage_id: null,
    resulting_stage_id: filingStageId,
    rule_version: null,
  };

  let filed = false;
  if (filing_claim) {
    if (filing_claim.kind !== "filed") {
      rejectedClaims.push(rejected(filing_claim.kind, "unsupported_filing_kind", filing_claim));
    } else {
      const shapeError = validateCommonClaimShape(filing_claim, filingCtx);
      if (shapeError) {
        rejectedClaims.push(rejected("filed", shapeError, filing_claim));
      } else {
        events.push(materializeEvent("filed", filing_claim, filingCtx));
        filed = true;
      }
    }
  }

  const processCtx = {
    expectedApplicationId: boardApplicationId,
    allowedJoinMethods: TARGETED_PROJECT_JOIN_METHODS,
    prior_stage_id: filingStageId,
    resulting_stage_id: hearingStageId,
    rule_version: null,
  };
  for (const claim of process_claims || []) {
    if (!filed) {
      rejectedClaims.push(rejected(claim?.kind, "no_filing_precedes_this_step", claim));
      continue;
    }
    if (!TARGETED_PROJECT_PROCESS_KINDS.includes(claim?.kind)) {
      rejectedClaims.push(rejected(claim?.kind, "unsupported_process_kind", claim));
      continue;
    }
    const shapeError = validateCommonClaimShape(claim, processCtx);
    if (shapeError) {
      rejectedClaims.push(rejected(claim.kind, shapeError, claim));
      continue;
    }
    events.push(materializeEvent(claim.kind, claim, processCtx));
  }

  const decisionCtx = {
    expectedApplicationId: boardApplicationId,
    allowedJoinMethods: TARGETED_PROJECT_JOIN_METHODS,
    prior_stage_id: hearingStageId,
    resulting_stage_id: hearingStageId,
    rule_version: null,
  };
  let decided = false;
  if (decision_claim) {
    if (!filed) {
      rejectedClaims.push(rejected(decision_claim.kind, "no_filing_precedes_this_decision", decision_claim));
    } else if (!TARGETED_PROJECT_DECISION_KINDS.includes(decision_claim.kind)) {
      rejectedClaims.push(rejected(decision_claim.kind, "unsupported_decision_kind", decision_claim));
    } else {
      const shapeError = validateCommonClaimShape(decision_claim, decisionCtx);
      if (shapeError) {
        rejectedClaims.push(rejected(decision_claim.kind, shapeError, decision_claim));
      } else {
        events.push(materializeEvent(decision_claim.kind, decision_claim, decisionCtx));
        decided = true;
      }
    }
  }

  let status;
  if (decided) status = "resolved";
  else if (filed) status = "invoked_unresolved";
  else if (coverage && coverage.checked === true) status = "eligible_but_not_invoked";
  else status = "not_observed";

  return {
    schema: AFFORDABLE_REVIEW_TRANSITIONS_SCHEMA,
    mechanism: "targeted_project_666a",
    board_application_id: boardApplicationId,
    prediction_as_of: prediction_as_of || null,
    status,
    coverage: coverage ? { ...coverage } : { checked: false, reason: "no_coverage_assertion_supplied" },
    events,
    rejected_claims: rejectedClaims,
  };
}
