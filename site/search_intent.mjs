/**
 * Read-only SearchIntent projector.
 *
 * Emits one frozen `cityscroll.search_intent.v1` by reading the three existing
 * compilers: scope-v0, resolveKeywordQuery, and NL sanitize. It does not change
 * those compilers and is not wired into /search or /nl.
 *
 * `domains[]` keep compiler-native lens tokens (money, land, meetings, …).
 * Typed `entity_refs[]` are copied when a compiler already produced them;
 * display names are not promoted to `agency:id:…`.
 */

import { resolveKeywordQuery } from "./keyword_matcher.mjs";
import { mandateSubjectRef } from "./mandate_subject_ref.mjs";
import { scopeFromLensState, scopeFromRouteHash } from "./scope_v0.mjs";
import { LENSES, resolveLens, sanitize } from "../worker/src/lib/filter.mjs";

export const SEARCH_INTENT_SCHEMA = "cityscroll.search_intent.v1";

export const SEARCH_INTENT_COMPILERS = Object.freeze([
  "scope_v0",
  "keyword_query",
  "nl_sanitize",
]);

export const SEARCH_INTENT_KEYS = Object.freeze([
  "schema",
  "text",
  "domains",
  "entity_refs",
  "relations",
  "place",
  "time",
  "compiler",
]);

const TYPED_REF = /^(?:agency:[^:\s]+:[^:\s]+|community-board:[a-z]+(?:-[a-z]+)*-cb-\d{2}|vendor:stem:[^:\s]+|entity:official:[^:\s]+|project:[A-Za-z0-9][A-Za-z0-9_-]{2,24}|notice:[A-Za-z0-9][A-Za-z0-9_-]{3,39}|pin:[A-Za-z0-9][A-Za-z0-9_-]{3,39}|exam:\d{4}|bbl:\d{10}|mandate:[A-Za-z0-9][A-Za-z0-9._-]{0,79})$/i;

const CONNECTION_RELATIONS = new Set([
  "published_by_agency",
  "named_vendor",
  "sited_on_parcel",
  "votes_on",
  "references_contract",
  "registered_as",
  "shares_authority_key",
  "about_notice",
  "parcel_links_project",
  "named_owner",
  "same_rulemaking",
]);

const BOROUGHS = Object.freeze([
  "Manhattan",
  "Brooklyn",
  "Queens",
  "Bronx",
  "Staten Island",
]);

function freezeDeep(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function cleanText(value, max = 320) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function unique(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function typedRef(value) {
  const ref = String(value ?? "").trim();
  if (!ref || /\s/.test(ref) || !TYPED_REF.test(ref)) return null;
  return ref.startsWith("community-board:") ? ref.toLowerCase() : ref;
}

function typedRefs(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(typedRef).filter(Boolean))].sort();
}

function relationOf(value) {
  return typeof value === "string" && CONNECTION_RELATIONS.has(value) ? value : null;
}

function boroughOf(value) {
  const name = cleanText(value, 40);
  if (!name) return null;
  return BOROUGHS.find((borough) => borough.toLowerCase() === name.toLowerCase()) || null;
}

function emptyPlace() {
  return {
    boroughs: [],
    community_districts: [],
    council_districts: [],
    neighborhood: null,
    location_scope: null,
  };
}

function emptyTime() {
  return {
    preset: null,
    start: null,
    end: null,
    rolling_months: null,
  };
}

function freezeIntent({
  text = "",
  domains = [],
  entity_refs = [],
  relations = [],
  place = emptyPlace(),
  time = emptyTime(),
  compiler = null,
} = {}) {
  return freezeDeep({
    schema: SEARCH_INTENT_SCHEMA,
    text: cleanText(text),
    domains: unique(domains),
    entity_refs: typedRefs(entity_refs),
    relations: unique(relations).filter((value) => CONNECTION_RELATIONS.has(value)),
    place: {
      boroughs: unique(place.boroughs).map(boroughOf).filter(Boolean),
      community_districts: unique(place.community_districts),
      council_districts: unique(place.council_districts),
      neighborhood: cleanText(place.neighborhood, 80) || null,
      location_scope: place.location_scope || null,
    },
    time: {
      preset: cleanText(time.preset, 40) || null,
      start: cleanText(time.start, 32) || null,
      end: cleanText(time.end, 32) || null,
      rolling_months: Number.isFinite(time.rolling_months) && time.rolling_months > 0
        ? time.rolling_months
        : null,
    },
    compiler: SEARCH_INTENT_COMPILERS.includes(compiler) ? compiler : null,
  });
}

