import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  UNIVERSAL_SEARCH_LENS_IDS,
  UNIVERSAL_SEARCH_RANKING_POLICY,
  federateUniversalSearch,
} from "../site/universal_search_federator.mjs";
import {
  buildCityRecordRuleProjectionIndex,
  materializeCityRecordSearchDocument,
} from "../site/city_record_search_producers.mjs";
import { projectAgencySearchDocument } from "../site/agency_search_producer.mjs";

const AGENCIES = JSON.parse(readFileSync(
  new URL("../site/data/agency_constellation_lookup.json", import.meta.url),
));
const RULES = JSON.parse(readFileSync(
  new URL("../site/data/rules_domain_observations.json", import.meta.url),
));

function candidate(document, localScore, field = "title") {
  return {
    document,
    local_score: localScore,
    match_fields: [{
      field,
      matched_term: "parks",
      source_observation_ref: document.source_observation_refs[0],
    }],
  };
}

function lens(candidates, overrides = {}) {
  return {
    async search({ query }) {
      assert.equal(query, "parks");
      return {
        candidates,
        coverage: {
          state: candidates.length ? "matched" : "empty",
          indexed_count: candidates.length,
          as_of: "2026-08-15T12:00:00Z",
          source: "committed fixture read model",
          method: "fts5_bm25",
          ...overrides,
        },
      };
    },
  };
}

function realParksDocuments() {
  const agency = projectAgencySearchDocument(
    "parks-and-recreation",
    AGENCIES.by_id["parks-and-recreation"],
    { lookup: AGENCIES },
  ).document;
  const ruleRow = RULES.rows.find((row) => row.request_id === "20260521021");
  const rule = materializeCityRecordSearchDocument(ruleRow, {
    ruleIndex: buildCityRecordRuleProjectionIndex(RULES),
  });
  assert.ok(agency);
  assert.ok(rule);
  return { agency, rule };
}

test("federation returns real notice and entity documents in one deterministic envelope", async () => {
  const { agency, rule } = realParksDocuments();
  const lenses = Object.fromEntries(UNIVERSAL_SEARCH_LENS_IDS.map((id) => [id, lens([])]));
  lenses.notices = lens([candidate(rule, -6.25)]);
  lenses.agencies = lens([candidate(agency, -4.5)]);

  const first = await federateUniversalSearch({ query: "  PARKS!! ", lenses });
  const second = await federateUniversalSearch({ query: "parks", lenses });

  assert.deepEqual(first, second);
  assert.equal(first.query.normalized, "parks");
  assert.deepEqual(new Set(first.results.map((row) => row.entity_type)), new Set([
    "agency",
    "rulemaking",
  ]));
  assert.equal(first.coverage.all_lenses_participated, true);
  assert.deepEqual(Object.keys(first.coverage.by_lens), UNIVERSAL_SEARCH_LENS_IDS);
  assert.equal(first.coverage.by_lens.notices.state, "matched");
  assert.equal(first.coverage.by_lens.vendors.state, "empty");

  for (const row of first.results) {
    assert.equal(row.stable_key, row.object_ref);
    assert.equal(row.source_route, row.canonical_href);
    assert.equal(row.local_score_kind, "fts5_bm25");
    assert.equal(typeof row.local_score, "number");
    assert.equal(typeof row.normalized_rank, "number");
    assert.ok(row.normalized_rank >= 0 && row.normalized_rank <= 1);
    assert.equal(row.match_fields[0].matched_term, "parks");
    assert.ok(row.source_observation_refs.includes(
      row.match_fields[0].source_observation_ref,
    ));
    assert.deepEqual(row.handoff, {
      query: "parks",
      lens: row.lens,
      entity_type: row.entity_type,
      domain: row.domain,
      canonical_href: row.canonical_href,
    });
    assert.equal(row.edge_provenance.document_producer, row.provenance.producer);
  }
});

test("coverage distinguishes an empty indexed lens from a missing or failed lens", async () => {
  const lenses = {
    notices: lens([]),
    people: lens([], { indexed_count: 12 }),
    agencies: {
      async search() {
        throw new Error("snapshot unavailable");
      },
    },
  };
  const response = await federateUniversalSearch({ query: "parks", lenses });

  assert.equal(response.coverage.by_lens.notices.state, "empty");
  assert.equal(response.coverage.by_lens.notices.matched_count, 0);
  assert.equal(response.coverage.by_lens.agencies.state, "provider_unavailable");
  assert.equal(response.coverage.by_lens.agencies.matched_count, null);
  assert.equal(response.coverage.by_lens.vendors.state, "not_indexed");
  assert.equal(response.coverage.by_lens.vendors.participated, false);
  assert.equal(response.coverage.all_lenses_participated, false);
});

test("declared calibration and tie-breaks do not depend on provider delivery order", async () => {
  const { agency, rule } = realParksDocuments();
  const tied = [candidate(rule, -1), candidate(agency, -1)];
  const one = await federateUniversalSearch({
    query: "parks",
    lenses: { notices: lens(tied) },
  });
  const two = await federateUniversalSearch({
    query: "parks",
    lenses: { notices: lens([...tied].reverse()) },
  });

  assert.deepEqual(
    one.results.map((row) => row.stable_key),
    two.results.map((row) => row.stable_key),
  );
  assert.deepEqual(UNIVERSAL_SEARCH_RANKING_POLICY.tie_break, [
    "calibrated_score_desc",
    "entity_type_asc",
    "stable_key_asc",
    "lens_asc",
  ]);
});

test("duplicate civic objects collapse by stable identity while retaining edge provenance", async () => {
  const { agency } = realParksDocuments();
  const response = await federateUniversalSearch({
    query: "parks",
    lenses: {
      notices: lens([candidate(agency, -2, "summary")]),
      agencies: lens([candidate(agency, -3, "title")]),
    },
  });

  assert.equal(response.results.length, 1);
  assert.equal(response.results[0].stable_key, "agency:id:parks-and-recreation");
  assert.deepEqual(response.results[0].matched_lenses, ["notices", "agencies"]);
  assert.equal(response.results[0].edge_provenance.matches.length, 2);
  assert.ok(response.results[0].edge_provenance.matches.every((edge) => (
    edge.source_observation_refs.includes(edge.match_fields[0].source_observation_ref)
  )));
});
