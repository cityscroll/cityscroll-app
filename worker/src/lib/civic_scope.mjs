// Unified civic-scope records: topic-scoped citywide rules vs place-scoped
// hearings/consents. The Dining Out NYC case study is the characterization
// anchor — one citywide program rule and many address-level cafe consents.
//
// This layer does not replace the Rules or Meetings lenses; it models the
// distinction those separate pipelines cannot currently express together:
// scope class, place geometry (coordinates/BBL/CD/council), modality,
// accessibility, deadline, official action route, and outcome.

import { ruleLocationFromRow } from "../../../site/rule_location.mjs";
import {
  cafeConsentPlacesFromRow,
  extractCafeConsentPetitions,
  isDiningOutConsentNotice,
} from "./cafe_consent.mjs";
import { classifyStage } from "./rules.mjs";
import { venueFromRow } from "./hearings.mjs";
import { plainText } from "../../../site/location_extract.mjs";

export const CIVIC_SCOPE_SCHEMA_VERSION = "1.0.0";

export const SCOPE_CLASSES = Object.freeze(["topic", "place"]);
export const RECORD_KINDS = Object.freeze(["citywide_rule", "place_consent", "place_hearing"]);
export const MODALITIES = Object.freeze(["in-person", "remote", "hybrid", "not-stated"]);
export const OUTCOME_STATUSES = Object.freeze([
  "not_recorded",
  "scheduled",
  "held",
  "comment_open",
  "comment_closed",
  "adopted",
  "effective",
  "granted",
  "denied",
  "withdrawn",
]);

const BODY_FIELDS = [
  "additional_description_1", "additional_description_2", "additional_description_3",
  "other_info_1", "other_info_2", "other_info_3", "printout_1", "printout_2", "printout_3",
];

function cityRecordUrl(requestId) {
  if (!requestId) return null;
  return `https://a856-cityrecord.nyc.gov/RequestDetail/${encodeURIComponent(requestId)}`;
}

function bodyText(row) {
  return plainText([
    row?.short_title,
    ...BODY_FIELDS.map((field) => row?.[field]),
  ].filter(Boolean).join(" "));
}

function emptyAccessibility(reason = "no accommodation language found in the notice") {
  return {
    stated: false,
    summary: null,
    accommodations_url: null,
    note: reason,
  };
}

function accessibilityFromText(text) {
  if (!text) return emptyAccessibility();
  const match = text.match(
    /\b(?:if you need (?:an? )?(?:reasonable )?accommodation|accessibility|sign language|assistive listening|wheelchair)[^.]*\./i,
  );
  if (!match) return emptyAccessibility();
  return {
    stated: true,
    summary: plainText(match[0]),
    accommodations_url: null,
    note: null,
  };
}

function modalityFromVenueMode(mode) {
  if (mode === "virtual") return "remote";
  if (mode === "in-person") return "in-person";
  if (mode === "hybrid") return "hybrid";
  return "not-stated";
}

function actionRoute({ type, label, url, deadline = null, delivery = null }) {
  const resolvedDelivery = delivery
    || (url && String(url).startsWith("https://") ? "official_handoff" : "unavailable");
  const route = {
    type,
    label,
    delivery: resolvedDelivery,
    deadline: deadline || null,
  };
  if (resolvedDelivery === "official_handoff") {
    route.url = url;
    try {
      route.destination_label = new URL(url).hostname;
    } catch {
      route.destination_label = "official site";
    }
  } else {
    route.url = null;
    route.destination_label = null;
    if (!url) route.note = "no official action URL found for this record";
  }
  return route;
}

function validatePlace(place) {
  if (!place || typeof place !== "object") throw new TypeError("place must be an object");
  if (!place.label) throw new TypeError("place.label is required");
  return place;
}

