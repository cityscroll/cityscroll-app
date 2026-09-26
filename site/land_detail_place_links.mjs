/**
 * Land detail → supported neighborhoods and boards from published project lots.
 *
 * Reads the L02/L03 compact membership index (and optional evidence shard) to
 * list actual NTA and community-district memberships separately from
 * publisher-reported districts. Board links resolve only through the published
 * covers relation on matched community districts.
 */

import { constellationLink } from "./affordance_grammar.mjs";
import { civicGeographyKey } from "./civic_geography_registry.mjs";
import { communityBoardIdFromCommunityDistrict } from "./community_board_geography.mjs";
import {
  communityBoardPageHref,
  communityDistrictDisplayName,
} from "./community_board_links.mjs";
import {
  isResidentialNeighborhoodSubtype,
  ntaResidentLabelPolicy,
} from "./geography_navigation_capability.mjs";
import {
  LAND_PLACE_ASSOCIATION_KIND,
  landPlaceLayerCoverage,
} from "./land_place_membership.mjs";
import { landProjectPath } from "./land_project_route.mjs";
import { nearYouUrlFromScope, scopeWithGeographies } from "./scope_v0.mjs";

export const LAND_DETAIL_PLACE_LINKS_SCHEMA = "cityscroll.land_detail_place_links.v1";
export const LAND_DETAIL_PLACE_LINKS_HEADING = "Published project lots in";
export const LAND_DETAIL_PLACE_LINKS_NOTE =
  "These names come from published project-lot points. A match means a lot point is in the area. It is not a claim of project impact or board review authority.";
export const LAND_DETAIL_PLACE_LINKS_PUBLISHER_NOTE =
  "Publisher-reported districts stay in Where above. They are separate from these lot-point places.";

const SUBTYPE_KIND_LABELS = Object.freeze({
  residential: "Neighborhood",
  park: "Park",
  cemetery: "Cemetery",
  airport: "Airport",
  rikers_island: "Special area",
  special_use: "Special area",
});

const BOROUGH_SLUG_LABELS = Object.freeze({
  bronx: "Bronx",
  brooklyn: "Brooklyn",
  manhattan: "Manhattan",
  queens: "Queens",
  "staten-island": "Staten Island",
});

const IMPACT_OR_AUTHORITY_CLAIM =
  /\b(?:project impact|rezoning impact|board review authority|reviewing body|rezoning of)\b/i;

function clean(value, max = 240) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function freezeDeep(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const entry of value) freezeDeep(entry);
    return Object.freeze(value);
  }
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

/** Resident-facing kind label driven by NTA subtype policy. */
export function ntaSubtypeKindLabel(subtype) {
  const value = clean(subtype, 40);
  if (!value) return null;
  if (SUBTYPE_KIND_LABELS[value]) return SUBTYPE_KIND_LABELS[value];
  const policy = ntaResidentLabelPolicy(value);
  if (policy.may_label_as_neighborhood) return "Neighborhood";
  return "Special area";
}

/** Canonical Near You href that restores one NTA geography key for Land. */
export function ntaNearYouHref(ntaId, { base = "/near-you/", lens = "land" } = {}) {
  const id = clean(ntaId, 16).toUpperCase();
  const key = civicGeographyKey("nta2020", id);
  if (!key) return null;
  return nearYouUrlFromScope(scopeWithGeographies({
    facets: { domains: [lens] },
    place: { geographies: [key] },
  }), { base });
}

/** Build id → label from an NTA layer document (geometry ignored). */
export function ntaLabelIndexFromLayer(layerDoc = {}) {
  const out = Object.create(null);
  for (const feature of Array.isArray(layerDoc?.features) ? layerDoc.features : []) {
    const id = clean(feature?.id, 16).toUpperCase();
    const label = clean(feature?.label, 120);
    if (!id || !label) continue;
    out[id] = label;
    out[`nta2020:${id}`] = label;
    out[`geography:nta2020:${id}`] = label;
  }
  return Object.freeze(out);
}

