/**
 * Source-qualified meeting location assertions.
 *
 * Adapters retain publisher venue text and structured components. This module
 * assigns an explicit civic role and validity before any spatial resolution:
 * date-shaped text, incidental footer/contact text, and unresolved remote /
 * office conflicts never become physical venue candidates.
 */

import { ADDRESS_RE, normalizeAddress } from "./location_extract.mjs";

export const MEETING_LOCATION_ASSERTION_SCHEMA = "cityscroll.meeting_location_assertion.v1";

export const LOCATION_ROLES = Object.freeze({
  VENUE: "venue",
  SUBJECT_PROPERTY: "subject_property",
  HOST_JURISDICTION: "host_jurisdiction",
  CONTACT_FOOTER: "contact_footer",
});

export const LOCATION_VALIDITY = Object.freeze({
  ADMITTED_PHYSICAL: "admitted_physical_venue",
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

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max) || null;

const DATE_SHAPED_VENUE = /^(?:(?:sun|mon|tue|wed|thu|fri|sat)\w*\.?[,]?\s+)?(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:,?\s+20\d{2})?$/i;
const REMOTE_SIGNAL = /\b(?:via\s+video\s+conference|video\s+conference|virtual|online|zoom|webex|teams|webinar)\b/i;
const STREET_TYPE_EXPAND = Object.freeze({
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
  const text = clean(value, 200);
  if (!text) return false;
  if (DATE_SHAPED_VENUE.test(text)) return true;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return true;
  return false;
}

/**
 * Expand a bounded street-type abbreviation inside a published street span.
 * Leaves the original publisher string available separately as original_address.
 */
export function expandPublishedStreetSpan(value) {
  const text = clean(value, 300);
  if (!text) return null;
  return text.replace(
    /\b([A-Za-z0-9.'’ -]+?)\s+(Ave|Av|St|Rd|Blvd|Pl|Ln|Dr|Pkwy)\b\.?/gi,
    (_, stem, type) => `${stem.trim()} ${STREET_TYPE_EXPAND[type.toLowerCase()] || type}`,
  );
}

/**
 * Parse an ICS LOCATION wrapper of the form `Venue Name (street, locality, ZIP)`.
 * Preserves the wrapper text separately and never invents a borough.
 */
export function parseIcsLocationWrapper(value) {
  const original = clean(value, 500);
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
  const venueName = clean(match[1], 300);
  const inside = clean(match[2], 400);
  const parts = inside.split(",").map((part) => clean(part, 200)).filter(Boolean);
  let street = null;
  let locality = null;
  let postalCode = null;
  for (const part of parts) {
    if (/^\d{5}(?:-\d{4})?$/.test(part)) {
      postalCode = part.slice(0, 5);
      continue;
    }
    if (!street && ADDRESS_RE.test(part)) {
      ADDRESS_RE.lastIndex = 0;
      street = expandPublishedStreetSpan(part);
      continue;
    }
    ADDRESS_RE.lastIndex = 0;
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
function hasPhysicalStreetEvidence(address = null, components = null) {
  if (clean(components?.street_address) && !isDateShapedVenueText(components.street_address)) {
    return true;
  }
  const text = clean(address);
  if (!text || isDateShapedVenueText(text)) return false;
  const matched = ADDRESS_RE.test(text);
  ADDRESS_RE.lastIndex = 0;
  return matched;
}

export function resolveAttendanceMeaning({
  mode = null,
  address = null,
  venue_name = null,
  description = null,
  components = null,
} = {}) {
  const blob = [mode, address, venue_name, description].map((part) => clean(part, 500)).filter(Boolean).join(" ");
  const remote = REMOTE_SIGNAL.test(blob);
  const physical = hasPhysicalStreetEvidence(address, components);
  const stated = clean(mode, 40)?.toLowerCase() || null;

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

function assertionId(meetingId, role, sourceField, ordinal = 1) {
  const base = [meetingId || "meeting:unknown", role, sourceField || "location", String(ordinal)]
    .map((part) => String(part).replace(/\s+/g, "_"))
    .join("::");
  return `location_assertion:${base}`;
}

function componentsFromStructured(raw = {}) {
  if (!raw || typeof raw !== "object") return null;
  const street = clean(raw.street_address || raw.streetAddress, 300);
  const locality = clean(raw.address_locality || raw.addressLocality, 120);
  const region = clean(raw.address_region || raw.addressRegion, 40);
  const postal = clean(raw.postal_code || raw.postalCode, 20);
  const borough = clean(raw.address_borough || raw.borough, 40);
  if (!street && !locality && !region && !postal && !borough) return null;
  return {
    street_address: street ? expandPublishedStreetSpan(street) || street : null,
    address_locality: locality,
    address_region: region,
    postal_code: postal ? postal.replace(/\D/g, "").slice(0, 5) || postal : null,
    address_borough: borough,
  };
}

function flattenComponents(components) {
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
  source_receipt = null,
  mode = null,
  description = null,
  ordinal = 1,
} = {}) {
  const original = clean(original_address, 500);
  const structured = componentsFromStructured(components) || null;
  const attendance = resolveAttendanceMeaning({
    mode,
    address: original || flattenComponents(structured),
    venue_name,
    description,
    components: structured,
  });

  let validity = LOCATION_VALIDITY.UNLOCATED;
  if (role === LOCATION_ROLES.CONTACT_FOOTER) {
    validity = LOCATION_VALIDITY.REJECTED_INCIDENTAL;
  } else if (original && isDateShapedVenueText(original)) {
    validity = LOCATION_VALIDITY.REJECTED_DATE_SHAPED;
  } else if (attendance === ATTENDANCE_MEANING.UNRESOLVED_CONFLICT) {
    validity = LOCATION_VALIDITY.UNRESOLVED_ATTENDANCE;
  } else if (
    role === LOCATION_ROLES.VENUE
    && (attendance === ATTENDANCE_MEANING.IN_PERSON || attendance === ATTENDANCE_MEANING.HYBRID)
    && (
      hasPhysicalStreetEvidence(original, structured)
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

  return {
    schema: MEETING_LOCATION_ASSERTION_SCHEMA,
    assertion_id: assertionId(meeting_id || record_id, role, source_field, ordinal),
    meeting_id: meeting_id || null,
    record_id: record_id || null,
    role,
    validity,
    attendance_meaning: attendance,
    original_address: original,
    venue_name: clean(venue_name, 300),
    components: structured,
    wrapper: clean(wrapper, 400),
    source_field: clean(source_field, 120),
    source_passage: clean(source_passage, 1_000),
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
 * Build the additive location_assertions list for one normalized meeting row.
 */
export function buildMeetingLocationAssertions(row = {}, options = {}) {
  const meetingId = clean(row.meeting_id || options.meeting_id, 500);
  const recordId = clean(row.record_id || row.source_record_id || options.record_id, 500);
  const receipt = row.source_receipt || row.observed_receipt || options.source_receipt || null;
  const venue = row.venue && typeof row.venue === "object" ? row.venue : null;
  const structured = row.location_components || row.address_components || venue?.components || null;
  const wrapperParse = options.ics_location
    ? parseIcsLocationWrapper(options.ics_location)
    : (row.location_wrapper ? parseIcsLocationWrapper(row.location_wrapper) : null);

  const original = clean(
    wrapperParse?.original_address
    || venue?.address
    || row.address
    || flattenComponents(structured)
    || null,
    500,
  );
  const venueName = clean(
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
      address: flattenComponents(admitted.components) || admitted.original_address || fallback?.address || null,
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
  return normalizeAddress(value);
}
