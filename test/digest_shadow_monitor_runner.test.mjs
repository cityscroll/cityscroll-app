import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { persistScheduleResult, replayOutbox } from "../tools/external_schedule_outbox.mjs";
import { runDigestShadowJob } from "../tools/digest_shadow_monitor.mjs";
import {
  DIGEST_SHADOW_MONITOR_OBSERVATION_SCHEMA,
  UNCHANGED_OBSERVATION,
} from "../tools/digest_shadow_monitor_observation.mjs";
import { withTempDir } from "../tools/lib/with_temp_dir.mjs";
import { withPinnedClock } from "./helpers/test_clock.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LETTER_RECEIPTS = JSON.parse(
  await readFile(join(ROOT, "test/fixtures/digest-shadow-monitor/letter-receipts.json"), "utf8"),
);

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

function runKey(now) {
  return now.toISOString().slice(0, 16).replace(/:/g, "-");
}

async function persistJobOutput(stateDir, now, output) {
  const key = runKey(now);
  if (output.intents) {
    for (const [index, intent] of output.intents.entries()) {
      await persistScheduleResult({
        stateDir,
        jobId: DIGEST_SHADOW_JOB.id,
        runKey: key,
        eventRunKey: `${key}-source-${index}`,
        now,
        result: intent.result,
        issue: intent.issue,
      });
    }
  } else {
    await persistScheduleResult({
      stateDir,
      jobId: DIGEST_SHADOW_JOB.id,
      runKey: key,
      now,
      result: output.result,
      issue: output.issue,
    });
  }
}

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

function emptySourceReceipt(runDay = LETTER_RECEIPTS.unchanged_attention.run_day, ranAt = LETTER_RECEIPTS.unchanged_attention.ran_at) {
  const fixture = LETTER_RECEIPTS.unchanged_attention;
  return {
    summary: {
      status: fixture.status,
      run_day: runDay,
      ran_at: ranAt,
      ok: false,
      collapse_stage: fixture.collapse_stage,
      selection_funnel: { ...fixture.selection_funnel },
      redlines: structuredClone(fixture.redlines),
      observations: [],
      upstream_incidents: [],
    },
  };
}

function quietWatermarkReceipt(runDay = LETTER_RECEIPTS.quiet_watermark.run_day, candidates = LETTER_RECEIPTS.quiet_watermark.candidates) {
  return {
    summary: {
      status: "READY",
      run_day: runDay,
      ran_at: `${runDay}T10:00:31.209Z`,
      ok: true,
      collapse_stage: "watermark_fresh",
      selection_funnel: {
        source_candidates: candidates,
        delivery_authorized: candidates,
        lens_evaluated: candidates,
        watermark_fresh: 0,
        content_deduped: 0,
        owed_drained: 0,
        items: 0,
      },
      redlines: [],
      observations: [{
        code: "quiet_watermark",
        severity: "info",
        stage: "watermark_fresh",
        classification: "watermark exhaustion after backlog flush",
        reason: "watermark exhaustion after backlog flush",
        evidence: { source_candidates: candidates, watermark_fresh: 0, backlog_flush_day: "2026-09-07" },
      }],
      upstream_incidents: [],
    },
  };
}

function expectedCatchUpReceipt() {
  return {
    summary: {
      status: "READY",
      run_day: "2026-09-18",
      ran_at: "2026-09-18T10:10:53.838Z",
      ok: true,
      selection_funnel: {
        source_candidates: 116,
        delivery_authorized: 116,
        lens_evaluated: 116,
        watermark_fresh: 116,
        content_deduped: 12,
        owed_drained: 122,
        items: 122,
      },
      redlines: [],
      observations: [{
        code: "expected_catch_up_explosion",
        severity: "info",
        classification: "expected catch-up after owed backlog drain",
        reason: "expected catch-up after owed backlog drain",
        evidence: {
          selection_funnel: {
            source_candidates: 116,
            delivery_authorized: 116,
            lens_evaluated: 116,
            watermark_fresh: 116,
            content_deduped: 12,
            owed_drained: 122,
            items: 122,
          },
        },
      }],
      upstream_incidents: [],
    },
  };
}

