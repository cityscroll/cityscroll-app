// Proves the alerts spend-guard math — so "a test or a teammate can't run up a bill" is a
// tested property, not a comment. Pure decision function, no KV/network needed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { capDecision } from "../src/lib/sendcap.mjs";

const base = { hasFresh: true, live: true, hasEmail: true, sentThisRun: 0, sentToday: 0, maxPerRun: 25, maxPerDay: 50 };

test("happy path: fresh + live + email, under caps -> send", () => {
  assert.deepEqual(capDecision(base), { wantSend: true, send: true, capped: null });
});

test("dry-run (live=false) never sends and is not 'capped'", () => {
  const d = capDecision({ ...base, live: false });
  assert.equal(d.send, false);
  assert.equal(d.capped, null);   // null, not "daily" — so the caller still marks seen in dry-run
  assert.equal(d.wantSend, false);
});

test("no fresh notices -> no send, not capped", () => {
  assert.deepEqual(capDecision({ ...base, hasFresh: false }), { wantSend: false, send: false, capped: null });
});

test("no subscriber email -> no send, not capped", () => {
  assert.equal(capDecision({ ...base, hasEmail: false }).send, false);
});

test("per-run cap: at the ceiling, the next send is deferred", () => {
  assert.equal(capDecision({ ...base, sentThisRun: 24 }).send, true);          // 25th allowed
  assert.deepEqual(capDecision({ ...base, sentThisRun: 25 }), { wantSend: true, send: false, capped: "per-run" });
});

test("daily cap: at the ceiling, the next send is deferred", () => {
  assert.equal(capDecision({ ...base, sentToday: 49 }).send, true);            // 50th allowed
  assert.deepEqual(capDecision({ ...base, sentToday: 50 }), { wantSend: true, send: false, capped: "daily" });
});

test("per-run cap takes precedence over daily when both are hit", () => {
  const d = capDecision({ ...base, sentThisRun: 25, sentToday: 50 });
  assert.equal(d.capped, "per-run");
});
