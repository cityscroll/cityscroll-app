/**
 * Reverse board → neighborhood links for community board profiles.
 *
 * Reads B01 by_board edges (via the B02 profile consumer or the committed
 * index), orders by pct_to then NTA id, and renders Near You destinations for
 * each overlapping NTA. The first six names stay visible; the remainder expand
 * with an exact remaining count. All links are server HTML.
 */

import { civicGeographyKey } from "./civic_geography_registry.mjs";
import {
  isResidentialNeighborhoodSubtype,
  ntaResidentLabelPolicy,
} from "./geography_navigation_capability.mjs";
import { formatOverlapExactPercent } from "./geography_navigation_overlap_ui.mjs";
import { ntasForBoard } from "./board_neighborhood_index.mjs";
import { nearYouUrlFromScope, scopeWithGeographies } from "./scope_v0.mjs";
import { renderNodeSection } from "./civic_document_chrome.mjs";

export const BOARD_PROFILE_NEIGHBORHOODS_SCHEMA = "cityscroll.board_profile_neighborhoods.v1";
export const BOARD_PROFILE_NEIGHBORHOODS_VISIBLE_LIMIT = 6;
export const BOARD_PROFILE_NEIGHBORHOODS_HEADING = "Neighborhoods in this district";
export const BOARD_PROFILE_NEIGHBORHOODS_NOTE =
  "These named areas overlap this board's district. Opening one shows that whole place in Near You; it does not mean every local record belongs only to this board.";
export const BOARD_PROFILE_PCT_TO_DENOMINATOR = "of this district's area";

const SUBTYPE_KIND_LABELS = Object.freeze({
  residential: "Neighborhood",
  park: "Park",
  cemetery: "Cemetery",
  airport: "Airport",
  rikers_island: "Special area",
  special_use: "Special area",
});

function clean(value, max = 240) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
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

