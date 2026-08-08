import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { agencyScopeHref, agencyScopeLinksHTML } from "../site/agency_scope_links.mjs";
import { attendanceScopeHref, attendanceScopeLinksHTML } from "../site/attendance_scope_links.mjs";
import { scopeFromRouteHash } from "../site/scope_v0.mjs";

const index = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");

test("Zoning Attendance replaces the select with typed links and preserves the scope", () => {
  const current = "#land?boro=Queens&q=2022M0258&status=hearings&facet=%7B%22entity_refs_all%22%3A%5B%22project:2022M0258%22%5D%7D";
  const href = attendanceScopeHref("hybrid", current);
  const scope = scopeFromRouteHash(href);

  assert.equal(scope.facets.domains[0], "land");
  assert.equal(scope.place.boroughs[0], "Queens");
  assert.equal(scope.topic.query, "2022M0258");
  assert.equal(scope.facets.values.status, "hearings");
  assert.equal(scope.facets.values.attendance, "hybrid");
  assert.deepEqual(scope.facets.values.entity_refs_all, ["project:2022M0258"]);

  const html = attendanceScopeLinksHTML({ selected: "hybrid", currentHash: current });
  assert.match(html, /data-attendance-scope-link="hybrid"[^>]*data-scope-edge="land\.attendance\.hybrid"[^>]*aria-current="page"/);
  assert.doesNotMatch(html, /<select|<button/);
  assert.doesNotMatch(index, /id="lhearingmode"/);
  assert.match(index, /id="land-attendance-rail"/);
});

test("Rules Agency uses a canonical typed edge while preserving other Rules facets", () => {
  const current = "#rules?boro=Brooklyn&q=sidewalk&process=proposal&facet=%7B%22entity_refs_all%22%3A%5B%22bbl:1020260015%22%2C%22agency:id:buildings%22%5D%7D";
  const href = agencyScopeHref("rules", "Department of Buildings", current);
  const scope = scopeFromRouteHash(href);

  assert.equal(scope.facets.domains[0], "rules");
  assert.equal(scope.place.boroughs[0], "Brooklyn");
  assert.equal(scope.topic.query, "sidewalk");
  assert.equal(scope.facets.values.process, "proposal");
  assert.deepEqual(scope.facets.values.entity_refs_all, ["agency:id:buildings", "bbl:1020260015"]);
  assert.equal(scope.facets.agencies.length, 0, "canonical agency scope does not duplicate a readable agency query");

  const html = agencyScopeLinksHTML({
    surface: "rules",
    agencies: [{ agency_name: "Department of Buildings" }],
    selected: "Department of Buildings",
    currentHash: current,
  });
  assert.match(html, /data-agency-scope-link="buildings"[^>]*data-scope-edge="rules\.agency\.buildings"[^>]*aria-current="page"/);
  assert.doesNotMatch(html, /<select|<button/);
  assert.doesNotMatch(index, /id="rulesagency"/);
  assert.match(index, /id="rules-agency-rail"/);
});
