/** Shared place and deadline projection for consultation consumers. */

export const CONSULTATION_NOW_HORIZON_DAYS = 30;
export const CONSULTATION_OPEN_CLAIM_MAX_AGE_HOURS = 72;
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

/**
 * Return the public membership projection. Labels are retained as search
 * evidence; only explicit board identity or accepted address geocoding grants
 * district membership.
 */
export function consultationPlace(record = {}) {
  const geography = geographyEvidence(record);
  const labels = geography.labels;
  const kind = String(geography.kind || geography.scope || "").toLowerCase();
  const evidence = String(geography.evidence || geography.method || "").toLowerCase();
  const citywide = kind === "citywide" || kind === "citywide_unlocated" || geography.citywide === true;
  const exactBoard = geography.community_district === "K14"
    || geography.board_id === "brooklyn-cb-14"
    || /(?:^|\b)cb\s*14(?:\b|$)/i.test(labels.join(" "));
  const acceptedAddress = evidence === "address_geocoding" || evidence === "accepted_address_geocoding";
  const communityDistricts = unique(geography.community_districts || geography.communityDistricts);
  const boroughs = unique(geography.boroughs || (geography.borough ? [geography.borough] : []));
  const councils = unique(geography.council_districts || geography.councilDistricts);
  if (exactBoard) communityDistricts.push("K14");
  const memberships = acceptedAddress || exactBoard ? unique(communityDistricts) : [];
  return {
    scope: citywide ? "citywide" : memberships.length || boroughs.length ? "local" : "unlocated",
    boroughs: citywide ? [] : boroughs,
    community_districts: citywide ? [] : memberships,
    council_districts: citywide ? [] : (acceptedAddress ? unique(councils) : []),
    labels,
    evidence: geography.evidence || null,
    basis: citywide ? "Citywide" : memberships.length ? "Affected area" : labels.length ? "Search evidence only" : "No place signal",
    method: geography.method || (exactBoard ? "community_board_ontology" : acceptedAddress ? "civic_address_pip" : citywide ? "citywide" : null),
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
