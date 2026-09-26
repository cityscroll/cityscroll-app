/** Deferred, exact-join links for the land detail record's agency and place facts. */

import { resolveAgencyIdentity } from "./agency_identity.mjs";
import { constellationLink } from "./affordance_grammar.mjs";
import {
  NYCEDC_CANONICAL_ID,
  isNycEdcApplicantSpelling,
} from "./civic_institution_development_specimens.mjs";
import { boroughMapPivotHref, normalizeBoroughScope } from "./borough_scope_links.mjs";
import { districtMapPivotHref } from "./district_scope_facets.mjs";
import { entityChipHTML } from "./entity_pivot.mjs";
import { paintLandDetailPlaceLinks } from "./land_detail_place_links.mjs";

export { paintLandDetailPlaceLinks } from "./land_detail_place_links.mjs";

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
  if (isNycEdcApplicantSpelling(label)) {
    return constellationLink({
      href: `/agencies/${NYCEDC_CANONICAL_ID}/`,
      label,
      className: "land-record-applicant-link",
      attributes: {
        "data-link-confidence": "strong",
        "data-role-relation": "has_applicant",
        "data-applicant-id": NYCEDC_CANONICAL_ID,
      },
      escape,
    }) || escape(label);
  }
  const identity = resolveAgencyIdentity(label);
  if (!identity?.matched || !identity.canonical_id) return escape(label);
  return entityChipHTML({
    ref: `agency:id:${identity.canonical_id}`,
    label,
    link_confidence: "strong",
    relation: "applicant agency",
  }, { surface: "land" }) || escape(label);
}

function resolveSelectedLandDetailRecord() {
  const detail = globalThis.document?.querySelector?.("#ldetail");
  if (!detail) return null;
  const selected = globalThis.document?.querySelector?.("#llist .row.sel");
  const index = selected ? Number(selected.dataset?.i) : Number.NaN;
  if (Number.isInteger(index) && Array.isArray(globalThis.lRows) && globalThis.lRows[index]) {
    return { detail, record: globalThis.lRows[index] };
  }
  const hashMatch = String(globalThis.location?.hash || "").match(/^#land\/([^/?#]+)/);
  if (hashMatch && Array.isArray(globalThis.lRows)) {
    const projectId = decodeURIComponent(hashMatch[1]);
    const record = globalThis.lRows.find((row) => String(row?.project_id || "") === projectId);
    if (record) return { detail, record };
  }
  return null;
}

let placeLinksPaintedForSelection = null;

function scheduleLandDetailPlaceLinksPaint({ escape = escapeHtml } = {}) {
  const selection = globalThis.landSelectionSeq;
  if (selection == null || selection === placeLinksPaintedForSelection) return;
  placeLinksPaintedForSelection = selection;
  queueMicrotask(() => {
    if (selection !== globalThis.landSelectionSeq) return;
    const resolved = resolveSelectedLandDetailRecord();
    if (!resolved?.detail || !resolved.record) return;
    void paintLandDetailPlaceLinks(resolved.detail, resolved.record, { escape });
  });
}

/** Return a place pivot only when the shared scope helper resolves the identifier. */
export function landRecordPlaceHTML(kind, value, {
  borough = "",
  labelForCouncilDistrict,
  knownCommunityDistricts = null,
  knownCouncilDistricts = null,
  escape = escapeHtml,
} = {}) {
  // The existing Land detail hydrate paints publisher Where pivots through this
  // helper. Schedule the lot-derived neighborhood/board section once per
  // selection from the same production path.
  scheduleLandDetailPlaceLinksPaint({ escape });
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

/**
 * Paint publisher place pivots and the lot-derived neighborhood/board section.
 * Keeps publisher Where links separate from physical membership destinations.
 */
export async function hydrateLandRecordDetailPlaces(detail, record, {
  escape = escapeHtml,
  labelForCouncilDistrict = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!detail || !record) return null;
  const placeOptions = {
    borough: record.borough,
    labelForCouncilDistrict,
    escape,
  };
  const placeRegistry = await loadLandRecordPlaceRegistry(fetchImpl);
  const placeOptionsWithRegistry = {
    ...placeOptions,
    knownCommunityDistricts: placeRegistry.community,
    knownCouncilDistricts: placeRegistry.council,
  };
  for (const [kind, value] of [
    ["borough", record.borough],
    ["community", record.community_district],
    ["council", record.cc_district],
  ]) {
    const host = detail.querySelector?.(`[data-land-record-place='${kind}']`);
    if (host) host.innerHTML = landRecordPlaceHTML(kind, value, placeOptionsWithRegistry);
  }
  return paintLandDetailPlaceLinks(detail, record, { fetchImpl, escape });
}
