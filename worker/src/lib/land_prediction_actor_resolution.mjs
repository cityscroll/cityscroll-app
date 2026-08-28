// Historical Council actor resolution for Land-Use Prediction v2.
//
// This is a pure, precompute-friendly join:
// application -> location -> Council district vintage -> officeholder term.
// It intentionally consumes term history, never a person's current_term or
// current district. A missing or conflicting historical fact stays unknown.

import {
  normalizeCouncilDistrictId,
  resolveCouncilDistrict,
} from "../../../site/council_district_lookup.mjs";
import { officialEntityId } from "../../../entity_resolution/officials/index.mjs";
import { buildPersonHubLookup } from "../../../site/person_hub.mjs";

export const LAND_PREDICTION_ACTOR_RESOLUTION_SCHEMA =
  "cityscroll.land_prediction_actor_resolution.v1";
export const LAND_PREDICTION_ACTOR_RESOLUTION_VERSION = 1;
export const HISTORICAL_RESOLUTION_STATES = Object.freeze([
  "resolved",
  "unknown",
  "vacant",
]);
export const DISTRICT_RESOLUTION_STATES = Object.freeze(["resolved", "unknown"]);

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function clean(value, max = 500) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function requiredText(value, label) {
  const text = clean(value);
  if (!text) throw new TypeError(`${label} is required`);
  return text;
}

function instant(value, label, { required = false } = {}) {
  if (value === null || value === undefined || value === "") {
    if (required) throw new TypeError(`${label} is required`);
    return null;
  }
  const text = clean(value, 80);
  if (!text || !Number.isFinite(Date.parse(text))) {
    throw new TypeError(`${label} must be an ISO timestamp`);
  }
  return new Date(text).toISOString();
}

function dateBoundary(value, label) {
  const text = clean(value, 80);
  if (!text || !Number.isFinite(Date.parse(text))) {
    throw new TypeError(`${label} must be an ISO date or timestamp`);
  }
  return DAY_RE.test(text) ? text : new Date(text).toISOString().slice(0, 10);
}

function time(value) {
  return Date.parse(value);
}

function jsonValue(value, seen = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((item) => jsonValue(item, seen));
  return Object.values(value).every((item) => jsonValue(item, seen));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

function source(value, label) {
  if (value === null || value === undefined || value === "") return null;
  if ((typeof value !== "string" && (typeof value !== "object" || Array.isArray(value)))
      || (typeof value === "string" && !clean(value))
      || !jsonValue(value)) {
    throw new TypeError(`${label} must be a non-empty string or JSON object`);
  }
  return canonicalJson(value);
}

function first(...values) {
  return values.find((value) => value !== null && value !== undefined && value !== "");
}

function hasCoordinates(location) {
  const latitude = Number(first(location.latitude, location.lat));
  const longitude = Number(first(location.longitude, location.lon, location.lng));
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
}

function coordinates(location) {
  if (hasCoordinates(location)) {
    return {
      latitude: Number(first(location.latitude, location.lat)),
      longitude: Number(first(location.longitude, location.lon, location.lng)),
    };
  }
  const coordinatesValue = location.coordinates;
  if (Array.isArray(coordinatesValue) && coordinatesValue.length >= 2) {
    const longitude = Number(coordinatesValue[0]);
    const latitude = Number(coordinatesValue[1]);
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) return { latitude, longitude };
  }
  return null;
}

function locationSource(location) {
  return source(
    first(location.source, location.provenance?.source, location.source_record),
    "location.source",
  );
}

function locationObservedAt(location) {
  return instant(first(
    location.observed_at,
    location.provenance?.observed_at,
  ), "location.observed_at");
}

function locationEffectiveAt(location) {
  return instant(first(
    location.effective_at,
    location.provenance?.effective_at,
  ), "location.effective_at");
}

function boundarySource(entry) {
  const layer = entry.layer || {};
  const councilSource = layer.sources?.council_district || {};
  return source(first(
    entry.source,
    layer.source,
    councilSource,
    layer.source_url && { source_url: layer.source_url },
    layer.dataset_id && { dataset_id: layer.dataset_id },
  ), "boundary source");
}

