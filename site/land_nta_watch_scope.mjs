/**
 * Land neighborhood watch parity — scope ↔ wire aliases, save admission, and
 * pre-limit matching ID sets shared by browse, preview, and delivery.
 *
 * Extends the existing geography watch path (scopeWithGeographies /
 * watchFromGeographyScope / district_activity transform) rather than adding a
 * second subscription type. Display limits and transient address narrowing are
 * never saved as membership filters.
 */

import {
  LAND_FILTER_DIMENSIONS,
  LAND_DEFAULT_RESULT_LIMIT,
  landCanonicalIds,
  landSemanticScopeFromState,
  resolveLandNtaGeographyConstraint,
} from "./land_filter_parity.mjs";
import { filterLandSnapshot } from "./resident_snapshot_queries.mjs";
import { normalizeGeographyKey } from "./scope_v0.mjs";
import { normalizeLandFilingEvidenceFilter } from "./land_filing_evidence_facet.mjs";
import { normalizeLandStage } from "./land_status_facets.mjs";

export const LAND_NTA_WATCH_SCOPE_SCHEMA = "cityscroll.land_nta_watch_scope.v1";
export const LAND_GEOGRAPHY_ARTIFACT_UNAVAILABLE = "LAND_GEOGRAPHY_ARTIFACT_UNAVAILABLE";

/** reachesWatchScope query keys that a saved Land watch may carry. */
export const LAND_WATCH_DIMENSION_KEYS = Object.freeze(
  LAND_FILTER_DIMENSIONS
    .filter((dimension) => dimension.reachesWatchScope)
    .map((dimension) => dimension.queryKey),
);

/**
 * Route/wire aliases for each Land watch dimension.
 * Canonical query keys stay stable; subscribe/storage uses the wire name.
 */
export const LAND_WATCH_WIRE_ALIASES = Object.freeze({
  status: Object.freeze({ queryKey: "status", wireKey: "status", routeKey: "status" }),
  stage: Object.freeze({ queryKey: "stage", wireKey: "stage", routeKey: "stage" }),
  futureAction: Object.freeze({ queryKey: "futureAction", wireKey: "futureAction", routeKey: "future" }),
  procedure: Object.freeze({ queryKey: "procedure", wireKey: "procedure", routeKey: "procedure" }),
  family: Object.freeze({ queryKey: "family", wireKey: "family", routeKey: "family" }),
  regulatoryEffect: Object.freeze({ queryKey: "regulatoryEffect", wireKey: "regulatoryEffect", routeKey: null }),
  filingEvidence: Object.freeze({ queryKey: "filingEvidence", wireKey: "filingEvidence", routeKey: null }),
  borough: Object.freeze({ queryKey: "borough", wireKey: "boro", routeKey: "boro" }),
  communityDistrict: Object.freeze({ queryKey: "communityDistrict", wireKey: "communityDistrict", routeKey: "cd" }),
  councilDistrict: Object.freeze({ queryKey: "councilDistrict", wireKey: "councilDistrict", routeKey: "council" }),
  keyword: Object.freeze({ queryKey: "keyword", wireKey: "keywords", routeKey: "q" }),
  geographies: Object.freeze({ queryKey: "geographies", wireKey: "geographies", routeKey: "geo" }),
});

const WIRE_TO_QUERY = Object.freeze({
  status: "status",
  stage: "stage",
  futureAction: "futureAction",
  future: "futureAction",
  procedure: "procedure",
  family: "family",
  regulatoryEffect: "regulatoryEffect",
  filingEvidence: "filingEvidence",
  borough: "borough",
  boro: "borough",
  communityDistrict: "communityDistrict",
  cd: "communityDistrict",
  councilDistrict: "councilDistrict",
  council: "councilDistrict",
  keyword: "keyword",
  keywords: "keyword",
  q: "keyword",
  geographies: "geographies",
  geography: "geographies",
  geo: "geographies",
});

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function cleanText(value) {
  return value == null ? "" : String(value).replace(/\s+/g, " ").trim();
}

