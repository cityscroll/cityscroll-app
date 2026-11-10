// Named verdict per watch check: closed vocabulary, day-log attachment, receipt tallies, fitness.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  VERDICT,
  SKIP_TABLE,
  classifySkip,
  verdictOf,
  subscriberLine,
  tally,
  deskCauseOf,
  normalizeVerdict,
  normalizeTally,
} from "../src/lib/watch_verdict.mjs";
import { toDayLogEntry } from "../src/lib/digest_ops.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALERTS_SRC = readFileSync(join(ROOT, "src/alerts.mjs"), "utf8");

const BAGS = [
  { id: "sent-match", bag: { sent: true, action: "match", new: 3 } },
  { id: "sent-heartbeat", bag: { sent: true, action: "heartbeat", new: 0 } },
  { id: "sent-weekly-empty", bag: { sent: true, action: "weekly-empty", new: 0 } },
  { id: "quiet-none", bag: { action: "none", new: 0, found: 4 } },
  { id: "weekly-not-due", bag: { skipped: "weekly", kind: "subscription" } },
  { id: "rollup-empty", bag: { skipped: "empty", kind: "rollup" } },
  { id: "capped", bag: { capped: true, action: "match", new: 2 } },
  { id: "dry-run", bag: { dryRun: true, action: "match", new: 2 } },
  { id: "shadow-hold", bag: { skipped: "shadow-hold" } },
  { id: "text-query-unavailable", bag: { skipped: "text-query-unavailable" } },
  { id: "text-query-incomplete", bag: { skipped: "text-query-incomplete" } },
  { id: "land-artifact-unavailable", bag: { skipped: "land-geography-artifact-unavailable" } },
  { id: "award-lookup-failed", bag: { skipped: "award-lookup-failed" } },
  { id: "unsupported-scope", bag: { skipped: "unsupported-scope" } },
  { id: "feature-gated", bag: { skipped: "feature-gated", kind: "council-matter" } },
  { id: "unknown-lens", bag: { skipped: "lens:zoning" } },
  { id: "malformed-award", bag: { skipped: "malformed-award-watch" } },
  { id: "suppressed-and-capped", bag: { capped: true, skipped: "recipient-suppressed" } },
  { id: "paused", bag: { skipped: "paused" } },
  { id: "all-paused", bag: { skipped: "all-paused", kind: "rollup" } },
  { id: "developer-test", bag: { skipped: "developer-test" } },
  { id: "gone", bag: { skipped: "gone" } },
  { id: "deleted", bag: { skipped: "deleted" } },
  { id: "error", bag: { error: "upstream 502", action: "match" } },
  { id: "bad-job", bag: { skipped: "bad-job" } },
  { id: "NEG-unknown-skip", bag: { skipped: "brand-new-reason" } },
  { id: "NEG-wanted-no-outcome", bag: { action: "match", new: 2 } },
  { id: "NEG-queue-placeholder", bag: { mode: "queue", enqueued: 40 } },
  { id: "NEG-error-beats-sent", bag: { error: "partial", sent: true, action: "match" } },
  { id: "NEG-empty-bag", bag: {} },
  { id: "none-no-matches", bag: { action: "none", new: 0, found: 0 } },
  { id: "none-zero-match-flag", bag: { action: "none", new: 0, zeroMatch: true } },
  { id: "none-found-unknown", bag: { action: "none", new: 0 } },
  { id: "none-already-seen", bag: { action: "none", new: 0, found: 7 } },
  { id: "catch-up-sent", bag: { sent: true, action: "catch_up", new: 5 } },
  { id: "NEG-sent-and-capped", bag: { sent: true, capped: true, action: "match", new: 2 } },
  { id: "NEG-sent-and-rehearsal", bag: { sent: true, dryRun: true, action: "match", new: 2 } },
];

