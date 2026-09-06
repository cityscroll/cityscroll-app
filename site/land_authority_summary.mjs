/**
 * Bounded Land authority summary (Tier A).
 *
 * Answers "who has the ball?" from exact project/action resolution, the
 * reviewed procedure profile, phase-spine / current-milestone evidence,
 * LDP-04 geography for affected actors, and source ids for published
 * opportunities. Normative role/effect, observed recommendations, and
 * published next opportunities stay separate. This module never fetches.
 */

import { communityBoardPageHref } from "./community_board_links.mjs";
import {
  LAND_PROCEDURE_PROFILE_REGISTRY,
  LAND_PROCEDURE_PROFILE_REGISTRY_VERSION,
  matchesLandProcedureCondition,
} from "./land_procedure_profiles.mjs";
import {
  mergeLandActionEvidence,
  resolveLandActionProcedures,
} from "./land_action_procedure_resolution.mjs";
import {
  observedRecommendationFromDisposition,
  projectAffectedReviewBodies,
} from "./land_affected_review_body.mjs";
import { mapMilestoneToPhase } from "./land_phase_spine.mjs";

export const LAND_AUTHORITY_SUMMARY_SCHEMA = "cityscroll.land_authority_summary.v1";
export const LAND_AUTHORITY_SUMMARY_RECEIPT_SCHEMA = "cityscroll.land_authority_summary_receipt.v1";
export const LAND_AUTHORITY_SUMMARY_JOIN_VERSION = "ldp05_authority_summary_v1";
export const LAND_AUTHORITY_SUMMARY_MAX_BYTES = 128 * 1024;

export const LAND_AUTHORITY_SUMMARY_SPECIMENS = Object.freeze({
  council: "2026Q0210",
  multi_cd_draft: "2025K0305",
  cpc_vs_observed: "2025M0252",
  mixed: "2024M0244",
  unknown_procedure: "2026K0123",
});

export const LAND_AUTHORITY_SUMMARY_STATUSES = Object.freeze({
  RESOLVED: "resolved",
  UNKNOWN: "unknown",
});

export const LAND_AUTHORITY_PUBLISHED_OPPORTUNITY_STATUSES = Object.freeze([
  "published",
  "none",
  "unknown",
  "stale",
]);

// A checked hearings artifact older than this relative to `asOf` cannot vouch
// for either a specific date or an authoritative absence — it reports
// `stale`, not `published`/`none`, so a vintage never silently mixes with a
// current-looking read.
export const LAND_AUTHORITY_PUBLISHED_OPPORTUNITY_MAX_AGE_DAYS = 30;

// Phases that sit between `pre_application` and the first review-body stage
// in the fixed LAND_ULURP_PHASES order but describe internal DCP prep work
// (environmental review, pre-certification notice, certification) rather
// than a review-body stage a reviewed profile ever models. A milestone that
// maps to one of these never advances "who has the ball" past the resolved
// profile's own certification stage.
const PRE_REVIEW_MILESTONE_PHASE_IDS = new Set(["environmental", "pre_certification", "certification"]);

const INSTITUTIONAL_ACTORS = Object.freeze({
  department_of_city_planning: "agency:id:city-planning",
  city_planning_commission: "agency:id:city-planning-commission",
  city_council: "agency:id:city-council",
  mayor: "agency:id:mayor",
});

const PROFILE_BY_ID = new Map(
  (LAND_PROCEDURE_PROFILE_REGISTRY.profiles || []).map((profile) => [profile.procedure_id, profile]),
);

const TIER_A_KEYS = Object.freeze([
  "schema",
  "layer",
  "status",
  "reason",
  "project_id",
  "procedure_id",
  "procedure_resolution",
  "current_stage",
  "current_actor_refs",
  "current_role",
  "effect",
  "source_basis",
  "expected_next_stage",
  "published_next_opportunity",
  "next_procedural_body",
  "affected_actor_refs",
  "observed",
  "freshness",
]);

function clean(value) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text || null;
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

const sourceBag = mergeLandActionEvidence;

