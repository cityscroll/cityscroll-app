/**
 * Evidence-carrying location derivation for map density and notice place stamps.
 *
 * Doctrine (site owner): do not give up at the first missing structured field.
 * Read the notice as a location-interested human would — venue lines, borough-of
 * phrases, titled addresses, agency / vendor place names — then rank methods by
 * confidence. Only after every human-visible derivation fails is a row unlocated,
 * and the reason is recorded (e.g. virtual-only meeting).
 *
 * Shape mirrors notice_facts: each hit carries method + confidence + evidence span.
 * Lens modules decide which hits are matter-scope vs meeting-venue vs weak agency HQ.
 */

import {
  ADDRESS_RE,
  boroughsIn,
  communityBoardSignals,
  normalizeAddress,
  plainText,
  unique,
} from "./location_extract.mjs";

/** Confidence tiers — higher wins when merging into a single place stamp. */
export const LOCATION_CONFIDENCE = Object.freeze({
  publisher_district: 0.95,
  matter_body_borough: 0.9,
  matter_title_place: 0.88,
  matter_address: 0.85,
  community_board: 0.85,
  venue_line: 0.7,
  venue_column: 0.65,
  vendor_place: 0.55,
  agency_hq: 0.35,
  citywide_phrase: 0.8,
});

const BODY_FIELDS = [
  "additional_description_1",
  "additional_description_2",
  "additional_description_3",
  "other_info_1",
  "other_info_2",
  "other_info_3",
  "printout_1",
  "printout_2",
  "printout_3",
  "description",
  "other_info",
  "printout",
];

/** Neighborhood / campus phrases a human reads as a borough pin. */
const PLACE_GAZETTEER = Object.freeze([
  { pattern: /\bMosholu\b/i, boroughs: ["Bronx"], label: "Mosholu" },
  { pattern: /\bMontefiore\b/i, boroughs: ["Bronx"], label: "Montefiore" },
  { pattern: /\bValentine\s+Avenue\b/i, boroughs: ["Bronx"], label: "Valentine Avenue" },
  { pattern: /\bWNYC\s+Transmitter\s+Park\b/i, boroughs: ["Brooklyn"], label: "WNYC Transmitter Park" },
  { pattern: /\bCrescent\s+Beach\s+Park\b/i, boroughs: ["Staten Island"], label: "Crescent Beach Park" },
  { pattern: /\bPolice\s+Academy\b/i, boroughs: ["Queens"], label: "NYPD Police Academy" },
  { pattern: /\bHutchinson\s+River\s+Parkway\b/i, boroughs: ["Bronx"], label: "Hutchinson River Parkway" },
  { pattern: /\bHillside\s+Avenue\b/i, boroughs: ["Queens"], label: "Hillside Avenue" },
  { pattern: /\bJoralemon\s+Street\b/i, boroughs: ["Brooklyn"], label: "Joralemon Street" },
  { pattern: /\bTimes\s+Square\b/i, boroughs: ["Manhattan"], label: "Times Square" },
  // Known City Hall / agency campus streets (venue fallthrough).
  { pattern: /\b(?:120|250|253)\s+Broadway\b/i, boroughs: ["Manhattan"], label: "Broadway civic corridor" },
  { pattern: /\b255\s+Greenwich\s+Street\b/i, boroughs: ["Manhattan"], label: "255 Greenwich Street" },
  { pattern: /\b22\s+Reade\s+Street\b/i, boroughs: ["Manhattan"], label: "22 Reade Street" },
  { pattern: /\b125\s+Worth\s+Street\b/i, boroughs: ["Manhattan"], label: "125 Worth Street" },
  { pattern: /\bOne\s+Centre\s+Street\b|\b1\s+Centre\s+Street\b/i, boroughs: ["Manhattan"], label: "1 Centre Street" },
]);

/**
 * Known agency meeting / HQ addresses used only as a last-resort weak pin.
 * Never invents a district; borough-only is honest for citywide boards.
 */
