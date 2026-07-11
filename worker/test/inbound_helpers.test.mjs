// Inbound-email signup helpers: the lens router and the auto-reply/loop guards
// (the parts that decide whether we spend a model call at all).

import { test } from "node:test";
import assert from "node:assert/strict";
import { pickLens, shouldIgnore } from "../src/inbound.mjs";
import { overSurfaceCap, overActorLimit } from "../src/lib/meter.mjs";

class MockKV {
  constructor() { this.store = new Map(); }
  async get(k) { return this.store.has(k) ? this.store.get(k) : null; }
  async put(k, v) { this.store.set(k, String(v)); }
}

test("pickLens routes topics to the right lens, money by default", () => {
  assert.equal(pickLens("rezoning notices in Brooklyn"), "land");
  assert.equal(pickLens("upcoming public hearings about buses"), "meetings");
  assert.equal(pickLens("proposed rule changes from DEP"), "rules");
  assert.equal(pickLens("city-owned property auctions"), "property");
  assert.equal(pickLens("construction contract awards over $500k"), "money");
  assert.equal(pickLens(""), "money");
});

test("shouldIgnore blocks loops, bounces, ourselves, and auto-submitted mail", () => {
  assert.equal(shouldIgnore("alerts@crol-list.org"), true);
  assert.equal(shouldIgnore("subscribe@crol-list.org"), true);
  assert.equal(shouldIgnore("MAILER-DAEMON@example.com"), true);
  assert.equal(shouldIgnore("no-reply@example.com"), true);
  assert.equal(shouldIgnore("someone@example.com", new Map([["auto-submitted", "auto-replied"]])), true);
  assert.equal(shouldIgnore("someone@example.com", new Map([["auto-submitted", "no"]])), false);
  assert.equal(shouldIgnore("someone@example.com"), false);
  assert.equal(shouldIgnore(""), true);
});

test("overSurfaceCap: allows up to max, then blocks; missing store fails open", async () => {
  const kv = new MockKV();
  assert.equal(await overSurfaceCap(kv, "t", 2), false);
  assert.equal(await overSurfaceCap(kv, "t", 2), false);
  assert.equal(await overSurfaceCap(kv, "t", 2), true);
  assert.equal(await overSurfaceCap(null, "t", 2), false);
});

test("overActorLimit: counts attempts per actor per day", async () => {
  const kv = new MockKV();
  for (let i = 0; i < 5; i++) assert.equal(await overActorLimit(kv, "in", "a@b.co", 5), false);
  assert.equal(await overActorLimit(kv, "in", "a@b.co", 5), true);
  assert.equal(await overActorLimit(kv, "in", "other@b.co", 5), false); // separate actor
});