const EXPECTED = {
  "sent-match": { class: "delivered", reason: "match", subscriber_line: "Delivered", desk_cause: "sent" },
  "sent-heartbeat": { class: "delivered", reason: "heartbeat", subscriber_line: "Delivered", desk_cause: "sent" },
  "sent-weekly-empty": { class: "delivered", reason: "weekly-empty", subscriber_line: "Delivered", desk_cause: "sent" },
  "quiet-none": { class: "idle", reason: "already-seen", subscriber_line: "Nothing new", desk_cause: "already_seen" },
  "weekly-not-due": { class: "idle", reason: "not-due", subscriber_line: "Not due yet", desk_cause: "skipped" },
  "rollup-empty": { class: "idle", reason: "empty-section", subscriber_line: "Nothing new", desk_cause: "skipped" },
  "capped": { class: "held", reason: "send-cap", subscriber_line: "Waiting", desk_cause: "capped" },
  "dry-run": { class: "held", reason: "rehearsal", subscriber_line: "Waiting", desk_cause: "dry_run" },
  "shadow-hold": { class: "held", reason: "safety-hold", subscriber_line: "Waiting", desk_cause: "skipped" },
  "text-query-unavailable": { class: "held", reason: "source-unavailable", subscriber_line: "Waiting", desk_cause: "skipped" },
  "text-query-incomplete": { class: "held", reason: "source-incomplete", subscriber_line: "Waiting", desk_cause: "skipped" },
  "land-artifact-unavailable": { class: "held", reason: "source-unavailable", subscriber_line: "Waiting", desk_cause: "skipped" },
  "award-lookup-failed": { class: "held", reason: "source-unavailable", subscriber_line: "Waiting", desk_cause: "skipped" },
  "unsupported-scope": { class: "blocked", reason: "unsupported-scope", subscriber_line: "Can't run yet", desk_cause: "skipped" },
  "feature-gated": { class: "blocked", reason: "not-live-yet", subscriber_line: "Can't run yet", desk_cause: "skipped" },
  "unknown-lens": { class: "blocked", reason: "unsupported-lens", subscriber_line: "Can't run yet", desk_cause: "skipped" },
  "malformed-award": { class: "blocked", reason: "malformed-watch", subscriber_line: "Can't run yet", desk_cause: "skipped" },
  "suppressed-and-capped": { class: "blocked", reason: "recipient-unreachable", subscriber_line: "Can't reach this address", desk_cause: "skipped" },
  "paused": { class: "off", reason: "paused", subscriber_line: "Paused", desk_cause: "skipped" },
  "all-paused": { class: "off", reason: "paused", subscriber_line: "Paused", desk_cause: "skipped" },
  "developer-test": { class: "off", reason: "test-account", subscriber_line: null, desk_cause: "skipped" },
  "gone": { class: "off", reason: "ended", subscriber_line: null, desk_cause: "unsub" },
  "deleted": { class: "off", reason: "ended", subscriber_line: null, desk_cause: "unsub" },
  "error": { class: "failed", reason: "error", subscriber_line: "Something went wrong", desk_cause: "error" },
  "bad-job": { class: "failed", reason: "bad-job", subscriber_line: "Something went wrong", desk_cause: "skipped" },
  "NEG-unknown-skip": { class: "failed", reason: "unclassified-skip", subscriber_line: "Something went wrong", desk_cause: "skipped" },
  "NEG-wanted-no-outcome": { class: "failed", reason: "send-wanted-no-outcome", subscriber_line: "Something went wrong", desk_cause: "other" },
  "NEG-queue-placeholder": null,
  "NEG-error-beats-sent": { class: "failed", reason: "error", subscriber_line: "Something went wrong", desk_cause: "error" },
  "NEG-empty-bag": { class: "failed", reason: "unclassified", subscriber_line: "Something went wrong", desk_cause: "other" },
  "none-no-matches": { class: "idle", reason: "no-matches", subscriber_line: "Nothing new", desk_cause: "quiet" },
  "none-zero-match-flag": { class: "idle", reason: "no-matches", subscriber_line: "Nothing new", desk_cause: "quiet" },
  "none-found-unknown": { class: "idle", reason: "nothing-new", subscriber_line: "Nothing new", desk_cause: "quiet" },
  "none-already-seen": { class: "idle", reason: "already-seen", subscriber_line: "Nothing new", desk_cause: "already_seen" },
  "catch-up-sent": { class: "delivered", reason: "catch_up", subscriber_line: "Delivered", desk_cause: "sent" },
  "NEG-sent-and-capped": { class: "held", reason: "send-cap", subscriber_line: "Waiting", desk_cause: "capped" },
  "NEG-sent-and-rehearsal": { class: "held", reason: "rehearsal", subscriber_line: "Waiting", desk_cause: "dry_run" },
};