function sortedUnique(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))].sort();
}

function hasProjectIdNarrowing(raw) {
  const input = asObject(raw) || {};
  if (Array.isArray(input.projectIds) && input.projectIds.length) return true;
  if (Array.isArray(input.project_ids) && input.project_ids.length) return true;
  return false;
}

function rawGeographyIntent(raw) {
  const input = asObject(raw) || {};
  if (Object.prototype.hasOwnProperty.call(input, "geographies")) return true;
  if (Object.prototype.hasOwnProperty.call(input, "geography")) return true;
  if (Object.prototype.hasOwnProperty.call(input, "geo")) return true;
  return false;
}

function readGeographyKeys(raw) {
  const input = asObject(raw) || {};
  const value = input.geographies ?? input.geography ?? input.geo ?? null;
  if (value == null) return null;
  const list = Array.isArray(value) ? value : [value];
  return list.map((entry) => String(entry ?? "").trim()).filter(Boolean);
}

function readKeyword(raw) {
  const input = asObject(raw) || {};
  if (typeof input.keyword === "string" && cleanText(input.keyword)) return cleanText(input.keyword);
  if (typeof input.q === "string" && cleanText(input.q)) return cleanText(input.q);
  if (Array.isArray(input.keywords)) {
    const first = input.keywords.map(cleanText).find(Boolean);
    return first || "";
  }
  return "";
}

/**
 * Normalize mixed route/wire/semantic Land filter bags into canonical query keys.
 * Does not clamp vocabulary — prepareLandNtaWatchFilter owns admission.
 */
export function normalizeLandWatchFilterInput(raw = {}) {
  const input = asObject(raw) || {};
  const out = {};

  for (const [wireKey, queryKey] of Object.entries(WIRE_TO_QUERY)) {
    if (queryKey === "geographies" || queryKey === "keyword" || queryKey === "borough") continue;
    if (!Object.prototype.hasOwnProperty.call(input, wireKey)) continue;
    if (out[queryKey] != null && out[queryKey] !== "") continue;
    const value = input[wireKey];
    if (value == null || value === "") continue;
    out[queryKey] = value;
  }

  const borough = cleanText(input.borough || input.boro || "");
  if (borough) out.borough = borough;

  const keyword = readKeyword(input);
  if (keyword) out.keyword = keyword;

  const geos = readGeographyKeys(input);
  if (geos) out.geographies = geos;

  // Explicitly ignore non-membership fields so callers cannot smuggle them through.
  void input.limit;
  void input.projectIds;
  void input.project_ids;

  return out;
}

/**
 * Canonical semantic scope → Land watch wire filter (boro / keywords / …).
 */
export function landWatchWireFilterFromSemantic(semantic = {}) {
  const scope = asObject(semantic) || {};
  const wire = {};
  for (const key of LAND_WATCH_DIMENSION_KEYS) {
    const alias = LAND_WATCH_WIRE_ALIASES[key];
    if (!alias) continue;
    const value = scope[key];
    if (key === "geographies") {
      if (!Array.isArray(value) || !value.length) continue;
      wire.geographies = sortedUnique(value.map(normalizeGeographyKey).filter(Boolean));
      continue;
    }
    if (key === "keyword") {
      const text = cleanText(value);
      if (!text) continue;
      wire.keywords = [text.toLowerCase()];
      continue;
    }
    if (key === "borough") {
      const borough = cleanText(value);
      if (!borough) continue;
      wire.boro = borough;
      continue;
    }
    if (value == null || value === "") continue;
    wire[alias.wireKey] = value;
  }
  return wire;
}

/**
 * Wire filter → semantic scope keys used by landSemanticScopeFromState.
 */
