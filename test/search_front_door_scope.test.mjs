import assert from "node:assert/strict";
import test from "node:test";

import { FEDERATED_SEARCH_PRESENTATION_SCOPES } from "../capabilities/federated_search.mjs";
import {
  SEARCH_FRONT_DOOR_SCOPES,
  searchFrontDoorHref,
  searchFrontDoorRequestPath,
  searchFrontDoorScopeFromParams,
} from "../site/search_front_door_scope.mjs";

test("an absent source_scope parameter resolves to the all-sources default", () => {
  assert.equal(
    searchFrontDoorScopeFromParams(new URLSearchParams("q=rats")).id,
    "all",
  );
});

test("an unrecognized source_scope value degrades to all-sources, never throws", () => {
  const scope = searchFrontDoorScopeFromParams(new URLSearchParams("q=rats&source_scope=meetings"));
  assert.equal(scope.id, "all");
});

test("a registered source_scope value resolves to that scope", () => {
  assert.equal(
    searchFrontDoorScopeFromParams(new URLSearchParams("q=rats&source_scope=contracts")).id,
    "contracts",
  );
});

test("the front-door scope parameter is source_scope, not the pre-existing place scope parameter", () => {
  // /search/ already uses a bare `scope` query parameter for place/Area
  // context (PLACE_KEYS in site/search_document.mjs). A resident who
  // arrives with both must keep the meaning of each, never one silently
  // overriding the other.
  const params = new URLSearchParams("q=rats&scope=cb&source_scope=contracts");
  assert.equal(searchFrontDoorScopeFromParams(params).id, "contracts");
  assert.equal(params.get("scope"), "cb");
});

test("the Contracts scope reuses the registered Contracts presentation scope, not an invented facet", () => {
  const contracts = SEARCH_FRONT_DOOR_SCOPES.contracts;
  assert.deepEqual([...contracts.lenses], [...FEDERATED_SEARCH_PRESENTATION_SCOPES.contracts.lenses]);
  assert.deepEqual([...contracts.domains], [...FEDERATED_SEARCH_PRESENTATION_SCOPES.contracts.domains]);
});

test("the all-sources scope has no domain allowlist: nothing is out of scope", () => {
  assert.equal(SEARCH_FRONT_DOOR_SCOPES.all.domains, null);
  assert.equal(SEARCH_FRONT_DOOR_SCOPES.all.lenses, null);
});

test("each scope's narrow target is the other registered scope", () => {
  assert.equal(SEARCH_FRONT_DOOR_SCOPES.all.narrow_target, "contracts");
  assert.equal(SEARCH_FRONT_DOOR_SCOPES.contracts.narrow_target, "all");
});

test("the all-sources request path omits scope, matching the capability's own omitted-scope address", () => {
  assert.equal(searchFrontDoorRequestPath("all", "rats"), "/search?q=rats");
});

test("the Contracts request path serializes the registered Contracts lenses", () => {
  const path = searchFrontDoorRequestPath("contracts", "rats");
  const params = new URLSearchParams(path.split("?")[1]);
  assert.equal(params.get("q"), "rats");
  assert.deepEqual(params.getAll("scope"), [...FEDERATED_SEARCH_PRESENTATION_SCOPES.contracts.lenses]);
});

test("an unrecognized scope id falls back to the all-sources request path", () => {
  assert.equal(searchFrontDoorRequestPath("not-a-scope", "rats"), "/search?q=rats");
});

test("the all-sources href omits source_scope entirely, matching a legacy deep link", () => {
  const href = searchFrontDoorHref("all", new URLSearchParams("q=rats&source_scope=contracts"));
  assert.equal(href, "/search/?q=rats");
});

test("the Contracts href sets source_scope while preserving every other parameter", () => {
  const href = searchFrontDoorHref("contracts", new URLSearchParams("q=rats&boro=Manhattan&lang=es"));
  const [path, query] = href.split("?");
  assert.equal(path, "/search/");
  const params = new URLSearchParams(query);
  assert.equal(params.get("q"), "rats");
  assert.equal(params.get("boro"), "Manhattan");
  assert.equal(params.get("lang"), "es");
  assert.equal(params.get("source_scope"), "contracts");
});

test("a query with no other parameters and the all-sources scope reduces to the bare /search/ address", () => {
  assert.equal(searchFrontDoorHref("all", new URLSearchParams()), "/search/");
});
