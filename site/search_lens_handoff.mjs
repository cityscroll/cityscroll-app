import {
  routeHashFromScope,
  scopeFromLensState,
} from "./scope_v0.mjs";

export const SEARCH_LENS_HANDOFF_SCHEMA = "cityscroll.search_lens_handoff.v1";

const SEARCH_HANDOFF_FAMILY_CONFIG = Object.freeze({
  contracts: Object.freeze({ surface: "money", label: "Contracts", route: "/browse/contracts/" }),
  "people-organizations": Object.freeze({ surface: "people", label: "People + organizations", state: { mode: "person" }, route: "/browse/staffing/" }),
  land: Object.freeze({ surface: "land", label: "Land", state: { status: "all" }, route: "/browse/zoning/" }),
  rules: Object.freeze({ surface: "rules", label: "Rules", route: "/browse/rules/" }),
  meetings: Object.freeze({ surface: "meetings", label: "Meetings", route: "/browse/meetings/" }),
  exams: Object.freeze({ surface: "people", label: "Exams", state: { view: "guide" }, route: "/browse/exams/" }),
});

const SEARCH_HANDOFF_CARRIED_KEYS = Object.freeze([
  "boro",
  "cd",
  "council",
  "neighborhood",
  "scope",
  "when",
  "months",
  "lang",
]);

function cleanSearchHandoffValue(value, max = 240) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function cleanSearchHandoffList(values, max = 8) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => cleanSearchHandoffValue(value, 120))
    .filter(Boolean))]
    .slice(0, max);
}

function searchHandoffSourceUrl(value) {
  try {
    return value instanceof URL
      ? new URL(value.toString())
      : new URL(String(value || "/search/"), "https://cityscroll.org");
  } catch {
    return new URL("https://cityscroll.org/search/");
  }
}

function searchHandoffPlace(params) {
  const place = {};
  for (const [key, output, max] of [
    ["boro", "borough", 40],
    ["cd", "community_district", 8],
    ["council", "council_district", 4],
    ["neighborhood", "neighborhood", 80],
    ["scope", "location_scope", 40],
  ]) {
    const value = cleanSearchHandoffValue(params.get(key), max);
    if (value) place[output] = value;
  }
  return Object.freeze(place);
}

function searchHandoffTime(params, familyId) {
  const time = {};
  const when = cleanSearchHandoffValue(params.get("when"), 40) || (familyId === "meetings" ? "all" : "");
  const months = Number(params.get("months"));
  if (when) time.when = when;
  if (Number.isFinite(months) && months > 0 && months <= 60) time.months = Math.round(months);
  return Object.freeze(time);
}

function validSearchHandoffEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snippetText = cleanSearchHandoffValue(value.snippet?.text, 400);
  const markStart = Number(value.snippet?.mark_start);
  const markEnd = Number(value.snippet?.mark_end);
  if (!snippetText || !Number.isInteger(markStart) || !Number.isInteger(markEnd)
    || markStart < 0 || markEnd <= markStart || markEnd > snippetText.length) return null;
  const sourceIdentifier = cleanSearchHandoffValue(value.source_identifier, 240);
  return Object.freeze({
    field: cleanSearchHandoffValue(value.field, 40),
    matched_normalized_term: cleanSearchHandoffValue(value.matched_normalized_term, 240),
    source_identifier: sourceIdentifier || null,
    snippet: Object.freeze({
      text: snippetText,
      mark_start: markStart,
      mark_end: markEnd,
    }),
  });
}

function searchHandoffFamilyLane(payload, familyId) {
  return (Array.isArray(payload?.lanes) ? payload.lanes : []).find((lane) => lane?.id === familyId) || null;
}

function representativeSearchHandoffEvidence(lane) {
  for (const card of Array.isArray(lane?.cards) ? lane.cards : []) {
    const evidence = validSearchHandoffEvidence(card?.match_evidence);
    if (evidence) return { evidence, objectRef: cleanSearchHandoffValue(card?.object_ref, 240) || null };
  }
  return { evidence: null, objectRef: null };
}

function searchHandoffFamilyState(config, rawQuery, normalizedTerms, place, time, handoff = null) {
  return {
    ...config.state,
    q: rawQuery,
    keywords: normalizedTerms,
    boro: place.borough,
    cd: place.community_district,
    council: place.council_district,
    neighborhood: place.neighborhood,
    locationScope: place.location_scope,
    when: time.when,
    months: time.months,
    ...(handoff ? { search_handoff: handoff } : {}),
  };
}

function searchHandoffDocumentHref(config, state) {
  const scope = scopeFromLensState(config.surface, state);
  const hash = routeHashFromScope(scope, { surface: config.surface });
  const queryAt = hash.indexOf("?");
  return `${config.route}${queryAt < 0 ? "" : hash.slice(queryAt)}`;
}