export function landSemanticScopeFromWatchFilter(raw = {}) {
  const normalized = normalizeLandWatchFilterInput(raw);
  const state = {
    status: normalized.status || "active",
    stage: normalized.stage || "active",
    futureAction: normalized.futureAction || "any",
    procedure: normalized.procedure || "review",
    family: normalized.family || "any",
    regulatoryEffect: normalized.regulatoryEffect || "any",
    filingEvidence: normalizeLandFilingEvidenceFilter(normalized.filingEvidence || "any"),
    borough: normalized.borough || "",
    communityDistrict: normalized.communityDistrict || "",
    councilDistrict: normalized.councilDistrict || "",
    keyword: normalized.keyword || "",
    geographies: Array.isArray(normalized.geographies) ? normalized.geographies : null,
    attendance: "",
    closingWeek: false,
    view: "list",
    limit: LAND_DEFAULT_RESULT_LIMIT,
  };
  if (normalized.stage) state.stage = normalizeLandStage(normalized.stage, state.stage);
  return landSemanticScopeFromState(state);
}

/**
 * Admission gate before sanitize/prepareWatchFilter for Land neighborhood watches.
 *
 * Refuses transient address narrowing and geography intent that would sanitize
 * into a broader (citywide) watch. Display limits are never admitted.
 */
export function prepareLandNtaWatchFilter(raw = {}) {
  const input = asObject(raw) || {};

  if (hasProjectIdNarrowing(input)) {
    return Object.freeze({
      ok: false,
      reason: "land-address-narrowing-present",
      correction: "clear_address_narrowing",
      filter: null,
    });
  }

  if (Object.prototype.hasOwnProperty.call(input, "limit") && input.limit != null) {
    // A limit may appear on browse state; saving must drop it rather than treat it
    // as membership. Presence alone is not a hard refuse when it is only the
    // presentation default — strip it. An explicit attempt to persist limit as a
    // filter field still strips; membership is never limited by display size.
  }

  const normalized = normalizeLandWatchFilterInput(input);
  const geographyIntent = rawGeographyIntent(input);
  const rawKeys = readGeographyKeys(input);
  const admittedKeys = Array.isArray(normalized.geographies)
    ? sortedUnique(normalized.geographies.map(normalizeGeographyKey).filter(Boolean))
    : [];

  if (geographyIntent) {
    if (!rawKeys || !rawKeys.length) {
      return Object.freeze({
        ok: false,
        reason: "land-geography-empty",
        correction: "choose_valid_neighborhood",
        filter: null,
      });
    }
    if (!admittedKeys.length) {
      return Object.freeze({
        ok: false,
        reason: "land-geography-invalid",
        correction: "choose_valid_neighborhood",
        filter: null,
      });
    }
  }

  const wire = landWatchWireFilterFromSemantic({
    ...normalized,
    geographies: admittedKeys.length ? admittedKeys : normalized.geographies,
  });

  return Object.freeze({
    ok: true,
    reason: null,
    correction: null,
    filter: Object.freeze(wire),
    semantic: landSemanticScopeFromWatchFilter(wire),
  });
}

/**
 * Classify the district-activity / Near You geography artifact for Land watches.
 */
export function landGeographyArtifactState(payload) {
  const root = asObject(payload?.activity) || asObject(payload) || {};
  const items = asObject(root.geography_items);
  if (!items || typeof items.by_key !== "object" || items.by_key == null) {
    return Object.freeze({ status: "unavailable", reason: "missing_geography_items", items: null, coverage: null });
  }
  const coverage = asObject(items.coverage?.by_lens?.land) || asObject(items.coverage?.land) || null;
  if (!coverage) {
    return Object.freeze({ status: "unavailable", reason: "missing_land_coverage", items, coverage: null });
  }
  if (coverage.status === "unavailable" || coverage.status === "failed") {
    return Object.freeze({ status: "unavailable", reason: "land_coverage_unavailable", items, coverage });
  }
  return Object.freeze({ status: "ready", reason: null, items, coverage });
}

export function assertLandGeographyArtifact(payload) {
  const state = landGeographyArtifactState(payload);
  if (state.status !== "ready") {
    const error = new Error(`land geography artifact unavailable (${state.reason || "unknown"})`);
    error.code = LAND_GEOGRAPHY_ARTIFACT_UNAVAILABLE;
    error.artifactState = state;
    throw error;
  }
  return state;
}

