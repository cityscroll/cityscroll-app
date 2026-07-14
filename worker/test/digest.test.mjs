// Proves the alerts "confidence" logic: a subscriber should never be left guessing whether silence
// means "nothing matched" or "it's broken." Pure decision + formatting, no KV/network needed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { digestDecision, daysBetween, shortDate, dedupeFreshByContent, matchEvidence } from "../src/lib/digest.mjs";

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

// dedupeFreshByContent: a measured identifier audit found 24 groups of Award notices, out of
// 53,007 rows, that are byte-identical republications under a DIFFERENT request_id — the
// `seen`-set (keyed on request_id alone, alerts.mjs) can't catch those, so before this fix a
// subscriber watching that agency/keyword saw the same notice twice in one digest email.
const republished = {
  request_id: "20260601001", pin: "85024B0001", agency_name: "Department of Sanitation",
  short_title: "Snow removal equipment maintenance", vendor_name: "Acme Snow & Ice LLC",
  start_date: "2026-06-01", contract_amount: 250000,
};

test("before: two rows sharing pin/agency/title/vendor/start_date but different request_id both counted as fresh", () => {
  const dup = { ...republished, request_id: "20260601002" };
  const naiveFresh = [republished, dup]; // what alerts.mjs's request_id-only seen-set used to produce
  assert.equal(naiveFresh.length, 2, "sanity: distinct request_ids, no request_id-level dedupe would catch this");
});

test("after: dedupeFreshByContent collapses the republished duplicate to one line item", () => {
  const dup = { ...republished, request_id: "20260601002" };
  const out = dedupeFreshByContent([republished, dup]);
  assert.equal(out.length, 1);
  assert.equal(out[0].request_id, republished.request_id, "keeps the first-seen request_id");
});

test("rows differing only by an untracked field (amount, request_id) still collapse", () => {
  const amended = { ...republished, request_id: "20260601003", contract_amount: 999999 };
  const out = dedupeFreshByContent([republished, amended]);
  assert.equal(out.length, 1, "contract_amount isn't part of the fingerprint — a republished notice with a typo-fixed amount still dedupes");
});

test("rows differing in a fingerprint field (a genuinely different notice) are NOT collapsed", () => {
  const differentStart = { ...republished, request_id: "20260601004", start_date: "2026-06-15" };
  const differentVendor = { ...republished, request_id: "20260601005", vendor_name: "Best Ice Removal Corp" };
  const out = dedupeFreshByContent([republished, differentStart, differentVendor]);
  assert.equal(out.length, 3, "distinct start_date/vendor_name means these are legitimately different notices");
});

test("missing fingerprint fields (null/undefined) don't crash and don't over-collapse unrelated rows", () => {
  const a = { request_id: "1", pin: null, agency_name: null, short_title: null, vendor_name: null, start_date: null };
  const b = { request_id: "2", pin: null, agency_name: null, short_title: null, vendor_name: null, start_date: null };
  const out = dedupeFreshByContent([a, b]);
  assert.equal(out.length, 1, "two rows with identically-missing fields still fingerprint-match (expected, if rare)");
});

// matchEvidence: an "education" alert once surfaced "NOS - Equity Index Investment Management
// Products" (an Office of the Comptroller pension-fund notice) with nothing visible explaining
// the match — the subscriber had to open the notice to learn the hit was buried in the
// description, which names the Board of Education Retirement System (one of the pension funds
// the notice covers). Neither the title nor the meta line a digest renders gave any hint why.
const compTitle = "NOS - Equity Index Investment Management Products";
const compDescription =
  "The New York City Office of the Comptroller, Bureau of Asset Management, is soliciting " +
  "proposals on behalf of the Boards of Trustees of the New York City Employees' Retirement " +
  "System, Teachers' Retirement System, and the Board of Education Retirement System for " +
  "equity index investment management products.";

test("before: 'education' doesn't appear in the title at all — old rendering had nothing to show", () => {
  assert.equal(compTitle.toLowerCase().includes("education"), false);
});

test("after: matchEvidence finds 'education' in the description and returns a centered snippet naming it", () => {
  const ev = matchEvidence(compTitle, compDescription, ["education"]);
  assert.equal(ev.field, "description");
  assert.equal(ev.term, "education");
  assert.match(ev.hit, /^[Ee]ducation$/);
  assert.match(ev.before + ev.hit + ev.after, /Board of Education Retirement System/);
});

test("matchEvidence: a term that's in the title takes priority over the description", () => {
  const ev = matchEvidence(compTitle, compDescription, ["equity"]);
  assert.equal(ev.field, "title");
  assert.equal(ev.term, "equity");
  assert.equal(compTitle.slice(ev.index, ev.index + ev.term.length).toLowerCase(), "equity");
});

test("matchEvidence: case-insensitive on both title and description", () => {
  assert.equal(matchEvidence("Snow Removal", "", ["SNOW"]).field, "title");
  assert.equal(matchEvidence("x", "Board of EDUCATION Retirement System", ["education"]).field, "description");
});

test("matchEvidence: no keywords (amount/name-only watches) -> null, nothing to explain", () => {
  assert.equal(matchEvidence(compTitle, compDescription, []), null);
  assert.equal(matchEvidence(compTitle, compDescription, undefined), null);
});

test("matchEvidence: multiple OR-terms — first hit found wins, by field priority not list order", () => {
  const ev = matchEvidence(compTitle, compDescription, ["nonexistent", "education", "equity"]);
  assert.equal(ev.field, "title", "'equity' is in the title, so it wins over 'education' even though it's listed later");
  assert.equal(ev.term, "equity");
});

test("matchEvidence: term matched via a field this digest doesn't fetch -> 'unknown', names the term rather than showing nothing", () => {
  const ev = matchEvidence(compTitle, compDescription, ["sanitation"]);
  assert.equal(ev.field, "unknown");
  assert.equal(ev.term, "sanitation");
});

test("matchEvidence: description snippet is truncated with an ellipsis, not the whole field", () => {
  const longDesc = "x".repeat(500) + " target " + "y".repeat(500);
  const ev = matchEvidence("no match here", longDesc, ["target"]);
  assert.equal(ev.field, "description");
  assert.ok(ev.before.startsWith("…"), "truncated on the left");
  assert.ok(ev.after.endsWith("…"), "truncated on the right");
  assert.ok(ev.before.length < 100 && ev.after.length < 100, "snippet stays short, not the full 500+ char field");
});
