import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  FEDERATED_SEARCH_CAPABILITY,
  FEDERATED_SEARCH_CAPABILITY_REFERENCE,
  FEDERATED_SEARCH_COVERAGE_STATES,
  FEDERATED_SEARCH_LENS_IDS,
  FEDERATED_SEARCH_REQUESTED_COVERAGE_STATES,
  FEDERATED_SEARCH_REQUESTED_SCOPE_SCHEMA,
  FEDERATED_SEARCH_SCOPE_SCHEMA,
  executeFederatedSearch,
  normalizeFederatedSearchScope,
  validateFederatedSearchInput,
} from "../capabilities/federated_search.mjs";
import { federateUniversalSearch } from "../site/universal_search_federator.mjs";
import { buildUniversalSearchCoverageView } from "../site/universal_search_coverage_receipt.mjs";
import { handleSearch } from "../worker/src/search.mjs";

const SCHEMA = JSON.parse(readFileSync(new URL("./fixtures/federated_search_scope/schema.v1.json", import.meta.url)));
const CASES = JSON.parse(readFileSync(new URL("./fixtures/federated_search_scope/cases.v1.json", import.meta.url)));

function document() {
  return {
    schema: "cityscroll.search_document.v1",
    object_ref: "agency:id:parks-and-recreation",
    object_type: "agency",
    domain: "people",
    canonical_href: "/agencies/parks-and-recreation/",
    title: "Department of Parks and Recreation",
    summary: "Public agency profile.",
    search_text: "Department of Parks and Recreation parks",
    source_family: "agency_constellation",
    source_observation_refs: ["agency:parks-and-recreation"],
    process_role: null,
    classification: { method: "fixture", basis: "fixture" },
    provenance: { producer: "fixture.agency-search.v1" },
  };
}

function coverageFor(lens, state, extra = {}) {
  const indexed = ["matched", "empty", "partial", "stale"].includes(state);
  return {
    state,
    indexed_count: indexed ? (state === "matched" ? 1 : 0) : null,
    as_of: state === "stale" ? "2026-07-01T00:00:00Z" : "2026-08-26T00:00:00Z",
    source: `fixture.${lens}`,
    method: "fixture_v1",
    ...extra,
  };
}

function provider(options = {}) {
  const matchedLens = options.matchedLens ?? "agencies";
  const states = options.states || {};
  const failing = new Set(options.failing || []);
  const omitCoverage = new Set(options.omitCoverage || []);
  const calls = [];
  const lenses = Object.fromEntries(FEDERATED_SEARCH_LENS_IDS.map((lens) => [lens, {
    async search() {
      calls.push(lens);
      if (failing.has(lens)) throw new Error("snapshot unavailable");
      const matched = lens === matchedLens && (states[lens] ?? "matched") === "matched";
      const payload = {
        candidates: matched ? [{
          document: document(),
          local_score: 1,
          match_fields: [{
            field: "title",
            matched_term: "parks",
            source_observation_ref: "agency:parks-and-recreation",
          }],
        }] : [],
      };
      if (!omitCoverage.has(lens)) {
        payload.coverage = coverageFor(lens, states[lens] ?? (matched ? "matched" : "empty"));
      }
      return payload;
    },
  }]));
  return {
    capabilityReference: FEDERATED_SEARCH_CAPABILITY_REFERENCE,
    providerId: FEDERATED_SEARCH_CAPABILITY.provider.id,
    calls,
    execute(input) {
      return federateUniversalSearch({
        query: input.query,
        lenses,
        limit: input.limit,
        scope: input.scope,
      });
    },
  };
}

function projection(result) {
  return {
    query: result.query,
    result_object_refs: result.results.map((row) => row.object_ref),
    result_lenses: result.results.map((row) => row.lens),
    coverage_by_lens: Object.fromEntries(FEDERATED_SEARCH_LENS_IDS.map((lens) => (
      [lens, result.coverage.by_lens[lens].state]
    ))),
    requested_scope: {
      omitted: result.requested_scope.omitted,
      mode: result.requested_scope.mode,
      lenses: result.requested_scope.lenses,
    },
  };
}