/**
 * Bounded-coverage disclosure for a saved Land neighborhood watch.
 * Partial spatial coverage never becomes an assurance that every local project is monitored.
 */
export function landNtaWatchCoverageDisclosure(coverage) {
  const cov = asObject(coverage) || {};
  const matched = Number(cov.spatially_matched);
  const admitted = Number(cov.admitted);
  const partial = Number(cov.partially_covered);
  const bounded = Number.isFinite(matched) && Number.isFinite(admitted) && matched < admitted;
  return Object.freeze({
    schema: LAND_NTA_WATCH_SCOPE_SCHEMA,
    monitoring: "published_project_lot_membership",
    association_kind: cov.association_kind || "published_project_lot",
    bounded_to_matched_lots: bounded || (Number.isFinite(partial) && partial > 0),
    assurance: "matched_published_lots_only",
    spatially_matched: Number.isFinite(matched) ? matched : null,
    admitted: Number.isFinite(admitted) ? admitted : null,
    partially_covered: Number.isFinite(partial) ? partial : null,
  });
}

function membershipIdsFromActivity(items, geographyKeys, lens = "land") {
  const keys = sortedUnique((geographyKeys || []).map(normalizeGeographyKey).filter(Boolean));
  if (!keys.length) return [];
  // OR across selected NTA keys (same contract as Land browse geography filters).
  const ids = new Set();
  for (const key of keys) {
    const list = items?.by_key?.[key]?.[lens];
    if (!Array.isArray(list)) continue;
    for (const id of list) {
      const clean = cleanText(id);
      if (clean) ids.add(clean);
    }
  }
  return [...ids].sort();
}

/**
 * Pre-limit canonical project IDs for a Land geography watch.
 *
 * `source: "browse"` uses place-membership + catalog (Near You / Land browse).
 * `source: "activity"` uses district_activity membership IDs ∩ catalog facets
 * (watch preview / delivery transform).
 */
export function landNtaWatchMatchingIds({
  filter = {},
  catalogRows = [],
  placeMembership = null,
  activityPayload = null,
  source = "browse",
  today = null,
  actionRows = [],
} = {}) {
  const prepared = prepareLandNtaWatchFilter(filter);
  if (!prepared.ok) {
    return Object.freeze({
      status: "refused",
      reason: prepared.reason,
      correction: prepared.correction,
      ids: Object.freeze([]),
      disclosure: null,
    });
  }
  const wire = prepared.filter;
  const semantic = prepared.semantic;
  const geographies = Array.isArray(wire.geographies) ? wire.geographies : [];

  let memberIds = null;
  let disclosure = null;

  if (source === "activity") {
    const artifact = assertLandGeographyArtifact(activityPayload);
    disclosure = landNtaWatchCoverageDisclosure(artifact.coverage);
    memberIds = membershipIdsFromActivity(artifact.items, geographies, "land");
  } else {
    if (geographies.length) {
      const constraint = resolveLandNtaGeographyConstraint(geographies, placeMembership);
      if (constraint.status === "unavailable") {
        return Object.freeze({
          status: "unavailable",
          reason: "place_membership_unavailable",
          correction: null,
          ids: Object.freeze([]),
          disclosure: null,
        });
      }
      memberIds = [...(constraint.projectIds || [])];
    }
    if (placeMembership?.layers || placeMembership?.generation) {
      // Prefer generation coverage counts when the browse index is present.
      const layer = placeMembership?.layers?.nta2020 || placeMembership?.layers?.nta || null;
      disclosure = landNtaWatchCoverageDisclosure({
        association_kind: placeMembership.association_kind,
        spatially_matched: layer?.matched ?? placeMembership?.spatially_matched,
        admitted: placeMembership.project_count ?? placeMembership?.admitted,
        partially_covered: layer?.partial ?? placeMembership?.partially_covered,
      });
    }
  }

  const query = {
    status: wire.status || semantic.status || "active",
    stage: wire.stage || semantic.stage || null,
    futureAction: wire.futureAction || semantic.futureAction || "any",
    procedure: wire.procedure || semantic.procedure,
    family: wire.family || semantic.family,
    regulatoryEffect: wire.regulatoryEffect || semantic.regulatoryEffect || "any",
    filingEvidence: wire.filingEvidence || semantic.filingEvidence || "any",
    borough: wire.boro || semantic.borough || "",
    communityDistrict: wire.communityDistrict || semantic.communityDistrict || "",
    councilDistrict: wire.councilDistrict || semantic.councilDistrict || "",
    keyword: Array.isArray(wire.keywords) && wire.keywords[0]
      ? wire.keywords[0]
      : (semantic.keyword || ""),
    // Geography already applied via memberIds for both sources.
    geographies: null,
    projectIds: memberIds,
    placeMembership: null,
    actionRows,
    today,
    // Pre-limit: watches subscribe to the full matching set, not the list page size.
    limit: Math.max(catalogRows.length, memberIds?.length || 0, 1),
  };

  const rows = filterLandSnapshot(catalogRows, query);
  return Object.freeze({
    status: "ready",
    reason: null,
    correction: null,
    ids: Object.freeze(landCanonicalIds(rows)),
    disclosure,
    wire,
    semantic,
  });
}

