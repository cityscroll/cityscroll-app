import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import test from "node:test";

import {
  scopeFromLensState,
} from "../site/scope_v0.mjs";
import {
  commonNearYouPath,
  nearYouUrlFromScope,
  scopeFromNearYouUrl,
  scopeWithPlace,
} from "../site/near_you_scope.mjs";
import {
  buildNearYouViewModel,
  renderNearYouDocument,
} from "../site/near_you_view.mjs";

const COUNTS = Object.freeze({ land: 0, property: 0, rules: 0, meetings: 0, money: 0 });

function fixtureActivity() {
  return {
    schema: "cityscroll.district_activity.v1",
    boundary_vintage: "2026-05-26",
    built_at: "2026-08-04T12:00:00.000Z",
    levels: ["borough", "community_district", "council_district"],
    lenses: ["land", "property", "rules", "meetings", "money"],
    by_level: {
      borough: {
        Manhattan: { ...COUNTS },
        Bronx: { ...COUNTS },
        Brooklyn: { ...COUNTS },
        Queens: { ...COUNTS, meetings: 1 },
        "Staten Island": { ...COUNTS },
      },
      community_district: {},
      council_district: {},
    },
    citywide: { ...COUNTS, meetings: 1 },
    virtual: { ...COUNTS, meetings: 1 },
    unlocated: { ...COUNTS, meetings: 1 },
    unlocated_reasons: { meetings: { body_place_omitted: 1 } },
    sources: {
      meetings: { corpus: "fixture", counted: 4, located: 3, by_method: { matter_title_place: 1 } },
    },
    district_items: {
      schema: "cityscroll.district_items.v1",
      boundary_vintage: "2026-05-26",
      built_at: "2026-08-04T12:00:00.000Z",
      lenses: ["land", "property", "rules", "meetings", "money"],
      by_level: {
        borough: {
          Queens: { meetings: ["m-queens"] },
        },
        community_district: {},
        council_district: {},
      },
      citywide: { meetings: ["m-citywide"] },
      virtual: { meetings: ["m-virtual"] },
      unlocated: { meetings: ["m-unlocated"] },
    },
    records: {
      meetings: {
        "m-queens": {
          id: "m-queens",
          title: "Queens curb redesign hearing",
          agency: "Transportation",
          type: "Public Hearings",
          date: "2026-08-12T18:00:00.000",
          basis: "Affected area",
          confidence: "strong",
          route: "/#notice/m-queens",
        },
        "m-citywide": {
          id: "m-citywide",
          title: "Citywide accessibility hearing",
          agency: "Transportation",
          type: "Public Hearings",
          date: "2026-08-13T18:00:00.000",
          basis: "Citywide",
          confidence: "strong",
          route: "/#notice/m-citywide",
        },
        "m-virtual": {
          id: "m-virtual",
          title: "Online-only board meeting",
          agency: "Community Board",
          type: "Meeting",
          basis: "Virtual",
          confidence: "strong",
          route: "/#notice/m-virtual",
        },
        "m-unlocated": {
          id: "m-unlocated",
          title: "Meeting with no place signal",
          agency: "Community Board",
          type: "Meeting",
          basis: "No place signal",
          confidence: "unknown",
          route: "/#notice/m-unlocated",
        },
      },
    },
    basis_layers: {},
  };
}

const fixtureBoundaries = {
  schema: "cityscroll.district_boundaries.v1",
  boundary_vintage: "2026-05-26",
  community_districts: [],
  council_districts: [],
};

test("Near you adds place to the shared scope without dropping lens, agency, type, or query", () => {
  const starting = scopeFromLensState("meetings", {
    agency: "Transportation",
    q: "curb",
    type: "Public Hearings",
    when: "month",
  });
  const narrowed = scopeWithPlace(starting, { borough: "Queens" });
  const url = nearYouUrlFromScope(narrowed, { base: "https://api.cityscroll.org/near-you" });
  const replayed = scopeFromNearYouUrl(url);

  assert.deepEqual(replayed.facets.domains, ["meetings"]);
  assert.deepEqual(replayed.facets.agencies, ["Transportation"]);
  assert.equal(replayed.facets.values.type, "Public Hearings");
  assert.equal(replayed.topic.query, "curb");
  assert.equal(replayed.time_window.preset, "month");
  assert.deepEqual(replayed.place.boroughs, ["Queens"]);
  assert.match(url, /v=0/);
});