test("the frozen scope schema matches the registered allowlist and coverage states", () => {
  assert.deepEqual(SCHEMA.allowlisted_lenses, FEDERATED_SEARCH_LENS_IDS);
  assert.deepEqual(SCHEMA.requested_coverage_states, FEDERATED_SEARCH_REQUESTED_COVERAGE_STATES);
  assert.equal(SCHEMA.unrequested_coverage_state, "out_of_scope");
  assert.deepEqual(FEDERATED_SEARCH_COVERAGE_STATES, [
    ...FEDERATED_SEARCH_REQUESTED_COVERAGE_STATES,
    "out_of_scope",
  ]);
  assert.equal(FEDERATED_SEARCH_CAPABILITY.input.scope.schema, FEDERATED_SEARCH_SCOPE_SCHEMA);
  assert.equal(FEDERATED_SEARCH_CAPABILITY.output.requestedScopeSchema, FEDERATED_SEARCH_REQUESTED_SCOPE_SCHEMA);
});

test("frozen all-source and one-allowlisted examples match the capability envelope", async () => {
  const explicit = provider();
  for (const fixture of CASES.cases.filter((row) => row.expected)) {
    const result = await executeFederatedSearch(explicit, fixture.input);
    assert.deepEqual(projection(result), fixture.expected, fixture.id);
    assert.equal(result.results[0].stable_key, result.results[0].object_ref);
    assert.equal(result.results[0].source_route, result.results[0].canonical_href);
    assert.ok(result.results[0].source_observation_refs.length);
    assert.equal(result.ranking_policy.id, "cityscroll.cross_lens_rank.v1");
    assert.ok(result.results.length <= 10);
  }
});

test("frozen unknown and arbitrary scopes fail closed", () => {
  for (const fixture of CASES.cases.filter((row) => row.error)) {
    assert.throws(() => validateFederatedSearchInput(fixture.input), new RegExp(fixture.error), fixture.id);
  }
});

test("legacy omitted scope stays all-lens and does not query as an allowlist", async () => {
  const explicit = provider();
  const omitted = await executeFederatedSearch(explicit, { query: "parks", limit: 10 });
  const explicitAll = await executeFederatedSearch(explicit, {
    query: "parks",
    limit: 10,
    scope: { lenses: [...FEDERATED_SEARCH_LENS_IDS] },
  });
  assert.equal(omitted.requested_scope.omitted, true);
  assert.equal(explicitAll.requested_scope.omitted, false);
  assert.deepEqual(omitted.results.map((row) => row.object_ref), explicitAll.results.map((row) => row.object_ref));
  assert.deepEqual(
    Object.fromEntries(FEDERATED_SEARCH_LENS_IDS.map((lens) => [lens, omitted.coverage.by_lens[lens].state])),
    Object.fromEntries(FEDERATED_SEARCH_LENS_IDS.map((lens) => [lens, explicitAll.coverage.by_lens[lens].state])),
  );
  assert.ok(omitted.coverage.by_lens.notices.state !== "out_of_scope");
});

test("each requested coverage state stays distinct from out-of-scope", async () => {
  const states = {
    notices: "empty",
    people: "partial",
    agencies: "matched",
    vendors: "stale",
    committees: "not_indexed",
    community_boards: "provider_unavailable",
  };
  const explicit = provider({
    states,
    failing: ["community_boards"],
  });
  const result = await executeFederatedSearch(explicit, {
    query: "parks",
    limit: 10,
    scope: { lenses: Object.keys(states) },
  });
  for (const [lens, state] of Object.entries(states)) {
    assert.equal(result.coverage.by_lens[lens].state, state, lens);
    assert.equal(result.requested_scope.by_lens[lens].requested, true);
    assert.notEqual(state, "out_of_scope");
  }
  assert.equal(result.coverage.by_lens.exams.state, "out_of_scope");
  assert.equal(result.coverage.by_lens.parcels.state, "out_of_scope");
  assert.equal(result.coverage.by_lens.land.state, "out_of_scope");
  assert.equal(result.coverage.by_lens.meetings.state, "out_of_scope");
  assert.equal(result.requested_scope.by_lens.exams.requested, false);
});

test("coverage projection keeps out-of-scope distinct from not-indexed", async () => {
  const explicit = provider();
  const result = await executeFederatedSearch(explicit, {
    query: "parks",
    limit: 10,
    scope: { lenses: ["agencies"] },
  });
  const view = buildUniversalSearchCoverageView(result.coverage);
  const agencies = view.lenses.find((row) => row.lens === "agencies");
  const notices = view.lenses.find((row) => row.lens === "notices");
  assert.equal(agencies.state, "matched");
  assert.equal(notices.state, "out_of_scope");
  assert.equal(notices.state_label, "out of scope");
  assert.notEqual(notices.state, "not_indexed");
});

