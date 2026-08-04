/**
 * Pure builders for district_activity precompute (cs-geo-04).
 *
 * Rolls located civic events into per-area per-lens counts using the
 * committed boundary layer (point-in-polygon) and per-lens location extractors.
 * No live GIS at render time — the artifact is the source of truth for the map.
 *
 * Lenses:
 *   land     — ZAP publisher community_district (+ optional council)
 *   property — geometry / addresses → point-in-polygon
 *   meetings — affectedAreaFromRow (title + body) + stamped affected_area
 *   rules    — ruleLocationFromRow + stamped rule_location / affected_area
 *   money    — publisher district fields, coords → PIP, optional place stamp
 */

import {
  emptyLensCounts,
  DISTRICT_ACTIVITY_SCHEMA,
  boroughFromCommunityId,
} from "../../site/map_exploration.mjs";
import {
  normalizeCommunityDistrictId,
  normalizeCouncilDistrictId,
  resolveCommunityDistrict,
  resolveCouncilDistrict,
} from "../../site/council_district_lookup.mjs";
import {
  affectedAreaFromRow,
  meetingPlaceFromRow,
} from "../../worker/src/lib/hearings.mjs";
import { ruleLocationFromRow } from "../../site/rule_location.mjs";
import {
  boroughsIn,
  communityBoardSignals,
  plainText,
} from "../../site/location_extract.mjs";
import {
  placeFromDerivations,
  compactDerivationStamp,
} from "../../site/location_derivation.mjs";
import {
  geocodeFromPlaceOrRow,
  buildCommunityToCouncilIndex,
} from "../../site/civic_address_geocode.mjs";

export { DISTRICT_ACTIVITY_SCHEMA };

const LENSES = ["land", "property", "rules", "meetings", "money"];

/**
 * Synthetic warehouse fixture rows (WH-01 sample / ER offline seed) must not
 * pollute map density. Product demos use real City Record request_ids; FIX* ids
 * are offline-only and have no place signal by construction.
 *
 * @param {object} row
 * @returns {boolean}
 */
export function isSyntheticWarehouseFixtureRow(row = {}) {
  const id = String(row?.request_id || row?.id || "").trim();
  if (/^FIX\d+/i.test(id)) return true;
  const vendor = String(row?.vendor_name || "").trim();
  if (/^FIXTURE\s+VENDOR\b/i.test(vendor)) return true;
  const pin = String(row?.pin || "").trim();
  if (/^PIN-FIXTURE-/i.test(pin)) return true;
  return false;
}

/**
 * Agency Rules public hearings that land in the meetings domain without a local
 * pin follow the same citywide default as the rules lens — the rule applies
 * city-scale unless the notice states a local geography.
 *
 * @param {object} row
 * @returns {boolean}
 */
export function isAgencyRulesMeetingRow(row = {}) {
  const section = String(row?.section_name || "").trim().toLowerCase();
  if (section === "agency rules") return true;
  // Some densified rows only carry type without section.
  const type = String(row?.type_of_notice_description || "").trim().toLowerCase();
  const title = String(row?.short_title || row?.title || "");
  if (section.includes("agency rules")) return true;
  if (type === "public hearings" && /\b(?:rules?|noh|noa|rcny)\b/i.test(title) && section !== "public hearings and meetings") {
    return false; // ambiguous — require section
  }
  return false;
}

const BOROUGH_CANON = Object.freeze({
  manhattan: "Manhattan",
  bronx: "Bronx",
  brooklyn: "Brooklyn",
  queens: "Queens",
  "staten island": "Staten Island",
});

function bump(bag, key, lens, n = 1) {
  if (!key) return;
  if (!bag[key]) bag[key] = emptyLensCounts();
  if (!LENSES.includes(lens)) return;
  bag[key][lens] = (bag[key][lens] || 0) + n;
}

function canonBorough(value) {
  if (value == null || value === "") return null;
  const raw = plainText(value);
  if (!raw) return null;
  if (raw === "Citywide" || /^city[\s-]?wide$/i.test(raw)) return "Citywide";
  const key = raw.toLowerCase().replace(/\s+/g, " ").trim();
  if (BOROUGH_CANON[key]) return BOROUGH_CANON[key];
  // Accept "the Bronx" etc. via location_extract patterns.
  const found = boroughsIn(raw);
  return found[0] || null;
}

function coordsFromPropertyRow(row) {
  const loc = row?.property_location || row?._location || row?.location || null;
  if (loc && typeof loc === "object") {
    const g = loc.geometry;
    if (g && Number.isFinite(Number(g.latitude)) && Number.isFinite(Number(g.longitude))) {
      return { lat: Number(g.latitude), lon: Number(g.longitude) };
    }
    const addrs = Array.isArray(loc.addresses) ? loc.addresses : [];
    for (const a of addrs) {
      if (a && Number.isFinite(Number(a.latitude)) && Number.isFinite(Number(a.longitude))) {
        return { lat: Number(a.latitude), lon: Number(a.longitude) };
      }
    }
  }
  if (Number.isFinite(Number(row?.latitude)) && Number.isFinite(Number(row?.longitude))) {
    return { lat: Number(row.latitude), lon: Number(row.longitude) };
  }
  if (Number.isFinite(Number(row?.lat)) && Number.isFinite(Number(row?.lon))) {
    return { lat: Number(row.lat), lon: Number(row.lon) };
  }
  return null;
}

