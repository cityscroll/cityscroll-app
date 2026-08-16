import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildBoardSearchDocuments,
  projectBoardSearchDocument,
} from "../site/board_search_producer.mjs";

function lookup(overrides = {}) {
  return {
    schema: "cityscroll.community_board_constellation.v1",
    method: "community_board_constellation_v1",
    generated_at: "2026-08-13",
    board_count: 1,
    by_id: {
      "brooklyn-cb-03": {
        body_id: "brooklyn-cb-03",
        display_name: "Brooklyn Community Board 3",
        path: "/community-boards/brooklyn-cb-03/",
        summary: { matched_categories: 2, category_count: 5 },
        edge_summary: [{
          edge_type: "covers",
          relation_label: "District coverage",
          target_name: "Brooklyn Community District 3",
          state: "matched",
          provenance: { observed_at: "2026-08-12T00:00:00.000Z" },
        }],
      },
    },
    ...overrides,
  };
}

test("community-board documents preserve borough identity, aliases, route, and coverage", () => {
  const source = lookup();
  const row = source.by_id["brooklyn-cb-03"];
  const result = projectBoardSearchDocument("brooklyn-cb-03", row, { lookup: source });
  assert.equal(result.outcome, "indexed");
  assert.equal(result.document.object_ref, "community-board:brooklyn-cb-03");
  assert.equal(result.document.object_type, "community_board");
  assert.equal(result.document.domain, "places");
  assert.equal(result.document.canonical_href, "/community-boards/brooklyn-cb-03/");
  assert.deepEqual(result.document.source_observation_refs, [
    "community_board_registry:brooklyn-cb-03",
  ]);
  assert.ok(result.document.search_text.includes("Community Board 3, Brooklyn"));
  assert.ok(result.document.search_text.includes("Brooklyn CB3"));
  assert.equal(result.document.provenance.coverage.matched_categories, 2);
});

test("ambiguous or inconsistent board identities fail closed", () => {
  const source = lookup();
  const unresolved = projectBoardSearchDocument("cb-03", {
    body_id: "cb-03",
    display_name: "Community Board 3",
    path: "/community-boards/cb-03/",
  }, { lookup: source });
  assert.equal(unresolved.outcome, "unclassified");
  assert.equal(unresolved.document, null);

  const partial = buildBoardSearchDocuments(lookup({
    board_count: 2,
    by_id: {
      ...source.by_id,
      "queens-cb-03": {
        body_id: "queens-cb-03",
        display_name: "Queens Community Board 3",
        path: "/community-boards/wrong/",
      },
    },
  }));
  assert.equal(partial.coverage.state, "partial");
  assert.equal(partial.documents.length, 1);
  assert.equal(buildBoardSearchDocuments(lookup({ board_count: 0, by_id: {} })).coverage.state, "empty");
  assert.equal(buildBoardSearchDocuments({}).coverage.state, "not_indexed");
});

test("the committed constellation emits all 59 borough-qualified board identities", () => {
  const source = JSON.parse(readFileSync(new URL("../site/data/community_board_constellation_lookup.json", import.meta.url)));
  const corpus = buildBoardSearchDocuments(source);
  assert.equal(corpus.coverage.state, "matched");
  assert.equal(corpus.documents.length, 59);
  assert.equal(corpus.documents.length, source.board_count);
});
