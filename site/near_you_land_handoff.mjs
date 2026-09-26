/**
 * Near You → Land handoff: real result and record destinations that carry the same
 * neighborhood membership and supported Land facets.
 *
 * Links are built through scope_v0 geography keys and the Land filter-parity route helpers.
 * Canonical NTA keys stay NTA keys; they are never rewritten into approximate community-district
 * filters. Selection is by project id when that id remains in the pre-limit population; when it
 * does not, selection clears and the return path is the matching Near You URL.
 */

import {
  landBrowseHrefFromState,
  landCanonicalIds,
  landFilterStateFromRouteParams,
  landFilterStateToSearchParams,
  landSnapshotQueryFromState,
  normalizeLandNtaGeographyKeys,
  resolveLandNtaGeographyConstraint,
} from "./land_filter_parity.mjs";
import { landProjectPath } from "./land_project_route.mjs";
import { nextLandMapSelection } from "./land_map_selection.mjs";
import {
  placeNavigationLandDetailHref,
  placeNavigationStateFromParts,
} from "./place_navigation_continuity.mjs";
import { filterLandSnapshot } from "./resident_snapshot_queries.mjs";
import {
  geographyKeysFromScope,
  nearYouUrlFromScope,
  normalizeGeographyKey,
  scopeWithGeographies,
} from "./scope_v0.mjs";

export const NEAR_YOU_LAND_HANDOFF_SCHEMA = "cityscroll.near_you_land_handoff.v1";
export const NEAR_YOU_LAND_RESULTS_BASE = "/browse/zoning/";
export const NEAR_YOU_LAND_RETURN_BASE = "/near-you/";

const NTA_GEOGRAPHY_RE = /^geography:nta2020:((?:BK|BX|MN|QN|SI)\d{4})$/;
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,24}$/;

const LAND_FACET_KEYS = Object.freeze([
  "status",
  "stage",
  "futureAction",
  "procedure",
  "family",
  "regulatoryEffect",
  "filingEvidence",
]);