function normalizeBoundaryEntry(raw, index) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError(`boundary[${index}] must be an object`);
  }
  const layer = raw.layer || raw.boundaries || raw;
  if (!layer || typeof layer !== "object") throw new TypeError(`boundary[${index}].layer is required`);
  const vintage = clean(first(
    raw.vintage,
    raw.boundary_vintage,
    layer.boundary_vintage,
    layer.vintage?.id,
    layer.vintage,
  ), 160) || null;
  const effectiveAt = instant(first(
    raw.effective_at,
    raw.effective_from,
    raw.valid_from,
    layer.effective_at,
    layer.effective_from,
    layer.valid_from,
    layer.vintage?.effective_at,
  ), `boundary[${index}].effective_at`);
  const effectiveUntil = instant(first(
    raw.effective_until,
    raw.effective_to,
    raw.valid_until,
    layer.effective_until,
    layer.effective_to,
    layer.valid_until,
  ), `boundary[${index}].effective_until`);
  const observedAt = instant(first(
    raw.observed_at,
    raw.source_updated_at,
    layer.observed_at,
    layer.source_updated_at,
    layer.sources?.council_district?.source_updated_at,
  ), `boundary[${index}].observed_at`);
  return {
    layer,
    vintage,
    effective_at: effectiveAt,
    effective_until: effectiveUntil,
    observed_at: observedAt,
    source: boundarySource({ ...raw, layer }),
  };
}

function boundaryEntries(options) {
  const candidates = first(
    options.boundaries,
    options.boundary_layers,
    options.boundaryLayers,
  );
  if (Array.isArray(candidates)) return candidates.map(normalizeBoundaryEntry);
  const single = first(
    options.boundary,
    options.boundary_layer,
    options.boundaryLayer,
    candidates,
  );
  return single ? [normalizeBoundaryEntry(single, 0)] : [];
}

function boundaryIsValidAt(entry, cutoff) {
  // A vintage label is not a validity interval. Requiring an explicit
  // effective_from keeps a present-day boundary from being projected into
  // an earlier application merely because it has a date-like label.
  if (!entry.effective_at || time(entry.effective_at) > time(cutoff)) return false;
  // Validity windows are [effective_at, effective_until), so a boundary
  // change at midnight cannot leave both vintages active at the transition.
  if (entry.effective_until && time(entry.effective_until) <= time(cutoff)) return false;
  if (entry.observed_at && time(entry.observed_at) > time(cutoff)) return false;
  return Boolean(entry.source);
}

function districtFromLocation(location, entry) {
  const point = coordinates(location);
  if (point) return normalizeCouncilDistrictId(resolveCouncilDistrict(
    point.latitude,
    point.longitude,
    entry.layer,
  ));
  const explicit = normalizeCouncilDistrictId(first(
    location.council_district,
    location.councilDistrict,
    location.district,
  ));
  if (!explicit) return null;
  // A publisher-supplied district is usable without coordinates only when
  // the location observation itself carries source and temporal evidence.
  return locationSource(location) && (locationObservedAt(location) || locationEffectiveAt(location))
    ? explicit
    : null;
}

function unknownDistrict(reason, extra = {}) {
  return {
    resolution: "unknown",
    district_id: null,
    boundary_vintage: null,
    observed_at: null,
    effective_at: null,
    source: null,
    reason,
    ...extra,
  };
}

function resolveDistrict(location, entries, cutoff) {
  const validEntries = entries.filter((entry) => boundaryIsValidAt(entry, cutoff));
  if (!validEntries.length) {
    return unknownDistrict(entries.length ? "no_boundary_vintage_at_cutoff" : "boundary_data_unavailable");
  }
  const matches = validEntries.map((entry) => ({
    entry,
    district_id: districtFromLocation(location, entry),
  })).filter((match) => match.district_id);
  if (!matches.length) return unknownDistrict("location_not_resolved_in_boundary_vintage");
  const districtIds = [...new Set(matches.map((match) => match.district_id))];
  if (districtIds.length !== 1) {
    return unknownDistrict("conflicting_boundary_vintages_at_cutoff", {
      candidate_district_ids: districtIds.sort(),
      candidate_boundary_vintages: matches.map(({ entry }) => entry.vintage).filter(Boolean).sort(),
    });
  }
  // Multiple vintages agreeing on the same district are safe to retain as
  // supporting evidence. The newest effective source is the representative.
  const selected = [...matches].sort((left, right) =>
    time(right.entry.effective_at) - time(left.entry.effective_at)
    || String(right.entry.vintage || "").localeCompare(String(left.entry.vintage || "")),
  )[0].entry;
  return {
    resolution: "resolved",
    district_id: districtIds[0],
    boundary_vintage: selected.vintage,
    observed_at: selected.observed_at,
    effective_at: selected.effective_at,
    source: selected.source,
    reason: null,
    supporting_boundary_vintages: matches.map(({ entry }) => entry.vintage).filter(Boolean).sort(),
  };
}

