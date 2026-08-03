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
import { affectedAreaFromRow } from "../../worker/src/lib/hearings.mjs";
import { ruleLocationFromRow } from "../../site/rule_location.mjs";
import {
  boroughsIn,
  communityBoardSignals,
  plainText,
} from "../../site/location_extract.mjs";

export { DISTRICT_ACTIVITY_SCHEMA };

const LENSES = ["land", "property", "rules", "meetings", "money"];

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
 * Returns one or more { borough, community, council } slots (multi-place honest).
 *
 * @param {object|null} area
 * @param {object} boundaries
 * @param {{ coords?: {lat:number, lon:number}|null }} [opts]
 */
export function placementsFromLocatedArea(area, boundaries, opts = {}) {
  if (!area || typeof area !== "object") return [];
  const slots = [];
  const seen = new Set();
  const push = (slot) => {
    const community = slot.community ? normalizeCommunityDistrictId(slot.community) : null;
    const council = slot.council ? normalizeCouncilDistrictId(slot.council) : null;
    let borough = canonBorough(slot.borough)
      || (community ? boroughFromCommunityId(community) : null);
    if (!community && !council && !borough) return;
    const key = `${borough || ""}|${community || ""}|${council || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    slots.push({ borough, community, council });
  };

  // Coordinates → shared boundary layer PIP (both district kinds).
  const coords = opts.coords
    || (area.geometry
      && Number.isFinite(Number(area.geometry.latitude))
      && Number.isFinite(Number(area.geometry.longitude))
      ? { lat: Number(area.geometry.latitude), lon: Number(area.geometry.longitude) }
      : null);
  if (coords && boundaries) {
    const community = resolveCommunityDistrict(coords.lat, coords.lon, boundaries);
    const council = resolveCouncilDistrict(coords.lat, coords.lon, boundaries);
    const borough = community
      ? boroughFromCommunityId(community)
      : (Array.isArray(area.boroughs) ? canonBorough(area.boroughs[0]) : null);
    push({ borough, community, council });
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

  // Citywide scope with no local pins → Citywide borough bag (not invented districts).
  if (!slots.length && area.scope === "citywide") {
    push({ borough: "Citywide", community: null, council: null });
  }

  return slots;
}

/**
 * Resolve meetings placement from stamped affected_area or the pure extractor.
 */
export function meetingPlacementsFromRow(row, boundaries) {
  const stamped = row?.affected_area || row?.place || row?._location || null;
  const area = stamped && typeof stamped === "object" && (stamped.scope || stamped.boroughs)
    ? stamped
    : affectedAreaFromRow(row || {});

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
  let slots = placementsFromLocatedArea(merged, boundaries, { coords });
  // Agency CD alone (no extractor hit).
  if (!slots.length && agencyCd) {
    slots = [{
      borough: boroughFromCommunityId(agencyCd),
      community: agencyCd,
      council: null,
    }];
  }
  if (!slots.length && agencyBoro) {
    slots = [{ borough: agencyBoro, community: null, council: null }];
  }
  return slots;
}

/**
 * Resolve rules placement from stamped location or rule-scope extractor.
 */
export function rulePlacementsFromRow(row, boundaries) {
  const stamped = row?.rule_location || row?.affected_area || row?.place || null;
  let area;
  if (stamped && typeof stamped === "object" && (stamped.scope || stamped.boroughs)) {
    area = stamped;
  } else {
    // Rule hearings may carry the same body fields as meetings; prefer hearing area when present.
    const hearingArea = affectedAreaFromRow(row || {});
    if (hearingArea.scope === "local") {
      area = hearingArea;
    } else {
      area = ruleLocationFromRow(row || {}, {
        hearingArea: hearingArea.scope === "local" ? hearingArea : null,
      });
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
  let slots = placementsFromLocatedArea(merged, boundaries, { coords });
  if (!slots.length && agencyCd) {
    slots = [{
      borough: boroughFromCommunityId(agencyCd),
      community: agencyCd,
      council: null,
    }];
  }
  if (!slots.length && agencyBoro) {
    slots = [{ borough: agencyBoro, community: null, council: null }];
  }
  return slots;
}

/**
 * Resolve money / contracts placement from publisher geo fields, coords, or place stamp.
 */
export function moneyPlacementsFromRow(row, boundaries) {
  const stamped = row?.place || row?.location || row?.affected_area || null;
  if (stamped && typeof stamped === "object") {
    const slots = placementsFromLocatedArea(stamped, boundaries, {
      coords: coordsFromPropertyRow(row),
    });
    if (slots.length) return slots;
  }

  const coords = coordsFromPropertyRow(row);
  if (coords && boundaries) {
    const community = resolveCommunityDistrict(coords.lat, coords.lon, boundaries);
    const council = resolveCouncilDistrict(coords.lat, coords.lon, boundaries);
    const borough = community
      ? boroughFromCommunityId(community)
      : canonBorough(row?.borough);
    if (community || council || borough) {
      return [{ borough, community, council }];
    }
  }

  // Publisher district columns (warehouse / hand-stamped).
  const cds = parseZapCommunityDistricts(row?.community_district);
  const council = normalizeCouncilDistrictId(row?.council_district || row?.cc_district);
  const borough = canonBorough(row?.borough)
    || (cds[0] ? boroughFromCommunityId(cds[0]) : null);
  if (cds.length) {
    return cds.map((cd) => ({
      borough: borough || boroughFromCommunityId(cd),
      community: cd,
      council: council || null,
    }));
  }
  if (council || borough) {
    return [{ borough, community: null, council: council || null }];
  }

  // Last resort: title/agency place words (honest borough-only when present).
  const haystack = plainText([row?.short_title, row?.agency_name].filter(Boolean).join(" "));
  const boros = boroughsIn(haystack);
  if (boros.length) {
    return boros.map((b) => ({ borough: b, community: null, council: null }));
  }
  return [];
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
 * @param {string} [opts.builtAt]
 */
export function buildDistrictActivity(opts = {}) {
  const boundaries = opts.boundaries;
  if (!boundaries || !boundaries.boundary_vintage) {
    throw new Error("buildDistrictActivity requires a labeled boundary layer");
  }

  const byBorough = Object.create(null);
  const byCommunity = Object.create(null);
  const byCouncil = Object.create(null);
  const unlocated = emptyLensCounts();
  const sources = {
    land: { corpus: "zap_projects_warehouse_lookup", counted: 0, located: 0 },
    property: { corpus: "property_domain_observations", counted: 0, located: 0 },
    meetings: { corpus: "meetings_domain_observations", counted: 0, located: 0 },
    rules: { corpus: "rules_domain_observations", counted: 0, located: 0 },
    money: { corpus: "ocp_awards_warehouse_lookup", counted: 0, located: 0 },
  };

  function place(lens, { borough, community, council }) {
    sources[lens].counted += 1;
    let placed = false;
    if (community) {
      const cd = normalizeCommunityDistrictId(community);
      if (cd) {
        bump(byCommunity, cd, lens);
        const b = borough || boroughFromCommunityId(cd);
        if (b) bump(byBorough, b, lens);
        placed = true;
      }
    }
    if (council) {
      const id = normalizeCouncilDistrictId(council);
      if (id) {
        bump(byCouncil, id, lens);
        placed = true;
      }
    }
    if (!placed && borough) {
      bump(byBorough, borough, lens);
      placed = true;
    }
    if (placed) sources[lens].located += 1;
    else unlocated[lens] += 1;
  }

  /**
   * Count one source row once in sources.counted, fan out to districts, and
   * mark located if any slot placed. Multi-place rows bump district bags once
   * each without inflating sources.counted (unlike multi-CD ZAP, which is
   * multi-row intentional).
   */
  function placeSlots(lens, slots) {
    sources[lens].counted += 1;
    if (!slots.length) {
      unlocated[lens] += 1;
      return;
    }
    let placed = false;
    for (const slot of slots) {
      let slotPlaced = false;
      if (slot.community) {
        const cd = normalizeCommunityDistrictId(slot.community);
        if (cd) {
          bump(byCommunity, cd, lens);
          const b = slot.borough || boroughFromCommunityId(cd);
          if (b) bump(byBorough, b, lens);
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
      if (!slotPlaced && slot.borough) {
        bump(byBorough, slot.borough, lens);
        slotPlaced = true;
      }
      if (slotPlaced) placed = true;
    }
    if (placed) sources[lens].located += 1;
    else unlocated[lens] += 1;
  }

  // Land — publisher community_district on ZAP; resolve council via CD centroid when possible.
  for (const row of opts.zapRows || []) {
    const cds = parseZapCommunityDistricts(row.community_district);
    const boro = canonBorough(row.borough) || (cds[0] ? boroughFromCommunityId(cds[0]) : null);
    if (cds.length) {
      for (const cd of cds) {
        // Multi-CD projects count once per listed district (honest multi-place).
        place("land", { borough: boro, community: cd, council: row.cc_district });
      }
    } else {
      place("land", { borough: boro, community: null, council: row.cc_district });
    }
  }

  // Property — geometry → point-in-polygon; else borough-only.
  for (const row of opts.propertyRows || []) {
    const coords = coordsFromPropertyRow(row);
    let community = null;
    let council = null;
    let borough = boroughsFromPropertyRow(row)[0] || null;
    if (coords) {
      community = resolveCommunityDistrict(coords.lat, coords.lon, boundaries);
      council = resolveCouncilDistrict(coords.lat, coords.lon, boundaries);
      if (!borough && community) borough = boroughFromCommunityId(community);
    }
    place("property", { borough, community, council });
  }

  // Meetings — per-lens affected-area extractor + boundary layer PIP / CD resolve.
  for (const row of opts.meetingsRows || []) {
    placeSlots("meetings", meetingPlacementsFromRow(row, boundaries));
  }

  // Rules — rule-scope / hearing affected-area extractors.
  for (const row of opts.rulesRows || []) {
    placeSlots("rules", rulePlacementsFromRow(row, boundaries));
  }

  // Money — publisher geo, coords → PIP, title borough words when present.
  for (const row of opts.moneyRows || []) {
    placeSlots("money", moneyPlacementsFromRow(row, boundaries));
  }

  // Ensure every borough / regular CD / council id has a counts bag (zeros OK).
  for (const b of ["Manhattan", "Bronx", "Brooklyn", "Queens", "Staten Island"]) {
    if (!byBorough[b]) byBorough[b] = emptyLensCounts();
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
    unlocated: { ...unlocated },
    sources,
    note: "Precomputed per-district per-lens activity for the map exploration surface. Counts are from committed corpora + per-lens location extractors (not live geo queries). Unlocated items stay in unlocated — never invented into a district.",
  };
}
