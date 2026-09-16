/** Shared place and deadline projection for consultation consumers. */

import {
  classifyLocationEvidence,
  locationEvidenceAllowsExactPredicate,
} from "./location_evidence_tier.mjs";

export const CONSULTATION_NOW_HORIZON_DAYS = 30;
export const CONSULTATION_OPEN_CLAIM_MAX_AGE_HOURS = 72;
export const CONSULTATION_ACTIVITY_LENS = "consultations";

/** Placement methods that would turn an organiser office into the affected area. */
export const CONSULTATION_HEADQUARTERS_METHODS = Object.freeze(new Set([
  "agency_hq",
  "headquarters",
  "organizer_headquarters",
  "organiser_headquarters",
  "organizer_address",
  "organiser_address",
  "hq_geocode",
]));

const DAY_MS = 86_400_000;

function day(value) {
  const match = String(value || "").match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function dateMs(value) {
  const parsed = Date.parse(`${day(value) || ""}T12:00:00Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

function unique(values) { return [...new Set((values || []).filter(Boolean).map(String))]; }

function geographyEvidence(record) {
  const geography = record?.geography || {};
  const place = record?.place || {};
  return {
    ...geography,
    ...place,
    labels: unique(geography.labels || place.labels || (record?.place && typeof record.place === "string" ? [record.place] : [])),
  };
}

function placementMethod(geography = {}) {
  return String(geography.method || geography.evidence || geography.placement_method || "").toLowerCase();
}

function isHeadquartersPlacement(geography = {}, record = {}) {
  const method = placementMethod(geography);
  if (CONSULTATION_HEADQUARTERS_METHODS.has(method)) return true;
  if (geography.headquarters === true || geography.organizer_headquarters === true) return true;
  const organizerAddress = String(record.organizer_address || record.organiser_address || geography.organizer_address || "").trim();
  if (!organizerAddress) return false;
  const labels = unique(geography.labels);
  return labels.some((label) => label.toLowerCase() === organizerAddress.toLowerCase());
}

/**
 * Return the public membership projection. Labels are retained as search
 * evidence; only explicit board identity or accepted address geocoding grants
 * district membership. Organiser headquarters never become the affected area.
 */
export function consultationPlace(record = {}) {
  const geography = geographyEvidence(record);
  const labels = geography.labels;
  const kind = String(geography.kind || geography.scope || "").toLowerCase();
  const evidence = String(geography.evidence || geography.method || "").toLowerCase();
  const method = placementMethod(geography);
  const citywide = kind === "citywide" || kind === "citywide_unlocated" || geography.citywide === true;
  const headquarters = isHeadquartersPlacement(geography, record);
  const exactBoard = !headquarters && (
    geography.community_district === "K14"
    || geography.board_id === "brooklyn-cb-14"
    || /(?:^|\b)cb\s*14(?:\b|$)/i.test(labels.join(" "))
  );
  const acceptedAddress = !headquarters && (
    evidence === "address_geocoding" || evidence === "accepted_address_geocoding"
  );
  const evidenceTier = classifyLocationEvidence({
    method: method || (exactBoard ? "community_board_ontology" : acceptedAddress ? "civic_address_pip" : null),
    confidence: geography.confidence,
    confidence_tier: geography.confidence_tier,
  });
  const exactPlaceAllowed = !headquarters && locationEvidenceAllowsExactPredicate({
    method: method || (exactBoard ? "community_board_ontology" : acceptedAddress ? "civic_address_pip" : ""),
    confidence: geography.confidence,
    confidence_tier: geography.confidence_tier || evidenceTier,
  });
  const communityDistricts = unique(geography.community_districts || geography.communityDistricts);
  const boroughs = unique(geography.boroughs || (geography.borough ? [geography.borough] : []));
  const councils = unique(geography.council_districts || geography.councilDistricts);
  if (exactBoard) communityDistricts.push("K14");
  const memberships = (!headquarters && exactPlaceAllowed && (acceptedAddress || exactBoard))
    ? unique(communityDistricts)
    : [];
  return {
    scope: citywide ? "citywide" : memberships.length || boroughs.length ? "local" : "unlocated",
    boroughs: citywide ? [] : boroughs,
    community_districts: citywide ? [] : memberships,
    council_districts: citywide ? [] : (acceptedAddress && exactPlaceAllowed ? unique(councils) : []),
    labels,
    evidence: geography.evidence || null,
    evidence_tier: evidenceTier,
    headquarters_rejected: headquarters,
    basis: citywide ? "Citywide" : memberships.length ? "Affected area" : labels.length ? "Search evidence only" : "No place signal",
    method: headquarters
      ? (method || "agency_hq")
      : geography.method || (exactBoard ? "community_board_ontology" : acceptedAddress ? "civic_address_pip" : citywide ? "citywide" : null),
  };
}

export function consultationMatchesScope(record, scope = {}) {
  const place = consultationPlace(record);
  const requested = scope.place || {};
  if (requested.location_scope && requested.location_scope !== place.scope) return false;
  if (requested.boroughs?.length && !requested.boroughs.some((value) => place.boroughs.includes(value))) return false;
  if (requested.community_districts?.length && !requested.community_districts.some((value) => place.community_districts.includes(value))) return false;
  if (requested.council_districts?.length && !requested.council_districts.some((value) => place.council_districts.includes(String(value)))) return false;
  const terms = scope.topic?.keywords?.length ? scope.topic.keywords : scope.topic?.query ? [scope.topic.query] : [];
  if (terms.length) {
    const haystack = [record.id, record.title, record.category, record.organizer, record.purpose, ...place.labels].filter(Boolean).join(" ").toLowerCase();
    if (!terms.every((term) => haystack.includes(String(term).toLowerCase()))) return false;
  }
  return true;
}

export function consultationDeadline(record, { asOf = new Date().toISOString(), horizonDays = CONSULTATION_NOW_HORIZON_DAYS, maxAgeHours = CONSULTATION_OPEN_CLAIM_MAX_AGE_HOURS } = {}) {
  const value = day(record?.deadline?.value);
  const today = day(asOf);
  const asOfMs = Date.parse(asOf);
  const deadlineMs = dateMs(value);
  const ageMs = record?.observed_at || record?.lifecycle?.observed_at
    ? asOfMs - Date.parse(record.observed_at || record.lifecycle.observed_at) : Infinity;
  const fresh = Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= maxAgeHours * 3_600_000;
  const supported = Boolean(value && today && deadlineMs != null && dateMs(today) != null
    && deadlineMs >= dateMs(today) && deadlineMs <= dateMs(today) + horizonDays * DAY_MS
    && record.deadline?.historical !== true && record.deadline?.verified !== false && fresh);
  return { value, precision: record?.deadline?.precision || "day", fresh, supported, expired: Boolean(value && value < today), days: value && today ? Math.round((deadlineMs - dateMs(today)) / DAY_MS) : null };
}

export function consultationNowItems(records = [], options = {}) {
  return records.map((record) => {
    const deadline = consultationDeadline(record, options);
    if (!deadline.supported) return null;
    const place = consultationPlace(record);
    return {
      id: `consultation:${record.id}`,
      kind: "comment",
      lane: "act_by",
      title: record.title || "Untitled consultation",
      agency: record.organizer || null,
      domain: "consultations",
      scope_domains: ["consultations"],
      route: `/consultations/${encodeURIComponent(record.id)}/`,
      action: { type: "comment", delivery: "internal", label: "Open consultation details", destination: `/consultations/${encodeURIComponent(record.id)}/` },
      time: { value: deadline.value, day: deadline.value, precision: deadline.precision, basis: "published_consultation_deadline", verified: true, source_field: "deadline.value" },
      place,
    };
  }).filter(Boolean);
}

/**
 * Project consultations into the district-activity / digest / Near You record
 * shape while retaining typed consultation references (never a fabricated
 * notice request_id).
 */
export function consultationConsumerRecords(records = []) {
  const out = {
    lens: CONSULTATION_ACTIVITY_LENS,
    records: {},
    by_community_district: {},
    citywide: [],
    unlocated: [],
  };
  for (const record of records) {
    if (!record?.id) continue;
    const place = consultationPlace(record);
    const id = String(record.id);
    const row = {
      id,
      title: record.title || null,
      route: `/consultations/${encodeURIComponent(id)}/`,
      date: day(record.deadline?.value) || day(record.observed_at) || null,
      agency: record.organizer || null,
      type: "Consultation",
      basis: place.basis,
      confidence: place.evidence_tier,
      basis_method: place.method,
      consultation_id: id,
      domain: CONSULTATION_ACTIVITY_LENS,
      place,
    };
    out.records[id] = row;
    if (place.scope === "citywide") {
      out.citywide.push(id);
      continue;
    }
    if (!place.community_districts.length) {
      out.unlocated.push(id);
      continue;
    }
    for (const district of place.community_districts) {
      (out.by_community_district[district] ||= []).push(id);
    }
  }
  for (const district of Object.keys(out.by_community_district)) {
    out.by_community_district[district] = unique(out.by_community_district[district]).sort();
  }
  out.citywide = unique(out.citywide).sort();
  out.unlocated = unique(out.unlocated).sort();
  return out;
}

/** Merge typed consultation records into a district-activity document copy. */
export function mergeConsultationActivity(activity = {}, records = []) {
  const contribution = consultationConsumerRecords(records);
  const next = structuredClone(activity || {});
  next.records = { ...(next.records || {}), [CONSULTATION_ACTIVITY_LENS]: { ...(next.records?.[CONSULTATION_ACTIVITY_LENS] || {}), ...contribution.records } };
  next.sources = {
    ...(next.sources || {}),
    [CONSULTATION_ACTIVITY_LENS]: {
      counted: Object.keys(contribution.records).length,
      ...(next.sources?.[CONSULTATION_ACTIVITY_LENS] || {}),
    },
  };
  next.district_items = next.district_items || { by_level: { community_district: {} } };
  next.district_items.by_level = next.district_items.by_level || {};
  next.district_items.by_level.community_district = next.district_items.by_level.community_district || {};
  for (const [district, ids] of Object.entries(contribution.by_community_district)) {
    const bucket = next.district_items.by_level.community_district[district] || {};
    bucket[CONSULTATION_ACTIVITY_LENS] = unique([...(bucket[CONSULTATION_ACTIVITY_LENS] || []), ...ids]).sort();
    next.district_items.by_level.community_district[district] = bucket;
  }
  next.district_items.citywide = {
    ...(next.district_items.citywide || {}),
    [CONSULTATION_ACTIVITY_LENS]: unique([
      ...(next.district_items.citywide?.[CONSULTATION_ACTIVITY_LENS] || []),
      ...contribution.citywide,
    ]).sort(),
  };
  next.district_items.unlocated = {
    ...(next.district_items.unlocated || {}),
    [CONSULTATION_ACTIVITY_LENS]: unique([
      ...(next.district_items.unlocated?.[CONSULTATION_ACTIVITY_LENS] || []),
      ...contribution.unlocated,
    ]).sort(),
  };
  if (next.district_items.corpora) {
    next.district_items.corpora[CONSULTATION_ACTIVITY_LENS] = {
      stamp_value: records[0]?.observed_at || next.built_at || null,
      ...(next.district_items.corpora[CONSULTATION_ACTIVITY_LENS] || {}),
    };
  }
  return next;
}
