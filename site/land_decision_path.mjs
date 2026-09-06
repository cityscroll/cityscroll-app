/**
 * Shared Land decision-path view model.
 *
 * The observed spine and the reviewed procedure profile are separate layers.
 * This module is the narrow waist shared by the resident detail view, the map
 * handoff, and the public capability provider; it does not fetch a publisher.
 */

import { resolveLandAuthoritySourceBasis } from "./land_authority_summary.mjs";
import {
  LAND_ULURP_PHASES,
  buildLandPhaseView,
  mapMilestoneToPhase,
} from "./land_phase_spine.mjs";
import { buildLandAuthoritySummary } from "./land_authority_summary.mjs";
import {
  mergeLandActionEvidence,
  resolveLandActionProcedures,
} from "./land_action_procedure_resolution.mjs";
import {
  buildLandProcedureProfileView,
  resolveLandProcedureVariant,
} from "./land_procedure_profiles.mjs";

export const LAND_DECISION_PATH_VIEW_SCHEMA = "cityscroll.land_decision_path_view.v1";

function clean(value) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text || null;
}

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function publicEffect(value) {
  const text = clean(value);
  if (!text) return null;
  return text
    .replace(/;\s*this expedited path is not filed for ordinary Council review\.?/gi, ".")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function phaseOfEvent(event) {
  return mapMilestoneToPhase(event?.title, {
    kind: event?.kind,
    representing: event?.detail,
    detail: event?.detail,
  });
}

function observedEvents(phaseView) {
  return (phaseView?.chronological || []).map((event) => ({
    ...clone(event),
    layer: "observed",
    phase_id: phaseOfEvent(event),
  }));
}

function unknownStage(phaseId = null) {
  return {
    layer: "normative",
    status: "unknown",
    stage_id: null,
    phase_id: phaseId,
    role: null,
    effect: null,
  };
}

function normativeStages(profile) {
  if (!profile || profile.status !== "resolved") {
    return LAND_ULURP_PHASES.map((phaseId) => unknownStage(phaseId));
  }

  const present = profile.stages.map((stage) => ({
    ...clone(stage),
    layer: "normative",
    phase_id: stage.spine_phase_id || null,
    status: "present",
    effect: publicEffect(stage.effect),
  }));
  const presentPhases = new Set(present.map((stage) => stage.phase_id).filter(Boolean));
  const absent = LAND_ULURP_PHASES
    .filter((phaseId) => !presentPhases.has(phaseId))
    .map((phaseId) => ({
      layer: "normative",
      status: "absent",
      stage_id: null,
      phase_id: phaseId,
      role: null,
      effect: null,
    }));
  return [...present, ...absent];
}

function parallelReviewGroups(profile) {
  if (!profile || profile.status !== "resolved") return [];
  return (profile.transitions || [])
    .filter((transition) => transition.kind === "parallel_group")
    .map((transition) => ({
      group_id: transition.group_id,
      layer: "normative",
      stages: (transition.stages || []).map((stage) => ({
        stage_id: stage.stage_id,
        phase_id: stage.spine_phase_id || null,
        role: stage.role || null,
        effect: publicEffect(stage.effect),
        status: "present",
        layer: "normative",
      })),
      join_to_stage_id: transition.join_to_stage_id || null,
      evidence: clone(transition.legal_basis || []),
    }));
}

function currentActors(authority, currentStage) {
  const role = currentStage?.role || authority?.current_role || null;
  const effect = currentStage?.effect || authority?.effect || null;
  const refs = Array.isArray(authority?.current_actor_refs) ? authority.current_actor_refs : [];
  if (refs.length) {
    return refs.map((actor_ref) => ({
      layer: "normative",
      status: "known",
      actor_ref,
      role,
      effect: publicEffect(effect),
    }));
  }
  if (!role && !effect) return [];
  return [{
    layer: "normative",
    status: "unknown",
    actor_ref: null,
    role,
    effect: publicEffect(effect),
  }];
}

function expectedNextTransition(profile) {
  if (profile?.status !== "resolved") {
    return { layer: "normative", status: "unknown", kind: null, stages: [], join_to_stage_id: null };
  }
  if (!profile.expected_next_transition) return null;
  return {
    ...clone(profile.expected_next_transition),
    layer: "normative",
    status: "known",
    stages: (profile.expected_next_transition.stages || []).map((stage) => ({
      stage_id: stage.stage_id,
      phase_id: stage.spine_phase_id || null,
      role: stage.role || null,
      effect: publicEffect(stage.effect),
      status: "present",
      layer: "normative",
    })),
  };
}

function evidenceReferences(record, phaseView, authority) {
  const refs = [];
  const projectId = clean(record?.project_id || record?.open_data?.project_id);
  if (projectId) refs.push({ kind: "project", source_id: `zap-projects-open-data:${projectId}`, layer: "observed" });
  if (record?.generated_at) refs.push({ kind: "outcomes", source_id: `zap-api-outcomes:${projectId}`, observed_at: record.generated_at, layer: "observed" });
  const profile = phaseView?.procedure_profile;
  if (profile?.provenance) refs.push({ kind: "procedure_profile", ...clone(profile.provenance), layer: "normative" });
  const authorityBasis = resolveLandAuthoritySourceBasis(authority);
  if (authorityBasis?.phase) refs.push({ kind: "current_milestone", ...clone(authorityBasis.phase), layer: "observed" });
  if (authorityBasis?.profile) refs.push({ kind: "authority_profile", ...clone(authorityBasis.profile), layer: "normative" });
  return refs;
}

/** Build the canonical observed/normative decision-path view for one record. */
export function buildLandDecisionPathView(record = {}, options = {}) {
  const openData = record?.open_data && typeof record.open_data === "object"
    ? record.open_data
    : record;
  const exactActions = record?.actions || record?.zap_actions || null;
  const facts = mergeLandActionEvidence({ ...record, open_data: openData, actions: exactActions });
  const actionResolution = resolveLandActionProcedures(facts);
  const spine = record?.spine && typeof record.spine === "object"
    ? record.spine
    : { project_id: facts.project_id || null, events: [] };
  const phaseView = buildLandPhaseView(spine, {
    open_data: openData,
    portal_url: record?.portal_url || null,
    public_status: openData?.public_status || record?.public_status || null,
    project_id: facts.project_id || spine.project_id || null,
    actions: exactActions,
    variant_evidence: options.variantEvidence || record?.variant_evidence || null,
    procedure_facts: options.procedure_facts || record?.procedure_facts || {},
    geography: options.geography || record?.geography || null,
    dispositions: options.dispositions || record?.dispositions || null,
    observed_outcomes: options.observed_outcomes || record?.observed_outcomes || null,
  });
  const authority = buildLandAuthoritySummary({
    project: facts,
    geography: options.geography || record?.geography || null,
    outcomes: record?.outcomes || { dispositions: options.dispositions || record?.dispositions || [] },
    dispositions: options.dispositions || record?.dispositions || null,
    publishedOpportunities: options.publishedOpportunities || record?.publishedOpportunities,
    asOf: options.asOf || record?.generated_at || null,
    generatedAt: options.generatedAt || record?.generated_at || null,
  });
  const profile = phaseView.procedure_profile;
  const variant = resolveLandProcedureVariant({
    broad_profile_id: profile?.broad_profile_id || profile?.profile_id || actionResolution.land_actions.find((action) => action.procedure_id)?.procedure_id || null,
    evidence: options.variantEvidence || record?.variant_evidence || null,
  });
  const selectedProfileId = variant.status === "resolved" ? variant.variant_id : profile?.profile_id;
  // The detail's authority panel clamps pre-review milestones to the profile's
  // certification stage. Re-anchor the normative view to that same stage while
  // retaining the phase spine as the observed layer.
  const normativeProfile = profile?.status === "resolved"
    ? buildLandProcedureProfileView({
        source: facts,
        profile: { procedure_id: selectedProfileId },
        current_stage_id: authority.status === "resolved" ? authority.current_stage?.stage_id || null : null,
        current_phase_id: phaseView.current?.phase_id || null,
      })
    : profile;
  const currentStage = normativeProfile?.current_stage
    ? {
        ...clone(normativeProfile.current_stage),
        layer: "normative",
        phase_id: normativeProfile.current_stage.spine_phase_id || null,
        status: "known",
        effect: publicEffect(normativeProfile.current_stage.effect),
      }
    : unknownStage(phaseView.current?.phase_id || null);
  const observed = {
    current_phase: {
      layer: "observed",
      status: phaseView.current?.phase_id ? "known" : "unknown",
      phase_id: phaseView.current?.phase_id || null,
      milestone: phaseView.current?.milestone_label || null,
      since: phaseView.current?.since || null,
      derivation: phaseView.current?.derivation || null,
    },
    events: observedEvents(phaseView),
    gaps: clone(phaseView.gaps || []),
  };
  const normative = {
    current_stage: currentStage,
    current_actors: currentActors(authority, currentStage),
    expected_next_transition: expectedNextTransition(normativeProfile),
    parallel_review_groups: parallelReviewGroups(normativeProfile),
    stages: normativeStages(normativeProfile),
  };
  return {
    schema: LAND_DECISION_PATH_VIEW_SCHEMA,
    project_id: clean(facts.project_id || spine.project_id),
    procedure: {
      resolution: actionResolution.procedure_resolution,
      profile_id: normativeProfile?.profile_id || null,
      broad_profile_id: variant.status === "resolved" ? variant.broad_profile_id : (profile?.broad_profile_id || null),
      variant_status: variant.status,
      variant_id: variant.variant_id || null,
      actions: clone(actionResolution.land_actions),
    },
    observed,
    normative,
    // Explicit field names keep the typed capability self-describing for
    // clients that do not consume the grouped layer projection. They are
    // aliases of the same observed/normative values, never a second resolver.
    observed_current_phase: observed.current_phase,
    observed_events: observed.events,
    normative_current_stage: normative.current_stage,
    current_actors: normative.current_actors,
    expected_next_transition: normative.expected_next_transition,
    parallel_review_groups: normative.parallel_review_groups,
    normative_stages: normative.stages,
    evidence: evidenceReferences(record, phaseView, authority),
    _resident: {
      phase_view: phaseView,
      authority_summary: authority,
    },
  };
}

export function publicLandDecisionPathView(view) {
  if (!view || typeof view !== "object") return null;
  const { _resident, ...publicView } = view;
  return publicView;
}
