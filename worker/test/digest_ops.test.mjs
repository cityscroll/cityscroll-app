// Pure helpers for the operator digest dashboard: day logs, roster, correctness.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toDayLogEntry,
  buildDayLog,
  mergeDayLogEntry,
  dayRange,
  summarizeDay,
  toRosterRow,
  searchInterestSignal,
  correctnessCheck,
  recountFresh,
  noticeDeepLink,
  digestDayLogKey,
} from "../src/lib/digest_ops.mjs";

test("digestDayLogKey: stable prefix", () => {
  assert.equal(digestDayLogKey("2026-07-30"), "digest:daylog:2026-07-30");
});

test("noticeDeepLink: public site hash route", () => {
  assert.equal(noticeDeepLink("20260730001"), "https://cityscroll.org/#notice/20260730001");
});

test("toDayLogEntry: redacts email, keeps notice ids, marks zero match", () => {
  const e = toDayLogEntry({
    sub: "sub:ab***",
    lens: "money",
    queryLabel: "contract money — about \u201ceducation\u201d",
    email: "owner@example.com",
    emailRedacted: "ow***@example.com",
    found: 0,
    new: 0,
    noticeIds: [],
    action: "none",
    zeroMatch: true,
    sent: false,
  }, { day: "2026-07-30" });
  assert.equal(e.day, "2026-07-30");
  assert.equal(e.email, "ow***@example.com");
  assert.equal(e.zeroMatch, true);
  assert.equal(e.noticeCount, 0);
  assert.deepEqual(e.noticeIds, []);
});

test("toDayLogEntry: sent digest carries deep links for each notice", () => {
  const e = toDayLogEntry({
    sub: "sub:ab***",
    lens: "money",
    queryLabel: "procurement",
    found: 12,
    new: 12,
    noticeIds: ["20260730001", "20260730002"],
    action: "match",
    sent: true,
  });
  // noticeCount follows `new` (the full send count); ids may be a capped sample.
  assert.equal(e.noticeCount, 12);
  assert.equal(e.noticeLinks.length, 2);
  assert.ok(e.noticeLinks[0].includes("#notice/20260730001"));
});

test("buildDayLog: keeps zero-match rows (absence visible)", () => {
  const log = buildDayLog({
    day: "2026-07-30",
    ranAt: "2026-07-30T13:00:00Z",
    live: true,
    mode: "inline",
    results: [
      { sub: "sub:a***", lens: "money", new: 3, found: 3, noticeIds: ["1", "2", "3"], action: "match", sent: true },
      { sub: "sub:b***", lens: "land", new: 0, found: 0, noticeIds: [], action: "none", zeroMatch: true, sent: false },
      { mode: "queue", enqueued: 2 }, // ignored
    ],
  });
  assert.equal(log.entryCount, 2);
  assert.equal(log.sentCount, 1);
  assert.equal(log.zeroSendCount, 1);
  assert.equal(log.totalNotices, 3);
  assert.equal(log.entries[1].zeroMatch, true);
});

test("mergeDayLogEntry: queue consumer replaces same id", () => {
  const first = buildDayLog({
    day: "2026-07-30",
    results: [{ sub: "sub:a***", new: 0, found: 0, action: "none", zeroMatch: true, sent: false }],
  });
  const merged = mergeDayLogEntry(first, toDayLogEntry({
    sub: "sub:a***", new: 2, found: 2, noticeIds: ["x", "y"], action: "match", sent: true,
  }, { day: "2026-07-30" }), { day: "2026-07-30", mode: "queue" });
  assert.equal(merged.entryCount, 1);
  assert.equal(merged.sentCount, 1);
  assert.equal(merged.totalNotices, 2);
});

test("dayRange: inclusive end, newest first", () => {
  const days = dayRange("2026-07-30", 3);
  assert.deepEqual(days, ["2026-07-30", "2026-07-29", "2026-07-28"]);
});

test("summarizeDay: missing log still returns the day (absence visible)", () => {
  const s = summarizeDay({ day: "2026-07-28", dayLog: null, receipt: null, sendcount: 0 });
  assert.equal(s.day, "2026-07-28");
  assert.equal(s.hasLog, false);
  assert.deepEqual(s.sends, []);
  assert.equal(s.sendcount, 0);
});

