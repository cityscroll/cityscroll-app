import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { resolveKeywordQuery } from "../site/keyword_matcher.mjs";
import {
  SEARCH_INTENT_COMPILERS,
  SEARCH_INTENT_KEYS,
  SEARCH_INTENT_SCHEMA,
  emptySearchIntent,
  searchIntentFromKeywordQuery,
  searchIntentFromLensState,
  searchIntentFromNlFilter,
  searchIntentFromRouteHash,
  searchIntentFromScope,
} from "../site/search_intent.mjs";
import { scopeFromLensState, scopeFromRouteHash } from "../site/scope_v0.mjs";
import { sanitize } from "../worker/src/lib/filter.mjs";

const MEETINGS_HASH = "#meetings?agency=Transportation&q=dining&when=month&boro=Brooklyn&neighborhood=Red+Hook";
const PROJECTOR_SOURCE = readFileSync(new URL("../site/search_intent.mjs", import.meta.url), "utf8");

function assertFrozenIntent(intent, compiler) {
  assert.equal(intent.schema, SEARCH_INTENT_SCHEMA);
  assert.deepEqual(Object.keys(intent), [...SEARCH_INTENT_KEYS]);
  assert.equal(intent.compiler, compiler);
  assert.ok(Object.isFrozen(intent));
  assert.ok(Object.isFrozen(intent.domains));
  assert.ok(Object.isFrozen(intent.entity_refs));
  assert.ok(Object.isFrozen(intent.relations));
  assert.ok(Object.isFrozen(intent.place));
  assert.ok(Object.isFrozen(intent.time));
}

test("SearchIntent is one frozen cityscroll.search_intent.v1 object", () => {
  const intent = emptySearchIntent();
  assertFrozenIntent(intent, null);
  assert.equal(intent.text, "");
  assert.deepEqual(intent.domains, []);
  assert.deepEqual(intent.entity_refs, []);
  assert.deepEqual(intent.relations, []);
  assert.deepEqual(SEARCH_INTENT_COMPILERS, ["scope_v0", "keyword_query", "nl_sanitize"]);
});

test("scope-v0 route hash projects text, domain, and place/time", () => {
  const scope = scopeFromRouteHash(MEETINGS_HASH);
  const intent = searchIntentFromRouteHash(MEETINGS_HASH);
  assertFrozenIntent(intent, "scope_v0");
  assert.deepEqual(intent, searchIntentFromScope(scope));
  assert.equal(intent.text, "dining");
  assert.deepEqual(intent.domains, ["meetings"]);
  assert.deepEqual(intent.entity_refs, []);
  assert.deepEqual(intent.relations, []);
  assert.deepEqual(intent.place.boroughs, ["Brooklyn"]);
  assert.equal(intent.place.neighborhood, "Red Hook");
  assert.equal(intent.time.preset, "month");
});

test("scope-v0 lens state projects the same frozen intent axes", () => {
  const state = {
    q: "dining",
    agency: "Transportation",
    boro: "Brooklyn",
    neighborhood: "Red Hook",
    when: "month",
  };
  const intent = searchIntentFromLensState("meetings", state);
  assertFrozenIntent(intent, "scope_v0");
  assert.deepEqual(intent, searchIntentFromScope(scopeFromLensState("meetings", state)));
  assert.equal(intent.text, "dining");
  assert.deepEqual(intent.domains, ["meetings"]);
  assert.deepEqual(intent.place.boroughs, ["Brooklyn"]);
  assert.equal(intent.time.preset, "month");
});

test("scope-v0 copies typed entity refs and relations and does not invent agency ids", () => {
  const hash = `#money?q=mosquito&agency=Parks+and+Recreation&facet=${encodeURIComponent(JSON.stringify({
    entity_refs_all: ["agency:id:parks-and-recreation"],
    connection_relation: "published_by_agency",
  }))}`;
  const intent = searchIntentFromRouteHash(hash);
  assertFrozenIntent(intent, "scope_v0");
  assert.equal(intent.text, "mosquito");
  assert.deepEqual(intent.domains, ["money"]);
  assert.deepEqual(intent.entity_refs, ["agency:id:parks-and-recreation"]);
  assert.deepEqual(intent.relations, ["published_by_agency"]);

  const namedOnly = searchIntentFromRouteHash("#money?q=mosquito&agency=Parks+and+Recreation");
  assert.deepEqual(namedOnly.entity_refs, []);
  assert.deepEqual(namedOnly.relations, []);
});

