/**
 * Offline civic-venue geocoder for map density (no live GIS).
 *
 * Matches publisher venue / evidence address strings against a committed
 * gazetteer of known NYC civic and repeatedly-cited facility points. Each
 * hit carries provenance (method + evidence) so the map never fabricates
 * locations. Unknown streets stay unresolved — district PIP only runs when
 * a gazetteer entry matches.
 */

import { plainText, normalizeAddress } from "./location_extract.mjs";

/**
 * Known venue / facility points. Coordinates are WGS84 and were verified
 * against the committed district boundary layer (community + council PIP).
 * Keys are match patterns (case-insensitive); first hit wins.
 */
export const CIVIC_ADDRESS_GAZETTEER = Object.freeze([
  // Lower Manhattan civic corridor (City Planning, Council, FCRC, LPC, …)
  {
    id: "120-broadway",
    pattern: /\b120\s+Broadway\b/i,
    label: "120 Broadway",
    lat: 40.7085,
    lon: -74.0113,
    borough: "Manhattan",
  },
  {
    id: "250-broadway",
    pattern: /\b250\s+Broadway\b/i,
    label: "250 Broadway",
    lat: 40.7131,
    lon: -74.0078,
    borough: "Manhattan",
  },
  {
    id: "253-broadway",
    pattern: /\b253\s+Broadway\b/i,
    label: "253 Broadway",
    lat: 40.7132,
    lon: -74.0076,
    borough: "Manhattan",
  },
  {
    id: "255-greenwich",
    pattern: /\b255\s+Greenwich\s+(?:Street|St)\b/i,
    label: "255 Greenwich Street",
    lat: 40.7136,
    lon: -74.0110,
    borough: "Manhattan",
  },
  {
    id: "100-church",
    pattern: /\b100\s+Church\s+(?:Street|St)\b/i,
    label: "100 Church Street",
    lat: 40.7135,
    lon: -74.0097,
    borough: "Manhattan",
  },
  {
    id: "22-reade",
    pattern: /\b22\s+Reade\s+(?:Street|St)\b/i,
    label: "22 Reade Street",
    lat: 40.7145,
    lon: -74.0055,
    borough: "Manhattan",
  },
  {
    id: "1-centre",
    pattern: /\b(?:1|One)\s+Centre\s+(?:Street|St)\b/i,
    label: "1 Centre Street",
    lat: 40.7130,
    lon: -74.0037,
    borough: "Manhattan",
  },
  {
    id: "125-worth",
    pattern: /\b125\s+Worth\s+(?:Street|St)\b/i,
    label: "125 Worth Street",
    lat: 40.7155,
    lon: -74.0028,
    borough: "Manhattan",
  },
  {
    id: "33-beaver",
    pattern: /\b33\s+Beaver\s+(?:Street|St)\b/i,
    label: "33 Beaver Street",
    lat: 40.7050,
    lon: -74.0120,
    borough: "Manhattan",
  },
  {
    id: "55-water",
    pattern: /\b55\s+Water\s+(?:Street|St)\b/i,
    label: "55 Water Street",
    lat: 40.7033,
    lon: -74.0090,
    borough: "Manhattan",
  },
  {
    id: "260-11th-ave",
    pattern: /\b260\s+11th\s+Avenue\b/i,
    label: "260 11th Avenue",
    lat: 40.7525,
    lon: -74.0055,
    borough: "Manhattan",
  },
  {
    id: "555-w26",
    pattern: /\b555\s+West\s+26(?:th)?(?:\s+(?:Street|St))?\b/i,
    label: "555 West 26th Street",
    lat: 40.7505,
    lon: -74.0045,
    borough: "Manhattan",
  },
  // Repeated facility / vendor street points used by money + venue columns.
  {
    id: "1880-valentine",
    pattern: /\b1880\s+Valentine\s+(?:Avenue|Ave)\b/i,
    label: "1880 Valentine Avenue",
    lat: 40.8485,
    lon: -73.9005,
    borough: "Bronx",
  },
  {
    id: "197-15-hillside",
    pattern: /\b197[\s-]?15\s+Hillside\s+(?:Avenue|Ave)\b/i,
    label: "197-15 Hillside Avenue",
    lat: 40.7025,
    lon: -73.7895,
    borough: "Queens",
  },
]);

/**
 * Normalize an address-like string for matching (collapse whitespace, strip suite/floor noise
 * is unnecessary — patterns key on street numbers).
 */