function clean(value, max = 240) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function first(values) {
  return Array.isArray(values) && values.length ? values[0] : null;
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

/** NTA geography keys only — community-district and other layers stay out of Land handoff. */
export function nearYouLandNtaKeysFromScope(input = {}) {
  const keys = geographyKeysFromScope(input)
    .map(normalizeGeographyKey)
    .filter((key) => key && NTA_GEOGRAPHY_RE.test(key));
  return Object.freeze(normalizeLandNtaGeographyKeys(keys).keys);
}

function facetValue(scope, key) {
  const values = scope?.facets?.values && typeof scope.facets.values === "object"
    ? scope.facets.values
    : {};
  if (values[key] != null && values[key] !== "") return values[key];
  return null;
}

/**
 * Build the Land filter state a Near You land view hands off.
 *
 * Defaults to `status=all` and `stage=any` so membership matches the unfiltered place index.
 * Supported Land facets already present on the Near You scope are copied; borough/CD/council
 * axes are left empty so an NTA question is not rewritten as a district filter.
 */
export function landFilterStateFromNearYouScope(input = {}) {
  const scope = scopeWithGeographies(input);
  const ntaKeys = nearYouLandNtaKeysFromScope(scope);
  const bag = {
    status: "all",
    stage: "any",
    futureAction: "any",
    procedure: facetValue(scope, "procedure"),
    family: facetValue(scope, "family"),
    regulatoryEffect: facetValue(scope, "regulatoryEffect"),
    filingEvidence: facetValue(scope, "filingEvidence"),
    borough: "",
    communityDistrict: "",
    councilDistrict: "",
    keyword: clean(scope.topic?.query || first(scope.topic?.keywords), 320),
    geographies: ntaKeys.length ? [...ntaKeys] : null,
  };

  const stageOverride = facetValue(scope, "stage");
  if (stageOverride) bag.stage = stageOverride;
  const statusOverride = facetValue(scope, "status");
  if (statusOverride) bag.status = statusOverride;
  const futureOverride = facetValue(scope, "futureAction") || facetValue(scope, "future");
  if (futureOverride) bag.futureAction = futureOverride;

  const params = landFilterStateToSearchParams(bag);
  return landFilterStateFromRouteParams(params);
}

/** Land results document href carrying canonical NTA scope and supported facets. */
export function nearYouLandResultsHref(input = {}, { base = NEAR_YOU_LAND_RESULTS_BASE } = {}) {
  const state = landFilterStateFromNearYouScope(input);
  return landBrowseHrefFromState(state, { base });
}

/**
 * Full-record destination for one project id.
 *
 * When a Near You / Land filter state (or scope) is supplied, the href carries
 * allowlisted geography and facet query params beside `#land/{id}` so Back and
 * copied links restore the same place context.
 */
export function nearYouLandRecordHref(projectId, input = null) {
  const bare = landProjectPath(projectId);
  if (!bare) return null;
  if (!input || typeof input !== "object") return bare;
  const filter = input.landFilter
    || input.state
    || (input.scope ? landFilterStateFromNearYouScope(input.scope) : null);
  if (!filter && !input.geographies && input.view == null && !input.boundaries) return bare;
  const continuity = placeNavigationStateFromParts({
    landFilter: filter || landFilterStateFromRouteParams(new URLSearchParams()),
    geographies: input.geographies || null,
    projectId,
    view: input.view ?? filter?.view ?? null,
    boundaries: input.boundaries || null,
    surface: "land",
  });
  return placeNavigationLandDetailHref(continuity) || bare;
}

/** Near You return path for the same geography and land lens. */
export function nearYouLandReturnHref(input = {}, { base = NEAR_YOU_LAND_RETURN_BASE } = {}) {
  const scope = scopeWithGeographies({
    ...input,
    facets: {
      ...(input?.facets || {}),
      domains: ["land"],
      values: { ...(input?.facets?.values || {}) },
    },
  }, nearYouLandNtaKeysFromScope(input));
  return nearYouUrlFromScope(scope, { base });
}

/**
 * Pre-limit canonical project ids for the handoff query (L05 before limits, L06 parity).
 *
 * Uses the place-membership constraint and the same filterLandSnapshot path Land browse uses,
 * with limit raised to the catalog size so the comparison set is the full eligible population.
 */
export function nearYouLandPreLimitIds({
  scope = null,
  state = null,
  catalogRows = [],
  placeMembership = null,
  today = null,
} = {}) {
  const resolvedState = state || landFilterStateFromNearYouScope(scope || {});
  const rows = Array.isArray(catalogRows) ? catalogRows : [];
  const query = landSnapshotQueryFromState(resolvedState, {
    placeMembership,
    today: today || undefined,
    limit: Math.max(rows.length, 1),
  });
  return Object.freeze(landCanonicalIds(filterLandSnapshot(rows, query)));
}

/**
 * Resolve a requested project selection against the pre-limit population.
 *
 * When the id remains eligible it is kept. When data changes remove it, selection clears and the
 * return path is the matching Near You land URL — never an unrelated substitute record.
 */
export function resolveNearYouLandSelection({
  projectId = null,
  preLimitIds = [],
  scope = null,
  population = null,
} = {}) {
  const id = clean(projectId, 32);
  const ids = Array.isArray(preLimitIds) ? preLimitIds.map(String) : [];
  const inScope = Boolean(id && PROJECT_ID_RE.test(id) && ids.includes(id));
  const painted = inScope ? id : null;
  const selected = nextLandMapSelection({
    requested: id,
    painted,
    population: population == null ? ids.length : population,
  });
  const returnHref = nearYouLandReturnHref(scope || {});
  const resultsHref = nearYouLandResultsHref(scope || {});
  if (selected) {
    return freezeDeep({
      status: "selected",
      project_id: selected,
      record_href: nearYouLandRecordHref(selected, { scope }),
      results_href: resultsHref,
      return_href: returnHref,
    });
  }
  return freezeDeep({
    status: "cleared",
    project_id: null,
    record_href: null,
    results_href: resultsHref,
    return_href: returnHref,
    reason: id ? "project_out_of_scope" : "no_project",
  });
}

/**
 * Build the full handoff packet Near You renders for a land view.
 *
 * Preview remains a separate button elsewhere; this packet only supplies the two real anchors
 * (matching Land results, and optional full-record) plus selection/return resolution.
 */
export function buildNearYouLandHandoff({
  scope = null,
  projectId = null,
  catalogRows = [],
  placeMembership = null,
  today = null,
} = {}) {
  const state = landFilterStateFromNearYouScope(scope || {});
  const resultsHref = landBrowseHrefFromState(state);
  const returnHref = nearYouLandReturnHref(scope || {});
  const preLimitIds = nearYouLandPreLimitIds({
    state,
    catalogRows,
    placeMembership,
    today,
  });
  const selection = resolveNearYouLandSelection({
    projectId,
    preLimitIds,
    scope,
    population: preLimitIds.length,
  });
  const recordHref = selection.status === "selected"
    ? selection.record_href
    : (PROJECT_ID_RE.test(clean(projectId, 32))
      ? nearYouLandRecordHref(projectId, { state, scope })
      : null);

  return freezeDeep({
    schema: NEAR_YOU_LAND_HANDOFF_SCHEMA,
    state,
    nta_keys: nearYouLandNtaKeysFromScope(scope || {}),
    results_href: resultsHref,
    record_href: recordHref,
    return_href: returnHref,
    pre_limit_ids: preLimitIds,
    selection,
  });
}

function hrefLeaksPrivateOrExternal(href) {
  const findings = [];
  const value = String(href || "");
  if (!value) return findings;
  if (/^(?:https?:)?\/\/(?!cityscroll\.org(?:\/|$))/i.test(value) && !value.startsWith("/")) {
    findings.push("external_destination");
  }
  if (/[?&#](?:return|returnUrl|return_to|next|redirect)=/i.test(value)) {
    findings.push("arbitrary_return_url");
  }
  if (/(?:address|street|victory|boulevard)=/i.test(value)) {
    findings.push("raw_address_param");
  }
  if (/geo=geography:community_district:/i.test(value)) {
    findings.push("nta_converted_to_community_district");
  }
  return findings;
}

/**
 * Positive-control checker for handoff destinations.
 *
 * Empty findings mean the destination carries only canonical NTA geography and supported Land
 * facets. Supply a deliberately leaking href to prove the checker can fail.
 */
export function nearYouLandHandoffFindings(input = {}) {
  const resultsHref = input.resultsHref ?? input.results_href ?? null;
  const recordHref = input.recordHref ?? input.record_href ?? null;
  const returnHref = input.returnHref ?? input.return_href ?? null;
  const state = input.state ?? null;
  const ntaKeys = input.ntaKeys ?? input.nta_keys ?? null;

  const findings = [];
  const results = String(resultsHref || "");
  if (!results.startsWith(NEAR_YOU_LAND_RESULTS_BASE)) {
    findings.push("results_href_not_land_browse");
  }
  findings.push(...hrefLeaksPrivateOrExternal(results).map((code) => `results:${code}`));
  findings.push(...hrefLeaksPrivateOrExternal(recordHref).map((code) => `record:${code}`));
  findings.push(...hrefLeaksPrivateOrExternal(returnHref).map((code) => `return:${code}`));

  if (returnHref && !String(returnHref).startsWith(NEAR_YOU_LAND_RETURN_BASE)) {
    findings.push("return_href_not_near_you");
  }

  const keys = Array.isArray(ntaKeys)
    ? ntaKeys
    : (Array.isArray(state?.geographies) ? state.geographies : []);
  for (const key of keys) {
    if (!NTA_GEOGRAPHY_RE.test(String(key))) findings.push(`non_nta_geography:${key}`);
  }

  if (state) {
    if (state.communityDistrict) findings.push("community_district_filter_present");
    if (state.councilDistrict) findings.push("council_district_filter_present");
    if (Array.isArray(state.geographies) && state.geographies.length) {
      const params = landFilterStateToSearchParams(state);
      const encoded = params.getAll("geo");
      for (const key of state.geographies) {
        if (!encoded.includes(key)) findings.push(`geo_not_encoded:${key}`);
      }
    }
  }

  if (recordHref) {
    const match = String(recordHref).match(/\/browse\/zoning\/(?:\?[^#]*)?#land\/([^/?#]+)/);
    if (!match) {
      findings.push("record_href_not_land_project");
    } else {
      let projectId = match[1];
      try {
        projectId = decodeURIComponent(projectId);
      } catch (_error) {
        findings.push("record_href_invalid_project");
        projectId = "";
      }
      if (projectId && !landProjectPath(projectId)) findings.push("record_href_invalid_project");
    }
    // Continuity-aware record links (document query + hash) must keep NTA geography.
    if (String(recordHref).includes("?")) {
      const expected = Array.isArray(ntaKeys) && ntaKeys.length
        ? ntaKeys
        : (Array.isArray(state?.geographies) ? state.geographies : []);
      if (expected.length) {
        const url = new URL(String(recordHref), "https://cityscroll.org");
        const encoded = url.searchParams.getAll("geo");
        for (const key of expected) {
          if (!encoded.includes(key)) findings.push(`record_geo_not_encoded:${key}`);
        }
      }
    }
  }

  return findings;
}

/**
 * Geography constraint helper exposed for tests that assert membership before limits.
 *
 * @param {string[]} keys
 * @param {object|null} membershipIndex
 */
export function nearYouLandGeographyConstraint(keys, membershipIndex = null) {
  return resolveLandNtaGeographyConstraint(keys, membershipIndex);
}

export {
  landFilterStateToSearchParams,
  landBrowseHrefFromState,
  LAND_FACET_KEYS,
};
