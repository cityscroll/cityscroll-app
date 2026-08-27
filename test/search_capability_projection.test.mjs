import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  FEDERATED_SEARCH_LENS_IDS,
  FEDERATED_SEARCH_RESULT_SCHEMA,
  FEDERATED_SEARCH_SCHEMA,
} from "../capabilities/federated_search.mjs";
import { canonicalSearchCoverage } from "../site/search_capability_projection.mjs";

const searchDocumentSource = readFileSync(
  fileURLToPath(new URL("../site/search_document.mjs", import.meta.url)),
  "utf8",
);
const searchEntrySource = readFileSync(
  fileURLToPath(new URL("../site/search_entry.mjs", import.meta.url)),
  "utf8",
);

function federatedEnvelope(coverage, results = []) {
  return {
    schema: FEDERATED_SEARCH_SCHEMA,
    query: { normalized: "parks", tokens: ["parks"] },
    ranking_policy: { policy: "cityscroll.cross_lens_rank.v1" },
    results,
    coverage,
  };
}

function coverage(state = "matched") {
  return {
    by_lens: Object.fromEntries(FEDERATED_SEARCH_LENS_IDS.map((lens) => [lens, {
      lens,
      participated: true,
      state,
      reason: null,
      matched_count: 0,
      candidate_count: 0,
      invalid_candidate_count: 0,
      indexed_count: 1,
      as_of: "2026-08-15T12:00:00Z",
      source: "test fixture",
      method: "fixture_v1",
    }])),
  };
}

test("Search capability code is route-scoped behind a dynamic import", () => {
  assert.doesNotMatch(searchDocumentSource, /from ["']\.\/search_capability_projection\.mjs/);
  assert.match(searchDocumentSource, /import\(["']\.\/search_capability_projection\.mjs["']\)/);
  assert.match(searchEntrySource, /import\(["']\.\/search_document\.mjs["']\)/);
});

test("Search consumes coverage from the canonical federated capability envelope", async () => {
  const canonical = coverage("partial");
  const legacy = { schema: "cityscroll.universal_search_coverage.v1", state: "complete" };
  assert.deepEqual(
    await canonicalSearchCoverage({
      federated: federatedEnvelope(canonical),
      coverage: legacy,
    }),
    canonical,
  );
});

test("Search keeps legacy coverage when a degraded adapter omits or corrupts the envelope", async () => {
  const legacy = { schema: "cityscroll.universal_search_coverage.v1", state: "complete" };
  assert.deepEqual(await canonicalSearchCoverage({ coverage: legacy }), legacy);
  assert.deepEqual(await canonicalSearchCoverage({
    federated: federatedEnvelope({ by_lens: {} }),
    coverage: legacy,
  }), legacy);
});

test("canonical validation still enforces typed result evidence", async () => {
  const canonical = coverage();
  const result = {
    result_schema: FEDERATED_SEARCH_RESULT_SCHEMA,
    object_ref: "person:parks",
    object_type: "person",
    canonical_href: "/people/parks/",
    source_observation_refs: ["fixture:person:parks"],
    provenance: { producer: "fixture_v1" },
    match_fields: [{ field: "title", matched_term: "parks" }],
  };
  assert.deepEqual(
    await canonicalSearchCoverage({ federated: federatedEnvelope(canonical, [result]) }),
    canonical,
  );
});
