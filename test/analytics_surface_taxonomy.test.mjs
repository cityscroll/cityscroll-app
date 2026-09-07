/**
 * The surface vocabulary and the route map must answer for each other.
 *
 * The defect this file guards against is not a crash; it is a number that is quietly about the
 * wrong page. The browser used to resolve a surface from the last path segment and answer
 * "home" when it recognised nothing, so every `.html` document served at its extensionless
 * path, the Search document, the data-health document and each `/browse/<lane>/` document all
 * reported themselves as the homepage. Nothing failed. The measurement was simply wrong, and
 * stayed wrong as the product grew past it.
 *
 * So the checks here are all bidirectional: a surface the route map registers must be answered
 * here, a surface answered here must still be registered there, a document that ships the
 * collector must resolve to a surface a producer may name, and a surface a producer may name
 * must be one some document actually produces.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ANALYTICS_COLLECTOR_SURFACES,
  ANALYTICS_NON_ROUTE_SURFACES,
  ANALYTICS_ROUTE_MANIFEST_PATH,
  ANALYTICS_ROUTE_SURFACES,
  ANALYTICS_SURFACES,
  isAnalyticsSurface,
  resolveAnalyticsSurface,
} from "../site/analytics_surface_taxonomy.mjs";
import { collectorDocuments } from "../tools/build_measurement_review.mjs";

const manifest = JSON.parse(readFileSync(new URL(`../${ANALYTICS_ROUTE_MANIFEST_PATH}`, import.meta.url), "utf8"));

/** The one surface deliberately kept without a route-map row, and the reason it carries. */
const UNREGISTERED_BY_DESIGN = new Set(["worth-a-look"]);

test("every registered route surface is answered exactly once", () => {
  const answered = ANALYTICS_ROUTE_SURFACES.filter((row) => row.route_surface_id);
  const ids = answered.map((row) => row.route_surface_id);
  assert.deepEqual([...new Set(ids)].sort(), [...ids].sort(), "a route-map surface is answered twice");
  assert.deepEqual(
    ids.slice().sort(),
    manifest.surfaces.map((surface) => surface.surface_id).sort(),
    "the answered route-map surfaces are exactly the registered ones",
  );
  for (const row of ANALYTICS_ROUTE_SURFACES) {
    if (row.route_surface_id) continue;
    assert.ok(UNREGISTERED_BY_DESIGN.has(row.surface), `${row.surface} has no route-map row and no declared reason`);
    assert.ok(row.unregistered_reason, `${row.surface} must state why it is not in the route map`);
  }
});

test("each answered surface carries the route map's own matcher paths and family", () => {
  for (const surface of manifest.surfaces) {
    const row = ANALYTICS_ROUTE_SURFACES.find((candidate) => candidate.route_surface_id === surface.surface_id);
    assert.ok(row, `${surface.surface_id} is unanswered`);
    assert.equal(row.route_family, surface.route_family, surface.surface_id);
    assert.deepEqual(
      [...row.patterns].sort(),
      surface.public_safe_matcher.map((matcher) => matcher.pathname).sort(),
      `${surface.surface_id} matcher paths drifted`,
    );
    // Every path the map registers resolves to that surface, with a record segment filled in
    // where the map uses a template.
    for (const pattern of row.patterns) {
      const concrete = pattern.replace(/\{[a-z][a-z0-9-]*\}/g, "sample");
      assert.equal(resolveAnalyticsSurface(concrete).surface, row.surface, concrete);
    }
  }
});

test("the extensionless path a document is actually served at resolves to its surface", () => {
  // The platform answers 308 from /stats.html to /stats, so a reader's browser sits on the
  // second one. Before these aliases, that was the exact path that fell through to "home".
  for (const [alias, expected] of Object.entries({
    "/stats": "stats",
    "/about": "about",
    "/api": "api",
    "/data": "data",
    "/changelog": "changelog",
    "/standards": "standards",
  })) {
    assert.equal(resolveAnalyticsSurface(alias).surface, expected, alias);
    assert.equal(resolveAnalyticsSurface(`${alias}.html`).surface, expected, `${alias}.html`);
  }
});

test("an unregistered route resolves to nothing, and never to a neighbour", () => {
  for (const pathname of [
    "/not-a-route", "/notices", "/browse/nothing", "/stats/extra", "/agencies/a/b",
    "", "//evil", "/search?q=x", "/search#top", "relative",
  ]) {
    const resolved = resolveAnalyticsSurface(pathname);
    assert.equal(resolved.classification_state, "unclassified", pathname);
    assert.equal(resolved.surface, null, pathname);
  }
});

test("every document that ships the collector resolves to a producible surface", () => {
  const documents = collectorDocuments();
  assert.ok(documents.length > 10, "the collector ships on more than a handful of documents");
  const produced = new Set();
  for (const document of documents) {
    const resolved = resolveAnalyticsSurface(document.route);
    assert.ok(resolved.surface, `${document.route} (${document.path}) resolves to no surface`);
    assert.ok(
      ANALYTICS_COLLECTOR_SURFACES.includes(resolved.surface),
      `${document.route} resolves to ${resolved.surface}, which is not declared producible`,
    );
    produced.add(resolved.surface);
  }
  // And the reverse: nothing is accepted that no document can produce.
  assert.deepEqual([...produced].sort(), [...ANALYTICS_COLLECTOR_SURFACES].sort());
});

test("the vocabulary is closed, sorted, and free of duplicates", () => {
  assert.deepEqual(ANALYTICS_SURFACES, [...ANALYTICS_SURFACES].sort());
  assert.equal(new Set(ANALYTICS_SURFACES).size, ANALYTICS_SURFACES.length);
  for (const row of ANALYTICS_NON_ROUTE_SURFACES) {
    assert.ok(row.reason, `${row.surface} must state why it is not a route`);
    assert.equal(resolveAnalyticsSurface(`/${row.surface}`).surface, null, "a delivery surface is not a path");
  }
  assert.ok(isAnalyticsSurface("stats"));
  assert.equal(isAnalyticsSurface("not-a-surface"), false);
});

test("resolution reads a pathname and nothing else", () => {
  const source = readFileSync(new URL("../site/analytics_surface_taxonomy.mjs", import.meta.url), "utf8");
  // No clock, no store, no network, no import: this module is loaded in a browser on every
  // page that measures anything.
  assert.doesNotMatch(source, /\bfetch\(|Date\.now|new Date\(|localStorage|document\./);
  assert.doesNotMatch(source, /^import /m);
});
