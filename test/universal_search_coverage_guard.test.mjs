import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildAgencySearchDocuments,
} from "../site/agency_search_producer.mjs";
import {
  buildPeopleSearchDocuments,
  rankPeopleSearchDocuments,
} from "../site/people_search_producer.mjs";
import {
  buildVendorSearchDocuments,
  rankVendorSearchDocuments,
} from "../site/vendor_search_producer.mjs";
import {
  UNIVERSAL_SEARCH_LENS_IDS,
  federateUniversalSearch,
} from "../site/universal_search_federator.mjs";
import {
  buildUniversalSearchCoverageView,
  renderUniversalSearchCoverageHtml,
} from "../site/universal_search_coverage_receipt.mjs";
import {
  buildFacts,
  buildObserverCoverage,
} from "../tools/build_architecture_facts.mjs";

const PEOPLE = JSON.parse(readFileSync(
  new URL("../site/data/person_hub_lookup.json", import.meta.url),
));
const AGENCIES = JSON.parse(readFileSync(
  new URL("../site/data/agency_constellation_lookup.json", import.meta.url),
));
const AGENCY_IDENTITIES = JSON.parse(readFileSync(
  new URL("../site/data/agency_route_identity_report.json", import.meta.url),
));
const VENDORS = JSON.parse(readFileSync(
  new URL("../site/data/entity_intelligence_lookup.json", import.meta.url),
));
const VENDOR_ALIASES = JSON.parse(readFileSync(
  new URL("../entity_resolution/review/alias_registry.json", import.meta.url),
));

const GOLD = JSON.parse(readFileSync(
  new URL("./fixtures/universal_search_object_gold.json", import.meta.url),
));
const OBSERVER_CANARIES = JSON.parse(readFileSync(
  new URL("../architecture/observer-canaries.json", import.meta.url),
));

const SNAPSHOT_AS_OF = "2026-08-15T12:00:00Z";
const LA7_SEARCH_CANARY_PATHS = Object.freeze([
  "worker/src/search.mjs",
  "tools/build_keyword_search_index.mjs",
  "site/agency_search_producer.mjs",
]);

function matchField(document, query) {
  const normalized = query.toLocaleLowerCase("en-US");
  const fields = document.provenance?.match_fields || {};
  if (String(fields.display_name || "").toLocaleLowerCase("en-US").includes(normalized)) {
    return "display_name";
  }
  if ((fields.aliases || []).some((alias) => alias.toLocaleLowerCase("en-US").includes(normalized))) {
    return "alias";
  }
  return "title";
}

function corpusLens(documents, coverage, rank) {
  return {
    async search({ query, limit }) {
      const ranked = rank(documents, query, { limit });
      return {
        candidates: ranked.map((document, index) => ({
          document,
          local_score: index + 1,
          match_fields: [{
            field: matchField(document, query),
            matched_term: query,
            source_observation_ref: document.source_observation_refs[0],
          }],
        })),
        coverage: {
          state: coverage.state,
          reason: coverage.reason,
          indexed_count: coverage.indexed_count,
          as_of: SNAPSHOT_AS_OF,
          source: coverage.producer,
          method: "fixture_lexical_rank_v1",
        },
      };
    },
  };
}

function completeLens(candidates = [], overrides = {}) {
  return {
    async search() {
      return {
        candidates,
        coverage: {
          state: candidates.length ? "matched" : "empty",
          indexed_count: candidates.length,
          as_of: SNAPSHOT_AS_OF,
          source: "committed fixture read model",
          method: "fixture_exact_v1",
          ...overrides,
        },
      };
    },
  };
}

function candidate(document, term) {
  return {
    document,
    local_score: 1,
    match_fields: [{
      field: matchField(document, term),
      matched_term: term,
      source_observation_ref: document.source_observation_refs[0],
    }],
  };
}