function personRows(personHub, options) {
  if (Array.isArray(options.member_terms)) return options.member_terms;
  if (Array.isArray(options.memberTerms)) return options.memberTerms;
  if (Array.isArray(options.officeholders)) return options.officeholders;
  if (Array.isArray(personHub)) return personHub;
  if (Array.isArray(personHub?.rows)) return personHub.rows;
  return null;
}

function normalizeHub(personHub, options) {
  const rows = personRows(personHub, options);
  if (rows) return buildPersonHubLookup(rows, { retrievedAt: null });
  if (personHub?.by_person_id && typeof personHub.by_person_id === "object") return personHub;
  if (options.person_hub?.by_person_id) return options.person_hub;
  if (options.personHub?.by_person_id) return options.personHub;
  return null;
}

function termsForDistrict(hub, districtId, cutoff) {
  const terms = [];
  for (const person of Object.values(hub?.by_person_id || {})) {
    const personId = clean(person.person_id || person.council_member_id);
    const officialId = clean(person.official_id) || officialEntityId({ personId });
    if (!personId || !officialId || !officialId.startsWith("official:")) continue;
    for (const rawTerm of Array.isArray(person.terms) ? person.terms : []) {
      const district = normalizeCouncilDistrictId(rawTerm.district);
      const start = rawTerm.term_start ? dateBoundary(rawTerm.term_start, "term_start") : null;
      const end = rawTerm.term_end ? dateBoundary(rawTerm.term_end, "term_end") : null;
      if (district !== districtId || !start || !end) continue;
      if (start > cutoff.slice(0, 10) || end < cutoff.slice(0, 10)) continue;
      const observedAt = instant(rawTerm.observed_at, "term.observed_at");
      if (observedAt && time(observedAt) > time(cutoff)) continue;
      terms.push({
        person_id: personId,
        actor_id: officialId,
        person_name: clean(rawTerm.name || person.person_name) || null,
        district,
        term_start: start,
        term_end: end,
        office_id: clean(rawTerm.office_id) || null,
        observed_at: observedAt,
        source: source(rawTerm.source, "term.source") || source({
          source_contract: hub.source_contract || "person_hub",
          source_record_id: `${personId}:${rawTerm.office_id || `${start}:${end}`}`,
          method: "exact_council_member_id_term",
        }, "term source"),
      });
    }
  }
  const unique = new Map();
  for (const term of terms) {
    const key = [term.actor_id, term.term_start, term.term_end, term.office_id].join("\u0000");
    unique.set(key, term);
  }
  return [...unique.values()].sort((left, right) =>
    left.actor_id.localeCompare(right.actor_id)
    || left.term_start.localeCompare(right.term_start)
    || left.term_end.localeCompare(right.term_end),
  );
}

function vacancyRecords(options) {
  const records = first(options.vacancies, options.vacancy_records, options.vacancyRecords);
  return Array.isArray(records) ? records : [];
}

function vacancyAt(records, districtId, cutoff) {
  return records.filter((record) => {
    const district = normalizeCouncilDistrictId(first(record.district, record.council_district));
    if (district !== districtId) return false;
    const start = instant(first(record.effective_at, record.start_at, record.start), "vacancy start", { required: true });
    const end = instant(first(record.effective_until, record.end_at, record.end), "vacancy end");
    const observedAt = instant(record.observed_at, "vacancy.observed_at");
    return time(start) <= time(cutoff)
      && (!end || time(end) >= time(cutoff))
      && (!observedAt || time(observedAt) <= time(cutoff));
  });
}

