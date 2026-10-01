import {
  MAP_LENSES,
  BOROUGH_META,
  BOROUGH_HULLS,
  bboxToViewBox,
  defaultViewBox,
  mapFeatures,
} from "./map_exploration.mjs";
import {
  nearYouUrlFromScope,
  geographyKeysFromScope,
  scopeWithGeographies,
  normalizeScope,
  PLACE_ROLES,
  placeRoleSupportedForDomain,
  routeHashFromScope,
  watchFromScope,
} from "./scope_v0.mjs";
import { ACTION_LOCATION_BASIS_LABELS } from "./contract_action_location.mjs";
import { civicGeographyKey } from "./civic_geography_registry.mjs";
import { allNycRecordsRouteHash, scopeForAllNycRecords, scopeWithPlace } from "./near_you_scope_runtime.mjs";
import {
  GEOGRAPHY_RECORD_LENSES,
  geographyKeyForScope,
  geographyPlaceSuggestions,
  geographyRecordProjection,
  geographyRecordLenses,
  recordIdsForScope,
  scopeWithCanonicalGeography,
} from "./geography_navigation_records.mjs";
import { followingUrlFromWatch } from "./following_view.mjs";
import { migrateLegacyUrl } from "./route_migration.mjs";
import {
  placeRoleForBasis,
  selectNearYouExplanationPath,
  selectNearYouGeographyEvidence,
} from "./near_you_explanation_path.mjs";
import {
  renderCivicDocumentAssets,
  renderCivicDocumentMast,
} from "./civic_document_chrome.mjs";
import {
  buildPlaceLocalConstellation,
  councilDistrictsIntersectingCommunity,
} from "./community_board_geography.mjs";
import {
  BROADER_DISTRICT_PREVIEW_LIMIT,
  buildNearYouBroaderDistrictSection,
  renderNearYouBroaderDistrictsHtml,
} from "./near_you_broader_districts.mjs";
import { communityBoardPageHref } from "./community_board_links.mjs";
import { renderLocalConstellationHTML } from "./local_constellation.mjs";
import { renderWalkEntry, walkEntryHref, walkEntryPlaceLabel } from "./walk_entry.mjs";
import { meetingOriginLabel } from "./meeting_origin.mjs";
import { buildLocalDistrictFollowBundle } from "./local_district_follow_bundle.mjs";
import { renderFollowDiscoveryForNearYou } from "./follow_discovery.mjs";
import {
  landRecordHasFamilyEvidence,
  landRowMatchesFamily,
  normalizeLandFamily,
} from "./land_status_facets.mjs";
import {
  landRowMatchesRegulatoryEffect,
  normalizeLandRegulatoryEffect,
} from "./land_regulatory_effect.mjs";
import {
  nearYouLandRecordHref,
  nearYouLandResultsHref,
} from "./near_you_land_handoff.mjs";
import {
  NEAR_YOU_RECORD_TITLE_LINK_CLASS,
  nearYouEventTimeLabel,
  nearYouHeldInLabel,
  nearYouRecordInspectionFacts,
  nearYouRecordTiming,
  renderNearYouRecordFullRecordLink,
  renderNearYouRecordInspectButton,
} from "./near_you_record_inspection.mjs";
import {
  GEOGRAPHY_SHELL_DIRECTORY_FILTER_PARAM,
  aliasesByNtaIdFromGazetteer,
  geographyShellAreasListHtml,
  geographyShellPlaceSuggestionsHtml,
  geographyShellSearchFormHtml,
  geographyShellLayerSwitcherHtml,
  navigationAreaEntriesFromLayerDoc,
  navigationDirectoryFromLayerDoc,
  renderGeographyShellEntry,
  renderGeographyShellSurfaceSwitch,
  resolveShellSurface,
} from "./geography_navigation_shell.mjs";
import {
  GEOGRAPHY_NAVIGATION_DRAWER_OPEN,
  GEOGRAPHY_NAVIGATION_SURFACE_MAP,
  GEOGRAPHY_NAVIGATION_SURFACE_RECORDS,
  geographyNavigationUrlWithFilters,
  parseGeographyNavigationState,
} from "./geography_navigation_state.mjs";
import {
  GEOGRAPHY_NAVIGATION_AREA_OVERLAP_EXAMPLE,
} from "./geography_navigation_capability.mjs";
import neighborhoodGazetteer from "./data/neighborhood_gazetteer.json" with { type: "json" };
import {
  buildSelectedGeographyOverlapViewModel,
  renderSelectedGeographyOverlapDrawerHtml,
  resolveGeographyOwnerPresentation,
} from "./geography_navigation_overlap_ui.mjs";

const LENS_LABELS = Object.freeze({
  land: "Zoning",
  property: "Property",
  rules: "Rules",
  meetings: "Meetings",
  money: "Contracts",
  people: "Staffing",
  consultations: "Consultations",
});
const BAG_LABELS = Object.freeze({
  citywide: "Citywide",
  virtual: "Virtual / online only",
  unlocated: "No place signal",
});
/** Page titles for an explicit special-bucket route; none of them is a place. */
const NEAR_YOU_SPECIAL_SCOPE_TITLES = Object.freeze({
  citywide: "Citywide",
  virtual: "Online only",
  unlocated: "Without a mapped place",
});
const BOROUGHS = Object.keys(BOROUGH_META);
const NEAR_YOU_DATA_STATES = Object.freeze(["ready", "pending", "error"]);
/** Independently loaded sections: the requested scope and each special bucket. */
const NEAR_YOU_SECTIONS = Object.freeze(["primary", "citywide", "virtual", "unlocated"]);

/**
 * Per-section records state. A loader that reports section health decides each
 * section on its own; without it every section follows the page's dataState.
 */
function nearYouSectionStates(sections, dataState) {
  return Object.fromEntries(NEAR_YOU_SECTIONS.map((name) => {
    const state = sections?.[name]?.state;
    return [name, state === "ready" ? "ready" : state === "unavailable" ? "error" : dataState];
  }));
}
/** Geometry health is independent of records-loading state. */
const NEAR_YOU_GEOMETRY_STATES = Object.freeze(["ready", "pending", "missing", "error"]);

