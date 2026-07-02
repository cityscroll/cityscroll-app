// Proves the alerts "confidence" logic: a subscriber should never be left guessing whether silence
// means "nothing matched" or "it's broken." Pure decision + formatting, no KV/network needed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { digestDecision, daysBetween, shortDate } from "../src/lib/digest.mjs";

test("shortDate: ISO date and full timestamp both -> 'Mon D'", () => {
  assert.equal(shortDate("2026-06-30"), "Jun 30");
  assert.equal(shortDate("2026-06-30T22:13:00.000Z"), "Jun 30");
  assert.equal(shortDate("2026-01-05"), "Jan 5");
  assert.equal(shortDate("2026-12-25"), "Dec 25");
});

test("shortDate: junk -> empty string (never throws)", () => {
  assert.equal(shortDate(""), "");
  assert.equal(shortDate(null), "");
  assert.equal(shortDate("not-a-date"), "");
});

test("daysBetween: same day 0, +1 day, and forward span", () => {
  assert.equal(daysBetween("2026-07-01", "2026-07-01"), 0);
  assert.equal(daysBetween("2026-06-30", "2026-07-01"), 1);
  assert.equal(daysBetween("2026-06-17", "2026-07-01"), 14);
});

test("daysBetween: null/invalid `from` -> Infinity (a first heartbeat is due)", () => {
  assert.equal(daysBetween(null, "2026-07-01"), Infinity);
  assert.equal(daysBetween("", "2026-07-01"), Infinity);
  assert.equal(daysBetween("garbage", "2026-07-01"), Infinity);
});

const base = { freshCount: 0, freq: "daily", lastSentDate: "2026-07-01", today: "2026-07-01", heartbeatDays: 14 };

test("fresh notices -> always a match digest (daily or weekly)", () => {
  assert.equal(digestDecision({ ...base, freshCount: 3 }).action, "match");
  assert.equal(digestDecision({ ...base, freshCount: 3, freq: "weekly" }).action, "match");
});

test("weekly + no fresh -> weekly-empty check-in (regardless of how recent the last send)", () => {
  assert.equal(digestDecision({ ...base, freq: "weekly" }).action, "weekly-empty");
  assert.equal(digestDecision({ ...base, freq: "weekly", lastSentDate: null }).action, "weekly-empty");
});

test("daily + no fresh, still inside the quiet window -> stay silent (none)", () => {
  assert.equal(digestDecision(base).action, "none");                              // sent today
  assert.equal(digestDecision({ ...base, lastSentDate: "2026-06-19" }).action, "none"); // 12 days
});

test("daily + no fresh, quiet >= heartbeatDays -> heartbeat", () => {
  assert.equal(digestDecision({ ...base, lastSentDate: "2026-06-17" }).action, "heartbeat"); // exactly 14
  assert.equal(digestDecision({ ...base, lastSentDate: "2026-06-01" }).action, "heartbeat"); // 30
});

test("daily + no fresh, never sent (null lastSent) -> heartbeat is due", () => {
  assert.equal(digestDecision({ ...base, lastSentDate: null }).action, "heartbeat");
});

test("heartbeat window is tunable via heartbeatDays", () => {
  assert.equal(digestDecision({ ...base, lastSentDate: "2026-06-24", heartbeatDays: 7 }).action, "heartbeat"); // 7
  assert.equal(digestDecision({ ...base, lastSentDate: "2026-06-26", heartbeatDays: 7 }).action, "none");      // 5
});
