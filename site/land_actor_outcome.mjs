/**
 * Actor-aware observed outcomes for Land ZAP dispositions (LDP-10).
 *
 * One normalized object per accepted disposition row: canonical actor
 * ref/kind, the publisher's own observed action, the raw outcome value, and
 * a profile-derived legal effect kept in its own field. The same array is
 * meant to power both the recommendations-and-decisions matrix and
 * role-aware timeline evidence — neither consumer re-parses raw dispositions
 * or independently paraphrases a source row.
 *
 * Advisory bodies (Community Board, Borough President, Borough Board) only
 * ever *issue a recommendation*: the publisher's Favorable/Unfavorable/
 * Conditional language never promotes them to a decision family, even when
 * that language reads like "unfavorable" == reject. A CB outcome is never
 * binding. Draft, missing, pending, meeting-only, and actor-ambiguous rows
 * never mint an observed outcome.
 */

import {
  LAND_PROCEDURE_PROFILE_REGISTRY,
  LAND_PROCEDURE_PROFILE_REGISTRY_VERSION,
} from "./land_procedure_profiles.mjs";
import { resolveLandActionProcedures } from "./land_action_procedure_resolution.mjs";
import { boroughBoardIdentity } from "./borough_board_identity.mjs";

export const LAND_ACTOR_OUTCOME_SCHEMA = "cityscroll.land_actor_outcome.v1";

export const ACTOR_KIND_COMMUNITY_BOARD = "community_board";
export const ACTOR_KIND_BOROUGH_PRESIDENT = "borough_president";
export const ACTOR_KIND_BOROUGH_BOARD = "borough_board";
export const ACTOR_KIND_CPC = "cpc";
export const ACTOR_KIND_CITY_COUNCIL = "city_council";

export const ACTOR_KINDS = Object.freeze([
  ACTOR_KIND_COMMUNITY_BOARD,
  ACTOR_KIND_BOROUGH_PRESIDENT,
  ACTOR_KIND_BOROUGH_BOARD,
  ACTOR_KIND_CPC,
  ACTOR_KIND_CITY_COUNCIL,
]);

// Advisory bodies: their observed action is always a recommendation, never a
// decision family — this is the negative rule "a CB outcome is not binding
// merely because it is observed" applied structurally, not by raw text.
export const ADVISORY_ACTOR_KINDS = Object.freeze([
  ACTOR_KIND_COMMUNITY_BOARD,
  ACTOR_KIND_BOROUGH_PRESIDENT,
  ACTOR_KIND_BOROUGH_BOARD,
]);

export const OBSERVED_ACTION = Object.freeze({
  ISSUES_RECOMMENDATION: "issues_recommendation",
  ADOPTS: "adopts",
  REJECTS: "rejects",
  MODIFIES: "modifies",
  DISPOSITION: "project_disposition",
});

// Timeline phase each actor kind's observed outcomes belong under. Borough
// Board review runs alongside Borough President review (same-borough,
// multi-district rule) and has no distinct spine phase of its own.
const ACTOR_KIND_SPINE_PHASE = Object.freeze({
  [ACTOR_KIND_COMMUNITY_BOARD]: "community_board",
  [ACTOR_KIND_BOROUGH_PRESIDENT]: "borough_president",
  [ACTOR_KIND_BOROUGH_BOARD]: "borough_president",
  [ACTOR_KIND_CPC]: "cpc",
  [ACTOR_KIND_CITY_COUNCIL]: "city_council",
});

const ACTOR_KIND_TO_SELECTOR = Object.freeze({
  [ACTOR_KIND_COMMUNITY_BOARD]: "affected_community_board",
  [ACTOR_KIND_BOROUGH_PRESIDENT]: "affected_borough_president",
  [ACTOR_KIND_BOROUGH_BOARD]: "affected_borough_board",
  [ACTOR_KIND_CPC]: "city_planning_commission",
  [ACTOR_KIND_CITY_COUNCIL]: "city_council",
});

const ACTOR_OUTCOME_BOROUGH_PREFIX = Object.freeze({
  X: Object.freeze({ name: "Bronx", slug: "bronx" }),
  K: Object.freeze({ name: "Brooklyn", slug: "brooklyn" }),
  M: Object.freeze({ name: "Manhattan", slug: "manhattan" }),
  Q: Object.freeze({ name: "Queens", slug: "queens" }),
  R: Object.freeze({ name: "Staten Island", slug: "staten-island" }),
});