function normalizeNearYouGeometryState(value, {
  navigationLayerDoc = null,
  boundaries = null,
} = {}) {
  if (NEAR_YOU_GEOMETRY_STATES.includes(value)) return value;
  if (navigationLayerDoc && Array.isArray(navigationLayerDoc.features) && navigationLayerDoc.features.length) {
    return "ready";
  }
  if (boundaries && (
    (Array.isArray(boundaries.community_districts) && boundaries.community_districts.length)
    || (Array.isArray(boundaries.council_districts) && boundaries.council_districts.length)
    || (boundaries.boroughs && typeof boundaries.boroughs === "object" && Object.keys(boundaries.boroughs).length)
  )) {
    return "ready";
  }
  if (boundaries?.boundary_vintage || navigationLayerDoc?.vintage?.id) return "ready";
  return "missing";
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function first(values) {
  return Array.isArray(values) && values.length ? values[0] : null;
}

function normalizeNearYouDataState(value) {
  return NEAR_YOU_DATA_STATES.includes(value) ? value : "ready";
}

function knownCount(value) {
  return Number.isFinite(value) ? value : null;
}

function countMarkup(value) {
  return knownCount(value) == null
    ? `<span aria-label="Count unavailable">—</span>`
    : `<strong>${value}</strong>`;
}

function effectiveTimeWindow(scope, builtAt) {
  let start = scope.time_window.start ? Date.parse(scope.time_window.start) : NaN;
  let end = scope.time_window.end ? Date.parse(scope.time_window.end) : NaN;
  const anchor = Date.parse(builtAt || "");
  const preset = String(scope.time_window.preset || "").replace(/^closing:/, "");
  const days = preset === "today" ? 1 : preset === "week" ? 7 : preset === "month" ? 31 : null;
  if (days && Number.isFinite(anchor)) {
    start = anchor;
    end = anchor + days * 86400000;
  } else if (scope.time_window.rolling_months && Number.isFinite(anchor)) {
    start = anchor;
    end = anchor + Number(scope.time_window.rolling_months) * 31 * 86400000;
  }
  return { start, end };
}

function selectedMembership(record = {}, scope = {}) {
  const memberships = record?.place?.geographies || [];
  const explicit = scope.place?.geographies || [];
  const keys = explicit.length ? explicit : [
    first(scope.place?.community_districts) && civicGeographyKey("community_district", first(scope.place.community_districts)),
    first(scope.place?.council_districts) && civicGeographyKey("council_district", first(scope.place.council_districts)),
    first(scope.place?.boroughs) && ({ Manhattan: "1", Bronx: "2", Brooklyn: "3", Queens: "4", "Staten Island": "5" }[first(scope.place.boroughs)]
      ? civicGeographyKey("borough", { Manhattan: "1", Bronx: "2", Brooklyn: "3", Queens: "4", "Staten Island": "5" }[first(scope.place.boroughs)])
      : null),
  ].filter(Boolean);
  return keys.map((key) => memberships.find((membership) => membership.key === key)).find(Boolean) || null;
}

function membershipRole(record, scope) {
  const membership = selectedMembership(record, scope);
  return membership?.location_role || placeRoleForBasis(membership?.basis || record?.basis);
}

function recordMatches(record, scope, builtAt) {
  const lens = first(scope.facets.domains) || "meetings";
  const requestedPlaceRole = scope.facets.values?.place_role;
  // A refinement, never a new predicate: only a domain with typed venue/matter/affected-area
  // evidence (site/near_you_explanation_path.mjs) can honor the request. A record with no
  // district-specific evidence (citywide, virtual, unlocated, weak fallback) never satisfies
  // a specific role — see PS-02 acceptance A4-A6.
  if (requestedPlaceRole && PLACE_ROLES.includes(requestedPlaceRole) && placeRoleSupportedForDomain(lens)
    && membershipRole(record, scope) !== requestedPlaceRole) return false;
  const agency = first(scope.facets.agencies);
  if (agency && String(record.agency || "").toLowerCase() !== agency.toLowerCase()) return false;
  const type = scope.facets.values?.type || scope.facets.values?.noticeType;
  if (type && String(record.type || "").toLowerCase() !== String(type).toLowerCase()) return false;
  const actionBasis = scope.facets.values?.actionBasis;
  if (actionBasis && actionBasis !== "contract_action_address") {
    const methods = Array.isArray(record.basis_methods)
      ? record.basis_methods
      : [record.basis_method].filter(Boolean);
    if (!methods.includes(actionBasis)) return false;
  }
  const query = String(scope.topic.query || first(scope.topic.keywords) || "").trim().toLowerCase();
  if (query) {
    const haystack = [record.id, record.title, record.agency, record.type, record.status] // Source: district_activity.json records.
      .filter(Boolean).join(" ").toLowerCase();
    if (!haystack.includes(query)) return false;
  }
  const family = normalizeLandFamily(scope.facets.values?.family);
  if (family !== "any" && landRecordHasFamilyEvidence(record) && !landRowMatchesFamily(record, family)) return false;
  const regulatoryEffect = normalizeLandRegulatoryEffect(scope.facets.values?.regulatoryEffect);
  if (regulatoryEffect !== "any" && !landRowMatchesRegulatoryEffect(record, regulatoryEffect)) return false;
  const { start, end } = effectiveTimeWindow(scope, builtAt);
  const date = record.date ? Date.parse(record.date) : NaN;
  if (Number.isFinite(start) && (!Number.isFinite(date) || date < start)) return false;
  if (Number.isFinite(end) && (!Number.isFinite(date) || date > end)) return false;
  return true;
}

function intersection(ids, allowed) {
  return [...new Set((ids || []).map(String).filter((id) => allowed.has(id)))].sort();
}

function itemIdsForPlace(activity, lens, scope) {
  return recordIdsForScope(activity, lens, scope).ids;
}

function geographyRecordProjectionForArea(activity, lens, scope, key, allowed) {
  if (!activity?.geography_items) return { count: null, state: "unavailable" };
  const projection = geographyRecordProjection(activity, { key, lens });
  return {
    count: projection.exact ? intersection(projection.ids, allowed).length : null,
    state: projection.state,
    href: nearYouUrlFromScope(scopeWithCanonicalGeography({
      ...scope,
      place: { ...scope.place, geographies: [key] },
      facets: { ...scope.facets, domains: [lens] },
    }), { base: "https://cityscroll.invalid/near-you" }),
  };
}

function filteredActivity(activity, lens, allowed) {
  const index = activity?.district_items || {};
  const byLevel = {};
  for (const level of ["borough", "community_district", "council_district"]) {
    byLevel[level] = {};
    const ids = new Set([
      ...Object.keys(activity?.by_level?.[level] || {}),
      ...Object.keys(index?.by_level?.[level] || {}),
    ]);
    for (const id of ids) {
      const counts = { ...(activity?.by_level?.[level]?.[id] || {}) };
      counts[lens] = intersection(index?.by_level?.[level]?.[id]?.[lens], allowed).length;
      byLevel[level][id] = counts;
    }
  }
  const out = {
    ...activity,
    by_level: byLevel,
    citywide: { ...(activity?.citywide || {}), [lens]: intersection(index?.citywide?.[lens], allowed).length },
    virtual: { ...(activity?.virtual || {}), [lens]: intersection(index?.virtual?.[lens], allowed).length },
    unlocated: { ...(activity?.unlocated || {}), [lens]: intersection(index?.unlocated?.[lens], allowed).length },
  };
  return out;
}

function scopeForFeature(scope, feature) {
  const basis = scope.place.viewport?.basis || scope.facets.values?.basis || "performance";
  if (feature.level === "borough") {
    const next = scopeWithPlace(scope, { borough: feature.id });
    next.place.geographies = [civicGeographyKey("borough", feature.id)].filter(Boolean);
    next.place.viewport = {
      level: "community_district",
      id: null,
      parent: feature.id,
      basis,
      view_box: null,
    };
    return normalizeScope(next);
  }
  if (feature.level === "community_district") {
    const next = scopeWithPlace(scope, { communityDistrict: feature.id, borough: feature.parent });
    next.place.geographies = [civicGeographyKey("community_district", feature.id)].filter(Boolean);
    next.place.viewport = {
      level: "community_district",
      id: feature.id,
      parent: feature.parent,
      basis,
      view_box: null,
    };
    return normalizeScope(next);
  }
  const next = scopeWithPlace(scope, { councilDistrict: feature.id });
  next.place.geographies = [civicGeographyKey("council_district", feature.id)].filter(Boolean);
  next.place.viewport = {
    level: "council_district",
    id: feature.id,
    parent: null,
    basis,
    view_box: null,
  };
  return normalizeScope(next);
}

function scopeSummary(scope, lens, geographyDefinitions = {}) {
  const chips = [{ axis: "lens", label: LENS_LABELS[lens] || lens }];
  const values = [
    ["borough", first(scope.place.boroughs)],
    ["community district", formatCommunityDistrict(first(scope.place.community_districts))],
    ["council district", formatCouncilDistrict(first(scope.place.council_districts))],
    ["place basis", scope.place.location_scope && BAG_LABELS[scope.place.location_scope]],
    ["local activity", placeRoleSupportedForDomain(lens) && PLACE_ROLES.includes(scope.facets.values?.place_role)
      ? placeRoleUserLabel(scope.facets.values.place_role)
      : null],
    ["agency", first(scope.facets.agencies)],
    ["type", scope.facets.values?.type || scope.facets.values?.noticeType],
    ["keyword", scope.topic.query || first(scope.topic.keywords)],
    ["time", scope.time_window.preset],
    ["action", first(scope.facets.actions)],
    ["action type", (() => {
      const family = normalizeLandFamily(scope.facets.values?.family);
      return family !== "any" ? family.replace(/_/g, " ") : null;
    })()],
  ];
  for (const key of scope.place.geographies || []) {
    const definition = geographyDefinitions[key];
    if (!definition) continue;
    const axis = definition.type === "nta2020" ? "neighborhood tabulation area"
      : definition.type === "police_precinct" ? "police precinct" : "geography";
    values.splice(1, 0, [axis, definition.label]);
  }
  if (lens === "money" && (scope.place.viewport?.basis || scope.facets.values?.basis) === "contract_action_address") {
    values.push(["map basis", "Contract response address"]);
    const actionBasis = scope.facets.values?.actionBasis;
    if (actionBasis && actionBasis !== "contract_action_address") {
      values.push(["location basis", ACTION_LOCATION_BASIS_LABELS[actionBasis] || "Unknown location basis"]);
    }
  }
  for (const [axis, label] of values) if (label) chips.push({ axis, label: String(label) });
  return chips;
}

function formatCommunityDistrict(id) {
  if (!id) return null;
  const prefix = { M: "Manhattan", X: "Bronx", BX: "Bronx", K: "Brooklyn", Q: "Queens", R: "Staten Island", SI: "Staten Island" }[String(id).replace(/\d+$/, "")];
  const number = String(id).match(/(\d+)$/)?.[1];
  return prefix && number ? `${prefix} Community District ${Number(number)}` : `Community District ${id}`;
}

function formatCouncilDistrict(id) {
  return id ? `City Council District ${Number(id)}` : null;
}

function selectedPlacePresentation(scope, communityGeography = {}, {
  geographyState = null,
  geographyDefinitions = null,
  geographyLabelIndex = null,
  navigationLayerDoc = null,
} = {}) {
  const community = first(scope.place.community_districts);
  const council = first(scope.place.council_districts);
  const borough = first(scope.place.boroughs);
  if (community) {
    const edge = (communityGeography.public_edges || []).find((candidate) => candidate?.type === "covers"
      && candidate.to === `community-district:${community}`);
    const board = (communityGeography.nodes || []).find((candidate) => candidate?.id === edge?.from);
    const overlappingCouncilDistricts = councilDistrictsIntersectingCommunity(community, communityGeography);
    return {
      label: formatCommunityDistrict(community),
      boardLabel: board?.name || null,
      boardRef: board?.properties?.body_id ? `community-board:${board.properties.body_id}` : null,
      boardHref: board?.properties?.body_id ? communityBoardPageHref(board.properties.body_id) : null,
      overlappingCouncilLabels: overlappingCouncilDistricts.map((id) => formatCouncilDistrict(id)),
    };
  }
  if (council) return { label: formatCouncilDistrict(council) };
  if (borough) return { label: borough };
  if (scope.place.location_scope && NEAR_YOU_SPECIAL_SCOPE_TITLES[scope.place.location_scope]) {
    return { label: NEAR_YOU_SPECIAL_SCOPE_TITLES[scope.place.location_scope] };
  }
  if (scope.place.neighborhood) return { label: scope.place.neighborhood };
  const geoKey = geographyState?.key || first(scope.place.geographies);
  if (geoKey) {
    const definition = geographyDefinitions?.[geoKey]
      || (GEOGRAPHY_NAVIGATION_AREA_OVERLAP_EXAMPLE.selected.key === geoKey
        ? GEOGRAPHY_NAVIGATION_AREA_OVERLAP_EXAMPLE.selected
        : null);
    const owner = resolveGeographyOwnerPresentation({
      type: geographyState?.type || definition?.type || null,
      id: geographyState?.id || definition?.id || null,
      key: geoKey,
      label: definition?.label || null,
      boundary_vintage: definition?.boundary_vintage || null,
      labelIndex: geographyLabelIndex,
      layerDoc: navigationLayerDoc,
    });
    if (owner.label) {
      return {
        label: owner.label,
        geographyKey: geoKey,
        boundary_vintage: owner.boundary_vintage,
      };
    }
    return { label: geographyState?.id || geoKey, geographyKey: geoKey };
  }
  return { label: "Near you" };
}

function scopeWithoutAxis(scope, axis) {
  const next = structuredClone(scope);
  if (axis === "borough") next.place.boroughs = [];
  else if (axis === "community district") next.place.community_districts = [];
  else if (axis === "council district") next.place.council_districts = [];
  else if (axis === "keyword") next.topic = { ...(next.topic || {}), query: "", keywords: [] };
  else if (axis === "agency") next.facets.agencies = [];
  else if (axis === "type") next.facets.values = { ...(next.facets.values || {}), type: "" };
  else if (axis === "time") next.time_window = {};
  else if (axis === "local activity") next.facets.values = { ...(next.facets.values || {}), place_role: "" };
  return normalizeScope(next);
}

function watchHref(scope, lens, matchCount) {
  const watch = watchFromScope(scope, { lens });
  const geographies = geographyKeysFromScope(scope);
  if (geographies.length) watch.filter.geographies = geographies;
  return followingUrlFromWatch(watch, { matchCount });
}

function recordSort(a, b) {
  const dateA = Date.parse(a.date || "") || 0;
  const dateB = Date.parse(b.date || "") || 0;
  return dateB - dateA || String(a.title).localeCompare(String(b.title));
}

/** Records a special-bucket preview shows before its View all link. */
export const NEAR_YOU_SPECIAL_PREVIEW_LIMIT = 3;
const NEAR_YOU_PREVIEW_TIMING_RANK = Object.freeze({ upcoming: 0, past: 1, closed: 1 });

/**
 * Preview order for a special bucket, read through the record timing contract
 * at `now`: known future dates soonest first, then past dates most recent
 * first, then records without a published date; the record ID breaks ties.
 */
export function orderNearYouSpecialPreview(records, { now = null } = {}) {
  return (records || []).map((record) => {
    const timing = nearYouRecordTiming(record, { now });
    const source = timing.kind === "deadline"
      ? record.deadline || record.due_date || record.comment_by_date
      : record.event_date || record.date;
    const instant = Date.parse(source || "");
    return {
      record,
      rank: NEAR_YOU_PREVIEW_TIMING_RANK[timing.state] ?? 2,
      day: timing.event_at || "",
      instant: Number.isFinite(instant) ? instant : 0,
      id: String(record.id),
    };
  }).sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    const direction = a.rank === 1 ? -1 : 1;
    if (a.rank < 2 && a.day !== b.day) return (a.day < b.day ? -1 : 1) * direction;
    if (a.rank < 2 && a.instant !== b.instant) return (a.instant - b.instant) * direction;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }).map((entry) => entry.record);
}

/** A special-bucket collection opens as its own Records list. */
function withRecordsSurface(href) {
  const absolute = /^[a-z][a-z\d+.-]*:\/\//i.test(href);
  const url = new URL(href, "https://cityscroll.invalid");
  url.searchParams.set("surface", GEOGRAPHY_NAVIGATION_SURFACE_RECORDS);
  return absolute ? url.toString() : `${url.pathname}${url.search}`;
}

const INITIAL_RECORD_LIMIT = 30;

function viewBoardCoverage(scope, geography) {
  const community = first(scope.place.community_districts);
  if (!community) return "This place is not a Community Board district, so board activity is not applicable here.";
  const presentation = selectedPlacePresentation(scope, geography);
  return presentation.boardHref
    ? "Open the named Community Board to see its published meetings and actions. District membership does not imply board action."
    : "The Community Board covering this district is not identified in the retained geography sources.";
}

