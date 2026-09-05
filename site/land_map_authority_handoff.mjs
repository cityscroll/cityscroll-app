/**
 * Map-to-Land-decision-path bounded-context adapter.
 *
 * Map supplies only the canonical project id. The authority projection supplies
 * every civic meaning shown here; this module never resolves procedure, stage,
 * actor, outcome, or geography.
 */

export const LAND_MAP_AUTHORITY_HANDOFF_SCHEMA = "cityscroll.land_map_authority_handoff.v1";
export const LAND_MAP_AUTHORITY_PROJECTION_SCHEMA = "cityscroll.land_authority_summary.v1";
export const LAND_MAP_AUTHORITY_PROJECTION_VERSION = "ldp05_authority_summary_v1";

export const LAND_MAP_AUTHORITY_STATES = Object.freeze({
  AVAILABLE: "available",
  PARTIAL: "partial",
  UNAVAILABLE: "unavailable",
});

// The typed procedure state a resident actually needs distinguished. `state` above answers
// "is there enough to show a compact fact block at all"; `procedure_state` answers "what kind
// of evidence gap is this" so a mixed procedure, an unresolved one, and a stale source never
// collapse into the same generic "unavailable" reading.
export const LAND_MAP_PROCEDURE_STATES = Object.freeze({
  KNOWN: "known",
  MIXED: "mixed",
  UNKNOWN: "unknown",
  STALE: "stale",
  MISSING: "missing",
});

// The next-action affordance is typed the same way as `published_next_opportunity.status` in
// the LDP-08 projection, plus `missing` for a summary that supplies no opportunity field at
// all. A status other than `published` never renders a date or a body: the handoff states only
// that no next action is published, distinguishing why in data without promising one in copy.
export const LAND_MAP_NEXT_ACTION_STATES = Object.freeze({
  PUBLISHED: "published",
  NONE: "none",
  UNKNOWN: "unknown",
  STALE: "stale",
  MISSING: "missing",
});

function clean(value) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text || null;
}

function nextActionFrom(published, { stale, missing }) {
  if (missing) return Object.freeze({ status: LAND_MAP_NEXT_ACTION_STATES.MISSING, date: null, label: null, source_id: null, checked_vintage: null });
  if (stale) {
    return Object.freeze({
      status: LAND_MAP_NEXT_ACTION_STATES.STALE, date: null, label: null, source_id: null,
      checked_vintage: published?.checked_vintage || null,
    });
  }
  if (published == null) return Object.freeze({ status: LAND_MAP_NEXT_ACTION_STATES.MISSING, date: null, label: null, source_id: null, checked_vintage: null });
  const status = published.status || LAND_MAP_NEXT_ACTION_STATES.UNKNOWN;
  const published_ok = status === LAND_MAP_NEXT_ACTION_STATES.PUBLISHED;
  return Object.freeze({
    status,
    date: published_ok ? (published.date || null) : null,
    label: published_ok ? (published.label || published.representing || null) : null,
    source_id: published_ok ? (published.source_id || null) : null,
    checked_vintage: published.checked_vintage || null,
  });
}

/** Join exactly one row to its already materialized LDP projection. */
export function landMapAuthorityHandoff({ projectId, row = null, panelHref = null } = {}) {
  const id = clean(projectId);
  const summary = row?.authority_summary;
  const base = {
    schema: LAND_MAP_AUTHORITY_HANDOFF_SCHEMA,
    project_id: id,
    projection_schema: LAND_MAP_AUTHORITY_PROJECTION_SCHEMA,
    projection_version: LAND_MAP_AUTHORITY_PROJECTION_VERSION,
    panel_href: panelHref || null,
    location_state: "mapped",
  };
  if (!id || !summary || clean(summary.project_id) !== id
    || summary.schema !== LAND_MAP_AUTHORITY_PROJECTION_SCHEMA) {
    return Object.freeze({
      ...base,
      state: LAND_MAP_AUTHORITY_STATES.UNAVAILABLE,
      reason: "missing_projection",
      procedure_state: LAND_MAP_PROCEDURE_STATES.MISSING,
      next_action: nextActionFrom(null, { stale: false, missing: true }),
    });
  }
  const stale = summary.reason === "stale_source" || summary.freshness?.stale === true;
  const state = stale
    ? LAND_MAP_AUTHORITY_STATES.UNAVAILABLE
    : summary.status === "resolved"
      ? LAND_MAP_AUTHORITY_STATES.AVAILABLE
      : LAND_MAP_AUTHORITY_STATES.PARTIAL;
  const procedureState = stale
    ? LAND_MAP_PROCEDURE_STATES.STALE
    : summary.procedure_resolution === "mixed"
      ? LAND_MAP_PROCEDURE_STATES.MIXED
      : summary.status === "resolved"
        ? LAND_MAP_PROCEDURE_STATES.KNOWN
        : LAND_MAP_PROCEDURE_STATES.UNKNOWN;
  return Object.freeze({
    ...base,
    state,
    reason: stale ? "stale_source" : (summary.reason || null),
    source_receipt: summary.join_version || LAND_MAP_AUTHORITY_PROJECTION_VERSION,
    source_vintage: summary.freshness?.generated_at || summary.freshness?.as_of || null,
    procedure_id: summary.procedure_id || null,
    procedure_resolution: summary.procedure_resolution || null,
    procedure_state: procedureState,
    stage: summary.current_stage || null,
    observed: summary.observed || null,
    normative: {
      current_actor_refs: Array.isArray(summary.current_actor_refs) ? summary.current_actor_refs : [],
      current_role: summary.current_role || null,
      effect: summary.effect || null,
    },
    next_action: nextActionFrom(summary.published_next_opportunity ?? null, { stale, missing: false }),
    authority_evidence: summary.source_basis?.profile || null,
    observed_evidence: summary.source_basis?.phase || null,
  });
}