test("committed person, agency, and vendor fixtures survive their canonical lenses", async () => {
  const people = buildPeopleSearchDocuments(PEOPLE);
  const agencies = buildAgencySearchDocuments(AGENCIES, { identityReport: AGENCY_IDENTITIES });
  const vendors = buildVendorSearchDocuments(VENDORS, { aliasRegistry: VENDOR_ALIASES });
  const cases = [
    {
      query: "Christopher Marte",
      lens: "people",
      expected: "person:7801",
      provider: corpusLens(people.documents, people.coverage, rankPeopleSearchDocuments),
    },
    {
      query: "Department of Parks and Recreation",
      lens: "agencies",
      expected: "agency:id:parks-and-recreation",
      provider: corpusLens(agencies.documents, agencies.coverage, (documents, query, { limit }) => (
        documents.filter((document) => document.search_text.toLocaleLowerCase("en-US")
          .includes(query.toLocaleLowerCase("en-US"))).slice(0, limit)
      )),
    },
    {
      query: "AECOM",
      lens: "vendors",
      expected: "vendor:stem:AECOM",
      provider: corpusLens(vendors.documents, vendors.coverage, rankVendorSearchDocuments),
    },
  ];

  for (const fixture of cases) {
    const response = await federateUniversalSearch({
      query: fixture.query,
      lenses: { [fixture.lens]: fixture.provider },
    });
    assert.ok(response.results.some((row) => row.stable_key === fixture.expected), fixture.query);
  }
});

test("complete_count is the sum of declared per-lens counts at one snapshot boundary", async () => {
  const agency = buildAgencySearchDocuments(AGENCIES, {
    identityReport: AGENCY_IDENTITIES,
  }).documents.find((document) => document.object_ref === "agency:id:parks-and-recreation");
  assert.ok(agency);
  const lenses = Object.fromEntries(UNIVERSAL_SEARCH_LENS_IDS.map((lensId) => (
    [lensId, completeLens(lensId === "agencies" ? [candidate(agency, "parks")] : [])]
  )));

  const response = await federateUniversalSearch({ query: "parks", lenses });
  const declaredSum = Object.values(response.coverage.by_lens)
    .reduce((sum, lens) => sum + lens.matched_count, 0);

  assert.equal(response.coverage.snapshot.state, "complete");
  assert.equal(response.coverage.snapshot.as_of, SNAPSHOT_AS_OF);
  assert.equal(response.coverage.complete_count, declaredSum);
  assert.equal(response.coverage.complete_count, 1);

  const view = buildUniversalSearchCoverageView(response.coverage);
  const html = renderUniversalSearchCoverageHtml(response.coverage);
  assert.equal(view.complete_count, response.coverage.complete_count);
  assert.equal(view.lenses.find((lens) => lens.lens === "agencies").matched_count, 1);
  assert.match(html, /1 match across all indexed collections/);
  assert.match(html, /data-coverage-lens="agencies"[^>]*data-coverage-state="matched"/);
});

test("honest empty is a complete zero, not missing coverage", async () => {
  const lenses = Object.fromEntries(UNIVERSAL_SEARCH_LENS_IDS.map((lensId) => (
    [lensId, completeLens()]
  )));
  const response = await federateUniversalSearch({
    query: "zzzx-no-such-civic-object",
    lenses,
  });
  const view = buildUniversalSearchCoverageView(response.coverage);
  const html = renderUniversalSearchCoverageHtml(response.coverage);

  assert.equal(response.results.length, 0);
  assert.equal(response.coverage.snapshot.state, "complete");
  assert.equal(response.coverage.complete_count, 0);
  assert.equal(response.coverage.all_lenses_participated, true);
  for (const lensId of UNIVERSAL_SEARCH_LENS_IDS) {
    assert.equal(response.coverage.by_lens[lensId].state, "empty", lensId);
  }
  assert.match(view.headline, /0 matches across all indexed collections/);
  assert.match(html, /0 matches across all indexed collections/);
});

