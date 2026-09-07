// Replays the four findings a scheduled rehearsal reported on three consecutive runs, and pins
// the rule each one turned out to be testing. The inputs are the published evidence: one source
// gateway timeout, two zero-item digests on watches with prior items, and an aggregate total of
// 234 against a trailing average of 47.857142857142854.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DIGEST_SHADOW_ATTENTION,
  DIGEST_SHADOW_DEGRADED_UPSTREAM,
  DIGEST_SHADOW_READY,
  buildDigestShadowSummary,
} from "../src/digest_shadow.mjs";
import { buildDigestShadowHoldState, isDigestHeld } from "../src/digest_shadow_hold.mjs";
import { dayLogBuiltItemTotal } from "../src/lib/digest_ops.mjs";
import { fetchSodaRowsWithRetry } from "../src/alerts.mjs";

const NOW = new Date("2026-09-07T10:00:00.000Z");
const QUIET_A = "digest:3aec7b8a2b2579e8f3628b3e";
const QUIET_B = "digest:a2efc3db0071310ea8dddaff";

function html(count) {
  const items = Array.from({ length: count }, (_, index) => `<li data-digest-item="1">item ${index + 1}</li>`).join("");
  return `<ul>${items}</ul><a href="https://cityscroll.org/#notice/1">View</a>`
    + '<a href="https://api.cityscroll.org/unsubscribe?example=1">Unsubscribe</a>';
}

function digest({ id, sub, count = 0, found = 0, action = "match", forecasts = 0 }) {
  return {
    sub,
    previewId: id,
    kind: "subscription",
    lens: "money",
    emailRedacted: "ab***@example.com",
    found,
    new: count,
    forecasts,
    action,
    dryRun: true,
    preview: {
      subject: "CityScroll preview",
      html: html(count + forecasts),
      listUnsubscribe: "<https://api.cityscroll.org/unsubscribe?example=1>",
    },
  };
}

// The watch whose source read timed out, exactly as the build path now reports it.
function timedOutWatch() {
  return {
    watch: "rivington",
    previewId: "watch:rivington",
    error: "SODA 524 (source unavailable after 3 attempts)",
    upstream: { source: "soda", http_status: 524, attempts: 3 },
  };
}

// Seven stored days. Each built 60 items and delivered fewer, which is what the trailing average
// used to be taken over: 335 delivered across seven days is 47.857142857142854.
function history() {
  const days = [];
  for (let index = 1; index <= 7; index++) {
    const day = `2026-09-0${7 - index}`;
    days.push({
      day,
      sentCount: 2,
      totalNotices: index === 1 ? 47 : 48,
      entries: [
        { day, id: "sub:quiet-a", noticeCount: 21, forecasts: 0, sent: index <= 2 },
        { day, id: "sub:quiet-b", noticeCount: 21, forecasts: 0, sent: index <= 2 },
        { day, id: "sub:busy", noticeCount: 18, forecasts: 0, sent: index <= 2 },
      ],
    });
  }
  return days;
}

function reportedRun() {
  return [
    timedOutWatch(),
    // Both quiet digests still match rows; none of them are new. This is the heartbeat the
    // digest decision deliberately sends so a quiet inbox never looks like a broken alert.
    digest({ id: QUIET_A, sub: "sub:quiet-a", count: 0, found: 19, action: "heartbeat" }),
    digest({ id: QUIET_B, sub: "sub:quiet-b", count: 0, found: 14, action: "weekly-empty" }),
    digest({ id: "digest:busy", sub: "sub:busy", count: 180, found: 190, action: "match", forecasts: 54 }),
  ];
}

test("a source gateway timeout is reported as an upstream outage, not a digest defect", () => {
  const out = buildDigestShadowSummary({ run: { results: [timedOutWatch()] }, history: [], now: NOW });

  assert.equal(out.redlines.find((item) => item.code === "render_error"), undefined);
  assert.equal(out.status, DIGEST_SHADOW_DEGRADED_UPSTREAM);
  assert.equal(out.ok, true);
  const incident = out.upstream_incidents[0];
  assert.equal(incident.code, "upstream_source_unavailable");
  assert.equal(incident.digest_id, "watch:rivington");
  assert.equal(incident.evidence.http_status, 524);
  assert.equal(incident.evidence.attempts, 3);
  assert.deepEqual(out.upstream_sources_unavailable, ["soda"]);
  // Nothing to serve and it says so, rather than implying a digest exists.
  assert.deepEqual(incident.degraded_output, {
    mode: "none",
    reason: "no previously rendered digest is stored for this id",
  });
});

test("an unavailable source serves the last good digest, dated", () => {
  const out = buildDigestShadowSummary({
    run: { results: [timedOutWatch()] },
    history: [],
    now: NOW,
    lastGoodPreviews: new Map([["watch:rivington", { run_day: "2026-09-05", item_count: 6 }]]),
  });
  assert.deepEqual(out.upstream_incidents[0].degraded_output, {
    mode: "last_good_digest",
    served_from_run_day: "2026-09-05",
    item_count: 6,
  });
});

