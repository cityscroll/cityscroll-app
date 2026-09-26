/**
 * Land NTA geography query helpers kept beside `site/app/land.mjs` so the route
 * module stays under the short-context working bar. Owns membership load,
 * clear-area / unavailable markup, and the pre-limit result ceiling choice.
 */

import {
  LAND_ADDRESS_RESULT_LIMIT,
  LAND_DEFAULT_RESULT_LIMIT,
  LAND_PLACE_MEMBERSHIP_SCHEMA_ID,
  resolveLandNtaGeographyConstraint,
} from "./land_filter_parity.mjs";

export const LAND_PLACE_MEMBERSHIP_URL = "data/land_place_membership.json";

let landPlaceMembershipPromise = null;
let landPlaceMembership = null;
/** null = geography axis absent; array = explicit NTA scope (possibly empty/invalid). */
let landGeographiesState = null;

export function getLandGeographies() {
  return landGeographiesState;
}

export function setLandGeographies(value) {
  landGeographiesState = value == null ? null : (Array.isArray(value) ? [...value] : null);
  return landGeographiesState;
}

export function installLandGeographyGlobals(globalObj = globalThis) {
  Object.defineProperty(globalObj, "landGeographies", {
    configurable: true,
    get: () => landGeographiesState,
    set: (value) => { setLandGeographies(value); },
  });
}

export function landHasExplicitGeography(geographies = landGeographiesState) {
  return Array.isArray(geographies);
}

export function landResultLimitForBranch({ block = false } = {}) {
  return block ? LAND_ADDRESS_RESULT_LIMIT : LAND_DEFAULT_RESULT_LIMIT;
}

export function landShouldBroadenDistrict({ block = false, geographies = null } = {}) {
  return Boolean(block) && !landHasExplicitGeography(geographies);
}

export function resetLandPlaceMembershipCache() {
  landPlaceMembershipPromise = null;
  landPlaceMembership = null;
}

export function loadLandPlaceMembership(fetchImpl = globalThis.fetch) {
  if (!landPlaceMembershipPromise) {
    landPlaceMembershipPromise = fetchImpl(LAND_PLACE_MEMBERSHIP_URL, {
      cache: "force-cache",
      credentials: "omit",
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((doc) => {
        if (!doc || doc.schema !== LAND_PLACE_MEMBERSHIP_SCHEMA_ID || !doc.by_geography) {
          return null;
        }
        landPlaceMembership = doc;
        return doc;
      })
      .catch(() => null);
  }
  return landPlaceMembershipPromise;
}

/**
 * Resolve geography for a Land search. Returns:
 * - `{ status: "none", placeMembership: null }` when the axis is inactive
 * - `{ status: "ready"|"invalid", placeMembership }` when membership loaded
 * - `{ status: "unavailable", html }` when the index cannot be used
 */
export async function resolveLandSearchGeography(geographies, fetchImpl = globalThis.fetch) {
  if (!landHasExplicitGeography(geographies)) {
    return { status: "none", placeMembership: null };
  }
  const placeMembership = await loadLandPlaceMembership(fetchImpl);
  const constraint = resolveLandNtaGeographyConstraint(geographies, placeMembership);
  if (constraint.status === "unavailable") {
    return { status: "unavailable", placeMembership: null };
  }
  return { status: constraint.status, placeMembership };
}

export function landEmptyStateHTML({
  kind = "projects",
  filtered = false,
  geographies = null,
  translate,
} = {}) {
  const heading = kind === "hearings"
    ? translate("land_empty_hearings_heading")
    : translate("land_empty_projects_heading");
  const explicit = landHasExplicitGeography(geographies);
  const detail = explicit
    ? translate("land_empty_area_detail")
    : (filtered
      ? translate("land_empty_filtered_detail")
      : translate("land_empty_unfiltered_detail"));
  const action = explicit
    ? `<button type="button" class="act" data-land-clear-area>${translate("land_clear_area")}</button>`
    : `<button type="button" class="act" data-land-widen>${translate("land_empty_widen")}</button>`;
  return `<section class="land-empty-state" role="status" aria-labelledby="land-empty-heading">
    <h3 id="land-empty-heading">${heading}</h3><p>${detail}</p>
    ${action}
  </section>`;
}

export function landPlaceIndexUnavailableHTML(translate) {
  return `<section class="land-empty-state" role="status" aria-labelledby="land-empty-heading">
    <h3 id="land-empty-heading">${translate("land_place_index_unavailable_heading")}</h3>
    <p>${translate("land_place_index_unavailable_detail")}</p>
    <button type="button" class="act" data-land-retry-place>${translate("land_place_index_retry")}</button>
  </section>`;
}

/** Paint the unavailable-index empty state and wire retry. */
export function showLandPlaceIndexUnavailable({
  listEl,
  translate,
  setResultCount,
  setStatus,
  unbusy,
  onRetry,
} = {}) {
  unbusy?.();
  if (listEl) listEl.innerHTML = landPlaceIndexUnavailableHTML(translate);
  setResultCount?.(0);
  setStatus?.(translate("land_place_index_unavailable_status"));
  listEl?.querySelector("[data-land-retry-place]")?.addEventListener("click", () => {
    resetLandPlaceMembershipCache();
    onRetry?.();
  });
}

/** Snapshot filter options shared by ordinary, lexical, and address branches. */
export function landGeographySnapshotOptions({
  geographies = null,
  placeMembership = null,
  block = false,
  limit = null,
  ...rest
} = {}) {
  return {
    ...rest,
    geographies,
    placeMembership,
    limit: Number.isFinite(limit) ? limit : landResultLimitForBranch({ block }),
  };
}

/**
 * Apply geography + facets through filterLandSnapshot. Callers pass the filter
 * implementation so this module stays free of a resident_snapshot_queries import.
 */
export function filterLandRowsWithGeography(filterLandSnapshot, rows, options) {
  return filterLandSnapshot(rows, landGeographySnapshotOptions(options));
}

export {
  LAND_ADDRESS_RESULT_LIMIT,
  LAND_DEFAULT_RESULT_LIMIT,
  resolveLandNtaGeographyConstraint,
};
