/**
 * Contract action-address geography.
 *
 * These are response logistics (submit, attend a pre-bid meeting, pick up
 * documents), not places where contract work is performed. Every resolved pin
 * therefore carries a basis and `is_place_of_performance: false`.
 */

import { normalizeAddress, plainText } from "./location_extract.mjs";
import { resolveDistricts } from "./council_district_lookup.mjs";
import {
  communityDistrictKey,
  councilDistrictKey,
  paintDistrictFacetRails,
} from "./district_scope_facets.mjs";

export const ACTION_LOCATION_BASES = Object.freeze({
  SUBMISSION: "submission_address",
  PRE_BID: "pre_bid_venue",
  DOCUMENT_PICKUP: "document_pickup",
});

export const ACTION_LOCATION_BASIS_LABELS = Object.freeze({
  [ACTION_LOCATION_BASES.SUBMISSION]: "Located by submission address",
  [ACTION_LOCATION_BASES.PRE_BID]: "Located by pre-bid venue",
  [ACTION_LOCATION_BASES.DOCUMENT_PICKUP]: "Located by document-pickup address",
});

const NYC_LOCALITY_RE = /\b(?:New\s+York|Brooklyn|Bronx|Queens|Staten\s+Island|Long\s+Island\s+City|Flushing|Jamaica|Astoria)\b/i;
const OUTSIDE_LOCALITY_RE = /\b(?:Greenwich\s*,?\s*CT|Kingston\s*,?\s*NY)\b/i;
const PLACEHOLDER_RE = /^(?:\.|-+|n\/?a|none|passport)$/i;
const ACTION_STREET_RE = /\b\d{1,5}(?:-\d{1,5})?(?!\s*(?:feet|foot|ft\.?|square|sf)\b)\s+(?:(?:[A-Z][A-Z0-9.'’]*|\d+(?:st|nd|rd|th))[\s-]+){0,6}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Place|Pl|Plaza|Center|Centre|Lane|Ln|Drive|Dr|Parkway|Pkwy|Broadway)\b/gi;
const PRE_BID_RE = /\b(?:pre[-\s]?(?:bid|proposal|submission)|site\s+visit|walk[-\s]?through|information(?:al)?\s+(?:conference|session))\b/gi;
const PICKUP_RE = /\b(?:bid\s+packages?|solicitation\s+(?:packages?|documents?)|bid\s+documents?|copies?)\b[\s\S]{0,120}?\b(?:pick(?:ed)?\s+up|collect(?:ed)?|obtain(?:ed)?|available)\b|\b(?:pick(?:ed)?\s+up|collect(?:ed)?|obtain(?:ed)?)\b[\s\S]{0,80}?\b(?:bid\s+packages?|documents?|copies?)\b/gi;

function bodyText(row = {}) {
  return plainText([
    row.additional_description_1,
    row.additional_description_2,
    row.additional_description_3,
    row.other_info_1,
    row.other_info_2,
    row.other_info_3,
  ].filter(Boolean).join(" "));
}

function canonicalBorough(value) {
  const raw = String(value || "");
  if (/\bBrooklyn\b/i.test(raw)) return "Brooklyn";
  if (/\bBronx\b/i.test(raw)) return "Bronx";
  if (/\bQueens|Long\s+Island\s+City|Flushing|Jamaica|Astoria\b/i.test(raw)) return "Queens";
  if (/\bStaten\s+Island\b/i.test(raw)) return "Staten Island";
  if (/\b(?:New\s+York|Manhattan)\b/i.test(raw)) return "Manhattan";
  return null;
}

function addressJurisdiction(value, context = "") {
  const text = `${value || ""} ${context || ""}`;
  if (OUTSIDE_LOCALITY_RE.test(text) || /\bCT\s+\d{5}\b/i.test(text)) return "outside_nyc";
  const zip = text.match(/\b(\d{5})(?:-\d{4})?\b/)?.[1] || null;
  if (zip && !(Number(zip) >= 10001 && Number(zip) <= 11697)) return "outside_nyc";
  if (NYC_LOCALITY_RE.test(text) || (zip && Number(zip) >= 10001 && Number(zip) <= 11697)) {
    return "nyc";
  }
  return "unknown";
}

function usableStructuredAddress(value) {
  const text = normalizeAddress(value || "");
  if (!text || PLACEHOLDER_RE.test(text) || /^https?:\/\//i.test(text)) return null;
  if (!/\d/.test(text)) return null;
  ACTION_STREET_RE.lastIndex = 0;
  const street = ACTION_STREET_RE.exec(text)?.[0] || null;
  ACTION_STREET_RE.lastIndex = 0;
  if (!street && !/\bBuilding\s+\d+\b/i.test(text)) return null;
  return text;
}

function extendStreetAddress(text, match) {
  const start = match.index;
  const street = match[0];
  const tail = text.slice(start + street.length, start + street.length + 110);
  const locality = tail.match(
    /^(?:\s*,?\s*(?:(?:Suite|Floor|Fl|Room|Rm|Lobby|Building)\s*[A-Z0-9-]+|\d{1,2}(?:st|nd|rd|th)\s+Floor))*\s*,?\s*(?:New\s+York|Brooklyn|Bronx|Queens|Staten\s+Island|Long\s+Island\s+City|Flushing|Jamaica|Astoria|Kingston|Greenwich)\s*,?\s*(?:NY|CT)(?:\s+\d{5}(?:-\d{4})?)?/i,
  );
  return normalizeAddress(street + (locality?.[0] || ""));
}

function extractNearbyAddresses(text, keywordRe, basis) {
  const out = [];
  keywordRe.lastIndex = 0;
  const keywordHits = [...text.matchAll(keywordRe)];
  keywordRe.lastIndex = 0;
  if (!keywordHits.length) return out;
  ACTION_STREET_RE.lastIndex = 0;
  const streets = [...text.matchAll(ACTION_STREET_RE)];
  ACTION_STREET_RE.lastIndex = 0;
  for (const street of streets) {
    const nearest = keywordHits.reduce((best, hit) => {
      const distance = Math.abs((hit.index || 0) - (street.index || 0));
      return !best || distance < best.distance ? { hit, distance } : best;
    }, null);
    // A bounded evidence window prevents an unrelated office boilerplate address
    // elsewhere in the notice from becoming a venue or pickup location.
    if (!nearest || nearest.distance > 320) continue;
    const contextStart = Math.max(0, Math.min(nearest.hit.index, street.index) - 40);
    const contextEnd = Math.min(text.length, Math.max(
      nearest.hit.index + nearest.hit[0].length,
      street.index + street[0].length,
    ) + 110);
    const context = text.slice(contextStart, contextEnd);
    out.push({
      basis,
      address: extendStreetAddress(text, street),
      context,
    });
  }
  return out;
}

function normalizedKey(value) {
  return normalizeAddress(value || "")
    .toLowerCase()
    .replace(/\b(?:suite|floor|fl|room|rm)\s*[a-z0-9-]+\b/gi, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function candidate(basis, address, context = "") {
  const clean = usableStructuredAddress(address);
  if (!clean) return null;
  return {
    basis,
    basis_label: ACTION_LOCATION_BASIS_LABELS[basis],
    address: clean,
    normalized: normalizedKey(clean),
    jurisdiction: addressJurisdiction(clean, context),
    expected_borough: canonicalBorough(`${clean} ${context}`),
    is_place_of_performance: false,
  };
}

/** Inventory the response-logistics addresses already present in a contract notice. */
export function actionAddressCandidates(row = {}) {
  const found = [];
  const structured = candidate(
    ACTION_LOCATION_BASES.SUBMISSION,
    row.address_to_request,
    "",
  );
  if (structured) found.push(structured);

  const body = bodyText(row);
  if (body) {
    for (const item of extractNearbyAddresses(body, PRE_BID_RE, ACTION_LOCATION_BASES.PRE_BID)) {
      const parsed = candidate(item.basis, item.address, item.context);
      if (parsed) found.push(parsed);
    }
    for (const item of extractNearbyAddresses(body, PICKUP_RE, ACTION_LOCATION_BASES.DOCUMENT_PICKUP)) {
      const parsed = candidate(item.basis, item.address, item.context);
      if (parsed) found.push(parsed);
    }
  }

  const seen = new Set();
  return found.filter((item) => {
    const key = `${item.basis}|${item.normalized}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function streetIdentity(value) {
  const text = normalizeAddress(value || "");
  ACTION_STREET_RE.lastIndex = 0;
  const street = ACTION_STREET_RE.exec(text)?.[0] || "";
  ACTION_STREET_RE.lastIndex = 0;
  if (!street) return null;
  const number = street.match(/^\d{1,5}(?:-\d{1,5})?/)?.[0] || null;
  const name = street
    .replace(/^\d{1,5}(?:-\d{1,5})?\s+/, "")
    .toLowerCase()
    .replace(/\bcentre\b/g, "center")
    .replace(/\b(street|st|avenue|ave|road|rd|boulevard|blvd|place|pl|plaza|center|centre|lane|ln|drive|dr|parkway|pkwy)\b/g, (m) => ({
      st: "street", ave: "avenue", rd: "road", blvd: "boulevard", pl: "place", ln: "lane", dr: "drive", pkwy: "parkway",
    })[m] || m)
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return number && name ? `${number}|${name}` : null;
}

function geoShape(feature) {
  const properties = feature?.properties || {};
  const coordinates = feature?.geometry?.coordinates || [];
  const lon = Number(coordinates[0]);
  const lat = Number(coordinates[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    label: String(properties.label || "").trim(),
    borough: canonicalBorough(properties.borough) || null,
    lat,
    lon,
    bbl: /^\d{10}$/.test(String(properties.addendum?.pad?.bbl || ""))
      ? String(properties.addendum.pad.bbl)
      : null,
    method: "nyc_geosearch_strict_address",
  };
}

/**
 * Select one unambiguous GeoSearch feature. A fuzzy first result is not enough:
 * street identity (or a named Building-number facility) and borough must agree.
 */
export function pickGeoSearchMatch(item, features = []) {
  if (!item || item.jurisdiction === "outside_nyc") return null;
  const wantedStreet = streetIdentity(item.address);
  const building = item.address.match(/\bBuilding\s+(\d+)\b/i)?.[1] || null;
  const matches = [];
  for (const feature of features || []) {
    const geo = geoShape(feature);
    if (!geo || !geo.label) continue;
    if (item.expected_borough && geo.borough !== item.expected_borough) continue;
    const sameStreet = wantedStreet && streetIdentity(geo.label) === wantedStreet;
    const sameBuilding = building && new RegExp(`\\bBuilding\\s+${building}\\b`, "i").test(geo.label);
    if (!sameStreet && !sameBuilding) continue;
    matches.push(geo);
  }
  const unique = new Map(matches.map((geo) => [`${geo.lat}|${geo.lon}`, geo]));
  return unique.size === 1 ? unique.values().next().value : null;
}

export function buildContractActionLocationRow(row, geocodes, boundaries) {
  const inventory = actionAddressCandidates(row);
  const addresses = inventory.map((item) => {
    const geo = geocodes instanceof Map
      ? geocodes.get(item.normalized)
      : geocodes?.[item.normalized];
    if (!geo) {
      return {
        ...item,
        resolution_status: item.jurisdiction === "outside_nyc" ? "outside_nyc" : "unresolved",
      };
    }
    const districts = resolveDistricts(geo.lat, geo.lon, boundaries);
    const resolved = Boolean(geo.borough && districts.community_district && districts.council_district);
    return {
      ...item,
      resolution_status: resolved ? "resolved" : "unresolved",
      geocode_method: geo.method,
      geocode_label: geo.label,
      borough: geo.borough,
      latitude: geo.lat,
      longitude: geo.lon,
      bbl: geo.bbl || null,
      community_district: districts.community_district,
      council_district: districts.council_district,
      boundary_vintage: districts.boundary_vintage,
    };
  });
  return {
    request_id: row.request_id || null,
    start_date: row.start_date || null,
    due_date: row.due_date || null,
    agency_name: row.agency_name || null,
    type_of_notice_description: row.type_of_notice_description || null,
    short_title: row.short_title || null,
    pin: row.pin || null,
    selection_method_description: row.selection_method_description || null,
    addresses,
    locations: addresses.filter((item) => item.resolution_status === "resolved"),
  };
}

export function rowMatchesContractActionFilter(row, filter = {}) {
  const locations = Array.isArray(row?.locations) ? row.locations : [];
  return locations.some((location) => {
    if (filter.basis && location.basis !== filter.basis) return false;
    if (filter.borough && location.borough !== filter.borough) return false;
    if (filter.community_district && location.community_district !== filter.community_district) return false;
    if (filter.council_district && String(location.council_district) !== String(filter.council_district)) return false;
    return true;
  });
}

/**
 * Paint join-backed community / council district facet rails (and keep the
 * hidden selects in registry-key sync for share/routing state).
 * Unknown location stamps are omitted — fail closed, never inferred.
 */
export function fillContractActionLocationSelects(doc, options = {}) {
  const documentRef = options.documentRef || globalThis.document;
  if (!documentRef) return paintDistrictFacetRails(doc, options);

  const locations = (doc?.rows || []).flatMap((row) => row.locations || []);
  const syncHidden = (selector, resolve) => {
    const select = documentRef.querySelector(selector);
    if (!select) return;
    const current = resolve(select.value) || "";
    // Rebuild options from exact keys only so forceSelect/route restore stays honest.
    const keys = [...new Set(locations.map((item) => {
      if (selector === "#moneycd") return communityDistrictKey(item.community_district);
      return councilDistrictKey(item.council_district);
    }).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    select.innerHTML = `<option value=""></option>`
      + keys.map((value) => `<option value="${value}">${value}</option>`).join("");
    select.value = keys.includes(current) ? current : "";
  };
  syncHidden("#moneycd", communityDistrictKey);
  syncHidden("#moneycouncil", councilDistrictKey);

  return paintDistrictFacetRails(doc, {
    ...options,
    documentRef,
    communityDistrict: documentRef.querySelector("#moneycd")?.value || "",
    councilDistrict: documentRef.querySelector("#moneycouncil")?.value || "",
  });
}