export function validateCivicScopeRecord(record) {
  if (!record || typeof record !== "object") throw new TypeError("civic scope record required");
  if (record.schema_version !== CIVIC_SCOPE_SCHEMA_VERSION) {
    throw new TypeError(`unsupported civic scope schema_version: ${record.schema_version}`);
  }
  if (!RECORD_KINDS.includes(record.kind)) throw new TypeError(`unknown kind: ${record.kind}`);
  if (!SCOPE_CLASSES.includes(record.scope_class)) {
    throw new TypeError(`unknown scope_class: ${record.scope_class}`);
  }
  if (typeof record.citywide !== "boolean") throw new TypeError("citywide must be boolean");
  if (record.scope_class === "topic" && !record.citywide) {
    throw new TypeError("topic-scoped records must be citywide in this schema version");
  }
  if (record.scope_class === "place" && record.citywide) {
    throw new TypeError("place-scoped records cannot be citywide");
  }
  if (!MODALITIES.includes(record.modality)) throw new TypeError(`unknown modality: ${record.modality}`);
  if (!Array.isArray(record.places)) throw new TypeError("places must be an array");
  record.places.forEach(validatePlace);
  if (record.scope_class === "place" && record.places.length === 0) {
    throw new TypeError("place-scoped records require at least one place");
  }
  if (record.scope_class === "topic" && record.places.length !== 0) {
    throw new TypeError("topic-scoped records must not carry place pins");
  }
  if (!record.action?.primary) throw new TypeError("action.primary is required");
  if (!record.outcome || !OUTCOME_STATUSES.includes(record.outcome.status)) {
    throw new TypeError("outcome.status is required and must be known");
  }
  if (!record.sources || typeof record.sources !== "object") {
    throw new TypeError("sources are required");
  }
  return record;
}

export function emptyPlace(label, borough = null) {
  return {
    label,
    borough: borough || null,
    neighborhood: null,
    latitude: null,
    longitude: null,
    bbl: null,
    community_district: null,
    council_district: null,
    cafe_type: null,
    petitioner: null,
    geocode_status: "unresolved",
  };
}

/**
 * Apply geocode / MapPLUTO enrichment to place pins.
 * `geocodes` is keyed by `${label}|${borough}` then bare label.
 * Notice borough stays authoritative; a conflicting geocoder borough is flagged.
 */
export function applyPlaceGeocodes(places, geocodes = {}) {
  return (places || []).map((place) => {
    const keyWithBorough = place.borough ? `${place.label}|${place.borough}` : null;
    const geo = (keyWithBorough && geocodes[keyWithBorough])
      || geocodes[place.label]
      || {};
    const out = {
      ...place,
      neighborhood: geo.neighborhood || place.neighborhood || null,
      latitude: Number.isFinite(geo.latitude) ? geo.latitude : place.latitude,
      longitude: Number.isFinite(geo.longitude) ? geo.longitude : place.longitude,
      bbl: /^\d{10}$/.test(geo.bbl || "") ? geo.bbl : place.bbl,
      community_district: geo.community_district || place.community_district || null,
      council_district: geo.council_district || place.council_district || null,
    };
    const hasGeometry = Number.isFinite(out.latitude) && Number.isFinite(out.longitude);
    if (!hasGeometry) {
      out.geocode_status = "unresolved";
    } else if (
      place.borough
      && geo.borough
      && String(place.borough).toLowerCase() !== String(geo.borough).toLowerCase()
    ) {
      out.geocode_status = "borough_mismatch";
      out.geocode_borough = geo.borough;
    } else {
      out.geocode_status = "matched";
      if (geo.borough && !out.borough) out.borough = geo.borough;
    }
    return out;
  });
}

