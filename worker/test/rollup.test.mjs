// Account-level digest rollup: grouping, job fan-out, send decision, daylog kind.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isWatchActive,
  groupSubsByEmail,
  shouldRollup,
  buildDigestJobs,
  sectionWantsSend,
  rollupSendDecision,
  rollupSubject,
  rollupBodySections,
  toRollupDayLogEntry,
  accountLogId,
} from "../src/lib/rollup.mjs";
import { toDayLogEntry, buildDayLog } from "../src/lib/digest_ops.mjs";

const sub = (email, key, extra = {}) => ({
  key,
  email,
  lens: "money",
  filter: { keywords: ["x"] },
  freq: "daily",
  ...extra,
});

test("isWatchActive: paused watches are inactive", () => {
  assert.equal(isWatchActive(sub("a@b.co", "sub:1")), true);
  assert.equal(isWatchActive(sub("a@b.co", "sub:1", { paused: false })), true);
  assert.equal(isWatchActive(sub("a@b.co", "sub:1", { paused: true })), false);
  assert.equal(isWatchActive(null), false);
});

test("groupSubsByEmail: normalizes case and groups", () => {
  const map = groupSubsByEmail([
    sub("Ada@Example.com", "sub:1"),
    sub("ada@example.com", "sub:2"),
    sub("bob@example.com", "sub:3"),
  ]);
  assert.equal(map.size, 2);
  assert.equal(map.get("ada@example.com").length, 2);
  assert.equal(map.get("bob@example.com").length, 1);
});

test("shouldRollup: only when >1 active watch", () => {
  assert.equal(shouldRollup([sub("a@b.co", "sub:1")]), false);
  assert.equal(shouldRollup([sub("a@b.co", "sub:1"), sub("a@b.co", "sub:2")]), true);
  assert.equal(
    shouldRollup([
      sub("a@b.co", "sub:1"),
      sub("a@b.co", "sub:2", { paused: true }),
    ]),
    false,
  );
  assert.equal(
    shouldRollup([
      sub("a@b.co", "sub:1"),
      sub("a@b.co", "sub:2", { paused: true }),
      sub("a@b.co", "sub:3"),
    ]),
    true,
  );
});

test("buildDigestJobs: one rollup job per multi-watch email; single key otherwise", () => {
  const jobs = buildDigestJobs([
    sub("a@b.co", "sub:a1"),
    sub("a@b.co", "sub:a2"),
    sub("c@d.co", "sub:c1"),
    sub("e@f.co", "sub:e1", { paused: true }),
    sub("e@f.co", "sub:e2", { paused: true }),
  ]);
  assert.equal(jobs.length, 2);
  const rollup = jobs.find((j) => j.type === "rollup");
  const single = jobs.find((j) => j.type === "sub");
  assert.ok(rollup);
  assert.equal(rollup.email, "a@b.co");
  assert.deepEqual(rollup.keys.sort(), ["sub:a1", "sub:a2"]);
  assert.ok(single);
  assert.equal(single.key, "sub:c1");
});

test("sectionWantsSend + rollupSendDecision", () => {
  assert.equal(sectionWantsSend({ action: "none", new: 0 }), false);
  assert.equal(sectionWantsSend({ action: "match", new: 2 }), true);
  assert.equal(sectionWantsSend({ action: "heartbeat", new: 0 }), true);
  assert.equal(sectionWantsSend({ skipped: "weekly" }), false);

  const d = rollupSendDecision([
    { action: "none", new: 0, queryLabel: "quiet one" },
    { action: "match", new: 3, queryLabel: "construction" },
    { action: "heartbeat", new: 0, queryLabel: "education" },
  ]);
  assert.equal(d.wantSend, true);
  assert.equal(d.wantingCount, 2);
  assert.equal(d.totalNew, 3);
  assert.ok(d.labels.includes("construction"));
});

test("rollupSubject: multi-watch with matches", () => {
  assert.match(
    rollupSubject({ totalNew: 5, totalForecasts: 0, labels: ["a", "b"] }),
    /5 new — 2 watches/,
  );
  assert.match(
    rollupSubject({ totalNew: 0, totalForecasts: 0, labels: ["a", "b"], quiet: true }),
    /still watching — 2 watches/,
  );
});

test("rollupSubject: multi-watch account with only one wanting label still says N watches", () => {
  // Production incident shape: 4 active watches, only shelter matched → labels.length === 1.
  // Subject must not collapse to the single-watch form naming only that label.
  const subject = rollupSubject({
    totalNew: 1,
    totalForecasts: 0,
    labels: ["contract money — about “shelter” · awards only"],
    watchCount: 4,
  });
  assert.match(subject, /1 new — 4 watches/);
  assert.doesNotMatch(subject, /shelter/);
});

test("rollupBodySections: keeps quiet and weekly sections, drops errors", () => {
  const body = rollupBodySections([
    { queryLabel: "a", action: "match", new: 1 },
    { queryLabel: "b", action: "none", new: 0 },
    { queryLabel: "c", skipped: "weekly", new: 0 },
    { queryLabel: "d", error: "boom", new: 0 },
  ]);
  assert.equal(body.length, 3);
  assert.deepEqual(body.map((s) => s.queryLabel), ["a", "b", "c"]);
});

test("toRollupDayLogEntry: kind=rollup and sendUnits=1", () => {
  const e = toRollupDayLogEntry({
    sub: "account:ab***",
    emailRedacted: "ab***@ex.com",
    new: 4,
    noticeIds: ["1", "2"],
    sent: true,
    sections: [
      { sub: "sub:1", lens: "money", queryLabel: "x", new: 2, action: "match" },
      { sub: "sub:2", lens: "entity", queryLabel: "y", new: 2, action: "match" },
    ],
  }, { day: "2026-07-31" });
  assert.equal(e.kind, "rollup");
  assert.equal(e.sendUnits, 1);
  assert.equal(e.sent, true);
  assert.equal(e.sections.length, 2);
  assert.equal(e.noticeCount, 4);
});

test("buildDayLog includes rollup entries via toDayLogEntry fallback shape", () => {
  // Single-path daylog still uses toDayLogEntry; rollup uses toRollupDayLogEntry
  // then is pushed into the same entries array by the caller.
  const single = toDayLogEntry({
    sub: "sub:1",
    new: 1,
    noticeIds: ["n1"],
    sent: true,
    action: "match",
    emailRedacted: "a***@b.co",
  }, { day: "2026-07-31" });
  assert.equal(single.kind, "subscription");

  const rollup = toRollupDayLogEntry({
    sub: "account:a***",
    new: 2,
    noticeIds: ["n1", "n2"],
    sent: true,
    emailRedacted: "a***@b.co",
    sections: [],
  }, { day: "2026-07-31" });

  const log = buildDayLog({
    day: "2026-07-31",
    results: [],
  });
  log.entries = [single, rollup];
  assert.equal(log.entries.filter((x) => x.kind === "rollup").length, 1);
  assert.equal(log.entries.filter((x) => x.kind === "subscription").length, 1);
});

test("accountLogId redacts", () => {
  assert.equal(accountLogId("alice@example.com"), "account:al***");
  assert.match(accountLogId(""), /account:/);
});