/** Build id → subtype from an NTA layer document (geometry ignored). */
export function ntaSubtypeIndexFromLayer(layerDoc = {}) {
  const out = Object.create(null);
  for (const feature of Array.isArray(layerDoc?.features) ? layerDoc.features : []) {
    const id = clean(feature?.id, 16).toUpperCase();
    if (!id) continue;
    out[id] = feature?.subtype == null ? null : clean(feature.subtype, 40);
  }
  return Object.freeze(out);
}

function labelForNta(ntaId, labelIndex) {
  const id = clean(ntaId, 16).toUpperCase();
  if (!id) return null;
  return (labelIndex
    && (labelIndex[id]
      || labelIndex[`nta2020:${id}`]
      || labelIndex[`geography:nta2020:${id}`]))
    || id;
}

function subtypeForNta(ntaId, subtypeIndex, edgeSubtype = null) {
  const id = clean(ntaId, 16).toUpperCase();
  if (edgeSubtype != null && clean(edgeSubtype, 40)) return clean(edgeSubtype, 40);
  if (!id || !subtypeIndex) return null;
  const value = subtypeIndex[id];
  return value == null ? null : clean(value, 40);
}

function boardTitleFromId(boardId) {
  const id = clean(boardId).toLowerCase().replace(/^community-board:/, "");
  const match = id.match(/^([a-z]+(?:-[a-z]+)*)-cb-(\d{2})$/);
  if (!match) return null;
  const borough = BOROUGH_SLUG_LABELS[match[1]] || null;
  const number = Number(match[2]);
  if (!borough || !Number.isInteger(number)) return null;
  return `${borough} Community Board ${number}`;
}

function districtBoroughFromCd(communityDistrictId) {
  const code = clean(communityDistrictId, 8).toUpperCase();
  const prefix = code[0];
  return ({
    X: "Bronx",
    K: "Brooklyn",
    M: "Manhattan",
    Q: "Queens",
    R: "Staten Island",
  })[prefix] || null;
}

/** Coverage sentence when partial placement changes interpretation. */
export function landDetailPlaceCoverageCopy(coverage) {
  if (!coverage || !Number.isFinite(coverage.matched) || !Number.isFinite(coverage.total)) {
    return null;
  }
  if (coverage.total <= 0 || coverage.matched >= coverage.total) return null;
  return `${coverage.matched} of ${coverage.total} lot points placed`;
}

/**
 * Build the Land-detail place-links model for one project.
 *
 * Returns null when enrichment is absent or the project has no physical
 * NTA/CD memberships, so callers can omit the section without inventing places.
 */
