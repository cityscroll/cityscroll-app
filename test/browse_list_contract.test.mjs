import assert from "node:assert/strict";
import test from "node:test";

import {
  browseListParams,
  browseListShareSearch,
  browseListState,
  filterConfiguredBrowseRows,
  PEOPLE_ORGANIZATIONS_BROWSE_CONFIG,
} from "../site/browse_list_contract.mjs";

const model = {
  generated_at: "2026-08-11T19:21:19.284Z",
  rows: [
    { kind: "official", search_text: "Christopher Marte official" },
    { kind: "exact-person-appointment", search_text: "Christopher Marte appointment" },
    { kind: "community-board", search_text: "Bronx Community Board 1" },
  ],
  counts: { official: 1, "exact-person-appointment": 1, "community-board": 1 },
};

test("People Browse contract keeps typed facets exact and shareable", () => {
  const params = new URLSearchParams("q=Christopher%20Marte&type=official&type=not-a-kind");
  assert.deepEqual(browseListParams(params), { query: "Christopher Marte", facet: "official" });
  assert.deepEqual(filterConfiguredBrowseRows(model.rows, params), [model.rows[0]]);
  assert.equal(browseListShareSearch({ query: "Christopher Marte", facet: "not-a-kind" }).toString(), "q=Christopher+Marte");
});

test("People Browse contract preserves complete-model matching and freshness state", () => {
  const state = browseListState(model, new URLSearchParams("q=Christopher"));
  assert.equal(state.total, 3);
  assert.equal(state.matched, 2);
  assert.equal(state.generatedAt, model.generated_at);
  assert.equal(state.status, "published");
});

test("People Browse contract distinguishes empty and unknown model states", () => {
  assert.equal(browseListState({ rows: [], generated_at: "2026-08-11" }).status, "empty");
  assert.equal(browseListState({ rows: [] }).status, "unknown");
  assert.equal(PEOPLE_ORGANIZATIONS_BROWSE_CONFIG.initialPageSize, 16);
  assert.equal(PEOPLE_ORGANIZATIONS_BROWSE_CONFIG.pageSize, 24);
});
