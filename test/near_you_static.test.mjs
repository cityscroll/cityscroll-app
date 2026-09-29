import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";

import {
  scopeFromLensState,
} from "../site/scope_v0.mjs";
import {
  commonNearYouPath,
  nearYouUrlFromScope,
} from "../site/scope_v0.mjs";
import {
  scopeFromNearYouUrl,
  scopeWithPlace,
} from "../site/near_you_scope_runtime.mjs";
import {
  buildNearYouViewModel,
  renderNearYouDeferredBody,
  renderNearYouDeferredParts,
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
          place: { geographies: [{
            key: "geography:borough:4", type: "borough", label: "Queens", visibility: "public",
            location_role: "affected_area", basis: "Affected area", confidence: "strong",
            method: "matter_title_place", source_id: "fixture", boundary_vintage: "2026-05-26",
          }] },
          route: "/#notice/m-queens",
          why_here_candidates: [{
            schema: "cityscroll.near_you_explanation_path.v1",
            hop_count: 3,
            notice_href: "/notices/m-queens",
            location: {
              relation: "located_in",
              subject_ref: "borough:queens",
              kind: "borough",
              label: "Queens",
              place_role: "affected_area",
              method: "district_activity_placement_v1",
              placement_method: "matter_title_place",
            },
            agency: {
              id: "transportation",
              name: "Transportation",
              href: "/agencies/transportation/",
            },
            mandate: {
              relation: "requires_public_hearing",
              relation_label: "Public hearing for this duty",
              duty_text: "Hold a hearing before adopting the plan.",
              citation: "Local Law § 1",
              publication_tier: "deterministic",
            },
            provenance: {
              located_in_method: "district_activity_placement_v1",
              cross_spine_method: "notice_mandate_backlinks_v1",
              publication_tier: "deterministic",
            },
          }],
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
  const url = nearYouUrlFromScope(narrowed, { base: "https://cityscroll.org/near-you" });
  const replayed = scopeFromNearYouUrl(url);

  assert.deepEqual(replayed.facets.domains, ["meetings"]);
  assert.deepEqual(replayed.facets.agencies, ["Transportation"]);
  assert.equal(replayed.facets.values.type, "Public Hearings");
  assert.equal(replayed.topic.query, "curb");
  assert.equal(replayed.time_window.preset, "month");
  assert.deepEqual(replayed.place.boroughs, ["Queens"]);
  assert.equal(new URL(url).origin, "https://cityscroll.org");
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

test("Near-you distinguishes supported empty, populated, unsupported, and pending map states", () => {
  const emptyScope = scopeWithPlace(
    scopeFromLensState("meetings", { agency: "No matching agency" }),
    { borough: "Queens" },
  );
  const emptyView = buildNearYouViewModel(emptyScope, fixtureActivity(), fixtureBoundaries);
  assert.equal(emptyView.mapState, "empty");
  assert.equal(emptyView.results.count, 0);
  assert.match(renderNearYouDocument(emptyView), /data-near-map-state="empty"/);
  assert.match(renderNearYouDocument(emptyView), /data-count="0"/);

  const populatedView = buildNearYouViewModel(
    scopeWithPlace(scopeFromLensState("meetings", { agency: "Transportation" }), { borough: "Queens" }),
    fixtureActivity(),
    fixtureBoundaries,
  );
  assert.equal(populatedView.mapState, "populated");
  assert.equal(populatedView.results.count, 1);

  const unsupportedView = buildNearYouViewModel(
    scopeWithPlace(scopeFromLensState("people"), { borough: "Queens" }),
    fixtureActivity(),
    fixtureBoundaries,
  );
  const unsupportedHtml = renderNearYouDocument(unsupportedView);
  assert.equal(unsupportedView.mapState, "unsupported");
  assert.equal(unsupportedView.results.count, null);
  assert.match(unsupportedHtml, /data-near-map-state="unsupported"/);
  assert.equal(unsupportedView.localRecovery.state, "unsupported");
  assert.match(unsupportedHtml, /We can’t filter these people and organizations to this borough yet\./);
  assert.match(unsupportedHtml, /<a href="\/browse\/people\/" data-near-recovery="all-nyc">All NYC people and organizations<\/a>/);
  assert.doesNotMatch(unsupportedHtml, /data-map-(?:id|area)="[^"]+"[^>]+data-count="0"/);

  const pendingRecordsView = buildNearYouViewModel(
    emptyScope,
    fixtureActivity(),
    fixtureBoundaries,
    { dataState: "pending" },
  );
  const pendingRecordsHtml = renderNearYouDocument(pendingRecordsView);
  assert.equal(pendingRecordsView.dataState, "pending");
  assert.equal(pendingRecordsView.geometryState, "ready");
  assert.equal(pendingRecordsView.mapState, "ready");
  assert.equal(pendingRecordsView.results.count, null);
  assert.match(pendingRecordsHtml, /data-near-data-state="pending"/);
  assert.match(pendingRecordsHtml, /Loading matching records/);
  assert.doesNotMatch(pendingRecordsHtml, /data-count="0"/);

  const pendingGeometryView = buildNearYouViewModel(
    emptyScope,
    fixtureActivity(),
    fixtureBoundaries,
    { dataState: "ready", geometryState: "pending" },
  );
  const pendingGeometryHtml = renderNearYouDocument(pendingGeometryView);
  assert.equal(pendingGeometryView.mapState, "pending");
  assert.match(pendingGeometryHtml, /data-near-map-state="pending"/);
  assert.match(pendingGeometryHtml, /Map boundaries are still loading/);
});

test("Near-you record failures keep geometry healthy and preserve scoped retry", () => {
  const scope = scopeWithPlace(
    scopeFromLensState("meetings", { agency: "Transportation", q: "curb" }),
    { borough: "Queens" },
  );
  for (const trigger of ["http-error", "malformed-payload", "bounded-timeout"]) {
    const view = buildNearYouViewModel(scope, null, fixtureBoundaries, {
      dataState: "error",
      canonicalBase: "https://cityscroll.org/near-you",
    });
    const html = renderNearYouDocument(view);
    assert.equal(view.dataState, "error", trigger);
    assert.equal(view.geometryState, "ready", trigger);
    assert.equal(view.mapState, "ready", trigger);
    assert.equal(view.results.count, null, trigger);
    assert.match(html, /data-near-data-state="error"/, trigger);
    assert.match(html, /data-near-geometry-state="ready"/, trigger);
    assert.match(html, /data-near-map-state="ready"/, trigger);
    assert.match(html, /These meetings could not load\./, trigger);
    assert.doesNotMatch(html, /buyer_history_retry/, trigger);
    const retryHref = html.match(/<a href="([^"]+)" data-near-recovery="retry">/)?.[1]?.replaceAll("&amp;", "&");
    assert.ok(retryHref, trigger);
    assert.equal(new URL(retryHref).searchParams.get("agency"), "Transportation", trigger);
    assert.equal(new URL(retryHref).searchParams.get("boro"), "Queens", trigger);
    assert.equal(new URL(retryHref).searchParams.get("q"), "curb", trigger);
    assert.ok(html.indexOf('class="near-map-wrap"') < html.indexOf('data-near-recovery="retry"'), trigger);
    assert.doesNotMatch(html, /data-count="0"/, trigger);
  }
});

