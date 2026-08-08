import assert from "node:assert/strict";
import { test } from "node:test";

import { agencyScopeHref } from "../site/agency_scope_route.mjs";
import { scopeFromRouteHash } from "../site/scope_v0.mjs";

test("meeting agency links preserve borough and date scope in the shared route grammar", () => {
  const href = agencyScopeHref("meetings", "Parks and Recreation", "#meetings?when=all&boro=Brooklyn");
  assert.equal(href, "#meetings?agency=Parks+and+Recreation&when=all&boro=Brooklyn");

  const scope = scopeFromRouteHash(href);
  assert.deepEqual(scope.facets.agencies, ["Parks and Recreation"]);
  assert.deepEqual(scope.place.boroughs, ["Brooklyn"]);
  assert.equal(scope.time_window.preset, "all");
});