const AGENCY_HQ = Object.freeze([
  {
    pattern: /\bCity\s+Planning\s+Commission\b|\bDepartment\s+of\s+City\s+Planning\b|\bCity\s+Planning\b/i,
    boroughs: ["Manhattan"],
    label: "City Planning (120 Broadway)",
  },
  {
    pattern: /\bLandmarks\s+Preservation\s+Commission\b/i,
    boroughs: ["Manhattan"],
    label: "LPC (253 Broadway)",
  },
  {
    pattern: /\bCity\s+Council\b/i,
    boroughs: ["Manhattan"],
    label: "City Council (City Hall / 250 Broadway)",
  },
  {
    pattern: /\bFranchise\s+and\s+Concession\s+Review\s+Committee\b|\bFCRC\b/i,
    boroughs: ["Manhattan"],
    label: "FCRC (255 Greenwich Street)",
  },
  {
    pattern: /\bBoard\s+of\s+Standards\s+and\s+Appeals\b/i,
    boroughs: ["Manhattan"],
    label: "BSA",
  },
  {
    pattern: /\bBoard\s+of\s+Correction\b/i,
    boroughs: ["Manhattan"],
    label: "Board of Correction (125 Worth Street)",
  },
  {
    pattern: /\bPublic\s+Design\s+Commission\b|\bArt\s+Commission\b/i,
    boroughs: ["Manhattan"],
    label: "Public Design Commission",
  },
  {
    pattern: /\bEqual\s+Employment\s+Practices\s+Commission\b|\bEEPC\b/i,
    boroughs: ["Manhattan"],
    label: "EEPC",
  },
]);

function evidence(value) {
  return plainText(value).replace(/\s+/g, " ").trim().slice(0, 280);
}

function hit({ method, confidence, role, boroughs = [], community_boards = [], community_districts = [], addresses = [], evidence: ev, citywide = false }) {
  return {
    method,
    confidence,
    role, // "matter" | "venue" | "agency" | "vendor" | "citywide"
    boroughs: unique(boroughs.filter(Boolean)),
    community_boards: unique(community_boards.filter(Boolean)),
    community_districts: unique(community_districts.filter(Boolean)),
    addresses: unique(addresses.filter(Boolean)),
    citywide: !!citywide,
    evidence: evidence(ev || ""),
  };
}

export function noticeProse(row = {}) {
  return plainText([
    row.short_title,
    ...BODY_FIELDS.map((field) => row[field]),
  ].filter(Boolean).join(" "));
}

export function noticeTitle(row = {}) {
  return plainText(row.short_title || "");
}

/**
 * "Borough of The Bronx" / "located in the Borough of Brooklyn".
 * Deliberately avoids bare "held in Manhattan" venue language — that is a
 * meeting room, not the matter's geography.
 */
export function boroughOfPhrases(text) {
  const found = [];
  const patterns = [
    /\bBorough\s+of\s+(?:the\s+)?(Bronx|Manhattan|Brooklyn|Queens|Staten\s+Island)\b/gi,
    /\blocated\s+in\s+(?:the\s+)?(?:Borough\s+of\s+)?(?:the\s+)?(Bronx|Manhattan|Brooklyn|Queens|Staten\s+Island)\b/gi,
    /\b(?:premises|property|properties|disposition\s+area|site|project|park|facility|building)\s+(?:is\s+|are\s+)?(?:located\s+)?in\s+(?:the\s+)?(?:Borough\s+of\s+)?(?:the\s+)?(Bronx|Manhattan|Brooklyn|Queens|Staten\s+Island)\b/gi,
    /\bin\s+(?:the\s+)?(Bronx|Manhattan|Brooklyn|Queens|Staten\s+Island)\s*,\s*(?:New\s+York|NY|Community\s+District)\b/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      // Skip matches that sit inside a "held at/in" venue clause.
      const start = Math.max(0, match.index - 40);
      const window = text.slice(start, match.index + match[0].length);
      if (/\b(?:held|hold|holding|meeting|hearing)\b[^. ]{0,40}$/i.test(window.slice(0, -match[0].length + 5))
        && /\b(?:held|hold)\b/i.test(window)) {
        // venue clause — skip
        continue;
      }
      found.push({
        borough: plainText(match[1]).replace(/^the\s+/i, ""),
        evidence: match[0],
      });
    }
  }
  // Normalize "Bronx" from "the Bronx"
  return found.map((f) => ({
    borough: f.borough.toLowerCase() === "bronx" ? "Bronx" : f.borough.replace(/\s+/g, " "),
    evidence: f.evidence,
  }));
}

/**
 * Venue lines: "will be held at 22 Reade Street", "to be held … at 255 Greenwich Street".
 */