test("unindexed collections do not collapse into a citywide zero", async () => {
  const response = await federateUniversalSearch({
    query: "shelter contracts",
    lenses: {},
  });
  const view = buildUniversalSearchCoverageView(response.coverage);
  const html = renderUniversalSearchCoverageHtml(response.coverage);

  assert.equal(response.results.length, 0);
  assert.equal(response.coverage.snapshot.state, "incomplete");
  assert.equal(response.coverage.complete_count, null);
  assert.equal(response.coverage.all_lenses_participated, false);
  for (const lensId of UNIVERSAL_SEARCH_LENS_IDS) {
    assert.equal(response.coverage.by_lens[lensId].state, "not_indexed", lensId);
  }
  assert.match(view.headline, /Search coverage is incomplete/);
  assert.doesNotMatch(view.headline, /0 matches across all/);
  assert.doesNotMatch(html, /0 matches across all/);
});

test("missing and stale lenses invalidate complete_count instead of producing a false zero", async () => {
  const lenses = Object.fromEntries(UNIVERSAL_SEARCH_LENS_IDS.map((lensId) => (
    [lensId, completeLens()]
  )));
  delete lenses.people;
  lenses.vendors = completeLens([], {
    state: "stale",
    reason: "snapshot_expired",
    as_of: "2026-07-01T00:00:00Z",
  });

  const response = await federateUniversalSearch({ query: "not-present", lenses });

  assert.equal(response.results.length, 0);
  assert.equal(response.coverage.observed_count, 0);
  assert.equal(response.coverage.complete_count, null);
  assert.equal(response.coverage.snapshot.state, "incomplete");
  assert.deepEqual(response.coverage.incomplete_lenses, ["people", "vendors"]);
  assert.equal(response.coverage.by_lens.people.state, "not_indexed");
  assert.equal(response.coverage.by_lens.vendors.state, "stale");

  const view = buildUniversalSearchCoverageView(response.coverage);
  const html = renderUniversalSearchCoverageHtml(response.coverage);
  assert.equal(view.state, "incomplete");
  assert.equal(view.complete_count, null);
  assert.equal(view.lenses.find((lens) => lens.lens === "people").matched_count, null);
  assert.match(view.detail, /available collections/);
  assert.doesNotMatch(view.headline, /0 matches across all/);
  assert.doesNotMatch(html, /People<\/span><strong>0 matches/);
  assert.match(html, /data-coverage-lens="people"[^>]*data-coverage-state="not_indexed"/);
  assert.match(html, /data-coverage-lens="vendors"[^>]*data-coverage-state="stale"/);
});

test("coverage-honesty and LA7 unmapped-surface misses are one class", () => {
  const twin = GOLD.query_suite.coverage_honesty_twin;
  assert.ok(twin);
  assert.equal(twin.feeds, "LA7");
  assert.equal(twin.observer_canaries, "architecture/observer-canaries.json");
  assert.deepEqual(twin.canary_paths, [...LA7_SEARCH_CANARY_PATHS]);

  const facts = buildFacts({ generatedAt: "2026-08-16T00:00:00Z", commit: "test-commit" });
  const byId = new Map(OBSERVER_CANARIES.canaries.map((row) => [row.id, row]));
  for (const [index, path] of twin.canary_paths.entries()) {
    const id = twin.canary_ids[index];
    const listed = byId.get(id);
    assert.ok(listed, id);
    assert.equal(listed.path, path);
    assert.ok(
      facts.observer_coverage.known_canaries.some((row) => row.id === id && row.path === path),
      id,
    );
    assert.ok(facts.observer_coverage.observed_paths.includes(path), path);
    assert.equal(
      facts.observer_coverage.unmapped_surfaces.some((row) => row.path === path),
      false,
      path,
    );
  }

  const synthetic = buildObserverCoverage(
    ["worker/wrangler.toml"],
    twin.canary_ids.map((id, index) => ({ id, path: twin.canary_paths[index] })),
  );
  assert.deepEqual(
    synthetic.unmapped_surfaces.map((row) => row.path).sort(),
    [...LA7_SEARCH_CANARY_PATHS].sort(),
  );
});

test("coverage UI fails closed when an API response omits its machine receipt", () => {
  const view = buildUniversalSearchCoverageView(null);
  const html = renderUniversalSearchCoverageHtml(null);

  assert.equal(view.state, "unavailable");
  assert.equal(view.complete_count, null);
  assert.match(html, /Coverage details are unavailable/);
  assert.doesNotMatch(html, /No matches|0 matches/);
});