test("toRosterRow + searchInterestSignal", () => {
  const a = toRosterRow({
    email: "alice@example.com",
    lens: "money",
    filter: { keywords: ["education"] },
    freq: "daily",
    createdAt: "2026-07-01T00:00:00.000Z",
  }, { lastSent: "2026-07-29", key: "sub:al***" });
  const b = toRosterRow({
    email: "bob@example.com",
    lens: "money",
    filter: { keywords: ["education"] },
    freq: "weekly",
    createdAt: "2026-07-10T00:00:00.000Z",
  }, { lastSent: "2026-07-28" });
  assert.equal(a.confirmed, true);
  assert.equal(a.email, "alice@example.com");
  assert.match(a.query, /education/i);
  const q = searchInterestSignal([a, b]);
  assert.equal(q.length, 1);
  assert.equal(q[0].subscriberCount, 2);
});

test("recountFresh: drops already-seen ids", () => {
  const r = recountFresh({
    rows: [{ request_id: "a" }, { request_id: "b" }, { request_id: "a" }],
    idField: "request_id",
    seenIds: ["a"],
  });
  assert.equal(r.noticeCount, 1);
  assert.deepEqual(r.noticeIds, ["b"]);
});

test("correctnessCheck: no_log status when day log missing", () => {
  const c = correctnessCheck({ day: "2026-07-30", dayLog: null });
  assert.equal(c.status, "no_log");
  assert.equal(c.ok, false);
});

test("correctnessCheck: ok when logged found matches day-scoped recount", () => {
  const dayLog = buildDayLog({
    day: "2026-07-30",
    results: [
      { sub: "sub:a***", lens: "money", queryLabel: "edu", found: 2, new: 2, noticeIds: ["1", "2"], action: "match", sent: true },
      { sub: "sub:b***", lens: "money", queryLabel: "quiet", found: 0, new: 0, noticeIds: [], action: "none", zeroMatch: true, sent: false },
    ],
  });
  const c = correctnessCheck({
    day: "2026-07-30",
    dayLog,
    recounts: {
      "sub:a***": { noticeCount: 2, noticeIds: ["1", "2"] },
      "sub:b***": { noticeCount: 0, noticeIds: [] },
    },
  });
  assert.equal(c.status, "ok");
  assert.equal(c.ok, true);
  assert.equal(c.checked, 2);
  assert.equal(c.divergences.length, 0);
});

test("correctnessCheck: silent_miss when found=0 but recount finds notices", () => {
  // The five-day outage class: digest thought nothing matched; a fresh recount finds rows.
  const dayLog = buildDayLog({
    day: "2026-07-15",
    results: [
      {
        sub: "sub:a***",
        lens: "money",
        queryLabel: "procurement",
        found: 0,
        new: 0,
        noticeIds: [],
        action: "none",
        zeroMatch: true,
        sent: false,
      },
    ],
  });
  const c = correctnessCheck({
    day: "2026-07-15",
    dayLog,
    recounts: {
      "sub:a***": { noticeCount: 7, noticeIds: ["a", "b", "c", "d", "e", "f", "g"] },
    },
  });
  assert.equal(c.status, "diverge");
  assert.equal(c.ok, false);
  assert.equal(c.divergences.length, 1);
  assert.equal(c.divergences[0].reason, "silent_miss");
  assert.match(c.summary, /silent miss/i);
});

test("correctnessCheck: already-seen (found>0, new=0) is not a silent miss", () => {
  const dayLog = buildDayLog({
    day: "2026-07-30",
    results: [
      {
        sub: "sub:a***",
        lens: "money",
        found: 5,
        new: 0,
        noticeIds: [],
        action: "none",
        sent: false,
      },
    ],
  });
  const c = correctnessCheck({
    day: "2026-07-30",
    dayLog,
    recounts: { "sub:a***": { noticeCount: 5, noticeIds: [] } },
  });
  assert.equal(c.status, "ok", "seen notices still present in day-scoped recount must not flag");
});

// Catch-up digests intentionally send a multi-day window since the watermark.
// A day-scoped recount for "today" can correctly be 0 while noticeCount is N —
// that must not read as phantom_send (false ops alarm after recovery).
test("correctnessCheck: catch-up send with day-scoped expected=0 is ok (not phantom_send)", () => {
  const dayLog = buildDayLog({
    day: "2026-07-31",
    mode: "catch_up",
    results: [
      {
        sub: "sub:edu***",
        lens: "money",
        queryLabel: "education",
        found: 3,
        new: 3,
        noticeIds: ["a", "b", "c"],
        action: "catch_up",
        sent: true,
      },
    ],
  });
  const c = correctnessCheck({
    day: "2026-07-31",
    dayLog,
    recounts: { "sub:edu***": { noticeCount: 0, noticeIds: [] } },
  });
  assert.equal(c.status, "ok", "catch-up multi-day recovery must not flag day-scoped zero as phantom");
  assert.equal(c.ok, true);
  assert.equal(c.divergences.length, 0);
  assert.equal(c.checked, 1);
  assert.equal(c.matched, 1);
  assert.equal(c.catchUpExempt, 1);
  assert.match(c.summary, /catch-up/i);
});

