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
import { runDigestShadowJob } from "../tools/digest_shadow_monitor.mjs";
import { persistScheduleResult, replayOutbox } from "../tools/external_schedule_outbox.mjs";
import { withTempDir } from "../tools/lib/with_temp_dir.mjs";
import { withPinnedClock } from "./helpers/test_clock.mjs";
import {
  DIGEST_SHADOW_MONITOR_EVIDENCE_RELPATH,
  DIGEST_SHADOW_MONITOR_OBSERVATION_SCHEMA,
  DIGEST_SHADOW_MONITOR_TOOL,
  UNCHANGED_OBSERVATION,
  appendDigestShadowMonitorObservation,
  assertDigestShadowMonitorDocument,
  digestShadowMonitorProvenance,
  digestShadowObservationFingerprint,
  findingSeverity,
  observationFromCycle,
} from "../tools/digest_shadow_monitor_observation.mjs";
import { PRODUCTION_PROVENANCE_SCHEMA } from "../tools/lib/production_provenance.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_DIR = join(ROOT, "test/fixtures/digest-shadow-monitor");
const RETAINED = JSON.parse(await readFile(join(FIXTURE_DIR, "retained-cycles.json"), "utf8"));
const LETTER_RECEIPTS = JSON.parse(await readFile(join(FIXTURE_DIR, "letter-receipts.json"), "utf8"));
const SYNTHETIC = JSON.parse(await readFile(join(FIXTURE_DIR, "synthetic-trailing-series.json"), "utf8"));
const EVIDENCE = JSON.parse(await readFile(join(ROOT, DIGEST_SHADOW_MONITOR_EVIDENCE_RELPATH), "utf8"));

function spikeHistory() {
  return SYNTHETIC.history.map((row) => ({ ...row }));
}