const REPRESENTING_ACTOR_KIND = Object.freeze({
  "community board": ACTOR_KIND_COMMUNITY_BOARD,
  "borough president": ACTOR_KIND_BOROUGH_PRESIDENT,
  "borough board": ACTOR_KIND_BOROUGH_BOARD,
  "city planning commission": ACTOR_KIND_CPC,
  cpc: ACTOR_KIND_CPC,
  "city council": ACTOR_KIND_CITY_COUNCIL,
  council: ACTOR_KIND_CITY_COUNCIL,
});

const DRAFT_STATUS = /^draft$/i;
const PENDING_OUTCOME = /^(pending|not yet|scheduled)$/i;
const ADOPT_MARK = /\b(?:adopt(?:ed|s|ion)?|approved)\b/i;
const REJECT_MARK = /\b(?:reject(?:ed|s|ion)?|disapproved|denied|unfavorable)\b/i;
const MODIFY_MARK = /\bmodif(?:y|ied|ies|ication)\b/i;
const AUTHORITATIVE_OUTCOME = /\b(?:favorable|unfavorable|approved|disapproved|denied|adopted|rejected|conditional|withdrawn|modified)\b/i;

function clean(value, max = 500) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function isoDate(value) {
  const text = clean(value, 40);
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

/** Canonical actor kind from a ZAP disposition's `representing` field. */
export function actorKindFromRepresenting(representing) {
  const key = clean(representing).toLowerCase();
  return REPRESENTING_ACTOR_KIND[key] || null;
}

function boroughFromProjectId(projectId) {
  const letter = clean(projectId, 12).toUpperCase().charAt(4);
  return ACTOR_OUTCOME_BOROUGH_PREFIX[letter] || null;
}

function boroughFromBoardId(boardId) {
  const match = clean(boardId, 40).match(/^([a-z]+(?:-[a-z]+)*)-cb-\d{2}$/);
  if (!match) return null;
  return Object.values(ACTOR_OUTCOME_BOROUGH_PREFIX).find((row) => row.slug === match[1]) || null;
}

function boroughSlugFromRef(ref, prefix) {
  const match = clean(ref, 80).match(new RegExp(`^${prefix}:([a-z]+(?:-[a-z]+)*)$`));
  return match ? match[1] : null;
}

/**
 * Prefer the LDP-04 geography-resolved affected body when it is unambiguous
 * (exactly one borough president / borough board for this project); fall
 * back to the disposition's own board_id, then the exact borough letter
 * embedded in the ZAP project id itself (YYYY + borough letter + sequence).
 * Never a title guess.
 */
function boroughFromAffected(kind, affected) {
  if (!affected || affected.status !== "resolved") return null;
  if (kind === ACTOR_KIND_BOROUGH_PRESIDENT) {
    const refs = affected.facts?.borough_presidents || [];
    if (refs.length !== 1) return null;
    const slug = boroughSlugFromRef(refs[0], "borough-president");
    return slug ? Object.values(ACTOR_OUTCOME_BOROUGH_PREFIX).find((row) => row.slug === slug) || null : null;
  }
  if (kind === ACTOR_KIND_BOROUGH_BOARD) {
    const refs = affected.facts?.borough_boards || [];
    if (refs.length !== 1) return null;
    const slug = boroughSlugFromRef(refs[0], "borough-board");
    return slug ? Object.values(ACTOR_OUTCOME_BOROUGH_PREFIX).find((row) => row.slug === slug) || null : null;
  }
  return null;
}

/**
 * Canonical actor ref for one disposition row. Ambiguous actor identity
 * (unresolved representing text, missing board_id, unresolved borough) never
 * produces a ref — the caller must gate on this, not guess.
 */
export function actorRefForOutcome(disposition = {}, { projectId, affected } = {}) {
  const kind = actorKindFromRepresenting(disposition.representing);
  if (!kind) return { kind: null, ref: null, reason: "actor_ambiguous" };
  if (kind === ACTOR_KIND_COMMUNITY_BOARD) {
    const boardId = clean(disposition.board_id, 80);
    if (!boardId) return { kind, ref: null, reason: "actor_ambiguous" };
    return { kind, ref: `community-board:${boardId}`, reason: null };
  }
  if (kind === ACTOR_KIND_CPC) return { kind, ref: "agency:id:city-planning-commission", reason: null };
  if (kind === ACTOR_KIND_CITY_COUNCIL) return { kind, ref: "agency:id:city-council", reason: null };
  const borough = boroughFromAffected(kind, affected)
    || boroughFromBoardId(disposition.board_id)
    || boroughFromProjectId(projectId);
  if (!borough) return { kind, ref: null, reason: "actor_ambiguous" };
  if (kind === ACTOR_KIND_BOROUGH_PRESIDENT) {
    return { kind, ref: `borough-president:${borough.slug}`, reason: null };
  }
  if (kind === ACTOR_KIND_BOROUGH_BOARD) {
    const identity = boroughBoardIdentity(borough.slug);
    return identity ? { kind, ref: identity.id, reason: null } : { kind, ref: null, reason: "actor_ambiguous" };
  }
  return { kind: null, ref: null, reason: "actor_ambiguous" };
}

function rawOutcomeValue(disposition = {}) {
  return clean(
    disposition.community_board
      || disposition.borough_president
      || disposition.borough_board
      || disposition.outcome
      || "",
  );
}

/**
 * Advisory actors (CB, BP, Borough Board) only ever *issue a recommendation*
 * regardless of the raw outcome's Favorable/Unfavorable/Conditional
 * language. Decisional actors (CPC, Council) map the raw outcome language to
 * adopts/rejects/modifies, falling back to the generic disposition family
 * when the language is not an unambiguous adopt/reject/modify statement
 * (e.g. a bare "Approved with conditions").
 */
function observedActionFor(actorKind, rawOutcome) {
  if (ADVISORY_ACTOR_KINDS.includes(actorKind)) return OBSERVED_ACTION.ISSUES_RECOMMENDATION;
  if (MODIFY_MARK.test(rawOutcome)) return OBSERVED_ACTION.MODIFIES;
  if (ADOPT_MARK.test(rawOutcome) && !REJECT_MARK.test(rawOutcome)) return OBSERVED_ACTION.ADOPTS;
  if (REJECT_MARK.test(rawOutcome) && !ADOPT_MARK.test(rawOutcome)) return OBSERVED_ACTION.REJECTS;
  return OBSERVED_ACTION.DISPOSITION;
}

const ACTOR_OUTCOME_PROFILE_BY_ID = new Map(
  (LAND_PROCEDURE_PROFILE_REGISTRY.profiles || []).map((profile) => [profile.procedure_id, profile]),
);

function resolvedProfileFor(project) {
  if (!project || typeof project !== "object") return null;
  const resolution = resolveLandActionProcedures(project);
  if (resolution.procedure_resolution !== "uniform") return null;
  const ids = [...new Set(
    resolution.land_actions
      .filter((action) => action.status === "resolved")
      .map((action) => action.procedure_id)
      .filter(Boolean),
  )];
  return ids.length === 1 ? ACTOR_OUTCOME_PROFILE_BY_ID.get(ids[0]) || null : null;
}

function stageForActorKind(profile, actorKind) {
  const selectorKind = ACTOR_KIND_TO_SELECTOR[actorKind];
  if (!profile || !selectorKind) return null;
  return (profile.stages || []).find((stage) => stage.actor_selector?.kind === selectorKind) || null;
}

/**
 * Profile-derived legal effect, kept structurally separate from the
 * publisher's observed action and raw value. Null role/effect (with a
 * reason) when the procedure does not resolve to exactly one profile or that
 * profile names no stage for this actor kind — never inferred from the raw
 * outcome text, and never overwrites the raw source value.
 */
export function legalEffectFromProfile(project, actorKind) {
  const profile = resolvedProfileFor(project);
  if (!profile) return { role: null, effect: null, reason: "procedure_unresolved", procedure_id: null, stage_id: null };
  const stage = stageForActorKind(profile, actorKind);
  if (!stage) {
    return {
      role: null,
      effect: null,
      reason: "no_matching_stage_in_profile",
      procedure_id: profile.procedure_id,
      stage_id: null,
    };
  }
  return {
    role: stage.role || null,
    effect: stage.effect || null,
    reason: null,
    procedure_id: profile.procedure_id,
    stage_id: stage.stage_id,
  };
}

/** Timeline spine phase id an actor kind's observed outcomes belong under. */
export function spinePhaseIdForActorKind(actorKind) {
  return ACTOR_KIND_SPINE_PHASE[actorKind] || null;
}

/**
 * Gate + normalize one ZAP disposition row into the canonical observed
 * outcome contract. Returns null when evidence is insufficient: draft,
 * missing/pending raw outcome, non-authoritative language, or an
 * actor-ambiguous representing/board_id. Never promotes a CB/BP/Borough
 * Board outcome to a decision family, and never overwrites the raw value.
 */
export function buildActorObservedOutcome(disposition = {}, { projectId, project, affected } = {}) {
  const status = clean(disposition.status, 80);
  if (!status || DRAFT_STATUS.test(status)) return null;
  const raw = rawOutcomeValue(disposition);
  if (!raw || PENDING_OUTCOME.test(raw)) return null;
  if (!AUTHORITATIVE_OUTCOME.test(raw) && !AUTHORITATIVE_OUTCOME.test(status)) return null;
  const actor = actorRefForOutcome(disposition, { projectId, affected });
  if (!actor.kind || !actor.ref) return null;

  const observedAction = observedActionFor(actor.kind, raw);
  const effect = legalEffectFromProfile(project || { project_id: projectId }, actor.kind);
  const dispositionId = clean(disposition.id, 120) || null;
  const cleanProjectId = clean(projectId, 25) || null;
  const sourceIds = Array.isArray(disposition.source_ids)
    ? disposition.source_ids.map((value) => clean(value, 120)).filter(Boolean)
    : [];
  const votesFor = Number.isFinite(disposition.votes_for) ? disposition.votes_for : null;
  const votesAgainst = Number.isFinite(disposition.votes_against) ? disposition.votes_against : null;
  const votesAbstain = Number.isFinite(disposition.votes_abstain) ? disposition.votes_abstain : null;

  return Object.freeze({
    schema: LAND_ACTOR_OUTCOME_SCHEMA,
    project_id: cleanProjectId,
    action_key: dispositionId && cleanProjectId
      ? `project:${cleanProjectId}:disposition:${dispositionId}`
      : null,
    actor_ref: actor.ref,
    actor_kind: actor.kind,
    is_advisory: ADVISORY_ACTOR_KINDS.includes(actor.kind),
    observed_action: observedAction,
    raw_outcome: raw,
    legal_effect_from_profile: effect.role || effect.effect
      ? Object.freeze({
        role: effect.role,
        effect: effect.effect,
        procedure_id: effect.procedure_id,
        stage_id: effect.stage_id,
        registry_version: LAND_PROCEDURE_PROFILE_REGISTRY_VERSION,
      })
      : null,
    legal_effect_reason: effect.reason,
    observed_at: isoDate(disposition.vote_date) || isoDate(disposition.hearing_date) || isoDate(disposition.hearing_at),
    vote_tally: (votesFor != null || votesAgainst != null || votesAbstain != null)
      ? Object.freeze({ for: votesFor, against: votesAgainst, abstain: votesAbstain })
      : null,
    disposition_id: dispositionId,
    source_ids: Object.freeze(sourceIds),
    document_count: Number.isFinite(disposition.n_documents) ? disposition.n_documents : null,
    spine_phase_id: spinePhaseIdForActorKind(actor.kind),
  });
}

/**
 * Build the full observed_outcomes[] for one project's ZAP dispositions.
 * This is the single array both the recommendations-and-decisions matrix
 * (`land_outcomes_matrix.mjs`) and role-aware timeline evidence
 * (`land_phase_spine.mjs`) consume — neither independently re-parses raw
 * disposition rows.
 */
export function buildActorObservedOutcomes(dispositions = [], { projectId, project, affected } = {}) {
  const rows = Array.isArray(dispositions) ? dispositions : [];
  const out = [];
  for (const disposition of rows) {
    const outcome = buildActorObservedOutcome(disposition, { projectId, project, affected });
    if (outcome) out.push(outcome);
  }
  return out;
}