test("A2 named assertion: letter-receipts unchanged attention comments once; a changed receipt still comments", async () => {
  await withPinnedClock("2026-09-10T12:00:00.000Z", async () => {
    await withTempDir("crol-digest-shadow-unchanged", async (stateDir) => {
      const github = fakeGithub();
      await github.createIssue({ title: DIGEST_SHADOW_JOB.issue_title, body: "prior finding" });
      const receipt = emptySourceReceipt();
      const observationPath = join(stateDir, "quiet-watermark-cycles.json");
      async function cycle(now) {
        return withDigestShadowEnv({
          CITYSCROLL_ADMIN_KEY: "probe-secret",
          CITYSCROLL_DIGEST_SHADOW_URL: "https://example.invalid/admin/digest-shadow",
        }, async () => {
          const output = await runDigestShadowJob(DIGEST_SHADOW_JOB, {
            stateDir,
            now,
            runKey: runKey(now),
            observationPath,
            async fetchImpl() {
              return { ok: false, status: 503, async json() { return receipt; } };
            },
          });
          await persistJobOutput(stateDir, now, output);
          return output;
        });
      }

      const first = await cycle(new Date("2026-09-10T10:10:00.000Z"));
      await replayOutbox({ stateDir, github, now: "2026-09-10T10:10:00.000Z" });
      const second = await cycle(new Date("2026-09-10T13:10:00.000Z"));
      await replayOutbox({ stateDir, github, now: "2026-09-10T13:10:00.000Z" });

      assert.equal(first.result.comment_written, true);
      assert.equal(second.result.comment_written, false);
      assert.equal(second.result.comment_suppressed, UNCHANGED_OBSERVATION);
      assert.equal((await github.listComments(1)).length, 1);
      const stored = JSON.parse(await readFile(observationPath, "utf8"));
      assert.equal(stored.schema, DIGEST_SHADOW_MONITOR_OBSERVATION_SCHEMA);
      assert.equal(stored.observations.length, 2);
      assert.equal(stored.observations[0].comment_written, true);
      assert.equal(stored.observations[1].comment_written, false);
      assert.equal(stored.observations[1].comment_suppressed, UNCHANGED_OBSERVATION);
      assert.equal(stored.observations[1].collapse_stage, "source_candidates");
      assert.equal(stored.observations[1].source_candidates, 0);
      assert.equal(stored.observations[1].finding_severity, "attention");
    });

    await withTempDir("crol-digest-shadow-changed", async (stateDir) => {
      const github = fakeGithub();
      await github.createIssue({ title: DIGEST_SHADOW_JOB.issue_title, body: "prior finding" });
      let receipt = emptySourceReceipt("2026-09-10", "2026-09-10T10:00:31.209Z");
      async function cycle(now) {
        const current = receipt;
        return withDigestShadowEnv({
          CITYSCROLL_ADMIN_KEY: "probe-secret",
          CITYSCROLL_DIGEST_SHADOW_URL: "https://example.invalid/admin/digest-shadow",
        }, async () => {
          const output = await runDigestShadowJob(DIGEST_SHADOW_JOB, {
            stateDir,
            now,
            runKey: runKey(now),
            async fetchImpl() {
              return { ok: false, status: 503, async json() { return current; } };
            },
          });
          await persistJobOutput(stateDir, now, output);
          return output;
        });
      }

      await cycle(new Date("2026-09-10T10:10:00.000Z"));
      await replayOutbox({ stateDir, github, now: "2026-09-10T10:10:00.000Z" });
      receipt = emptySourceReceipt("2026-09-11", "2026-09-11T10:00:22.000Z");
      await cycle(new Date("2026-09-11T10:10:00.000Z"));
      await replayOutbox({ stateDir, github, now: "2026-09-11T10:10:00.000Z" });
      assert.equal((await github.listComments(1)).length, 2);
    });
  });
});
test("a quiet watermark rehearsal opens no attention issue", async () => {
  await withTempDir("crol-digest-shadow-quiet", async (stateDir) => {
    const github = fakeGithub();
    const receipt = quietWatermarkReceipt();
    const output = await withDigestShadowEnv({
      CITYSCROLL_ADMIN_KEY: "probe-secret",
      CITYSCROLL_DIGEST_SHADOW_URL: "https://example.invalid/admin/digest-shadow",
    }, async () => {
      const now = new Date("2026-09-10T10:10:00.000Z");
      const ran = await runDigestShadowJob(DIGEST_SHADOW_JOB, {
        stateDir,
        now,
        runKey: runKey(now),
        async fetchImpl() {
          return { ok: true, status: 200, async json() { return receipt; } };
        },
      });
      await persistJobOutput(stateDir, now, ran);
      return ran;
    });
    await replayOutbox({ stateDir, github, now: "2026-09-10T10:10:00.000Z" });
    assert.equal(output.result.status, "healthy");
    assert.equal(output.result.finding_severity, "info");
    assert.equal(output.result.comment_written, false);
    assert.equal(output.intents[0].issue.mode, "close");
    assert.equal(github.issues.length, 0);
  });
});

