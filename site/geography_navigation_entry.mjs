/**
 * Unified resident entry resolution for addresses, place labels, map clicks,
 * and explicit geolocation.
 *
 * Every successful path yields the same point-result schema and a selection
 * transition into durable geography URL state. Coordinates and address query
 * text stay ephemeral: they are discarded after containment and never
 * serialized, persisted, logged as analytics dimensions, or included in error
 * reporting payloads.
 */

import {
  GEOGRAPHY_NAVIGATION_LAYER_TYPES,
  isResidentialNeighborhoodSubtype,
  ntaResidentLabelPolicy,
  resolveGeographyNavigationKey,
} from "./geography_navigation_capability.mjs";
import {
  GEOGRAPHY_NAVIGATION_EPHEMERAL_KEYS,
  geographyNavigationPayloadLeaksEphemeral,
  omitGeographyNavigationEphemeral,
} from "./geography_navigation_state.mjs";
import { resolveCivicGeographies } from "./civic_geography.mjs";
import { civicGeographyKey } from "./civic_geography_registry.mjs";

/** Schema id avoids the private-terms geography+navigation fold. */
export const RESIDENT_GEOGRAPHY_ENTRY_SCHEMA = "cityscroll.resident_geography_entry.v1";

export const BOUNDARIES_AT_LOCATION_HEADING = "Boundaries at this location";

export const GEOGRAPHY_ENTRY_SOURCES = Object.freeze({
  POINT: "point",
  ADDRESS: "address",
  PLACE_LABEL: "place_label",
  MAP_CLICK: "map_click",
  GEOLOCATION: "geolocation",
});

export const GEOGRAPHY_ENTRY_RECOVERY = Object.freeze({
  NO_RESULT: "no_result",
  OUTSIDE_COVERED_LAND: "outside_covered_land",
  GEOLOCATION_UNAVAILABLE: "geolocation_unavailable",
  GEOLOCATION_DENIED: "geolocation_denied",
  GEOLOCATION_TIMEOUT: "geolocation_timeout",
  LOOKUP_FAILURE: "lookup_failure",
  EMPTY_QUERY: "empty_query",
  AMBIGUOUS_PLACE_LABEL: "ambiguous_place_label",
});

/**
 * Plain recovery copy. Distinct reasons stay distinct so the resident can tell
 * denial, timeout, unavailable API, lookup failure, and outside-city apart.
 */
export const GEOGRAPHY_ENTRY_RECOVERY_COPY = Object.freeze({
  [GEOGRAPHY_ENTRY_RECOVERY.NO_RESULT]:
    "No matching place was found. Try another address or choose an area from the list.",
  [GEOGRAPHY_ENTRY_RECOVERY.OUTSIDE_COVERED_LAND]:
    "That location is outside the covered city land. Choose an area from the list.",
  [GEOGRAPHY_ENTRY_RECOVERY.GEOLOCATION_UNAVAILABLE]:
    "Location is not available in this browser. Choose an area from the list.",
  [GEOGRAPHY_ENTRY_RECOVERY.GEOLOCATION_DENIED]:
    "Location permission was not granted. Choose an area from the list.",
  [GEOGRAPHY_ENTRY_RECOVERY.GEOLOCATION_TIMEOUT]:
    "Location timed out. Try again or choose an area from the list.",
  [GEOGRAPHY_ENTRY_RECOVERY.LOOKUP_FAILURE]:
    "The location lookup failed. Try again or choose an area from the list.",
  [GEOGRAPHY_ENTRY_RECOVERY.EMPTY_QUERY]:
    "Enter an address or place name to search.",
  [GEOGRAPHY_ENTRY_RECOVERY.AMBIGUOUS_PLACE_LABEL]:
    "Several places share that name. Choose the matching area from the list.",
});

const LAYER_SET = new Set(GEOGRAPHY_NAVIGATION_LAYER_TYPES);
const EPHEMERAL_SET = new Set(GEOGRAPHY_NAVIGATION_EPHEMERAL_KEYS);

function freezeDeep(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const entry of value) freezeDeep(entry);
    return Object.freeze(value);
  }
  for (const entry of Object.values(value)) freezeDeep(entry);
  return Object.freeze(value);
}

