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
import { scopeWithPlace } from "./near_you_scope_runtime.mjs";
import {
  geographyKeyForScope,
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
  NEAR_YOU_RECORD_TITLE_LINK_CLASS,
  nearYouRecordInspectionFacts,
  renderNearYouRecordFullRecordLink,
  renderNearYouRecordInspectButton,
} from "./near_you_record_inspection.mjs";
import {
  geographyShellAreasListHtml,
  geographyShellSearchFormHtml,
  geographyShellLayerSwitcherHtml,
  navigationAreaEntriesFromLayerDoc,
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
import {
  buildSelectedGeographyOverlapViewModel,
  renderSelectedGeographyOverlapDrawerHtml,
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
const BOROUGHS = Object.keys(BOROUGH_META);
const NEAR_YOU_DATA_STATES = Object.freeze(["ready", "pending", "error"]);

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
  if (scope.place.neighborhood) return { label: scope.place.neighborhood };
  const geoKey = geographyState?.key || first(scope.place.geographies);
  if (geoKey) {
    const definition = geographyDefinitions?.[geoKey]
      || (GEOGRAPHY_NAVIGATION_AREA_OVERLAP_EXAMPLE.selected.key === geoKey
        ? GEOGRAPHY_NAVIGATION_AREA_OVERLAP_EXAMPLE.selected
        : null);
    if (definition?.label) return { label: definition.label, geographyKey: geoKey };
    if (geographyState?.id && geographyState?.type === "nta2020") {
      return { label: geographyState.id, geographyKey: geoKey };
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
  const mapped = MAP_LENSES.includes(lens) && lens !== "all";
  const basis = lens === "money"
    && (scope.place.viewport?.basis || scope.facets.values?.basis) === "contract_action_address"
    ? "contract_action_address"
    : "performance";
  const basisLayer = basis === "contract_action_address"
    ? activity?.basis_layers?.contract_action_address
    : null;
  const activityRoot = basisLayer
    ? {
        ...basisLayer,
        boundary_vintage: activity?.boundary_vintage,
        built_at: activity?.built_at,
      }
    : activity;
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
  const mapState = dataState === "pending"
    ? "pending"
    : dataState === "error"
      ? "error"
      : !localMembershipAvailable && mapped
        ? "unsupported"
        : mapped
        ? resultCount > 0 ? "populated" : "empty"
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
  const activeGeographyLayer = options.navigationLayerType
    || geographyState?.compare
    || geographyState?.type
    || "nta2020";
  const navigationAreas = options.navigationLayerDoc
    ? navigationAreaEntriesFromLayerDoc(options.navigationLayerDoc, {
      layerType: options.navigationLayerType || activeGeographyLayer,
    })
    : [];
  const selectedGeographyKey = geographyState?.key || first(scope.place.geographies) || null;
  const selectedGeographyDefinition = selectedGeographyKey
    ? (activity?.geography_items?.definitions?.[selectedGeographyKey]
      || (GEOGRAPHY_NAVIGATION_AREA_OVERLAP_EXAMPLE.selected.key === selectedGeographyKey
        ? GEOGRAPHY_NAVIGATION_AREA_OVERLAP_EXAMPLE.selected
        : null))
    : null;
  const overlapSelected = selectedGeographyKey
    ? {
      key: selectedGeographyKey,
      type: geographyState?.type
        || selectedGeographyDefinition?.type
        || String(selectedGeographyKey).split(":")[1]
        || null,
      id: geographyState?.id
        || selectedGeographyDefinition?.id
        || String(selectedGeographyKey).split(":")[2]
        || null,
      label: selectedGeographyDefinition?.label
        || (GEOGRAPHY_NAVIGATION_AREA_OVERLAP_EXAMPLE.selected.key === selectedGeographyKey
          ? GEOGRAPHY_NAVIGATION_AREA_OVERLAP_EXAMPLE.selected.label
          : null),
      boundary_vintage: selectedGeographyDefinition?.boundary_vintage
        || (GEOGRAPHY_NAVIGATION_AREA_OVERLAP_EXAMPLE.selected.key === selectedGeographyKey
          ? GEOGRAPHY_NAVIGATION_AREA_OVERLAP_EXAMPLE.selected.boundary_vintage
          : null),
    }
    : null;
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
  const linkedRecord = (record, { explain = true } = {}) => {
    const whyHere = explain
      ? selectNearYouExplanationPath(record.why_here_candidates, scope)
      : null;
    return {
      ...record,
      route: migratedSiteHref(record.route),
      why_here: whyHere
        ? { ...whyHere, notice_href: siteHref(whyHere.notice_href) }
        : null,
      geography_evidence: selectNearYouGeographyEvidence(record, scope),
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
      return {
        ...record,
        route: migratedSiteHref(record.route),
        why_here: whyHere ? { ...whyHere, notice_href: siteHref(whyHere.notice_href) } : null,
        geography_evidence: selectNearYouGeographyEvidence(record, lensScope),
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
  const bags = Object.fromEntries(["citywide", "virtual", "unlocated"].map((kind) => {
    const ids = dataState === "ready" && mapped
      ? intersection(activityRoot?.district_items?.[kind]?.[lens], allowed)
      : [];
    const count = dataState === "ready" && mapped ? ids.length : null;
    return [kind, {
      kind,
      label: BAG_LABELS[kind],
      ids,
      count,
      records: ids.map((id) => records[id]).filter(Boolean).sort(recordSort)
        .map((record) => linkedRecord(record, { explain: false })),
      href: urlForScope(scopeWithPlace(scope, { locationScope: kind })),
    }];
  }));
  return {
    schema: "cityscroll.near_you_view.v1",
    scope,
    lens,
    mapped,
    dataState,
    mapState,
    basis,
    basisLabel: basisLayer?.basis_label || "Affected area or place of performance",
    hasPlace,
    placePresentation: selectedPlacePresentation(scope, options.communityGeography || {}, {
      geographyState,
      geographyDefinitions: activity?.geography_items?.definitions || null,
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
    features,
    navigationAreas,
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
    browseHref: migratedSiteHref(`/${routeHashFromScope(scope, { surface: lens })}`),
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
    recoveryHref: options.recoveryHref || nearYouUrlFromScope(scope, { base: canonicalBase }),
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
}

function dateLabel(value) {
  if (!value) return "Date not published";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  // determinism-lint: allow timezone a published date is rendered in the reader's own zone, matching every other date on the Near You surface.
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(date);
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

function recordCard(record) {
  const meetingSource = record.meeting_origin
    ? `<div class="near-record-source" data-meeting-origin="${esc(record.meeting_origin)}">${record.source_url
      ? `<a href="${esc(record.source_url)}" rel="noopener noreferrer">${esc(meetingOriginLabel(record.meeting_origin))}</a>`
      : esc(meetingOriginLabel(record.meeting_origin))}</div>`
    : record.source_url
      ? `<div class="near-record-source"><a href="${esc(record.source_url)}" rel="noopener noreferrer" data-near-you-record-source>Official source</a></div>`
      : "";
  const placement = record.basis || "Local activity";
  const facts = nearYouRecordInspectionFacts(record);
  const inspectButton = facts
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
    <div class="near-record-basis"><strong>${esc(placement)}</strong></div>
    ${timing}
    ${uncertainty}
    ${fullRecord ? `<p class="near-record-actions">${fullRecord}</p>` : ""}
  </li>`;
}

function recordList(records, emptyCopy = "No records match these filters.") {
  if (!records.length) return `<p class="near-empty">${esc(emptyCopy)}</p>`;
  return `<ol class="near-records">${records.map(recordCard).join("")}</ol>`;
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

/** Render the lower-priority record lists for the deferred Near-you artifact. */
export function renderNearYouDeferredParts(view) {
  const bags = Object.values(view.bags).map((bag) => `<details class="near-bag" data-bag="${bag.kind}">
    <summary><span>${esc(bag.label)}</span>${countMarkup(bag.count)}</summary>
    <p>${bag.kind === "citywide"
      ? "These records apply citywide, so they do not belong to one district."
      : bag.kind === "virtual"
        ? "These records are online only and have no physical place."
        : "The source does not give enough place detail to map these records."}</p>
    ${recordList(bag.records, bag.count == null
      ? "These records are not available right now."
      : `No ${bag.label.toLowerCase()} records match these filters.`)}
  </details>`).join("");
  const resultCount = knownCount(view.results.count);
  const noResultsCopy = view.mapState === "unsupported" && view.membershipProjection?.state === "unfilterable"
    ? "This lens cannot be filtered to this exact area yet."
    : view.mapState === "unsupported" && view.membershipProjection?.state === "incomplete"
      ? "This area’s materialized records are incomplete."
      : view.mapState === "unsupported" && view.membershipProjection?.state === "unavailable"
        ? "This area’s materialized records are unavailable right now."
        : undefined;
  const visibleResults = view.results.records.slice(0, INITIAL_RECORD_LIMIT);
  const moreResults = view.results.records.length > INITIAL_RECORD_LIMIT && resultCount != null
    ? `<p class="near-results-more"><a href="${esc(view.browseHref)}">Open all ${resultCount} matching records</a></p>`
    : "";
  const resultsHtml = `<section class="near-results" aria-labelledby="near-results-heading"${resultCount == null ? "" : ` data-results-count="${resultCount}"`} data-near-surface-panel="records">
      <div class="near-section-heading"><div><p class="near-kicker">Matching records</p><h2 id="near-results-heading" tabindex="-1">${resultCount == null ? `Matching ${esc(view.lensLabel)} records` : `${resultCount} ${esc(view.lensLabel)} records for these filters`}</h2></div></div>
      ${recordList(visibleResults, noResultsCopy || (view.mapState === "unsupported"
        ? `${esc(view.lensLabel)} records are not mapped here.`
        : resultCount == null ? "Matching records are not available right now." : undefined))}
      ${moreResults}
    </section>`;
  const bagsHtml = `<section class="near-bags" aria-labelledby="near-bags-heading">
      <p class="near-kicker">Other places</p><h2 id="near-bags-heading">Records outside mapped districts</h2>
      <p>Citywide, online, and records without a place stay visible. We do not assign them to a district.</p>
      ${bags}
    </section>`;
  return { resultsHtml, bagsHtml };
}

export function renderNearYouDeferredBody(view) {
  const { resultsHtml, bagsHtml } = renderNearYouDeferredParts(view);
  return `${resultsHtml}
    ${bagsHtml}`;
}

function renderNearYouDeferredShell(view, part, { includeListPanelMarker = false } = {}) {
  if (part === "results") {
    return `<section class="near-results near-results-shell" aria-labelledby="near-results-heading" data-near-deferred="results" data-near-deferred-state="pending"${includeListPanelMarker ? ` data-near-surface-panel="records"` : ""} aria-busy="true">
      <div class="near-section-heading"><div><p class="near-kicker">Matching records</p><h2 id="near-results-heading" tabindex="-1">Matching ${esc(view.lensLabel)} records</h2></div></div>
      <p class="near-deferred-status" role="status" aria-live="polite">Loading matching records…</p>
    </section>`;
  }
  const bags = Object.values(view.bags).map((bag) => `<details class="near-bag" data-bag="${bag.kind}">
    <summary><span>${esc(bag.label)}</span>${countMarkup(bag.count)}</summary>
    <p class="near-deferred-status" role="status" aria-live="polite">Loading ${esc(bag.label.toLowerCase())} records…</p>
  </details>`).join("");
  return `<section class="near-bags near-bags-shell" aria-labelledby="near-bags-heading" data-near-deferred="bags" data-near-deferred-state="pending" aria-busy="true">
      <p class="near-kicker">Other places</p><h2 id="near-bags-heading">Records outside mapped districts</h2>
      <p>Citywide, online, and records without a place stay visible. We do not assign them to a district.</p>
      ${bags}
    </section>`;
}

function renderNearYouOverview(view) {
  if (!view.isOverview || !view.hasPlace) return "";
  const lensScopeHref = (lens) => {
    const scope = normalizeScope({ ...view.scope, facets: { ...view.scope.facets, domains: [lens] } });
    return nearYouUrlFromScope(scope, { base: view.canonicalBase });
  };
  const sections = view.overview.sections.map((section) => {
    const records = section.records.length ? recordList(section.records) : "";
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

function renderNearYouMapState(view) {
  const state = view.mapState;
  let notice = "";
  if (state === "unsupported") {
    const membershipState = view.membershipProjection?.state;
    const exactLocalFilterUnavailable = ["unfilterable", "unavailable", "incomplete"].includes(membershipState);
    notice = `<div class="near-coverage near-map-state" data-near-map-state="unsupported" role="note">
      <strong>${esc(exactLocalFilterUnavailable ? `${view.lensLabel} records are not available for this exact area filter.` : `${view.lensLabel} records are not mapped here.`)}</strong>
      <p>${esc(exactLocalFilterUnavailable
        ? "This lens has no exact local membership materialization here, so no local count or broader destination is shown."
        : "This map does not have place data for this lens, so it will not imply that no civic activity exists.")}</p>
      ${exactLocalFilterUnavailable ? "" : `<a href="${esc(view.browseHref)}" data-near-recovery="unsupported">Open ${esc(view.lensLabel)} records</a>`}
    </div>`;
  }
  if (state === "pending") {
    notice = `<div class="near-coverage near-map-state" data-near-map-state="pending" role="status" aria-busy="true">
      <strong>Map data is loading.</strong><p>Area counts will appear when the data is ready.</p>
    </div>`;
  }
  if (state === "error") {
    notice = `<div class="near-coverage near-map-state" data-near-map-state="error" role="alert">
      <strong>Local records are temporarily unavailable.</strong><p>Your filters and place are still selected. You can continue exploring neighborhoods on the map.</p>
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
  const navigationAreasHtml = view.navigationAreas?.length
    ? geographyShellAreasListHtml(view.navigationAreas, {
      activeType: view.activeGeographyLayer || "nta2020",
      base: view.shareHref || view.canonicalBase || "/near-you/",
      surface: GEOGRAPHY_NAVIGATION_SURFACE_MAP,
      countsByKey: view.navigationAreaCountsByKey,
    })
    : `<div class="near-area-panel" id="near-area-list">
          <h3>Areas</h3>
          <ol class="near-area-list">${featureAreas || "<li>No areas match these filters.</li>"}</ol>
        </div>`;
  return `${notice}<div class="near-map-grid" data-near-map-state="${esc(state)}">
        <div class="near-map-wrap">
          <svg id="nearMapSvg" role="img" aria-labelledby="nearMapTitle nearMapDesc" viewBox="${esc(view.viewBox)}" preserveAspectRatio="xMidYMid meet">
            <title id="nearMapTitle">New York City ${esc(view.level.replaceAll("_", " "))} map</title>
            <desc id="nearMapDesc">The area list beside this map contains the same links and ${esc(view.lensLabel)} counts.</desc>
            <g fill-rule="evenodd">${paths}</g>
            <g aria-hidden="true">${labels}</g>
          </svg>
          <div id="near-map-enhanced" class="near-map-enhanced" hidden></div>
          <p class="map-legend"><span></span> Fewer to more qualifying records</p>
          <p class="near-vintage">Map boundaries: ${esc(view.activity?.boundary_vintage || "not published")}</p>
        </div>
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
      ${view.hasPlace ? `<details class="near-map-layers"><summary>Boundary layers</summary>${geographyShellLayerSwitcherHtml({
        activeType: view.activeGeographyLayer || "nta2020",
        base: view.canonicalBase || "/near-you/",
        surface: view.shellSurface || GEOGRAPHY_NAVIGATION_SURFACE_MAP,
        selectedGeo: view.geographyState?.geo
          || (view.overlapModel?.selected
            ? `${view.overlapModel.selected.type}:${view.overlapModel.selected.id}`
            : null),
      })}</details>` : ""}
      ${renderNearYouMapState(view)}
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

export function renderNearYouBody(view, { includeListPanelMarker = false } = {}) {
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
  const coverageNotes = `${view.mapState === "unsupported" ? `<aside class="near-coverage" role="note"><strong>${esc(view.lensLabel)} place data is not available.</strong> Your other filters stay in place; this is not an empty activity result.</aside>` : ""}
    ${view.basis === "contract_action_address" ? `<aside class="near-coverage" role="note"><strong>${esc(view.basisLabel)}.</strong> This shows where to submit a bid, attend a pre-bid event, or pick up a file. It does not say where the contract work will happen.</aside>` : ""}`;
  const recordsBlock = `<div class="near-records-surface" data-near-surface-panel="records">
      ${advancedFilters}
      ${coverageNotes}
      ${renderNearYouDeferredShell(view, "results", { includeListPanelMarker })}
    </div>`;
  const selectedHero = view.hasPlace ? `<section class="near-hero">
      <p class="near-kicker">Place-first civic records</p>
      <h1>${esc(view.placePresentation.label)}</h1>
      ${view.placePresentation.boardHref ? `<p class="near-board-link"><a href="${esc(view.placePresentation.boardHref)}">${esc(view.placePresentation.boardLabel)}</a></p>` : ""}
      <p>${view.isOverview ? "See this place summary. Then choose records to explore." : `${esc(view.lensLabel)} and public records linked to this place.`}</p>
      <ul class="near-scope" aria-label="Active filters"><li data-scope-axis="topic"><span>Topic: ${esc(view.lensLabel)}</span></li>${scopeChips}</ul>
      <details class="near-map-secondary"><summary>Follow or share</summary><nav class="near-actions" aria-label="Map actions">
        <a href="${esc(view.browseHref)}">Open as a list</a>
        <a href="${esc(view.watchHref)}">Watch these filters</a>
        <a href="${esc(view.shareHref)}">Share this map</a>
      </nav>
      ${renderFollowDiscoveryForNearYou(view)}
      </details>
    </section>
      ${renderNearYouOverview(view)}
      <details class="near-explore"><summary>Explore related records</summary>${walkEntry}</details>
      ${renderLocalConstellationHTML(view.local_constellation, { heading: "Nearby place records", id: "place-local-constellation-heading" })}
    <details class="near-place-guide is-set">
      <summary id="near-place-heading">Change neighborhood or address</summary>
      ${geographyShellSearchFormHtml({ action: view.shareHref || view.canonicalBase })}
      <p>Choose another borough, neighborhood, community district, or council district. Or use your location once to match your district. Your coordinates stay in this browser; CityScroll does not save them.</p>
      <div class="near-place-actions">
        <button type="button" class="js-only near-location-action" data-use-location hidden>Use my location</button>
        <a href="#near-place-fields">Choose a place</a>
        <a href="#near-area-list">Browse the area list</a>
      </div>
      <p class="near-map-status" data-map-status aria-live="polite"></p>
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
    data-near-data-state="${esc(view.dataState)}" data-near-map-state="${esc(view.mapState)}" data-near-recovery-href="${esc(view.recoveryHref)}"
    data-near-deferred-href="${esc(view.deferredDataHref || "")}" data-near-deferred-state="pending"
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
    data-message-deferred-unavailable="Matching records are temporarily unavailable."
    data-message-bags-unavailable="Other place records are temporarily unavailable."
    data-translation-all-boroughs="All boroughs"
    data-translation-borough-label="Borough"
    data-translation-context-strip-label="Context">
    ${selectedHero}
    ${unselectedEntry}
    ${surfaceSwitch}
    ${renderNearYouGeoWorkspace(view)}
    ${recordsBlock}
    ${renderNearYouDeferredShell(view, "bags")}
  </main>`;
}

export function renderNearYouDocument(view, options = {}) {
  const assetPrefix = options.assetPrefix || "/";
  const prefix = assetPrefix.endsWith("/") ? assetPrefix : `${assetPrefix}/`;
  const deferredDataHref = options.deferredDataHref || view.deferredDataHref || "";
  const body = renderNearYouBody({ ...view, deferredDataHref }, { includeListPanelMarker: true });
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
<script type="module" src="${esc(prefix)}analytics.js?v=1.4.0"></script>
<script type="module" src="${esc(prefix)}app/walk-entry.mjs"></script>
<script type="module" src="${esc(prefix)}app/traversal.mjs"></script><script type="module" src="${esc(prefix)}app/map.mjs"></script></body></html>`;
  return html.replace(/[ \t]+$/gm, "");
}
