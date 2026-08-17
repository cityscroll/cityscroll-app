/**
 * Pure cross-family Search -> typed lens handoff contract.
 *
 * Topic/place/time remain ordinary scope-v0 route fields. The bounded
 * `search_handoff` value travels through scope-v0's established `facet`
 * envelope and carries navigation context only: it is not a civic assertion.
 */

import {
  EXAMS_SURFACE,
  PEOPLE_ORGANIZATIONS_SURFACE,
} from "./browse_surface_contracts.mjs";

export const SEARCH_LENS_HANDOFF_SCHEMA = "cityscroll.search_lens_handoff.v1";

const MAX_FACET_LENGTH = 2_000;
const CONTEXT_KEYS = Object.freeze([
  "boro",
  "cd",
  "council",
  "neighborhood",
  "scope",
  "when",
  "months",
]);

const DESTINATIONS = Object.freeze({
  contracts: Object.freeze({
    family: "contracts", surface: "money", route: "/browse/contracts/", label: "Contracts",
  }),
  "people-organizations": Object.freeze({
    family: "people-organizations", surface: PEOPLE_ORGANIZATIONS_SURFACE.surfaceId, route: PEOPLE_ORGANIZATIONS_SURFACE.canonicalRoute, label: PEOPLE_ORGANIZATIONS_SURFACE.label,
  }),
  zoning: Object.freeze({
    family: "land", surface: "land", route: "/browse/zoning/", label: "Land",
  }),
  property: Object.freeze({
    family: "land", surface: "property", route: "/browse/property/", label: "Property",
  }),
  rules: Object.freeze({
    family: "rules", surface: "rules", route: "/browse/rules/", label: "Rules",
  }),
  meetings: Object.freeze({
    family: "meetings", surface: "meetings", route: "/browse/meetings/", label: "Meetings",
  }),
  exams: Object.freeze({
    family: "exams", surface: EXAMS_SURFACE.surfaceId, route: EXAMS_SURFACE.canonicalRoute, label: EXAMS_SURFACE.label,
  }),
});

const OBJECT_DESTINATIONS = Object.freeze({
  person: DESTINATIONS["people-organizations"],
  official: DESTINATIONS["people-organizations"],
  agency: DESTINATIONS["people-organizations"],
  vendor: DESTINATIONS["people-organizations"],
  committee: DESTINATIONS["people-organizations"],
  community_board: DESTINATIONS["people-organizations"],
  land_use_project: DESTINATIONS.zoning,
  parcel: DESTINATIONS.property,
  civil_service_exam: DESTINATIONS.exams,
});

const DOMAIN_DESTINATIONS = Object.freeze({
  contracts: DESTINATIONS.contracts,
  people: DESTINATIONS["people-organizations"],
  places: DESTINATIONS["people-organizations"],
  zoning: DESTINATIONS.zoning,
  property: DESTINATIONS.property,
  rules: DESTINATIONS.rules,
  meetings: DESTINATIONS.meetings,
  staffing: DESTINATIONS.exams,
});

const PEOPLE_TYPES = Object.freeze({
  person: "official",
  official: "official",
  agency: "agency",
  vendor: "vendor",
  committee: "committee",
  community_board: "community-board",
});

const FALLBACK_COPY = Object.freeze({
  search_handoff_opened: "Opened {surface}",
  search_handoff_topic: "Topic: “{query}”",
  search_handoff_remove_topic: "Remove topic {query}",
  search_handoff_evidence: "Matched in {field}",
  search_handoff_evidence_unavailable: "Keyword evidence is unavailable for this source.",
  search_handoff_back: "Back to topic results",
});

