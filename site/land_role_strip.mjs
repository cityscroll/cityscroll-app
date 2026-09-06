/**
 * Land phase-spine role strip (LDP-21).
 *
 * A profile-backed normative header for one ULURP phase panel — actor, role,
 * legal effect, statutory window, and profile citation — rendered as a
 * distinct sibling ABOVE that phase's unchanged observed event rows. Reads
 * `view.procedure_profile` and `view.affected_review_bodies`, both already
 * computed by land_phase_spine.mjs; never inspects or mutates observed
 * events, aggregates, or chronological rows.
 *
 * Absorbed from a retired timeline role-strips record. Historical:
 * unlike the current-stage-only "Where this stands" panel
 * (land_authority_summary_view.mjs), this renders a strip for every
 * profile-backed stage — passed, current, and future — that the resolved
 * procedure models.
 */
import { matchesLandProcedureCondition } from "./land_procedure_profiles.mjs";
import { actorLabel } from "./land_authority_summary_view.mjs";

export const LAND_PHASE_ROLE_STRIP_SCHEMA = "cityscroll.land_phase_role_strip.v1";

const INSTITUTIONAL_ACTORS = Object.freeze({
  department_of_city_planning: "agency:id:city-planning",
  city_planning_commission: "agency:id:city-planning-commission",
  city_council: "agency:id:city-council",
  mayor: "agency:id:mayor",
});

/** Kinds whose day count is derived from a start event, not an observed date. */
const CALCULATED_WINDOW_KINDS = new Set(["statutory_days", "statutory_days_after_review"]);

function actorRefsForSelector(actorSelector, affected) {
  const kind = actorSelector?.kind;
  if (!kind) return [];
  if (kind === "affected_community_board") return [...(affected?.community_boards || [])];
  if (kind === "affected_borough_president") {
    return affected?.borough_presidents?.length
      ? [...affected.borough_presidents]
      : affected?.borough_president
        ? [affected.borough_president]
        : [];
  }
  if (kind === "affected_borough_board") return [...(affected?.borough_boards || [])];
  const institutional = INSTITUTIONAL_ACTORS[kind];
  return institutional ? [institutional] : [];
}

/**
 * Pick the profile-backed stage definition for one spine phase id — the
 * normative sibling of that phase's observed row. Reads only
 * `view.procedure_profile` / `view.affected_review_bodies`; never reads
 * `view.phases`, `view.chronological`, or any event. A phase the resolved
 * profile does not model (an unresolved procedure, or a phase outside the
 * profile's own stage vocabulary) returns null rather than inventing one —
 * the negative rule this card carries from LDP-09.
 */
export function buildLandPhaseRoleStrip(view, phaseId) {
  const profile = view?.procedure_profile;
  if (!profile || profile.status !== "resolved" || !Array.isArray(profile.stages)) return null;
  const candidates = profile.stages.filter((stage) => stage.spine_phase_id === phaseId);
  if (!candidates.length) return null;
  const affected = view.affected_review_bodies || {};
  const facts = { affected_review_bodies: affected };
  const stage = candidates.find((s) => !s.when || matchesLandProcedureCondition(s.when, facts))
    || candidates.find((s) => !s.when)
    || candidates[0];
  const timeWindow = stage.time_window || null;
  const legalBasis = Array.isArray(stage.legal_basis) && stage.legal_basis.length ? stage.legal_basis[0] : null;
  return {
    schema: LAND_PHASE_ROLE_STRIP_SCHEMA,
    layer: "normative",
    phase_id: phaseId,
    stage_id: stage.stage_id,
    profile_id: stage.profile_id || profile.profile_id,
    registry_version: stage.registry_version || profile.registry_version,
    role: stage.role || null,
    effect: stage.effect || null,
    actor_refs: actorRefsForSelector(stage.actor_selector, affected),
    time_window: timeWindow
      ? { ...timeWindow, calculated: CALCULATED_WINDOW_KINDS.has(timeWindow.kind) }
      : null,
    legal_basis: legalBasis,
  };
}

function esc(escape, value) {
  return typeof escape === "function" ? escape(value) : String(value ?? "");
}

function sourceLink(href, label, escape) {
  if (!href || !label) return esc(escape, label || "");
  return `<a href="${esc(escape, href)}" rel="noopener noreferrer" target="_blank">${esc(escape, label)}</a>`;
}

function windowHTML(timeWindow, translate) {
  if (!timeWindow) return "";
  if (timeWindow.calculated) {
    const days = String(timeWindow.days ?? "—");
    const text = timeWindow.alternate_days_with_eis != null
      ? translate("land_role_strip_window_days_alt_eis_html", { days, alt: String(timeWindow.alternate_days_with_eis) })
      : translate("land_role_strip_window_days_html", { days });
    return `<div class="land-role-strip-window" data-land-role-strip-window="calculated">${text}</div>`;
  }
  if (timeWindow.kind === "rules_defined") {
    return `<div class="land-role-strip-window" data-land-role-strip-window="rules_defined">${translate("land_role_strip_window_rules_defined")}</div>`;
  }
  return "";
}

/**
 * Render one phase's role strip as a sibling block, marked
 * `data-land-authority-kind="role_definition"` so it is mechanically distinct
 * from that phase's observed rows (which carry no such marker). Adds no
 * recommendation, vote, hearing, or decision row — role and legal effect are
 * profile text, never an observed outcome.
 */
export function landPhaseRoleStripHTML(strip, { t, escape } = {}) {
  if (!strip) return "";
  const translate = typeof t === "function" ? t : (key) => key;
  const unknown = translate("land_authority_unknown");
  const roleKey = strip.role ? `land_authority_role_here_${strip.role}` : null;
  const roleLabel = roleKey ? translate(roleKey) : null;
  const roleText = roleLabel && roleLabel !== roleKey ? roleLabel : (strip.role || unknown);
  const actorText = (strip.actor_refs || []).length
    ? strip.actor_refs.map((ref) => esc(escape, actorLabel(ref, translate))).join(", ")
    : esc(escape, unknown);
  const roleLine = translate("land_role_strip_role", { actor: actorText, role: esc(escape, roleText) });
  const effectHTML = strip.effect
    ? `<div class="land-role-strip-effect" lang="en" dir="ltr">${esc(escape, strip.effect)}</div>`
    : "";
  const citationHTML = strip.legal_basis?.citation
    ? `<div class="land-role-strip-citation">${esc(escape, translate("land_authority_provenance_profile"))}: ${sourceLink(strip.legal_basis.source_url, strip.legal_basis.citation, escape)}</div>`
    : "";
  return `<div class="land-role-strip" data-land-role-strip="1" data-land-authority-kind="role_definition" data-land-authority-provenance="profile" data-stage-id="${esc(escape, strip.stage_id || "")}" data-profile-id="${esc(escape, strip.profile_id || "")}" data-registry-version="${esc(escape, strip.registry_version || "")}">
    <div class="land-role-strip-kicker">${esc(escape, translate("land_role_strip_kicker"))}</div>
    <p class="land-role-strip-line">${roleLine}</p>
    ${effectHTML}
    ${windowHTML(strip.time_window, translate)}
    ${citationHTML}
  </div>`;
}

/** Single-call phase-panel entry point: builds then renders in one step. */
export function landRoleStrip(view, phaseId, opts) {
  return landPhaseRoleStripHTML(buildLandPhaseRoleStrip(view, phaseId), opts);
}