/** Canonical Near You href that restores one NTA geography key. */
export function ntaNearYouHref(ntaId, { base = "/near-you/" } = {}) {
  const id = clean(ntaId, 16).toUpperCase();
  const key = civicGeographyKey("nta2020", id);
  if (!key) return null;
  return nearYouUrlFromScope(scopeWithGeographies({
    facets: { domains: ["meetings"] },
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

function compareReverse(left, right) {
  const pct = (Number(right.pct_to) || 0) - (Number(left.pct_to) || 0);
  if (pct !== 0) return pct;
  return clean(left.nta_id).localeCompare(clean(right.nta_id));
}

function resolveEdges(boardId, {
  edges = null,
  profile = null,
  index = null,
} = {}) {
  if (Array.isArray(edges)) return edges;
  const id = clean(boardId).toLowerCase().replace(/^community-board:/, "");
  if (!id) return [];
  if (Array.isArray(profile?.by_board?.[id])) return profile.by_board[id];
  if (index) return ntasForBoard(index, id);
  return [];
}

/**
 * Build the reverse neighborhood section model for one board profile.
 *
 * Missing enrichment (null profile/index and no edges) returns null so the
 * caller can omit the section without inventing an empty neighborhood claim.
 */
export function buildBoardProfileNeighborhoodsView({
  boardId = null,
  edges = null,
  profile = null,
  index = null,
  labelIndex = null,
  visibleLimit = BOARD_PROFILE_NEIGHBORHOODS_VISIBLE_LIMIT,
} = {}) {
  const id = clean(boardId).toLowerCase().replace(/^community-board:/, "");
  if (!id) return null;
  const hasEnrichment = Array.isArray(edges)
    || (profile && typeof profile === "object")
    || (index && typeof index === "object");
  if (!hasEnrichment) return null;

  const sourceEdges = resolveEdges(id, { edges, profile, index });
  const sorted = [...sourceEdges]
    .filter((edge) => edge && clean(edge.nta_id))
    .map((edge) => ({
      nta_id: clean(edge.nta_id, 16).toUpperCase(),
      district_id: clean(edge.district_id, 8).toUpperCase() || null,
      board_id: clean(edge.board_id).toLowerCase() || id,
      pct_from: Number.isFinite(Number(edge.pct_from)) ? Number(edge.pct_from) : null,
      pct_to: Number.isFinite(Number(edge.pct_to)) ? Number(edge.pct_to) : null,
      subtype: edge.subtype == null ? null : clean(edge.subtype, 40),
    }))
    .sort(compareReverse);

  const items = sorted.map((edge) => {
    const key = civicGeographyKey("nta2020", edge.nta_id);
    const href = ntaNearYouHref(edge.nta_id);
    const label = (labelIndex
      && (labelIndex[edge.nta_id]
        || labelIndex[`nta2020:${edge.nta_id}`]
        || labelIndex[`geography:nta2020:${edge.nta_id}`]))
      || edge.nta_id;
    const kind = ntaSubtypeKindLabel(edge.subtype);
    const policy = ntaResidentLabelPolicy(edge.subtype);
    return Object.freeze({
      nta_id: edge.nta_id,
      key,
      label,
      subtype: edge.subtype,
      kind_label: kind,
      is_special_use: !isResidentialNeighborhoodSubtype(edge.subtype),
      may_label_as_neighborhood: Boolean(policy.may_label_as_neighborhood),
      district_id: edge.district_id,
      board_id: edge.board_id,
      pct_from: edge.pct_from,
      pct_to: edge.pct_to,
      exact_pct_to: formatOverlapExactPercent(edge.pct_to),
      pct_to_denominator: BOARD_PROFILE_PCT_TO_DENOMINATOR,
      href,
    });
  }).filter((item) => item.href && item.key);

  const limit = Number.isInteger(visibleLimit) && visibleLimit > 0
    ? visibleLimit
    : BOARD_PROFILE_NEIGHBORHOODS_VISIBLE_LIMIT;
  const visible = items.slice(0, limit);
  const overflow = items.slice(limit);
  const remainingCount = overflow.length;

  return freezeDeep({
    schema: BOARD_PROFILE_NEIGHBORHOODS_SCHEMA,
    board_id: id,
    heading: BOARD_PROFILE_NEIGHBORHOODS_HEADING,
    note: BOARD_PROFILE_NEIGHBORHOODS_NOTE,
    visible_limit: limit,
    total_count: items.length,
    remaining_count: remainingCount,
    items: Object.freeze(items),
    visible: Object.freeze(visible),
    overflow: Object.freeze(overflow),
  });
}

function itemMarkup(item) {
  const kind = item.kind_label
    ? `<span class="board-profile-neighborhood-kind">${esc(item.kind_label)}</span>`
    : "";
  const share = item.exact_pct_to
    ? `<span class="muted board-profile-neighborhood-share">${esc(item.exact_pct_to)} ${esc(item.pct_to_denominator)}</span>`
    : "";
  const specialAttr = item.is_special_use ? ' data-geography-special-use="true"' : "";
  return `<li class="board-profile-neighborhood" data-nta-id="${esc(item.nta_id)}" data-nta-subtype="${esc(item.subtype || "")}"${specialAttr}>`
    + `<a class="board-profile-neighborhood-link" href="${esc(item.href)}" data-geography-key="${esc(item.key)}">${esc(item.label)}</a>`
    + (kind ? ` ${kind}` : "")
    + (share ? ` ${share}` : "")
    + `</li>`;
}

/**
 * Server HTML for the board-profile neighborhood section.
 * Returns "" when enrichment is absent or the board has no associated NTAs,
 * so a missing optional section never renders a blank heading.
 */
export function renderBoardProfileNeighborhoodsSection(view) {
  if (!view || view.schema !== BOARD_PROFILE_NEIGHBORHOODS_SCHEMA) return "";
  if (!view.items?.length) return "";

  const visibleList = `<ul class="node-record-list board-profile-neighborhood-list" data-board-profile-neighborhood-visible="${esc(String(view.visible.length))}">`
    + view.visible.map(itemMarkup).join("")
    + `</ul>`;

  const overflow = view.remaining_count > 0
    ? `<details class="board-profile-neighborhood-more" data-board-profile-neighborhood-remaining="${esc(String(view.remaining_count))}">`
      + `<summary>${esc(view.remaining_count === 1
        ? "1 more overlapping area"
        : `${view.remaining_count} more overlapping areas`)}</summary>`
      + `<ul class="node-record-list board-profile-neighborhood-list board-profile-neighborhood-overflow">`
      + view.overflow.map(itemMarkup).join("")
      + `</ul></details>`
    : "";

  return renderNodeSection({
    heading: view.heading,
    extraClass: "node-card civic-object-section board-profile-neighborhoods",
    attrs: {
      id: "board-neighborhoods",
      "data-board-profile-neighborhoods": "1",
      "data-neighborhood-count": String(view.total_count),
      "data-neighborhood-remaining": String(view.remaining_count),
    },
    body: `<p class="node-lede">${esc(view.note)}</p>${visibleList}${overflow}`,
  });
}
