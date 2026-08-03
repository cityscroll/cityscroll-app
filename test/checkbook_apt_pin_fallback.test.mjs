import { SITE_SOURCE } from "./helpers/site_source.mjs";
// Precompute-first: notice detail no longer calls Checkbook NYC from the browser.
// Legacy apt_pin fallback used to live in client-side checkbookByPin(); registration
// and payment now come from GET /contract-lifecycle (worker pinMatchStrategy + assembly).
// This file keeps the historical PIN-shape fixtures and pins the migration:
//   - client has no live Checkbook proxy helpers
//   - worker pinMatchStrategy still tries exact PIN then renewal-base fallback
//
//   node --test test/checkbook_apt_pin_fallback.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pinMatchStrategy, usablePin } from "../worker/src/lib/checkbook_lifecycle.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = SITE_SOURCE;

test("client notice detail has no live Checkbook proxy (precompute-first)", () => {
  assert.doesNotMatch(src, /async function checkbookByPin\(/);
  assert.doesNotMatch(src, /async function checkbookQueryByField\(/);
  assert.doesNotMatch(src, /apt_pin/);
  // Dollars + timeline read the edge-materialized lifecycle
  assert.match(src, /\/contract-lifecycle\?id=/);
  assert.match(src, /function lifecycleDollarsHTML\(/);
  assert.match(src, /async function loadLifecycle\(/);
});

test("usablePin accepts legacy-shaped PINs that used to need apt_pin retries", () => {
  // Pre-PASSPort-format example from the original apt_pin characterization
  assert.ok(usablePin("82607Y0012"));
  assert.ok(usablePin("85719P0001"));
  assert.ok(!usablePin("N/A"));
});

test("pinMatchStrategy: modern PIN is exact-only; renewal suffix gets base fallback", () => {
  const modern = pinMatchStrategy("85719P0001");
  assert.equal(modern.strategy, "exact");
  assert.deepEqual(modern.pins, ["85719P0001"]);

  const renewed = pinMatchStrategy("82626R0001001");
  assert.equal(renewed.strategy, "legacy-base");
  assert.equal(renewed.pins[0], "82626R0001001");
  assert.equal(renewed.pins[1], "82626");
});

test("pinMatchStrategy: junk PIN yields none (no Checkbook fan-out)", () => {
  const junk = pinMatchStrategy("N/A");
  assert.equal(junk.strategy, "none");
  assert.deepEqual(junk.pins, []);
});