function backlogFlushHistory() {
  return LETTER_RECEIPTS.quiet_watermark.backlog_flush_history.map((row) => structuredClone(row));
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
    history: items > 0 ? ordinaryHistory() : backlogFlushHistory(),
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

function summaryFromLetter(letter, { history, now } = {}) {
  const funnel = normalizeFunnel(letter.selection_funnel);
  const items = Number(funnel.items) || 0;
  return buildDigestShadowSummary({
    run: {
      results: [{
        sub: "account:letter",
        new: items,
        forecasts: 0,
        preview: items > 0
          ? { subject: `CityScroll: ${items} new`, html: itemHtml(items), listUnsubscribe: "<https://api.cityscroll.org/unsubscribe?example=1>" }
          : undefined,
        selection_funnel: funnel,
      }],
    },
    history: history || [],
    now: now || new Date(`${letter.run_day}T10:00:00.000Z`),
  });
}

function fakeGithub() {
  const issues = [];
  const comments = new Map();
  return {
    issues,
    async listIssues() { return issues.filter((issue) => issue.state === "open"); },
    async listComments(number) { return comments.get(number) || []; },
    async createIssue(issue) {
      const created = { number: issues.length + 1, state: "open", ...issue };
      issues.push(created);
      return created;
    },
    async createComment(number, body) {
      const list = comments.get(number) || [];
      list.push({ body });
      comments.set(number, list);
    },
    async updateIssue(number, patch) {
      Object.assign(issues.find((issue) => issue.number === number), patch);
    },
  };
}

const DIGEST_SHADOW_JOB = {
  id: "digest-shadow-monitor",
  runner: "digest-shadow",
  issue_title: "Digest shadow run needs attention",
};

async function withDigestShadowEnv(env, run) {
  const keys = ["CITYSCROLL_ADMIN_KEY", "ADMIN_KEY", "CITYSCROLL_ADMIN_KEY_FILE", "CITYSCROLL_DIGEST_SHADOW_URL"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, env);
  try { return await run(); } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("A1 named assertion: letter-receipts distinguish quiet watermark info from empty-source attention", async () => {
  await withPinnedClock("2026-09-10T12:00:00.000Z", async () => {
    const quiet = summaryFromLetter(LETTER_RECEIPTS.quiet_watermark, {
      history: LETTER_RECEIPTS.quiet_watermark.backlog_flush_history,
    });
    assert.equal(quiet.status, DIGEST_SHADOW_READY);
    assert.equal(quiet.collapse_stage, "watermark_fresh");
    assert.ok(quiet.selection_funnel.source_candidates > QUIET_WATERMARK_CANDIDATE_FLOOR);
    assert.equal(quiet.selection_funnel.watermark_fresh, 0);
    assert.equal(quiet.total_items, 0);
    assert.deepEqual(quiet.redlines.map((row) => row.code), []);
    const quietObservation = quiet.observations.find((row) => row.code === "quiet_watermark");
    assert.ok(quietObservation);
    assert.equal(quietObservation.severity, "info");
    assert.equal(
      findingSeverity({ healthy: true, summary: quiet, opening: false }),
      "info",
    );

    const empty = summaryFromLetter(LETTER_RECEIPTS.empty_source, {
      history: LETTER_RECEIPTS.empty_source.history,
    });
    assert.equal(empty.status, DIGEST_SHADOW_ATTENTION);
    assert.equal(empty.collapse_stage, "source_candidates");
    assert.equal(empty.selection_funnel.source_candidates, 0);
    assert.equal(empty.total_items, 0);
    assert.ok(empty.redlines.some((row) => row.code === "aggregate_count_collapse"));
    assert.equal(empty.observations.find((row) => row.code === "quiet_watermark"), undefined);
    assert.equal(
      findingSeverity({ healthy: false, summary: empty, opening: true }),
      "attention",
    );

    // Same zero item count; only the funnel stage separates the two cases.
    assert.equal(quiet.total_items, empty.total_items);
    assert.notEqual(quiet.collapse_stage, empty.collapse_stage);

    await withTempDir("crol-digest-shadow-a1", async (stateDir) => {
      const github = fakeGithub();
      const quietReceipt = {
        summary: {
          status: DIGEST_SHADOW_READY,
          run_day: LETTER_RECEIPTS.quiet_watermark.run_day,
          ran_at: LETTER_RECEIPTS.quiet_watermark.ran_at,
          ok: true,
          collapse_stage: "watermark_fresh",
          selection_funnel: { ...LETTER_RECEIPTS.quiet_watermark.selection_funnel },
          redlines: [],
          observations: [{
            code: "quiet_watermark",
            severity: "info",
            stage: "watermark_fresh",
            classification: "watermark exhaustion after backlog flush",
            reason: "watermark exhaustion after backlog flush",
          }],
          upstream_incidents: [],
        },
      };
      const quietOutput = await withDigestShadowEnv({
        CITYSCROLL_ADMIN_KEY: "probe-secret",
        CITYSCROLL_DIGEST_SHADOW_URL: "https://example.invalid/admin/digest-shadow",
      }, async () => {
        const now = new Date("2026-09-10T10:10:00.000Z");
        const ran = await runDigestShadowJob(DIGEST_SHADOW_JOB, {
          stateDir,
          now,
          runKey: now.toISOString().slice(0, 16).replace(/:/g, "-"),
          async fetchImpl() {
            return { ok: true, status: 200, async json() { return quietReceipt; } };
          },
        });
        await persistScheduleResult({
          stateDir,
          jobId: DIGEST_SHADOW_JOB.id,
          runKey: now.toISOString().slice(0, 16).replace(/:/g, "-"),
          now,
          result: ran.result,
          issue: ran.intents[0].issue,
        });
        return ran;
      });
      await replayOutbox({ stateDir, github, now: "2026-09-10T10:10:00.000Z" });
      assert.equal(quietOutput.result.finding_severity, "info");
      assert.equal(quietOutput.result.comment_written, false);
      assert.equal(quietOutput.intents[0].issue.mode, "close");
      assert.equal(github.issues.length, 0);

      const emptyGithub = fakeGithub();
      const emptyReceipt = {
        summary: {
          status: DIGEST_SHADOW_ATTENTION,
          run_day: LETTER_RECEIPTS.empty_source.run_day,
          ran_at: LETTER_RECEIPTS.empty_source.ran_at,
          ok: false,
          collapse_stage: "source_candidates",
          selection_funnel: { ...LETTER_RECEIPTS.empty_source.selection_funnel },
          redlines: [{
            code: "aggregate_count_collapse",
            digest_id: "run",
            watch_id: null,
            reason: "Aggregate digest items collapsed against the trailing average.",
            evidence: { collapse_stage: "source_candidates" },
          }],
          observations: [],
          upstream_incidents: [],
        },
      };
      const emptyOutput = await withDigestShadowEnv({
        CITYSCROLL_ADMIN_KEY: "probe-secret",
        CITYSCROLL_DIGEST_SHADOW_URL: "https://example.invalid/admin/digest-shadow",
      }, async () => {
        const now = new Date("2026-09-10T13:10:00.000Z");
        const ran = await runDigestShadowJob(DIGEST_SHADOW_JOB, {
          stateDir,
          now,
          runKey: now.toISOString().slice(0, 16).replace(/:/g, "-"),
          async fetchImpl() {
            return { ok: false, status: 503, async json() { return emptyReceipt; } };
          },
        });
        await persistScheduleResult({
          stateDir,
          jobId: DIGEST_SHADOW_JOB.id,
          runKey: now.toISOString().slice(0, 16).replace(/:/g, "-"),
          now,
          result: ran.result,
          issue: ran.intents[0].issue,
        });
        return ran;
      });
      await replayOutbox({ stateDir, github: emptyGithub, now: "2026-09-10T13:10:00.000Z" });
      assert.equal(emptyOutput.result.finding_severity, "attention");
      assert.equal(emptyOutput.result.comment_written, true);
      assert.equal(emptyOutput.intents[0].issue.mode, "open");
      assert.equal(emptyGithub.issues.length, 1);
    });
  });
});

test("A3 named assertion: retained cycles and synthetic trailing series raise no weekday collapse", async () => {
  await withPinnedClock("2026-09-14T12:00:00.000Z", () => {
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

    const synthetic = summaryFromLetter(SYNTHETIC, {
      history: SYNTHETIC.history,
      now: new Date(SYNTHETIC.ran_at),
    });
    assert.equal(synthetic.status, DIGEST_SHADOW_READY);
    assert.equal(synthetic.collapse_stage, SYNTHETIC.expectations.collapse_stage);
    assert.equal(synthetic.total_items, SYNTHETIC.current_items);
    assert.equal(synthetic.redlines.find((row) => row.code === "aggregate_count_collapse"), undefined);

    const trailingMean = SYNTHETIC.history
      .slice(0, 7)
      .reduce((sum, row) => sum + Number(row.totalNotices), 0) / 7;
    assert.ok(SYNTHETIC.expectations.mean_would_collapse);
    assert.ok((SYNTHETIC.current_items / trailingMean) < 0.25);
  });
});

test("the committed quiet-watermark evidence names each retained cycle", async () => {
  await withPinnedClock("2026-09-14T12:00:00.000Z", () => {
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
});

test("the committed quiet-watermark evidence carries production provenance", () => {
  const document = assertDigestShadowMonitorDocument(EVIDENCE);
  assert.equal(document.provenance.schema, PRODUCTION_PROVENANCE_SCHEMA);
  assert.equal(document.provenance.isolated, false);
  assert.equal(document.provenance.observer.tool, DIGEST_SHADOW_MONITOR_TOOL);
  assert.ok(document.provenance.observer.source_revision);
  assert.deepEqual(document.provenance.methods, ["GET"]);
  assert.ok(document.provenance.bases.includes("https://api.cityscroll.org"));
});

test("appending a later cycle keeps production provenance", async () => {
  await withTempDir("digest-shadow-provenance", async (dir) => {
    const path = join(dir, "quiet-watermark-cycles-2026-09-14.json");
    const provenance = digestShadowMonitorProvenance({
      observed_at: "2026-09-11T20:47:50.607Z",
      source_revision: "233a42d95a73c0d10b49ce5e96d59f6ebf386b65",
    });
    await appendDigestShadowMonitorObservation(path, EVIDENCE.observations[0], {
      now: "2026-09-10T10:10:00.000Z",
      provenance,
    });
    const written = await appendDigestShadowMonitorObservation(path, EVIDENCE.observations.at(-1), {
      now: "2026-09-11T20:47:50.607Z",
    });
    assert.equal(written.observations.length, 2);
    assert.deepEqual(written.provenance, provenance);
  });
});