function resolveOfficeholder(district, cutoff, hub, options) {
  if (district.resolution !== "resolved") {
    return {
      resolution: "unknown",
      actor_id: null,
      person_id: null,
      person_name: null,
      district_id: null,
      term_start: null,
      term_end: null,
      observed_at: null,
      effective_at: null,
      source: null,
      reason: "district_unresolved",
    };
  }
  if (!hub) {
    return {
      resolution: "unknown",
      actor_id: null,
      person_id: null,
      person_name: null,
      district_id: district.district_id,
      term_start: null,
      term_end: null,
      observed_at: null,
      effective_at: null,
      source: null,
      reason: "officeholder_data_unavailable",
    };
  }
  const terms = termsForDistrict(hub, district.district_id, cutoff);
  const vacancies = vacancyAt(vacancyRecords(options), district.district_id, cutoff);
  if (vacancies.length > 1) {
    return {
      resolution: "unknown",
      actor_id: null,
      person_id: null,
      person_name: null,
      district_id: district.district_id,
      term_start: null,
      term_end: null,
      observed_at: null,
      effective_at: null,
      source: null,
      reason: "conflicting_vacancy_records",
    };
  }
  const identities = [...new Set(terms.map((term) => term.actor_id))];
  if (identities.length > 1) {
    return {
      resolution: "unknown",
      actor_id: null,
      person_id: null,
      person_name: null,
      district_id: district.district_id,
      term_start: null,
      term_end: null,
      observed_at: null,
      effective_at: null,
      source: null,
      reason: "multiple_officeholders_at_cutoff",
      candidate_actor_ids: identities.sort(),
    };
  }
  if (terms.length === 1) {
    if (vacancies.length === 1) {
      return {
        resolution: "unknown",
        actor_id: null,
        person_id: null,
        person_name: null,
        district_id: district.district_id,
        term_start: null,
        term_end: null,
        observed_at: null,
        effective_at: null,
        source: null,
        reason: "term_and_vacancy_conflict",
      };
    }
    const term = terms[0];
    return {
      resolution: "resolved",
      actor_id: term.actor_id,
      person_id: term.person_id,
      person_name: term.person_name,
      district_id: term.district,
      term_start: term.term_start,
      term_end: term.term_end,
      observed_at: term.observed_at,
      effective_at: `${term.term_start}T00:00:00.000Z`,
      source: term.source,
      reason: null,
    };
  }
  if (vacancies.length === 1) {
    const vacancy = vacancies[0];
    const vacancySource = source(vacancy.source, "vacancy.source");
    if (vacancySource) {
      return {
        resolution: "vacant",
        actor_id: null,
        person_id: null,
        person_name: null,
        district_id: district.district_id,
        term_start: null,
        term_end: null,
        observed_at: instant(vacancy.observed_at, "vacancy.observed_at"),
        effective_at: instant(first(vacancy.effective_at, vacancy.start_at, vacancy.start), "vacancy start", { required: true }),
        source: vacancySource,
        reason: null,
      };
    }
  }
  return {
    resolution: "unknown",
    actor_id: null,
    person_id: null,
    person_name: null,
    district_id: district.district_id,
    term_start: null,
    term_end: null,
    observed_at: null,
    effective_at: null,
    source: null,
    reason: vacancies.length > 1 ? "conflicting_vacancy_records" : "no_term_at_cutoff",
  };
}

function applicationLocations(application, options) {
  const locations = first(
    options.locations,
    application.locations,
    application.geographies,
  );
  if (Array.isArray(locations)) return locations;
  const singular = first(options.location, application.location);
  if (singular && typeof singular === "object") return [singular];
  // An explicit array of geography keys is still preserved as unresolved
  // locations; no address or district is fabricated from a label.
  const keys = first(application.location_keys, application.geography_keys);
  return Array.isArray(keys) ? keys.map((key) => ({ location_id: key })) : [];
}

function locationId(location, index) {
  return clean(first(
    location.location_id,
    location.id,
    location.source_record_id,
    location.bbl,
    location.address,
  ), 240) || `location-${index + 1}`;
}

function provenance(stage, resolution, value) {
  return {
    stage,
    resolution,
    source: value?.source || null,
    observed_at: value?.observed_at || null,
    effective_at: value?.effective_at || null,
  };
}

function snapshotActor(location, officeholder, multipleLocations) {
  return {
    role: multipleLocations ? `local_council_member:${location.location_id}` : "local_council_member",
    actor_id: officeholder.actor_id,
    resolution: officeholder.resolution,
    as_of: location.prediction_as_of,
    observed_at: officeholder.observed_at,
    effective_at: officeholder.effective_at,
    source: officeholder.source,
  };
}

/**
 * Resolve one application against supplied historical boundary and term
 * snapshots. All source snapshots are caller-supplied so this function is
 * deterministic and does not perform request-time reads.
 */