export function normalizeGeocodeQuery(value) {
  if (value == null) return "";
  const raw = plainText(value);
  if (!raw) return "";
  return normalizeAddress(raw) || raw.replace(/\s+/g, " ").trim();
}

/**
 * Resolve a single address string against the civic gazetteer.
 * @returns {{ lat:number, lon:number, borough:string|null, label:string, method:string, evidence:string, gazetteer_id:string }|null}
 */
export function geocodeCivicAddress(address) {
  const q = normalizeGeocodeQuery(address);
  if (!q) return null;
  for (const entry of CIVIC_ADDRESS_GAZETTEER) {
    if (entry.pattern.test(q)) {
      return {
        lat: entry.lat,
        lon: entry.lon,
        borough: entry.borough || null,
        label: entry.label,
        method: "civic_address_gazetteer",
        evidence: entry.label,
        gazetteer_id: entry.id,
      };
    }
  }
  return null;
}

/**
 * Collect address-like strings from a place stamp or notice-shaped row, then
 * return the first successful gazetteer hit.
 */
export function geocodeFromPlaceOrRow(area = null, row = null) {
  const candidates = [];
  const push = (v) => {
    const s = normalizeGeocodeQuery(v);
    if (s) candidates.push(s);
  };

  if (area && typeof area === "object") {
    for (const a of Array.isArray(area.addresses) ? area.addresses : []) {
      if (typeof a === "string") push(a);
      else if (a && typeof a === "object") push(a.label || a.address || a.value);
    }
    const ev = area.derivation?.evidence;
    if (Array.isArray(ev)) {
      for (const e of ev) push(e);
    } else if (typeof ev === "string") {
      push(ev);
    }
  }

  if (row && typeof row === "object") {
    push([
      row.street_address_1,
      row.street_address_2,
      row.city,
      row.state,
      row.zip_code,
    ].filter(Boolean).join(", "));
    push(row.vendor_address);
    push(row.building_name);
  }

  const seen = new Set();
  for (const c of candidates) {
    if (seen.has(c)) continue;
    seen.add(c);
    const hit = geocodeCivicAddress(c);
    if (hit) return hit;
  }
  return null;
}

/**
 * Approximate polygon / district centroid from a boundary-layer district object.
 * Prefers bbox center (stable, cheap); falls back to outer-ring mean.
 * @returns {{ lat:number, lon:number }|null}
 */
export function districtCentroid(district) {
  if (!district || typeof district !== "object") return null;
  const bbox = district.bbox;
  if (Array.isArray(bbox) && bbox.length === 4) {
    const [minLon, minLat, maxLon, maxLat] = bbox.map(Number);
    if ([minLon, minLat, maxLon, maxLat].every(Number.isFinite)) {
      return {
        lat: (minLat + maxLat) / 2,
        lon: (minLon + maxLon) / 2,
      };
    }
  }
  const polygons = district.polygons;
  if (!Array.isArray(polygons) || !polygons.length) return null;
  const ring = polygons[0]?.rings?.[0];
  if (!Array.isArray(ring) || ring.length < 3) return null;
  let sumLon = 0;
  let sumLat = 0;
  let n = 0;
  for (const pt of ring) {
    const lon = Number(pt[0]);
    const lat = Number(pt[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    sumLon += lon;
    sumLat += lat;
    n += 1;
  }
  if (!n) return null;
  return { lat: sumLat / n, lon: sumLon / n };
}

/**
 * Build community-district id → council-district id via CD centroid PIP.
 * Honest single-council attribution per CD (centroid of the CD polygon).
 * CDs and council districts do not nest; this is a density join, not a legal
 * containment claim — method should be labeled `cd_centroid_council`.
 *
 * @param {object} boundaries — district_boundaries.v1
 * @param {(lat:number, lon:number, layer:object) => string|null} resolveCouncil
 */
export function buildCommunityToCouncilIndex(boundaries, resolveCouncil) {
  const index = Object.create(null);
  if (!boundaries || typeof resolveCouncil !== "function") return index;
  for (const d of boundaries.community_districts || []) {
    const id = d?.id;
    if (!id) continue;
    const c = districtCentroid(d);
    if (!c) continue;
    const council = resolveCouncil(c.lat, c.lon, boundaries);
    if (council) index[id] = String(council);
  }
  return index;
}
