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
const ADDITIVE_SINCE_RUM07 = Object.freeze(["search_executions"]);

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
  assert.deepEqual(Object.keys(body), ["schema", "generated_at", "scope", "coverage", "language_coverage"]);
  assert.deepEqual(Object.keys(body.coverage), ["available", "measurement", "metrics", "evidence_vintage", "domains"]);
  // The route publishes the projection and nothing else: no field is added on the way out.
  assert.equal(text, JSON.stringify(buildPublicStatsBody(undefined, new Date(NOW)), null, 2));
  const snapshot = JSON.parse(readFileSync(new URL("../../site/data/served_coverage_snapshot.json", import.meta.url), "utf8"));
  assert.deepEqual(body.coverage.domains, snapshot.domains);
  assert.doesNotMatch(text, /performance|percentile|p50|p75|p95|sample_floor/);
});
