/**
 * Source-qualified meeting location assertions.
 *
 * Adapters retain publisher venue text and structured components. This module
 * assigns an explicit civic role and validity before any spatial resolution:
 * date-shaped text, incidental footer/contact text, and unresolved remote /
 * office conflicts never become physical venue candidates.
 *
 * Keep this module free of location_extract.mjs. The retained SPA inline rebuild
 * concatenates modules into one scope; location_extract's exported BOROUGHS
 * collides with borough_scope_links.mjs when both land in that rebuild.
 */

export const MEETING_LOCATION_ASSERTION_SCHEMA = "cityscroll.meeting_location_assertion.v1";

// Local street probe — mirrors location_extract.ADDRESS_RE without importing it.
const MEETING_ADDRESS_RE = /\b\d{1,5}(?:-\d{1,5})?(?!\s*(?:feet|foot|ft\.?|square|sf)\b)\s+[A-Z0-9][A-Z0-9.'’ -]{0,60}?\b(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Place|Pl|Lane|Ln|Drive|Dr|Parkway|Pkwy|Broadway)\b/gi;

function normalizeMeetingAddress(value) {
  return String(value ?? "")
    .replace(/\s*,\s*/g, ", ")
    .replace(/[.,;:\s]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export const LOCATION_ROLES = Object.freeze({
  VENUE: "venue",
  SUBJECT_PROPERTY: "subject_property",
  HOST_JURISDICTION: "host_jurisdiction",
  CONTACT_FOOTER: "contact_footer",
});

export const LOCATION_VALIDITY = Object.freeze({
  ADMITTED_PHYSICAL: "admitted_physical_venue",
  ADMITTED_SUBJECT_PROPERTY: "admitted_subject_property",
  REJECTED_DATE_SHAPED: "rejected_date_shaped",
  UNRESOLVED_ATTENDANCE: "unresolved_attendance_conflict",
  REJECTED_INCIDENTAL: "rejected_incidental_source_text",
  UNLOCATED: "unlocated",
});

export const ATTENDANCE_MEANING = Object.freeze({
  IN_PERSON: "in_person",
  REMOTE: "remote",
  HYBRID: "hybrid",
  UNRESOLVED_CONFLICT: "unresolved_conflict",
  NOT_STATED: "not_stated",
});

const mlaClean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max) || null;

const MLA_DATE_SHAPED_VENUE = /^(?:(?:sun|mon|tue|wed|thu|fri|sat)\w*\.?[,]?\s+)?(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:,?\s+20\d{2})?$/i;
const MLA_REMOTE_SIGNAL = /\b(?:via\s+video\s+conference|video\s+conference|virtual|online|zoom|webex|teams|webinar)\b/i;
const MLA_STREET_TYPE_EXPAND = Object.freeze({
  ave: "Avenue",
  av: "Avenue",
  st: "Street",
  rd: "Road",
  blvd: "Boulevard",
  pl: "Place",
  ln: "Lane",
  dr: "Drive",
  pkwy: "Parkway",
});

/**
 * True when publisher location text is a calendar date rather than a street.
 */
export function isDateShapedVenueText(value) {
  const text = mlaClean(value, 200);
  if (!text) return false;
  if (MLA_DATE_SHAPED_VENUE.test(text)) return true;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return true;
  return false;
}

/**
 * Expand a bounded street-type abbreviation inside a published street span.
 * Leaves the original publisher string available separately as original_address.
 */
export function expandPublishedStreetSpan(value) {
  const text = mlaClean(value, 300);
  if (!text) return null;
  return text.replace(
    /\b([A-Za-z0-9.'’ -]+?)\s+(Ave|Av|St|Rd|Blvd|Pl|Ln|Dr|Pkwy)\b\.?/gi,
    (_, stem, type) => `${stem.trim()} ${MLA_STREET_TYPE_EXPAND[type.toLowerCase()] || type}`,
  );
}

/**
 * Parse an ICS LOCATION wrapper of the form `Venue Name (street, locality, ZIP)`.
 * Preserves the wrapper text separately and never invents a borough.
 */
export function parseIcsLocationWrapper(value) {
  const original = mlaClean(value, 500);
  if (!original) return null;
  const match = original.match(/^(.*?)\(([^()]*)\)\s*$/);
  if (!match) {
    return {
      original_address: original,
      wrapper: null,
      venue_name: null,
      components: null,
    };
  }
  const venueName = mlaClean(match[1], 300);
  const inside = mlaClean(match[2], 400);
  const parts = inside.split(",").map((part) => mlaClean(part, 200)).filter(Boolean);
  let street = null;
  let locality = null;
  let postalCode = null;
  for (const part of parts) {
    if (/^\d{5}(?:-\d{4})?$/.test(part)) {
      postalCode = part.slice(0, 5);
      continue;
    }
    if (!street && MEETING_ADDRESS_RE.test(part)) {
      MEETING_ADDRESS_RE.lastIndex = 0;
      street = expandPublishedStreetSpan(part);
      continue;
    }
    MEETING_ADDRESS_RE.lastIndex = 0;
    if (!locality) locality = part;
  }
  return {
    original_address: original,
    wrapper: inside,
    venue_name: venueName,
    components: {
      street_address: street,
      address_locality: locality,
      postal_code: postalCode,
      address_region: null,
      address_borough: null,
    },
  };
}

/**
 * Resolve attendance meaning from publisher mode and location text before a
 * physical venue edge is admitted.
 */
function mlaHasPhysicalStreetEvidence(address = null, components = null) {
  if (mlaClean(components?.street_address) && !isDateShapedVenueText(components.street_address)) {
    return true;
  }
  const text = mlaClean(address);
  if (!text || isDateShapedVenueText(text)) return false;
  const matched = MEETING_ADDRESS_RE.test(text);
  MEETING_ADDRESS_RE.lastIndex = 0;
  return matched;
}

export function resolveAttendanceMeaning({
  mode = null,
  address = null,
  venue_name = null,
  description = null,
  components = null,
} = {}) {
  const blob = [mode, address, venue_name, description].map((part) => mlaClean(part, 500)).filter(Boolean).join(" ");
  const remote = MLA_REMOTE_SIGNAL.test(blob);
  const physical = mlaHasPhysicalStreetEvidence(address, components);
  const stated = mlaClean(mode, 40)?.toLowerCase() || null;

  if (remote && physical) {
    if (stated === "hybrid") return ATTENDANCE_MEANING.HYBRID;
    return ATTENDANCE_MEANING.UNRESOLVED_CONFLICT;
  }
  if (stated === "hybrid" || (remote && physical)) return ATTENDANCE_MEANING.HYBRID;
  if (stated === "virtual" || stated === "online" || (remote && !physical)) {
    return ATTENDANCE_MEANING.REMOTE;
  }
  if (stated === "in-person" || stated === "in_person") {
    if (remote) return ATTENDANCE_MEANING.UNRESOLVED_CONFLICT;
    return ATTENDANCE_MEANING.IN_PERSON;
  }
  if (physical && !remote) return ATTENDANCE_MEANING.IN_PERSON;
  if (remote) return ATTENDANCE_MEANING.REMOTE;
  return ATTENDANCE_MEANING.NOT_STATED;
}

function mlaAssertionId(meetingId, role, sourceField, ordinal = 1) {
  const base = [meetingId || "meeting:unknown", role, sourceField || "location", String(ordinal)]
    .map((part) => String(part).replace(/\s+/g, "_"))
    .join("::");
  return `location_assertion:${base}`;
}

// Web-API-safe SHA-256 so browser notice preload can retain passage hashes without node:crypto.
const MLA_SHA256_K = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const MLA_SHA256_INITIAL = Object.freeze([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

function mlaRotateRight(value, bits) {
  return (value >>> bits) | (value << (32 - bits));
}

function mlaSha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value ?? ""));
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const state = [...MLA_SHA256_INITIAL];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const a = words[index - 15];
      const b = words[index - 2];
      const smallSigma0 = mlaRotateRight(a, 7) ^ mlaRotateRight(a, 18) ^ (a >>> 3);
      const smallSigma1 = mlaRotateRight(b, 17) ^ mlaRotateRight(b, 19) ^ (b >>> 10);
      words[index] = (words[index - 16] + smallSigma0 + words[index - 7] + smallSigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const bigSigma1 = mlaRotateRight(e, 6) ^ mlaRotateRight(e, 11) ^ mlaRotateRight(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + bigSigma1 + ch + MLA_SHA256_K[index] + words[index]) >>> 0;
      const bigSigma0 = mlaRotateRight(a, 2) ^ mlaRotateRight(a, 13) ^ mlaRotateRight(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (bigSigma0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }
  return state.map((word) => word.toString(16).padStart(8, "0")).join("");
}

const MLA_SUBJECT_ADDRESS = String.raw`(\d{1,5}(?:-\d{1,5})?\s+[A-Za-z0-9][A-Za-z0-9.'’ -]{0,60}?\b(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Boulevard|Blvd\.?|Place|Pl\.?|Lane|Ln\.?|Drive|Dr\.?|Parkway|Pkwy\.?|Broadway)\b)`;
const MLA_SUBJECT_CLAUSE_RES = Object.freeze([
  // "... application ... at 461 Coney Island Avenue"
  new RegExp(String.raw`\bapplications?\b[\s\S]{0,180}?\bat\s+${MLA_SUBJECT_ADDRESS}`, "gi"),
  // "Public Hearing on Retail Cannabis Application: 461 Coney Island Avenue"
  new RegExp(String.raw`\b(?:public\s+)?hearings?\b[\s\S]{0,160}?\bapplications?\b[\s\S]{0,80}?(?::|[-–—]\s*|\bat\s+)${MLA_SUBJECT_ADDRESS}`, "gi"),
  // "Recommendation - ... Application - 461 Coney Island Avenue"
  new RegExp(String.raw`\bapplications?\b\s*[-–—:]\s*${MLA_SUBJECT_ADDRESS}`, "gi"),
]);

function mlaNormalizeStreetKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\b(avenue|ave)\b/g, "ave")
    .replace(/\b(street|st)\b/g, "st")
    .replace(/\b(road|rd)\b/g, "rd")
    .replace(/\b(boulevard|blvd)\b/g, "blvd")
    .replace(/\b(place|pl)\b/g, "pl")
    .replace(/\b(lane|ln)\b/g, "ln")
    .replace(/\b(drive|dr)\b/g, "dr")
    .replace(/\b(parkway|pkwy)\b/g, "pkwy")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function mlaPassageLocator(sourceField, address, start) {
  const slug = mlaNormalizeStreetKey(address).replace(/\s+/g, "-").slice(0, 80) || "address";
  return `${sourceField || "description"}:application_at:${slug}@${Math.max(0, Number(start) || 0)}`;
}

/**
 * Bounded extraction of explicit application/hearing subject-property clauses.
 * Unknown shapes stay unadmitted; bare addresses without an application/hearing
 * clause never become subjects. Never invents a borough from an organizer name.
 */
export function extractAgendaSubjectPlaces(text, options = {}) {
  const source = mlaClean(text, 8_000);
  if (!source) return [];
  const excludeKeys = new Set(
    (options.exclude_addresses || [])
      .map((value) => mlaNormalizeStreetKey(value))
      .filter(Boolean),
  );
  const venueKey = mlaNormalizeStreetKey(options.venue_address || options.venue_street);
  if (venueKey) excludeKeys.add(venueKey);

  const found = [];
  const seen = new Set();
  for (const pattern of MLA_SUBJECT_CLAUSE_RES) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const rawAddress = expandPublishedStreetSpan(match[1]) || mlaClean(match[1], 300);
      if (!rawAddress || isDateShapedVenueText(rawAddress)) continue;
      const key = mlaNormalizeStreetKey(rawAddress);
      if (!key || seen.has(key) || excludeKeys.has(key)) continue;
      // Require the matched address span itself to look like a street probe.
      MEETING_ADDRESS_RE.lastIndex = 0;
      if (!MEETING_ADDRESS_RE.test(rawAddress)) {
        MEETING_ADDRESS_RE.lastIndex = 0;
        continue;
      }
      MEETING_ADDRESS_RE.lastIndex = 0;

      const clauseStart = Math.max(0, match.index);
      const clauseEnd = Math.min(source.length, clauseStart + match[0].length);
      const passage = mlaClean(source.slice(clauseStart, clauseEnd), 500);
      const sourceField = options.source_field || "description";
      const locality = mlaClean(options.address_locality || options.borough_context, 120);
      const region = mlaClean(options.address_region, 40);
      const postal = mlaClean(options.postal_code, 20);
      // Event-published locality may supply borough context; organizer names never do.
      const borough = mlaClean(options.address_borough, 40)
        || (locality && /^(Brooklyn|Queens|Manhattan|Bronx|Staten Island)$/i.test(locality) ? locality : null);
      seen.add(key);
      found.push({
        address: rawAddress,
        original_address: rawAddress,
        passage,
        source_field: sourceField,
        passage_locator: mlaPassageLocator(sourceField, rawAddress, clauseStart),
        passage_text_sha256: mlaSha256Hex(passage),
        components: {
          street_address: rawAddress,
          address_locality: locality,
          address_region: region,
          postal_code: postal,
          address_borough: borough,
        },
      });
    }
  }
  return found;
}

function mlaComponentsFromStructured(raw = {}) {
  if (!raw || typeof raw !== "object") return null;
  const street = mlaClean(raw.street_address || raw.streetAddress, 300);
  const locality = mlaClean(raw.address_locality || raw.addressLocality, 120);
  const region = mlaClean(raw.address_region || raw.addressRegion, 40);
  const postal = mlaClean(raw.postal_code || raw.postalCode, 20);
  const borough = mlaClean(raw.address_borough || raw.borough, 40);
  if (!street && !locality && !region && !postal && !borough) return null;
  return {
    street_address: street ? expandPublishedStreetSpan(street) || street : null,
    address_locality: locality,
    address_region: region,
    postal_code: postal ? postal.replace(/\D/g, "").slice(0, 5) || postal : null,
    address_borough: borough,
  };
}

function mlaFlattenComponents(components) {
  if (!components) return null;
  const region = components.address_region === "New York" ? "NY" : components.address_region;
  const cityStateZip = [
    components.address_locality,
    [region, components.postal_code].filter(Boolean).join(" "),
  ].filter(Boolean).join(", ");
  return [components.street_address, cityStateZip].filter(Boolean).join(", ") || null;
}

/**
 * Build one source-qualified location assertion. Callers supply the publisher
 * field or passage; this function never scrapes arbitrary page text.
 */
export function buildLocationAssertion({
  meeting_id = null,
  record_id = null,
  role = LOCATION_ROLES.VENUE,
  original_address = null,
  venue_name = null,
  components = null,
  wrapper = null,
  source_field = null,
  source_passage = null,
  passage_locator = null,
  passage_text_sha256 = null,
  source_receipt = null,
  mode = null,
  description = null,
  ordinal = 1,
} = {}) {
  const original = mlaClean(original_address, 500);
  const structured = mlaComponentsFromStructured(components) || null;
  const attendance = resolveAttendanceMeaning({
    mode,
    address: original || mlaFlattenComponents(structured),
    venue_name,
    description,
    components: structured,
  });

  let validity = LOCATION_VALIDITY.UNLOCATED;
  if (role === LOCATION_ROLES.CONTACT_FOOTER) {
    validity = LOCATION_VALIDITY.REJECTED_INCIDENTAL;
  } else if (original && isDateShapedVenueText(original)) {
    validity = LOCATION_VALIDITY.REJECTED_DATE_SHAPED;
  } else if (role === LOCATION_ROLES.SUBJECT_PROPERTY) {
    validity = mlaHasPhysicalStreetEvidence(original, structured)
      ? LOCATION_VALIDITY.ADMITTED_SUBJECT_PROPERTY
      : LOCATION_VALIDITY.UNLOCATED;
  } else if (attendance === ATTENDANCE_MEANING.UNRESOLVED_CONFLICT) {
    validity = LOCATION_VALIDITY.UNRESOLVED_ATTENDANCE;
  } else if (
    role === LOCATION_ROLES.VENUE
    && (attendance === ATTENDANCE_MEANING.IN_PERSON || attendance === ATTENDANCE_MEANING.HYBRID)
    && (
      mlaHasPhysicalStreetEvidence(original, structured)
      // Explicit in-person/hybrid publisher mode with a non-date location line
      // keeps the venue as a physical candidate even when the street regex
      // misses forms like "250 Broadway".
      || (original && !isDateShapedVenueText(original))
    )
  ) {
    validity = LOCATION_VALIDITY.ADMITTED_PHYSICAL;
  } else if (!original && !structured?.street_address) {
    validity = LOCATION_VALIDITY.UNLOCATED;
  } else if (attendance === ATTENDANCE_MEANING.REMOTE) {
    validity = LOCATION_VALIDITY.UNLOCATED;
  } else if (original || structured?.street_address) {
    // Preserve ambiguous publisher text without admitting a physical edge.
    validity = LOCATION_VALIDITY.UNRESOLVED_ATTENDANCE;
  }

  const passage = mlaClean(source_passage, 1_000);
  return {
    schema: MEETING_LOCATION_ASSERTION_SCHEMA,
    assertion_id: mlaAssertionId(meeting_id || record_id, role, source_field, ordinal),
    meeting_id: meeting_id || null,
    record_id: record_id || null,
    role,
    validity,
    attendance_meaning: attendance,
    original_address: original,
    venue_name: mlaClean(venue_name, 300),
    components: structured,
    wrapper: mlaClean(wrapper, 400),
    source_field: mlaClean(source_field, 120),
    source_passage: passage,
    passage_locator: mlaClean(passage_locator, 240),
    passage_text_sha256: mlaClean(passage_text_sha256, 64)
      || (passage ? mlaSha256Hex(passage) : null),
    source_receipt: source_receipt && typeof source_receipt === "object" ? source_receipt : null,
  };
}

/**
 * True when an assertion may feed exact address resolution / physical venue edges.
 */
export function isAdmittedPhysicalVenue(assertion) {
  return assertion?.role === LOCATION_ROLES.VENUE
    && assertion?.validity === LOCATION_VALIDITY.ADMITTED_PHYSICAL;
}

/**
 * True when an assertion may feed subject-property geography edges (AG-14).
 */
export function isAdmittedSubjectProperty(assertion) {
  return assertion?.role === LOCATION_ROLES.SUBJECT_PROPERTY
    && assertion?.validity === LOCATION_VALIDITY.ADMITTED_SUBJECT_PROPERTY;
}

/**
 * Build the additive location_assertions list for one normalized meeting row.
 */
export function buildMeetingLocationAssertions(row = {}, options = {}) {
  const meetingId = mlaClean(row.meeting_id || options.meeting_id, 500);
  const recordId = mlaClean(row.record_id || row.source_record_id || options.record_id, 500);
  const receipt = row.source_receipt || row.observed_receipt || options.source_receipt || null;
  const venue = row.venue && typeof row.venue === "object" ? row.venue : null;
  const structured = row.location_components || row.address_components || venue?.components || null;
  const wrapperParse = options.ics_location
    ? parseIcsLocationWrapper(options.ics_location)
    : (row.location_wrapper ? parseIcsLocationWrapper(row.location_wrapper) : null);

  const original = mlaClean(
    wrapperParse?.original_address
    || venue?.address
    || row.address
    || mlaFlattenComponents(structured)
    || null,
    500,
  );
  const venueName = mlaClean(
    wrapperParse?.venue_name
    || venue?.name
    || row.venue_name
    || null,
    300,
  );
  const components = structured || wrapperParse?.components || null;
  const mode = venue?.mode || row.mode || row.attendance_mode || null;
  const assertions = [];

  if (!original && !components?.street_address && !venueName) {
    assertions.push(buildLocationAssertion({
      meeting_id: meetingId,
      record_id: recordId,
      role: LOCATION_ROLES.VENUE,
      source_field: options.source_field || "venue",
      source_receipt: receipt,
      mode,
      description: row.description,
    }));
    return assertions;
  }

  assertions.push(buildLocationAssertion({
    meeting_id: meetingId,
    record_id: recordId,
    role: LOCATION_ROLES.VENUE,
    original_address: original,
    venue_name: venueName,
    components,
    wrapper: wrapperParse?.wrapper || null,
    source_field: options.source_field
      || (wrapperParse ? "LOCATION" : (structured ? "location.address" : "venue.address")),
    source_passage: options.source_passage || null,
    source_receipt: receipt,
    mode,
    description: row.description,
  }));

  const subjectCandidates = [
    ...(Array.isArray(options.agenda_subject_places) ? options.agenda_subject_places : []),
    ...(Array.isArray(row.agenda_subject_places) ? row.agenda_subject_places : []),
  ];
  if (subjectCandidates.length === 0 && row.description) {
    for (const extracted of extractAgendaSubjectPlaces(row.description, {
      source_field: "description",
      venue_address: original || components?.street_address || null,
      address_locality: components?.address_locality || null,
      address_region: components?.address_region || null,
      postal_code: components?.postal_code || null,
      address_borough: components?.address_borough || null,
      borough_context: components?.address_locality || components?.address_borough || null,
    })) {
      subjectCandidates.push(extracted);
    }
  }
  const seenSubjectKeys = new Set();
  for (const subject of subjectCandidates) {
    const address = subject?.address || subject?.original_address || subject;
    const key = mlaNormalizeStreetKey(address);
    if (!key || seenSubjectKeys.has(key)) continue;
    seenSubjectKeys.add(key);
    assertions.push(buildLocationAssertion({
      meeting_id: meetingId,
      record_id: recordId,
      role: LOCATION_ROLES.SUBJECT_PROPERTY,
      original_address: address,
      components: subject?.components || {
        street_address: expandPublishedStreetSpan(address) || mlaClean(address, 300),
        address_locality: components?.address_locality || null,
        address_region: components?.address_region || null,
        postal_code: null,
        address_borough: components?.address_borough
          || (components?.address_locality && /^(Brooklyn|Queens|Manhattan|Bronx|Staten Island)$/i.test(components.address_locality)
            ? components.address_locality
            : null),
      },
      source_field: subject?.source_field || "description",
      source_passage: subject?.passage || subject?.source_passage || null,
      passage_locator: subject?.passage_locator || null,
      passage_text_sha256: subject?.passage_text_sha256 || null,
      source_receipt: receipt,
      ordinal: assertions.length + 1,
    }));
  }

  for (const incidental of options.incidental_addresses || []) {
    assertions.push(buildLocationAssertion({
      meeting_id: meetingId,
      record_id: recordId,
      role: LOCATION_ROLES.CONTACT_FOOTER,
      original_address: incidental.address || incidental,
      source_field: incidental.source_field || "page_footer",
      source_passage: incidental.passage || null,
      source_receipt: receipt,
      ordinal: assertions.length + 1,
    }));
  }

  return assertions;
}

/**
 * Project admitted venue evidence back onto the legacy venue object without
 * inventing geography. Date-shaped text is cleared. Publisher venue names that
 * are not yet street-resolvable remain visible. Unresolved attendance keeps
 * the source text for repair without confirming a physical edge.
 */
export function projectVenueFromAssertions(assertions = [], fallback = null) {
  const admitted = (assertions || []).find(isAdmittedPhysicalVenue);
  if (admitted) {
    const projected = {
      ...(fallback && typeof fallback === "object" ? fallback : null),
      address: mlaFlattenComponents(admitted.components) || admitted.original_address || fallback?.address || null,
      mode: admitted.attendance_meaning === ATTENDANCE_MEANING.HYBRID
        ? "hybrid"
        : admitted.attendance_meaning === ATTENDANCE_MEANING.REMOTE
          ? "virtual"
          : "in-person",
    };
    const name = admitted.venue_name || fallback?.name || null;
    if (name) projected.name = name;
    const components = admitted.components || fallback?.components || null;
    if (components) projected.components = components;
    return projected;
  }
  const primary = (assertions || []).find((row) => row.role === LOCATION_ROLES.VENUE) || null;
  if (!primary) return fallback;
  if (primary.validity === LOCATION_VALIDITY.REJECTED_DATE_SHAPED) {
    return null;
  }
  if (primary.validity === LOCATION_VALIDITY.UNRESOLVED_ATTENDANCE) {
    const projected = {
      ...(fallback && typeof fallback === "object" ? fallback : null),
      address: primary.original_address || fallback?.address || null,
      mode: "not-stated",
      attendance_conflict: true,
    };
    const name = primary.venue_name || fallback?.name || null;
    if (name) projected.name = name;
    const components = primary.components || fallback?.components || null;
    if (components) projected.components = components;
    return projected;
  }
  return fallback;
}

export function normalizeAddressLine(value) {
  return normalizeMeetingAddress(value);
}