test("resolveKeywordQuery projects raw text and reviewed alias entity refs", () => {
  const resolved = resolveKeywordQuery("mosquitos");
  const intent = searchIntentFromKeywordQuery("mosquitos");
  assertFrozenIntent(intent, "keyword_query");
  assert.equal(intent.text, resolved.raw_query);
  assert.equal(intent.text, "mosquitos");
  assert.deepEqual(intent.domains, []);
  assert.deepEqual(intent.entity_refs, []);
  assert.deepEqual(intent.relations, []);

  const ida = searchIntentFromKeywordQuery("ida");
  assertFrozenIntent(ida, "keyword_query");
  assert.equal(ida.text, "ida");
  assert.deepEqual(ida.entity_refs, ["agency:id:industrial-development-agency"]);
  assert.deepEqual(resolveKeywordQuery("ida").structured_filters.agency_id, "industrial-development-agency");
});

test("NL sanitize projects lens, keywords, place, and time", () => {
  const input = {
    keywords: ["education"],
    minAmount: 200000,
    months: 3,
    agency: "Department of Education",
  };
  const filter = sanitize("money", input);
  const intent = searchIntentFromNlFilter("money", input);
  assertFrozenIntent(intent, "nl_sanitize");
  assert.deepEqual(filter.keywords, ["education"]);
  assert.equal(filter.minAmount, 200000);
  assert.equal(filter.months, 3);
  assert.equal(intent.text, "education");
  assert.deepEqual(intent.domains, ["money"]);
  assert.deepEqual(intent.entity_refs, []);
  assert.equal(intent.time.rolling_months, 3);

  const land = searchIntentFromNlFilter("land", { keywords: ["rezoning"], boro: "Brooklyn" });
  assertFrozenIntent(land, "nl_sanitize");
  assert.equal(land.text, "rezoning");
  assert.deepEqual(land.domains, ["land"]);
  assert.deepEqual(land.place.boroughs, ["Brooklyn"]);
});

test("NL sanitize copies typed refs and relations and maps obligations to mandates", () => {
  const intent = searchIntentFromNlFilter("money", {
    keywords: ["contracts"],
    entity_refs_all: ["agency:id:parks-and-recreation", "not a ref"],
    connection_relation: "published_by_agency",
    agency: "Parks and Recreation",
  });
  assertFrozenIntent(intent, "nl_sanitize");
  assert.deepEqual(intent.entity_refs, ["agency:id:parks-and-recreation"]);
  assert.deepEqual(intent.relations, ["published_by_agency"]);

  const mandates = searchIntentFromNlFilter("obligations", {
    agency_id: "parks-and-recreation",
    mandate_id: "66056-006",
  });
  assert.deepEqual(mandates.domains, ["mandates"]);
  assert.deepEqual(mandates.entity_refs, [
    "agency:id:parks-and-recreation",
    "mandate:66056-006",
  ]);

  const exam = searchIntentFromNlFilter("people", { examNumber: "7016" });
  assert.deepEqual(exam.entity_refs, ["exam:7016"]);
});

test("empty compiler inputs emit the empty frozen intent shape", () => {
  const empty = emptySearchIntent();
  assert.deepEqual(searchIntentFromRouteHash("#unknown"), { ...empty, compiler: "scope_v0" });
  assert.deepEqual(searchIntentFromKeywordQuery(""), { ...empty, compiler: "keyword_query" });
  assert.deepEqual(searchIntentFromNlFilter("money", {}), { ...empty, compiler: "nl_sanitize", domains: ["money"] });
});

test("projector reads the three compilers and does not import retrieval or Ask", () => {
  assert.match(PROJECTOR_SOURCE, /scopeFromRouteHash/);
  assert.match(PROJECTOR_SOURCE, /scopeFromLensState/);
  assert.match(PROJECTOR_SOURCE, /resolveKeywordQuery/);
  assert.match(PROJECTOR_SOURCE, /sanitize/);
  assert.equal(PROJECTOR_SOURCE.includes("worker/src/search.mjs"), false);
  assert.equal(PROJECTOR_SOURCE.includes("worker/src/nl.mjs"), false);
  assert.equal(PROJECTOR_SOURCE.includes("site/app/search-share.mjs"), false);
});
