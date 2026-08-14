/** Deferred, exact-join links for the land detail record's agency and place facts. */

import { resolveAgencyIdentity } from "./agency_identity.mjs";
import { constellationLink } from "./affordance_grammar.mjs";
import { boroughMapPivotHref, normalizeBoroughScope } from "./borough_scope_links.mjs";
import { districtMapPivotHref } from "./district_scope_facets.mjs";
import { entityChipHTML } from "./entity_pivot.mjs";

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const escapeHtml = (value) => clean(value).replace(/[<>&"']/g, (char) => ({
  "<": "&lt;",
  ">": "&gt;",
  "&": "&amp;",
  '"': "&quot;",
  "'": "&#39;",
}[char]));
let placeRegistryPromise = null;

/** Load the committed boundary IDs after the record's first paint. */
export function loadLandRecordPlaceRegistry(fetchImpl = globalThis.fetch) {
  if (!placeRegistryPromise) {
    placeRegistryPromise = Promise.resolve(typeof fetchImpl === "function"
      ? fetchImpl(new URL("./data/district_boundaries.json", import.meta.url))
      : null)
      .then((response) => response?.ok ? response.json() : null)
      .then((document) => ({
        community: new Set((document?.community_districts || []).map((item) => clean(item?.id).toUpperCase()).filter(Boolean)),
        council: new Set((document?.council_districts || []).map((item) => clean(item?.id)).filter(Boolean)),
      }))
      .catch(() => ({ community: new Set(), council: new Set() }));
  }
  return placeRegistryPromise;
}

function councilDistrictLabel(value, labelFor) {
  return typeof labelFor === "function" ? labelFor(value) : `Council District ${value}`;
}

/** Return a profile link only for a reviewed agency identity with a public route. */
export function landRecordApplicantHTML(value, { escape = escapeHtml } = {}) {
  const label = clean(value);
  if (!label) return "";
  const identity = resolveAgencyIdentity(label);
  if (!identity?.matched || !identity.canonical_id) return escape(label);
  return entityChipHTML({
    ref: `agency:id:${identity.canonical_id}`,
    label,
    link_confidence: "strong",
    relation: "applicant agency",
  }, { surface: "land" }) || escape(label);
}

/** Return a place pivot only when the shared scope helper resolves the identifier. */
export function landRecordPlaceHTML(kind, value, {
  borough = "",
  labelForCouncilDistrict,
  knownCommunityDistricts = null,
  knownCouncilDistricts = null,
  escape = escapeHtml,
} = {}) {
  const raw = clean(value);
  if (!raw) return "";
  let href = null;
  let label = raw;
  if (kind === "borough") {
    if (normalizeBoroughScope(raw)) href = boroughMapPivotHref("land", raw, "#land");
  } else if (kind === "community") {
    const id = clean(raw).toUpperCase();
    if (knownCommunityDistricts?.has(id)) href = districtMapPivotHref({ kind: "community_district", id, lens: "land" });
    label = `CD ${id}`;
  } else if (kind === "council") {
    if (knownCouncilDistricts?.has(raw)) href = districtMapPivotHref({ kind: "council_district", id: raw, lens: "land" });
    label = councilDistrictLabel(raw, labelForCouncilDistrict);
  }
  if (!href) return escape(label);
  return constellationLink({
    href,
    label,
    className: "land-record-place-link",
    attributes: {
      "data-place-kind": kind,
      "data-place-id": raw,
      "data-scope-edge": `land.${kind}.${raw}`,
      ...(borough ? { "data-place-borough": borough } : {}),
    },
    escape,
  });
}