function searchHandoffReturnHref(url, familyId, rawQuery) {
  const params = new URLSearchParams();
  if (rawQuery) params.set("q", rawQuery);
  for (const key of SEARCH_HANDOFF_CARRIED_KEYS) {
    const value = cleanSearchHandoffValue(url.searchParams.get(key), key === "neighborhood" ? 80 : 40);
    if (value) params.set(key, value);
  }
  params.set("lane", familyId);
  return `/search/?${params}`;
}

function searchHandoffTransportContract(familyId, config, payload, url, rawQuery, normalizedTerms, place, time, removeTopicHref) {
  const lane = searchHandoffFamilyLane(payload, familyId);
  const { evidence, objectRef } = representativeSearchHandoffEvidence(lane);
  return Object.freeze({
    schema: SEARCH_LENS_HANDOFF_SCHEMA,
    family_id: familyId,
    surface: config.surface,
    lens_label: config.label,
    raw_query: rawQuery,
    normalized_terms: Object.freeze(normalizedTerms),
    place,
    time,
    back_href: searchHandoffReturnHref(url, familyId, rawQuery),
    remove_topic_href: removeTopicHref,
    evidence,
    edge_provenance: Object.freeze({
      relation: "search_result_handoff",
      lane_source: cleanSearchHandoffValue(lane?.source, 240) || null,
      lane_as_of: cleanSearchHandoffValue(lane?.as_of, 160) || null,
      source_observation_ref: evidence?.source_identifier || null,
      object_ref: objectRef,
    }),
  });
}

export function buildSearchLensHandoff(familyId, payload = {}, source = "/search/") {
  const config = SEARCH_HANDOFF_FAMILY_CONFIG[familyId];
  if (!config) return null;
  const url = searchHandoffSourceUrl(source);
  const rawQuery = cleanSearchHandoffValue(url.searchParams.get("q") || payload?.query);
  if (!rawQuery) return null;
  const normalizedTerms = cleanSearchHandoffList(payload?.resolved_term?.canonical_tokens);
  const place = searchHandoffPlace(url.searchParams);
  const time = searchHandoffTime(url.searchParams, familyId);
  const removeTopicHref = searchHandoffDocumentHref(
    config,
    searchHandoffFamilyState(config, "", [], place, time),
  );
  const contract = searchHandoffTransportContract(
    familyId,
    config,
    payload,
    url,
    rawQuery,
    normalizedTerms,
    place,
    time,
    removeTopicHref,
  );
  const href = searchHandoffDocumentHref(
    config,
    searchHandoffFamilyState(config, rawQuery, normalizedTerms, place, time, contract),
  );
  return Object.freeze({ ...contract, href, remove_topic_href: removeTopicHref });
}

