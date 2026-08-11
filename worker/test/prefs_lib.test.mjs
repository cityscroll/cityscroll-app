// Preference-center pure helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  prefsPayload,
  isPrefsPayload,
  toPrefsWatchRow,
  applyWatchPatch,
  parsePrefsAction,
  CUTOVER_COPY,
  UNSUB_IMMEDIATE_COPY,
  HEARTBEAT_HELP_COPY,
  PREFS_SCOPE,
} from "../src/lib/prefs.mjs";

test("prefs payload scope", () => {
  const p = prefsPayload("Ada@Example.com");
  assert.equal(p.sc, PREFS_SCOPE);
  assert.equal(p.e, "ada@example.com");
  assert.equal(isPrefsPayload(p), true);
  assert.equal(isPrefsPayload({ sc: "pins", e: "a@b.co" }), false);
  assert.equal(isPrefsPayload({ sc: "prefs", e: "not-an-email" }), false);
});

test("toPrefsWatchRow shapes a SUBS record", () => {
  const row = toPrefsWatchRow({
    email: "a@b.co",
    lens: "money",
    filter: { keywords: ["education"] },
    freq: "weekly",
    paused: true,
    createdAt: "2026-01-01T00:00:00.000Z",
  }, "sub:abc");
  assert.equal(row.key, "sub:abc");
  assert.equal(row.freq, "weekly");
  assert.equal(row.paused, true);
  assert.match(row.query, /education/i);
});

test("applyWatchPatch: freq, pause, keywords", () => {
  const base = {
    email: "a@b.co",
    lens: "money",
    filter: { keywords: ["old"], minAmount: 1000000 },
    freq: "daily",
  };
  const paused = applyWatchPatch(base, { paused: true });
  assert.equal(paused.ok, true);
  assert.equal(paused.record.paused, true);

  const freq = applyWatchPatch(base, { freq: "weekly" });
  assert.equal(freq.record.freq, "weekly");

  const bad = applyWatchPatch(base, { freq: "hourly" });
  assert.equal(bad.ok, false);

  const kw = applyWatchPatch(base, { keywords: ["schools", "education"] });
  assert.equal(kw.ok, true);
  assert.deepEqual(kw.record.filter.keywords, ["schools", "education"]);
  // minAmount preserved through keyword patch
  assert.equal(kw.record.filter.minAmount, 1000000);
});

test("parsePrefsAction accepts form-style keywords string", () => {
  const a = parsePrefsAction({
    action: "update",
    key: "sub:abc",
    keywords: "schools, education",
    freq: "weekly",
  });
  assert.equal(a.action, "update");
  assert.equal(a.key, "sub:abc");
  assert.deepEqual(a.patch.keywords, ["schools", "education"]);
  assert.equal(a.patch.freq, "weekly");
});

test("CUTOVER_COPY documents next digest latency", () => {
  assert.match(CUTOVER_COPY, /next digest/i);
  assert.match(CUTOVER_COPY, /9am Eastern/i);
});

test("unsub and heartbeat help copy are explicit", () => {
  assert.match(UNSUB_IMMEDIATE_COPY, /immediate/i);
  assert.match(HEARTBEAT_HELP_COPY, /14 days/i);
  assert.match(HEARTBEAT_HELP_COPY, /still-watching/i);
});