function isoDate(value) {
  const text = clean(value);
  if (!text) return null;
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function daysBetweenIso(left, right) {
  const a = Date.parse(left);
  const b = Date.parse(right);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.abs(b - a) / 86400000;
}

/**
 * A checked source is stale only when both a checked vintage and an as-of
 * date are known and the gap exceeds the freshness contract. Missing either
 * date never fabricates staleness — that gap is `unknown`, a separate state.
 */
function opportunityIsStale(vintage, asOf) {
  const gap = daysBetweenIso(isoDate(vintage), isoDate(asOf));
  return gap != null && gap > LAND_AUTHORITY_PUBLISHED_OPPORTUNITY_MAX_AGE_DAYS;
}

/**
 * Clamp a raw milestone-mapped phase id to the resolved profile's own stage
 * vocabulary. A profile never models CEQR/pre-certification/certification as
 * review-body stages, so a milestone landing on one of those never advances
 * "who has the ball" past the profile's own certification stage. A phase
 * outside both the profile's vocabulary and this pre-review cluster (e.g. an
 * observed stage beyond what an unresolved-variant broad profile models) is
 * returned unchanged so the caller can report it honestly as unresolved
 * rather than guessing a plausible-looking but unearned stage.
 */
function clampMilestonePhaseToProfile(phaseId, profile) {
  if (!profile || !phaseId) return phaseId;
  const profilePhaseIds = new Set((profile.stages || []).map((stage) => stage.spine_phase_id));
  if (profilePhaseIds.has(phaseId)) return phaseId;
  if (PRE_REVIEW_MILESTONE_PHASE_IDS.has(phaseId) && profilePhaseIds.has("pre_application")) {
    return "pre_application";
  }
  return phaseId;
}

function compactStage(stage) {
  if (!stage?.stage_id) return null;
  return {
    stage_id: stage.stage_id,
    spine_phase_id: stage.spine_phase_id || null,
    status: "known",
  };
}

function unknownStage() {
  return { stage_id: null, spine_phase_id: null, status: "unknown" };
}

function currentProfileStage(profile, phaseId, facts) {
  if (!profile || !phaseId) return null;
  const matches = (profile.stages || []).filter((stage) => stage.spine_phase_id === phaseId);
  if (!matches.length) return null;
  const conditioned = matches.find((stage) => !stage.when || matchesLandProcedureCondition(stage.when, facts));
  if (conditioned) return conditioned;
  if (matches.length === 1) return matches[0];
  return matches.find((stage) => !stage.when) || null;
}

/**
 * A stage's normative successor is either a shared-origin parallel group
 * (e.g. Community Board / Borough President reviewed at the same time under
 * § 197-e) or a single sequential stage. The parallel group lives in the
 * profile's own `transitions[]`, not a stage's `conditional_successors` — a
 * parallel group is never collapsed into a single "next stage" pick, which
 * would invent an order the statute does not impose.
 */
function expectedSuccessor(profile, stage, facts) {
  const transitions = Array.isArray(profile.transitions) ? profile.transitions : [];
  const group = transitions.find((transition) =>
    transition.origin_stage_id === stage?.stage_id && matchesLandProcedureCondition(transition.when, facts));
  if (group) {
    const stageIds = [...(group.stage_ids || [])];
    const spinePhaseIds = stageIds.map((stageId) =>
      (profile.stages || []).find((candidate) => candidate.stage_id === stageId)?.spine_phase_id || null);
    return { kind: "parallel_group", group_id: group.group_id, stage_ids: stageIds, spine_phase_ids: spinePhaseIds };
  }
  const successors = Array.isArray(stage?.conditional_successors) ? stage.conditional_successors : [];
  const selected = successors.find((successor) => matchesLandProcedureCondition(successor.when, facts));
  if (!selected) return null;
  const next = (profile.stages || []).find((candidate) => candidate.stage_id === selected.to_stage_id);
  return next ? { kind: "sequential", stage_id: next.stage_id, spine_phase_id: next.spine_phase_id } : null;
}

function compactExpectedNext(next) {
  if (!next) return null;
  if (next.kind === "parallel_group") {
    return {
      stage_id: null,
      spine_phase_id: null,
      group_id: next.group_id,
      stage_ids: next.stage_ids,
      spine_phase_ids: next.spine_phase_ids,
      status: "known",
    };
  }
  return compactStage(next);
}

function institutionalActorRef(kind) {
  return INSTITUTIONAL_ACTORS[kind] || null;
}

function representingBodyRef(representing, extra = {}) {
  if (clean(extra.board_id)) return `community-board:${clean(extra.board_id)}`;
  const label = clean(representing)?.toLowerCase() || "";
  if (!label) return null;
  if (label === "city planning commission" || label === "cpc") return INSTITUTIONAL_ACTORS.city_planning_commission;
  if (label === "city council") return INSTITUTIONAL_ACTORS.city_council;
  if (label === "department of city planning" || label === "dcp") return INSTITUTIONAL_ACTORS.department_of_city_planning;
  if (label === "mayor" || label === "office of the mayor") return INSTITUTIONAL_ACTORS.mayor;
  if (label === "community board") return extra.body_ref || null;
  if (label === "borough president") return extra.borough_president_ref || extra.body_ref || null;
  if (label === "borough board") return extra.borough_board_ref || extra.body_ref || null;
  return null;
}

function currentActorRefs(stage, affected) {
  const kind = stage?.actor_selector?.kind;
  if (!kind) return [];
  if (kind === "affected_community_board") return [...(affected?.facts?.community_boards || [])];
  if (kind === "affected_borough_president") {
    return affected?.facts?.borough_presidents?.length
      ? [...affected.facts.borough_presidents]
      : affected?.facts?.borough_president
        ? [affected.facts.borough_president]
        : [];
  }
  if (kind === "affected_borough_board") return [...(affected?.facts?.borough_boards || [])];
  const institutional = institutionalActorRef(kind);
  return institutional ? [institutional] : [];
}

function compactAffected(affected) {
  if (affected?.status !== "resolved") return [];
  return (affected.edges || []).map((edge) => ({
    body_ref: edge.body_ref,
    role: edge.role,
  }));
}

function observedFromDispositions(dispositions = [], affected = null) {
  const rows = Array.isArray(dispositions) ? dispositions : [];
  if (!rows.length) {
    return { status: "no_observation", recommendations: [] };
  }
  const recommendations = [];
  let draftOnly = true;
  for (const disposition of rows) {
    const observed = observedRecommendationFromDisposition(disposition);
    if (!observed) continue;
    draftOnly = false;
    recommendations.push({
      body_ref: representingBodyRef(disposition.representing, {
        board_id: disposition.board_id,
        borough_president_ref: affected?.facts?.borough_president || (affected?.facts?.borough_presidents || [])[0] || null,
        borough_board_ref: (affected?.facts?.borough_boards || [])[0] || null,
      }),
      representing: clean(disposition.representing),
      value: observed.value,
      status: observed.status,
      vote_date: isoDate(disposition.vote_date),
      votes_for: disposition.votes_for ?? null,
      votes_against: disposition.votes_against ?? null,
      votes_abstain: disposition.votes_abstain ?? null,
      source_id: Array.isArray(disposition.source_ids) ? disposition.source_ids[0] || clean(disposition.id) : clean(disposition.id),
    });
  }
  if (recommendations.length) {
    return { status: "observed", recommendations };
  }
  if (rows.every((row) => /^draft$/i.test(clean(row.status) || ""))) {
    return { status: "draft_only", recommendations: [] };
  }
  return { status: "no_observation", recommendations: [] };
}

function hearingsList(publishedOpportunities) {
  if (Array.isArray(publishedOpportunities)) return publishedOpportunities;
  if (Array.isArray(publishedOpportunities?.hearings)) return publishedOpportunities.hearings;
  return null;
}

function publishedOpportunity(projectId, publishedOpportunities, asOf) {
  const hearings = hearingsList(publishedOpportunities);
  const vintage = isoDate(publishedOpportunities?.generated_at);
  if (!hearings) {
    return {
      status: "unknown",
      checked: false,
      checked_vintage: null,
      source_id: null,
      source: null,
      label: null,
      date: null,
      representing: null,
      phase_id: null,
      body_ref: null,
    };
  }
  const checkedVintage = vintage || isoDate(asOf);
  const stale = opportunityIsStale(vintage, asOf);
  const cutoff = isoDate(asOf) || null;
  const future = hearings
    .filter((row) => clean(row?.project_id) === projectId && isoDate(row?.hearing_date))
    .filter((row) => !cutoff || isoDate(row.hearing_date) >= cutoff)
    .sort((left, right) => String(isoDate(left.hearing_date)).localeCompare(String(isoDate(right.hearing_date))));
  const first = future[0];
  if (!first) {
    return {
      status: stale ? "stale" : "none",
      checked: true,
      checked_vintage: checkedVintage,
      source_id: null,
      source: "land_upcoming_hearings",
      label: null,
      date: null,
      representing: null,
      phase_id: null,
      body_ref: null,
    };
  }
  const sourceId = clean(first.milestone_id) || clean(first.source_id) || clean(first.id);
  const representing = clean(first.representing);
  return {
    status: stale ? "stale" : "published",
    checked: true,
    checked_vintage: checkedVintage,
    source_id: sourceId,
    source: clean(first.source) || clean(first.provenance?.source) || null,
    label: clean(first.milestone_title) || clean(first.milestone_source_title) || null,
    date: isoDate(first.hearing_date),
    representing,
    phase_id: clean(first.phase_id),
    body_ref: representingBodyRef(representing, first),
  };
}

function nextProceduralBody(published) {
  if (published?.status !== "published" || !published.body_ref || !published.source_id) return null;
  return {
    body_ref: published.body_ref,
    source_id: published.source_id,
    source: published.source,
  };
}

function freshnessEnvelope({ project, outcomes, publishedOpportunities, asOf, generatedAt }) {
  return {
    generated_at: generatedAt || asOf || null,
    as_of: asOf || null,
    source_vintages: {
      project_milestone_date: project?.current_milestone_date || null,
      outcomes_generated_at: outcomes?.generated_at || null,
      hearings_generated_at: publishedOpportunities?.generated_at || null,
    },
  };
}

function emptyPublishedUnknown() {
  return { status: "unknown" };
}

function unknownSummary({
  projectId,
  reason,
  procedureId = null,
  procedureResolution = null,
  currentStage = unknownStage(),
  sourceBasis,
  freshness,
  observed = { status: "no_observation", recommendations: [] },
  affected = [],
  published = emptyPublishedUnknown(),
}) {
  return {
    schema: LAND_AUTHORITY_SUMMARY_SCHEMA,
    layer: "tier_a",
    status: LAND_AUTHORITY_SUMMARY_STATUSES.UNKNOWN,
    reason,
    project_id: projectId,
    procedure_id: procedureId,
    procedure_resolution: procedureResolution,
    current_stage: currentStage,
    current_actor_refs: [],
    current_role: null,
    effect: null,
    source_basis: sourceBasis,
    expected_next_stage: null,
    published_next_opportunity: published,
    next_procedural_body: null,
    affected_actor_refs: affected,
    observed,
    freshness,
  };
}

/**
 * Project a bounded authority summary. Observed dispositions never replace
 * the current-stage actor. Profile successors never mint next_procedural_body.
 */
/**
 * Provenance that is the same on every summary.
 *
 * Each fact in a summary names the source that produced it. Those source names,
 * and the registry and boundary versions behind them, do not vary by project,
 * so repeating them on every summary spends the bounded payload on forty
 * identical copies. They are published once here and merged back by
 * resolveLandAuthoritySourceBasis, which is what every reader should use.
 */
/** The legal citation the reviewed registry records for one stage. */
function legalBasisForStage(stageId) {
  for (const profile of LAND_PROCEDURE_PROFILE_REGISTRY.profiles || []) {
    for (const stage of profile.stages || []) {
      if (stage.stage_id !== stageId) continue;
      const citation = (stage.legal_basis && stage.legal_basis[0])
        || (profile.legal_basis && profile.legal_basis[0])
        || null;
      if (citation) return citation;
    }
  }
  return null;
}

export const LAND_AUTHORITY_SOURCE_BASIS_DEFAULTS = Object.freeze({
  profile: Object.freeze({
    source_type: "reviewed_static_registry",
    registry_version: LAND_PROCEDURE_PROFILE_REGISTRY_VERSION,
    effect_source: "reviewed_static_registry",
  }),
  phase: Object.freeze({
    source_type: "publisher_current_milestone",
    source_field: "current_milestone",
  }),
  geography: Object.freeze({
    source_type: "affected_review_body_for",
    source_fields: Object.freeze(["community_district", "actions", "ulurp_numbers", "ulurp_non"]),
  }),
  publisher: Object.freeze({
    source_type: "published_hearing",
  }),
});

/**
 * One summary's provenance, with the shared defaults merged back in.
 *
 * `legalBasisByStage` carries the legal citation for each stage the payload
 * uses, so a citation is published once per stage rather than once per project.
 */
export function resolveLandAuthoritySourceBasis(summary, payload = null) {
  const basis = summary?.source_basis;
  if (!basis || typeof basis !== "object") return null;
  const defaults = payload?.source_basis_defaults || LAND_AUTHORITY_SOURCE_BASIS_DEFAULTS;
  const byStage = payload?.legal_basis_by_stage || {};
  const merge = (key) => (basis[key] ? { ...(defaults[key] || {}), ...basis[key] } : null);
  const profile = merge("profile");
  // A summary that carries its own citation keeps it. A bounded one resolves it
  // from the payload's per-stage table, and failing that from the reviewed
  // registry itself, so a summary read on its own is never short a citation.
  if (profile) {
    profile.legal_basis = basis.profile?.legal_basis
      || byStage[profile.stage_id]
      || legalBasisForStage(profile.stage_id)
      || null;
  }
  return {
    profile,
    phase: merge("phase"),
    geography: merge("geography"),
    publisher: merge("publisher"),
  };
}

export function buildLandAuthoritySummary(input = {}) {
  const project = sourceBag(input);
  const projectId = clean(project.project_id);
  const asOf = input.asOf || input.now || null;
  const generatedAt = input.generatedAt || asOf || null;
  const geography = input.geography || null;
  const outcomes = asObject(input.outcomes);
  const dispositions = Array.isArray(input.dispositions)
    ? input.dispositions
    : Array.isArray(outcomes.dispositions)
      ? outcomes.dispositions
      : [];
  const publishedOpportunities = input.publishedOpportunities;
  const stale = input.stale === true;
  const actionResolution = resolveLandActionProcedures(project);
  const procedureResolution = actionResolution.procedure_resolution;
  const resolvedActions = actionResolution.land_actions.filter((action) => action.status === "resolved");
  const procedureIds = [...new Set(resolvedActions.map((action) => action.procedure_id).filter(Boolean))];
  const procedureId = procedureIds.length === 1 ? procedureIds[0] : null;
  const profile = procedureId ? PROFILE_BY_ID.get(procedureId) : null;
  const affected = projectAffectedReviewBodies(project, { geography });
  const facts = {
    ...project,
    affected_review_bodies: affected?.facts || project.affected_review_bodies || {},
  };
  const milestone = clean(project.current_milestone);
  const milestonePhaseId = milestone ? mapMilestoneToPhase(milestone) : null;
  const phaseId = milestonePhaseId ? clampMilestonePhaseToProfile(milestonePhaseId, profile) : null;
  const observed = observedFromDispositions(dispositions, affected);
  const published = publishedOpportunity(projectId, publishedOpportunities, asOf);
  // Only what differs between projects is carried per project. The constant
  // half of the provenance — which source produced each fact, the registry and
  // boundary versions behind it, and the legal citation for a procedure — is
  // identical on all forty summaries, so it is stated once on the payload as
  // LAND_AUTHORITY_SOURCE_BASIS_DEFAULTS and read back through
  // resolveLandAuthoritySourceBasis. Nothing is dropped; it is said once
  // instead of forty times, which is what keeps the bounded payload bounded as
  // more projects resolve.
  const sourceBasis = {
    profile: profile ? { procedure_id: procedureId } : null,
    phase: milestone
      ? {
          current_milestone: milestone,
          phase_id: phaseId,
          milestone_phase_id: milestonePhaseId,
        }
      : null,
    geography: affected
      ? {
          status: affected.status,
          profile_version: affected.profile_version || null,
          boundary_vintage: affected.boundary_vintage || null,
        }
      : null,
    publisher: {
      source: published.source,
      source_id: published.source_id,
      checked: published.checked === true,
      checked_vintage: published.checked_vintage || null,
    },
  };
  const freshness = freshnessEnvelope({
    project,
    outcomes,
    publishedOpportunities,
    asOf,
    generatedAt,
  });
  const compactAffectedRefs = compactAffected(affected);

  if (stale) {
    return unknownSummary({
      projectId,
      reason: "stale_source",
      procedureId,
      procedureResolution,
      currentStage: phaseId ? { stage_id: null, spine_phase_id: phaseId, status: "unknown" } : unknownStage(),
      sourceBasis,
      freshness: { ...freshness, stale: true },
      observed,
      affected: compactAffectedRefs,
      published,
    });
  }

  if (procedureResolution === "mixed" || procedureResolution === "unknown" || !profile) {
    return unknownSummary({
      projectId,
      reason: procedureResolution === "mixed" ? "mixed_procedure" : "unresolved_procedure",
      procedureId,
      procedureResolution,
      currentStage: phaseId ? { stage_id: null, spine_phase_id: phaseId, status: "unknown" } : unknownStage(),
      sourceBasis,
      freshness,
      observed,
      affected: compactAffectedRefs,
      published,
    });
  }

  if (!milestone || !phaseId) {
    return unknownSummary({
      projectId,
      reason: "missing_current_stage",
      procedureId,
      procedureResolution,
      sourceBasis,
      freshness,
      observed,
      affected: compactAffectedRefs,
      published,
    });
  }

  const stage = currentProfileStage(profile, phaseId, facts);
  if (!stage) {
    return unknownSummary({
      projectId,
      reason: "unresolved_current_stage",
      procedureId,
      procedureResolution,
      currentStage: { stage_id: null, spine_phase_id: phaseId, status: "unknown" },
      sourceBasis,
      freshness,
      observed,
      affected: compactAffectedRefs,
      published,
    });
  }

  const next = expectedSuccessor(profile, stage, facts);
  const actors = currentActorRefs(stage, affected);
  return {
    schema: LAND_AUTHORITY_SUMMARY_SCHEMA,
    layer: "tier_a",
    status: LAND_AUTHORITY_SUMMARY_STATUSES.RESOLVED,
    reason: null,
    project_id: projectId,
    procedure_id: procedureId,
    procedure_resolution: procedureResolution,
    current_stage: compactStage(stage),
    current_actor_refs: actors,
    current_role: stage.role || null,
    effect: stage.effect || null,
    source_basis: {
      ...sourceBasis,
      profile: {
        ...sourceBasis.profile,
        stage_id: stage.stage_id,
        role: stage.role,
      },
    },
    expected_next_stage: compactExpectedNext(next),
    published_next_opportunity: published,
    next_procedural_body: nextProceduralBody(published),
    affected_actor_refs: compactAffectedRefs,
    observed,
    freshness,
  };
}

export function stampLandAuthoritySummary(row, opts = {}) {
  if (!row || typeof row !== "object") return row;
  row.authority_summary = buildLandAuthoritySummary({
    project: row,
    geography: opts.geography,
    outcomes: opts.outcomes,
    dispositions: opts.dispositions,
    publishedOpportunities: opts.publishedOpportunities,
    asOf: opts.asOf || opts.now,
    generatedAt: opts.generatedAt,
    stale: opts.stale,
  });
  return row;
}

function projectUniverse(landDefault) {
  const projects = Array.isArray(landDefault?.projects) ? landDefault.projects : [];
  const seen = new Set();
  const out = [];
  for (const project of projects) {
    const projectId = clean(project?.project_id);
    if (!projectId || seen.has(projectId)) continue;
    seen.add(projectId);
    out.push(project);
  }
  return out;
}

function hearingsByProject(publishedOpportunities) {
  const list = hearingsList(publishedOpportunities) || [];
  const byProject = new Map();
  for (const row of list) {
    const projectId = clean(row?.project_id);
    if (!projectId) continue;
    const bucket = byProject.get(projectId) || [];
    bucket.push(row);
    byProject.set(projectId, bucket);
  }
  return byProject;
}

function stripToTierA(summary) {
  const out = {};
  for (const key of TIER_A_KEYS) {
    if (Object.hasOwn(summary, key)) out[key] = summary[key];
  }
  return out;
}

export function materializeLandAuthoritySummaries(inputs = {}) {
  const landDefault = asObject(inputs.landDefault);
  const geography = inputs.geography || null;
  const publishedOpportunities = asObject(inputs.publishedOpportunities);
  const hashes = asObject(inputs.artifactHashes);
  const asOf = inputs.asOf || landDefault.generated_at || publishedOpportunities.generated_at || null;
  const generatedAt = inputs.generatedAt || asOf;
  const universe = projectUniverse(landDefault);
  const hearingsIndex = hearingsByProject(publishedOpportunities);
  const outcomesByProject = asObject(landDefault.outcomes?.by_project);
  const summaries = {};
  const outcomes = [];
  const counts = {
    universe: universe.length,
    resolved: 0,
    unknown: 0,
  };

  for (const project of universe) {
    const projectId = clean(project.project_id);
    const outcomeRecord = outcomesByProject[projectId] || {};
    const hearings = hearingsIndex.get(projectId) || [];
    const summary = stripToTierA(buildLandAuthoritySummary({
      project,
      geography,
      outcomes: {
        actions: outcomeRecord.actions,
        dispositions: outcomeRecord.dispositions,
        generated_at: outcomeRecord.generated_at || landDefault.generated_at,
      },
      publishedOpportunities: {
        hearings,
        generated_at: publishedOpportunities.generated_at,
      },
      asOf,
      generatedAt,
    }));
    summaries[projectId] = summary;
    const bucket = summary.status === LAND_AUTHORITY_SUMMARY_STATUSES.RESOLVED ? "resolved" : "unknown";
    counts[bucket] += 1;
    outcomes.push({
      project_id: projectId,
      status: summary.status,
      reason: summary.reason,
      procedure_resolution: summary.procedure_resolution,
      current_stage_id: summary.current_stage?.stage_id || null,
      observed_status: summary.observed?.status || null,
      published_next_status: summary.published_next_opportunity?.status || null,
    });
  }

  // The legal citation for a stage is the same wherever that stage appears, so
  // it is published once per stage rather than once per project.
  // A vintage that is the same on every summary is a property of the build, not
  // of a project, so it is hoisted into the defaults rather than repeated. One
  // that differs stays where it is.
  const hoistUniform = (group, key) => {
    const values = new Set(Object.values(summaries)
      .map((summary) => summary?.source_basis?.[group]?.[key])
      .filter((value) => value != null));
    if (values.size !== 1) return null;
    const [only] = values;
    for (const summary of Object.values(summaries)) {
      if (summary?.source_basis?.[group]) delete summary.source_basis[group][key];
    }
    return only;
  };
  const boundaryVintage = hoistUniform("geography", "boundary_vintage");
  const checkedVintage = hoistUniform("publisher", "checked_vintage");
  const sourceBasisDefaults = {
    ...LAND_AUTHORITY_SOURCE_BASIS_DEFAULTS,
    geography: {
      ...LAND_AUTHORITY_SOURCE_BASIS_DEFAULTS.geography,
      ...(boundaryVintage ? { boundary_vintage: boundaryVintage } : {}),
    },
    publisher: {
      ...LAND_AUTHORITY_SOURCE_BASIS_DEFAULTS.publisher,
      ...(checkedVintage ? { checked_vintage: checkedVintage } : {}),
    },
  };
  const legalBasisByStage = {};
  for (const stageId of new Set(Object.values(summaries)
    .map((summary) => summary?.source_basis?.profile?.stage_id)
    .filter(Boolean))) {
    const citation = legalBasisForStage(stageId);
    if (citation) legalBasisByStage[stageId] = citation;
  }
  const payload = {
    schema: LAND_AUTHORITY_SUMMARY_SCHEMA,
    join_version: LAND_AUTHORITY_SUMMARY_JOIN_VERSION,
    generated_at: generatedAt,
    source_basis_defaults: sourceBasisDefaults,
    legal_basis_by_stage: legalBasisByStage,
    summaries,
  };
  const receipt = {
    schema: LAND_AUTHORITY_SUMMARY_RECEIPT_SCHEMA,
    join_version: LAND_AUTHORITY_SUMMARY_JOIN_VERSION,
    generated_at: generatedAt,
    counts,
    resolved_project_ids: outcomes.filter((row) => row.status === "resolved").map((row) => row.project_id),
    unknown_project_ids: outcomes.filter((row) => row.status === "unknown").map((row) => row.project_id),
    outcomes,
    inputs: {
      land_default: {
        path: "site/data/land_default_ulurp.json",
        count: universe.length,
        vintage: { generated_at: landDefault.generated_at || null },
        sha256: hashes.land_default || null,
      },
      geography: {
        path: "site/data/community_board_geography_lookup.json",
        vintage: { boundary_vintage: geography?.boundary_vintage || null },
        sha256: hashes.geography || null,
      },
      upcoming_hearings: {
        path: "site/data/land_upcoming_hearings.json",
        count: (hearingsList(publishedOpportunities) || []).length,
        vintage: { generated_at: publishedOpportunities.generated_at || null },
        sha256: hashes.upcoming_hearings || null,
      },
      join_keys: ["project_id"],
    },
    generation: {
      derivation: "node tools/build_land_authority_summary.mjs",
    },
  };
  return { payload, receipt };
}

export function landAuthoritySummaryFindings(payload, receipt, opts = {}) {
  const findings = [];
  if (payload?.schema !== LAND_AUTHORITY_SUMMARY_SCHEMA) findings.push("payload schema");
  if (receipt?.schema !== LAND_AUTHORITY_SUMMARY_RECEIPT_SCHEMA) findings.push("receipt schema");
  const summaries = asObject(payload?.summaries);
  const ids = Object.keys(summaries);
  if (ids.length !== receipt?.counts?.universe) findings.push("universe count");
  if ((receipt?.counts?.resolved || 0) + (receipt?.counts?.unknown || 0) !== (receipt?.counts?.universe || 0)) {
    findings.push("status counts");
  }
  for (const id of ids) {
    const summary = summaries[id];
    for (const key of Object.keys(summary || {})) {
      if (!TIER_A_KEYS.includes(key)) findings.push(`${id} extra field ${key}`);
    }
    if (summary.next_procedural_body && summary.expected_next_stage) {
      const nextStageActors = summary.expected_next_stage.stage_id || "";
      if (
        summary.next_procedural_body.source_id
        && summary.next_procedural_body.source_id === nextStageActors
      ) {
        findings.push(`${id} next body copied from expected stage`);
      }
    }
    if (summary.next_procedural_body && !summary.published_next_opportunity?.source_id) {
      findings.push(`${id} next_procedural_body without published source`);
    }
  }
  const payloadBytes = opts.payloadBytes;
  if (Number.isFinite(payloadBytes) && payloadBytes > LAND_AUTHORITY_SUMMARY_MAX_BYTES) {
    findings.push("payload exceeds bounded Tier A budget");
  }
  return findings;
}

export function assertLandAuthoritySummaries(payload, receipt, opts = {}) {
  const findings = landAuthoritySummaryFindings(payload, receipt, opts);
  if (findings.length) throw new Error(`land authority summary: ${findings.join("; ")}`);
  return true;
}

export function actorHref(bodyRef) {
  const ref = clean(bodyRef);
  if (!ref) return null;
  const board = ref.match(/^community-board:(.+)$/);
  if (board) return communityBoardPageHref(board[1]);
  const agency = ref.match(/^agency:id:(.+)$/);
  if (agency) return `/agencies/${encodeURIComponent(agency[1])}/`;
  return null;
}