test("Near-you leads with a named community district and keeps exploration secondary", () => {
  const scope = scopeWithPlace(scopeFromLensState("meetings", { agency: "Transportation" }), {
    borough: "Brooklyn",
    communityDistrict: "K15",
  });
  const view = buildNearYouViewModel(scope, fixtureActivity(), fixtureBoundaries, {
    communityGeography: {
      public_edges: [{ type: "covers", from: "community-board:brooklyn-cb-15", to: "community-district:K15" }],
      nodes: [{
        id: "community-board:brooklyn-cb-15",
        name: "Brooklyn Community Board 15",
        properties: { body_id: "brooklyn-cb-15" },
      }],
    },
  });
  const html = renderNearYouDocument(view);
  assert.match(html, />Brooklyn Community District 15<\/h1>/);
  assert.match(html, /href="\/community-boards\/brooklyn-cb-15\/"[^>]*>Brooklyn Community Board 15<\/a>/);
  assert.match(html, />Topic: Meetings<\/span>/);
  assert.match(html, /Advanced filters/);
  assert.match(html, /Explore related records/);
  assert.doesNotMatch(html, /Graph entry/);
  assert.doesNotMatch(html, /No count for this family here/);
  assert.doesNotMatch(html, /Equivalent area list/);
  assert.match(html, /<h3>Areas<\/h3>/);
  assert.match(html, /data-remove-filter="agency"/);
  assert.match(html, /name="walk_query"/);
  assert.ok(html.indexOf("<h1>Brooklyn Community District 15</h1>") < html.indexOf(">Change place</summary>"));
  assert.ok(html.indexOf(">Change place</summary>") < html.indexOf('class="near-map-wrap"'));
  assert.ok(html.indexOf('class="near-map-wrap"') < html.indexOf('class="near-selected-context"'));
  assert.ok(html.indexOf('class="near-selected-context"') < html.indexOf(">Topic: Meetings</span>"));
});

test("Near-you never presents a council district as a governing community board", () => {
  const scope = scopeWithPlace(scopeFromLensState("meetings"), { borough: "Brooklyn", councilDistrict: "8" });
  const view = buildNearYouViewModel(scope, fixtureActivity(), fixtureBoundaries, {
    communityGeography: {
      public_edges: [{ type: "covers", from: "community-board:brooklyn-cb-15", to: "community-district:K15" }],
      nodes: [{ id: "community-board:brooklyn-cb-15", name: "Brooklyn Community Board 15", properties: { body_id: "brooklyn-cb-15" } }],
    },
  });
  const html = renderNearYouDocument(view);
  assert.match(html, />City Council District 8<\/h1>/);
  assert.doesNotMatch(html, /class="near-board-link"/);
  assert.doesNotMatch(html, /Brooklyn Community Board 15/);
});

