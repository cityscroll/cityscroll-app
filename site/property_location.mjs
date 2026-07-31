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
  // "RFP … for the sale and potential development" — the RFP tag is often
  // parenthesised ("RFP") or spelled out, so anchor on the disposition phrase.
  /\bfor the sale and potential development\b/i,
  /\bone or more of three sites\b/i,
  /\bDisposition Area\b/i,
  /\bAcquisition Parcels\b/i,
  // Lease surrender / termination / assignment — the scope clause names the
  // site ("…on Block 644, Lot 1 … in the Borough of Manhattan").
  /\brelating to the (?:early |voluntary )?(?:surrender|termination|assignment) of (?:its interest in )?the lease\b/i,
  /\bdesires to (?:voluntarily )?surrender (?:its interest in )?(?:the lease|the Property)\b/i,
  /\bthe Property is currently occupied\b/i,
  /\bpremises known as\b/i,
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
  // Hearing-access / call-in boilerplate that follows the scope clause.
  /\bIn order to access the (?:Public )?Hearing\b/i,
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

function markerChunks(body) {
  return START_MARKERS.map((pattern) => boundedChunk(body, pattern)).filter(Boolean);
}

export function propertyScopeText(row) {
  const title = plainText(row.short_title);
  const body = bodyFromRow(row);
  const chunks = markerChunks(body);
  return plainText([title, ...chunks].join(" "));
}

// Safety net for notices whose scope clause the START_MARKERS do not enumerate
// (e.g. a lease surrender phrased differently, a marker that anchored after the
// property details). When the title and scope clauses yield nothing local, scan
// a bounded body window — but trust only a tax lot (Block / Lot) that co-occurs
// with exactly one NYC borough. A Block/Lot plus a single borough is an
// unambiguous NYC site reference and resolves a BBL. A Block/Lot with no borough
// (often a non-NYC parcel number or project code) or a body listing several
// boroughs (property-clerk offices, citywide auctions) is boilerplate, never
// the subject site. Street addresses are intentionally not extracted here — an
// agency office or hearing venue must never become the property's geography.
function propertyFallbackSignals(row) {
  const body = bodyFromRow(row);
  if (!body) return { boroughs: [], tax_lots: [] };
  const window = body.slice(0, 12000);
  const boroughs = unique(boroughsIn(window));
  if (boroughs.length !== 1) return { boroughs: [], tax_lots: [] };
  const tax_lots = propertyTaxLotsIn(window);
  return tax_lots.length ? { boroughs, tax_lots } : { boroughs: [], tax_lots: [] };
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
  let boroughs = unique(boroughsIn(scopeText));
  let addresses = propertyAddressesIn(scopeText).map((label) => ({
    label,
    borough: null,
    neighborhood: null,
    latitude: null,
    longitude: null,
    bbl: null,
  }));
  let tax_lots = propertyTaxLotsIn(scopeText);
  let explicitBbls = [...scopeText.matchAll(/\b(?:BBL|borough[- ]block[- ]lot)\s*[:#-]?\s*(\d{10})\b/gi)]
    .map((match) => match[1]);
  let inferredBbls = boroughs.length === 1
    ? tax_lots.flatMap((entry) => entry.lots.map((lot) => bblFor(boroughs[0], entry.block, lot)))
    : [];
  let bbls = unique([...explicitBbls, ...inferredBbls]);
  let local = boroughs.length || addresses.length || tax_lots.length || bbls.length;
  // Fallback: the title and scope clauses yielded no local signal (either no
  // marker matched, or the marker anchored after the property details). Scan a
  // bounded body window for precise property identifiers only — never addresses
  // or multi-borough admin lists, which are venue/boilerplate, not the site.
  if (!local) {
    const fallback = propertyFallbackSignals(row);
    if (fallback.tax_lots.length) {
      tax_lots = fallback.tax_lots;
      boroughs = fallback.boroughs;
      inferredBbls = boroughs.length === 1
        ? tax_lots.flatMap((entry) => entry.lots.map((lot) => bblFor(boroughs[0], entry.block, lot)))
        : [];
      bbls = unique([...explicitBbls, ...inferredBbls]);
      local = true;
    }
  }
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