function searchHandoffFacetValues(input) {
  if (input && typeof input.get === "function") {
    const raw = input.get("facet");
    if (!raw || raw.length > 2_000) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return input && typeof input === "object" && !Array.isArray(input) ? input : null;
}

export function parseSearchLensHandoff(input, { surface = null } = {}) {
  const candidate = searchHandoffFacetValues(input)?.search_handoff;
  if (!candidate || candidate.schema !== SEARCH_LENS_HANDOFF_SCHEMA) return null;
  const config = SEARCH_HANDOFF_FAMILY_CONFIG[candidate.family_id];
  if (!config || candidate.surface !== config.surface || (surface && surface !== config.surface)) return null;
  const rawQuery = cleanSearchHandoffValue(candidate.raw_query);
  const backHref = cleanSearchHandoffValue(candidate.back_href, 1_000);
  if (!rawQuery || !backHref.startsWith("/search/?")) return null;
  const place = candidate.place && typeof candidate.place === "object" && !Array.isArray(candidate.place)
    ? searchHandoffPlace(new URLSearchParams({
      boro: candidate.place.borough || "",
      cd: candidate.place.community_district || "",
      council: candidate.place.council_district || "",
      neighborhood: candidate.place.neighborhood || "",
      scope: candidate.place.location_scope || "",
    }))
    : Object.freeze({});
  const time = candidate.time && typeof candidate.time === "object" && !Array.isArray(candidate.time)
    ? searchHandoffTime(new URLSearchParams({
      when: candidate.time.when || "",
      months: candidate.time.months || "",
    }), candidate.family_id)
    : Object.freeze({});
  const evidence = validSearchHandoffEvidence(candidate.evidence);
  const provenance = candidate.edge_provenance && typeof candidate.edge_provenance === "object"
    ? Object.freeze({
      relation: "search_result_handoff",
      lane_source: cleanSearchHandoffValue(candidate.edge_provenance.lane_source, 240) || null,
      lane_as_of: cleanSearchHandoffValue(candidate.edge_provenance.lane_as_of, 160) || null,
      source_observation_ref: evidence?.source_identifier || null,
      object_ref: cleanSearchHandoffValue(candidate.edge_provenance.object_ref, 240) || null,
    })
    : Object.freeze({ relation: "search_result_handoff" });
  return Object.freeze({
    schema: SEARCH_LENS_HANDOFF_SCHEMA,
    family_id: candidate.family_id,
    surface: config.surface,
    lens_label: config.label,
    raw_query: rawQuery,
    normalized_terms: Object.freeze(cleanSearchHandoffList(candidate.normalized_terms)),
    place,
    time,
    back_href: backHref,
    remove_topic_href: cleanSearchHandoffValue(candidate.remove_topic_href, 1_000) || null,
    evidence,
    edge_provenance: provenance,
  });
}

function escapeSearchHandoffHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const SEARCH_HANDOFF_FALLBACK_COPY = Object.freeze({
  search_handoff_arrival: ({ lens }) => `Opened ${lens} from topic search.`,
  search_handoff_topic: () => "Topic",
  search_handoff_place: () => "Place",
  search_handoff_time: () => "Time",
  search_handoff_remove_topic: ({ topic }) => `Remove topic ${topic}`,
  search_handoff_back: () => "Back to all search results",
  search_handoff_evidence: ({ field }) => `Matched in ${field}`,
  search_handoff_evidence_unavailable: () => "Keyword evidence is unavailable for this source.",
});

function searchHandoffCopy(t, key, vars = {}) {
  if (typeof t === "function") return t(key, vars);
  return SEARCH_HANDOFF_FALLBACK_COPY[key]?.(vars) || key;
}

function searchHandoffEvidenceHtml(handoff, t, escape) {
  const evidence = handoff.evidence;
  if (!evidence) return `<p class="search-handoff-evidence is-unavailable">${escape(searchHandoffCopy(t, "search_handoff_evidence_unavailable"))}</p>`;
  const { text, mark_start: start, mark_end: end } = evidence.snippet;
  const snippet = `${escape(text.slice(0, start))}<mark>${escape(text.slice(start, end))}</mark>${escape(text.slice(end))}`;
  const field = evidence.field.replaceAll("_", " ");
  return `<p class="search-handoff-evidence"><strong>${escape(searchHandoffCopy(t, "search_handoff_evidence", { field }))}</strong> · <span lang="en" dir="ltr">${snippet}</span></p>`;
}

export function renderSearchHandoffArrivalHtml(input, { t = null, escape = escapeSearchHandoffHtml } = {}) {
  const handoff = input?.schema === SEARCH_LENS_HANDOFF_SCHEMA ? input : parseSearchLensHandoff(input);
  if (!handoff) return "";
  const sourceRef = cleanSearchHandoffValue(handoff.edge_provenance?.source_observation_ref, 240);
  const sourceAttribute = sourceRef ? ` data-source-observation-ref="${escape(sourceRef)}"` : "";
  const removeHref = cleanSearchHandoffValue(handoff.remove_topic_href, 1_000) || "#";
  const place = [
    handoff.place?.borough,
    handoff.place?.community_district,
    handoff.place?.council_district ? `Council ${handoff.place.council_district}` : null,
    handoff.place?.neighborhood,
    handoff.place?.location_scope,
  ].filter(Boolean).join(" · ");
  const time = [handoff.time?.when, handoff.time?.months ? `${handoff.time.months} months` : null]
    .filter(Boolean).join(" · ");
  const contextChips = [
    place ? `<span class="qchip">${escape(searchHandoffCopy(t, "search_handoff_place"))} <b>${escape(place)}</b></span>` : "",
    time ? `<span class="qchip">${escape(searchHandoffCopy(t, "search_handoff_time"))} <b>${escape(time)}</b></span>` : "",
  ].join("");
  return `<aside class="nlunderstood search-handoff-arrival" data-search-handoff-schema="${SEARCH_LENS_HANDOFF_SCHEMA}"${sourceAttribute} role="status">
    <p class="search-handoff-arrival-title"><strong>${escape(searchHandoffCopy(t, "search_handoff_arrival", { lens: handoff.lens_label }))}</strong></p>
    <div class="search-handoff-arrival-actions"><span class="qchip search-handoff-topic">${escape(searchHandoffCopy(t, "search_handoff_topic"))} <b lang="en" dir="ltr">${escape(handoff.raw_query)}</b> <a href="${escape(removeHref)}" aria-label="${escape(searchHandoffCopy(t, "search_handoff_remove_topic", { topic: handoff.raw_query }))}">×</a></span>${contextChips}<a class="search-handoff-back" href="${escape(handoff.back_href)}">${escape(searchHandoffCopy(t, "search_handoff_back"))}</a></div>
    ${searchHandoffEvidenceHtml(handoff, t, escape)}
  </aside>`;
}

export function searchLaneActionLabel(familyId) {
  return SEARCH_HANDOFF_FAMILY_CONFIG[familyId]?.label || null;
}