export function buildLandDetailPlaceLinksView({
  projectId = null,
  membership = null,
  record = null,
  labelIndex = null,
  subtypeIndex = null,
  geography = null,
  sourceDates = null,
} = {}) {
  const id = clean(projectId || record?.project_id, 32);
  if (!id || !membership || typeof membership !== "object") return null;
  if (membership.association_kind && membership.association_kind !== LAND_PLACE_ASSOCIATION_KIND) {
    return null;
  }

  const ntaPlaces = Array.isArray(membership.layers?.nta2020?.places)
    ? membership.layers.nta2020.places.map((value) => clean(value, 16).toUpperCase()).filter(Boolean)
    : [];
  const cdPlaces = Array.isArray(membership.layers?.community_district?.places)
    ? membership.layers.community_district.places.map((value) => clean(value, 8).toUpperCase()).filter(Boolean)
    : [];

  const hasPhysical = ntaPlaces.length > 0 || cdPlaces.length > 0;
  if (!hasPhysical) return null;

  const coverage = landPlaceLayerCoverage(membership, "nta2020");
  const coverageCopy = landDetailPlaceCoverageCopy(coverage);

  const neighborhoods = ntaPlaces.map((ntaId) => {
    const key = civicGeographyKey("nta2020", ntaId);
    const href = ntaNearYouHref(ntaId);
    const subtype = subtypeForNta(ntaId, subtypeIndex);
    const policy = ntaResidentLabelPolicy(subtype);
    const kind = ntaSubtypeKindLabel(subtype);
    const label = labelForNta(ntaId, labelIndex);
    return Object.freeze({
      nta_id: ntaId,
      key,
      label,
      subtype,
      kind_label: kind,
      is_special_use: !isResidentialNeighborhoodSubtype(subtype),
      may_label_as_neighborhood: Boolean(policy.may_label_as_neighborhood),
      href,
    });
  }).filter((item) => item.href && item.key);

  const districts = cdPlaces.map((cdId) => {
    const borough = districtBoroughFromCd(cdId);
    const districtLabel = communityDistrictDisplayName({ borough, id: cdId })
      || (borough ? `${borough} Community District ${Number(cdId.slice(1))}` : `Community District ${cdId}`);
    const boardId = communityBoardIdFromCommunityDistrict(cdId, geography || {});
    const boardHref = boardId ? communityBoardPageHref(boardId) : null;
    const boardLabel = boardId ? boardTitleFromId(boardId) : null;
    return Object.freeze({
      community_district_id: cdId,
      district_label: districtLabel,
      board_id: boardId,
      board_label: boardLabel,
      board_href: boardHref,
    });
  });

  const publisher = membership.publisher_geography && typeof membership.publisher_geography === "object"
    ? Object.freeze({
      borough: membership.publisher_geography.borough ?? record?.borough ?? null,
      community_district: membership.publisher_geography.community_district
        ?? record?.community_district
        ?? null,
      council_district: membership.publisher_geography.council_district
        ?? record?.cc_district
        ?? record?.council_district
        ?? null,
    })
    : Object.freeze({
      borough: record?.borough ?? null,
      community_district: record?.community_district ?? null,
      council_district: record?.cc_district ?? record?.council_district ?? null,
    });

  const projectPath = landProjectPath(id);
  const resolvedSourceDates = (sourceDates && typeof sourceDates === "object"
    ? sourceDates
    : null)
    || (membership.source_dates && typeof membership.source_dates === "object"
      ? membership.source_dates
      : null);

  return freezeDeep({
    schema: LAND_DETAIL_PLACE_LINKS_SCHEMA,
    project_id: id,
    project_path: projectPath,
    heading: LAND_DETAIL_PLACE_LINKS_HEADING,
    note: LAND_DETAIL_PLACE_LINKS_NOTE,
    publisher_note: LAND_DETAIL_PLACE_LINKS_PUBLISHER_NOTE,
    association_kind: membership.association_kind || LAND_PLACE_ASSOCIATION_KIND,
    bbl_association_state: membership.bbl_association_state || null,
    evidence_shard: membership.evidence_shard || null,
    coverage: coverage
      ? Object.freeze({
        matched: coverage.matched,
        total: coverage.total,
        fraction: coverage.fraction,
        copy: coverageCopy,
      })
      : null,
    neighborhoods: Object.freeze(neighborhoods),
    districts: Object.freeze(districts),
    publisher_geography: publisher,
    source_dates: resolvedSourceDates,
  });
}

function neighborhoodMarkup(item, escape) {
  const kind = item.kind_label
    ? `<span class="land-detail-place-kind">${escape(item.kind_label)}</span>`
    : "";
  const specialAttr = item.is_special_use ? ' data-geography-special-use="true"' : "";
  const link = constellationLink({
    href: item.href,
    label: item.label,
    className: "land-detail-place-nta-link",
    attributes: {
      "data-geography-key": item.key,
      "data-nta-id": item.nta_id,
      "data-nta-subtype": item.subtype || "",
      "data-land-place-kind": "nta2020",
    },
    escape,
  });
  return `<li class="land-detail-place-nta" data-nta-id="${escape(item.nta_id)}" data-nta-subtype="${escape(item.subtype || "")}"${specialAttr}>`
    + `${link}${kind ? ` ${kind}` : ""}`
    + `</li>`;
}

function districtMarkup(item, escape) {
  const board = item.board_href && item.board_label
    ? constellationLink({
      href: item.board_href,
      label: item.board_label,
      className: "land-detail-place-board-link",
      attributes: {
        "data-board-id": item.board_id,
        "data-community-district-id": item.community_district_id,
        "data-land-place-kind": "community_board",
      },
      escape,
    })
    : "";
  return `<li class="land-detail-place-district" data-community-district-id="${escape(item.community_district_id)}"`
    + `${item.board_id ? ` data-board-id="${escape(item.board_id)}"` : ""}>`
    + `<span class="land-detail-place-district-label">${escape(item.district_label)}</span>`
    + (board ? ` · ${board}` : "")
    + `</li>`;
}

