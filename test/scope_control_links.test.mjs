import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { agencyScopeHref, agencyScopeLinksHTML } from "../site/agency_scope_links.mjs";
import { attendanceScopeHref, attendanceScopeLinksHTML, landClosingWeekHash, landTemporalScopeLinksHTML } from "../site/attendance_scope_links.mjs";
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
  assert.match(html, /aria-pressed="true"[^>]*data-attendance-scope-link="hybrid"[^>]*data-scope-edge="land\.attendance\.hybrid"/);
  assert.doesNotMatch(html, /<select/);
  assert.match(html, /<button[^>]+data-filter-href/);
  assert.doesNotMatch(index, /id="lhearingmode"/);
  assert.match(index, /id="land-attendance-rail"/);
});

test("Zoning closing-week is a temporal scope chip and round-trips with attendance", () => {
  const current = "#land?boro=Queens&status=hearings&attendance=hybrid";
  const href = landClosingWeekHash(current);
  const scope = scopeFromRouteHash(href);
  assert.equal(scope.time_window.preset, "closing:week");
  assert.equal(scope.facets.values.attendance, "hybrid");
  assert.match(landTemporalScopeLinksHTML({ active: true, currentHash: href }), /data-scope-edge="land\.time\.closing_week"/);
  assert.match(landTemporalScopeLinksHTML({ active: true, currentHash: href }), /data-filter-href="#land\?boro=Queens&amp;status=hearings/);
  assert.equal(scopeFromRouteHash(landClosingWeekHash(href, false)).time_window.preset, null);
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
  assert.match(html, /class="ui-filter-chip[^"]*agency-scope-link" aria-pressed="true"[^>]*data-agency-scope-link="buildings"[^>]*data-filter-href=/);
  assert.match(html, /data-scope-edge="rules\.agency\.buildings"/);
  assert.doesNotMatch(html, /<select/);
  assert.doesNotMatch(index, /id="rulesagency"/);
  assert.match(index, /id="rules-agency-rail"/);
});
