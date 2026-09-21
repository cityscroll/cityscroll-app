import assert from "node:assert/strict";
import { test } from "node:test";
import { buildConsultationSearchDocuments } from "../../site/consultation_search_producer.mjs";
import { workerFederatedSearch } from "../src/search.mjs";

function consultationDb() {
  const documents = buildConsultationSearchDocuments().documents;
  return { prepare(sql) {
    let args = [];
    const statement = { bind(...values) { args = values; return statement; }, async first() {
      if (sql.includes("keyword_search_families")) return args[0] === "consultations"
        ? { source: "Retained organizer-linked public consultation rounds", as_of: "2026-09-14T00:00:00.000Z", source_row_count: 4, indexed_count: 4, coverage_json: "[]" } : null;
      return null;
    }, async all() {
      if (sql.includes("keyword_search_fts") && args[0] === "consultations") return { results: documents.map((document) => ({ document_json: JSON.stringify(document) })) };
      return { results: [] };
    } };
    return statement;
  } };
}

test("production-shaped Worker federation serves consultation results from D1", async () => {
  const fixtureOrder = buildConsultationSearchDocuments().documents.map(({ title, object_ref }) => ({ title, object_ref }));
  const provider = workerFederatedSearch({ DB: consultationDb() });
  const rounds = [
    ["bus", "Fast Buses: Central Brooklyn", "consultation:dot-fast-buses-central-brooklyn"],
    ["bike parking", "Secure Bike Parking", "consultation:dot-secure-bike-parking"],
    ["CB14", "Brooklyn CB14 district needs, FY2028", "consultation:cb14-community-budget-fy2028"],
    ["library", "Bloomingdale Library and Housing", "consultation:bloomingdale-library-and-housing"],
  ];
  assert.deepEqual(
    rounds.map(([, title, objectRef]) => ({ title, object_ref: objectRef })),
    fixtureOrder,
    "the four provider assertions cover the complete fixture order",
  );
  const observed = [];
  for (const [query, title, objectRef] of rounds) {
    const result = await provider.execute({
      query,
      limit: 10,
      scope: { lenses: ["consultations"] },
    });
    assert.equal(result.coverage.by_lens.consultations.state, "matched", `${query} round is covered`);
    assert.equal(result.results.length, 1, `${query} returns one canonical round`);
    assert.equal(result.results[0].title, title, `${query} returns the named round`);
    assert.equal(result.results[0].object_ref, objectRef, `${query} retains the round identity`);
    observed.push(result.results[0].title);
  }
  assert.deepEqual(observed, fixtureOrder.map(({ title }) => title), "provider returns all four rounds in fixture order");
  assert.equal((await provider.execute({ query: "bike parking", limit: 10 })).results[0].canonical_href, "/consultations/dot-secure-bike-parking/");
});