export function resolveLandUseApplicationActors(input = {}, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("application must be an object");
  }
  const applicationId = requiredText(first(
    input.application_id,
    input.applicationId,
    input.project_id,
    options.application_id,
  ), "application_id");
  const predictionAsOf = instant(first(
    options.prediction_as_of,
    options.predictionAsOf,
    input.prediction_as_of,
    input.predictionAsOf,
  ), "prediction_as_of", { required: true });
  const entries = boundaryEntries(options);
  const hub = normalizeHub(first(options.person_hub, options.personHub, options.officials), options);
  const locations = applicationLocations(input, options);
  const locationsToResolve = locations.length ? locations : [{}];
  const resolvedLocations = locationsToResolve.map((rawLocation, index) => {
    const location = rawLocation && typeof rawLocation === "object" && !Array.isArray(rawLocation)
      ? rawLocation
      : { location_id: rawLocation };
    const id = locationId(location, index);
    const locationObserved = locationObservedAt(location);
    const locationEffective = locationEffectiveAt(location);
    const locationInScope = (!locationObserved || time(locationObserved) <= time(predictionAsOf))
      && (!locationEffective || time(locationEffective) <= time(predictionAsOf));
    const district = locationInScope
      ? resolveDistrict(location, entries, predictionAsOf)
      : unknownDistrict("location_observed_after_cutoff");
    const officeholder = resolveOfficeholder(district, predictionAsOf, hub, options);
    const result = {
      location_id: id,
      prediction_as_of: predictionAsOf,
      district,
      officeholder,
      provenance: [
        provenance("location", locationInScope ? "resolved" : "unknown", {
          source: locationSource(location),
          observed_at: locationObserved,
          effective_at: locationEffective,
        }),
        provenance("council_district", district.resolution, district),
        provenance("officeholder", officeholder.resolution, officeholder),
      ],
    };
    return result;
  });
  const districtIds = [...new Set(
    resolvedLocations.map((location) => location.district.district_id).filter(Boolean),
  )].sort((left, right) => Number(left) - Number(right));
  const officeholders = resolvedLocations
    .map((location) => location.officeholder)
    .filter((actor) => actor.resolution === "resolved")
    .filter((actor, index, list) => list.findIndex((candidate) => candidate.actor_id === actor.actor_id) === index)
    .sort((left, right) => left.actor_id.localeCompare(right.actor_id));
  const complete = resolvedLocations.length > 0
    && resolvedLocations.every((location) =>
      location.district.resolution === "resolved"
      && ["resolved", "vacant"].includes(location.officeholder.resolution));
  return {
    schema_version: LAND_PREDICTION_ACTOR_RESOLUTION_VERSION,
    schema: LAND_PREDICTION_ACTOR_RESOLUTION_SCHEMA,
    application_id: applicationId,
    prediction_as_of: predictionAsOf,
    resolution: complete ? "resolved" : "unknown",
    council_district_ids: districtIds,
    locations: resolvedLocations,
    officeholders,
    historical_actors: resolvedLocations.map((location) => snapshotActor(
      { location_id: location.location_id, prediction_as_of: predictionAsOf },
      location.officeholder,
      resolvedLocations.length > 1,
    )),
    provenance: {
      method: "application_location_historical_council_term_join_v1",
      boundary_vintage_count_at_cutoff: entries.filter((entry) => boundaryIsValidAt(entry, predictionAsOf)).length,
      person_source_contract: hub?.source_contract || null,
      current_officeholder_fallback: false,
    },
  };
}

/** Resolve the officeholder for a known historical district. */
export function resolveHistoricalCouncilMemberAt({
  district,
  predictionAsOf,
  prediction_as_of,
  personHub = null,
  person_hub = null,
  memberTerms = null,
  vacancies = [],
} = {}) {
  const cutoff = instant(first(predictionAsOf, prediction_as_of), "prediction_as_of", { required: true });
  const districtId = normalizeCouncilDistrictId(district);
  if (!districtId) {
    return {
      resolution: "unknown",
      actor_id: null,
      person_id: null,
      person_name: null,
      district_id: null,
      term_start: null,
      term_end: null,
      observed_at: null,
      effective_at: null,
      source: null,
      reason: "district_invalid_or_missing",
    };
  }
  const options = { member_terms: memberTerms, vacancies };
  const hub = normalizeHub(first(personHub, person_hub), options);
  return resolveOfficeholder({ resolution: "resolved", district_id: districtId }, cutoff, hub, options);
}

/** Adapter for the c2 snapshot callback; it receives the c2 `as_of` cutoff. */
export function historicalCouncilActorResolver(options = {}) {
  return (request = {}) => {
    const resolution = resolveHistoricalCouncilMemberAt({
      district: first(request.council_district, request.district, request.district_id),
      predictionAsOf: request.as_of,
      personHub: options.personHub || options.person_hub,
      memberTerms: options.memberTerms || options.member_terms,
      vacancies: options.vacancies || [],
    });
    return resolution;
  };
}

export const buildHistoricalCouncilResolution = resolveLandUseApplicationActors;