/**
 * Transform a district_activity / Near You payload into Land watch delivery rows
 * whose IDs match the pre-limit browse membership for the same filter.
 */
export function transformLandGeographyWatchRows(payload, filter = {}, {
  catalogRows = [],
  today = null,
  actionRows = [],
} = {}) {
  const match = landNtaWatchMatchingIds({
    filter,
    catalogRows,
    activityPayload: payload,
    source: "activity",
    today,
    actionRows,
  });
  if (match.status !== "ready") {
    if (match.status === "unavailable" || match.reason === "place_membership_unavailable") {
      const error = new Error(`land geography artifact unavailable (${match.reason || "unknown"})`);
      error.code = LAND_GEOGRAPHY_ARTIFACT_UNAVAILABLE;
      throw error;
    }
    return Object.freeze([]);
  }

  const artifact = assertLandGeographyArtifact(payload);
  const root = asObject(payload?.activity) || asObject(payload) || {};
  const records = asObject(root.records?.land) || {};
  const idSet = new Set(match.ids);
  return match.ids.map((id) => {
    const record = records[id] || { id, title: id };
    return {
      ...record,
      id,
      geography_item_id: `land:${id}`,
      request_id: null,
      project_id: id,
      short_title: record.title || id,
      agency_name: record.agency || null,
      start_date: record.date || null,
      type_of_notice_description: record.type || null,
      land_watch_coverage: match.disclosure,
      _artifact_coverage_status: artifact.coverage?.status || null,
    };
  }).filter((row) => idSet.has(row.project_id));
}

/** Positive-control detector: reports when a transform silently broadened past geography. */
export function landNtaWatchBroadeningFindings({
  filter = {},
  deliveredIds = [],
  catalogRows = [],
  placeMembership = null,
} = {}) {
  const findings = [];
  const prepared = prepareLandNtaWatchFilter(filter);
  if (!prepared.ok) return Object.freeze(findings);
  const geos = prepared.filter.geographies || [];
  if (!geos.length) return Object.freeze(findings);

  const expected = landNtaWatchMatchingIds({
    filter: prepared.filter,
    catalogRows,
    placeMembership,
    source: "browse",
  });
  if (expected.status !== "ready") {
    findings.push(`browse oracle unavailable: ${expected.reason}`);
    return Object.freeze(findings);
  }
  const expectedSet = new Set(expected.ids);
  for (const id of deliveredIds) {
    if (!expectedSet.has(id)) findings.push(`delivered id outside geography membership: ${id}`);
  }
  return Object.freeze(findings);
}