test("a source that rejects our query is still our defect", () => {
  const out = buildDigestShadowSummary({
    run: { results: [{ watch: "malformed", previewId: "watch:malformed", error: "SODA 400" }] },
    history: [],
    now: NOW,
  });
  assert.equal(out.status, DIGEST_SHADOW_ATTENTION);
  assert.equal(out.redlines[0].code, "render_error");
  assert.deepEqual(out.upstream_incidents, []);
});

test("an upstream outage never holds a digest", () => {
  const out = buildDigestShadowSummary({ run: { results: [timedOutWatch()] }, history: [], now: NOW });
  const hold = buildDigestShadowHoldState({ summary: out, now: "2026-09-07T13:00:00.000Z" });
  assert.equal(hold.source_status, "UPSTREAM_SOURCE_UNAVAILABLE");
  assert.equal(hold.delivery_policy, "ALL_DIGESTS_ELIGIBLE");
  assert.deepEqual(hold.active_digest_ids, []);
  assert.equal(isDigestHeld(hold, "watch:rivington"), false);
});

test("a quiet digest on a watch whose query still matches is not a recall drop", () => {
  const out = buildDigestShadowSummary({ run: { results: reportedRun() }, history: history(), now: NOW });
  assert.deepEqual(out.redlines.filter((item) => item.code === "historical_watch_zero"), []);
  const quiet = out.per_watch_item_counts.find((watch) => watch.digest_id === QUIET_A);
  assert.equal(quiet.evaluation_state, "quiet");
  assert.equal(quiet.matched_row_count, 19);
  assert.equal(quiet.digest_action, "heartbeat");
});

test("a watch whose query stopped matching anything still redlines, and says so", () => {
  const run = [digest({ id: QUIET_A, sub: "sub:quiet-a", count: 0, found: 0, action: "heartbeat" })];
  const out = buildDigestShadowSummary({ run: { results: run }, history: history(), now: NOW });
  const warning = out.redlines.find((item) => item.code === "historical_watch_zero");
  assert.ok(warning);
  assert.equal(warning.evidence.matched_row_count, 0);
  assert.equal(warning.evidence.digest_action, "heartbeat");
  assert.equal(warning.evidence.trailing_max_item_count, 21);
  assert.equal(warning.evidence.trailing_max_day, "2026-09-06");
});

test("the trailing average is taken over items built, not items delivered", () => {
  // Three of the seven stored days were held back from delivery. Read as delivered items they
  // average 47.86 and this run looks like a 4.9x explosion; read as items built they do not.
  const logs = history();
  assert.equal(dayLogBuiltItemTotal(logs[0]), 60);
  const delivered = logs.map((log) => log.totalNotices);
  const deliveredAverage = delivered.reduce((sum, value) => sum + value, 0) / delivered.length;
  assert.equal(deliveredAverage, 47.857142857142854);

  const out = buildDigestShadowSummary({ run: { results: reportedRun() }, history: logs, now: NOW });
  assert.equal(out.total_items, 234);
  assert.equal(out.trailing_average, 60);
  assert.equal(out.trailing_average_basis, "built_digest_items");
  assert.equal(out.redlines.find((item) => item.code === "aggregate_count_explosion"), undefined);
});

test("the reported run reduces to one upstream outage and no redline", () => {
  const out = buildDigestShadowSummary({ run: { results: reportedRun() }, history: history(), now: NOW });
  assert.deepEqual(out.redlines, []);
  assert.equal(out.status, DIGEST_SHADOW_DEGRADED_UPSTREAM);
  assert.equal(out.upstream_incidents.length, 1);
  assert.deepEqual(out.affected_digest_ids, []);
});

test("a run with every source answering and nothing amiss is READY", () => {
  const run = reportedRun().slice(1);
  const out = buildDigestShadowSummary({ run: { results: run }, history: history(), now: NOW });
  assert.equal(out.status, DIGEST_SHADOW_READY);
  assert.equal(out.ok, true);
  assert.equal(out.trailing_average_comparable, true);
});

test("a genuine explosion against comparable days still redlines", () => {
  const logs = history().map((log) => ({
    ...log,
    entries: log.entries.map((entry) => ({ ...entry, noticeCount: 4 })),
  }));
  const out = buildDigestShadowSummary({ run: { results: reportedRun().slice(1) }, history: logs, now: NOW });
  const warning = out.redlines.find((item) => item.code === "aggregate_count_explosion");
  assert.ok(warning);
  assert.equal(warning.evidence.trailing_average, 12);
});

test("a source read is retried on a budget before it is given up on", async () => {
  const waits = [];
  let calls = 0;
  await assert.rejects(
    fetchSodaRowsWithRetry("https://example.test/soda", {
      fetchFn: async () => { calls++; return new Response(null, { status: 524 }); },
      waitFn: async (milliseconds) => { waits.push(milliseconds); },
    }),
    /SODA 524 \(source unavailable after 3 attempts\)/,
  );
  assert.equal(calls, 3);
  assert.deepEqual(waits, [250, 1000]);
});

test("the retry budget bounds how long one unwell source can stall a run", async () => {
  let clock = 0;
  let calls = 0;
  await assert.rejects(
    fetchSodaRowsWithRetry("https://example.test/soda", {
      fetchFn: async () => { calls++; clock += 3000; return new Response(null, { status: 503 }); },
      waitFn: async () => {},
      nowFn: () => clock,
    }),
    /SODA 503/,
  );
  assert.equal(calls, 2);
});