test("the shared renderer emits exact server-owned records, counts, map paths, area links, and special bags", () => {
  const scope = scopeWithPlace(
    scopeFromLensState("meetings", { agency: "Transportation" }),
    { borough: "Queens" },
  );
  const view = buildNearYouViewModel(scope, fixtureActivity(), fixtureBoundaries);
  const html = renderNearYouDocument(view, { canonicalBase: "https://cityscroll.org/near-you" });
  const deferred = renderNearYouDeferredBody(view);
  const visible = `${html}${deferred}`.replace(/<[^>]+>/g, " ");

  assert.equal(view.results.count, 1);
  assert.deepEqual(view.results.ids, ["m-queens"]);
  assert.match(html, /data-near-you-root/);
  assert.match(html, /class="near-results near-results-shell"[^>]+data-near-deferred="results"/);
  assert.match(html, /class="near-bags near-bags-shell[^"]*"[^>]+data-near-deferred="bags"/);
  assert.match(html, /data-bag="citywide"[\s\S]*data-record-id="m-citywide"/);
  assert.match(deferred, /data-results-count="1"/);
  assert.match(deferred, /data-record-id="m-queens"/);
  assert.match(deferred, /data-pivot-schema="cityscroll\.edge_summary\.v1"[^>]+data-pivot-target-kind="notice"/);
  assert.match(deferred, /Queens curb redesign hearing/);
  assert.match(deferred, /Affected area/);
  const residentText = deferred.replace(/<details\b[\s\S]*?<\/details>/gi, "").replace(/<[^>]+>/g, " ");
  assert.doesNotMatch(residentText, /strong basis|location evidence|community_board_ontology|placement_method/i);
  // Geographic evidence and why-here stay inside inspection payloads, not the default card.
  assert.equal((deferred.match(/data-why-here-path="1"/g) || []).length, 0);
  assert.doesNotMatch(deferred, />Why this appears</);
  assert.match(deferred, /near-record-title-link/);
  assert.match(deferred, /near-record-inspect near-record-title/);
  assert.match(deferred, /near-record-full-record/);
  // Past fixture dates use View…; upcoming dates keep Open… Neither promises a currently open action when closed.
  assert.match(deferred, /data-action-open="(?:true|false)"/);
  assert.match(deferred, /(?:Open|View) the full record/);
  assert.match(deferred, /data-record-timing=/);
  assert.match(deferred, /data-near-you-record-inspection=/);
  assert.match(deferred, /&quot;place_role_label&quot;:&quot;Affected area&quot;/);
  assert.match(deferred, /&quot;label&quot;:&quot;Queens&quot;/);
  assert.match(deferred, /\/agencies\/transportation\//);
  assert.match(deferred, /\/notices\/m-queens/);
  assert.match(deferred, /Local Law § 1/);
  assert.match(html, /data-map-id="Queens"[^>]+data-count="1"/);
  assert.match(html, /data-map-area="Queens"[^>]+data-count="1"/);
  assert.match(deferred, /data-bag="citywide"/);
  assert.match(deferred, /data-bag="virtual"/);
  assert.match(deferred, /data-bag="unlocated"/);
  assert.match(deferred, /m-citywide/);
  assert.match(html, /type="module" src="\/app\/map\.mjs"/);
  assert.match(html, /<form[^>]+method="get"/);
  assert.match(html, /rel="stylesheet" href="\/brand\.css"/);
  assert.match(html, /rel="stylesheet" href="\/civic-documents\.css"/);
  assert.doesNotMatch(html, /<style>/);
  assert.doesNotMatch(html, /#f5f0e6|#7a1f1f|Georgia/);
  assert.doesNotMatch(html, /href="https:\/\/api\.cityscroll\.org/);
  assert.doesNotMatch(visible, /\b(?:facet|scope)\b|without JavaScript|server-rendered|static-first/i);
  assert.match(html, /class="document-brand brand-lockup home"/);
  assert.match(html, /Change place/);
  assert.match(html, /Other ways to choose/);
  assert.match(html, /data-use-location/);
  assert.match(html, /coordinates stay in this browser/i);
  assert.match(html, /name="neighborhood"/);
  assert.match(html, /name="cd"/);
  assert.match(html, /name="council"/);
  assert.match(html, /id="near-area-list"/);
});

test("deferred Near-you parts preserve records, empty copy, and error-state hooks", () => {
  const scope = scopeWithPlace(scopeFromLensState("meetings"), { borough: "Queens" });
  const view = buildNearYouViewModel(scope, fixtureActivity(), fixtureBoundaries);
  const parts = renderNearYouDeferredParts(view);
  assert.match(parts.resultsHtml, /data-results-count="1"/);
  assert.match(parts.resultsHtml, /data-record-id="m-queens"/);
  assert.match(parts.bagsHtml, /data-bag="citywide"/);

  const emptyView = {
    ...view,
    results: { ...view.results, count: 0, ids: [], records: [] },
    bags: Object.fromEntries(Object.entries(view.bags).map(([key, bag]) => [key, {
      ...bag,
      count: 0,
      records: [],
    }])),
  };
  const emptyParts = renderNearYouDeferredParts(emptyView);
  assert.match(emptyParts.resultsHtml, /No records match these filters/);
  assert.match(emptyParts.bagsHtml, /No citywide meetings match these filters/);

  const mapRuntime = readFileSync(new URL("../site/app/map.mjs", import.meta.url), "utf8");
  assert.match(mapRuntime, /copy\("messageDeferredUnavailable"\)/);
  assert.match(mapRuntime, /focusedDeferredPart/);
  assert.match(mapRuntime, /removeAttribute\("data-results-count"\)/);
  assert.match(mapRuntime, /nearDeferredState = "error"/);
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
  assert.match(index, /data-near-you-link[^>]+data-lens="(?:land|property)"|data-lens="(?:land|property)"[^>]+data-near-you-link/);
  assert.match(routing, /forwardLegacyMapToNearYou/);
});

test("Near-you scope parsing keeps response-address implementation off the cold link graph", () => {
  const source = readFileSync(new URL("../site/near_you_scope.mjs", import.meta.url), "utf8");
  assert.match(source, /scope_v0\.mjs/);
  assert.doesNotMatch(source, /contract_action_location\.mjs/);
  assert.doesNotMatch(source, /near_you_scope_runtime\.mjs/);
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

// Static import closure of a browser entry module, optionally without one
// edge or with one extra edge, as repository-relative paths.
function browserModuleClosure(entry, { without = null, extra = null } = {}) {
  const root = join(process.cwd(), "site");
  const seen = new Set();
  const pending = [join(root, entry)];
  const relative = (path) => path.slice(root.length + 1);
  while (pending.length) {
    const path = pending.pop();
    if (seen.has(path)) continue;
    seen.add(path);
    const source = readFileSync(path, "utf8");
    const targets = [...source.matchAll(/(?:import|export)\s[^;]*?from\s+["'](\.[^"']+\.mjs)["']|import\(\s*["'](\.[^"']+\.mjs)["']\s*\)/g)]
      .map((match) => join(path, "..", match[1] || match[2]));
    if (extra && relative(path) === extra.from) targets.push(join(root, extra.to));
    for (const target of targets) {
      if (without && relative(path) === without.from && relative(target) === without.to) continue;
      if (target.startsWith(root)) pending.push(target);
    }
  }
  return new Set([...seen].map(relative));
}

test("A6: the collection entry adds anchors only, no browser module and no data read", (t) => {
  const root = readFileSync(new URL("../site/near-you/index.html", import.meta.url), "utf8");
  const row = root.match(/<nav class="near-collection-entry"[\s\S]*?<\/nav>/)?.[0];
  assert.ok(row, "committed root document carries the collection row");
  const withoutRow = root.replace(row, "");
  const gzipDelta = gzipSync(root).length - gzipSync(withoutRow).length;
  t.diagnostic(`collection entry: ${Buffer.byteLength(row)} bytes raw, ${gzipDelta} bytes gzip of a ${gzipSync(root).length}-byte gzip root document`);
  assert.ok(gzipDelta > 0);
  // Anchors and a heading only: nothing that loads a module, image or data file.
  assert.doesNotMatch(row, /<(?:script|link|img|iframe|object|form|input)\b|data-near-deferred|\.json/);
  assert.equal(
    [...root.matchAll(/<script\b[^>]*>/g)].length,
    [...withoutRow.matchAll(/<script\b[^>]*>/g)].length,
  );

  // The shell's new import is already in the Near You browser graph through
  // another path, so it adds no module the page must fetch.
  const edge = { from: "geography_navigation_shell.mjs", to: "browse_surface_contracts.mjs" };
  const shellSource = readFileSync(new URL("../site/geography_navigation_shell.mjs", import.meta.url), "utf8");
  assert.match(shellSource, /from "\.\/browse_surface_contracts\.mjs"/);
  const withEdge = browserModuleClosure("app/map.mjs");
  const withoutEdge = browserModuleClosure("app/map.mjs", { without: edge });
  assert.ok(withEdge.has(edge.from) && withEdge.has(edge.to));
  assert.deepEqual([...withEdge].filter((path) => !withoutEdge.has(path)), []);
  // Positive control: importing the Browse renderer instead would add modules.
  const heavier = browserModuleClosure("app/map.mjs", { extra: { from: edge.from, to: "browse_view.mjs" } });
  assert.ok([...heavier].filter((path) => !withEdge.has(path)).length > 0);
});

const NTA_OWNER_LAYER = Object.freeze({
  schema: "cityscroll.geography_layer.v1",
  type: "nta2020",
  vintage: Object.freeze({
    id: "26B",
    published_at: "2026-05-04T00:00:00.000Z",
    valid_from: null,
    valid_to: null,
  }),
  geometry_fidelity: "simplified",
  features: Object.freeze([
    Object.freeze({
      key: "geography:nta2020:BK0101",
      type: "nta2020",
      id: "BK0101",
      label: "Greenpoint",
      subtype: "residential",
    }),
    Object.freeze({
      key: "geography:nta2020:QN0103",
      type: "nta2020",
      id: "QN0103",
      label: "Astoria (Central)",
      subtype: "residential",
    }),
    Object.freeze({
      key: "geography:nta2020:SI0101",
      type: "nta2020",
      id: "SI0101",
      label: "St. George-New Brighton",
      subtype: "residential",
    }),
  ]),
});

const NTA_LABEL_INDEX = Object.freeze({
  "geography:nta2020:BK0101": "Greenpoint",
  "geography:nta2020:QN0103": "Astoria (Central)",
  "geography:nta2020:SI0101": "St. George-New Brighton",
});

test("A1: selected neighborhoods keep friendly titles and geometry vintage when records fail", () => {
  const cases = [
    { id: "BK0101", label: "Greenpoint" },
    { id: "QN0103", label: "Astoria (Central)" },
    { id: "SI0101", label: "St. George-New Brighton" },
  ];
  for (const specimen of cases) {
    const scope = scopeFromNearYouUrl(
      `https://cityscroll.org/near-you/?geo=nta2020:${specimen.id}&surface=map&lens=meetings&agency=Transportation&q=curb&compare=council_district`,
    );
    const view = buildNearYouViewModel(scope, null, fixtureBoundaries, {
      dataState: "error",
      geometryState: "ready",
      canonicalBase: "https://cityscroll.org/near-you",
      geographySearch: `?geo=nta2020:${specimen.id}&surface=map&lens=meetings&agency=Transportation&q=curb&compare=council_district`,
      navigationLayerDoc: NTA_OWNER_LAYER,
      navigationLayerType: "nta2020",
      geographyLabelIndex: NTA_LABEL_INDEX,
    });
    const html = renderNearYouDocument(view);
    assert.equal(view.dataState, "error", specimen.id);
    assert.equal(view.geometryState, "ready", specimen.id);
    assert.equal(view.mapState, "ready", specimen.id);
    assert.equal(view.boundaryVintage, "26B", specimen.id);
    assert.equal(view.placePresentation.label, specimen.label, specimen.id);
    assert.match(html, new RegExp(`<h1>${specimen.label.replace(/[()]/g, "\\$&")}</h1>`), specimen.id);
    assert.match(html, /Map boundaries: 26B/, specimen.id);
    assert.match(html, /data-near-map-state="ready"/, specimen.id);
    assert.match(html, /These meetings could not load\./, specimen.id);
    assert.match(html, /data-near-recovery="retry">Try again/, specimen.id);
    assert.doesNotMatch(html, /buyer_history_retry/, specimen.id);
    assert.doesNotMatch(html, new RegExp(`<h1>${specimen.id}</h1>`), specimen.id);
    assert.doesNotMatch(html, /Map boundaries: not published/, specimen.id);
    const retryHref = html.match(/<a href="([^"]+)" data-near-recovery="retry">/)?.[1]?.replaceAll("&amp;", "&");
    assert.ok(retryHref, specimen.id);
    const retryUrl = new URL(retryHref);
    const retryGeo = retryUrl.searchParams.get("geo");
    assert.ok(
      retryGeo === `nta2020:${specimen.id}` || retryGeo === `geography:nta2020:${specimen.id}`,
      `${specimen.id} retry geo ${retryGeo}`,
    );
    assert.equal(retryUrl.searchParams.get("lens"), "meetings", specimen.id);
    assert.equal(retryUrl.searchParams.get("agency"), "Transportation", specimen.id);
    assert.equal(retryUrl.searchParams.get("q"), "curb", specimen.id);
    assert.equal(retryUrl.searchParams.get("compare"), "council_district", specimen.id);
  }
});

test("A2: geometry and records health stay independent across truthful states", () => {
  const baseScope = scopeFromNearYouUrl(
    "https://cityscroll.org/near-you/?geo=nta2020:BK0101&surface=map&lens=meetings",
  );
  const matrix = [
    {
      name: "healthy-records",
      options: {
        dataState: "ready",
        geometryState: "ready",
        navigationLayerDoc: NTA_OWNER_LAYER,
        geographyLabelIndex: NTA_LABEL_INDEX,
        geographySearch: "?geo=nta2020:BK0101&surface=map&lens=meetings",
      },
      activity: {
        ...fixtureActivity(),
        geography_items: {
          definitions: {
            "geography:nta2020:BK0101": {
              key: "geography:nta2020:BK0101",
              type: "nta2020",
              id: "BK0101",
              label: "Greenpoint",
              boundary_vintage: "26B",
            },
          },
          by_key: { "geography:nta2020:BK0101": { meetings: ["m-queens"] } },
        },
      },
      expect: { dataState: "ready", geometryState: "ready", mapState: "populated", vintage: "26B", label: "Greenpoint" },
    },
    {
      name: "published-zero",
      options: {
        dataState: "ready",
        geometryState: "ready",
        navigationLayerDoc: NTA_OWNER_LAYER,
        geographyLabelIndex: NTA_LABEL_INDEX,
        geographySearch: "?geo=nta2020:BK0101&surface=map&lens=meetings&agency=No%20matching%20agency",
      },
      activity: {
        ...fixtureActivity(),
        geography_items: {
          definitions: {
            "geography:nta2020:BK0101": {
              key: "geography:nta2020:BK0101",
              type: "nta2020",
              id: "BK0101",
              label: "Greenpoint",
              boundary_vintage: "26B",
            },
          },
          by_key: { "geography:nta2020:BK0101": { meetings: [] } },
        },
      },
      scope: scopeFromNearYouUrl(
        "https://cityscroll.org/near-you/?geo=nta2020:BK0101&surface=map&lens=meetings&agency=No%20matching%20agency",
      ),
      expect: { dataState: "ready", geometryState: "ready", mapState: "empty", vintage: "26B", label: "Greenpoint", zero: true },
    },
    {
      name: "delayed-geometry",
      options: {
        dataState: "ready",
        geometryState: "pending",
        geographySearch: "?geo=nta2020:BK0101&surface=map&lens=meetings",
        geographyLabelIndex: NTA_LABEL_INDEX,
      },
      activity: fixtureActivity(),
      expect: { dataState: "ready", geometryState: "pending", mapState: "pending", vintage: null, label: "Greenpoint" },
    },
    {
      name: "missing-geometry",
      options: {
        dataState: "ready",
        geometryState: "missing",
        geographySearch: "?geo=nta2020:BK0101&surface=map&lens=meetings",
        geographyLabelIndex: NTA_LABEL_INDEX,
      },
      activity: fixtureActivity(),
      expect: { dataState: "ready", geometryState: "missing", mapState: "missing", vintage: null, label: "Greenpoint" },
    },
    {
      name: "geometry-error",
      options: {
        dataState: "ready",
        geometryState: "error",
        geographySearch: "?geo=nta2020:BK0101&surface=map&lens=meetings",
        geographyLabelIndex: NTA_LABEL_INDEX,
        navigationLayerDoc: NTA_OWNER_LAYER,
      },
      activity: fixtureActivity(),
      expect: { dataState: "ready", geometryState: "error", mapState: "error", vintage: "26B", label: "Greenpoint" },
    },
    {
      name: "record-only-failure",
      options: {
        dataState: "error",
        geometryState: "ready",
        navigationLayerDoc: NTA_OWNER_LAYER,
        geographyLabelIndex: NTA_LABEL_INDEX,
        geographySearch: "?geo=nta2020:BK0101&surface=map&lens=meetings",
      },
      activity: null,
      expect: { dataState: "error", geometryState: "ready", mapState: "ready", vintage: "26B", label: "Greenpoint" },
    },
  ];

  for (const row of matrix) {
    const view = buildNearYouViewModel(
      row.scope || baseScope,
      row.activity,
      fixtureBoundaries,
      {
        canonicalBase: "https://cityscroll.org/near-you",
        navigationLayerType: "nta2020",
        ...row.options,
      },
    );
    const html = renderNearYouDocument(view);
    assert.equal(view.dataState, row.expect.dataState, row.name);
    assert.equal(view.geometryState, row.expect.geometryState, row.name);
    assert.equal(view.mapState, row.expect.mapState, row.name);
    assert.equal(view.boundaryVintage, row.expect.vintage, row.name);
    assert.equal(view.placePresentation.label, row.expect.label, row.name);
    assert.match(html, new RegExp(`data-near-data-state="${row.expect.dataState}"`), row.name);
    assert.match(html, new RegExp(`data-near-geometry-state="${row.expect.geometryState}"`), row.name);
    assert.match(html, new RegExp(`data-near-map-state="${row.expect.mapState}"`), row.name);
    if (row.expect.vintage) {
      assert.match(html, new RegExp(`Map boundaries: ${row.expect.vintage}`), row.name);
    } else {
      assert.match(html, /Map boundaries: not published/, row.name);
    }
    if (row.name === "missing-geometry") {
      assert.match(html, /Map boundaries are not published for this place yet/, row.name);
      assert.doesNotMatch(html, /data-near-map-state="ready"/, row.name);
    }
    if (row.expect.zero) {
      assert.equal(view.results.count, 0, row.name);
    }
    if (row.name === "record-only-failure") {
      assert.match(html, /These meetings could not load\./, row.name);
      assert.doesNotMatch(html, /buyer_history_retry/, row.name);
      assert.doesNotMatch(html, /The neighborhood map could not load/, row.name);
    }
  }
});

test("A3: production journey retained for Midwood without claiming field vitals", () => {
  const root = process.cwd();
  const harness = readFileSync(join(root, "test/browser/geography_navigation_release.py"), "utf8");
  const manifest = JSON.parse(
    readFileSync(join(root, "docs/evidence/geography-navigation-release/capture-manifest.json"), "utf8"),
  );
  assert.match(harness, /--write-production-journey/);
  assert.match(harness, /PRODUCTION_JOURNEY_ROUTES/);
  assert.equal(manifest.production_journey?.status, "taken");
  assert.match(manifest.production_journey?.served_revision || "", /^[0-9a-f]{40}$/);
  assert.equal(manifest.not_taken.includes("production CROL_BASE journey"), false);
  assert.ok(manifest.not_taken.includes("production field-vital measurement"));
  assert.equal(manifest.performance.production_field_vitals.status, "not_taken");
  const midwood = manifest.production_journey.captures.filter((row) => row.name.startsWith("production-midwood-"));
  assert.equal(midwood.length, 2);
  for (const row of midwood) {
    assert.equal(row.http_status, 200, row.name);
    assert.ok(row.visual_metrics.results_count >= 1, row.name);
    assert.equal(row.visual_metrics.results_populated, true, row.name);
    assert.ok(Array.isArray(row.visual_metrics.focus_order) && row.visual_metrics.focus_order.length > 0, row.name);
  }
});

test("All NYC broadening keeps destination-applied facets per lens and clears place-shaped refs", async () => {
  const { allNycRecordsRouteHash, scopeForAllNycRecords } = await import("../site/near_you_scope_runtime.mjs");
  const { scopeFromRouteHash } = await import("../site/scope_v0.mjs");
  const land = scopeWithPlace(
    scopeFromLensState("land", { family: "rezoning", regulatoryEffect: "upzoning", q: "housing" }),
    { communityDistrict: "K15", borough: "Brooklyn" },
  );
  const landHash = allNycRecordsRouteHash(land);
  const landScope = scopeFromRouteHash(landHash);
  assert.equal(landHash.startsWith("#land?"), true);
  assert.equal(landScope.facets.values.family, "rezoning");
  assert.equal(landScope.facets.values.regulatoryEffect, "upzoning");
  assert.deepEqual(landScope.place.community_districts, []);
  assert.deepEqual(landScope.place.boroughs, []);
  assert.deepEqual(scopeForAllNycRecords(land).removed, []);

  const board = scopeFromLensState("meetings", {
    entity_refs_all: ["community-board:brooklyn-cb-15", "agency:id:transportation"],
  });
  const broadened = scopeForAllNycRecords(scopeWithPlace(board, { communityDistrict: "K15" }));
  assert.deepEqual(broadened.scope.facets.values.entity_refs_all, ["agency:id:transportation"]);
  assert.deepEqual(broadened.scope.place.community_districts, []);

  assert.equal(allNycRecordsRouteHash(scopeWithPlace(scopeFromLensState("consultations"), { borough: "Queens" })), null);
  assert.equal(allNycRecordsRouteHash(scopeFromLensState("meetings", { when: "week" })), "#meetings?when=week");
});

// Separately loaded Near You sections (public alias ccfaadd338534), over frozen rows
// reduced from the pinned published snapshot.
import {
  MIDWOOD,
  SECTION_ISOLATION_SOURCE,
  readPinnedDistrictActivity,
  readSectionIsolationFixture,
  reduceSectionIsolationActivity,
} from "./helpers/near_you_section_isolation_fixture.mjs";

const SECTION_READY = Object.freeze({ state: "ready", cause: null });

function sectionsWith(overrides = {}) {
  return Object.fromEntries(["primary", "citywide", "virtual", "unlocated"]
    .map((name) => [name, overrides[name] || SECTION_READY]));
}

test("each Near You section renders from its own state; all-ready output is byte-identical", () => {
  const { provenance: _provenance, ...rows } = readSectionIsolationFixture();
  const scope = scopeFromNearYouUrl("https://cityscroll.org/near-you/?geo=nta2020:BK1403&lens=meetings&surface=records");
  const midwood = rows.geography_items.by_key[MIDWOOD].meetings.map(String).sort();
  const legacy = buildNearYouViewModel(scope, rows, fixtureBoundaries);
  const ready = buildNearYouViewModel(scope, rows, fixtureBoundaries, { sections: sectionsWith() });
  assert.deepEqual(renderNearYouDeferredParts(ready), renderNearYouDeferredParts(legacy),
    "reporting every section ready changes no served byte");
  assert.equal(ready.bags.citywide.count, 20);

  const citywideFailed = buildNearYouViewModel(scope, rows, fixtureBoundaries, {
    sections: sectionsWith({ citywide: { state: "unavailable", cause: "timeout" } }),
  });
  assert.deepEqual(citywideFailed.results.ids, midwood);
  assert.equal(citywideFailed.bags.citywide.count, null);
  assert.deepEqual(citywideFailed.bags.citywide.ids, []);
  assert.equal(citywideFailed.bags.virtual.count, 1);
  const parts = renderNearYouDeferredParts(citywideFailed);
  assert.match(parts.bagsHtml, /data-bag="citywide" data-near-section-state="unavailable"/);
  assert.doesNotMatch(parts.bagsHtml, /timeout/, "the internal cause never reaches resident markup");

  // The requested section failed: loaded buckets render from the loaded
  // sections only, and no local count, area count or lens count is derived.
  const localFailed = buildNearYouViewModel(scope, null, fixtureBoundaries, {
    dataState: "error",
    sections: sectionsWith({ primary: { state: "unavailable", cause: "read_failed" } }),
    sectionActivity: rows,
  });
  assert.equal(localFailed.results.count, null);
  assert.deepEqual(localFailed.results.ids, []);
  assert.equal(localFailed.bags.citywide.count, 20);
  assert.equal(localFailed.localRecovery.state, "error");
  assert.ok(Object.values(localFailed.navigationAreaCountsByKey).every((count) => count == null));
  assert.deepEqual(localFailed.geographyLensCounts, {});
  const failedParts = renderNearYouDeferredParts(localFailed);
  assert.match(failedParts.resultsHtml, /data-near-section-state="unavailable"/);
  assert.doesNotMatch(failedParts.resultsHtml, /data-record-id=/);
  // Control: without the loaded sections every bucket stays unavailable.
  const nothingLoaded = buildNearYouViewModel(scope, null, fixtureBoundaries, { dataState: "error" });
  assert.equal(nothingLoaded.bags.citywide.count, null);
});

test("the section fixture is the exact reduction of the pinned published snapshot", (t) => {
  const frozen = readSectionIsolationFixture();
  assert.equal(frozen.provenance.revision, SECTION_ISOLATION_SOURCE.revision);
  assert.equal(frozen.provenance.blob, SECTION_ISOLATION_SOURCE.blob);
  const pinned = readPinnedDistrictActivity();
  if (!pinned) {
    t.skip(`pinned blob ${SECTION_ISOLATION_SOURCE.blob} is not in this checkout's object store`);
    return;
  }
  const { provenance: _provenance, ...rows } = frozen;
  assert.deepEqual(rows, reduceSectionIsolationActivity(pinned));
  // Positive control: a changed row is caught.
  const altered = structuredClone(rows);
  altered.district_items.citywide.meetings.pop();
  assert.notDeepEqual(altered, reduceSectionIsolationActivity(pinned));
});

// Citywide records as relevant content (public alias c69db1aa1163d): a bounded
// preview over the frozen citywide bucket, read at a fixed clock.
import {
  NEAR_YOU_SPECIAL_PREVIEW_LIMIT,
  orderNearYouSpecialPreview,
} from "../site/near_you_view.mjs";
import { SHEEPSHEAD_BAY } from "./helpers/near_you_section_isolation_fixture.mjs";

const CITYWIDE_CLOCK = "2026-09-28T16:00:00.000Z";
const CONTAINMENT_NETTING = "20260826001";
const WATERFRONTS = "meeting:nyc_legistar_events:22568";
const SIDEWALK_SHEDS = "20260817025";
const VIRTUAL_NOTICE = "20260624005";
const UNMAPPED_NOTICE = "20260213014";

function citywideRows() {
  const { provenance: _provenance, ...rows } = readSectionIsolationFixture();
  return rows;
}

function citywideView(url, rows = citywideRows(), options = {}) {
  return buildNearYouViewModel(scopeFromNearYouUrl(url), rows, fixtureBoundaries, { now: CITYWIDE_CLOCK, ...options });
}

/** The special-records section of a document or deferred part. */
function specialSection(html) {
  const start = html.indexOf('<section class="near-bags');
  assert.ok(start >= 0, "special records section is rendered");
  return html.slice(start, html.indexOf("</section>", start) + "</section>".length);
}

function previewIds(html) {
  return [...specialSection(html).matchAll(/<li class="near-record" data-record-id="([^"]+)"/g)].map((match) => match[1]);
}

function viewAllHref(html) {
  return specialSection(html).match(/<a href="([^"]+)" data-near-special-link="citywide">/)?.[1]?.replaceAll("&amp;", "&") || null;
}

/** The View all destination, built from the href alone, over the same rows and clock. */
function destinationView(href, rows = citywideRows()) {
  return citywideView(new URL(href, "https://cityscroll.org/").toString(), rows);
}

test("A1/A7: the citywide preview shows the next two meetings then the latest past one, with a full-count View all", () => {
  const rows = citywideRows();
  const frozen = rows.district_items.citywide.meetings.map(String).sort();
  assert.equal(frozen.length, 20);
  const view = citywideView("https://cityscroll.org/near-you/?lens=meetings", rows);
  assert.equal(view.bags.citywide.count, 20);
  assert.deepEqual(view.bags.citywide.preview.map((record) => record.id), [CONTAINMENT_NETTING, WATERFRONTS, SIDEWALK_SHEDS]);
  const { bagsHtml } = renderNearYouDeferredParts(view);
  assert.deepEqual(previewIds(bagsHtml), [CONTAINMENT_NETTING, WATERFRONTS, SIDEWALK_SHEDS]);
  assert.equal(previewIds(bagsHtml).length, NEAR_YOU_SPECIAL_PREVIEW_LIMIT);
  assert.match(specialSection(bagsHtml), /<h2 id="near-bags-heading" tabindex="-1"><span>Citywide meetings<\/span> <strong>20<\/strong><\/h2>/);
  assert.match(specialSection(bagsHtml), /These apply across NYC\./);
  assert.match(specialSection(bagsHtml), /View all 20 citywide meetings/);
  // The two upcoming meetings keep their open action; the past one does not.
  assert.match(bagsHtml, new RegExp(`data-record-id="${CONTAINMENT_NETTING}"[\\s\\S]*?data-record-timing="upcoming" data-action-open="true">Upcoming · Oct 5, 2026`));
  assert.match(bagsHtml, new RegExp(`data-record-id="${SIDEWALK_SHEDS}"[\\s\\S]*?data-record-timing="past" data-action-open="false">Past event · Sep 24, 2026`));

  // View all is the whole deduplicated bucket as its own Records list.
  const href = viewAllHref(bagsHtml);
  const url = new URL(href, "https://cityscroll.org/");
  assert.equal(url.searchParams.get("scope"), "citywide");
  assert.equal(url.searchParams.get("surface"), "records");
  const destination = destinationView(href, rows);
  assert.deepEqual(destination.results.ids, frozen);
  assert.equal(destination.results.count, 20);
  // On that route the bucket is the primary list, never a preview of itself too.
  assert.doesNotMatch(renderNearYouDeferredParts(destination).bagsHtml, /data-bag="citywide"/);
  const duplicated = structuredClone(rows);
  duplicated.district_items.citywide.meetings.push(CONTAINMENT_NETTING);
  assert.equal(citywideView("https://cityscroll.org/near-you/?lens=meetings", duplicated).bags.citywide.count, 20, "the total is deduplicated");

  // Converse controls: the order is read from the clock, not fixed.
  const later = citywideView("https://cityscroll.org/near-you/?lens=meetings", rows, { now: "2026-10-10T16:00:00.000Z" });
  assert.deepEqual(later.bags.citywide.preview.map((record) => record.id), [WATERFRONTS, CONTAINMENT_NETTING, SIDEWALK_SHEDS]);
  const allPast = citywideView("https://cityscroll.org/near-you/?lens=meetings", rows, { now: "2026-11-01T16:00:00.000Z" });
  assert.deepEqual(allPast.bags.citywide.preview.map((record) => record.id), [WATERFRONTS, CONTAINMENT_NETTING, SIDEWALK_SHEDS]);
  assert.match(renderNearYouDeferredParts(allPast).bagsHtml, new RegExp(`data-record-id="${CONTAINMENT_NETTING}"[\\s\\S]*?data-action-open="false">Past event · Oct 5, 2026`));
});

test("A7: preview order is future ascending, past descending, then undated, with the ID as the last tiebreaker", () => {
  const now = CITYWIDE_CLOCK;
  const rows = [
    { id: "undated-b" },
    { id: "past-near", date: "2026-09-27T09:00:00.000" },
    { id: "future-far", date: "2026-11-02T09:00:00.000" },
    { id: "undated-a" },
    { id: "same-day-b", date: "2026-10-01T09:00:00.000" },
    { id: "same-day-a", date: "2026-10-01T09:00:00.000" },
    { id: "future-soon-later-hour", date: "2026-09-30T18:00:00.000" },
    { id: "future-soon", date: "2026-09-30T10:00:00.000" },
    { id: "past-far", date: "2026-01-05T09:00:00.000" },
  ];
  assert.deepEqual(orderNearYouSpecialPreview(rows, { now }).map((row) => row.id), [
    "future-soon", "future-soon-later-hour", "same-day-a", "same-day-b", "future-far",
    "past-near", "past-far", "undated-a", "undated-b",
  ]);
  // The input order never decides the output.
  assert.deepEqual(
    orderNearYouSpecialPreview([...rows].reverse(), { now }).map((row) => row.id),
    orderNearYouSpecialPreview(rows, { now }).map((row) => row.id),
  );
});

test("A2: from Sheepshead Bay the citywide preview follows the local recovery outside every disclosure, and View all clears the place", () => {
  const rows = citywideRows();
  const url = "https://cityscroll.org/near-you/?geo=nta2020:BK1503&lens=meetings&surface=records";
  const view = citywideView(url, rows);
  assert.equal(view.localRecovery.state, "unsupported");
  assert.equal(view.results.count, null);
  const html = renderNearYouDocument(view);
  const section = specialSection(html);
  // Server-rendered in the document itself, after the local result, outside
  // the Map details drawer, About this place and either surface panel.
  assert.ok(html.indexOf('data-near-local-recovery="unsupported"') < html.indexOf(section));
  assert.equal(section.includes("data-near-surface-panel"), false);
  const before = html.slice(0, html.indexOf(section));
  const openDetails = (before.match(/<details\b/g) || []).length - (before.match(/<\/details>/g) || []).length;
  const openAsides = (before.match(/<aside\b/g) || []).length - (before.match(/<\/aside>/g) || []).length;
  assert.equal(openDetails, 0, "the preview is not inside a disclosure");
  assert.equal(openAsides, 0, "the preview is not inside the Map details drawer");
  assert.deepEqual(previewIds(html), [CONTAINMENT_NETTING, WATERFRONTS, SIDEWALK_SHEDS]);

  const href = viewAllHref(html);
  const next = scopeFromNearYouUrl(new URL(href, "https://cityscroll.org/"));
  assert.equal(new URL(href, "https://cityscroll.org/").searchParams.has("geo"), false);
  assert.deepEqual(next.place.geographies || [], []);
  assert.deepEqual([next.place.boroughs, next.place.community_districts, next.place.council_districts], [[], [], []]);
  assert.equal(next.place.neighborhood, null);
  assert.equal(next.place.location_scope, "citywide");
  assert.deepEqual(destinationView(href, rows).results.ids, [...view.bags.citywide.ids].sort());
  // Control: the source page really was scoped to Sheepshead Bay.
  assert.deepEqual(view.scope.place.geographies, [SHEEPSHEAD_BAY]);
});

test("A3: online-only and unmapped notices stay in their own collections, never in the citywide preview or total", () => {
  const rows = citywideRows();
  const view = citywideView("https://cityscroll.org/near-you/?lens=meetings", rows);
  for (const id of [VIRTUAL_NOTICE, UNMAPPED_NOTICE]) {
    assert.equal(view.bags.citywide.ids.includes(id), false, id);
    assert.equal(rows.district_items.citywide.meetings.includes(id), false, id);
  }
  assert.equal(view.bags.citywide.count, 20);
  const { bagsHtml } = renderNearYouDeferredParts(view);
  for (const [kind, id, total] of [["virtual", VIRTUAL_NOTICE, 1], ["unlocated", UNMAPPED_NOTICE, 89]]) {
    const link = specialSection(bagsHtml).match(new RegExp(`<a href="([^"]+)" data-near-special-link="${kind}">[^<]+</a> <strong>${total}</strong>`));
    assert.ok(link, `${kind} is a compact link with its own total`);
    const destination = destinationView(link[1].replaceAll("&amp;", "&"), rows);
    assert.equal(destination.results.count, total, kind);
    assert.ok(destination.results.ids.includes(id), `${id} is reachable through the ${kind} collection`);
    assert.equal(destination.bags.citywide.ids.includes(id), false);
  }
  assert.doesNotMatch(previewIds(bagsHtml).join(" "), /20260624005|20260213014/);

  // Past rows never promise an open action; an unknown time stays unknown.
  const undated = structuredClone(rows);
  undated.records.meetings["undated-citywide"] = { id: "undated-citywide", title: "Undated citywide notice", route: "/#notice/undated-citywide", basis: "Citywide" };
  undated.district_items.citywide.meetings = ["undated-citywide", SIDEWALK_SHEDS];
  const parts = renderNearYouDeferredParts(citywideView("https://cityscroll.org/near-you/?lens=meetings", undated));
  assert.deepEqual(previewIds(parts.bagsHtml), [SIDEWALK_SHEDS, "undated-citywide"]);
  assert.match(parts.bagsHtml, /data-record-id="undated-citywide"[\s\S]*?data-record-timing="unknown" data-action-open="false">Date not published/);
  assert.doesNotMatch(parts.bagsHtml.slice(parts.bagsHtml.indexOf('data-record-id="undated-citywide"')), /Upcoming|\d{2}:\d{2}/);
});

test("A4: filters carry to the destination, and empty, failed and loading buckets each render their own state", () => {
  const rows = citywideRows();
  for (const query of ["agency=Buildings&q=Rule", "agency=Consumer%20and%20Worker%20Protection", "when=month", "q=Netting"]) {
    const view = citywideView(`https://cityscroll.org/near-you/?lens=meetings&${query}`, rows);
    const { bagsHtml } = renderNearYouDeferredParts(view);
    const destination = destinationView(viewAllHref(bagsHtml), rows);
    assert.ok(view.bags.citywide.count > 0 && view.bags.citywide.count < 20, query);
    assert.equal(destination.results.count, view.bags.citywide.count, query);
    for (const id of previewIds(bagsHtml)) assert.ok(destination.results.ids.includes(id), `${query}: ${id}`);
    assert.equal(previewIds(bagsHtml).length, Math.min(3, view.bags.citywide.count), query);
  }

  // Empty: its own sentence, an honest zero and no View all to an empty list.
  const empty = renderNearYouDeferredParts(citywideView("https://cityscroll.org/near-you/?lens=meetings&q=zzzz", rows)).bagsHtml;
  assert.match(empty, /No citywide meetings match these filters\./);
  assert.match(empty, /<span>Citywide meetings<\/span> <strong>0<\/strong>/);
  assert.equal(viewAllHref(empty), null);

  // Failed: unavailable with Retry and the View all route, never a zero.
  const failed = renderNearYouDeferredParts(citywideView("https://cityscroll.org/near-you/?lens=meetings", rows, {
    sections: sectionsWith({ citywide: { state: "unavailable", cause: "timeout" } }),
  })).bagsHtml;
  assert.match(failed, /data-bag="citywide" data-near-section-state="unavailable"/);
  assert.match(failed, /Citywide meetings could not load\./);
  assert.match(failed, /aria-label="Count unavailable"/);
  assert.match(failed, /data-near-recovery="retry"/);
  assert.doesNotMatch(failed, /<strong>0<\/strong>|No citywide meetings match/);
  assert.ok(viewAllHref(failed));

  // Loading: a deferred host that still carries every collection link.
  const pending = renderNearYouDocument(citywideView("https://cityscroll.org/near-you/?lens=meetings", rows, { dataState: "pending" }));
  const pendingSection = specialSection(pending);
  assert.match(pendingSection, /data-near-deferred="bags" data-near-deferred-state="pending" aria-busy="true"/);
  assert.match(pendingSection, /Loading citywide meetings…/);
  for (const kind of ["citywide", "virtual", "unlocated"]) assert.match(pendingSection, new RegExp(`data-near-special-link="${kind}"`));
  // Loaded content is complete in the document, so a failed deferred read keeps it.
  assert.match(specialSection(renderNearYouDocument(citywideView("https://cityscroll.org/near-you/?lens=meetings", rows))),
    /data-near-deferred="bags" data-near-deferred-state="pending" data-near-deferred-content="complete"/);

  // Special scope clearing also drops leftover neighborhood text.
  const texted = citywideView("https://cityscroll.org/near-you/?lens=meetings&neighborhood=Sheepshead%20Bay", rows);
  assert.match(texted.shareHref, /neighborhood=Sheepshead/, "control: the source scope carries the text");
  assert.equal(new URL(texted.bags.citywide.href).searchParams.has("neighborhood"), false);
  assert.equal(scopeWithPlace(texted.scope, { locationScope: "citywide" }).place.neighborhood, null);
});

test("A4: a place-role filter is never relaxed to fill the citywide preview; the All NYC route names what it removes", () => {
  const rows = citywideRows();
  const view = citywideView("https://cityscroll.org/near-you/?geo=nta2020:BK1403&lens=meetings&placeRole=venue", rows);
  assert.equal(view.bags.citywide.count, 0);
  const section = specialSection(renderNearYouDeferredParts(view).bagsHtml);
  assert.deepEqual(previewIds(section), []);
  assert.match(section, /No citywide meetings match these filters\./);
  assert.match(section, /<a href="[^"]+" data-near-recovery="all-nyc">All NYC meetings<\/a>/);
  assert.match(section, /Removes: “Happening here”\./);
  // Control: without the role filter the same place previews citywide meetings.
  assert.equal(citywideView("https://cityscroll.org/near-you/?geo=nta2020:BK1403&lens=meetings", rows).bags.citywide.count, 20);
});

test("A6: before a place is chosen, citywide records come after the entry row and before the map in reading order", () => {
  const html = renderNearYouDocument(citywideView("https://cityscroll.org/near-you/", citywideRows()));
  const section = specialSection(html);
  const at = html.indexOf(section);
  assert.ok(html.indexOf('class="near-collection-entry"') < at, "after the collection row");
  assert.ok(at < html.indexOf('class="near-geo-workspace"'), "before the map and area directory");
  assert.match(section, /data-near-special-records="entry"/);
  assert.equal(previewIds(html).length, NEAR_YOU_SPECIAL_PREVIEW_LIMIT);
  // A category whose special buckets are not published shows no collection, not a zero.
  const floor = citywideRows();
  floor.district_items.citywide = {};
  floor.district_items.virtual = {};
  floor.district_items.unlocated = {};
  const unpublished = citywideView("https://cityscroll.org/near-you/", floor);
  assert.equal(unpublished.bags.citywide.count, null);
  assert.doesNotMatch(renderNearYouDocument(unpublished), /data-bag=/);
});
