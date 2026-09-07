/**
 * Characterization captured from the landed RUM-07 baseline before /admin/performance was
 * implemented. It makes the separation invariant explicit: the field-performance contract
 * cannot change private usage or public stats. The authenticated response is pinned by hash;
 * the public response is pinned by shape, because its body carries served-coverage counts that
 * a data refresh legitimately moves.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { readFileSync } from "node:fs";

import { ANALYTICS_COLLECTOR_SURFACES } from "../../site/analytics_surface_taxonomy.mjs";
import { TAXONOMY_VERSION } from "../src/lib/analytics.mjs";
import { handleAdminStats } from "../src/admin.mjs";
import { buildPublicStatsBody, handleStats } from "../src/stats.mjs";

const NOW = "2026-08-05T18:00:00Z";
const ADMIN_STATS_RUM07_SHA256 = "1c5284e6cb48a5b562a9cf0a32d1621e3886b877afe91cb000f913d0e13d85b2";
// The public response now projects the served-coverage snapshot, whose counts move with every
// data refresh. A hash over that body would pin a figure that an unrelated refresh changes, so
// the public side is characterized by its shape — key names and order, headers, and the exact
// projection it publishes — which is what this file's separation invariant is actually about.

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Fields added since the baseline. Each entry is an additive top-level key: removing
 * it must leave the response byte-identical to the RUM-07 capture, which is a stronger
 * claim than "the old keys are still present" — it also proves none of them moved,
 * changed value, or changed order.
 */
const ADDITIVE_SINCE_RUM07 = Object.freeze([
  "search_executions",
  "measurement_basis",
  "search_usage_lineage",
  "measurement_diagnostics",
]);

/**
 * The one field inside the baseline that deliberately changed shape, and the surfaces it
 * carried when the baseline was captured.
 *
 * The page-view breakdown used to have eleven rows because the browser could only ever name
 * eleven surfaces: it derived one from the last path segment and answered "home" for anything
 * else, so the Search document, the data-health document and each `/browse/<lane>/` document
 * were all counted as the homepage. The breakdown is now shaped by the surfaces that actually
 * ship the collector. Projecting it back onto the eleven the baseline knew, and hashing that,
 * proves this is the only field that moved: everything else still matches byte for byte.
 */
const RUM07_TAXONOMY_VERSION = "1.3.0";
const RUM07_PAGE_VIEW_SURFACES = Object.freeze([
  "home", "now", "near-you", "following", "browse",
  "stats", "about", "data", "api", "changelog", "standards",
]);

function asRum07PageViewSurfaces(observed = {}) {
  return Object.fromEntries(RUM07_PAGE_VIEW_SURFACES.map((surface) => [surface, observed[surface] || 0]));
}

test("RUM-08 leaves authenticated /admin/stats byte-compatible with the RUM-07 baseline", async () => {
  const response = await handleAdminStats(
    new Request("https://api.cityscroll.org/admin/stats?key=secret"),
    { ADMIN_KEY: "secret" },
    { now: NOW },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(Object.fromEntries(response.headers), {
    "cache-control": "no-store",
    "content-type": "application/json",
  });
  const text = await response.text();
  const body = JSON.parse(text);
  for (const field of ADDITIVE_SINCE_RUM07) {
    assert.ok(field in body, `${field} is present and accounted for as an additive field`);
    delete body[field];
  }
  // The corrected surface taxonomy is asserted on its own terms, then projected back to the
  // eleven surfaces and the version the baseline knew, so the hash can still speak for
  // everything else. Those two are the whole intended difference.
  assert.deepEqual(
    Object.keys(body.usage.page_views.by_surface_last30d),
    [...ANALYTICS_COLLECTOR_SURFACES],
    "the page-view breakdown covers exactly the documents that ship the collector",
  );
  assert.equal(body.usage.taxonomy_version, TAXONOMY_VERSION);
  body.usage.page_views.by_surface_last30d =
    asRum07PageViewSurfaces(body.usage.page_views.by_surface_last30d);
  body.usage.taxonomy_version = RUM07_TAXONOMY_VERSION;
  assert.equal(
    sha256(`${JSON.stringify(body, null, 2)}`),
    ADMIN_STATS_RUM07_SHA256,
    "every field the baseline captured keeps its name, order, and value",
  );
});

test("SAH-05 reports completed searches additively, and honestly when there is no store", async () => {
  const response = await handleAdminStats(
    new Request("https://api.cityscroll.org/admin/stats?key=secret"),
    { ADMIN_KEY: "secret" },
    { now: NOW },
  );
  const body = JSON.parse(await response.text());
  assert.equal(body.search_executions.schema, "cityscroll.search_usage.v1");
  assert.equal(body.search_executions.available, false);
  assert.equal(body.search_executions.unavailable_reason, "no-store");
  // An absent receipt store is not evidence that nobody searched.
  assert.deepEqual(body.search_executions.windows, {});
});

test("RUM-08 leaves public /stats shape-compatible and performance-free", async () => {
  const response = await handleStats(
    new Request("https://api.cityscroll.org/stats"),
    {},
    { waitUntil: async (promise) => promise },
    { now: NOW, skipCacheRead: true },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(Object.fromEntries(response.headers), {
    "access-control-allow-origin": "*",
    "cache-control": "public, max-age=900",
    "content-type": "application/json; charset=utf-8",
  });
  const text = await response.text();
  const body = JSON.parse(text);
  assert.deepEqual(Object.keys(body),
    ["schema", "generated_at", "scope", "coverage", "language_coverage", "search_usage"]);
  assert.deepEqual(Object.keys(body.coverage), ["available", "measurement", "metrics", "evidence_vintage", "domains"]);
  // The route publishes the projection and nothing else: no field is added on the way out.
  // With no receipt snapshot stored, the usage summary is the honest empty answer, which is
  // exactly what buildPublicStatsBody produces on its own.
  assert.equal(text, JSON.stringify(buildPublicStatsBody(undefined, new Date(NOW)), null, 2));
  const snapshot = JSON.parse(readFileSync(new URL("../../site/data/served_coverage_snapshot.json", import.meta.url), "utf8"));
  assert.deepEqual(body.coverage.domains, snapshot.domains);
  assert.doesNotMatch(text, /performance|percentile|p50|p75|p95|sample_floor/);
  assert.equal(body.search_usage.available, false, "no snapshot is not a measured zero");
});