function refsFromKnownFields(fields = {}) {
  const refs = [];
  refs.push(...(Array.isArray(fields.entity_refs_all) ? fields.entity_refs_all : []));
  refs.push(...(Array.isArray(fields.subject_refs_all) ? fields.subject_refs_all : []));
  if (fields.agency_id) refs.push(`agency:id:${fields.agency_id}`);
  if (fields.examNumber) refs.push(`exam:${fields.examNumber}`);
  if (fields.requestId) refs.push(`notice:${fields.requestId}`);
  if (fields.mandate_id) refs.push(mandateSubjectRef(fields.mandate_id));
  return refs;
}

export function emptySearchIntent() {
  return freezeIntent();
}

/** Project an already-normalized scope-v0 object. */
export function searchIntentFromScope(scope) {
  const topic = scope?.topic && typeof scope.topic === "object" ? scope.topic : {};
  const facets = scope?.facets && typeof scope.facets === "object" ? scope.facets : {};
  const values = facets.values && typeof facets.values === "object" ? facets.values : {};
  const text = topic.query || (Array.isArray(topic.keywords) ? topic.keywords.join(" ") : "");
  const relation = relationOf(values.connection_relation);
  return freezeIntent({
    text,
    domains: facets.domains,
    entity_refs: refsFromKnownFields(values),
    relations: relation ? [relation] : [],
    place: scope?.place,
    time: scope?.time_window,
    compiler: "scope_v0",
  });
}

export function searchIntentFromRouteHash(hash, options) {
  return searchIntentFromScope(scopeFromRouteHash(hash, options));
}

export function searchIntentFromLensState(lens, state, options) {
  return searchIntentFromScope(scopeFromLensState(lens, state, options));
}

export function searchIntentFromKeywordQuery(value) {
  const resolved = resolveKeywordQuery(value);
  const agencyId = resolved.structured_filters?.agency_id;
  return freezeIntent({
    text: resolved.raw_query,
    domains: [],
    entity_refs: agencyId ? [`agency:id:${agencyId}`] : [],
    relations: [],
    compiler: "keyword_query",
  });
}

function placeFromFilter(filter) {
  const place = emptyPlace();
  const borough = boroughOf(filter.boro || filter.borough);
  if (borough) place.boroughs = [borough];
  if (filter.communityDistrict) place.community_districts = [filter.communityDistrict];
  if (filter.councilDistrict) place.council_districts = [filter.councilDistrict];
  const labeledPlace = cleanText(filter.place, 80);
  const labeledBorough = boroughOf(labeledPlace);
  if (labeledBorough && !place.boroughs.includes(labeledBorough)) {
    place.boroughs = [...place.boroughs, labeledBorough];
  }
  place.neighborhood = filter.neighborhood
    || (labeledPlace && !labeledBorough ? labeledPlace : null);
  place.location_scope = filter.locationScope || null;
  return place;
}

function timeFromFilter(filter) {
  const months = Number(filter.months);
  return {
    preset: filter.when || filter.dateWindow || (filter.closingWeek ? "closing:week" : null),
    start: null,
    end: null,
    rolling_months: Number.isFinite(months) ? months : null,
  };
}

export function searchIntentFromNlFilter(lens, input) {
  const resolved = resolveLens(lens);
  const filter = sanitize(lens, input);
  const knownLens = LENSES[resolved] || LENSES[lens] ? (resolved || lens) : null;
  const relation = relationOf(filter.connection_relation);
  return freezeIntent({
    text: Array.isArray(filter.keywords) ? filter.keywords.join(" ") : "",
    domains: knownLens ? [knownLens] : [],
    entity_refs: refsFromKnownFields(filter),
    relations: relation ? [relation] : [],
    place: placeFromFilter(filter),
    time: timeFromFilter(filter),
    compiler: "nl_sanitize",
  });
}
