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

function clean(value) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text || null;
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
    return Object.freeze({ ...base, state: LAND_MAP_AUTHORITY_STATES.UNAVAILABLE, reason: "missing_projection" });
  }
  const stale = summary.reason === "stale_source" || summary.freshness?.stale === true;
  const state = stale
    ? LAND_MAP_AUTHORITY_STATES.UNAVAILABLE
    : summary.status === "resolved"
      ? LAND_MAP_AUTHORITY_STATES.AVAILABLE
      : LAND_MAP_AUTHORITY_STATES.PARTIAL;
  return Object.freeze({
    ...base,
    state,
    reason: stale ? "stale_source" : (summary.reason || null),
    source_receipt: summary.join_version || LAND_MAP_AUTHORITY_PROJECTION_VERSION,
    source_vintage: summary.freshness?.generated_at || summary.freshness?.as_of || null,
    procedure_id: summary.procedure_id || null,
    procedure_resolution: summary.procedure_resolution || null,
    stage: summary.current_stage || null,
    observed: summary.observed || null,
    normative: {
      current_actor_refs: Array.isArray(summary.current_actor_refs) ? summary.current_actor_refs : [],
      current_role: summary.current_role || null,
      effect: summary.effect || null,
    },
    authority_evidence: summary.source_basis?.profile || null,
    observed_evidence: summary.source_basis?.phase || null,
  });
}
