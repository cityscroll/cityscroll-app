/**
 * Byte-level characterization captured from the landed RUM-07 baseline before
 * /admin/performance was implemented. These hashes make the separation invariant explicit:
 * the new field-performance contract cannot change private usage or public corpus stats.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { handleAdminStats } from "../src/admin.mjs";
import { handleStats } from "../src/stats.mjs";

const NOW = "2026-08-05T18:00:00Z";
const ADMIN_STATS_RUM07_SHA256 = "1c5284e6cb48a5b562a9cf0a32d1621e3886b877afe91cb000f913d0e13d85b2";
const PUBLIC_STATS_RUM07_SHA256 = "dcd00a56e454304da48a824886fdcaf7514299c4121f6f4eb803130612e01f96";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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
  assert.equal(sha256(await response.text()), ADMIN_STATS_RUM07_SHA256);
});

test("RUM-08 leaves public /stats byte-compatible and performance-free", async () => {
  const response = await handleStats(
    new Request("https://api.cityscroll.org/stats"),
    {},
    { waitUntil: async (promise) => promise },
    {
      now: NOW,
      skipCacheRead: true,
      fetchImpl: async () => Response.json([{
        notice_count: "1099194",
        first_notice_date: "2003-01-02T00:00:00.000",
        latest_notice_date: "2026-08-05T00:00:00.000",
      }]),
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(Object.fromEntries(response.headers), {
    "access-control-allow-origin": "*",
    "cache-control": "public, max-age=900",
    "content-type": "application/json; charset=utf-8",
  });
  const text = await response.text();
  assert.equal(sha256(text), PUBLIC_STATS_RUM07_SHA256);
  assert.doesNotMatch(text, /performance|percentile|p50|p75|p95|sample_floor/);
});