export function normalizeCitywideRuleRecord({
  cityRecordRow,
  nycRules = null,
  now = new Date(),
} = {}) {
  if (!cityRecordRow && !nycRules) {
    throw new TypeError("citywide rule requires a City Record row and/or NYC Rules item");
  }
  const location = cityRecordRow
    ? ruleLocationFromRow(cityRecordRow)
    : { scope: "citywide", boroughs: [], districts: [], source: "rule-scope" };
  // Topic-scoped program rules remain citywide even if a future district rule
  // uses the local branch; this normalizer is for the citywide program class.
  const stage = nycRules ? classifyStage(nycRules, now) : "proposed";
  const commentDeadline = nycRules?.comment_by_date || null;
  const hearingDate = nycRules?.hearing_date || cityRecordRow?.event_date || null;
  const effectiveDate = nycRules?.adoption_date || null;
  const deadline = commentDeadline
    ? { type: "comment", at: commentDeadline, label: "Comment deadline" }
    : hearingDate
      ? { type: "hearing", at: hearingDate, label: "Hearing date" }
      : effectiveDate
        ? { type: "effective", at: effectiveDate, label: "Effective date" }
        : null;

  const nycRulesUrl = nycRules?.url || null;
  const cityRecordId = cityRecordRow?.request_id || null;
  const primary = nycRulesUrl
    ? actionRoute({
      type: "comment",
      label: stage === "effective" || stage === "adopted"
        ? "Open the official NYC Rules page"
        : "Comment on NYC Rules",
      url: nycRulesUrl,
      deadline: commentDeadline,
    })
    : actionRoute({
      type: "document",
      label: "Open the City Record notice",
      url: cityRecordUrl(cityRecordId),
      deadline: null,
    });

  let outcomeStatus = "not_recorded";
  if (stage === "effective") outcomeStatus = "effective";
  else if (stage === "adopted") outcomeStatus = "adopted";
  else if (stage === "comment-open") outcomeStatus = "comment_open";
  else if (stage === "comment-closed") outcomeStatus = "comment_closed";
  else if (stage === "hearing") outcomeStatus = "scheduled";

  const title = plainText(
    cityRecordRow?.short_title || nycRules?.title || "Untitled rule",
  );
  const agency = cityRecordRow?.agency_name || nycRules?.agency_name || null;
  const body = cityRecordRow ? bodyText(cityRecordRow) : plainText(nycRules?.summary || "");

  const record = {
    schema_version: CIVIC_SCOPE_SCHEMA_VERSION,
    record_id: cityRecordId
      ? `rule:city-record:${cityRecordId}`
      : `rule:nyc-rules:${nycRules?.guid || nycRules?.url || title}`,
    kind: "citywide_rule",
    scope_class: "topic",
    citywide: true,
    title,
    agency,
    published_at: cityRecordRow?.start_date || nycRules?.pub_date || null,
    event_date: hearingDate,
    places: [],
    modality: hearingDate ? "not-stated" : "not-stated",
    accessibility: accessibilityFromText(body),
    deadline,
    action: {
      primary,
      routes: [
        primary,
        nycRulesUrl && primary.url !== nycRulesUrl
          ? actionRoute({
            type: "document",
            label: "Open the official NYC Rules page",
            url: nycRulesUrl,
          })
          : null,
        cityRecordId
          ? actionRoute({
            type: "document",
            label: "Open the City Record notice",
            url: cityRecordUrl(cityRecordId),
          })
          : null,
      ].filter(Boolean),
    },
    outcome: {
      status: outcomeStatus,
      recorded_at: effectiveDate || null,
      summary: outcomeStatus === "not_recorded"
        ? "no outcome record found for this rule beyond the published stage"
        : `Lifecycle stage: ${stage}`,
      stage,
    },
    sources: {
      city_record: cityRecordId
        ? {
          request_id: cityRecordId,
          url: cityRecordUrl(cityRecordId),
          section_name: cityRecordRow.section_name || null,
          notice_type: cityRecordRow.type_of_notice_description || null,
          title: plainText(cityRecordRow.short_title),
        }
        : null,
      nyc_rules: nycRulesUrl
        ? {
          url: nycRulesUrl,
          title: nycRules.title || null,
          comment_url: nycRules.comment_url || null,
          comment_by_date: nycRules.comment_by_date || null,
          hearing_date: nycRules.hearing_date || null,
          adoption_date: nycRules.adoption_date || null,
        }
        : null,
    },
    location_source: location.source || "rule-scope",
    rule_location_scope: location.scope,
  };
  return validateCivicScopeRecord(record);
}