const EXPECTED_TALLY = { off: 5, blocked: 5, held: 9, idle: 7, delivered: 4, failed: 6 };

/** Historical receipts/day-log entries may still carry the prior idle class name. */
const STORED_V1 = {
  verdicts: [
    {
      stored: { class: "quiet", reason: "nothing-new" },
      read_as: { class: "idle", reason: "nothing-new" },
      desk_cause: "quiet",
    },
    {
      stored: { class: "quiet", reason: "not-due" },
      read_as: { class: "idle", reason: "not-due" },
      desk_cause: "skipped",
    },
    {
      stored: { class: "held", reason: "send-cap" },
      read_as: { class: "held", reason: "send-cap" },
      desk_cause: "capped",
    },
  ],
  tally: {
    stored: { off: 1, blocked: 0, held: 2, quiet: 3, delivered: 4, failed: 0 },
    read_as: { off: 1, blocked: 0, held: 2, idle: 3, delivered: 4, failed: 0 },
  },
  mixed_tally: {
    stored: { off: 0, blocked: 0, held: 0, quiet: 2, idle: 5, delivered: 1, failed: 0 },
    read_as: { off: 0, blocked: 0, held: 0, idle: 7, delivered: 1, failed: 0 },
  },
};

/** Same total used by summarizeDigestRun. */
function inlineReceiptVerdicts(results) {
  return tally(results.map((r) => verdictOf(r)));
}

/** Same per-job accumulation used by recordQueueJobOutcome (normalize stored tallies first). */
function queueReceiptVerdicts(results) {
  const out = normalizeTally({});
  for (const r of results) {
    const v = verdictOf(r);
    if (v) out[v.class] += 1;
  }
  return out;
}

test("verdict vocabulary: idle replaces quiet as a written class", () => {
  assert.equal(VERDICT.IDLE, "idle");
  assert.equal(Object.hasOwn(VERDICT, "QUIET"), false);
  assert.ok(!Object.values(VERDICT).includes("quiet"));
});

for (const { id, bag } of BAGS) {
  test(`verdictOf: ${id}`, () => {
    const want = EXPECTED[id];
    const got = verdictOf(bag);
    if (want === null) {
      assert.equal(got, null);
      return;
    }
    assert.deepEqual(
      {
        class: got.class,
        reason: got.reason,
        subscriber_line: subscriberLine(got),
        desk_cause: deskCauseOf(got),
      },
      want,
    );
  });
}

test("tally: count by class with no other bucket", () => {
  assert.deepEqual(tally(BAGS.map((b) => verdictOf(b.bag))), EXPECTED_TALLY);
  const sum = Object.values(EXPECTED_TALLY).reduce((a, b) => a + b, 0);
  // Queue placeholder contributes no verdict; 36 of 37 bags tally.
  assert.equal(sum, BAGS.length - 1);
  assert.equal(Object.hasOwn(EXPECTED_TALLY, "quiet"), false);
});

test("toDayLogEntry: attaches verdict beside action; preserves existing fields", () => {
  const result = {
    sub: "sub:36abcdef01234567",
    lens: "money",
    queryLabel: "contract money",
    email: "owner@example.com",
    found: 0,
    new: 0,
    noticeIds: [],
    action: "none",
    zeroMatch: true,
    sent: false,
  };
  const entry = toDayLogEntry(result, { day: "2026-07-30" });
  assert.equal(entry.day, "2026-07-30");
  assert.equal(entry.id, "sub:36abcdef01234567");
  assert.equal(entry.email, "owner@example.com");
  assert.equal(entry.action, "none");
  assert.equal(entry.zeroMatch, true);
  assert.equal(entry.sent, false);
  assert.deepEqual(entry.verdict, { class: VERDICT.IDLE, reason: "no-matches" });
});

test("toDayLogEntry: skipped reason carries named verdict; queue placeholder stays null", () => {
  const skipped = toDayLogEntry({ sub: "sub:a", skipped: "weekly", sent: false }, { day: "2026-07-30" });
  assert.equal(skipped.action, "skipped:weekly");
  assert.deepEqual(skipped.verdict, { class: VERDICT.IDLE, reason: "not-due" });
  assert.equal(toDayLogEntry({ mode: "queue", enqueued: 4 }), null);
});