test("a scoped empty result is not unavailable, stale, not-indexed, partial, or out-of-scope", async () => {
  const explicit = provider({ matchedLens: null, states: { agencies: "empty" } });
  const result = await executeFederatedSearch(explicit, {
    query: "parks",
    limit: 10,
    scope: { lenses: ["agencies"] },
  });
  assert.equal(result.results.length, 0);
  assert.equal(result.coverage.by_lens.agencies.state, "empty");
  assert.equal(result.coverage.by_lens.agencies.matched_count, 0);
  assert.equal(result.coverage.by_lens.notices.state, "out_of_scope");
  assert.notEqual(result.coverage.by_lens.agencies.state, "provider_unavailable");
  assert.notEqual(result.coverage.by_lens.agencies.state, "stale");
  assert.notEqual(result.coverage.by_lens.agencies.state, "not_indexed");
  assert.notEqual(result.coverage.by_lens.agencies.state, "partial");
});

test("provider failure on a requested lens is unavailable, not empty", async () => {
  const explicit = provider({ failing: ["agencies"] });
  const result = await executeFederatedSearch(explicit, {
    query: "parks",
    limit: 10,
    scope: { lenses: ["agencies"] },
  });
  assert.equal(result.results.length, 0);
  assert.equal(result.coverage.by_lens.agencies.state, "provider_unavailable");
  assert.equal(result.coverage.by_lens.agencies.matched_count, null);
});

test("omitted requested coverage fails closed instead of collapsing to empty", async () => {
  const explicit = provider({ omitCoverage: ["agencies"] });
  const result = await executeFederatedSearch(explicit, {
    query: "parks",
    limit: 10,
    scope: { lenses: ["agencies"] },
  });
  assert.equal(result.coverage.by_lens.agencies.state, "provider_unavailable");
  assert.equal(result.coverage.by_lens.agencies.reason, "requested_coverage_omitted");
  assert.equal(result.results.length, 0);
});

test("unrequested lens providers are not queried", async () => {
  const explicit = provider();
  await executeFederatedSearch(explicit, {
    query: "parks",
    limit: 10,
    scope: { lenses: ["agencies"] },
  });
  assert.deepEqual(explicit.calls, ["agencies"]);
});

test("stable result identity is unchanged when the same allowlist is replayed", async () => {
  const explicit = provider();
  const first = await executeFederatedSearch(explicit, {
    query: "parks",
    limit: 10,
    scope: { lenses: ["agencies"] },
  });
  const second = await executeFederatedSearch(explicit, {
    query: "  PARKS ",
    limit: 10,
    scope: ["agencies"],
  });
  assert.deepEqual(
    first.results.map((row) => ({ object_ref: row.object_ref, rank: row.rank, calibrated: row.ranking.calibrated_score })),
    second.results.map((row) => ({ object_ref: row.object_ref, rank: row.rank, calibrated: row.ranking.calibrated_score })),
  );
});

test("HTTP and fixture adapters share validation, ranking, identity, and requested coverage", async () => {
  const httpProvider = provider();
  const fixtureProvider = provider();
  const input = { query: "parks", limit: 10, scope: { lenses: ["agencies"] } };
  const direct = await executeFederatedSearch(fixtureProvider, input);
  const http = await handleSearch(
    new Request("https://api.cityscroll.org/search?q=parks&scope=agencies"),
    {},
    { federatedProvider: httpProvider },
  );
  const httpBody = await http.json();
  assert.deepEqual(httpBody.federated, direct);
  assert.equal(httpBody.capability_reference, FEDERATED_SEARCH_CAPABILITY_REFERENCE);
  assert.equal(direct.requested_scope.schema, FEDERATED_SEARCH_REQUESTED_SCOPE_SCHEMA);
});

test("HTTP rejects unknown scope instead of widening", async () => {
  const http = await handleSearch(
    new Request("https://api.cityscroll.org/search?q=parks&scope=contracts"),
    {},
    { federatedProvider: provider() },
  );
  assert.equal(http.status, 400);
  const httpBody = await http.json();
  assert.equal(httpBody.reason, "invalid-request");
  assert.match(httpBody.error, /unknown or unregistered lens/);
});

test("normalizeFederatedSearchScope keeps registered order and rejects empty allowlists", () => {
  assert.deepEqual(
    normalizeFederatedSearchScope(["meetings", "agencies", "agencies"]).lenses,
    ["agencies", "meetings"],
  );
  assert.equal(normalizeFederatedSearchScope(undefined).omitted, true);
  assert.throws(() => normalizeFederatedSearchScope({ lenses: [] }), /non-empty/);
});
