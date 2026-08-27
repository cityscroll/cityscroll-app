import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  CAPABILITY_REFERENCE,
  SEARCH_HTTP_PATH,
  buildExternalSearchProof,
  fetchExternalSearchCase,
} from "../examples/external-search-proof/index.mjs";

const fixtureBytes = readFileSync(new URL("./fixtures/external_search_proof.json", import.meta.url));
const fixture = JSON.parse(fixtureBytes);

test("independent search consumer compares representative public results with the site projection", () => {
  const proof = buildExternalSearchProof(fixture, { fixtureBytes });

  assert.equal(proof.schema, "cityscroll.external_search_proof.v1");
  assert.equal(proof.source.capability_reference, CAPABILITY_REFERENCE);
  assert.equal(proof.source.route, "GET /search");
  assert.equal(proof.bounds.query_maximum_length, 240);
  assert.equal(proof.bounds.maximum_results, 100);
  assert.equal(proof.bounds.maximum_cards_per_lane, 8);
  assert.equal(proof.bounds.cases, 2);
  assert.deepEqual(proof.cases.map(({ query }) => query), ["parks", "public hearing"]);
  assert.ok(proof.cases.every(({ comparison }) => comparison.equivalent));
  assert.deepEqual(proof.cases[0].output.result_keys, [
    "agency:agency:id:parks-and-recreation:/agencies/parks-and-recreation/",
    "person:community-board-person:brooklyn:parks-example:/people/community-board-person-brooklyn-parks-example/",
  ]);
  assert.equal(proof.cases[0].coverage.meetings.state, "provider_unavailable");
  assert.equal(proof.cases[1].coverage.meetings.as_of, "2026-08-27T18:03:00Z");
  assert.equal(proof.cases[0].provenance[0].source_observation_refs[0], "agency:parks-and-recreation");
});

test("the consumer has no imports from the site, worker, or capability source trees", () => {
  const source = readFileSync(new URL("../examples/external-search-proof/index.mjs", import.meta.url), "utf8");
  assert.match(source, /from "node:/);
  assert.doesNotMatch(source, /from ["'](?:\.\.\/)+(?:site|worker|capabilities)\//);
  assert.match(source, /\/search/);
});

test("live consumer requests the documented bounded HTTP operation", async () => {
  const calls = [];
  const response = await fetchExternalSearchCase({
    apiOrigin: "https://api.cityscroll.org",
    query: "parks",
    fetchImpl: async (url, options) => {
      calls.push([url.toString(), options]);
      return new Response(JSON.stringify(fixture.cases[0].response), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(new URL(response.url).pathname, SEARCH_HTTP_PATH);
  assert.equal(new URL(response.url).searchParams.get("q"), "parks");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].headers.Accept, "application/json");
});

test("the proof fails closed when the site projection changes canonical result order", () => {
  const changed = structuredClone(fixture);
  changed.cases[0].response.results.reverse();
  assert.throws(
    () => buildExternalSearchProof(changed),
    /changed the federated result identity or order/,
  );
});

test("the proof fails closed when a public result loses source provenance", () => {
  const changed = structuredClone(fixture);
  changed.cases[1].response.federated.results[0].source_observation_refs = [];
  assert.throws(
    () => buildExternalSearchProof(changed),
    /missing public identity, evidence, or provenance/,
  );
});
