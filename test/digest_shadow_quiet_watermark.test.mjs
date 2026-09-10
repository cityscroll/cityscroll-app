import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  DIGEST_SHADOW_ATTENTION,
  DIGEST_SHADOW_READY,
  QUIET_WATERMARK_CANDIDATE_FLOOR,
  buildDigestShadowSummary,
} from "../worker/src/digest_shadow.mjs";
import { normalizeFunnel } from "../worker/src/lib/digest_funnel.mjs";
import {
  DIGEST_SHADOW_MONITOR_EVIDENCE_RELPATH,
  DIGEST_SHADOW_MONITOR_OBSERVATION_SCHEMA,
  UNCHANGED_OBSERVATION,
  digestShadowObservationFingerprint,
  findingSeverity,
  observationFromCycle,
} from "../tools/digest_shadow_monitor_observation.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RETAINED = JSON.parse(await readFile(join(ROOT, "test/fixtures/digest-shadow-monitor/retained-cycles.json"), "utf8"));
const EVIDENCE = JSON.parse(await readFile(join(ROOT, DIGEST_SHADOW_MONITOR_EVIDENCE_RELPATH), "utf8"));

function spikeHistory() {
  return [
    { day: "2026-09-07", totalNotices: 234, sentCount: 5 },
    { day: "2026-09-06", totalNotices: 8, sentCount: 2 },
    { day: "2026-09-05", totalNotices: 12, sentCount: 2 },
    { day: "2026-09-04", totalNotices: 10, sentCount: 2 },
    { day: "2026-09-03", totalNotices: 9, sentCount: 1 },
    { day: "2026-09-02", totalNotices: 11, sentCount: 2 },
    { day: "2026-09-01", totalNotices: 8, sentCount: 1 },
  ];
}

function ordinaryHistory() {
  return Array.from({ length: 7 }, (_, index) => ({
    day: `2026-08-${String(31 - index).padStart(2, "0")}`,
    totalNotices: 48,
    sentCount: 3,
  }));
}

function itemHtml(count) {
  const items = Array.from({ length: count }, () => '<li data-digest-item="1">item</li>').join("");
  return `<ul>${items}</ul><a href="https://cityscroll.org/#notice/1">View</a><a href="https://api.cityscroll.org/unsubscribe?example=1">Unsubscribe</a>`;
}

function replayCycle(cycle) {
  const summary = cycle.summary || {};
  const funnel = summary.selection_funnel;
  if (!funnel) {
    return {
      status: "degraded",
      summary: {},
      finding_severity: "attention",
      degraded_reason: cycle.degraded_reason || "rehearsal-not-ready",
    };
  }
  const items = Number(summary.total_items) || 0;
  const out = buildDigestShadowSummary({
    run: {
      results: [{
        sub: "account:replay",
        new: items,
        forecasts: 0,
        preview: items > 0
          ? { subject: `CityScroll: ${items} new`, html: itemHtml(items), listUnsubscribe: "<https://api.cityscroll.org/unsubscribe?example=1>" }
          : undefined,
        selection_funnel: normalizeFunnel(funnel),
      }],
    },
    history: items > 0 ? ordinaryHistory() : spikeHistory(),
    now: new Date(`${summary.run_day}T10:00:00.000Z`),
  });
  const healthy = out.status === DIGEST_SHADOW_READY;
  return {
    status: healthy ? "healthy" : "degraded",
    summary: out,
    finding_severity: findingSeverity({ healthy, summary: out, opening: !healthy }),
  };
}

function seedObservations(cycles) {
  const observations = [];
  let previous = null;
  for (const cycle of cycles) {
    const replayed = replayCycle(cycle);
    const fingerprint = digestShadowObservationFingerprint(replayed.summary, {
      degraded_reason: replayed.degraded_reason,
    });
    const opening = replayed.status === "degraded";
    const unchanged = previous === fingerprint;
    const commentWritten = opening && !unchanged;
    observations.push(observationFromCycle({
      runKey: cycle.run_key,
      result: {
        observed_at: cycle.observed_at,
        status: replayed.status,
        summary: replayed.summary,
        finding_severity: replayed.finding_severity,
      },
      commentWritten,
      commentSuppressed: opening && unchanged ? UNCHANGED_OBSERVATION : null,
    }));
    previous = fingerprint;
  }
  return observations;
}

test("replaying retained 2026-09-06..10 receipts raises no attention on quiet watermark days", () => {
  const watermarkDays = new Set(["2026-09-08", "2026-09-09", "2026-09-10"]);
  for (const cycle of RETAINED.cycles) {
    const replayed = replayCycle(cycle);
    const runDay = cycle.summary?.run_day;
    if (watermarkDays.has(runDay)) {
      assert.equal(replayed.summary.status, DIGEST_SHADOW_READY, cycle.run_key);
      assert.equal(replayed.summary.collapse_stage, "watermark_fresh", cycle.run_key);
      assert.ok(replayed.summary.selection_funnel.source_candidates > QUIET_WATERMARK_CANDIDATE_FLOOR, cycle.run_key);
      assert.deepEqual(replayed.summary.redlines.map((row) => row.code), [], cycle.run_key);
      assert.equal(replayed.finding_severity, "info", cycle.run_key);
    }
    if (runDay === "2026-09-07") {
      assert.equal(replayed.summary.status, DIGEST_SHADOW_ATTENTION, cycle.run_key);
      assert.ok(replayed.summary.redlines.some((row) => row.code === "aggregate_count_explosion"), cycle.run_key);
    }
    if (!runDay) {
      assert.equal(replayed.finding_severity, "attention", cycle.run_key);
    }
  }
});

test("the committed quiet-watermark evidence names each retained cycle", () => {
  assert.equal(EVIDENCE.schema, DIGEST_SHADOW_MONITOR_OBSERVATION_SCHEMA);
  const expected = seedObservations(RETAINED.cycles);
  assert.deepEqual(EVIDENCE.observations.map((row) => row.run_key), expected.map((row) => row.run_key));
  for (const [index, row] of EVIDENCE.observations.entries()) {
    const want = expected[index];
    assert.equal(row.collapse_stage, want.collapse_stage, row.run_key);
    assert.equal(row.source_candidates, want.source_candidates, row.run_key);
    assert.equal(row.finding_severity, want.finding_severity, row.run_key);
    assert.equal(row.comment_written, want.comment_written, row.run_key);
    assert.equal(row.comment_suppressed, want.comment_suppressed, row.run_key);
  }
  const quiet = EVIDENCE.observations.filter((row) => row.run_day === "2026-09-08" || row.run_day === "2026-09-09" || row.run_day === "2026-09-10");
  assert.ok(quiet.length >= 5);
  assert.ok(quiet.every((row) => row.finding_severity === "info" && row.comment_written === false && row.collapse_stage === "watermark_fresh"));
});