test("correctnessCheck: normal match with expected=0 is still phantom_send", () => {
  const dayLog = buildDayLog({
    day: "2026-07-31",
    results: [
      {
        sub: "sub:edu***",
        lens: "money",
        queryLabel: "education",
        found: 3,
        new: 3,
        noticeIds: ["a", "b", "c"],
        action: "match",
        sent: true,
      },
    ],
  });
  const c = correctnessCheck({
    day: "2026-07-31",
    dayLog,
    recounts: { "sub:edu***": { noticeCount: 0, noticeIds: [] } },
  });
  assert.equal(c.status, "diverge");
  assert.equal(c.ok, false);
  assert.equal(c.divergences.length, 1);
  assert.equal(c.divergences[0].reason, "phantom_send");
  assert.equal(c.catchUpExempt || 0, 0);
});

test("correctnessCheck: silent_miss still diverges (unchanged)", () => {
  const dayLog = buildDayLog({
    day: "2026-07-15",
    results: [
      {
        sub: "sub:a***",
        lens: "money",
        queryLabel: "procurement",
        found: 0,
        new: 0,
        noticeIds: [],
        action: "none",
        zeroMatch: true,
        sent: false,
      },
    ],
  });
  const c = correctnessCheck({
    day: "2026-07-15",
    dayLog,
    recounts: {
      "sub:a***": { noticeCount: 7, noticeIds: ["a", "b", "c", "d", "e", "f", "g"] },
    },
  });
  assert.equal(c.status, "diverge");
  assert.equal(c.divergences[0].reason, "silent_miss");
});

test("correctnessCheck: traffic_class catch_up without action string is exempt", () => {
  // Historical / partial rows may only carry traffic_class.
  const dayLog = {
    day: "2026-07-31",
    mode: "inline",
    entries: [
      {
        id: "sub:sw***",
        lens: "money",
        query: "software",
        found: 2,
        noticeCount: 2,
        noticeIds: ["x", "y"],
        action: null,
        traffic_class: "catch_up",
        sent: true,
        error: null,
      },
    ],
  };
  const c = correctnessCheck({
    day: "2026-07-31",
    dayLog,
    recounts: { "sub:sw***": { noticeCount: 0, noticeIds: [] } },
  });
  assert.equal(c.status, "ok");
  assert.equal(c.divergences.length, 0);
  assert.equal(c.catchUpExempt, 1);
});

test("correctnessCheck: catch-up over-count vs day (count_mismatch) is exempt", () => {
  const dayLog = buildDayLog({
    day: "2026-07-31",
    results: [
      {
        sub: "sub:edu***",
        lens: "money",
        queryLabel: "education",
        found: 5,
        new: 5,
        noticeIds: ["1", "2", "3", "4", "5"],
        action: "catch_up",
        sent: true,
      },
    ],
  });
  const c = correctnessCheck({
    day: "2026-07-31",
    dayLog,
    recounts: { "sub:edu***": { noticeCount: 1, noticeIds: ["5"] } },
  });
  assert.equal(c.status, "ok");
  assert.equal(c.divergences.length, 0);
  assert.equal(c.catchUpExempt, 1);
});

test("toDayLogEntry: catch_up action stamps traffic_class catch_up", () => {
  const e = toDayLogEntry({
    sub: "sub:a***",
    lens: "money",
    found: 3,
    new: 3,
    noticeIds: ["1", "2", "3"],
    action: "catch_up",
    sent: true,
  });
  assert.equal(e.action, "catch_up");
  assert.equal(e.traffic_class, "catch_up");
});

test("toDayLogEntry: mode catch_up stamps traffic_class even if action differs", () => {
  const e = toDayLogEntry({
    sub: "sub:a***",
    lens: "money",
    found: 1,
    new: 1,
    noticeIds: ["1"],
    mode: "catch_up",
    action: "match",
    sent: true,
  });
  assert.equal(e.traffic_class, "catch_up");
});