export function buildNearYouViewModel(inputScope, activity, boundaries, options = {}) {
  const scope = scopeWithCanonicalGeography(inputScope);
  const isOverview = scope.facets.domains.length === 0
    && !geographyKeysFromScope(scope).some((key) => key.startsWith("geography:nta2020:"));
  const requestedLens = first(scope.facets.domains) || "meetings";
  const lens = requestedLens;
  const dataState = normalizeNearYouDataState(options.dataState ?? (activity ? "ready" : "error"));
  // Record timing and preview order read this clock; unset, they read the current time.
  const now = options.now instanceof Date ? options.now.toISOString() : options.now || null;
  const geometryState = normalizeNearYouGeometryState(options.geometryState, {
    navigationLayerDoc: options.navigationLayerDoc || null,
    boundaries,
  });
  const mapped = MAP_LENSES.includes(lens) && lens !== "all";
  const basis = lens === "money"
    && (scope.place.viewport?.basis || scope.facets.values?.basis) === "contract_action_address"
    ? "contract_action_address"
    : "performance";
  const rootForBasis = (source) => {
    const layer = basis === "contract_action_address"
      ? source?.basis_layers?.contract_action_address
      : null;
    return layer
      ? { ...layer, boundary_vintage: source?.boundary_vintage, built_at: source?.built_at }
      : source;
  };
  const basisLayer = basis === "contract_action_address"
    ? activity?.basis_layers?.contract_action_address
    : null;
  const activityRoot = rootForBasis(activity);
  const sectionStates = nearYouSectionStates(options.sections, dataState);
  const records = dataState === "ready" ? activityRoot?.records?.[lens] || {} : {};
  const allowed = new Set(Object.values(records)
    .filter((record) => recordMatches(record, scope, activity?.built_at))
    .map((record) => String(record.id)));
  const membershipProjection = dataState === "ready"
    ? recordIdsForScope(activityRoot, lens, scope)
    : { exact: false, ids: [], state: dataState === "pending" ? "unavailable" : "error" };
  const localMembershipAvailable = dataState === "ready" && mapped && membershipProjection.exact;
  const scopedActivity = localMembershipAvailable
    ? filteredActivity(activityRoot, lens, allowed)
    : null;
  const viewport = scope.place.viewport || {};
  const level = ["borough", "community_district", "council_district"].includes(viewport.level)
    ? viewport.level
    : "borough";
  const parent = level === "community_district"
    ? viewport.parent || first(scope.place.boroughs)
    : null;
  const mappedFeatures = dataState === "ready" && mapped
    ? mapFeatures(boundaries, scopedActivity, { level, parent, lens })
    : { features: [], max: 0, lens };
  const canonicalBase = options.canonicalBase || "https://cityscroll.org/near-you";
  const urlForScope = typeof options.urlForScope === "function"
    ? options.urlForScope
    : (nextScope) => nearYouUrlFromScope(nextScope, { base: canonicalBase });
  const siteBase = String(options.siteBase || "").replace(/\/$/, "");
  const siteHref = (path) => `${siteBase}${path}`;
  const migratedSiteHref = (path) => siteHref(migrateLegacyUrl(path).target);
  const features = mappedFeatures.features.map((feature) => ({
    ...feature,
    href: urlForScope(scopeForFeature(scope, feature)),
  }));
  const resultIds = localMembershipAvailable
    ? intersection(membershipProjection.ids, allowed)
    : [];
  const resultCount = localMembershipAvailable ? resultIds.length : null;
  // Records-loading state governs only records. Geometry health owns mapState.
  const mapState = geometryState === "pending"
    ? "pending"
    : geometryState === "missing"
      ? "missing"
      : geometryState === "error"
        ? "error"
        : dataState === "ready"
          ? (!mapped || !localMembershipAvailable
            ? "unsupported"
            : resultCount > 0 ? "populated" : "empty")
          : geometryState === "ready"
            ? "ready"
            : "unsupported";
  const hasPlace = !!(scope.place.boroughs.length || scope.place.community_districts.length
    || scope.place.council_districts.length || (scope.place.geographies || []).length || scope.place.neighborhood
    || scope.place.location_scope);
  const geographyState = options.geographyState
    || parseGeographyNavigationState(options.geographySearch || options.shareSearch || "");
  const explicitSurface = Boolean(
    options.shellSurface
    || geographyState?.surface
    || (typeof options.geographySearch === "string" && /(?:^|[?&])surface=/.test(options.geographySearch)),
  );
  const shellSurface = resolveShellSurface(options.shellSurface || geographyState?.surface, {
    hasExplicitSurface: explicitSurface,
    hasPlace,
  });
  // Primary browse layer stays the selected geography's type. Comparison is a
  // secondary URL dimension and must not replace the Areas directory layer.
  const activeGeographyLayer = options.navigationLayerType
    || geographyState?.type
    || "nta2020";
  const directoryAliases = options.directoryAliasesByNtaId
    || aliasesByNtaIdFromGazetteer(neighborhoodGazetteer);
  const directoryQuery = String(
    options.directoryQuery
    || (typeof options.geographySearch === "string"
      ? new URLSearchParams(options.geographySearch.startsWith("?")
        ? options.geographySearch
        : `?${options.geographySearch}`).get(GEOGRAPHY_SHELL_DIRECTORY_FILTER_PARAM)
      : "")
    || "",
  ).trim();
  const navigationDirectory = options.navigationLayerDoc
    ? navigationDirectoryFromLayerDoc(options.navigationLayerDoc, {
      layerType: options.navigationLayerType || activeGeographyLayer,
      aliasesByNtaId: directoryAliases,
      query: directoryQuery,
    })
    : null;
  // Default chooser membership is residential; keep a flat residential list for counts.
  const navigationAreas = navigationDirectory?.residential
    || (options.navigationLayerDoc
      ? navigationAreaEntriesFromLayerDoc(options.navigationLayerDoc, {
        layerType: options.navigationLayerType || activeGeographyLayer,
        aliasesByNtaId: directoryAliases,
      })
      : []);
  // Neighborhoods to start from, before a place is chosen: ranked from the
  // loaded current-category activity by the count each one's own Records list
  // shows. Only a complete read of the requested scope can rank; a failed or
  // partial read, an unsupported category or location basis, or a missing
  // neighborhood directory offers none.
  const placeSuggestionCandidates = !hasPlace && dataState === "ready" && sectionStates.primary === "ready"
    && mapped && basis === "performance" && GEOGRAPHY_RECORD_LENSES.includes(lens)
    && String(options.navigationLayerDoc?.type || "") === "nta2020"
    ? navigationAreaEntriesFromLayerDoc(options.navigationLayerDoc, { layerType: "nta2020", membership: "residential" })
    : [];
  const placeSuggestions = geographyPlaceSuggestions(activityRoot, {
    lens,
    candidates: placeSuggestionCandidates,
    // The destination's own predicate: the same filters with that place selected.
    matches: (record, key) => recordMatches(record, scopeWithCanonicalGeography({
      ...scope,
      place: { ...scope.place, geographies: [key] },
    }), activity?.built_at),
  });
  const selectedGeographyKey = geographyState?.key || first(scope.place.geographies) || null;
  const selectedGeographyDefinition = selectedGeographyKey
    ? (activity?.geography_items?.definitions?.[selectedGeographyKey]
      || (GEOGRAPHY_NAVIGATION_AREA_OVERLAP_EXAMPLE.selected.key === selectedGeographyKey
        ? GEOGRAPHY_NAVIGATION_AREA_OVERLAP_EXAMPLE.selected
        : null))
    : null;
  const overlapOwner = selectedGeographyKey
    ? resolveGeographyOwnerPresentation({
      type: geographyState?.type
        || selectedGeographyDefinition?.type
        || String(selectedGeographyKey).split(":")[1]
        || null,
      id: geographyState?.id
        || selectedGeographyDefinition?.id
        || String(selectedGeographyKey).split(":")[2]
        || null,
      key: selectedGeographyKey,
      label: selectedGeographyDefinition?.label || null,
      boundary_vintage: selectedGeographyDefinition?.boundary_vintage || null,
      labelIndex: options.geographyLabelIndex || null,
      layerDoc: options.navigationLayerDoc || null,
    })
    : null;
  const overlapSelected = overlapOwner
    ? {
      key: overlapOwner.key || selectedGeographyKey,
      type: overlapOwner.type,
      id: overlapOwner.id,
      label: overlapOwner.label,
      boundary_vintage: overlapOwner.boundary_vintage,
    }
    : null;
  const boundaryVintage = geometryState === "missing"
    ? null
    : overlapSelected?.boundary_vintage
      || options.navigationLayerDoc?.vintage?.id
      || options.boundaryVintage
      || (geometryState === "ready" ? (boundaries?.boundary_vintage || null) : null)
      || null;
  const overlapBase = nearYouUrlFromScope(scope, {base:canonicalBase});
  const selectedRecordsHref = selectedGeographyKey
    ? geographyNavigationUrlWithFilters({
      ok: true,
      geo: `${overlapSelected.type}:${overlapSelected.id}`,
      key: selectedGeographyKey,
      type: overlapSelected.type,
      id: overlapSelected.id,
      compare: geographyState?.compare || null,
      surface: GEOGRAPHY_NAVIGATION_SURFACE_RECORDS,
      drawer: geographyState?.drawer || GEOGRAPHY_NAVIGATION_DRAWER_OPEN,
      focus: geographyState?.focus || null,
      lens,
    }, { base: overlapBase })
    : null;
  const crosswalkRowsProvided = Array.isArray(options.crosswalkRows);
  const crosswalkAvailable = crosswalkRowsProvided
    ? options.crosswalkAvailable !== false
    : options.crosswalkAvailable === true;
  const overlapModel = overlapSelected
    ? buildSelectedGeographyOverlapViewModel({
      selected: overlapSelected,
      compareType: geographyState?.compare || null,
      crosswalkRows: crosswalkRowsProvided ? options.crosswalkRows : null,
      crosswalkAvailable,
      pointBundle: options.pointBundle || null,
      labelIndex: options.geographyLabelIndex || null,
      base: overlapBase,
      surface: shellSurface,
      drawer: geographyState?.drawer || GEOGRAPHY_NAVIGATION_DRAWER_OPEN,
      focusToken: geographyState?.focus || null,
      recordsHref: selectedRecordsHref,
      recordLenses: selectedGeographyKey && activity?.geography_items
        ? geographyRecordLenses(activity, selectedGeographyKey)
        : null,
    })
    : null;
  const requestedPlaceRole = placeRoleSupportedForDomain(lens) && PLACE_ROLES.includes(scope.facets.values?.place_role)
    ? scope.facets.values.place_role
    : null;
  const landRecordRoute = (record) => {
    const projectHref = nearYouLandRecordHref(record?.id || record?.project_id, { scope });
    return projectHref ? siteHref(projectHref) : migratedSiteHref(record?.route);
  };
  const withPlaceScopedBasis = (record, geographyEvidence) => {
    // Dual venue + subject memberships keep one preferred corpus basis on the
    // stored record. When a selected place admits the row through a different
    // membership, surface that membership's basis on the linked result card.
    if (!geographyEvidence?.basis) return {};
    if (geographyEvidence.basis === record?.basis) return {};
    return {
      basis: geographyEvidence.basis,
      basis_method: geographyEvidence.method || record?.basis_method || null,
    };
  };
  const linkedRecord = (record, { explain = true } = {}) => {
    const whyHere = explain
      ? selectNearYouExplanationPath(record.why_here_candidates, scope)
      : null;
    const geography_evidence = selectNearYouGeographyEvidence(record, scope);
    return {
      ...record,
      route: lens === "land" ? landRecordRoute(record) : migratedSiteHref(record.route),
      why_here: whyHere
        ? { ...whyHere, notice_href: siteHref(whyHere.notice_href) }
        : null,
      geography_evidence,
      ...withPlaceScopedBasis(record, geography_evidence),
      // Every record reaching the results list already passed the recordMatches role gate
      // above, so this is the predicate that caused the match, not a separately-derived guess.
      matched_place_role: requestedPlaceRole,
    };
  };
  const overviewRecords = (lensName) => {
    if (dataState !== "ready" || !activityRoot?.records?.[lensName]) return [];
    const lensScope = scopeWithGeographies({ ...scope, facets: { ...scope.facets, domains: [lensName] } });
    const ids = intersection(recordIdsForScope(activityRoot, lensName, lensScope).ids, new Set(
      Object.values(activityRoot.records[lensName])
        .filter((record) => recordMatches(record, lensScope, activityRoot.built_at))
        .map((record) => String(record.id)),
    ));
    return ids.map((id) => activityRoot.records[lensName][id]).filter(Boolean).sort(recordSort).map((record) => {
      const whyHere = selectNearYouExplanationPath(record.why_here_candidates, lensScope);
      const geography_evidence = selectNearYouGeographyEvidence(record, lensScope);
      return {
        ...record,
        route: lensName === "land" ? landRecordRoute(record) : migratedSiteHref(record.route),
        why_here: whyHere ? { ...whyHere, notice_href: siteHref(whyHere.notice_href) } : null,
        geography_evidence,
        ...withPlaceScopedBasis(record, geography_evidence),
      };
    });
  };
  const overviewAll = Object.fromEntries(["meetings", "land", "property", "rules", "money", "consultations"].map((name) => [name, overviewRecords(name)]));
  const builtTime = Date.parse(activityRoot?.built_at || "");
  const upcoming = overviewAll.meetings.filter((record) => {
    const date = Date.parse(record.date || "");
    return Number.isFinite(date) && (!Number.isFinite(builtTime) || date >= builtTime);
  }).sort((a, b) => {
    const dateA = Date.parse(a.date || "") || Number.POSITIVE_INFINITY;
    const dateB = Date.parse(b.date || "") || Number.POSITIVE_INFINITY;
    return dateA - dateB || String(a.title).localeCompare(String(b.title));
  });
  const recent = ["land", "property", "rules"].flatMap((name) => overviewAll[name])
    .filter((record) => {
      const date = Date.parse(record.date || "");
      const recentStart = Number.isFinite(builtTime) ? builtTime - (180 * 24 * 60 * 60 * 1000) : Number.NEGATIVE_INFINITY;
      return Number.isFinite(date) && date <= builtTime && date >= recentStart;
    })
    .sort(recordSort);
  const projects = overviewAll.land;
  const overview = {
    state: isOverview ? dataState : "not_requested",
    sections: [
      { key: "upcoming", title: "Upcoming", count: dataState === "ready" ? upcoming.length : null, records: upcoming.slice(0, 3), coverage: upcoming.length ? null : "No upcoming activity is recorded for this district in the retained sources.", lens: "meetings" },
      { key: "recent-changes", title: "Recent changes", count: dataState === "ready" ? recent.length : null, records: recent.slice(0, 3), coverage: recent.length ? null : "No recent changes are recorded for this district in the retained sources.", lens: "land" },
      { key: "board-activity", title: "Board activity", count: null, records: [], coverage: viewBoardCoverage(scope, options.communityGeography || {}), lens: "meetings" },
      { key: "projects", title: "Projects", count: dataState === "ready" ? projects.length : null, records: projects.slice(0, 3), coverage: projects.length ? null : "No district projects are published in this digest.", lens: "land" },
      { key: "district-priorities", title: "District priorities", count: null, records: [], coverage: "District priorities are not published in this digest.", lens: "meetings" },
      { key: "consultations", title: "Consultations", count: dataState === "ready" ? overviewAll.consultations.length : null, records: overviewAll.consultations.slice(0, 3), coverage: overviewAll.consultations.length ? null : "No consultations are recorded for this district in the retained sources.", lens: "consultations" },
    ],
  };
  const localFollowBundle = isOverview && scope.place.community_districts.length
    ? buildLocalDistrictFollowBundle({
      scope,
      board: selectedPlacePresentation(scope, options.communityGeography || {}).boardRef,
    })
    : null;
  const resultRecords = resultIds.map((id) => records[id]).filter(Boolean).sort(recordSort).map(linkedRecord);
  // A special bucket reads only its own section. When the requested scope
  // failed, its records come from the sections that did load
  // (options.sectionActivity), never from the failed local read.
  const sectionRoot = dataState === "ready" ? activityRoot : rootForBasis(options.sectionActivity || null);
  const sectionRecords = sectionRoot?.records?.[lens] || {};
  const sectionAllowed = dataState === "ready"
    ? allowed
    : new Set(Object.values(sectionRecords)
      .filter((record) => recordMatches(record, scope, options.sectionActivity?.built_at))
      .map((record) => String(record.id)));
  const bags = Object.fromEntries(["citywide", "virtual", "unlocated"].map((kind) => {
    // A bucket the loaded slice does not publish for this category is unknown, never zero.
    const loaded = sectionStates[kind] === "ready" && mapped
      && Array.isArray(sectionRoot?.district_items?.[kind]?.[lens]);
    const ids = loaded
      ? intersection(sectionRoot.district_items[kind][lens], sectionAllowed)
      : [];
    const count = loaded ? ids.length : null;
    const bucketRecords = orderNearYouSpecialPreview(ids.map((id) => sectionRecords[id]).filter(Boolean), { now })
      .map((record) => linkedRecord(record, { explain: false }));
    return [kind, {
      kind,
      label: BAG_LABELS[kind],
      state: sectionStates[kind],
      ids,
      count,
      records: bucketRecords,
      preview: bucketRecords.slice(0, NEAR_YOU_SPECIAL_PREVIEW_LIMIT),
      // The whole bucket, same filters, as its own Records list; no local place survives.
      href: withRecordsSurface(urlForScope(scopeWithPlace(scope, { locationScope: kind }))),
    }];
  }));
  // Wider-district previews are meetings-only enrichment from the overlapping
  // districts' own published slices. They stay a separate labeled section and
  // never enter the exact membership projection, exact ids, or exact count.
  let broaderDistrictSection = null;
  if (lens === "meetings" && dataState === "ready" && options.broaderDistricts?.relations?.length) {
    const exactIdSet = new Set(resultIds.map(String));
    const relationsWithRecords = [];
    for (const relation of options.broaderDistricts.relations) {
      if (!relation?.id) continue;
      const slice = options.broaderDistricts.slices?.[relation.key]
        || options.broaderDistricts.slices?.[`community-district:${relation.id}`]
        || null;
      const lensRecords = slice?.records?.meetings || null;
      // A district slice without real records must not yield a working-looking
      // preview group (same invalid-generation rule as local result links).
      if (!lensRecords) continue;
      const memberIds = slice.district_items?.by_level?.community_district?.[relation.id]?.meetings;
      const candidateIds = Array.isArray(memberIds) && memberIds.length
        ? memberIds
        : Object.keys(lensRecords);
      const rows = candidateIds
        .map((id) => lensRecords[id])
        .filter(Boolean)
        .filter((record) => recordMatches(record, scope, activityRoot?.built_at))
        .sort(recordSort)
        .slice(0, BROADER_DISTRICT_PREVIEW_LIMIT)
        .map((record) => {
          // Broader previews are not exact for the selected neighborhood, so
          // attach the record's own neighborhood venue evidence when present.
          const linked = linkedRecord(record, { explain: false });
          if (!linked.geography_evidence) {
            const venueNta = (record.place?.geographies || []).find((row) =>
              row?.visibility === "public"
              && row.location_role === "venue"
              && row.type === "nta2020"
              && row.key);
            if (venueNta?.key) {
              linked.geography_evidence = selectNearYouGeographyEvidence(record, {
                place: { geographies: [venueNta.key] },
              });
            }
          }
          return linked;
        });
      if (!rows.length) continue;
      relationsWithRecords.push({
        ...relation,
        label: relation.label || formatCommunityDistrict(relation.id),
        href: geographyNavigationUrlWithFilters({
          ok: true,
          geo: `community_district:${relation.id}`,
          key: relation.key || `geography:community_district:${relation.id}`,
          type: "community_district",
          id: relation.id,
          surface: GEOGRAPHY_NAVIGATION_SURFACE_RECORDS,
          lens,
        }, { base: overlapBase }),
        records: rows,
      });
    }
    broaderDistrictSection = buildNearYouBroaderDistrictSection({
      relations: relationsWithRecords,
      exactIds: [...exactIdSet],
    });
  }
  const view = {
    schema: "cityscroll.near_you_view.v1",
    scope,
    lens,
    mapped,
    dataState,
    sectionStates,
    now,
    geometryState,
    mapState,
    boundaryVintage,
    basis,
    basisLabel: basisLayer?.basis_label || "Affected area or place of performance",
    hasPlace,
    placePresentation: selectedPlacePresentation(scope, options.communityGeography || {}, {
      geographyState,
      geographyDefinitions: activity?.geography_items?.definitions || null,
      geographyLabelIndex: options.geographyLabelIndex || null,
      navigationLayerDoc: options.navigationLayerDoc || null,
    }),
    isOverview,
    overview,
    localFollowBundle,
    lensLabel: LENS_LABELS[lens] || lens,
    scopeSummary: scopeSummary(scope, lens, activity?.geography_items?.definitions),
    geographyOptions: Object.values(activity?.geography_items?.definitions || {})
      .filter((definition) => ["nta2020", "police_precinct"].includes(definition.type))
      .filter((definition) => (activity?.geography_items?.by_key?.[definition.key]?.[lens] || []).length > 0)
      .sort((left, right) => left.type.localeCompare(right.type) || left.label.localeCompare(right.label)),
    results: { ids: resultIds, count: resultCount, records: resultRecords },
    broader_districts: broaderDistrictSection,
    features,
    navigationAreas,
    navigationDirectory,
    placeSuggestions,
    directoryQuery,
    activeGeographyLayer,
    shellSurface,
    geographyState,
    overlapModel,
    max: mappedFeatures.max,
    level,
    parent,
    viewBox: level === "community_district" && parent && BOROUGH_HULLS[parent]
      ? bboxToViewBox(BOROUGH_HULLS[parent].bbox, 0.08)
      : defaultViewBox(),
    bags,
    activity: dataState === "ready" ? activityRoot : null,
    browseHref: lens === "land"
      ? siteHref(nearYouLandResultsHref(scope))
      : migratedSiteHref(`/${routeHashFromScope(scope, { surface: lens })}`),
    membershipProjection,
    geographyLensCounts: geographyKeyForScope(scope) && activity?.geography_items
      ? geographyRecordLenses(activity, geographyKeyForScope(scope))
      : Object.freeze({}),
    navigationAreaCountsByKey: Object.fromEntries((navigationAreas || []).map((entry) => {
      const projection = geographyRecordProjectionForArea(activity, lens, scope, entry.key, allowed);
      return [entry.key, projection.count];
    })),
    watchHref: watchHref(scope, lens, resultCount),
    shareHref: nearYouUrlFromScope(scope, { base: canonicalBase }),
    recoveryHref: options.recoveryHref || (() => {
      const scopeUrl = nearYouUrlFromScope(scope, { base: canonicalBase });
      if (!(geographyState?.geo || geographyState?.key)) return scopeUrl;
      return geographyNavigationUrlWithFilters({
        ok: true,
        geo: geographyState.geo
          || (geographyState.type && geographyState.id
            ? `${geographyState.type}:${geographyState.id}`
            : null),
        key: geographyState.key || null,
        type: geographyState.type || null,
        id: geographyState.id || null,
        compare: geographyState.compare || null,
        surface: geographyState.surface || shellSurface,
        drawer: geographyState.drawer || null,
        focus: geographyState.focus || null,
        lens,
      }, { base: scopeUrl });
    })(),
    canonicalBase,
    siteBase,
    local_constellation: buildPlaceLocalConstellation(
      options.communityGeography || {},
      first(scope.place.community_districts)
        ? `community-district:${first(scope.place.community_districts)}`
        : first(scope.place.council_districts)
          ? `council-district:${first(scope.place.council_districts)}`
          : null,
      boundaries,
      scope,
    ),
  };
  view.allNyc = buildNearYouAllNycLink(view, { migratedSiteHref });
  view.localRecovery = buildNearYouLocalRecovery(view, { membershipProjection });
  return view;
}

