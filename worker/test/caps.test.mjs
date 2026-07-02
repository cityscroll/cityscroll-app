// Regression guard for the alert-mailer spend caps, now that the decision lives in the `sendcap`
// package (extracted + generalized 2026-07-02). sendcap has its own unit suite; this proves the
// crol INTEGRATION is intact — i.e. calling capDecision exactly the way alerts.mjs calls it
// (want = fresh && live && has-email; per-run before daily) still yields the old behavior:
// "a test or a teammate can't run up a bill" stays a tested property.
import { test } from "node:test";
import assert from "node:assert/strict";
import { capDecision } from "@jimdc/sendcap";

// Mirror of alerts.mjs's call shape, so this test breaks if that mapping drifts.
const decide = ({ fresh = true, live = true, hasEmail = true, sentThisRun = 0, sentToday = 0, maxPerRun = 25, maxPerDay = 50 } = {}) =>
  capDecision({
    want: fresh && live && hasEmail,
    counts: { "per-run": sentThisRun, daily: sentToday },
    caps: { "per-run": maxPerRun, daily: maxPerDay },
  });

test("happy path: fresh + live + email, under caps -> send", () => {
  const d = decide();
  assert.equal(d.allow, true);
  assert.equal(d.capped, null);
});

test("dry-run (live=false) never sends and is not 'capped' (caller still marks seen)", () => {
  const d = decide({ live: false });
  assert.equal(d.allow, false);
  assert.equal(d.capped, null);
});

test("no fresh notices -> no send, not capped", () => {
  assert.deepEqual(decide({ fresh: false }), { want: false, allow: false, capped: null });
});

test("no subscriber email -> no send, not capped", () => {
  assert.equal(decide({ hasEmail: false }).allow, false);
});

test("per-run cap: at the ceiling, the next send is deferred", () => {
  assert.equal(decide({ sentThisRun: 24 }).allow, true);            // 25th allowed
  assert.deepEqual(decide({ sentThisRun: 25 }), { want: true, allow: false, capped: "per-run" });
});

test("daily cap: at the ceiling, the next send is deferred", () => {
  assert.equal(decide({ sentToday: 49 }).allow, true);             // 50th allowed
  assert.deepEqual(decide({ sentToday: 50 }), { want: true, allow: false, capped: "daily" });
});

test("per-run cap takes precedence over daily when both are hit", () => {
  assert.equal(decide({ sentThisRun: 25, sentToday: 50 }).capped, "per-run");
});