test("only exact common scopes use static documents", () => {
  const common = scopeWithPlace(scopeFromLensState("land", {}), { borough: "Queens" });
  assert.equal(commonNearYouPath(common), "/near-you/borough/queens/land/");

  const uncommonViewport = structuredClone(common);
  uncommonViewport.place.viewport = {
    level: "council_district",
    id: null,
    parent: null,
    basis: "performance",
    view_box: null,
  };
  assert.equal(commonNearYouPath(uncommonViewport), null);

  const translated = structuredClone(common);
  translated.language = "es";
  assert.equal(commonNearYouPath(translated), null);
});

test("Near-you time presets constrain the same server-owned result IDs and map counts", () => {
  const activity = fixtureActivity();
  activity.built_at = "2026-08-04T12:00:00.000Z";
  const scope = scopeFromLensState("meetings", { when: "week" });
  const view = buildNearYouViewModel(scope, activity, fixtureBoundaries);

  assert.equal(view.results.count, 0);
  assert.equal(view.features.find((feature) => feature.id === "Queens")?.total, 0);
});

test("the shared renderer emits exact server-owned records, counts, map paths, area links, and special bags", () => {
  const scope = scopeWithPlace(
    scopeFromLensState("meetings", { agency: "Transportation" }),
    { borough: "Queens" },
  );
  const view = buildNearYouViewModel(scope, fixtureActivity(), fixtureBoundaries);
  const html = renderNearYouDocument(view, { canonicalBase: "https://api.cityscroll.org/near-you" });

  assert.equal(view.results.count, 1);
  assert.deepEqual(view.results.ids, ["m-queens"]);
  assert.match(html, /data-near-you-root/);
  assert.match(html, /data-results-count="1"/);
  assert.match(html, /data-record-id="m-queens"/);
  assert.match(html, /Queens curb redesign hearing/);
  assert.match(html, /Affected area/);
  assert.match(html, /data-map-id="Queens"[^>]+data-count="1"/);
  assert.match(html, /data-map-area="Queens"[^>]+data-count="1"/);
  assert.match(html, /data-bag="citywide"/);
  assert.match(html, /data-bag="virtual"/);
  assert.match(html, /data-bag="unlocated"/);
  assert.match(html, /m-citywide/);
  assert.match(html, /type="module" src="\/app\/map\.mjs"/);
  assert.match(html, /<form[^>]+method="get"/);
  assert.match(html, /rel="stylesheet" href="\/brand\.css"/);
  assert.match(html, /rel="stylesheet" href="\/civic-documents\.css"/);
  assert.doesNotMatch(html, /<style>/);
  assert.doesNotMatch(html, /#f5f0e6|#7a1f1f|Georgia/);
  assert.match(html, /class="document-brand brand-lockup home"/);
});

test("the map island adopts server markup and is absent from unrelated routes", () => {
  const main = readFileSync(new URL("../site/app/main.mjs", import.meta.url), "utf8");
  const island = readFileSync(new URL("../site/app/map.mjs", import.meta.url), "utf8");
  const index = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
  const routing = readFileSync(new URL("../site/app/routing.mjs", import.meta.url), "utf8");

  assert.doesNotMatch(main, /import\("\.\/map\.mjs"\)/);
  assert.doesNotMatch(index, /<script[^>]+app\/map\.mjs/);
  assert.doesNotMatch(island, /data-near-you-root[^\n]*(?:innerHTML|replaceChildren)/);
  assert.match(island, /querySelector\("\[data-near-you-root\]"\)/);
  assert.match(index, /href="\/near-you\/"[^>]+data-near-you-link/);
  assert.match(routing, /forwardLegacyMapToNearYou/);
});

test("the Near-you cold wire inventory stays below the 455,000-byte ceiling", () => {
  const files = [
    "../site/near-you/index.html",
    "../site/app/map.mjs",
    "../site/map_exploration.mjs",
    "../site/council_district_lookup.mjs",
    "../site/scope_v0.mjs",
  ];
  const bytes = files.reduce((sum, path) => sum + gzipSync(readFileSync(new URL(path, import.meta.url))).length, 0);
  assert.ok(bytes <= 455_000, `Near-you cold transfer ${bytes} exceeds 455,000 bytes`);
});
