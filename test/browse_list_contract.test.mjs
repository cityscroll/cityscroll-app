import assert from "node:assert/strict";
import test from "node:test";

import {
  browseListParams,
  browseListShareSearch,
  browseListState,
  filterConfiguredBrowseRows,
  PEOPLE_ORGANIZATIONS_BROWSE_CONFIG,
} from "../site/browse_list_contract.mjs";
import {
  ORGANIZATIONS_BROWSE_CAPABILITY_REFERENCE,
  validateOrganizationsBrowseInput,
  validateOrganizationsBrowseOutput,
} from "../capabilities/people_organizations.mjs";
import { organizationsBrowseFromModel } from "../capabilities/people_organizations_provider.mjs";

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
  assert.deepEqual(browseListParams(params), { query: "Christopher Marte", facet: "official", institution: "", role: "" });
  assert.deepEqual(filterConfiguredBrowseRows(model.rows, params), [model.rows[0]]);
  assert.equal(browseListShareSearch({ query: "Christopher Marte", facet: "not-a-kind" }).toString(), "q=Christopher+Marte");
  assert.deepEqual(
    filterConfiguredBrowseRows([
      { kind: "community-board-person", institution: "community-board", role_family: "staff", search_text: "Jesus Perez" },
      { kind: "official", institution: "city-council", role_family: "member", search_text: "Jesus Perez" },
    ], "institution=community-board&role=staff"),
    [{ kind: "community-board-person", institution: "community-board", role_family: "staff", search_text: "Jesus Perez" }],
  );
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

test("People Browse UI and public capability share matching and paging semantics", () => {
  const rows = Array.from({ length: 205 }, (_, index) => ({
    kind: index % 2 ? "agency" : "official",
    id: `${index % 2 ? "agency:id" : "official"}:${index}`,
    label: `Published ${index % 2 ? "Agency" : "Official"} ${index}`,
    relation_state: "published",
    search_text: `published ${index % 2 ? "agency" : "official"} parks ${index}`,
  }));
  const model = { schema: "cityscroll.people_organizations_read_model.v1", rows, generated_at: "2026-08-18" };
  const input = { query: "parks", kind: "agency", limit: 100 };
  validateOrganizationsBrowseInput(input);
  const publicResult = validateOrganizationsBrowseOutput(organizationsBrowseFromModel(model, input), input);
  const uiRows = filterConfiguredBrowseRows(rows, new URLSearchParams("q=parks&type=agency"));

  assert.equal(publicResult.capability_reference, ORGANIZATIONS_BROWSE_CAPABILITY_REFERENCE);
  assert.equal(publicResult.total_matches, 102);
  assert.equal(uiRows.length, publicResult.total_matches);
  assert.deepEqual(uiRows.map((row) => row.id), rows.filter((row) => row.kind === "agency").map((row) => row.id));
  assert.equal(publicResult.pagination.truncated, true);
});