test("toDayLogEntry: absence of verdict on a prior-shaped entry is unknown, never idle", () => {
  // Entries written before the named-verdict field have no verdict. Readers must not
  // treat missing as idle.
  const prior = {
    day: "2026-07-29",
    kind: "subscription",
    id: "sub:old",
    action: "none",
    sent: false,
  };
  assert.equal(Object.hasOwn(prior, "verdict"), false);
  assert.notEqual(prior.verdict?.class, VERDICT.IDLE);
});

test("receipt verdicts: inline and queue accumulation agree; counts sum to per-watch results", () => {
  const results = BAGS.map((b) => b.bag);
  const inline = inlineReceiptVerdicts(results);
  const queued = queueReceiptVerdicts(results);
  assert.deepEqual(inline, EXPECTED_TALLY);
  assert.deepEqual(queued, inline);
  const sum = Object.values(inline).reduce((a, b) => a + b, 0);
  const perWatch = results.filter((r) => r && r.mode !== "queue").length;
  assert.equal(sum, perWatch);
});

test("alerts.mjs wires verdicts on summarizeDigestRun and recordQueueJobOutcome", () => {
  assert.match(ALERTS_SRC, /from\s+["']\.\/lib\/watch_verdict\.mjs["']/);
  assert.match(ALERTS_SRC, /normalizeTally/);
  assert.match(
    ALERTS_SRC,
    /function summarizeDigestRun[\s\S]*?verdicts:\s*tally\(results\.map\(\(r\)\s*=>\s*verdictOf\(r\)\)\)/,
  );
  assert.match(
    ALERTS_SRC,
    /async function recordQueueJobOutcome[\s\S]*?normalizeTally\(base\.verdicts\)[\s\S]*?const verdict = verdictOf\(jobResult\);[\s\S]*?base\.verdicts = verdicts;/,
  );
});

/** Collect free-text skipped: literals from the digest runner source. */
function skippedLiteralsInAlerts() {
  const reasons = new Set();
  for (const m of ALERTS_SRC.matchAll(/skipped:\s*"([^"]+)"/g)) reasons.add(m[1]);
  for (const m of ALERTS_SRC.matchAll(/skipped:\s*`([^`$]+)/g)) {
    const raw = m[1];
    reasons.add(raw.startsWith("lens:") ? "lens:" : raw);
  }
  return [...reasons].sort();
}

test("fitness: every skipped: literal in alerts.mjs has a verdict", () => {
  const reasons = skippedLiteralsInAlerts();
  assert.ok(reasons.length >= 18, `expected at least 18 skip literals, got ${reasons.length}`);
  for (const reason of reasons) {
    const sample = reason === "lens:" ? "lens:any" : reason;
    const v = classifySkip(sample);
    assert.notDeepEqual(
      v,
      { class: VERDICT.FAILED, reason: "unclassified-skip" },
      `skipped:${reason} has no table row`,
    );
  }
  // Table covers every literal key (lens: is the prefix family).
  for (const reason of reasons) {
    if (reason === "lens:") continue;
    assert.ok(Object.hasOwn(SKIP_TABLE, reason), `SKIP_TABLE missing ${reason}`);
  }
});

test("fitness: a brand-new skipped literal without a table row is unclassified-skip", () => {
  assert.deepEqual(classifySkip("brand-new-reason"), {
    class: VERDICT.FAILED,
    reason: "unclassified-skip",
  });
});

test("stored under prior class name: read as idle, never rewritten", () => {
  for (const c of STORED_V1.verdicts) {
    const before = structuredClone(c.stored);
    assert.deepEqual(normalizeVerdict(c.stored), c.read_as);
    assert.equal(deskCauseOf(c.stored), c.desk_cause);
    assert.equal(subscriberLine(normalizeVerdict(c.stored)), subscriberLine(c.read_as));
    assert.deepEqual(c.stored, before, "the stored value is not mutated");
  }
  assert.deepEqual(normalizeTally(STORED_V1.tally.stored), STORED_V1.tally.read_as);
  assert.deepEqual(normalizeTally(STORED_V1.mixed_tally.stored), STORED_V1.mixed_tally.read_as);
  assert.equal(normalizeVerdict(null), null);
});
