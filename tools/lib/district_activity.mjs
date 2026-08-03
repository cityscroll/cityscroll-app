/**
 * Pure builders for district_activity precompute (cs-geo-04).
 *
 * Rolls located civic events into per-area per-lens counts using the
 * committed boundary layer (point-in-polygon) and publisher district fields.
 * No live GIS at render time — the artifact is the source of truth for the map.
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

export { DISTRICT_ACTIVITY_SCHEMA };

const LENSES = ["land", "property", "rules", "meetings", "money"];

function bump(bag, key, lens, n = 1) {
  if (!key) return;
  if (!bag[key]) bag[key] = emptyLensCounts();
  if (!LENSES.includes(lens)) return;
  bag[key][lens] = (bag[key][lens] || 0) + n;
}

function coordsFromPropertyRow(row) {
  const loc = row?.property_location || row?._location || null;
  if (!loc || typeof loc !== "object") return null;
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
  return null;
}

function boroughsFromPropertyRow(row) {
  const loc = row?.property_location || row?._location || null;
  const list = Array.isArray(loc?.boroughs) ? loc.boroughs : [];
  return list.filter(Boolean);
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
  const boroMap = {
    manhattan: "M",
    bronx: "X",
    brooklyn: "K",
    queens: "Q",
    "staten island": "R",
  };
  const prefix = boroMap[m[1].toLowerCase().replace(/\s+/g, " ")];
  if (!prefix) return null;
  const n = Number(m[2]);
  if (!Number.isFinite(n) || n < 1) return null;
  return prefix + String(n).padStart(2, "0");
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
 * Build the full district_activity document from committed corpora.
 *
 * @param {object} opts
 * @param {object} opts.boundaries — district_boundaries.v1
 * @param {object[]} [opts.zapRows]
 * @param {object[]} [opts.propertyRows]
 * @param {object[]} [opts.meetingsRows]
 * @param {object[]} [opts.rulesRows]
 * @param {object[]} [opts.moneyRows] — optional; usually unlocated
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

  // Land — publisher community_district on ZAP; resolve council via CD centroid when possible.
  for (const row of opts.zapRows || []) {
    const cds = parseZapCommunityDistricts(row.community_district);
    const boro = row.borough || (cds[0] ? boroughFromCommunityId(cds[0]) : null);
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

  // Meetings — community board agencies; else unlocated / citywide.
  for (const row of opts.meetingsRows || []) {
    const cd = communityDistrictFromAgencyName(row.agency_name);
    const boro = cd ? boroughFromCommunityId(cd) : null;
    place("meetings", { borough: boro, community: cd, council: null });
  }

  // Rules — usually citywide; count as unlocated unless title/agency pins a CD.
  for (const row of opts.rulesRows || []) {
    const cd = communityDistrictFromAgencyName(row.agency_name)
      || communityDistrictFromAgencyName(row.short_title);
    const boro = cd ? boroughFromCommunityId(cd) : null;
    place("rules", { borough: boro, community: cd, council: null });
  }

  // Money — awards rarely carry serving geography in the warehouse slice.
  for (const row of opts.moneyRows || []) {
    place("money", {
      borough: row.borough || null,
      community: row.community_district || null,
      council: row.council_district || null,
    });
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
    note: "Precomputed per-district per-lens activity for the map exploration surface. Counts are from committed corpora (not live geo queries). Unlocated items stay in unlocated — never invented into a district.",
  };
}