/**
 * HTML for the Land-detail place-links section.
 * Returns "" when the view is absent so missing optional membership never
 * fabricates a neighborhood claim.
 */
export function renderLandDetailPlaceLinksSection(view, { escape = esc } = {}) {
  if (!view || view.schema !== LAND_DETAIL_PLACE_LINKS_SCHEMA) return "";
  if (!view.neighborhoods?.length && !view.districts?.length) return "";

  const coverage = view.coverage?.copy
    ? `<p class="land-detail-place-coverage" data-land-place-coverage="${escape(view.coverage.fraction)}">${escape(view.coverage.copy)}</p>`
    : "";

  const neighborhoods = view.neighborhoods?.length
    ? `<ul class="land-detail-place-nta-list" data-land-place-nta-count="${escape(String(view.neighborhoods.length))}">`
      + view.neighborhoods.map((item) => neighborhoodMarkup(item, escape)).join("")
      + `</ul>`
    : "";

  const districts = view.districts?.length
    ? `<ul class="land-detail-place-district-list" data-land-place-district-count="${escape(String(view.districts.length))}">`
      + view.districts.map((item) => districtMarkup(item, escape)).join("")
      + `</ul>`
    : "";

  const vintageBits = [];
  const boundary = view.source_dates?.boundary_vintages;
  if (boundary && typeof boundary === "object") {
    if (boundary.nta2020) vintageBits.push(`NTA ${boundary.nta2020}`);
    if (boundary.community_district) vintageBits.push(`community district ${boundary.community_district}`);
  }
  if (view.source_dates?.parcel_coordinate_vintage) {
    vintageBits.push(`parcel points ${view.source_dates.parcel_coordinate_vintage}`);
  }
  const evidence = `<details class="land-detail-place-evidence">`
    + `<summary>Lot-point evidence</summary>`
    + `<p class="muted">Association kind: ${escape(view.association_kind)}. `
    + (view.evidence_shard ? `Evidence shard ${escape(view.evidence_shard)}. ` : "")
    + (vintageBits.length ? `Source vintages: ${escape(vintageBits.join("; "))}.` : "Source vintages follow the membership generation.")
    + `</p>`
    + `<p class="muted">${escape(view.publisher_note)}</p>`
    + `</details>`;

  return `<section class="land-detail-place-links" data-land-detail-place-links="1" data-project-id="${escape(view.project_id)}"`
    + `${view.project_path ? ` data-project-path="${escape(view.project_path)}"` : ""}`
    + `${view.bbl_association_state ? ` data-bbl-association-state="${escape(view.bbl_association_state)}"` : ""}>`
    + `<h3 class="land-detail-place-heading">${escape(view.heading)}</h3>`
    + `<p class="land-detail-place-note">${escape(view.note)}</p>`
    + coverage
    + neighborhoods
    + districts
    + evidence
    + `</section>`;
}

/**
 * Honesty findings for a rendered place-links view.
 * Returns an empty list for a clean section; callers must also exercise a
 * positive-control fixture that produces at least one finding.
 */
export function landDetailPlaceLinksFindings(view, { html = "" } = {}) {
  const findings = [];
  if (!view || view.schema !== LAND_DETAIL_PLACE_LINKS_SCHEMA) {
    findings.push("place-links view missing");
    return findings;
  }
  if (IMPACT_OR_AUTHORITY_CLAIM.test(view.note || "") || IMPACT_OR_AUTHORITY_CLAIM.test(html || "")) {
    // The standing note names the forbidden claims in the negative; only flag
    // affirmative claim phrasing outside that disclaimer.
    const affirmative = String(html || "")
      .replace(view.note || "", "")
      .replace(LAND_DETAIL_PLACE_LINKS_NOTE, "");
    if (/\b(?:this (?:is|shows) (?:the )?project impact|grants board review authority|is a rezoning of)\b/i.test(affirmative)) {
      findings.push("place-links claims project impact or board review authority");
    }
  }
  if (
    (view.bbl_association_state === "absent_from_index"
      || view.bbl_association_state === "empty"
      || view.bbl_association_state === "source_missing")
    && (view.neighborhoods?.length || view.districts?.length)
  ) {
    findings.push("no-bbl project fabricated physical place membership");
  }
  for (const item of view.neighborhoods || []) {
    if (!item.href || !item.key) findings.push(`nta ${item.nta_id} missing destination`);
    if (item.is_special_use && item.may_label_as_neighborhood) {
      findings.push(`nta ${item.nta_id} special-use labeled as neighborhood`);
    }
  }
  for (const item of view.districts || []) {
    if (item.board_id && !item.board_href) {
      findings.push(`district ${item.community_district_id} board missing profile href`);
    }
  }
  if (view.project_id && view.project_path && view.project_path !== landProjectPath(view.project_id)) {
    findings.push("project path diverges from canonical Land route helper");
  }
  return findings;
}