function normalizeLabelText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’‘`]/g, "'")
    .toLowerCase()
    .replace(/\b(\d+)(?:st|nd|rd|th)\b/g, "$1")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function geographyEntryRecoveryCopy(reason) {
  const key = String(reason || "");
  return GEOGRAPHY_ENTRY_RECOVERY_COPY[key] || GEOGRAPHY_ENTRY_RECOVERY_COPY[GEOGRAPHY_ENTRY_RECOVERY.LOOKUP_FAILURE];
}

function recoveryResult(reason, { source = GEOGRAPHY_ENTRY_SOURCES.POINT } = {}) {
  const message = geographyEntryRecoveryCopy(reason);
  return freezeDeep({
    schema: RESIDENT_GEOGRAPHY_ENTRY_SCHEMA,
    ok: false,
    source,
    selected: null,
    selection_policy: null,
    bundle: null,
    boundaries_heading: BOUNDARIES_AT_LOCATION_HEADING,
    ambiguity: null,
    alternatives: Object.freeze([]),
    recovery: Object.freeze({ reason, message }),
    selection: null,
    compatibility: null,
    summary: Object.freeze({
      heading: BOUNDARIES_AT_LOCATION_HEADING,
      selected_label: null,
      lines: Object.freeze([]),
      details: Object.freeze([]),
      ambiguity_note: null,
      special_use_note: null,
    }),
  });
}

function matchRecord(match, feature = null) {
  const type = String(match.type || "");
  const id = String(match.id || "");
  const subtype = feature?.subtype == null && match.subtype == null
    ? null
    : String(feature?.subtype ?? match.subtype);
  const labelPolicy = type === "nta2020"
    ? ntaResidentLabelPolicy(subtype)
    : Object.freeze({ may_label_as_neighborhood: true, subtype });
  return Object.freeze({
    key: match.key || civicGeographyKey(type, id),
    type,
    id,
    label: String(match.label || feature?.label || id),
    class: match.class || null,
    method: match.method || null,
    relation: match.relation || "contains_point",
    boundary_vintage: match.boundary_vintage || null,
    source_id: match.source_id || null,
    subtype,
    may_label_as_neighborhood: Boolean(labelPolicy.may_label_as_neighborhood),
    is_special_use: type === "nta2020" && !isResidentialNeighborhoodSubtype(subtype),
  });
}

function featureIndex(layerData) {
  const byType = new Map();
  for (const layer of Array.isArray(layerData) ? layerData : []) {
    if (!layer || typeof layer !== "object") continue;
    const type = String(layer.type || "");
    if (!LAYER_SET.has(type)) continue;
    const map = new Map();
    for (const feature of Array.isArray(layer.features) ? layer.features : []) {
      if (!feature || feature.id == null) continue;
      map.set(String(feature.id), feature);
    }
    byType.set(type, map);
  }
  return byType;
}

function bundleFromResolution(resolution, layerData) {
  const index = featureIndex(layerData);
  const byType = Object.create(null);
  for (const type of GEOGRAPHY_NAVIGATION_LAYER_TYPES) byType[type] = [];

  for (const match of resolution.matches || []) {
    if (!LAYER_SET.has(match.type)) continue;
    const feature = index.get(match.type)?.get(String(match.id)) || null;
    byType[match.type].push(matchRecord(match, feature));
  }

  const ambiguousTypes = [];
  for (const type of GEOGRAPHY_NAVIGATION_LAYER_TYPES) {
    const matches = byType[type];
    const layerStatus = (resolution.layers || []).find((row) => row.type === type);
    const hasBoundaryMethod = matches.some((row) => row.method === "point_on_polygon_boundary");
    if (matches.length > 1 || layerStatus?.status === "ambiguous_boundary" || hasBoundaryMethod) {
      if (matches.length > 0) ambiguousTypes.push(type);
    }
    byType[type] = Object.freeze(matches);
  }

  return freezeDeep({
    by_type: byType,
    layers: Object.freeze((resolution.layers || [])
      .filter((row) => LAYER_SET.has(row.type))
      .map((row) => Object.freeze({
        type: row.type,
        status: row.status,
        vintage: row.vintage,
        match_count: row.match_count,
      }))),
    ambiguous_types: Object.freeze(ambiguousTypes),
    has_ambiguity: ambiguousTypes.length > 0,
  });
}

function chooseSelected(bundle) {
  const ntaMatches = bundle.by_type.nta2020 || [];
  const residential = ntaMatches.find((row) => isResidentialNeighborhoodSubtype(row.subtype));
  if (residential) {
    return {
      selected: residential,
      selection_policy: "residential_nta",
      alternatives: Object.freeze([]),
    };
  }

  const special = ntaMatches.find((row) => row.is_special_use);
  if (special) {
    const alternatives = [
      ...(bundle.by_type.community_district || []),
      ...(bundle.by_type.council_district || []),
    ];
    return {
      selected: special,
      selection_policy: "special_use_nta_with_alternatives",
      alternatives: Object.freeze(alternatives),
    };
  }

  for (const type of GEOGRAPHY_NAVIGATION_LAYER_TYPES) {
    const matches = bundle.by_type[type] || [];
    if (matches.length) {
      return {
        selected: matches[0],
        selection_policy: `fallback_${type}`,
        alternatives: Object.freeze(matches.slice(1)),
      };
    }
  }

  return {
    selected: null,
    selection_policy: null,
    alternatives: Object.freeze([]),
  };
}

function selectionTransition(selected) {
  if (!selected?.key) return null;
  const resolved = resolveGeographyNavigationKey(selected.key);
  if (!resolved.ok) return null;
  return Object.freeze({
    geo: `${resolved.type}:${resolved.id}`,
    key: resolved.key,
    type: resolved.type,
    id: resolved.id,
  });
}

/**
 * Compatibility projection for older borough/district route destinations.
 * Entry resolution itself always keeps the full multi-layer bundle.
 */
export function projectCompatibilityDistricts(entryResult) {
  const bundle = entryResult?.bundle;
  if (!bundle) {
    return Object.freeze({
      community_district: null,
      council_district: null,
      borough: null,
    });
  }
  const community = bundle.by_type.community_district?.[0] || null;
  const council = bundle.by_type.council_district?.[0] || null;
  const boroughCode = community?.id ? String(community.id)[0] : null;
  const borough = ({
    M: "Manhattan",
    X: "Bronx",
    K: "Brooklyn",
    Q: "Queens",
    R: "Staten Island",
  })[boroughCode] || null;
  return Object.freeze({
    community_district: community?.id || null,
    council_district: council?.id || null,
    borough,
  });
}

function summaryFor(selected, bundle, {
  selectionPolicy = null,
  alternatives = [],
} = {}) {
  const lines = [];
  const details = [];
  for (const type of GEOGRAPHY_NAVIGATION_LAYER_TYPES) {
    for (const match of bundle?.by_type?.[type] || []) {
      lines.push(match.label);
      details.push(Object.freeze({
        type: match.type,
        id: match.id,
        label: match.label,
        boundary_vintage: match.boundary_vintage,
        method: match.method,
        subtype: match.subtype,
      }));
    }
  }
  const ambiguityNote = bundle?.has_ambiguity
    ? "This point sits on a boundary. Every matching area is listed; none was chosen by list order alone."
    : null;
  const specialUseNote = selectionPolicy === "special_use_nta_with_alternatives"
    ? `${selected?.label || "This area"} is a special statistical area, not a home neighborhood. Community and Council districts at this location remain available.`
    : null;
  return freezeDeep({
    heading: BOUNDARIES_AT_LOCATION_HEADING,
    selected_label: selected?.label || null,
    lines: Object.freeze(lines),
    details: Object.freeze(details),
    ambiguity_note: ambiguityNote,
    special_use_note: specialUseNote,
    alternatives: Object.freeze((alternatives || []).map((row) => row.label)),
  });
}

function successResult({
  source,
  bundle,
  selected,
  selectionPolicy,
  alternatives,
}) {
  const selection = selectionTransition(selected);
  return freezeDeep({
    schema: RESIDENT_GEOGRAPHY_ENTRY_SCHEMA,
    ok: true,
    source,
    selected,
    selection_policy: selectionPolicy,
    bundle,
    boundaries_heading: BOUNDARIES_AT_LOCATION_HEADING,
    ambiguity: Object.freeze({
      present: Boolean(bundle.has_ambiguity),
      types: bundle.ambiguous_types,
      note: bundle.has_ambiguity
        ? "This point sits on a boundary. Every matching area is listed; none was chosen by list order alone."
        : null,
    }),
    alternatives,
    recovery: null,
    selection,
    compatibility: projectCompatibilityDistricts({ bundle }),
    summary: summaryFor(selected, bundle, { selectionPolicy, alternatives }),
  });
}

function totalMatchCount(bundle) {
  return GEOGRAPHY_NAVIGATION_LAYER_TYPES.reduce(
    (sum, type) => sum + (bundle.by_type[type]?.length || 0),
    0,
  );
}

/**
 * Resolve one WGS84 point independently across the four public navigation
 * layers and normalize it into the shared entry result.
 * Coordinates are accepted as input only; the returned result never retains them.
 */
export function resolveGeographyEntryFromPoint(lon, lat, {
  layerData,
  source = GEOGRAPHY_ENTRY_SOURCES.POINT,
  types = GEOGRAPHY_NAVIGATION_LAYER_TYPES,
} = {}) {
  const longitude = Number(lon);
  const latitude = Number(lat);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
    return recoveryResult(GEOGRAPHY_ENTRY_RECOVERY.LOOKUP_FAILURE, { source });
  }
  if (!Array.isArray(layerData) || !layerData.length) {
    return recoveryResult(GEOGRAPHY_ENTRY_RECOVERY.LOOKUP_FAILURE, { source });
  }

  const navigationTypes = (Array.isArray(types) ? types : GEOGRAPHY_NAVIGATION_LAYER_TYPES)
    .map(String)
    .filter((type) => LAYER_SET.has(type));
  const resolution = resolveCivicGeographies(latitude, longitude, {
    types: navigationTypes,
    layerData,
  });
  const bundle = bundleFromResolution(resolution, layerData);
  if (!totalMatchCount(bundle)) {
    return recoveryResult(GEOGRAPHY_ENTRY_RECOVERY.OUTSIDE_COVERED_LAND, { source });
  }

  const choice = chooseSelected(bundle);
  if (!choice.selected) {
    return recoveryResult(GEOGRAPHY_ENTRY_RECOVERY.OUTSIDE_COVERED_LAND, { source });
  }

  return successResult({
    source,
    bundle,
    selected: choice.selected,
    selectionPolicy: choice.selection_policy,
    alternatives: choice.alternatives,
  });
}

export function resolveGeographyEntryFromMapClick(lon, lat, options = {}) {
  return resolveGeographyEntryFromPoint(lon, lat, {
    ...options,
    source: GEOGRAPHY_ENTRY_SOURCES.MAP_CLICK,
  });
}

export function resolveGeographyEntryFromGeolocation(lon, lat, options = {}) {
  return resolveGeographyEntryFromPoint(lon, lat, {
    ...options,
    source: GEOGRAPHY_ENTRY_SOURCES.GEOLOCATION,
  });
}

function numberedPlaceCandidates(query) {
  const normalized = normalizeLabelText(query);
  if (!normalized) return [];
  const candidates = [];

  let match = normalized.match(/^(?:city\s+)?council(?:\s+district)?\s+(\d{1,2})$/);
  if (match) candidates.push({ type: "council_district", id: String(Number(match[1])) });

  match = normalized.match(/^(?:brooklyn|manhattan|bronx|queens|staten island)\s+community\s+district\s+(\d{1,2})$/);
  if (match) {
    const borough = {
      brooklyn: "K",
      manhattan: "M",
      bronx: "X",
      queens: "Q",
      "staten island": "R",
    }[normalized.split(" community ")[0]];
    if (borough) {
      candidates.push({
        type: "community_district",
        id: `${borough}${String(Number(match[1])).padStart(2, "0")}`,
      });
    }
  }

  match = normalized.match(/^(?:community\s+district|cd)\s+([kmxqr]?\d{1,2})$/i);
  if (match) {
    const raw = match[1].toUpperCase();
    const id = /^[KMXQR]\d{1,2}$/.test(raw)
      ? `${raw[0]}${raw.slice(1).padStart(2, "0")}`
      : null;
    if (id) candidates.push({ type: "community_district", id });
  }

  match = normalized.match(/^(?:police\s+)?precinct\s+(\d{1,3})$/);
  if (match) candidates.push({ type: "police_precinct", id: String(Number(match[1])) });

  match = normalized.match(/^([kmxqr]\d{2})$/i);
  if (match) candidates.push({ type: "community_district", id: match[1].toUpperCase() });

  return candidates;
}

/**
 * Exact / case-insensitive canonical place-label selection across local layer
 * labels, stable ids, and retained aliases. Fuzzy ranking stays out of scope;
 * ambiguous multi-NTA aliases surface as multiple hits rather than a merge.
 */
export function matchGeographyPlaceLabels(query, { layerData, aliasIndex = null } = {}) {
  const normalized = normalizeLabelText(query);
  if (!normalized) return Object.freeze([]);

  const hits = [];
  const seen = new Set();
  const pushFeature = (layer, feature, method = "canonical_label") => {
    if (!feature || feature.id == null || !layer) return;
    const id = String(feature.id);
    const label = String(feature.label || "");
    const key = civicGeographyKey(layer.type, id);
    if (!key || seen.has(key)) return;
    seen.add(key);
    hits.push(matchRecord({
      key,
      type: layer.type,
      id,
      label,
      boundary_vintage: layer.vintage?.id || null,
      source_id: layer.source?.contract_id || null,
      method,
      relation: "label_match",
      class: null,
      subtype: feature.subtype,
    }, feature));
  };

  for (const layer of Array.isArray(layerData) ? layerData : []) {
    if (!layer || !LAYER_SET.has(layer.type)) continue;
    for (const feature of Array.isArray(layer.features) ? layer.features : []) {
      if (!feature || feature.id == null) continue;
      const id = String(feature.id);
      const label = String(feature.label || "");
      const labelNorm = normalizeLabelText(label);
      const idNorm = normalizeLabelText(id);
      if (labelNorm !== normalized && idNorm !== normalized) continue;
      pushFeature(layer, feature, "canonical_label");
    }
  }

  for (const candidate of numberedPlaceCandidates(query)) {
    const layer = (Array.isArray(layerData) ? layerData : [])
      .find((entry) => entry?.type === candidate.type);
    const feature = layer?.features?.find((row) => String(row.id) === candidate.id);
    if (!feature) continue;
    pushFeature(layer, feature, "canonical_label");
  }

  // Retained aliases only: never invent a single geography for an ambiguous name.
  if (aliasIndex && typeof aliasIndex === "object") {
    const ntaLayer = (Array.isArray(layerData) ? layerData : [])
      .find((entry) => entry?.type === "nta2020");
    const aliasIds = aliasIndex[normalized]
      || aliasIndex[query]
      || null;
    const ids = Array.isArray(aliasIds) ? aliasIds : (aliasIds ? [aliasIds] : []);
    for (const rawId of ids) {
      const id = String(rawId || "").trim();
      if (!id || !ntaLayer) continue;
      const feature = ntaLayer.features?.find((row) => String(row.id) === id);
      if (feature) pushFeature(ntaLayer, feature, "retained_alias");
    }
  }

  return Object.freeze(hits);
}

/**
 * Build a normalized alias → NTA id[] index from gazetteer neighborhoods.
 * Multi-code neighborhoods keep every id so callers can detect ambiguity.
 */
export function geographyPlaceAliasIndexFromGazetteer(gazetteer) {
  const neighborhoods = Array.isArray(gazetteer)
    ? gazetteer
    : Array.isArray(gazetteer?.neighborhoods) ? gazetteer.neighborhoods : [];
  const index = Object.create(null);
  for (const row of neighborhoods) {
    const codes = (Array.isArray(row?.nta_codes) ? row.nta_codes : [])
      .map((code) => String(code || "").trim())
      .filter(Boolean);
    if (!codes.length) continue;
    const names = [
      row?.name,
      ...(Array.isArray(row?.aliases) ? row.aliases : []),
      ...(Array.isArray(row?.official_names) ? row.official_names : []),
    ];
    for (const name of names) {
      const key = normalizeLabelText(name);
      if (!key) continue;
      if (!index[key]) index[key] = [];
      for (const code of codes) {
        if (!index[key].includes(code)) index[key].push(code);
      }
    }
  }
  return Object.freeze(Object.fromEntries(
    Object.entries(index).map(([key, ids]) => [key, Object.freeze(ids)]),
  ));
}

function resultFromLabelMatch(hit, { source, layerData }) {
  const byType = Object.create(null);
  for (const type of GEOGRAPHY_NAVIGATION_LAYER_TYPES) byType[type] = Object.freeze([]);
  byType[hit.type] = Object.freeze([hit]);
  const bundle = freezeDeep({
    by_type: byType,
    layers: Object.freeze(GEOGRAPHY_NAVIGATION_LAYER_TYPES.map((type) => Object.freeze({
      type,
      status: type === hit.type ? "matched" : "not_queried",
      vintage: type === hit.type ? hit.boundary_vintage : null,
      match_count: type === hit.type ? 1 : 0,
    }))),
    ambiguous_types: Object.freeze([]),
    has_ambiguity: false,
  });

  // Prefer residential NTA when the label itself is that NTA; special-use keeps
  // subtype language and offers community/Council alternatives when present in
  // the supplied layers (label path does not invent geometric neighbors).
  if (hit.type === "nta2020" && hit.is_special_use) {
    return successResult({
      source,
      bundle,
      selected: hit,
      selectionPolicy: "special_use_nta_with_alternatives",
      alternatives: Object.freeze([]),
    });
  }
  if (hit.type === "nta2020" && isResidentialNeighborhoodSubtype(hit.subtype)) {
    return successResult({
      source,
      bundle,
      selected: hit,
      selectionPolicy: "residential_nta",
      alternatives: Object.freeze([]),
    });
  }
  return successResult({
    source,
    bundle,
    selected: hit,
    selectionPolicy: `label_${hit.type}`,
    alternatives: Object.freeze([]),
  });
}

export function resolveGeographyEntryFromPlaceLabel(query, {
  layerData,
  aliasIndex = null,
  source = GEOGRAPHY_ENTRY_SOURCES.PLACE_LABEL,
} = {}) {
  const text = String(query ?? "").trim();
  if (!text) return recoveryResult(GEOGRAPHY_ENTRY_RECOVERY.EMPTY_QUERY, { source });
  const hits = matchGeographyPlaceLabels(text, { layerData, aliasIndex });
  if (!hits.length) return recoveryResult(GEOGRAPHY_ENTRY_RECOVERY.NO_RESULT, { source });
  if (hits.length > 1) {
    // Same label across layers is still one resident choice when ids align to a
    // preferred residential NTA; multiple retained NTA ids stay ambiguous.
    const ntaHits = hits.filter((row) => row.type === "nta2020");
    if (ntaHits.length > 1) {
      return recoveryResult(GEOGRAPHY_ENTRY_RECOVERY.AMBIGUOUS_PLACE_LABEL, { source });
    }
    const residential = hits.find((row) => row.type === "nta2020" && isResidentialNeighborhoodSubtype(row.subtype));
    if (residential) return resultFromLabelMatch(residential, { source, layerData });
    return recoveryResult(GEOGRAPHY_ENTRY_RECOVERY.AMBIGUOUS_PLACE_LABEL, { source });
  }
  return resultFromLabelMatch(hits[0], { source, layerData });
}

/**
 * Address search: reuse the injected geocoder contract, then the same point
 * resolver. The query string and coordinates are never retained on the result.
 */
export function resolveGeographyEntryFromAddress(query, {
  layerData,
  geocode,
  source = GEOGRAPHY_ENTRY_SOURCES.ADDRESS,
} = {}) {
  const text = String(query ?? "").trim();
  if (!text) return recoveryResult(GEOGRAPHY_ENTRY_RECOVERY.EMPTY_QUERY, { source });
  if (typeof geocode !== "function") {
    return recoveryResult(GEOGRAPHY_ENTRY_RECOVERY.LOOKUP_FAILURE, { source });
  }

  let point = null;
  try {
    point = geocode(text);
  } catch {
    return recoveryResult(GEOGRAPHY_ENTRY_RECOVERY.LOOKUP_FAILURE, { source });
  }
  if (point && typeof point.then === "function") {
    throw new TypeError("resolveGeographyEntryFromAddress expects a sync geocode helper; use resolveGeographyEntryFromAddressAsync for promises");
  }
  if (!point || typeof point !== "object") {
    return recoveryResult(GEOGRAPHY_ENTRY_RECOVERY.NO_RESULT, { source });
  }
  const lat = Number(point.lat ?? point.latitude);
  const lon = Number(point.lon ?? point.lng ?? point.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return recoveryResult(GEOGRAPHY_ENTRY_RECOVERY.LOOKUP_FAILURE, { source });
  }
  return resolveGeographyEntryFromPoint(lon, lat, { layerData, source });
}

export async function resolveGeographyEntryFromAddressAsync(query, {
  layerData,
  geocode,
  source = GEOGRAPHY_ENTRY_SOURCES.ADDRESS,
} = {}) {
  const text = String(query ?? "").trim();
  if (!text) return recoveryResult(GEOGRAPHY_ENTRY_RECOVERY.EMPTY_QUERY, { source });
  if (typeof geocode !== "function") {
    return recoveryResult(GEOGRAPHY_ENTRY_RECOVERY.LOOKUP_FAILURE, { source });
  }
  let point = null;
  try {
    point = await geocode(text);
  } catch {
    return recoveryResult(GEOGRAPHY_ENTRY_RECOVERY.LOOKUP_FAILURE, { source });
  }
  if (!point || typeof point !== "object") {
    return recoveryResult(GEOGRAPHY_ENTRY_RECOVERY.NO_RESULT, { source });
  }
  const lat = Number(point.lat ?? point.latitude);
  const lon = Number(point.lon ?? point.lng ?? point.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return recoveryResult(GEOGRAPHY_ENTRY_RECOVERY.LOOKUP_FAILURE, { source });
  }
  return resolveGeographyEntryFromPoint(lon, lat, { layerData, source });
}

/** Map a browser PositionError (or code) into a distinct recovery result. */
export function resolveGeographyEntryFromGeolocationError(error, {
  source = GEOGRAPHY_ENTRY_SOURCES.GEOLOCATION,
} = {}) {
  const code = Number(error?.code);
  if (code === 1) return recoveryResult(GEOGRAPHY_ENTRY_RECOVERY.GEOLOCATION_DENIED, { source });
  if (code === 3) return recoveryResult(GEOGRAPHY_ENTRY_RECOVERY.GEOLOCATION_TIMEOUT, { source });
  if (code === 2) return recoveryResult(GEOGRAPHY_ENTRY_RECOVERY.LOOKUP_FAILURE, { source });
  if (error == null) return recoveryResult(GEOGRAPHY_ENTRY_RECOVERY.GEOLOCATION_UNAVAILABLE, { source });
  return recoveryResult(GEOGRAPHY_ENTRY_RECOVERY.LOOKUP_FAILURE, { source });
}

export function geographyEntryUnavailableApiResult() {
  return recoveryResult(GEOGRAPHY_ENTRY_RECOVERY.GEOLOCATION_UNAVAILABLE, {
    source: GEOGRAPHY_ENTRY_SOURCES.GEOLOCATION,
  });
}

/** Strip ephemeral keys from a candidate URL/storage/analytics/error bag. */
export function omitGeographyEntryEphemeral(bag) {
  return omitGeographyNavigationEphemeral(bag);
}

/** True when a bag still carries a forbidden ephemeral key. */
export function geographyEntryPayloadLeaksEphemeral(bag) {
  if (geographyNavigationPayloadLeaksEphemeral(bag)) return true;
  if (!bag || typeof bag !== "object") return false;
  const text = JSON.stringify(bag);
  // Hard negative: raw coordinate pairs or address fields must not appear.
  if (/"(-?\d+\.\d+),\s*(-?\d+\.\d+)"/.test(text)) return true;
  for (const key of EPHEMERAL_SET) {
    if (Object.prototype.hasOwnProperty.call(bag, key)) return true;
  }
  return false;
}

/**
 * Public error/analytics projection of an entry result. Never includes
 * coordinates, address query text, or other ephemeral keys.
 */
export function geographyEntryPublicProjection(entryResult) {
  if (!entryResult || typeof entryResult !== "object") return Object.freeze({});
  const projection = {
    schema: entryResult.schema,
    ok: Boolean(entryResult.ok),
    source: entryResult.source || null,
    selection_policy: entryResult.selection_policy || null,
    selected_key: entryResult.selected?.key || null,
    selected_type: entryResult.selected?.type || null,
    selected_id: entryResult.selected?.id || null,
    recovery_reason: entryResult.recovery?.reason || null,
    ambiguous: Boolean(entryResult.ambiguity?.present),
    boundaries_heading: entryResult.boundaries_heading || BOUNDARIES_AT_LOCATION_HEADING,
  };
  return freezeDeep(omitGeographyEntryEphemeral(projection));
}

export function sameGeographyEntrySchema(left, right) {
  if (!left || !right) return false;
  return left.schema === RESIDENT_GEOGRAPHY_ENTRY_SCHEMA
    && right.schema === RESIDENT_GEOGRAPHY_ENTRY_SCHEMA
    && Boolean(left.ok) === Boolean(right.ok)
    && left.selected?.key === right.selected?.key
    && left.selection?.geo === right.selection?.geo
    && left.boundaries_heading === right.boundaries_heading;
}