/** Resident nouns for one category; the All NYC link names the same collection. */
const LOCAL_RECOVERY_NOUNS = Object.freeze({
  meetings: "meetings",
  land: "zoning records",
  property: "property records",
  rules: "rules",
  money: "contracts",
  consultations: "consultations",
  people: "people and organizations",
});

/** One record of each category, for a count of exactly one. */
const LOCAL_RECOVERY_SINGULAR_NOUNS = Object.freeze({
  meetings: "meeting",
  land: "zoning record",
  property: "property record",
  rules: "rule",
  money: "contract",
});

const LOCAL_RECOVERY_PLACE_NOUNS = Object.freeze({
  nta2020: "neighborhood",
  community_district: "community district",
  council_district: "council district",
  police_precinct: "precinct",
  borough: "borough",
});

function localRecoveryState(view, membershipProjection) {
  if (!view.hasPlace) return null;
  if (view.dataState === "pending") return null;
  if (view.dataState === "error") return "error";
  const key = geographyKeyForScope(view.scope);
  if (!key && view.scope.place.neighborhood && !view.scope.place.location_scope) return "unknown";
  if (!view.mapped) return "unsupported";
  const state = membershipProjection?.state;
  if (state === "incomplete") return "incomplete";
  if (state === "error") return "failed";
  if (!membershipProjection?.exact) return "unsupported";
  return view.results.count === 0 ? "zero" : null;
}