test("a catch-up explosion receipt is informational and records its observation kind", async () => {
  await withTempDir("crol-digest-shadow-catch-up", async (stateDir) => {
    const github = fakeGithub();
    const receipt = expectedCatchUpReceipt();
    const output = await withDigestShadowEnv({
      CITYSCROLL_ADMIN_KEY: "probe-secret",
      CITYSCROLL_DIGEST_SHADOW_URL: "https://example.invalid/admin/digest-shadow",
    }, async () => runDigestShadowJob(DIGEST_SHADOW_JOB, {
      stateDir,
      now: new Date("2026-09-18T10:10:00.000Z"),
      runKey: runKey(new Date("2026-09-18T10:10:00.000Z")),
      async fetchImpl() { return { ok: true, status: 200, async json() { return receipt; } }; },
    }));

    assert.equal(output.result.finding_severity, "info");
    assert.match(output.result.body, /expected catch-up after owed backlog drain/);
    assert.equal(output.result.comment_written, false);
    assert.equal(output.intents[0].issue.mode, "close");
    await persistJobOutput(stateDir, new Date("2026-09-18T10:10:00.000Z"), output);
    const stored = JSON.parse(await readFile(join(stateDir, "jobs", DIGEST_SHADOW_JOB.id, "quiet-watermark-cycles-2026-09-14.json"), "utf8"));
    assert.equal(stored.observations[0].observation_kind, "expected_catch_up_explosion");
    assert.equal(stored.observations[0].rehearsal_reason, "expected catch-up after owed backlog drain");
  });
});

test("a quiet watermark receipt records why the shadow issue did not page", async () => {
  await withTempDir("crol-digest-shadow-backlog-flush", async (stateDir) => {
    const github = fakeGithub();
    const receipt = quietWatermarkReceipt();
    const output = await withDigestShadowEnv({
      CITYSCROLL_ADMIN_KEY: "probe-secret",
      CITYSCROLL_DIGEST_SHADOW_URL: "https://example.invalid/admin/digest-shadow",
    }, async () => runDigestShadowJob(DIGEST_SHADOW_JOB, {
      stateDir,
      now: new Date("2026-09-10T10:10:00.000Z"),
      runKey: runKey(new Date("2026-09-10T10:10:00.000Z")),
      async fetchImpl() { return { ok: true, status: 200, async json() { return receipt; } }; },
    }));

    assert.equal(output.result.finding_severity, "info");
    assert.match(output.intents[0].issue.body, /watermark exhaustion after backlog flush/);
    await persistJobOutput(stateDir, new Date("2026-09-10T10:10:00.000Z"), output);
    const stored = JSON.parse(await readFile(join(stateDir, "jobs", DIGEST_SHADOW_JOB.id, "quiet-watermark-cycles-2026-09-14.json"), "utf8"));
    assert.equal(stored.observations[0].rehearsal_reason, "watermark exhaustion after backlog flush");
  });
});