export function venueHeldAtSpans(text) {
  const spans = [];
  const patterns = [
    /\b(?:will\s+be\s+held|to\s+be\s+held|being\s+held|is\s+being\s+held|hearing\s+will\s+be|meeting\s+will\s+be|public\s+hearing)[^.、]{0,80}?\bat\s+([0-9][^.;]{5,80}?(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Place|Pl|Broadway|Parkway|Pkwy)\b[^.;]{0,40})/gi,
    /\bheld\s+(?:in\s+person\s+)?at\s+([0-9][^.;]{5,80}?(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Place|Pl|Broadway|Parkway|Pkwy)\b[^.;]{0,40})/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const addr = normalizeAddress(match[1]);
      if (addr) spans.push({ address: addr, evidence: match[0] });
    }
  }
  return spans;
}

/**
 * Virtual / remote-only cues (human: Zoom-only → no map pin unless matter place exists).
 */
export function isVirtualOnlyText(text, venueAddress = null) {
  const t = plainText(text);
  const virtual = /\b(?:via\s+(?:zoom|webex|teams|conference\s+call|telephone|video)|online\s+(?:only|meeting|hearing)|virtual\s+(?:only\s+)?(?:public\s+)?(?:hearing|meeting)|conference\s+call\s+no\.?|call[\s-]?in\s*(?:#|number|no\.?))\b/i.test(t);
  const inPerson = !!venueAddress
    || /\bin[\s-]?person\b/i.test(t)
    || venueHeldAtSpans(t).length > 0;
  return virtual && !inPerson;
}

/**
 * Title / body street addresses (including Queens hyphenated form already in ADDRESS_RE).
 * Also accepts abbreviated Manhattan forms: "511 West 171" / "511 West 171st".
 */
export function addressSpansIn(text) {
  const spans = [];
  for (const match of text.matchAll(ADDRESS_RE)) {
    spans.push({ address: normalizeAddress(match[0]), evidence: match[0] });
  }
  for (const match of text.matchAll(
    /\b(\d{1,5})\s+(West|East|North|South|W\.?|E\.?)\s+(\d{1,3})(?:st|nd|rd|th)?\b/gi,
  )) {
    const label = normalizeAddress(match[0]);
    if (label && !spans.some((s) => s.address === label)) {
      spans.push({ address: label, evidence: match[0] });
    }
  }
  return spans;
}

/**
 * "Staten Island Tax Block 5308, Lot 50" / "Block 5308 Lot 50" with nearby borough.
 */
export function taxLotBoroughHints(text) {
  const hits = [];
  for (const match of text.matchAll(
    /\b(Manhattan|Bronx|Brooklyn|Queens|Staten\s+Island)\s+Tax\s+Block\s+(\d+)/gi,
  )) {
    hits.push({
      borough: plainText(match[1]).replace(/\s+/g, " "),
      block: match[2],
      evidence: match[0],
    });
  }
  return hits;
}

/**
 * Publisher venue columns (street_address_1 + city). "New York, NY" ⇒ Manhattan
 * for city-mail addresses (borough-named cities keep their name).
 */
export function venueFromPublisherColumns(row = {}) {
  const address = normalizeAddress([
    row.street_address_1,
    row.street_address_2,
    row.city,
    row.state,
    row.zip_code,
  ].filter(Boolean).join(", "));
  if (!address) return null;
  const city = plainText(row.city || "");
  let boroughs = boroughsIn([city, address].filter(Boolean).join(" "));
  if (!boroughs.length && /^(?:new\s+york|ny|nyc)$/i.test(city)) {
    boroughs = ["Manhattan"];
  }
  // Brooklyn / Queens / Bronx / SI as city name
  if (!boroughs.length) {
    boroughs = boroughsIn(city);
  }
  return {
    address,
    boroughs,
    building: plainText(row.building_name || "") || null,
    evidence: address,
  };
}

/**
 * Extract all location candidates from a notice-shaped row.
 * @returns {{ hits: object[], unlocated_reason: string|null, virtual_only: boolean }}
 */
export function deriveLocationCandidates(row = {}, opts = {}) {
  const title = noticeTitle(row);
  const body = noticeProse(row);
  const agency = plainText(row.agency_name || "");
  const vendor = plainText(row.vendor_name || "");
  const hits = [];

  // Citywide explicit phrases (matter scope).
  if (/\b(?:citywide(?! (?:administrative|personnel) services)|throughout\s+(?:new\s+york\s+)?city|all\s+five\s+boroughs)\b/i.test(body)) {
    hits.push(hit({
      method: "citywide_phrase",
      confidence: LOCATION_CONFIDENCE.citywide_phrase,
      role: "citywide",
      citywide: true,
      evidence: (body.match(/\b(?:citywide(?! (?:administrative|personnel) services)|throughout\s+(?:new\s+york\s+)?city|all\s+five\s+boroughs)\b/i) || ["citywide"])[0],
    }));
  }

  // Borough-of / located-in phrases in title + body.
  for (const phrase of boroughOfPhrases(body)) {
    hits.push(hit({
      method: "matter_body_borough",
      confidence: LOCATION_CONFIDENCE.matter_body_borough,
      role: "matter",
      boroughs: [phrase.borough],
      evidence: phrase.evidence,
    }));
  }

  // Title borough words (Park Avenue Brooklyn, Borough of Brooklyn in title).
  for (const b of boroughsIn(title)) {
    hits.push(hit({
      method: "matter_title_place",
      confidence: LOCATION_CONFIDENCE.matter_title_place,
      role: "matter",
      boroughs: [b],
      evidence: title.slice(0, 160),
    }));
  }

  // Community board signals (full body — formal designations).
  const boards = communityBoardSignals(body);
  if (boards.boards.length) {
    hits.push(hit({
      method: "community_board",
      confidence: LOCATION_CONFIDENCE.community_board,
      role: "matter",
      boroughs: boards.boroughs,
      community_boards: boards.boards,
      evidence: boards.boards.join("; "),
    }));
  }

  // Tax-lot borough labels ("Staten Island Tax Block…").
  for (const lot of taxLotBoroughHints(body)) {
    hits.push(hit({
      method: "matter_body_borough",
      confidence: LOCATION_CONFIDENCE.matter_body_borough,
      role: "matter",
      boroughs: [lot.borough],
      evidence: lot.evidence,
    }));
  }

  // Title + body street addresses as matter pins when title looks place-bearing
  // (leases, acquisitions, short address titles) OR when "Borough of" co-occurs.
  const titleAddresses = addressSpansIn(title);
  for (const span of titleAddresses) {
    hits.push(hit({
      method: "matter_address",
      confidence: LOCATION_CONFIDENCE.matter_address,
      role: "matter",
      addresses: [span.address],
      boroughs: boroughsIn(title),
      evidence: span.evidence,
    }));
  }

  // Gazetteer place names: title first (matter), then body only for non-venue
  // campus streets (parks / neighborhoods — not 120 Broadway agency HQ).
  const VENUE_ONLY_LABELS = new Set([
    "Broadway civic corridor",
    "255 Greenwich Street",
    "22 Reade Street",
    "125 Worth Street",
    "1 Centre Street",
  ]);
  for (const entry of PLACE_GAZETTEER) {
    const inTitle = entry.pattern.test(title);
    const inBody = entry.pattern.test(body);
    if (inTitle || (inBody && !VENUE_ONLY_LABELS.has(entry.label))) {
      hits.push(hit({
        method: "matter_title_place",
        confidence: LOCATION_CONFIDENCE.matter_title_place,
        role: "matter",
        boroughs: entry.boroughs,
        evidence: entry.label,
      }));
    }
    if (vendor && entry.pattern.test(vendor)) {
      hits.push(hit({
        method: "vendor_place",
        confidence: LOCATION_CONFIDENCE.vendor_place,
        role: "vendor",
        boroughs: entry.boroughs,
        evidence: `${entry.label} (${vendor.slice(0, 80)})`,
      }));
    }
  }

  // OCP / award vendor_address column (human: "where is the vendor?").
  const vendorAddress = plainText(row.vendor_address || "");
  if (vendorAddress) {
    let boros = boroughsIn(vendorAddress);
    // Manhattan mail convention: "…, New York, NY" without a borough name.
    if (!boros.length && /,\s*New York,?\s*NY\b/i.test(vendorAddress)
      && !/\b(?:Bronx|Brooklyn|Queens|Staten\s+Island)\b/i.test(vendorAddress)) {
      boros = ["Manhattan"];
    }
    // Street-only vendor addresses: gazetteer street → borough (Valentine Ave → Bronx).
    if (!boros.length) {
      for (const entry of PLACE_GAZETTEER) {
        if (entry.pattern.test(vendorAddress)) {
          boros = entry.boroughs.slice();
          break;
        }
      }
    }
    if (boros.length) {
      hits.push(hit({
        method: "vendor_address",
        confidence: LOCATION_CONFIDENCE.vendor_place,
        role: "vendor",
        boroughs: boros,
        addresses: [normalizeAddress(vendorAddress)],
        evidence: vendorAddress.slice(0, 160),
      }));
    }
  }

  // Venue held-at lines in body.
  for (const span of venueHeldAtSpans(body)) {
    const boros = boroughsIn(span.evidence + " " + span.address);
    hits.push(hit({
      method: "venue_line",
      confidence: LOCATION_CONFIDENCE.venue_line,
      role: "venue",
      addresses: [span.address],
      boroughs: boros,
      evidence: span.evidence,
    }));
  }

  // Publisher venue columns.
  const colVenue = venueFromPublisherColumns(row);
  if (colVenue) {
    let venueBoros = colVenue.boroughs.slice();
    if (!venueBoros.length) {
      for (const entry of PLACE_GAZETTEER) {
        if (entry.pattern.test(colVenue.address)) {
          venueBoros = entry.boroughs.slice();
          break;
        }
      }
    }
    hits.push(hit({
      method: "venue_column",
      confidence: LOCATION_CONFIDENCE.venue_column,
      role: "venue",
      addresses: [colVenue.address],
      boroughs: venueBoros,
      evidence: colVenue.evidence,
    }));
  }

  // Agency HQ last resort (weak) — only when no stronger matter/venue hit.
  const hasStrong = hits.some((h) =>
    h.role === "matter" || h.role === "citywide" || h.method === "venue_line" || h.method === "venue_column");
  if (!hasStrong && agency) {
    for (const hq of AGENCY_HQ) {
      if (hq.pattern.test(agency)) {
        hits.push(hit({
          method: "agency_hq",
          confidence: LOCATION_CONFIDENCE.agency_hq,
          role: "agency",
          boroughs: hq.boroughs,
          evidence: hq.label,
        }));
        break;
      }
    }
  }

  // Optional: force-include agency HQ for meetings map even when venue missing.
  if (opts.includeAgencyHq && agency && !hits.some((h) => h.method === "agency_hq")) {
    for (const hq of AGENCY_HQ) {
      if (hq.pattern.test(agency)) {
        hits.push(hit({
          method: "agency_hq",
          confidence: LOCATION_CONFIDENCE.agency_hq,
          role: "agency",
          boroughs: hq.boroughs,
          evidence: hq.label,
        }));
        break;
      }
    }
  }

  const venueAddr = colVenue?.address || null;
  const virtualOnly = isVirtualOnlyText(body, venueAddr)
    || (opts.venueMode === "virtual");

  let unlocated_reason = null;
  const placeHits = hits.filter((h) =>
    h.citywide
    || h.boroughs.length
    || h.community_boards.length
    || h.community_districts.length
    || h.addresses.length);
  if (!placeHits.length) {
    unlocated_reason = virtualOnly ? "virtual_only" : "no_place_signal";
  }

  return { hits, unlocated_reason, virtual_only: virtualOnly };
}

/**
 * Collapse candidates into an affected-area-shaped place object for map stamps.
 * Prefer matter > citywide > venue > vendor > agency.
 *
 * @param {object} row
 * @param {{ forLens?: "meetings"|"rules"|"money" }} [opts]
 */
export function placeFromDerivations(row = {}, opts = {}) {
  const { hits, unlocated_reason, virtual_only } = deriveLocationCandidates(row, {
    includeAgencyHq: opts.forLens === "meetings",
  });
  if (!hits.length) {
    return {
      scope: "unlocated",
      boroughs: [],
      community_boards: [],
      community_districts: [],
      addresses: [],
      derivation: { methods: [], confidence: 0, evidence: [] },
      unlocated_reason: unlocated_reason || "no_place_signal",
      virtual_only,
    };
  }

  const roleRank = { matter: 0, citywide: 1, venue: 2, vendor: 3, agency: 4 };
  const sorted = [...hits].sort((a, b) => {
    const rr = (roleRank[a.role] ?? 9) - (roleRank[b.role] ?? 9);
    if (rr !== 0) return rr;
    return (b.confidence || 0) - (a.confidence || 0);
  });

  // forLens filters:
  //   matter   — matter + citywide only (no venue / agency)
  //   rules    — matter + citywide, else default citywide
  //   meetings — full chain (matter → venue → agency HQ)
  //   money    — matter + citywide + vendor
  let chosen = sorted;
  if (opts.forLens === "matter") {
    chosen = sorted.filter((h) => h.role === "matter" || h.role === "citywide");
  } else if (opts.forLens === "rules") {
    chosen = sorted.filter((h) => h.role === "matter" || h.role === "citywide");
    if (!chosen.length) {
      // Default citywide for Agency Rules with no local pin — honest product rule.
      return {
        scope: "citywide",
        boroughs: [],
        community_boards: [],
        community_districts: [],
        addresses: [],
        derivation: {
          methods: ["rule_default_citywide"],
          confidence: LOCATION_CONFIDENCE.citywide_phrase,
          evidence: ["Agency Rules with no local scope phrase"],
        },
        unlocated_reason: null,
        virtual_only,
      };
    }
  } else if (opts.forLens === "money") {
    chosen = sorted.filter((h) =>
      h.role === "matter" || h.role === "citywide" || h.role === "vendor");
  }

  if (!chosen.length) {
    return {
      scope: "unlocated",
      boroughs: [],
      community_boards: [],
      community_districts: [],
      addresses: [],
      derivation: { methods: [], confidence: 0, evidence: [] },
      unlocated_reason: unlocated_reason || "no_place_signal",
      virtual_only,
    };
  }

  // Prefer top role; merge same-role peers; do not let agency HQ override matter.
  const topRole = chosen[0].role;
  const peer = chosen.filter((h) => h.role === topRole);
  const citywide = peer.some((h) => h.citywide) || topRole === "citywide";
  const boroughs = unique(peer.flatMap((h) => h.boroughs));
  const community_boards = unique(peer.flatMap((h) => h.community_boards));
  const community_districts = unique(peer.flatMap((h) => h.community_districts));
  const addresses = unique(peer.flatMap((h) => h.addresses)).map((label) => ({ label }));
  const confidence = Math.max(...peer.map((h) => h.confidence || 0));
  const methods = unique(peer.map((h) => h.method));
  const evidenceList = unique(peer.map((h) => h.evidence).filter(Boolean)).slice(0, 6);

  // Venue/agency without borough still unlocated for map bags (address alone can't PIP offline).
  const hasPlace = citywide || boroughs.length || community_boards.length || community_districts.length;
  if (!hasPlace) {
    // Try to recover boroughs from address labels via gazetteer street names.
    for (const a of addresses) {
      for (const entry of PLACE_GAZETTEER) {
        if (entry.pattern.test(a.label)) boroughs.push(...entry.boroughs);
      }
    }
  }
  const boroughsFinal = unique(boroughs);
  const local = boroughsFinal.length || community_boards.length || community_districts.length || addresses.length;
  if (!citywide && !local) {
    return {
      scope: "unlocated",
      boroughs: [],
      community_boards: [],
      community_districts: [],
      addresses,
      derivation: { methods, confidence, evidence: evidenceList },
      unlocated_reason: virtual_only ? "virtual_only" : "no_place_signal",
      virtual_only,
    };
  }

  return {
    scope: citywide && !boroughsFinal.length ? "citywide" : local ? "local" : "citywide",
    boroughs: boroughsFinal,
    community_boards,
    community_districts,
    addresses,
    neighborhoods: [],
    districts: [],
    derivation: {
      methods,
      confidence,
      evidence: evidenceList,
      role: topRole,
    },
    unlocated_reason: null,
    virtual_only,
    // Map may render agency/vendor-derived pins distinctly from matter/venue.
    confidence_tier: confidence >= 0.8 ? "strong" : confidence >= 0.55 ? "derived" : "weak",
  };
}

export function compactDerivationStamp(place) {
  if (!place || place.scope === "unlocated") {
    return place?.unlocated_reason
      ? { scope: "unlocated", unlocated_reason: place.unlocated_reason, virtual_only: !!place.virtual_only }
      : null;
  }
  const stamp = {
    scope: place.scope || "local",
  };
  if (place.boroughs?.length) stamp.boroughs = place.boroughs.slice();
  if (place.community_boards?.length) stamp.community_boards = place.community_boards.slice();
  if (place.community_districts?.length) stamp.community_districts = place.community_districts.slice();
  if (place.neighborhoods?.length) stamp.neighborhoods = place.neighborhoods.slice();
  if (place.districts?.length) stamp.districts = place.districts.slice();
  if (place.derivation) {
    stamp.derivation = {
      methods: place.derivation.methods || [],
      confidence: place.derivation.confidence || 0,
      role: place.derivation.role || null,
      evidence: (place.derivation.evidence || []).slice(0, 4),
    };
  }
  if (place.confidence_tier) stamp.confidence_tier = place.confidence_tier;
  if (place.virtual_only) stamp.virtual_only = true;
  return stamp;
}