function removedFilterLabel({ axis, value }) {
  if (axis === "place_role") return `“${placeRoleUserLabel(value)}”`;
  if (axis === "type" || axis === "noticeType") return `type “${String(value)}”`;
  return `${String(axis).replace(/_/g, " ")} “${typeof value === "string" ? value : JSON.stringify(value)}”`;
}

/** One explicit All NYC destination for the current category, only when a place narrows it. */
function buildNearYouAllNycLink(view, { migratedSiteHref }) {
  if (!view.hasPlace) return null;
  const routeHash = allNycRecordsRouteHash(view.scope, { lens: view.lens });
  if (!routeHash) return null;
  return Object.freeze({
    href: migratedSiteHref(`/${routeHash}`),
    label: `All NYC ${LOCAL_RECOVERY_NOUNS[view.lens] || "records"}`,
  });
}

/**
 * The single local recovery for a selected place: plain-language task consequence, one
 * All NYC link for the current category and, only for a transient load failure, Retry.
 * Internal states stay distinct; resident copy never says there is no civic activity.
 */
function buildNearYouLocalRecovery(view, { membershipProjection }) {
  const state = localRecoveryState(view, membershipProjection);
  if (!state) return null;
  const noun = LOCAL_RECOVERY_NOUNS[view.lens] || "records";
  const place = view.scope.place;
  const keyType = String(geographyKeyForScope(view.scope) || "").split(":")[1];
  const placeNoun = LOCAL_RECOVERY_PLACE_NOUNS[keyType]
    || (place.council_districts.length ? "council district"
      : place.community_districts.length ? "community district"
        : place.boroughs.length ? "borough" : "place");
  const message = {
    unsupported: `We can’t filter these ${noun} to this ${placeNoun} yet.`,
    incomplete: `The list of ${noun} for this ${placeNoun} is not complete yet.`,
    unknown: `We couldn’t find this place, so these ${noun} are not filtered to it.`,
    error: `These ${noun} could not load.`,
    failed: `These ${noun} could not load for this ${placeNoun}.`,
    zero: `No mapped ${noun} match these filters.`,
  }[state];
  const allNyc = view.allNyc;
  const broadened = scopeForAllNycRecords(view.scope, { lens: view.lens });
  const placeLabel = state === "unknown"
    ? view.scope.place.neighborhood
    : view.placePresentation?.label || null;
  const removedLabels = broadened.removed.map(removedFilterLabel);
  return Object.freeze({
    state,
    message,
    allNycHref: allNyc?.href || null,
    allNycLabel: allNyc?.label || null,
    placeNote: allNyc && placeLabel ? `Removes the ${placeLabel} place filter.` : null,
    removedNote: allNyc && removedLabels.length ? `Also removes: ${removedLabels.join(", ")}.` : null,
    removed: broadened.removed,
    retryHref: state === "error" ? view.recoveryHref : null,
  });
}

function renderNearYouLocalRecovery(view, surface) {
  const recovery = view.localRecovery;
  if (!recovery) return "";
  const alert = recovery.state === "error" || recovery.state === "failed";
  const links = [
    recovery.allNycHref
      ? `<a href="${esc(recovery.allNycHref)}" data-near-recovery="all-nyc">${esc(recovery.allNycLabel)}</a>`
      : "",
    recovery.retryHref
      ? `<a href="${esc(recovery.retryHref)}" data-near-recovery="retry">Try again</a>`
      : "",
  ].filter(Boolean).join("");
  const notes = [recovery.placeNote, recovery.removedNote].filter(Boolean)
    .map((note) => `<p class="near-local-recovery-note">${esc(note)}</p>`).join("");
  const body = [
    `<strong>${esc(recovery.message)}</strong>`,
    links ? `<p class="near-local-recovery-actions">${links}</p>` : "",
    notes,
  ].filter(Boolean).join("\n      ");
  return `<div class="near-coverage near-local-recovery" data-near-local-recovery="${esc(recovery.state)}" data-near-local-recovery-surface="${esc(surface)}" role="${alert ? "alert" : "note"}">
      ${body}
    </div>`;
}

function dateLabel(value) {
  if (!value) return "Date not published";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  // determinism-lint: allow timezone a published date is rendered in the reader's own zone, matching every other date on the Near You surface.
  const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(date);
  const time = nearYouEventTimeLabel(value);
  return time ? `${day} · ${time}` : day;
}

function appearanceReason(record) {
  const evidence = record?.geography_evidence;
  if (evidence?.location_role === "venue" && evidence?.label) {
    return nearYouHeldInLabel(evidence.label) || evidence.label;
  }
  if (record?.place?.location_role === "venue") {
    const venueGeo = (record.place.geographies || []).find((row) =>
      row?.visibility === "public" && row.location_role === "venue" && row.label);
    if (venueGeo?.label) return nearYouHeldInLabel(venueGeo.label) || venueGeo.label;
  }
  return record?.basis || "Local activity";
}

function venueAddressLabel(record) {
  return record?.venue_address
    || record?.venue?.address
    || record?.place?.venue_address
    || null;
}

// Plain-language names for the shared place-role predicate (site/scope_v0.mjs PLACE_ROLES).
// Not ontology jargon: this is the only vocabulary the role selector and result-card badge
// use, so the same word always means the same predicate everywhere it appears.
function placeRoleUserLabel(role) {
  if (role === "venue") return "Happening here";
  if (role === "matter") return "About this place";
  if (role === "affected_area") return "Affecting this place";
  return "All local activity";
}

function placeRoleBadge(role) {
  if (!PLACE_ROLES.includes(role)) return "";
  return `<span class="near-record-role" data-place-role="${esc(role)}">${esc(placeRoleUserLabel(role))}</span>`;
}

function recordCard(record, { now = null, inspect = true } = {}) {
  const meetingSource = record.meeting_origin
    ? `<div class="near-record-source" data-meeting-origin="${esc(record.meeting_origin)}">${record.source_url
      ? `<a href="${esc(record.source_url)}" rel="noopener noreferrer">${esc(meetingOriginLabel(record.meeting_origin))}</a>`
      : esc(meetingOriginLabel(record.meeting_origin))}</div>`
    : record.source_url
      ? `<div class="near-record-source"><a href="${esc(record.source_url)}" rel="noopener noreferrer" data-near-you-record-source>Official source</a></div>`
      : "";
  const placement = appearanceReason(record);
  const venueAddress = venueAddressLabel(record);
  const facts = nearYouRecordInspectionFacts(record, { now });
  // A card without Inspect keeps its title as the record link.
  const inspectButton = facts && inspect
    ? renderNearYouRecordInspectButton(facts, { escape: esc })
    : "";
  const fullRecord = facts
    ? renderNearYouRecordFullRecordLink(facts, { escape: esc })
    : "";
  const uncertainty = facts?.uncertainty
    ? `<p class="near-record-uncertainty">${esc(facts.uncertainty)}</p>`
    : "";
  const timing = facts?.timing
    ? `<p class="near-record-timing" data-record-timing="${esc(facts.timing.state)}" data-action-open="${facts.timing.action_open ? "true" : "false"}">${esc(facts.timing.label)}</p>`
    : "";
  // Static title link remains for no-JS / failed enhancement. After binding, CSS
  // swaps it for the title-sized inspect control and the named full-record link.
  return `<li class="near-record" data-record-id="${esc(record.id)}">
    <a class="${NEAR_YOU_RECORD_TITLE_LINK_CLASS} near-record-title" href="${esc(record.route)}"
      data-pivot-schema="cityscroll.edge_summary.v1" data-pivot-status="accepted"
      data-pivot-relation-label="nearby record" data-pivot-target-kind="notice"
      data-pivot-target-id="${esc(record.id)}" data-pivot-source-kind="place"
      data-pivot-source-id="near-you">${esc(record.title)}</a>${inspectButton}
    ${placeRoleBadge(record.matched_place_role)}
    <div class="near-record-meta">
      ${record.agency ? `<span>${esc(record.agency)}</span>` : ""}
      ${record.type ? `<span>${esc(record.type)}</span>` : ""}
      <span>${esc(dateLabel(record.date))}</span>
    </div>
    ${meetingSource}
    <div class="near-record-basis" data-appearance-reason="1"><strong>${esc(placement)}</strong></div>
    ${venueAddress ? `<div class="near-record-venue" data-venue-address="1">${esc(venueAddress)}</div>` : ""}
    ${timing}
    ${uncertainty}
    ${fullRecord ? `<p class="near-record-actions">${fullRecord}</p>` : ""}
  </li>`;
}

function recordList(records, emptyCopy = "No records match these filters.", { now = null, inspect = true } = {}) {
  if (!records.length) return `<p class="near-empty">${esc(emptyCopy)}</p>`;
  return `<ol class="near-records">${records.map((record) => recordCard(record, { now, inspect })).join("")}</ol>`;
}

