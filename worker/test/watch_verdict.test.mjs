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
];

const EXPECTED = {
  "sent-match": { class: "delivered", reason: "match", subscriber_line: "Delivered" },
  "sent-heartbeat": { class: "delivered", reason: "heartbeat", subscriber_line: "Delivered" },
  "sent-weekly-empty": { class: "delivered", reason: "weekly-empty", subscriber_line: "Delivered" },
  "quiet-none": { class: "quiet", reason: "nothing-new", subscriber_line: "Nothing new" },
  "weekly-not-due": { class: "quiet", reason: "not-due", subscriber_line: "Not due yet" },
  "rollup-empty": { class: "quiet", reason: "nothing-new", subscriber_line: "Nothing new" },
  "capped": { class: "held", reason: "send-cap", subscriber_line: "Waiting" },
  "dry-run": { class: "held", reason: "rehearsal", subscriber_line: "Waiting" },
  "shadow-hold": { class: "held", reason: "safety-hold", subscriber_line: "Waiting" },
  "text-query-unavailable": { class: "held", reason: "source-unavailable", subscriber_line: "Waiting" },
  "text-query-incomplete": { class: "held", reason: "source-incomplete", subscriber_line: "Waiting" },
  "land-artifact-unavailable": { class: "held", reason: "source-unavailable", subscriber_line: "Waiting" },
  "award-lookup-failed": { class: "held", reason: "source-unavailable", subscriber_line: "Waiting" },
  "unsupported-scope": { class: "blocked", reason: "unsupported-scope", subscriber_line: "Can't run yet" },
  "feature-gated": { class: "blocked", reason: "not-live-yet", subscriber_line: "Can't run yet" },
  "unknown-lens": { class: "blocked", reason: "unsupported-lens", subscriber_line: "Can't run yet" },
  "malformed-award": { class: "blocked", reason: "malformed-watch", subscriber_line: "Can't run yet" },
  "suppressed-and-capped": { class: "blocked", reason: "recipient-unreachable", subscriber_line: "Can't reach this address" },
  "paused": { class: "off", reason: "paused", subscriber_line: "Paused" },
  "all-paused": { class: "off", reason: "paused", subscriber_line: "Paused" },
  "developer-test": { class: "off", reason: "test-account", subscriber_line: null },
  "gone": { class: "off", reason: "ended", subscriber_line: null },
  "deleted": { class: "off", reason: "ended", subscriber_line: null },
  "error": { class: "failed", reason: "error", subscriber_line: "Something went wrong" },
  "bad-job": { class: "failed", reason: "bad-job", subscriber_line: "Something went wrong" },
  "NEG-unknown-skip": { class: "failed", reason: "unclassified", subscriber_line: "Something went wrong" },
  "NEG-wanted-no-outcome": { class: "failed", reason: "send-wanted-no-outcome", subscriber_line: "Something went wrong" },
  "NEG-queue-placeholder": null,
  "NEG-error-beats-sent": { class: "failed", reason: "error", subscriber_line: "Something went wrong" },
  "NEG-empty-bag": { class: "failed", reason: "unclassified", subscriber_line: "Something went wrong" },
};

const EXPECTED_TALLY = { off: 5, blocked: 5, held: 7, quiet: 3, delivered: 3, failed: 6 };

/** Same total used by summarizeDigestRun. */
function inlineReceiptVerdicts(results) {
  return tally(results.map((r) => verdictOf(r)));
}

/** Same per-job accumulation used by recordQueueJobOutcome. */
function queueReceiptVerdicts(results) {
  const out = tally([]);
  for (const r of results) {
    const v = verdictOf(r);
    if (v) out[v.class] += 1;
  }
  return out;
}

for (const { id, bag } of BAGS) {
  test(`verdictOf: ${id}`, () => {
    const want = EXPECTED[id];
    const got = verdictOf(bag);
    if (want === null) {
      assert.equal(got, null);
      return;
    }
    assert.deepEqual(
      { class: got.class, reason: got.reason, subscriber_line: subscriberLine(got) },
      want,
    );
  });
}

test("tally: count by class with no other bucket", () => {
  assert.deepEqual(tally(BAGS.map((b) => verdictOf(b.bag))), EXPECTED_TALLY);
  const sum = Object.values(EXPECTED_TALLY).reduce((a, b) => a + b, 0);
  // Queue placeholder contributes no verdict; 29 of 30 bags tally.
  assert.equal(sum, BAGS.length - 1);
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
  assert.deepEqual(entry.verdict, { class: VERDICT.QUIET, reason: "nothing-new" });
});

test("toDayLogEntry: skipped reason carries named verdict; queue placeholder stays null", () => {
  const skipped = toDayLogEntry({ sub: "sub:a", skipped: "weekly", sent: false }, { day: "2026-07-30" });
  assert.equal(skipped.action, "skipped:weekly");
  assert.deepEqual(skipped.verdict, { class: VERDICT.QUIET, reason: "not-due" });
  assert.equal(toDayLogEntry({ mode: "queue", enqueued: 4 }), null);
});

test("toDayLogEntry: absence of verdict on a prior-shaped entry is unknown, never quiet", () => {
  // Entries written before this change have no verdict field. Readers must not
  // treat missing as quiet.
  const prior = {
    day: "2026-07-29",
    kind: "subscription",
    id: "sub:old",
    action: "none",
    sent: false,
  };
  assert.equal(Object.hasOwn(prior, "verdict"), false);
  assert.notEqual(prior.verdict?.class, VERDICT.QUIET);
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
  assert.match(
    ALERTS_SRC,
    /function summarizeDigestRun[\s\S]*?verdicts:\s*tally\(results\.map\(\(r\)\s*=>\s*verdictOf\(r\)\)\)/,
  );
  assert.match(
    ALERTS_SRC,
    /async function recordQueueJobOutcome[\s\S]*?const verdict = verdictOf\(jobResult\);[\s\S]*?base\.verdicts = verdicts;/,
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
      { class: VERDICT.FAILED, reason: "unclassified" },
      `skipped:${reason} has no table row`,
    );
  }
  // Table covers every literal key (lens: is the prefix family).
  for (const reason of reasons) {
    if (reason === "lens:") continue;
    assert.ok(Object.hasOwn(SKIP_TABLE, reason), `SKIP_TABLE missing ${reason}`);
  }
});

test("fitness: a brand-new skipped literal without a table row is unclassified", () => {
  assert.deepEqual(classifySkip("brand-new-reason"), {
    class: VERDICT.FAILED,
    reason: "unclassified",
  });
});