function clean(value, max = 240) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function evidenceText(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 420);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function paramsFrom(value) {
  if (value instanceof URLSearchParams) return new URLSearchParams(value);
  const raw = String(value || "");
  if (/^https?:\/\//i.test(raw)) return new URL(raw).searchParams;
  const query = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : raw;
  return new URLSearchParams(query.split("#", 1)[0]);
}

function translated(t, key, values = {}) {
  let text = typeof t === "function" ? t(key, values) : FALLBACK_COPY[key];
  if (!text || text === key) text = FALLBACK_COPY[key] || key;
  return String(text).replace(/\{([a-z_]+)\}/g, (_match, name) => values[name] ?? "");
}

function destinationForResult(record = {}) {
  return DOMAIN_DESTINATIONS[clean(record.domain, 80)]
    || OBJECT_DESTINATIONS[clean(record.object_type, 80)]
    || null;
}

export function searchDestinationForResult(record = {}) {
  const destination = destinationForResult(record);
  return destination ? Object.freeze({ ...destination }) : null;
}

export function searchFamilyForResult(record = {}) {
  return destinationForResult(record)?.family || null;
}

function normalizedTerms(response = {}) {
  return Object.freeze([...(response?.resolved_term?.canonical_tokens || [])]
    .map((term) => clean(term, 80))
    .filter(Boolean)
    .slice(0, 8));
}

function carriedEvidence(record = {}) {
  const evidence = record?.match_evidence;
  const snippet = evidenceText(evidence?.snippet?.text);
  const markStart = Number(evidence?.snippet?.mark_start);
  const markEnd = Number(evidence?.snippet?.mark_end);
  if (
    snippet.trim()
    && Number.isInteger(markStart)
    && Number.isInteger(markEnd)
    && markStart >= 0
    && markEnd > markStart
    && markEnd <= snippet.length
  ) {
    return Object.freeze({
      status: "matched",
      field: clean(evidence.field, 80) || "record text",
      matched_normalized_term: clean(evidence.matched_normalized_term, 160),
      source_identifier: clean(evidence.source_identifier, 240) || null,
      snippet: Object.freeze({ text: snippet, mark_start: markStart, mark_end: markEnd }),
    });
  }
  return Object.freeze({ status: "unavailable" });
}

function contractIdentity(record = {}) {
  if (clean(record?.domain, 80) !== "contracts" || clean(record?.object_type, 80) !== "procurement") {
    return null;
  }
  const objectRef = clean(record?.object_ref, 320);
  if (!/^procurement:[A-Za-z0-9][A-Za-z0-9._/-]{4,159}$/.test(objectRef)) return null;
  const sourceObservationRef = (Array.isArray(record?.source_observation_refs)
    ? record.source_observation_refs : [])
    .map((ref) => clean(ref, 240))
    .find((ref) => /^(?:notice|ocp_award):[A-Za-z0-9_-]{1,80}$/.test(ref));
  if (!sourceObservationRef) return null;
  return Object.freeze({ object_ref: objectRef, source_observation_ref: sourceObservationRef });
}

function handoffEnvelope(record, response, destination, query) {
  return Object.freeze({
    schema: SEARCH_LENS_HANDOFF_SCHEMA,
    family: destination.family,
    destination: Object.freeze({
      surface: destination.surface,
      route: destination.route,
      label: destination.label,
    }),
    raw_query: query,
    normalized_terms: normalizedTerms(response),
    record_ref: clean(record?.object_ref, 240) || null,
    evidence: carriedEvidence(record),
  });
}

function destinationParams(record, response, sourceSearch, destination) {
  const source = paramsFrom(sourceSearch);
  const params = new URLSearchParams();
  const query = clean(response?.query || source.get("q"));
  if (query) params.set("q", query);
  for (const key of CONTEXT_KEYS) {
    const value = clean(source.get(key), 120);
    if (value) params.set(key, value);
  }
  const agency = clean(response?.resolved_term?.structured_filters?.agency, 160);
  const agencyId = clean(response?.resolved_term?.structured_filters?.agency_id, 120);
  const agencyRef = agencyId && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(agencyId)
    ? `agency:id:${agencyId}`
    : null;
  if (agency && !agencyRef) params.set("agency", agency);
  if (destination === DESTINATIONS["people-organizations"]) {
    const type = PEOPLE_TYPES[clean(record?.object_type, 80)];
    if (type) params.set("type", type);
  }
  const exactContract = destination === DESTINATIONS.contracts ? contractIdentity(record) : null;
  if (exactContract) params.set("mode", "archive");
  const facet = {
    ...(agencyRef ? { entity_refs_all: [agencyRef] } : {}),
    ...(exactContract ? { contract_identity: exactContract } : {}),
    search_handoff: handoffEnvelope(record, response, destination, query),
  };
  const encoded = JSON.stringify(facet);
  if (encoded.length >= MAX_FACET_LENGTH) {
    facet.search_handoff = Object.freeze({
      ...facet.search_handoff,
      evidence: Object.freeze({ status: "unavailable" }),
    });
  }
  const bounded = JSON.stringify(facet);
  if (bounded.length >= MAX_FACET_LENGTH) return null;
  params.set("facet", bounded);
  return params;
}

export function buildSearchLensHandoffHref(record = {}, response = {}, sourceSearch = "") {
  const destination = destinationForResult(record);
  if (!destination) return null;
  const params = destinationParams(record, response, sourceSearch, destination);
  if (!params) return null;
  return `${destination.route}?${params}`;
}

function parsedFacet(params) {
  const encoded = params.get("facet");
  if (!encoded || encoded.length >= MAX_FACET_LENGTH) return null;
  try {
    const facet = JSON.parse(encoded);
    const handoff = facet?.search_handoff;
    if (!handoff || handoff.schema !== SEARCH_LENS_HANDOFF_SCHEMA) return null;
    const destination = Object.values(DESTINATIONS).find((candidate) => (
      candidate.family === handoff.family
      && candidate.surface === handoff.destination?.surface
      && candidate.route === handoff.destination?.route
    ));
    if (!destination) return null;
    return { facet, handoff, destination };
  } catch {
    return null;
  }
}

function validateEvidence(evidence) {
  if (evidence?.status !== "matched") return Object.freeze({ status: "unavailable" });
  const snippet = evidenceText(evidence?.snippet?.text);
  const markStart = Number(evidence?.snippet?.mark_start);
  const markEnd = Number(evidence?.snippet?.mark_end);
  if (!snippet.trim() || !Number.isInteger(markStart) || !Number.isInteger(markEnd)
      || markStart < 0 || markEnd <= markStart || markEnd > snippet.length) {
    return Object.freeze({ status: "unavailable" });
  }
  return Object.freeze({
    status: "matched",
    field: clean(evidence.field, 80) || "record text",
    matched_normalized_term: clean(evidence.matched_normalized_term, 160),
    source_identifier: clean(evidence.source_identifier, 240) || null,
    snippet: Object.freeze({ text: snippet, mark_start: markStart, mark_end: markEnd }),
  });
}

export function parseSearchLensHandoff(search = "") {
  const params = paramsFrom(search);
  const parsed = parsedFacet(params);
  const rawQuery = clean(params.get("q"));
  if (!parsed || !rawQuery || clean(parsed.handoff.raw_query) !== rawQuery) return null;
  const normalized = [...(parsed.handoff.normalized_terms || [])]
    .map((term) => clean(term, 80)).filter(Boolean).slice(0, 8);
  if (!normalized.length) return null;
  return Object.freeze({
    schema: SEARCH_LENS_HANDOFF_SCHEMA,
    family: parsed.destination.family,
    destination: Object.freeze({
      surface: parsed.destination.surface,
      route: parsed.destination.route,
      label: parsed.destination.label,
    }),
    raw_query: rawQuery,
    normalized_terms: Object.freeze(normalized),
    record_ref: clean(parsed.handoff.record_ref, 240) || null,
    evidence: validateEvidence(parsed.handoff.evidence),
    params: new URLSearchParams(params),
    facet: parsed.facet,
  });
}

export function retainSearchHandoffForQuery(values = {}, query = "") {
  const next = values && typeof values === "object" && !Array.isArray(values) ? { ...values } : {};
  if (clean(next.search_handoff?.raw_query) !== clean(query)) {
    delete next.search_handoff;
    delete next.contract_identity;
  }
  return next;
}

export function searchReturnHref(handoff) {
  if (!handoff) return "/search/";
  const params = new URLSearchParams();
  params.set("q", handoff.raw_query);
  for (const key of CONTEXT_KEYS) {
    const value = clean(handoff.params?.get(key), 120);
    if (value) params.set(key, value);
  }
  return `/search/?${params}#search-lane-${encodeURIComponent(handoff.family)}`;
}

export function removeSearchTopicHref(handoff) {
  if (!handoff) return "/browse/";
  const params = new URLSearchParams(handoff.params);
  params.delete("q");
  const facet = { ...(handoff.facet || {}) };
  delete facet.search_handoff;
  if (Object.keys(facet).length) params.set("facet", JSON.stringify(facet));
  else params.delete("facet");
  return `${handoff.destination.route}${params.size ? `?${params}` : ""}`;
}

function evidenceHtml(evidence, t) {
  if (evidence?.status !== "matched") {
    return `<p class="search-handoff-evidence is-unavailable">${escapeHtml(translated(t, "search_handoff_evidence_unavailable"))}</p>`;
  }
  const { text, mark_start: start, mark_end: end } = evidence.snippet;
  const snippet = `${escapeHtml(text.slice(0, start))}<mark>${escapeHtml(text.slice(start, end))}</mark>${escapeHtml(text.slice(end))}`;
  const source = evidence.source_identifier
    ? ` data-source-observation-ref="${escapeHtml(evidence.source_identifier)}"`
    : "";
  return `<p class="search-handoff-evidence"${source}><span>${escapeHtml(translated(t, "search_handoff_evidence", { field: evidence.field }))}</span><span>${snippet}</span></p>`;
}

export function renderSearchLensHandoffHtml(handoff, { t } = {}) {
  if (!handoff) return "";
  const normalized = handoff.normalized_terms.join(" ");
  const opened = translated(t, "search_handoff_opened", { surface: handoff.destination.label });
  const topic = translated(t, "search_handoff_topic", { query: handoff.raw_query });
  const removeLabel = translated(t, "search_handoff_remove_topic", { query: handoff.raw_query });
  return `<aside class="search-handoff" data-search-handoff-destination data-search-family="${escapeHtml(handoff.family)}" data-normalized-terms="${escapeHtml(normalized)}" data-record-ref="${escapeHtml(handoff.record_ref || "")}" aria-labelledby="search-handoff-heading">
    <p class="search-handoff-kicker" id="search-handoff-heading" role="status">${escapeHtml(opened)}</p>
    <a class="qchip search-handoff-topic" data-search-topic-chip href="${escapeHtml(removeSearchTopicHref(handoff))}" aria-label="${escapeHtml(removeLabel)}">${escapeHtml(topic)} <span aria-hidden="true">×</span></a>
    ${evidenceHtml(handoff.evidence, t)}
    <p class="search-handoff-back"><a href="${escapeHtml(searchReturnHref(handoff))}">${escapeHtml(translated(t, "search_handoff_back"))}</a></p>
  </aside>`;
}