/**
 * Resolve one project's membership entry from a compact index document.
 */
export function landDetailPlaceMembershipForProject(index, projectId) {
  const id = clean(projectId, 32);
  if (!id || !index?.by_project) return null;
  const entry = index.by_project[id];
  return entry && typeof entry === "object" ? entry : null;
}

const MEMBERSHIP_URL = new URL("./data/land_place_membership.json", import.meta.url);
const NTA_LAYER_URL = new URL("./data/geography/layers/nta2020/26B.json", import.meta.url);
const GEOGRAPHY_URL = new URL("./data/community_board_geography_lookup.json", import.meta.url);

let membershipPromise = null;
let ntaLayerPromise = null;
let geographyPromise = null;

async function fetchJson(url, fetchImpl) {
  if (typeof fetchImpl !== "function") return null;
  try {
    const response = await fetchImpl(url);
    if (!response?.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function loadMembershipIndex(fetchImpl = globalThis.fetch) {
  if (!membershipPromise) {
    membershipPromise = fetchJson(MEMBERSHIP_URL, fetchImpl).catch(() => null);
  }
  return membershipPromise;
}

function loadNtaLayer(fetchImpl = globalThis.fetch) {
  if (!ntaLayerPromise) {
    ntaLayerPromise = fetchJson(NTA_LAYER_URL, fetchImpl).catch(() => null);
  }
  return ntaLayerPromise;
}

function loadBoardGeography(fetchImpl = globalThis.fetch) {
  if (!geographyPromise) {
    geographyPromise = fetchJson(GEOGRAPHY_URL, fetchImpl).catch(() => null);
  }
  return geographyPromise;
}

/**
 * Ensure a host element exists under the Land detail root and paint the
 * place-links section. Lookup failure clears optional prior markup and leaves
 * the rest of the detail usable.
 */
export async function paintLandDetailPlaceLinks(detailRoot, record, {
  fetchImpl = globalThis.fetch,
  escape = esc,
  hostId = "land-place-links-host",
} = {}) {
  if (!detailRoot || typeof detailRoot.querySelector !== "function") return null;
  let host = detailRoot.querySelector(`#${hostId}`);
  if (!host && typeof detailRoot.insertAdjacentHTML === "function") {
    const anchor = detailRoot.querySelector("#land-same-applicant-host")
      || detailRoot.querySelector("[data-land-record-place-group]")
      || detailRoot.querySelector(".agencybar");
    if (anchor && typeof anchor.insertAdjacentHTML === "function") {
      anchor.insertAdjacentHTML("afterend", `<div id="${hostId}"></div>`);
      host = detailRoot.querySelector(`#${hostId}`);
    }
  }
  if (!host) return null;

  try {
    const [index, layer, geography] = await Promise.all([
      loadMembershipIndex(fetchImpl),
      loadNtaLayer(fetchImpl),
      loadBoardGeography(fetchImpl),
    ]);
    const projectId = clean(record?.project_id, 32);
    const membership = landDetailPlaceMembershipForProject(index, projectId);
    if (!membership) {
      host.innerHTML = "";
      return null;
    }
    const view = buildLandDetailPlaceLinksView({
      projectId,
      membership,
      record,
      labelIndex: ntaLabelIndexFromLayer(layer || {}),
      subtypeIndex: ntaSubtypeIndexFromLayer(layer || {}),
      geography: geography || {},
      sourceDates: index?.source_dates || null,
    });
    host.innerHTML = renderLandDetailPlaceLinksSection(view, { escape });
    return view;
  } catch {
    host.innerHTML = "";
    return null;
  }
}