export function normalizePlaceConsentRecord(cityRecordRow, {
  geocodes = {},
  now = new Date(),
} = {}) {
  if (!cityRecordRow?.request_id) throw new TypeError("place consent requires a City Record row");
  const petitions = extractCafeConsentPetitions(cityRecordRow);
  if (!petitions.length && !isDiningOutConsentNotice(cityRecordRow)) {
    throw new TypeError("row is not a cafe-consent notice with extractable places");
  }
  let places = cafeConsentPlacesFromRow(cityRecordRow);
  if (!places.length) {
    // Fall back to empty place only if detector fired but parser missed — keep honest.
    throw new TypeError(`no cafe consent places extracted for ${cityRecordRow.request_id}`);
  }
  places = applyPlaceGeocodes(places, geocodes);

  const venue = venueFromRow(cityRecordRow);
  const modality = modalityFromVenueMode(venue.mode);
  const body = bodyText(cityRecordRow);
  const eventDate = cityRecordRow.event_date || null;
  const sourceUrl = cityRecordUrl(cityRecordRow.request_id);
  // Official Dining Out copy-request route appears on every recent notice.
  const copyRequest = /diningoutnyc\.info\/requestcopy/i.test(body)
    ? "https://diningoutnyc.info/requestcopy"
    : null;
  const zoom = (body.match(/\bzoom\.us\/j\/\d+\b/i) || [])[0];
  const zoomUrl = zoom ? `https://${zoom.replace(/^https?:\/\//i, "")}` : null;

  const primary = actionRoute({
    type: "attend",
    label: modality === "remote" || modality === "hybrid"
      ? "Join the official hearing"
      : "Open the City Record hearing notice",
    url: zoomUrl || sourceUrl,
    deadline: eventDate,
  });

  const past = eventDate && Date.parse(eventDate) < now.getTime();
  const record = {
    schema_version: CIVIC_SCOPE_SCHEMA_VERSION,
    record_id: `consent:city-record:${cityRecordRow.request_id}`,
    kind: "place_consent",
    scope_class: "place",
    citywide: false,
    title: plainText(cityRecordRow.short_title) || "Cafe consent hearing",
    agency: cityRecordRow.agency_name || null,
    published_at: cityRecordRow.start_date || null,
    event_date: eventDate,
    places,
    modality,
    accessibility: accessibilityFromText(body),
    deadline: eventDate
      ? { type: "hearing", at: eventDate, label: "Hearing date" }
      : null,
    action: {
      primary,
      routes: [
        primary,
        actionRoute({
          type: "document",
          label: "Open the City Record notice",
          url: sourceUrl,
          deadline: eventDate,
        }),
        copyRequest && actionRoute({
          type: "document",
          label: "Request the draft consent agreement",
          url: copyRequest,
        }),
        zoomUrl && actionRoute({
          type: "attend",
          label: "Join the Zoom hearing",
          url: zoomUrl,
          deadline: eventDate,
        }),
      ].filter(Boolean),
    },
    outcome: {
      status: past ? "held" : "scheduled",
      recorded_at: null,
      summary: past
        ? "Hearing date has passed; no separate grant/deny outcome record found in City Record"
        : "Hearing is scheduled; no grant/deny outcome record found yet",
    },
    sources: {
      city_record: {
        request_id: String(cityRecordRow.request_id),
        url: sourceUrl,
        section_name: cityRecordRow.section_name || null,
        notice_type: cityRecordRow.type_of_notice_description || null,
        title: plainText(cityRecordRow.short_title),
      },
      nyc_rules: null,
      dining_out: {
        program: "Dining Out NYC",
        petition_count: places.length,
        copy_request_url: copyRequest,
      },
    },
    venue: {
      mode: venue.mode,
      address: venue.address,
    },
  };
  return validateCivicScopeRecord(record);
}

/** Expand a multi-place consent hearing into one record per cafe pin (map-friendly). */
export function expandPlaceConsentRecords(record) {
  validateCivicScopeRecord(record);
  if (record.kind !== "place_consent") return [record];
  return record.places.map((place, index) => validateCivicScopeRecord({
    ...structuredClone(record),
    record_id: `${record.record_id}:place:${index + 1}`,
    title: place.petitioner
      ? `${place.petitioner} — ${place.label}`
      : `${record.title} — ${place.label}`,
    places: [place],
  }));
}

export function isCitywideTopicRecord(record) {
  return record?.scope_class === "topic" && record?.citywide === true;
}

export function isPlaceScopedRecord(record) {
  return record?.scope_class === "place" && record?.citywide === false;
}