/** Property placement shared by map density and the district weekly preset. */
export function propertyPlacementsFromRow(row, boundaries) {
  const coords = coordsFromPropertyRow(row);
  let community = null;
  let council = null;
  let borough = boroughsFromPropertyRow(row)[0] || null;
  if (coords) {
    community = resolveCommunityDistrict(coords.lat, coords.lon, boundaries);
    council = resolveCouncilDistrict(coords.lat, coords.lon, boundaries);
    if (!borough && community) borough = boroughFromCommunityId(community);
  }
  return borough || community || council
    ? [{ borough, community, council, method: coords ? "coordinates_pip" : null }]
    : [];
}

function boroughsFromPropertyRow(row) {
  const loc = row?.property_location || row?._location || row?.location || null;
  const list = Array.isArray(loc?.boroughs) ? loc.boroughs : [];
  return list.map(canonBorough).filter(Boolean);
}

/**
 * Parse community-board style agency names: "Brooklyn Community Board 1".
 */
export function communityDistrictFromAgencyName(name) {
  if (!name) return null;
  const m = String(name).match(
    /\b(Manhattan|Bronx|Brooklyn|Queens|Staten\s+Island)\s+Community\s+Board\s+(\d{1,2})\b/i,
  );
  if (!m) return null;
  const prefix = {
    manhattan: "M",
    bronx: "X",
    brooklyn: "K",
    queens: "Q",
    "staten island": "R",
  }[m[1].toLowerCase().replace(/\s+/g, " ")];
  if (!prefix) return null;
  const n = Number(m[2]);
  if (!Number.isFinite(n) || n < 1) return null;
  return prefix + String(n).padStart(2, "0");
}

/**
 * "Community Board 1, Brooklyn" → K01 (product form).
 */
export function communityDistrictFromBoardLabel(label) {
  if (!label) return null;
  const s = plainText(label);
  // "Community Board 1, Brooklyn"
  let m = s.match(
    /\bCommunity\s+Board\s+(\d{1,2})\s*,\s*(Manhattan|Bronx|Brooklyn|Queens|Staten\s+Island)\b/i,
  );
  if (m) {
    const prefix = {
      manhattan: "M",
      bronx: "X",
      brooklyn: "K",
      queens: "Q",
      "staten island": "R",
    }[m[2].toLowerCase().replace(/\s+/g, " ")];
    if (!prefix) return null;
    return prefix + String(Number(m[1])).padStart(2, "0");
  }
  // Agency form already handled by communityDistrictFromAgencyName
  return communityDistrictFromAgencyName(s);
}

/**
 * Borough President - Brooklyn / "Borough President of Queens" → borough name.
 */
export function boroughFromAgencyName(name) {
  if (!name) return null;
  const s = plainText(name);
  let m = s.match(
    /\bBorough\s+President\s*[-–:]\s*(Manhattan|Bronx|Brooklyn|Queens|Staten\s+Island)\b/i,
  );
  if (m) return canonBorough(m[1]);
  m = s.match(
    /\b(Manhattan|Bronx|Brooklyn|Queens|Staten\s+Island)\s+Borough\s+President\b/i,
  );
  if (m) return canonBorough(m[1]);
  return null;
}

/**
 * ZAP community_district cells can list multiple ids ("Q01, Q02" or "Q01/Q02").
 */
export function parseZapCommunityDistricts(value) {
  if (value == null || value === "") return [];
  const raw = String(value);
  const found = [];
  for (const m of raw.matchAll(/\b([MXKQR])\s*0?(\d{1,2})\b/gi)) {
    const id = normalizeCommunityDistrictId(m[1].toUpperCase() + String(Number(m[2])).padStart(2, "0"));
    if (id) found.push(id);
  }
  // Also accept bare product form already normalized
  const single = normalizeCommunityDistrictId(raw.trim());
  if (single) found.push(single);
  return [...new Set(found)];
}

/**
 * Build placement slots from an affected-area / rule-location shaped object.
 * Returns one or more { borough, community, council, method? } slots
 * (multi-place honest). Optional address geocode upgrades borough-only venue
 * stamps to CD + council via the committed boundary layer.
 *
 * @param {object|null} area
 * @param {object} boundaries
 * @param {{ coords?: {lat:number, lon:number}|null, row?: object|null, cdCouncilIndex?: object|null }} [opts]
 */