function hiddenScopeFields(scope, omit = new Set()) {
  const url = new URL(nearYouUrlFromScope(scope, { base: "https://cityscroll.invalid/near-you" }));
  return [...url.searchParams.entries()]
    .filter(([name]) => !omit.has(name))
    .map(([name, value]) => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`)
    .join("");
}

function lensOptions(current) {
  return ["meetings", "land", "property", "rules", "money", "people", "consultations"]
    .map((lens) => `<option value="${lens}"${lens === current ? " selected" : ""}>${esc(LENS_LABELS[lens])}</option>`)
    .join("");
}

function boroughOptions(current) {
  return `<option value="">All mapped areas</option>${BOROUGHS
    .map((borough) => `<option${borough === current ? " selected" : ""}>${esc(borough)}</option>`)
    .join("")}`;
}

function placeRoleOptions(current) {
  return ["", ...PLACE_ROLES]
    .map((role) => `<option value="${esc(role)}"${role === (current || "") ? " selected" : ""}>${esc(placeRoleUserLabel(role))}</option>`)
    .join("");
}

function basisOptions(current) {
  return `<option value="performance"${current === "performance" ? " selected" : ""}>Where work may affect an area</option>
    <option value="contract_action_address"${current === "contract_action_address" ? " selected" : ""}>Contract response address</option>`;
}

function geographyOptions(options, current) {
  const groups = [
    ["nta2020", "Neighborhood tabulation areas"],
    ["police_precinct", "Police precincts"],
  ];
  return `<option value="">All registered geographies</option>${groups.map(([type, label]) => {
    const rows = (options || []).filter((option) => option.type === type);
    if (!rows.length) return "";
    return `<optgroup label="${esc(label)}">${rows.map((option) =>
      `<option value="${esc(option.key)}"${option.key === current ? " selected" : ""}>${esc(option.label)}</option>`).join("")}</optgroup>`;
  }).join("")}`;
}

/** Resident names for the special buckets of one category. */
function nearYouSpecialLabels(lens) {
  const noun = LOCAL_RECOVERY_NOUNS[lens] || "records";
  const capitalized = `${noun.charAt(0).toUpperCase()}${noun.slice(1)}`;
  return {
    noun,
    citywide: `Citywide ${noun}`,
    virtual: `Online-only ${noun}`,
    unlocated: `${capitalized} without a mapped place`,
  };
}

/**
 * Citywide records as relevant content: a bounded preview of real records with
 * the honest bucket total and a View all link to the whole bucket as its own
 * Records list, then online-only and unmapped records as compact links. The
 * links are plain anchors in the document, so they work before and without
 * any deferred read. A bucket that could not be read says so with Retry and
 * never shows a zero; a bucket the category does not publish is left out.
 */
function renderNearYouSpecialRecords(view, { position = "after-results", shell = false } = {}) {
  if (!view.mapped) return "";
  const labels = nearYouSpecialLabels(view.lens);
  const current = view.scope.place.location_scope;
  const published = (bag) => bag.state !== "ready" || bag.count != null;
  const citywide = view.bags.citywide;
  const showCitywide = current !== "citywide" && published(citywide);
  const secondary = ["virtual", "unlocated"]
    .map((kind) => view.bags[kind])
    .filter((bag) => bag.kind !== current && published(bag));
  if (!showCitywide && !secondary.length) return "";
  const pending = [citywide, ...secondary].some((bag) => bag.state === "pending");
  let citywideHtml = "";
  if (showCitywide) {
    const failed = citywide.state === "error";
    const allHref = esc(citywide.href);
    const viewAll = citywide.count === 0
      ? ""
      : `<p class="near-citywide-all"><a href="${allHref}" data-near-special-link="citywide">${citywide.count == null
        ? `View all ${esc(labels.citywide.toLowerCase())}`
        : `View all ${citywide.count} ${esc(labels.citywide.toLowerCase())}`}</a></p>`;
    let body;
    if (failed) {
      body = `<div class="near-coverage near-section-recovery" data-near-section-recovery="citywide" role="note">
        <strong>${esc(`${labels.citywide} could not load.`)}</strong>
        <p class="near-local-recovery-actions"><a href="${esc(view.recoveryHref)}" data-near-recovery="retry">Try again</a></p>
      </div>`;
    } else if (citywide.state === "pending") {
      body = `<p class="near-deferred-status" role="status" aria-live="polite">${esc(`Loading ${labels.citywide.toLowerCase()}…`)}</p>`;
    } else if (citywide.count === 0) {
      // A place-role filter is never relaxed to fill the preview; the All NYC
      // route names the filter it removes.
      const roleFiltered = placeRoleSupportedForDomain(view.lens)
        && PLACE_ROLES.includes(view.scope.facets.values?.place_role);
      const removed = roleFiltered && view.allNyc
        ? scopeForAllNycRecords(view.scope, { lens: view.lens }).removed.map(removedFilterLabel)
        : [];
      body = `<p class="near-empty">${esc(`No ${labels.citywide.toLowerCase()} match these filters.`)}</p>${roleFiltered && view.allNyc
        ? `<p class="near-local-recovery-actions"><a href="${esc(view.allNyc.href)}" data-near-recovery="all-nyc">${esc(view.allNyc.label)}</a></p>${removed.length
          ? `<p class="near-local-recovery-note">${esc(`Removes: ${removed.join(", ")}.`)}</p>`
          : ""}`
        : ""}`;
    } else {
      // The document's cards are plain record links; the deferred section that
      // replaces them adds Inspect.
      body = recordList(citywide.preview, undefined, { now: view.now, inspect: !shell });
    }
    citywideHtml = `<div class="near-citywide" data-bag="citywide"${failed ? ` data-near-section-state="unavailable"` : ""}>
      <h2 id="near-bags-heading" tabindex="-1"><span>${esc(labels.citywide)}</span> ${countMarkup(citywide.count)}</h2>
      <p class="near-citywide-note">These apply across NYC.</p>
      ${body}
      ${viewAll}
    </div>`;
  }
  const secondaryHtml = secondary.length
    ? `${showCitywide ? "" : `<h2 id="near-bags-heading" tabindex="-1">Other collections</h2>`}<ul class="near-special-links" aria-label="Other collections">${secondary.map((bag) => {
      const label = labels[bag.kind];
      if (bag.state === "error") {
        return `<li data-bag="${bag.kind}" data-near-section-state="unavailable"><a href="${esc(bag.href)}" data-near-special-link="${bag.kind}">${esc(label)}</a> ${countMarkup(null)} <span>could not load.</span> <a href="${esc(view.recoveryHref)}" data-near-recovery="retry">Try again</a></li>`;
      }
      if (bag.count === 0) {
        return `<li data-bag="${bag.kind}"><span>${esc(label)}</span> ${countMarkup(0)}</li>`;
      }
      return `<li data-bag="${bag.kind}"><a href="${esc(bag.href)}" data-near-special-link="${bag.kind}">${esc(label)}</a> ${countMarkup(bag.count)}</li>`;
    }).join("")}</ul>`
    : "";
  // In the document the section is also the deferred host, so the deferred read
  // owns each bucket's final state. Its content is already complete unless a
  // bucket is still loading, and a failed deferred read never removes it.
  const deferredHost = shell
    ? ` data-near-deferred="bags" data-near-deferred-state="pending"${pending ? ` aria-busy="true"` : ` data-near-deferred-content="complete"`}`
    : "";
  return `<section class="near-bags${shell ? " near-bags-shell" : ""} near-special-records" aria-labelledby="near-bags-heading" data-near-special-records="${esc(position)}"${deferredHost}>
      ${citywideHtml}${secondaryHtml}
    </section>`;
}

/** Neighborhood starting points on an unselected page; absent when none qualifies. */
function renderNearYouPlaceSuggestions(view) {
  if (view.hasPlace || !view.placeSuggestions?.length) return "";
  return `\n    ${geographyShellPlaceSuggestionsHtml(view.placeSuggestions, {
    base: view.shareHref || view.canonicalBase || "/near-you/",
    lens: view.lens,
    noun: LOCAL_RECOVERY_NOUNS[view.lens] || "records",
    singularNoun: LOCAL_RECOVERY_SINGULAR_NOUNS[view.lens] || "record",
  })}`;
}

/** Render the lower-priority record lists for the deferred Near-you artifact. */
export function renderNearYouDeferredParts(view) {
  const resultCount = knownCount(view.results.count);
  const localRecoveryHtml = renderNearYouLocalRecovery(view, "records");
  const visibleResults = view.results.records.slice(0, INITIAL_RECORD_LIMIT);
  const moreResults = view.results.records.length > INITIAL_RECORD_LIMIT && resultCount != null
    ? `<p class="near-results-more"><a href="${esc(view.browseHref)}">Open all ${resultCount} matching records</a></p>`
    : "";
  // The wider-district block renders first so its scope label is read before
  // any exact result, including the honest unavailable exact-coverage copy.
  const broaderHtml = renderNearYouBroaderDistrictsHtml(view.broader_districts);
  // The requested scope failed while other sections loaded: its section is an
  // explicit failure with the scoped recovery, never an empty or zero result.
  const requestedFailed = view.dataState === "error";
  const resultsHtml = `<section class="near-results" aria-labelledby="${broaderHtml ? "near-broader-districts-heading" : "near-results-heading"}"${resultCount == null ? "" : ` data-results-count="${resultCount}"`}${requestedFailed ? ` data-near-section-state="unavailable"` : ""}>
      ${broaderHtml}<div class="near-section-heading"><div><p class="near-kicker">Matching records</p><h2 id="near-results-heading" tabindex="-1">${resultCount == null ? `Matching ${esc(view.lensLabel)} records` : `${resultCount} ${esc(view.lensLabel)} records for these filters`}</h2></div></div>
      ${requestedFailed ? renderNearYouRecordsRecovery(view) : localRecoveryHtml || recordList(visibleResults, view.mapState === "unsupported"
        ? `${view.lensLabel} records are not mapped here.`
        : resultCount == null ? "Matching records are not available right now." : undefined, { now: view.now })}
      ${moreResults}
    </section>`;
  const bagsHtml = renderNearYouSpecialRecords(view, { position: view.hasPlace ? "after-results" : "entry" });
  return { resultsHtml, bagsHtml };
}

export function renderNearYouDeferredBody(view) {
  const { resultsHtml, bagsHtml } = renderNearYouDeferredParts(view);
  return `${resultsHtml}
    ${bagsHtml}`;
}

function renderNearYouDeferredResultsShell(view) {
  if (view.dataState === "error") {
    return `<section class="near-results near-results-shell" aria-labelledby="near-results-heading" data-near-deferred="results" data-near-deferred-state="error" aria-busy="false">
      <div class="near-section-heading"><div><p class="near-kicker">Matching records</p><h2 id="near-results-heading" tabindex="-1">Matching ${esc(view.lensLabel)} records</h2></div></div>
      ${renderNearYouRecordsRecovery(view)}
    </section>`;
  }
  return `<section class="near-results near-results-shell" aria-labelledby="near-results-heading" data-near-deferred="results" data-near-deferred-state="pending" aria-busy="true">
      <div class="near-section-heading"><div><p class="near-kicker">Matching records</p><h2 id="near-results-heading" tabindex="-1">Matching ${esc(view.lensLabel)} records</h2></div></div>${renderNearYouLocalRecovery(view, "records")}
      <p class="near-deferred-status" role="status" aria-live="polite">Loading matching records…</p>
    </section>`;
}

function renderNearYouOverview(view) {
  if (!view.isOverview || !view.hasPlace) return "";
  const lensScopeHref = (lens) => {
    const scope = normalizeScope({ ...view.scope, facets: { ...view.scope.facets, domains: [lens] } });
    return nearYouUrlFromScope(scope, { base: view.canonicalBase });
  };
  const sections = view.overview.sections.map((section) => {
    const records = section.records.length ? recordList(section.records, undefined, { now: view.now }) : "";
    const count = knownCount(section.count) == null ? "" : ` <span class="near-overview-count">${section.count}</span>`;
    const destination = section.key === "board-activity" && view.placePresentation.boardHref
      ? view.placePresentation.boardHref
      : lensScopeHref(section.lens);
    return `<section class="near-overview-section" id="near-overview-${esc(section.key)}" aria-labelledby="near-overview-${esc(section.key)}-heading">
      <div class="near-section-heading"><h2 id="near-overview-${esc(section.key)}-heading">${esc(section.title)}${count}</h2><a href="${esc(destination)}">Open ${esc(section.lens === "meetings" ? "meetings" : LENS_LABELS[section.lens] || section.lens)}</a></div>
      ${records}${section.coverage ? `<p class="near-coverage" role="note">${esc(section.coverage)}</p>` : ""}
    </section>`;
  }).join("");
  const councils = (view.placePresentation.overlappingCouncilLabels || []).join(", ");
  const follow = view.localFollowBundle;
  const followAction = follow
    ? `<section class="near-follow-district" data-local-district-follow="${esc(follow.id)}" aria-labelledby="near-follow-district-heading">
      <p class="near-kicker">Ongoing view</p><h2 id="near-follow-district-heading">${esc(follow.title)}</h2>
      <p>${esc(follow.description)}</p>
      ${follow.children.length
        ? `<ul>${follow.children.map((child) => `<li><strong>${esc(child.label)}</strong> <code>${esc(JSON.stringify(child.filter))}</code></li>`).join("")}</ul>
          ${follow.unsupported_lenses.length ? `<p class="near-coverage" role="note">Not included because this bundle does not yet support these lenses: ${esc(follow.unsupported_lenses.join(", "))}.</p>` : ""}
          <a class="near-follow-action" href="/following/#alerts?template=${encodeURIComponent(follow.id)}&amp;cd=${encodeURIComponent(follow.district || "")}&amp;board=${encodeURIComponent(follow.board || "")}">Follow this district</a>`
        : `<p class="near-coverage" role="note">${esc(follow.unavailable || "This district bundle is unavailable.")}</p>`}
    </section>`
    : "";
  return `<section class="near-overview" aria-labelledby="near-overview-heading" data-near-overview="true">
    <p class="near-kicker">District overview</p><h2 id="near-overview-heading">What is happening here</h2>
    <p class="near-overview-place">${esc(view.placePresentation.label)}${view.placePresentation.boardLabel ? ` · ${esc(view.placePresentation.boardLabel)}` : ""}${councils ? ` · overlaps ${esc(councils)}` : ""}</p>
    <p class="near-overview-note">Dates come from the retained public calendars. Recurring calendars may publish dates beyond the current planning horizon.</p>
    ${sections}
    ${followAction}
  </section>`;
}

function renderNearYouRecordsRecovery(view) {
  if (view.dataState !== "error") return "";
  if (view.localRecovery) return renderNearYouLocalRecovery(view, "records");
  return `<div class="near-coverage near-records-state" data-near-records-state="error" role="alert">
      <strong>Matching records are temporarily unavailable.</strong>
      <p>Your place, topic, comparison, and filters stay selected. You can keep exploring the map while records recover.</p>
      <a href="${esc(view.recoveryHref)}" data-near-recovery="retry">Try again</a>
    </div>`;
}

function renderNearYouMapState(view) {
  const state = view.mapState;
  let notice = "";
  if (state === "unsupported" && !view.localRecovery) {
    notice = `<div class="near-coverage near-map-state" data-near-map-state="unsupported" role="note">
      <strong>${esc(`${view.lensLabel} records are not mapped here.`)}</strong>
      <p>This map does not have place data for this lens, so it will not imply that no civic activity exists.</p>
      <a href="${esc(view.browseHref)}" data-near-recovery="unsupported">Open ${esc(view.lensLabel)} records</a>
    </div>`;
  }
  if (state === "pending") {
    notice = `<div class="near-coverage near-map-state" data-near-map-state="pending" role="status" aria-busy="true">
      <strong>Map boundaries are still loading.</strong><p>Neighborhood outlines will appear when the boundary data is ready.</p>
    </div>`;
  }
  if (state === "missing") {
    notice = `<div class="near-coverage near-map-state" data-near-map-state="missing" role="note">
      <strong>Map boundaries are not published for this place yet.</strong>
      <p>Your selected place and filters stay available. This page does not invent a boundary that is not published.</p>
    </div>`;
  }
  if (state === "error") {
    notice = `<div class="near-coverage near-map-state" data-near-map-state="error" role="alert">
      <strong>The neighborhood map could not load.</strong>
      <p>Your place and filters stay selected. You can retry the map or keep browsing records when they are available.</p>
      <a href="${esc(view.recoveryHref)}" data-near-recovery="retry">Try again</a>
    </div>`;
  }
  const paths = view.features.map((feature) => `<path class="map-district"
    data-map-id="${esc(feature.id)}" data-count="${feature.total}" data-map-level="${esc(feature.level)}"
    data-map-href="${esc(feature.href)}" d="${esc(feature.path)}" fill="${esc(feature.fill)}"
    aria-label="${esc(feature.label)}: ${feature.total} ${esc(view.lensLabel)} records"></path>`).join("");
  const labels = view.features.map((feature) => `<text class="map-label map-label-${esc(feature.level)} map-label--${esc(feature.labelTone)}"
      data-map-label="${esc(feature.id)}" data-area-name="${esc(feature.label)}"
      x="${esc(feature.labelPoint?.x)}" y="${esc(feature.labelPoint?.y)}"
      text-anchor="middle" dominant-baseline="central" aria-label="${esc(feature.label)}">${esc(feature.labelText)}</text>`).join("");
  const featureAreas = [...view.features]
    .sort((a, b) => b.total - a.total || String(a.label).localeCompare(String(b.label)))
    .map((feature) => `<li><a data-map-area="${esc(feature.id)}" data-count="${feature.total}" href="${esc(feature.href)}"><span>${esc(feature.label)}</span><strong>${feature.total}</strong></a></li>`)
    .join("");
  const navigationAreasHtml = view.navigationDirectory || view.navigationAreas?.length
    ? geographyShellAreasListHtml(view.navigationAreas, {
      activeType: view.activeGeographyLayer || "nta2020",
      base: view.shareHref || view.canonicalBase || "/near-you/",
      surface: GEOGRAPHY_NAVIGATION_SURFACE_MAP,
      countsByKey: view.navigationAreaCountsByKey,
      query: view.directoryQuery || "",
      directory: view.navigationDirectory,
    })
    : `<div class="near-area-panel" id="near-area-list">
          <h3>Areas</h3>
          <ol class="near-area-list">${featureAreas || "<li>No areas match these filters.</li>"}</ol>
        </div>`;
  return `<div class="near-map-grid" data-near-map-state="${esc(state)}">
        <div class="near-map-wrap">
          <svg id="nearMapSvg" role="img" aria-labelledby="nearMapTitle nearMapDesc" viewBox="${esc(view.viewBox)}" preserveAspectRatio="xMidYMid meet">
            <title id="nearMapTitle">New York City ${esc(view.level.replaceAll("_", " "))} map</title>
            <desc id="nearMapDesc">The area list beside this map contains the same links and ${esc(view.lensLabel)} counts.</desc>
            <g fill-rule="evenodd">${paths}</g>
            <g aria-hidden="true">${labels}</g>
          </svg>
          <div id="near-map-enhanced" class="near-map-enhanced" hidden></div>
          <p class="map-legend"><span></span> Fewer to more qualifying records</p>
          <p class="near-vintage">Map boundaries: ${esc(view.boundaryVintage || "not published")}</p>
        </div>
        ${renderNearYouLocalRecovery(view, "map")}${notice}
        ${navigationAreasHtml}
      </div>`;
}

function renderNearYouAdvancedFilters(view) {
  const currentBorough = first(view.scope.place.boroughs);
  const currentGeography = first(view.scope.place.geographies);
  return `<details class="near-advanced"><summary>Advanced filters</summary><form class="near-form" id="near-place-fields" method="get" action="${esc(view.canonicalBase)}">
      ${hiddenScopeFields(view.scope, new Set(["lens", "agency", "type", "boro", "cd", "council", "geo", "neighborhood", "scope", "id", "parent", "basis", "placeRole"]))}
      <label>Topic<select name="lens">${lensOptions(view.lens)}</select></label>
      ${placeRoleSupportedForDomain(view.lens)
        ? `<label>What kind of local activity<select name="placeRole">${placeRoleOptions(view.scope.facets.values?.place_role)}</select></label>`
        : view.scope.facets.values?.place_role
          ? `<input type="hidden" name="placeRole" value="${esc(view.scope.facets.values.place_role)}">`
          : ""}
      <label>Agency<input name="agency" value="${esc(first(view.scope.facets.agencies) || "")}" placeholder="Any agency"></label>
      <label>Type<input name="type" value="${esc(view.scope.facets.values?.type || "")}" placeholder="Any record type"></label>
      <label>Borough<select name="boro">${boroughOptions(currentBorough)}</select></label>
      <label>Neighborhood<input name="neighborhood" value="${esc(view.scope.place.neighborhood || "")}" placeholder="e.g. Elmhurst"></label>
      <label>Community district<input name="cd" value="${esc(first(view.scope.place.community_districts) || "")}" placeholder="e.g. Q04" pattern="[MXKQR][0-9]{2}"></label>
      <label>Council district<input name="council" value="${esc(first(view.scope.place.council_districts) || "")}" placeholder="1–51" inputmode="numeric" pattern="(?:[1-9]|[1-4][0-9]|5[01])"></label>
      <label>Neighborhood or precinct<select name="geo">${geographyOptions(view.geographyOptions, currentGeography)}</select></label>
      ${view.lens === "money" ? `<label>Location basis<select name="basis">${basisOptions(view.basis)}</select></label>` : ""}
      <button type="submit">Apply filters</button>
    </form></details>`;
}

function renderNearYouMapSection(view) {
  return `<section class="near-map-section" aria-labelledby="near-map-heading" data-near-surface-panel="map">
      <div class="near-section-heading"><div><p class="near-kicker">Map view</p><h2 id="near-map-heading">${view.hasPlace ? `${esc(view.placePresentation.label)} on the map` : "Neighborhoods on the map"}</h2></div>
        <div class="map-controls js-only" hidden>
          <button type="button" data-map-zoom="in" aria-label="Zoom in">+</button>
          <button type="button" data-map-zoom="out" aria-label="Zoom out">−</button>
          <button type="button" data-map-pan="west" aria-label="Pan west">←</button>
          <button type="button" data-map-pan="north" aria-label="Pan north">↑</button>
          <button type="button" data-map-pan="south" aria-label="Pan south">↓</button>
          <button type="button" data-map-pan="east" aria-label="Pan east">→</button>
          <button type="button" data-map-zoom="reset">Reset</button>
        </div>
      </div>
      ${renderNearYouMapState(view)}
      ${view.hasPlace ? `<details class="near-map-layers"><summary>Boundary layers</summary>${geographyShellLayerSwitcherHtml({
        activeType: view.activeGeographyLayer || "nta2020",
        base: view.canonicalBase || "/near-you/",
        surface: view.shellSurface || GEOGRAPHY_NAVIGATION_SURFACE_MAP,
        selectedGeo: view.geographyState?.geo
          || (view.overlapModel?.selected
            ? `${view.overlapModel.selected.type}:${view.overlapModel.selected.id}`
            : null),
      })}</details>` : ""}
    </section>`;
}

function renderNearYouGeoWorkspace(view) {
  const drawerState = view.geographyState?.drawer
    || view.overlapModel?.drawer
    || "open";
  const open = drawerState !== "closed";
  const railBody = view.overlapModel && !view.overlapModel.empty
    ? renderSelectedGeographyOverlapDrawerHtml(view.overlapModel)
    : `<div class="near-geo-rail-body" data-geography-overlap-empty="true">
          <p class="near-kicker">Choose a place</p>
          <p>The list shows the same places as the map.</p>
        </div>`;
  return `<div class="near-geo-workspace" data-geography-workspace data-geography-drawer-state="${open ? "open" : "closed"}"${view.overlapModel?.focus_token ? ` data-geography-focus-restore="${esc(view.overlapModel.focus_token)}"` : ""}>
      <aside class="near-geo-rail near-geo-drawer" data-geography-drawer data-geography-record-lenses="${esc(JSON.stringify(Object.fromEntries(Object.entries(view.geographyLensCounts || {}).map(([lens, value]) => [lens, { exact: value.exact, count: value.count, state: value.state }]))))}"${view.overlapModel?.selected ? ' aria-labelledby="near-geo-overlap-heading"' : ""}>
        <button type="button" class="near-geo-drawer-toggle js-only" data-geography-drawer-toggle hidden aria-expanded="${open ? "true" : "false"}">Map details</button>
        ${railBody}
      </aside>
      ${renderNearYouMapSection(view)}
    </div>`;
}

export function renderNearYouBody(view) {
  const scopeChips = view.scopeSummary
    .filter((chip) => chip.axis !== "lens")
    .map((chip) => `<li data-scope-axis="${esc(chip.axis)}"><span>${esc(chip.label)}</span><a href="${esc(nearYouUrlFromScope(scopeWithoutAxis(view.scope, chip.axis), { base: view.canonicalBase }))}" data-remove-filter="${esc(chip.axis)}" aria-label="Remove ${esc(chip.label)}">×</a></li>`).join("");
  const walkQuery = view.scope.topic?.query || first(view.scope.topic?.keywords);
  const walkFamilies = Object.entries(LENS_LABELS).map(([lens, label]) => {
    const nextScope = normalizeScope({
      ...view.scope,
      facets: { ...view.scope.facets, domains: [lens] },
    });
    const current = lens === view.lens;
    const projection = view.geographyLensCounts?.[lens] || null;
    const exact = projection?.exact === true;
    const availableCount = current ? view.results.count : exact ? projection.count : null;
    const exactHref = exact
      ? nearYouUrlFromScope(normalizeScope({
        ...view.scope,
        facets: { ...view.scope.facets, domains: [lens] },
      }), { base: view.canonicalBase })
      : null;
    return {
      id: lens,
      label,
      kicker: current ? "Current records" : label,
      description: current
        ? "Open these records and follow their links."
        : exact
          ? "Open the records materialized for this place."
          : "This lens has no exact local filter here.",
      status: current
        ? (view.mapped && view.results.count != null ? "available" : "unknown")
        : exact ? (projection.count > 0 ? "available" : "empty") : "unsupported",
      count: availableCount,
      href: walkEntryHref(exactHref || (current ? nearYouUrlFromScope(nextScope, { base: view.canonicalBase }) : ""), {
        source: "near_you",
        query: walkQuery,
        place: view.scope,
      }),
    };
  });
  const walkHref = view.hasPlace
    ? walkEntryHref(view.shareHref, { source: "near_you", query: walkQuery, place: view.scope })
    : "#near-area-list";
  const walkEntry = renderWalkEntry({
    source: "near_you",
    query: walkQuery,
    placeLabel: walkEntryPlaceLabel(view.scope),
    families: walkFamilies,
    actionHref: walkHref,
    actionLabel: view.hasPlace ? "Walk this place" : "Choose a place",
    title: view.hasPlace ? "Walk this place" : "Start with a place",
    description: view.hasPlace
      ? "Keep this place as you view related records."
      : "Choose a place first. A guessed location is not an edge.",
    compact: true,
  });
  const shellSurface = view.shellSurface || (view.hasPlace
    ? GEOGRAPHY_NAVIGATION_SURFACE_RECORDS
    : GEOGRAPHY_NAVIGATION_SURFACE_MAP);
  const advancedFilters = renderNearYouAdvancedFilters(view);
  const coverageNotes = `${view.mapState === "unsupported" && !view.localRecovery ? `<aside class="near-coverage" role="note"><strong>${esc(view.lensLabel)} place data is not available.</strong> Your other filters stay in place; this is not an empty activity result.</aside>` : ""}
    ${view.basis === "contract_action_address" ? `<aside class="near-coverage" role="note"><strong>${esc(view.basisLabel)}.</strong> This shows where to submit a bid, attend a pre-bid event, or pick up a file. It does not say where the contract work will happen.</aside>` : ""}`;
  const recordsBlock = `<div class="near-records-surface" data-near-surface-panel="records">
      ${advancedFilters}
      ${coverageNotes}
      ${renderNearYouDeferredResultsShell(view)}
    </div>`;
  const selectedHero = view.hasPlace ? `<section class="near-hero">
      <h1>${esc(view.placePresentation.label)}</h1>
      ${view.placePresentation.boardHref ? `<p class="near-board-link"><a href="${esc(view.placePresentation.boardHref)}">${esc(view.placePresentation.boardLabel)}</a></p>` : ""}
    </section>
    <details class="near-place-guide is-set">
      <summary id="near-place-heading">Change place</summary>
      ${geographyShellSearchFormHtml({ action: view.shareHref || view.canonicalBase })}
      <details class="near-place-options"><summary>Other ways to choose</summary>
        <p>Choose another borough, neighborhood, community district, or council district. Or use your location once to match your district. Your coordinates stay in this browser; CityScroll does not save them.</p>
        <div class="near-place-actions">
          <button type="button" class="js-only near-location-action" data-use-location hidden>Use my location</button>
          <a href="#near-place-fields">Choose a place</a>
          <a href="#near-area-list">Browse the area list</a>
        </div>
      </details>
      <p class="near-map-status" data-map-status aria-live="polite"></p>
    </details>` : "";
  const selectedSecondary = view.hasPlace ? `<details class="near-selected-context">
      <summary>About this place</summary>
      <p>${view.isOverview ? "See this place summary. Then choose records to explore." : `${esc(view.lensLabel)} and public records linked to this place.`}</p>
      <ul class="near-scope" aria-label="Active filters"><li data-scope-axis="topic"><span>Topic: ${esc(view.lensLabel)}</span></li>${scopeChips}</ul>
      <div class="near-map-secondary" role="group" aria-label="Follow or share">
      <span class="near-map-secondary-label">Follow or share</span>
      <nav class="near-actions" aria-label="Map actions">
        <a href="${esc(view.browseHref)}">Open as a list</a>
        <a href="${esc(view.watchHref)}">Watch these filters</a>
        <a href="${esc(view.shareHref)}">Share this map</a>
      </nav>
      ${renderFollowDiscoveryForNearYou(view)}
      </div>
      ${renderNearYouOverview(view)}
      <details class="near-explore"><summary>Explore related records</summary>${walkEntry}</details>
      ${renderLocalConstellationHTML(view.local_constellation, { heading: "Nearby place records", id: "place-local-constellation-heading" })}
    </details>` : "";
  const unselectedEntry = view.hasPlace ? "" : renderGeographyShellEntry({
    canonicalBase: view.shareHref || view.canonicalBase || "/near-you/",
    surface: shellSurface,
    activeType: view.activeGeographyLayer || "nta2020",
    searchValue: view.scope.place.neighborhood || "",
    listHref: view.browseHref,
    watchHref: view.watchHref,
    shareHref: view.shareHref,
    followDiscoveryHtml: renderFollowDiscoveryForNearYou(view),
    siteBase: view.siteBase,
    categoryLabel: view.lensLabel,
  });
  const surfaceSwitch = view.hasPlace
    ? renderGeographyShellSurfaceSwitch({
      canonicalBase: view.shareHref || view.canonicalBase || "/near-you/",
      surface: shellSurface,
      recordsLabel: knownCount(view.results.count) == null ? "Browse records" : "Browse records",
      recordsCount: knownCount(view.results.count),
      geo: view.geographyState?.geo || view.overlapModel?.selected?.key?.replace(/^geography:/, "") || null,
      compare: view.geographyState?.compare || null,
      lens: view.lens,
      drawer: view.geographyState?.drawer || null,
      focus: view.geographyState?.focus || null,
    })
    : "";
  // Unselected entry already includes the surface switch; selected routes add one here.
  return `<main id="main" data-near-you-root data-geography-shell="map-first" data-near-surface="${esc(shellSurface)}" data-geography-layer="${esc(view.activeGeographyLayer || "nta2020")}" data-lens="${esc(view.lens)}" data-level="${esc(view.level)}"
    data-near-data-state="${esc(view.dataState)}" data-near-geometry-state="${esc(view.geometryState || "missing")}" data-near-map-state="${esc(view.mapState)}" data-near-recovery-href="${esc(view.recoveryHref)}"
    data-near-deferred-href="${esc(view.deferredDataHref || "")}" data-near-deferred-state="${esc(view.dataState === "error" ? "error" : "pending")}"
    data-message-updating="Updating the map…"
    data-message-updated="Map updated. Map and list counts match."
    data-message-location-unavailable="Location is not available in this browser. Choose an area from the list."
    data-message-location-finding="Finding your area…"
    data-message-location-matched="Location matched {district}."
    data-message-location-unmatched="No matching place was found. Try another address or choose an area from the list."
    data-message-location-update-failed="Location matched {district}, but the page could not update. Try again or choose the area from the list."
    data-message-location-denied="Location permission was not granted. Choose an area from the list."
    data-message-location-timeout="Location timed out. Try again or choose an area from the list."
    data-message-location-outside="That location is outside the covered city land. Choose an area from the list."
    data-message-location-lookup-failed="The location lookup failed. Try again or choose an area from the list."
    data-message-deferred-unavailable="${esc(view.allNyc ? `These ${LOCAL_RECOVERY_NOUNS[view.lens] || "records"} could not load.` : "Matching records are temporarily unavailable.")}"${view.allNyc ? ` data-near-all-nyc-href="${esc(view.allNyc.href)}" data-near-all-nyc-label="${esc(view.allNyc.label)}"` : ""}
    data-message-bags-unavailable="Other place records are temporarily unavailable."
    data-message-retry="Try again"
    data-translation-all-boroughs="All boroughs"
    data-translation-borough-label="Borough"
    data-translation-context-strip-label="Context">
    ${selectedHero}
    ${unselectedEntry}
    ${view.hasPlace ? "" : `${renderNearYouSpecialRecords(view, { position: "entry", shell: true })}${renderNearYouPlaceSuggestions(view)}`}
    ${surfaceSwitch}
    ${renderNearYouGeoWorkspace(view)}
    ${selectedSecondary}
    ${recordsBlock}
    ${view.hasPlace ? renderNearYouSpecialRecords(view, { position: "after-results", shell: true }) : ""}
  </main>`;
}

export function renderNearYouDocument(view, options = {}) {
  const assetPrefix = options.assetPrefix || "/";
  const prefix = assetPrefix.endsWith("/") ? assetPrefix : `${assetPrefix}/`;
  const deferredDataHref = options.deferredDataHref || view.deferredDataHref || "";
  const body = renderNearYouBody({ ...view, deferredDataHref });
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Near you · CityScroll</title><meta name="description" content="Explore NYC civic records by place without losing your active filters.">
<link rel="canonical" href="${esc(view.shareHref)}">${renderCivicDocumentAssets(assetPrefix)}
<link rel="stylesheet" href="${esc(`${prefix}walk-entry.css`)}">
<link rel="stylesheet" href="${esc(`${prefix}local_constellation.css`)}"></head>
<body><a class="skip" href="#main">Skip to content</a>
${renderCivicDocumentMast({ current: "near-you", siteBase: view.siteBase, scope: view.scope, surfaceClass: "near-mast" })}
${body}
<footer class="near-footer">Counts and place labels reflect the listed public records. Check each record with the linked official source.</footer>
<script type="module" src="${esc(prefix)}legacy_hash_forward.mjs"></script>
<script type="module" src="${esc(prefix)}analytics.js?v=1.4.0"></script>
<script type="module" src="${esc(prefix)}app/walk-entry.mjs"></script>
<script type="module" src="${esc(prefix)}app/traversal.mjs"></script><script type="module" src="${esc(prefix)}app/map.mjs"></script></body></html>`;
  return html.replace(/[ \t]+$/gm, "");
}
