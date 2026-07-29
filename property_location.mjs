// Property notices describe assets, not meeting venues. Extract only the title and
// property-scope clauses so a hearing room, contact office, or auction administrator
// never becomes the site's geography.

import {
  bblFor,
  boroughsIn,
  normalizeAddress,
  plainText,
  unique,
} from "./location_extract.mjs";

const PROPERTY_ADDRESS_RE = /\b\d{1,5}[A-Z]?(?:-\d{1,5}[A-Z]?)?(?!\s*(?:feet|foot|ft\.?|square|sf)\b)\s+[A-Z0-9][A-Z0-9.'’ -]{1,70}?\b(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Place|Pl|Lane|Ln|Drive|Dr|Parkway|Pkwy|Broadway|Terrace|Court|Way|Highway|Turnpike)\b(?:\s*,?\s*(?:Apt\.?|Apartment|Unit)\s+[A-Z0-9-]+)?/gi;
const BODY_FIELDS = [
  "additional_description_1", "additional_description_2", "additional_description_3",
  "other_info_1", "other_info_2", "other_info_3", "printout_1", "printout_2", "printout_3",
];
const START_MARKERS = [
  /\bhas proposed (?:an amendment to |the )?(?:sale|acquisition|disposition)\b/i,
  /\bproperty to be sold is located\b/i,
  /\boffer the following (?:residential )?property\b/i,
  /\bproperty located at\b/i,
  /\bRFP for the sale and potential development\b/i,
  /\bone or more of three sites\b/i,
  /\bDisposition Area\b/i,
  /\bAcquisition Parcels\b/i,
];
const STOP_MARKERS = [
  /\bUnder HPD['’]s\b/i,
  /\bUnder the proposed (?:project|amended project)\b/i,
  /\bThis submission is\b/i,
  /\bThe City proposes to\b/i,
  /\bThe proposed Land Disposition Agreement\b/i,
  /\bThe acquisition of the Acquisition Parcels\b/i,
  /\bThe Plan is available\b/i,
  /\bIntroduction:\b/i,
  /\bIndustrial firms or developers\b/i,
  /\bAs part of its commitment\b/i,
  /\bNYCEDC plans to select\b/i,
  /\bPLEASE TAKE NOTICE that a public hearing\b/i,
];

function bodyFromRow(row) {
  return plainText(BODY_FIELDS.map((field) => row[field]).filter(Boolean).join(" "));
}

function boundedChunk(text, startPattern) {
  const start = startPattern.exec(text)?.index;
  if (!Number.isInteger(start)) return "";
  const tail = text.slice(start, start + 12000);
  const stops = STOP_MARKERS
    .map((pattern) => pattern.exec(tail)?.index)
    .filter((index) => Number.isInteger(index) && index > 80);
  return tail.slice(0, stops.length ? Math.min(...stops) : 6000);
}

export function propertyScopeText(row) {
  const title = plainText(row.short_title);
  const body = bodyFromRow(row);
  const chunks = START_MARKERS.map((pattern) => boundedChunk(body, pattern)).filter(Boolean);
  return plainText([title, ...chunks].join(" "));
}

function cleanPropertyAddress(value) {
  let label = normalizeAddress(value).replace(/\b(\d+)\s+(st|nd|rd|th)\b/gi, "$1$2");
  // Flattened HTML tables can leave a preceding block and lot in front of the next address.
  label = label
    .replace(/^\d{1,5}\s+\d{1,4}\s+(?=\d{1,5}[A-Z]?(?:-\d{1,5}[A-Z]?)?\s)/, "")
    .replace(/^\d{1,4}\s+(?=\d{3,5}[A-Z]?(?:-\d{1,5}[A-Z]?)?\s)/, "");
  return label;
}

export function propertyAddressesIn(text) {
  return unique((text.match(PROPERTY_ADDRESS_RE) || [])
    .map(cleanPropertyAddress)
    .filter((address) => !/\b(?:feet|foot|square feet|sq\.?\s*ft)\b/i.test(address)));
}

function lotNumbers(value) {
  return unique([...String(value || "").matchAll(/(?:p\/o\s+|part of\s+)?(\d{1,4})/gi)]
    .map((match) => String(Number(match[1]))));
}

export function propertyTaxLotsIn(text) {
  const entries = [];
  const seen = new Set();
  const add = (block, lots, source) => {
    const normalizedBlock = String(Number(block));
    const normalizedLots = lotNumbers(lots);
    if (!normalizedBlock || normalizedBlock === "NaN" || !normalizedLots.length) return;
    const key = `${normalizedBlock}/${normalizedLots.join(",")}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({
      label: `Block ${normalizedBlock}, ${normalizedLots.length === 1 ? "Lot" : "Lots"} ${normalizedLots.join(", ")}`,
      block: normalizedBlock,
      lots: normalizedLots,
      source: plainText(source),
    });
  };

  for (const match of text.matchAll(/\bBlock\s*(\d{1,5})\s*[,;:/-]?\s*(?:p\/o\s+)?Lot(?:\(s\)|s)?\s*((?:p\/o\s+|part of\s+)?\d{1,4}(?:\s*(?:,|and|&|\/|-)\s*(?:p\/o\s+|part of\s+)?\d{1,4})*)/gi)) {
    add(match[1], match[2], match[0]);
  }
  for (const match of text.matchAll(/(?<!\d)(\d{3,5})\s*\/\s*((?:p\/o\s+)?\d{1,4})(?!\d)/gi)) {
    add(match[1], match[2], match[0]);
  }
  for (const match of text.matchAll(/\bBlock\s+Lots?\s+(\d{3,5})\s+((?:p\/o\s+)?\d{1,4}(?:\s*(?:,|and|&)\s*(?:p\/o\s+)?\d{1,4})*)/gi)) {
    add(match[1], match[2], match[0]);
  }
  return entries;
}

export function propertyLocationFromRow(row) {
  const scopeText = propertyScopeText(row);
  const boroughs = unique(boroughsIn(scopeText));
  const addresses = propertyAddressesIn(scopeText).map((label) => ({
    label,
    borough: null,
    neighborhood: null,
    latitude: null,
    longitude: null,
    bbl: null,
  }));
  const tax_lots = propertyTaxLotsIn(scopeText);
  const explicitBbls = [...scopeText.matchAll(/\b(?:BBL|borough[- ]block[- ]lot)\s*[:#-]?\s*(\d{10})\b/gi)]
    .map((match) => match[1]);
  const inferredBbls = boroughs.length === 1
    ? tax_lots.flatMap((entry) => entry.lots.map((lot) => bblFor(boroughs[0], entry.block, lot)))
    : [];
  const bbls = unique([...explicitBbls, ...inferredBbls]);
  const local = boroughs.length || addresses.length || tax_lots.length || bbls.length;
  return {
    scope: local ? "local" : "unlocated",
    boroughs,
    neighborhoods: [],
    addresses,
    tax_lots,
    bbls,
    geometry: null,
  };
}

export function applyPropertyGeocodes(location, geocodes = {}) {
  const out = structuredClone(location);
  out.addresses = out.addresses.map((address) => {
    const geocode = geocodes[address.label] || {};
    return {
      ...address,
      borough: geocode.borough || null,
      neighborhood: geocode.neighborhood || null,
      latitude: Number.isFinite(geocode.latitude) ? geocode.latitude : null,
      longitude: Number.isFinite(geocode.longitude) ? geocode.longitude : null,
      bbl: /^\d{10}$/.test(geocode.bbl || "") ? geocode.bbl : null,
    };
  });
  out.boroughs = unique([...out.boroughs, ...out.addresses.map((address) => address.borough)]);
  out.neighborhoods = unique(out.addresses.map((address) => address.neighborhood));
  out.bbls = unique([...out.bbls, ...out.addresses.map((address) => address.bbl)]);
  const located = out.addresses.find((address) => address.latitude !== null && address.longitude !== null);
  out.geometry = located ? {
    latitude: located.latitude,
    longitude: located.longitude,
    label: located.label,
  } : null;
  if (out.scope === "unlocated" && (out.boroughs.length || out.geometry)) out.scope = "local";
  return out;
}

export function propertyMatchesLocation(rowOrLocation, filter = {}) {
  const location = rowOrLocation?.scope ? rowOrLocation : propertyLocationFromRow(rowOrLocation || {});
  const borough = String(filter.borough || "").trim().toLowerCase();
  const neighborhood = String(filter.neighborhood || "").trim().toLowerCase();
  if (borough && !location.boroughs.some((value) => value.toLowerCase() === borough)) return false;
  if (neighborhood) {
    const haystack = [
      ...location.neighborhoods,
      ...location.addresses.map((address) => address.label),
    ].join(" ").toLowerCase();
    if (!haystack.includes(neighborhood)) return false;
  }
  return true;
}
