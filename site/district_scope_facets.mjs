/**
 * Join-backed district facets shared across surfaces.
 *
 * Doctrine: a district dropdown is not the feature — the exact registry key
 * and the shareable scope edge behind it are. Community keys are product
 * borough+number ids (M01…R18); council keys are bare 1…51. Unknown values
 * fail closed (never inferred into a key).
 */

import {
  COMMUNITY_DISTRICT_ID_RE,
  COUNCIL_DISTRICT_ID_RE,
  normalizeCommunityDistrictId,
  normalizeCouncilDistrictId,
} from "./council_district_lookup.mjs";
import { nearYouUrlFromScope, scopeFromLensState } from "./scope_v0.mjs";

export { COMMUNITY_DISTRICT_ID_RE, COUNCIL_DISTRICT_ID_RE };

/** Fail-closed community-district key, or null when the value does not resolve. */
export function communityDistrictKey(value) {
  return normalizeCommunityDistrictId(value);
}

/** Fail-closed council-district key, or null when the value does not resolve. */
export function councilDistrictKey(value) {
  return normalizeCouncilDistrictId(value);
}

function countByKey(values, resolve) {
  const counts = new Map();
  let unknown = 0;
  for (const raw of values || []) {
    if (raw == null || raw === "") continue;
    const key = resolve(raw);
    if (!key) {
      unknown += 1;
      continue;
    }
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return { counts, unknown };
}

/**
 * Community-district facet inventory from resolved location rows.
 * Only exact registry keys appear; unresolvable stamps are counted as unknown.
 */
export function communityDistrictFacetOptions(locations = []) {
  const { counts, unknown } = countByKey(
    (Array.isArray(locations) ? locations : []).map((item) => item?.community_district),
    communityDistrictKey,
  );
  // Derived inventory counts from registry-keyed location stamps (not a static table).
  const options = Array.from(counts.entries())
    .map(([id, count]) => ({
      id,
      count,
      kind: "community_district",
      label: id,
    }))
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  return { options, unknown };
}

/**
 * Council-district facet inventory from resolved location rows.
 * Only exact registry keys appear; unresolvable stamps are counted as unknown.
 */
export function councilDistrictFacetOptions(locations = [], { labelFor } = {}) {
  const { counts, unknown } = countByKey(
    (Array.isArray(locations) ? locations : []).map((item) => item?.council_district),
    councilDistrictKey,
  );
  const label = typeof labelFor === "function"
    ? labelFor
    : (id) => `Council District ${id}`;
  // Derived inventory counts from registry-keyed location stamps (not a static table).
  const options = Array.from(counts.entries())
    .map(([id, count]) => ({
      id,
      count,
      kind: "council_district",
      label: label(id),
    }))
    .sort((a, b) => Number(a.id) - Number(b.id));
  return { options, unknown };
}

/**
 * Shareable Money contract-action scope hash for district / borough filters.
 * Returns null when no place constraint is present (empty is not a scope edge).
 */
export function moneyDistrictScopeHash(filter = {}) {
  const cd = communityDistrictKey(filter.communityDistrict || filter.cd || filter.community_district);
  const council = councilDistrictKey(filter.councilDistrict || filter.council || filter.council_district);
  const borough = filter.borough || filter.boro || "";
  const actionBasis = filter.actionBasis || filter.basis || "";
  if (!cd && !council && !borough && !actionBasis) return null;
  const q = new URLSearchParams();
  q.set("basis", "contract_action_address");
  if (actionBasis && actionBasis !== "contract_action_address") {
    q.set("actionBasis", String(actionBasis));
  }
  if (borough) q.set("boro", String(borough));
  if (cd) q.set("cd", cd);
  if (council) q.set("council", council);
  return `#money?${q.toString()}`;
}

/**
 * Near-you / map pivot for a registry-backed district.
 * Fail closed when the id does not resolve.
 */
export function districtMapPivotHref({ kind, id, lens = "money", basis = "contract_action_address" } = {}) {
  if (kind === "community_district") {
    const cd = communityDistrictKey(id);
    if (!cd) return null;
    const scope = scopeFromLensState(lens, {
      communityDistrict: cd,
      basis: lens === "money" ? basis : undefined,
    });
    return nearYouUrlFromScope(scope, { base: "/near-you/" });
  }
  if (kind === "council_district") {
    const council = councilDistrictKey(id);
    if (!council) return null;
    const scope = scopeFromLensState(lens, {
      councilDistrict: council,
      basis: lens === "money" ? basis : undefined,
    });
    return nearYouUrlFromScope(scope, { base: "/near-you/" });
  }
  return null;
}

function escAttr(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Hypertext chip rail for a district facet.
 * Each option is a real shareable scope link, not a page-local button.
 */
export function districtFacetRailHTML({
  kind,
  options = [],
  selected = "",
  baseFilter = {},
  anyLabel = "Any district",
  mapPivotLabel = "Map",
  escape = escText,
  escapeAttr = escAttr,
} = {}) {
  const selectedKey = kind === "community_district"
    ? communityDistrictKey(selected)
    : councilDistrictKey(selected);
  const clearFilter = {
    ...baseFilter,
    communityDistrict: kind === "community_district" ? "" : baseFilter.communityDistrict,
    councilDistrict: kind === "council_district" ? "" : baseFilter.councilDistrict,
    // Keep the response-location layer open when clearing only a district chip.
    actionBasis: baseFilter.actionBasis || baseFilter.basis || "",
    borough: baseFilter.borough || "",
  };
  // Force basis on clear so the reader stays on the logistics inventory.
  const clearHash = moneyDistrictScopeHash({
    ...clearFilter,
    actionBasis: clearFilter.actionBasis || "contract_action_address",
  }) || "#money?basis=contract_action_address";

  const chips = [];
  chips.push(
    `<a class="chip district-facet-chip" href="${escapeAttr(clearHash)}" data-district-kind="${escapeAttr(kind)}" data-district-id="" aria-pressed="${selectedKey ? "false" : "true"}">${escape(anyLabel)}</a>`,
  );

  for (const option of options) {
    const id = kind === "community_district"
      ? communityDistrictKey(option.id)
      : councilDistrictKey(option.id);
    if (!id) continue;
    const nextFilter = {
      ...baseFilter,
      communityDistrict: kind === "community_district"
        ? id
        : (baseFilter.communityDistrict || ""),
      councilDistrict: kind === "council_district"
        ? id
        : (baseFilter.councilDistrict || ""),
      actionBasis: baseFilter.actionBasis || baseFilter.basis || "",
      borough: baseFilter.borough || "",
    };
    if (!nextFilter.actionBasis && !nextFilter.borough) {
      nextFilter.actionBasis = "contract_action_address";
    }
    const href = moneyDistrictScopeHash(nextFilter);
    if (!href) continue;
    const pressed = selectedKey === id ? "true" : "false";
    const count = Number(option.count) > 0
      ? ` <span class="ct">${escape(String(option.count))}</span>`
      : "";
    const mapHref = districtMapPivotHref({ kind, id, lens: "money" });
    const mapLink = mapHref
      ? ` <a class="district-map-pivot" href="${escapeAttr(mapHref)}" data-district-map-pivot="${escapeAttr(kind)}:${escapeAttr(id)}">${escape(mapPivotLabel)}</a>`
      : "";
    chips.push(
      `<span class="district-facet-option" data-district-kind="${escapeAttr(kind)}" data-district-id="${escapeAttr(id)}">`
      + `<a class="chip district-facet-chip" href="${escapeAttr(href)}" data-district-kind="${escapeAttr(kind)}" data-district-id="${escapeAttr(id)}" aria-pressed="${pressed}">${escape(option.label || id)}${count}</a>`
      + mapLink
      + `</span>`,
    );
  }

  return chips.join("");
}

/**
 * Paint community + council district facet rails from a location inventory.
 * Replaces dynamically populated district selects with join-backed hypertext.
 */
export function paintDistrictFacetRails(doc, options = {}) {
  const documentRef = options.documentRef || globalThis.document;
  if (!documentRef) return { community: { options: [], unknown: 0 }, council: { options: [], unknown: 0 } };

  const locations = (doc?.rows || []).flatMap((row) => row.locations || []);
  const community = communityDistrictFacetOptions(locations);
  const council = councilDistrictFacetOptions(locations, {
    labelFor: options.councilLabel,
  });

  const baseFilter = {
    borough: options.borough || documentRef.querySelector?.("#moneyboro")?.value || "",
    actionBasis: options.actionBasis || "",
    communityDistrict: options.communityDistrict
      ?? documentRef.querySelector?.("#moneycd")?.value
      ?? "",
    councilDistrict: options.councilDistrict
      ?? documentRef.querySelector?.("#moneycouncil")?.value
      ?? "",
  };
  // Normalize selection fail-closed into the hidden controls when present.
  const cdEl = documentRef.querySelector?.("#moneycd");
  const councilEl = documentRef.querySelector?.("#moneycouncil");
  if (cdEl) {
    const key = communityDistrictKey(cdEl.value);
    cdEl.value = key || "";
    baseFilter.communityDistrict = cdEl.value;
  }
  if (councilEl) {
    const key = councilDistrictKey(councilEl.value);
    councilEl.value = key || "";
    baseFilter.councilDistrict = councilEl.value;
  }

  // If the response basis control is set to a concrete logistics basis, carry it.
  const basisControl = documentRef.querySelector?.("#moneylocationbasis")?.value || "";
  if (["submission_address", "pre_bid_venue", "document_pickup"].includes(basisControl)) {
    baseFilter.actionBasis = basisControl;
  }

  const communityRail = documentRef.querySelector?.("#moneycd-facets");
  const councilRail = documentRef.querySelector?.("#moneycouncil-facets");
  if (communityRail) {
    communityRail.innerHTML = districtFacetRailHTML({
      kind: "community_district",
      options: community.options,
      selected: baseFilter.communityDistrict,
      baseFilter,
      anyLabel: options.anyLabel || "Any district",
      mapPivotLabel: options.mapPivotLabel || "Map",
      escape: options.escape,
      escapeAttr: options.escapeAttr,
    });
  }
  if (councilRail) {
    councilRail.innerHTML = districtFacetRailHTML({
      kind: "council_district",
      options: council.options,
      selected: baseFilter.councilDistrict,
      baseFilter,
      anyLabel: options.anyLabel || "Any district",
      mapPivotLabel: options.mapPivotLabel || "Map",
      escape: options.escape,
      escapeAttr: options.escapeAttr,
    });
  }

  return { community, council };
}
