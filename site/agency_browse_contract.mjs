/**
 * Shared agency → Browse contract.
 *
 * Agency category previews and their Browse destinations must use the same
 * typed entity facet, relation, source universe, and snapshot date. The
 * preview is intentionally bounded; the Browse view owns the uncapped total.
 */

import { BROWSE_FACETS, buildBrowseView } from "./browse_view.mjs";

export const AGENCY_BROWSE_PREVIEW_LIMIT = 8;

function clean(value, max = 240) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function day(value) {
  const match = clean(value, 40).match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : "";
}

function agencyId(identity) {
  return clean(identity?.canonical_id || identity, 120);
}

/** Build the exact query carried by an agency category's Browse action. */
export function agencyBrowseSearchParams(identity, relation, { mode = "", asOf = "" } = {}) {
  const id = agencyId(identity);
  const values = { entity_refs_all: [`agency:id:${id}`] };
  if (relation) values.connection_relation = clean(relation, 80);
  const params = new URLSearchParams({ facet: JSON.stringify(values) });
  if (mode) params.set("mode", clean(mode, 40));
  if (day(asOf)) params.set("as_of", day(asOf));
  return params;
}

/** Run the same bounded Browse query used by the edge document. */
export function buildAgencyBrowseContract({
  facet,
  identity,
  payload,
  relation,
  mode = "",
  limit = AGENCY_BROWSE_PREVIEW_LIMIT,
} = {}) {
  if (!BROWSE_FACETS[facet] || !payload || typeof payload !== "object") return null;
  const search = agencyBrowseSearchParams(identity, relation, { mode, asOf: payload.open_as_of || payload.retrieved_at });
  const view = buildBrowseView(facet, payload, search, { limit });
  return { ...view, search, relation: clean(relation, 80), mode: clean(mode, 40) || null };
}

/** Convert a Browse row into the agency document's existing edge-object shape. */
export function agencyBrowseRowObject(row, { facet, relation, sourceSystem = "city_record" } = {}) {
  const requestId = clean(row?.request_id || row?.id, 80);
  if (!requestId) return null;
  const type = clean(row?.type_of_notice_description, 80).toLowerCase();
  const objectKind = facet === "meetings"
    ? (type.includes("hearing") ? "hearing" : "meeting")
    : (type.includes("award") ? "award" : "solicitation");
  const when = clean(row?.event_date || row?.start_date || row?.date, 40) || null;
  return {
    subject_ref: `notice:${requestId}`,
    request_id: requestId,
    object_kind: objectKind,
    label: clean(row?.short_title || row?.title || requestId, 240),
    when,
    href: `/notices/${encodeURIComponent(requestId)}`,
    link_type: relation,
    confidence: "strong",
    method: "agency_browse_snapshot_v1",
    provenance: {
      source_system: clean(row?.source_system || sourceSystem, 120) || "city_record",
      source_record_id: `${clean(row?.source_system || sourceSystem, 120) || "city_record"}:${requestId}`,
      source_fields: ["agency_name"],
      basis: `${facet}_agency_name_browse_snapshot`,
      observed_at: when,
      input_value: clean(row?.agency_name, 240) || null,
    },
  };
}