export function placementsFromLocatedArea(area, boundaries, opts = {}) {
  if (!area || typeof area !== "object") return [];
  const slots = [];
  const seen = new Set();
  const push = (slot) => {
    const community = slot.community ? normalizeCommunityDistrictId(slot.community) : null;
    let council = slot.council ? normalizeCouncilDistrictId(slot.council) : null;
    let borough = canonBorough(slot.borough)
      || (community ? boroughFromCommunityId(community) : null);
    // When CD is known but council is not, join via CD centroid index (land density).
    if (community && !council && opts.cdCouncilIndex) {
      const fromCd = opts.cdCouncilIndex[community];
      if (fromCd) {
        council = normalizeCouncilDistrictId(fromCd);
        if (council && !slot.method) slot = { ...slot, method: "cd_centroid_council" };
      }
    }
    if (!community && !council && !borough) return;
    const key = `${borough || ""}|${community || ""}|${council || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    slots.push({
      borough,
      community,
      council,
      ...(slot.method ? { method: slot.method } : {}),
    });
  };

  // Coordinates → shared boundary layer PIP (both district kinds).
  let coords = opts.coords
    || (area.geometry
      && Number.isFinite(Number(area.geometry.latitude))
      && Number.isFinite(Number(area.geometry.longitude))
      ? { lat: Number(area.geometry.latitude), lon: Number(area.geometry.longitude) }
      : null);

  // Offline civic gazetteer: venue (and explicit address lists) → point → PIP.
  // Do not geocode free-form matter evidence alone — a street in a title may not
  // be the matter's borough, and fabricating a pin is worse than borough-only.
  // Provenance-labeled only; unknown streets stay unresolved.
  let geocodeHit = null;
  if (!coords && boundaries) {
    const role = area.derivation?.role || null;
    const methods = area.derivation?.methods || [];
    // Venue columns, vendor/facility addresses, and explicit address lists may geocode.
    // Matter-role free-text evidence alone does not (avoids false street pins).
    const geocodeable = role === "venue"
      || role === "vendor"
      || methods.some((m) => /^(?:venue|vendor_address|civic_address)/.test(String(m)))
      || (Array.isArray(area.addresses) && area.addresses.length > 0)
      || opts.forceGeocode
      || opts.row?.street_address_1
      || opts.row?.vendor_address;
    if (geocodeable) {
      geocodeHit = geocodeFromPlaceOrRow(area, opts.row || null);
      if (geocodeHit) {
        coords = { lat: geocodeHit.lat, lon: geocodeHit.lon };
      }
    }
  }

  if (coords && boundaries) {
    const community = resolveCommunityDistrict(coords.lat, coords.lon, boundaries);
    const council = resolveCouncilDistrict(coords.lat, coords.lon, boundaries);
    const borough = community
      ? boroughFromCommunityId(community)
      : (geocodeHit?.borough
        || (Array.isArray(area.boroughs) ? canonBorough(area.boroughs[0]) : null));
    push({
      borough,
      community,
      council,
      method: geocodeHit ? "civic_address_pip" : "coordinates_pip",
    });
  }

  // Community board labels → product CD ids.
  const boards = [
    ...(Array.isArray(area.community_boards) ? area.community_boards : []),
    ...(Array.isArray(area.communityBoards) ? area.communityBoards : []),
  ];
  for (const board of boards) {
    const cd = communityDistrictFromBoardLabel(board);
    if (cd) push({ community: cd, borough: boroughFromCommunityId(cd) });
  }

  // Numeric community district lists need a borough to form product ids.
  const boroughs = (Array.isArray(area.boroughs) ? area.boroughs : [])
    .map(canonBorough)
    .filter(Boolean);
  const primaryBoro = boroughs[0] || null;
  const prefix = primaryBoro
    ? { Manhattan: "M", Bronx: "X", Brooklyn: "K", Queens: "Q", "Staten Island": "R" }[primaryBoro]
    : null;
  const cdNums = Array.isArray(area.community_districts) ? area.community_districts : [];
  for (const raw of cdNums) {
    const asProduct = normalizeCommunityDistrictId(raw);
    if (asProduct) {
      push({ community: asProduct, borough: boroughFromCommunityId(asProduct) });
      continue;
    }
    if (prefix && /^\d{1,2}$/.test(String(raw).trim())) {
      const id = prefix + String(Number(raw)).padStart(2, "0");
      push({ community: id, borough: primaryBoro });
    }
  }

  // Named districts / product CD strings in free-form district lists.
  for (const d of Array.isArray(area.districts) ? area.districts : []) {
    const cd = normalizeCommunityDistrictId(d) || communityDistrictFromBoardLabel(d);
    if (cd) push({ community: cd, borough: boroughFromCommunityId(cd) });
  }

  // Explicit publisher council field.
  if (area.council_district || area.council) {
    const council = normalizeCouncilDistrictId(area.council_district || area.council);
    if (council) {
      push({
        borough: primaryBoro || boroughs[0] || null,
        community: null,
        council,
      });
    }
  }

  // Borough-only slots when no CD/council was resolved (still map-visible).
  if (!slots.length) {
    for (const b of boroughs) push({ borough: b, community: null, council: null });
  }

  // Citywide scope with no local pins → Citywide first-class bucket (not invented districts).
  if (!slots.length && area.scope === "citywide") {
    push({ borough: "Citywide", community: null, council: null, method: "citywide" });
  }

  return slots;
}

/**
 * Resolve meetings placement from stamped affected_area or the human-derivation chain
 * (matter → venue → agency HQ). Venue addresses geocode offline to CD + council.
 * Slots carry method + confidence when known. Virtual-only → explicit virtual bucket.
 *
 * @param {object} row
 * @param {object} boundaries
 * @param {{ cdCouncilIndex?: object|null }} [opts]
 */
export function meetingPlacementsFromRow(row, boundaries, opts = {}) {
  const stamped = row?.affected_area || row?.place || row?._location || null;
  let area;
  let meta = {
    method: null,
    confidence: null,
    confidence_tier: null,
    unlocated_reason: null,
    virtual_only: false,
  };

  if (stamped && typeof stamped === "object" && (
    stamped.scope
    || stamped.boroughs?.length
    || stamped.unlocated_reason
    || stamped.virtual_only
  )) {
    area = stamped;
    meta.method = stamped.derivation?.methods?.[0] || stamped.source || "stamped";
    meta.confidence = stamped.derivation?.confidence ?? null;
    meta.confidence_tier = stamped.confidence_tier || null;
    meta.unlocated_reason = stamped.unlocated_reason || null;
    meta.virtual_only = !!(stamped.virtual_only || stamped.unlocated_reason === "virtual_only");
  } else {
    area = meetingPlaceFromRow(row || {});
    meta.method = area.derivation?.methods?.[0] || area.source || null;
    meta.confidence = area.derivation?.confidence ?? null;
    meta.confidence_tier = area.confidence_tier || null;
    meta.unlocated_reason = area.unlocated_reason || null;
    meta.virtual_only = !!(area.virtual_only || area.unlocated_reason === "virtual_only");
  }

  // Virtual-only with no matter/place pin → explicit Virtual bucket (not silent unlocated).
  // Hybrid / matter-located + remote venue still use the matter geography.
  const unlocatedVirtual = area?.scope === "unlocated"
    && (area?.unlocated_reason === "virtual_only" || area?.virtual_only || meta.virtual_only);
  if (unlocatedVirtual) {
    const slots = [{
      borough: "Virtual",
      community: null,
      council: null,
      method: "virtual_only",
      confidence: 0.9,
      confidence_tier: "strong",
      bucket: "virtual",
    }];
    return slots;
  }

  // Agency-level borough / CD signals supplement title/body extraction.
  const agencyCd = communityDistrictFromAgencyName(row?.agency_name);
  const agencyBoro = boroughFromAgencyName(row?.agency_name);
  const boardFromAgency = communityBoardSignals(plainText(row?.agency_name || ""));
  const merged = {
    ...area,
    boroughs: [
      ...(Array.isArray(area?.boroughs) ? area.boroughs : []),
      ...(agencyBoro ? [agencyBoro] : []),
      ...boardFromAgency.boroughs,
    ],
    community_boards: [
      ...(Array.isArray(area?.community_boards) ? area.community_boards : []),
      ...boardFromAgency.boards,
    ],
  };
  if (agencyCd) {
    merged.community_districts = [
      ...(Array.isArray(merged.community_districts) ? merged.community_districts : []),
      agencyCd,
    ];
  }

  const coords = coordsFromPropertyRow(row);
  let slots = placementsFromLocatedArea(merged, boundaries, {
    coords,
    row,
    cdCouncilIndex: opts.cdCouncilIndex || null,
  });
  // Agency CD alone (no extractor hit).
  if (!slots.length && agencyCd) {
    slots = [{
      borough: boroughFromCommunityId(agencyCd),
      community: agencyCd,
      council: opts.cdCouncilIndex?.[agencyCd] || null,
      method: "agency_community_board",
    }];
    meta.method = meta.method || "agency_community_board";
    meta.confidence = meta.confidence ?? 0.85;
    meta.confidence_tier = meta.confidence_tier || "strong";
  }
  if (!slots.length && agencyBoro) {
    slots = [{ borough: agencyBoro, community: null, council: null }];
    meta.method = meta.method || "agency_borough";
    meta.confidence = meta.confidence ?? 0.85;
    meta.confidence_tier = meta.confidence_tier || "strong";
  }

  // Annotate slots with derivation meta for density payload accounting.
  // Prefer point-PIP / geocode method when the slot already carries one.
  slots = slots.map((s) => ({
    ...s,
    method: s.method || meta.method,
    confidence: s.confidence ?? meta.confidence,
    confidence_tier: s.confidence_tier || meta.confidence_tier || (
      meta.confidence == null ? null
        : meta.confidence >= 0.8 ? "strong"
          : meta.confidence >= 0.55 ? "derived" : "weak"
    ),
    ...(s.borough === "Citywide" || s.method === "citywide" ? { bucket: "citywide" } : {}),
  }));

  // Agency Rules rows in the meetings domain: no local pin → citywide (parity
  // with rulePlacementsFromRow / placeFromDerivations forLens=rules). Honors
  // stamped unlocated Agency Rules densify fields without inventing a borough.
  if (!slots.length && isAgencyRulesMeetingRow(row)) {
    return [{
      borough: "Citywide",
      community: null,
      council: null,
      method: "rule_default_citywide",
      confidence: 0.8,
      confidence_tier: "strong",
      bucket: "citywide",
    }];
  }

  if (!slots.length) {
    slots.unlocated_reason = meta.unlocated_reason
      || area?.unlocated_reason
      || "no_place_signal";
  }
  return slots;
}

/**
 * Resolve rules placement from stamped location or rule-scope extractor.
 * Citywide rules land in the Citywide bucket (visible at every map level).
 *
 * @param {object} row
 * @param {object} boundaries
 * @param {{ cdCouncilIndex?: object|null }} [opts]
 */
export function rulePlacementsFromRow(row, boundaries, opts = {}) {
  const stamped = row?.rule_location || row?.affected_area || row?.place || null;
  let area;
  let method = "rule-scope";
  let confidence = 0.8;
  if (stamped && typeof stamped === "object" && (stamped.scope || stamped.boroughs)) {
    area = stamped;
    method = stamped.derivation?.methods?.[0] || stamped.source || "stamped";
    confidence = stamped.derivation?.confidence ?? 0.8;
  } else {
    // Rule hearings may carry the same body fields as meetings; prefer hearing area when present.
    const hearingArea = affectedAreaFromRow(row || {});
    if (hearingArea.scope === "local") {
      area = hearingArea;
      method = "hearing_matter";
      confidence = hearingArea.derivation?.confidence ?? 0.88;
    } else {
      area = ruleLocationFromRow(row || {}, {
        hearingArea: hearingArea.scope === "local" ? hearingArea : null,
      });
      method = area.derivation?.methods?.[0] || area.source || "rule-scope";
      confidence = area.derivation?.confidence ?? 0.8;
    }
  }
  const agencyCd = communityDistrictFromAgencyName(row?.agency_name);
  const agencyBoro = boroughFromAgencyName(row?.agency_name);
  const merged = {
    ...area,
    boroughs: [
      ...(Array.isArray(area?.boroughs) ? area.boroughs : []),
      ...(agencyBoro ? [agencyBoro] : []),
    ],
  };
  if (agencyCd) {
    merged.community_districts = [
      ...(Array.isArray(merged.community_districts) ? merged.community_districts : []),
      agencyCd,
    ];
  }
  const coords = coordsFromPropertyRow(row);
  let slots = placementsFromLocatedArea(merged, boundaries, {
    coords,
    row,
    cdCouncilIndex: opts.cdCouncilIndex || null,
  });
  if (!slots.length && agencyCd) {
    slots = [{
      borough: boroughFromCommunityId(agencyCd),
      community: agencyCd,
      council: opts.cdCouncilIndex?.[agencyCd] || null,
    }];
    method = "agency_community_board";
    confidence = 0.85;
  }
  if (!slots.length && agencyBoro) {
    slots = [{ borough: agencyBoro, community: null, council: null }];
    method = "agency_borough";
    confidence = 0.85;
  }
  return slots.map((s) => ({
    ...s,
    method: s.method || method,
    confidence: s.confidence ?? confidence,
    confidence_tier: (s.confidence ?? confidence) >= 0.8
      ? "strong"
      : (s.confidence ?? confidence) >= 0.55 ? "derived" : "weak",
    ...(s.borough === "Citywide" || s.method === "citywide" || area?.scope === "citywide"
      ? { bucket: "citywide" }
      : {}),
  }));
}

/**
 * Resolve money / contracts placement from publisher geo fields, coords, place stamp,
 * or human-derivation (performance place phrases, vendor place names, citywide body).
 * Vendor / facility addresses geocode offline when present; genuine citywide awards
 * land in the Citywide bucket. Never invents a district from agency name alone.
 *
 * @param {object} row
 * @param {object} boundaries
 * @param {{ cdCouncilIndex?: object|null }} [opts]
 */
export function moneyPlacementsFromRow(row, boundaries, opts = {}) {
  const annotate = (slots, method, confidence) => slots.map((s) => ({
    ...s,
    method: s.method || method,
    confidence: s.confidence ?? confidence,
    confidence_tier: s.confidence_tier || (
      confidence >= 0.8 ? "strong" : confidence >= 0.55 ? "derived" : "weak"
    ),
    ...(s.borough === "Citywide" || s.method === "citywide" || method === "citywide"
      ? { bucket: "citywide" }
      : {}),
  }));

  const stamped = row?.place || row?.location || row?.affected_area || null;
  if (stamped && typeof stamped === "object") {
    // Citywide stamps first-class (not only borough bag).
    if (stamped.scope === "citywide" && !stamped.boroughs?.length) {
      return annotate(
        [{ borough: "Citywide", community: null, council: null, bucket: "citywide" }],
        stamped.derivation?.methods?.[0] || "citywide",
        stamped.derivation?.confidence ?? 0.8,
      );
    }
    const slots = placementsFromLocatedArea(stamped, boundaries, {
      coords: coordsFromPropertyRow(row),
      row,
      cdCouncilIndex: opts.cdCouncilIndex || null,
    });
    if (slots.length) {
      return annotate(
        slots,
        stamped.derivation?.methods?.[0] || "stamped",
        stamped.derivation?.confidence ?? 0.9,
      );
    }
  }

  const coords = coordsFromPropertyRow(row);
  if (coords && boundaries) {
    const community = resolveCommunityDistrict(coords.lat, coords.lon, boundaries);
    const council = resolveCouncilDistrict(coords.lat, coords.lon, boundaries);
    const borough = community
      ? boroughFromCommunityId(community)
      : canonBorough(row?.borough);
    if (community || council || borough) {
      return annotate([{ borough, community, council }], "coordinates_pip", 0.95);
    }
  }

  // Offline geocode of vendor / facility address columns.
  const geo = geocodeFromPlaceOrRow(stamped, row);
  if (geo && boundaries) {
    const community = resolveCommunityDistrict(geo.lat, geo.lon, boundaries);
    const council = resolveCouncilDistrict(geo.lat, geo.lon, boundaries);
    const borough = community
      ? boroughFromCommunityId(community)
      : (geo.borough || null);
    if (community || council || borough) {
      return annotate(
        [{ borough, community, council }],
        "civic_address_pip",
        0.7,
      );
    }
  }

  // Publisher district columns (warehouse / hand-stamped).
  const cds = parseZapCommunityDistricts(row?.community_district);
  const council = normalizeCouncilDistrictId(row?.council_district || row?.cc_district);
  const borough = canonBorough(row?.borough)
    || (cds[0] ? boroughFromCommunityId(cds[0]) : null);
  if (cds.length) {
    return annotate(
      cds.map((cd) => ({
        borough: borough || boroughFromCommunityId(cd),
        community: cd,
        council: council || opts.cdCouncilIndex?.[cd] || null,
      })),
      "publisher_district",
      0.95,
    );
  }
  if (council || borough) {
    return annotate(
      [{ borough, community: null, council: council || null }],
      "publisher_district",
      0.9,
    );
  }

  // Human derivation: title/body place phrases, vendor gazetteer, citywide awards.
  const derived = placeFromDerivations(row || {}, { forLens: "money" });
  if (derived.scope === "citywide" && !derived.boroughs?.length) {
    return annotate(
      [{ borough: "Citywide", community: null, council: null, bucket: "citywide" }],
      derived.derivation?.methods?.[0] || "citywide",
      derived.derivation?.confidence ?? 0.8,
    );
  }
  if (derived.scope !== "unlocated") {
    const slots = placementsFromLocatedArea(derived, boundaries, {
      row,
      cdCouncilIndex: opts.cdCouncilIndex || null,
    });
    if (slots.length) {
      return annotate(
        slots,
        derived.derivation?.methods?.[0] || "derived",
        derived.derivation?.confidence ?? 0.55,
      );
    }
  }

  // Title / description place words (honest borough-only when present).
  // Do NOT use vendor_name alone — "Queens Community House" is an org HQ, not
  // the service geography. Vendor address is handled earlier as a weaker path.
  const haystack = plainText([
    row?.short_title,
    row?.additional_description_1,
    row?.other_info_1,
  ].filter(Boolean).join(" "));
  const boros = boroughsIn(haystack).filter((b) => {
    // Skip false "citywide" agency titles that only name DCAS.
    if (b === "Citywide") return false;
    return true;
  });
  if (boros.length) {
    return annotate(
      boros.map((b) => ({ borough: b, community: null, council: null })),
      "title_borough",
      0.88,
    );
  }

  // Service-borough / performance fields when warehouse columns exist.
  const serviceBoro = canonBorough(
    row?.service_borough || row?.borough_of_performance || row?.work_borough,
  );
  if (serviceBoro) {
    return annotate(
      [{ borough: serviceBoro, community: null, council: null }],
      "service_borough",
      0.85,
    );
  }

  const empty = [];
  empty.unlocated_reason = derived.unlocated_reason || "no_place_signal";
  return empty;
}

/**
 * Supplemental contract response-logistics layer. These counts stay separate
 * from Money performance-place density: an agency office, pre-bid venue, or
 * document-pickup counter does not say where contract work occurs.
 */
export function buildContractActionBasisLayer(rows = [], boundaries = null) {
  const byBorough = Object.create(null);
  const byCommunity = Object.create(null);
  const byCouncil = Object.create(null);
  const unlocated = emptyLensCounts();
  const byBasis = Object.create(null);
  const source = {
    corpus: "contract_action_address_locations",
    counted: 0,
    with_address: 0,
    located: 0,
    by_basis: byBasis,
  };
  const bumpMoney = (bag, key) => {
    if (!key) return;
    if (!bag[key]) bag[key] = emptyLensCounts();
    bag[key].money = (bag[key].money || 0) + 1;
  };

  for (const row of rows || []) {
    source.counted += 1;
    const addresses = Array.isArray(row?.addresses) ? row.addresses : [];
    if (addresses.length) source.with_address += 1;
    const boroughs = new Set();
    const communities = new Set();
    const councils = new Set();
    const bases = new Set();
    for (const location of Array.isArray(row?.locations) ? row.locations : []) {
      if (location?.is_place_of_performance !== false || !location?.basis) continue;
      const borough = canonBorough(location.borough);
      const community = normalizeCommunityDistrictId(location.community_district);
      const council = normalizeCouncilDistrictId(location.council_district);
      if (borough) boroughs.add(borough);
      if (community) communities.add(community);
      if (council) councils.add(council);
      bases.add(location.basis);
    }
    if (!boroughs.size && !communities.size && !councils.size) {
      unlocated.money += 1;
      continue;
    }
    source.located += 1;
    for (const basis of bases) byBasis[basis] = (byBasis[basis] || 0) + 1;
    for (const borough of boroughs) bumpMoney(byBorough, borough);
    for (const community of communities) bumpMoney(byCommunity, community);
    for (const council of councils) bumpMoney(byCouncil, council);
  }

  for (const borough of ["Manhattan", "Bronx", "Brooklyn", "Queens", "Staten Island"]) {
    if (!byBorough[borough]) byBorough[borough] = emptyLensCounts();
  }
  for (const district of boundaries?.community_districts || []) {
    const id = normalizeCommunityDistrictId(district?.id || district?.boro_cd);
    if (!id || Number(id.slice(1)) > 18) continue;
    if (!byCommunity[id]) byCommunity[id] = emptyLensCounts();
  }
  for (const district of boundaries?.council_districts || []) {
    const id = normalizeCouncilDistrictId(district?.id);
    if (id && !byCouncil[id]) byCouncil[id] = emptyLensCounts();
  }

  return {
    basis: "contract_action_address",
    basis_label: "Located by contract response address",
    is_place_of_performance: false,
    by_level: {
      borough: byBorough,
      community_district: byCommunity,
      council_district: byCouncil,
    },
    citywide: emptyLensCounts(),
    virtual: emptyLensCounts(),
    unlocated,
    sources: { money: source },
    note:
      "Response logistics only. Counts name their submission, pre-bid, or document-pickup basis and are never merged into performance-place density.",
  };
}

/**
 * Build the full district_activity document from committed corpora.
 *
 * @param {object} opts
 * @param {object} opts.boundaries — district_boundaries.v1
 * @param {object[]} [opts.zapRows]
 * @param {object[]} [opts.propertyRows]
 * @param {object[]} [opts.meetingsRows]
 * @param {object[]} [opts.rulesRows]
 * @param {object[]} [opts.moneyRows]
 * @param {object[]} [opts.contractActionRows]
 * @param {string} [opts.builtAt]
 */
export function buildDistrictActivity(opts = {}) {
  const boundaries = opts.boundaries;
  if (!boundaries || !boundaries.boundary_vintage) {
    throw new Error("buildDistrictActivity requires a labeled boundary layer");
  }

  // CD → council via centroid PIP (land density join; labeled when used).
  const cdCouncilIndex = opts.cdCouncilIndex
    || buildCommunityToCouncilIndex(boundaries, resolveCouncilDistrict);

  const byBorough = Object.create(null);
  const byCommunity = Object.create(null);
  const byCouncil = Object.create(null);
  const citywideBag = emptyLensCounts();
  const virtualBag = emptyLensCounts();
  const unlocated = emptyLensCounts();
  const unlocatedReasons = {
    land: Object.create(null),
    property: Object.create(null),
    meetings: Object.create(null),
    rules: Object.create(null),
    money: Object.create(null),
  };
  const sources = {
    land: { corpus: "zap_projects_warehouse_lookup", counted: 0, located: 0, by_method: Object.create(null) },
    property: { corpus: "property_domain_observations", counted: 0, located: 0, by_method: Object.create(null) },
    meetings: { corpus: "meetings_domain_observations", counted: 0, located: 0, by_method: Object.create(null) },
    rules: { corpus: "rules_domain_observations", counted: 0, located: 0, by_method: Object.create(null) },
    money: { corpus: "money_domain_observations", counted: 0, located: 0, by_method: Object.create(null) },
  };

  function bumpMethod(lens, method) {
    const key = method || "unknown";
    sources[lens].by_method[key] = (sources[lens].by_method[key] || 0) + 1;
  }

  function bumpUnlocatedReason(lens, reason) {
    const key = reason || "no_place_signal";
    unlocatedReasons[lens][key] = (unlocatedReasons[lens][key] || 0) + 1;
  }

  function isCitywideSlot(slot) {
    return slot?.bucket === "citywide"
      || slot?.borough === "Citywide"
      || slot?.method === "citywide"
      || slot?.method === "citywide_phrase"
      || slot?.method === "rule_default_citywide";
  }

  function isVirtualSlot(slot) {
    return slot?.bucket === "virtual"
      || slot?.borough === "Virtual"
      || slot?.method === "virtual_only";
  }

  function place(lens, { borough, community, council, method }) {
    sources[lens].counted += 1;
    let placed = false;
    let resolvedCouncil = council ? normalizeCouncilDistrictId(council) : null;
    if (community) {
      const cd = normalizeCommunityDistrictId(community);
      if (cd) {
        bump(byCommunity, cd, lens);
        const b = borough || boroughFromCommunityId(cd);
        if (b && b !== "Citywide" && b !== "Virtual") bump(byBorough, b, lens);
        // Council join when publisher field missing: CD centroid → council polygon.
        if (!resolvedCouncil && cdCouncilIndex[cd]) {
          resolvedCouncil = normalizeCouncilDistrictId(cdCouncilIndex[cd]);
          if (!method) method = "cd_centroid_council";
        }
        placed = true;
      }
    }
    if (resolvedCouncil) {
      bump(byCouncil, resolvedCouncil, lens);
      placed = true;
    }
    if (borough === "Citywide" || method === "citywide") {
      citywideBag[lens] = (citywideBag[lens] || 0) + 1;
      bump(byBorough, "Citywide", lens);
      placed = true;
    } else if (borough === "Virtual" || method === "virtual_only") {
      virtualBag[lens] = (virtualBag[lens] || 0) + 1;
      bump(byBorough, "Virtual", lens);
      placed = true;
    } else if (!placed && borough) {
      bump(byBorough, borough, lens);
      placed = true;
    }
    if (placed) {
      sources[lens].located += 1;
      if (method) bumpMethod(lens, method);
    } else {
      unlocated[lens] += 1;
    }
  }

  /**
   * Count one source row once in sources.counted, fan out to districts, and
   * mark located if any slot placed. Multi-place rows bump district bags once
   * each without inflating sources.counted (unlike multi-CD ZAP, which is
   * multi-row intentional). Citywide / virtual slots go to first-class bags.
   */
  function placeSlots(lens, slots) {
    sources[lens].counted += 1;
    if (!slots.length) {
      unlocated[lens] += 1;
      bumpUnlocatedReason(lens, slots.unlocated_reason || "no_place_signal");
      return;
    }
    let placed = false;
    let method = null;
    let sawCitywide = false;
    let sawVirtual = false;
    for (const slot of slots) {
      let slotPlaced = false;
      if (slot.method) method = slot.method;
      if (isVirtualSlot(slot)) {
        sawVirtual = true;
        slotPlaced = true;
        continue;
      }
      if (isCitywideSlot(slot)) {
        sawCitywide = true;
        slotPlaced = true;
        // Still also record in borough Citywide bag below.
        continue;
      }
      if (slot.community) {
        const cd = normalizeCommunityDistrictId(slot.community);
        if (cd) {
          bump(byCommunity, cd, lens);
          const b = slot.borough || boroughFromCommunityId(cd);
          if (b && b !== "Citywide" && b !== "Virtual") bump(byBorough, b, lens);
          // Supplement council from CD centroid when the slot has CD but no council.
          if (!slot.council && cdCouncilIndex[cd]) {
            const fromCd = normalizeCouncilDistrictId(cdCouncilIndex[cd]);
            if (fromCd) {
              bump(byCouncil, fromCd, lens);
              if (!method || method === slot.method) method = method || "cd_centroid_council";
            }
          }
          slotPlaced = true;
        }
      }
      if (slot.council) {
        const id = normalizeCouncilDistrictId(slot.council);
        if (id) {
          bump(byCouncil, id, lens);
          slotPlaced = true;
        }
      }
      if (!slotPlaced && slot.borough && slot.borough !== "Citywide" && slot.borough !== "Virtual") {
        bump(byBorough, slot.borough, lens);
        slotPlaced = true;
      }
      if (slotPlaced) placed = true;
    }
    if (sawCitywide) {
      citywideBag[lens] = (citywideBag[lens] || 0) + 1;
      bump(byBorough, "Citywide", lens);
      placed = true;
      method = method || "citywide";
    }
    if (sawVirtual) {
      virtualBag[lens] = (virtualBag[lens] || 0) + 1;
      bump(byBorough, "Virtual", lens);
      placed = true;
      method = method || "virtual_only";
    }
    if (placed) {
      sources[lens].located += 1;
      bumpMethod(lens, method);
    } else {
      unlocated[lens] += 1;
      bumpUnlocatedReason(lens, slots.unlocated_reason || "no_place_signal");
    }
  }

  // Land — publisher community_district on ZAP; council via ZAP field or CD centroid.
  for (const row of opts.zapRows || []) {
    const cds = parseZapCommunityDistricts(row.community_district);
    const boro = canonBorough(row.borough) || (cds[0] ? boroughFromCommunityId(cds[0]) : null);
    const publisherCouncil = normalizeCouncilDistrictId(
      row.cc_district || row.council_district || row.city_council_district,
    );
    if (cds.length) {
      for (const cd of cds) {
        // Multi-CD projects count once per listed district (honest multi-place).
        place("land", {
          borough: boro,
          community: cd,
          council: publisherCouncil,
          method: publisherCouncil ? "publisher_council" : "cd_centroid_council",
        });
      }
    } else {
      place("land", {
        borough: boro,
        community: null,
        council: publisherCouncil,
        method: publisherCouncil ? "publisher_council" : null,
      });
    }
  }

  // Property — geometry → point-in-polygon; else borough-only.
  for (const row of opts.propertyRows || []) {
    const placements = propertyPlacementsFromRow(row, boundaries);
    if (placements.length) place("property", placements[0]);
    else place("property", {});
  }

  const placeOpts = { cdCouncilIndex };

  // Meetings — venue geocode + boundary PIP / CD resolve; virtual → Virtual bag.
  for (const row of opts.meetingsRows || []) {
    placeSlots("meetings", meetingPlacementsFromRow(row, boundaries, placeOpts));
  }

  // Rules — rule-scope / hearing extractors; citywide → Citywide bag.
  for (const row of opts.rulesRows || []) {
    placeSlots("rules", rulePlacementsFromRow(row, boundaries, placeOpts));
  }

  // Money — publisher geo, coords/gazetteer PIP, citywide phrase, service borough.
  // Skip synthetic warehouse FIX* sample rows so offline ER fixtures do not
  // inflate map unlocated / no_place_signal accounting.
  for (const row of opts.moneyRows || []) {
    if (isSyntheticWarehouseFixtureRow(row)) continue;
    placeSlots("money", moneyPlacementsFromRow(row, boundaries, placeOpts));
  }

  const contractActionBasis = buildContractActionBasisLayer(
    opts.contractActionRows || [],
    boundaries,
  );

  // Ensure every borough / regular CD / council id has a counts bag (zeros OK).
  for (const b of ["Manhattan", "Bronx", "Brooklyn", "Queens", "Staten Island"]) {
    if (!byBorough[b]) byBorough[b] = emptyLensCounts();
  }
  // First-class non-polygon bags when any lens used them.
  if (Object.values(citywideBag).some((n) => n > 0) && !byBorough.Citywide) {
    byBorough.Citywide = emptyLensCounts();
  }
  if (Object.values(virtualBag).some((n) => n > 0) && !byBorough.Virtual) {
    byBorough.Virtual = emptyLensCounts();
  }
  for (const d of boundaries.community_districts || []) {
    const id = d?.id;
    if (!id) continue;
    const num = Number(String(id).slice(1));
    if (Number.isFinite(num) && num > 18) continue;
    if (!byCommunity[id]) byCommunity[id] = emptyLensCounts();
  }
  for (const d of boundaries.council_districts || []) {
    const id = d?.id != null ? String(d.id) : null;
    if (!id) continue;
    if (!byCouncil[id]) byCouncil[id] = emptyLensCounts();
  }

  return {
    schema: DISTRICT_ACTIVITY_SCHEMA,
    boundary_vintage: String(boundaries.boundary_vintage),
    built_at: opts.builtAt || new Date().toISOString(),
    levels: ["borough", "community_district", "council_district"],
    lenses: LENSES.slice(),
    by_level: {
      borough: byBorough,
      community_district: byCommunity,
      council_district: byCouncil,
    },
    // First-class non-district bags — shown on the map surface at every level
    // so city-scale rules and virtual meetings do not leave districts looking dead.
    citywide: { ...citywideBag },
    virtual: { ...virtualBag },
    unlocated: { ...unlocated },
    unlocated_reasons: unlocatedReasons,
    sources,
    basis_layers: {
      contract_action_address: contractActionBasis,
    },
    note: "Precomputed per-district per-lens activity for the map exploration surface. Counts use committed corpora + human-derivation extractors + offline civic-address gazetteer PIP against the boundary layer (method + confidence). Citywide and virtual are first-class buckets, not invented district pins. Unlocated items stay in unlocated with a reason.",
  };
}

export { compactDerivationStamp, placeFromDerivations };
