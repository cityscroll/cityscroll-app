import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BOROUGHS,
  boroughMapPivotHref,
  boroughScopeHref,
  boroughScopeLinksHTML,
} from "../site/borough_scope_links.mjs";
import {
  communityBoardSearchPresentation,
  parseCommunityBoardQuery,
} from "../site/community_board_search.mjs";

const index = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const propertyTimedCases = JSON.parse(readFileSync(
  new URL("./fixtures/property_timed_events/real_notices.json", import.meta.url),
  "utf8",
)).cases;
const ruleCase = JSON.parse(readFileSync(
  new URL("./fixtures/rules_stage/20260728026.json", import.meta.url),
  "utf8",
)).record;

test("borough scope links preserve real Property and Rules notice scopes", () => {
  const hearing = propertyTimedCases.find((item) => item.row.request_id === "20241112003");
  assert.ok(hearing, "real Property disposition characterization notice is present");
  assert.equal(
    boroughScopeHref("property", "Brooklyn", `#property?q=${hearing.row.request_id}&process=hearing`),
    `#property?q=${hearing.row.request_id}&process=hearing&boro=Brooklyn`,
  );
  assert.equal(
    boroughScopeHref("rules", "Queens", `#rules?q=${ruleCase.request_id}&process=proposal`),
    `#rules?q=${ruleCase.request_id}&process=proposal&boro=Queens`,
  );
  assert.equal(
    boroughScopeHref("rules", "citywide", "#rules?boro=Bronx&process=proposal"),
    "#rules?process=proposal&scope=citywide",
  );
});

test("borough map pivots carry the same Zoning scope into Near you", () => {
  assert.equal(
    boroughMapPivotHref("zoning", "Queens", "#land?q=2022M0258&status=hearings"),
    "/near-you/?v=0&lens=land&q=2022M0258&boro=Queens&facet=%7B%22status%22%3A%22hearings%22%7D",
  );
});

test("rails expose pressed filter chips with a named group and one current state", () => {
  const html = boroughScopeLinksHTML({
    surface: "property",
    selected: "Brooklyn",
    currentHash: "#property?process=hearing",
  });
  assert.match(html, /data-borough-scope="property"/);
  assert.match(html, /role="group"/);
  assert.match(html, /aria-pressed="true"[^>]*data-borough-scope-link="Brooklyn"/);
  assert.match(html, /data-borough-scope-link="Brooklyn"[^>]*data-scope-edge="property\.borough\.Brooklyn"/);
  assert.match(html, /data-borough-map-pivot="property"/);
  assert.match(html, /data-borough-map-pivot="property"[^>]*data-scope-edge="property\.map\.borough\.Brooklyn"/);
  assert.equal((html.match(/data-borough-scope-link=/g) || []).length, BOROUGHS.length + 1);
  assert.doesNotMatch(html, /<select/);
});

test("the four in-scope surfaces retire their borough selects", () => {
  for (const id of ["land-borough-rail", "property-borough-rail", "rules-borough-rail"]) {
    assert.match(index, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(index, /id="(?:lboro|propertyboro|rulesboro)"/);
});

test("bare CB3 uses explicit M03 context as a visible, overridable default", () => {
  const query = parseCommunityBoardQuery("community board 3");
  const presentation = communityBoardSearchPresentation(query, {
    communityDistrict: "M03",
    source: "route",
  });

  assert.equal(presentation.defaultBodyId, "manhattan-cb-03");
  assert.equal(presentation.defaultLabel, "Manhattan CB3");
  assert.equal(presentation.choices.length, 5);
  assert.equal(presentation.choices.find((choice) => choice.bodyId === "manhattan-cb-03")?.preferred, true);

  const override = communityBoardSearchPresentation(query, {
    communityDistrict: "M03",
    selectedBodyId: "bronx-cb-03",
    source: "user",
  });
  assert.equal(override.defaultBodyId, "bronx-cb-03");
  assert.equal(override.defaultLabel, "Bronx CB3");
});

test("bare CB3 stays tied without civic context and ignores a general IP guess", () => {
  const query = parseCommunityBoardQuery("community board 3");
  assert.equal(communityBoardSearchPresentation(query).defaultBodyId, null);
  assert.equal(communityBoardSearchPresentation(query, {
    borough: "Manhattan",
    source: "ip",
  }).defaultBodyId, null);
});
