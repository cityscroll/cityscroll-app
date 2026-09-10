import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { persistScheduleResult, replayOutbox } from "../tools/external_schedule_outbox.mjs";
import { runDigestShadowJob } from "../tools/digest_shadow_monitor.mjs";
import {
  DIGEST_SHADOW_MONITOR_OBSERVATION_SCHEMA,
  UNCHANGED_OBSERVATION,
} from "../tools/digest_shadow_monitor_observation.mjs";
import { withTempDir } from "../tools/lib/with_temp_dir.mjs";

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

function emptySourceReceipt(runDay = "2026-09-10", ranAt = "2026-09-10T10:00:31.209Z") {
  return {
    summary: {
      status: "NEEDS_ATTENTION",
      run_day: runDay,
      ran_at: ranAt,
      ok: false,
      collapse_stage: "source_candidates",
      selection_funnel: {
        source_candidates: 0,
        delivery_authorized: 0,
        lens_evaluated: 0,
        watermark_fresh: 0,
        content_deduped: 0,
        owed_drained: 0,
        items: 0,
      },
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
}

function quietWatermarkReceipt(runDay = "2026-09-10", candidates = 379) {
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
        reason: "the per-watch seen watermark already contained every candidate",
        evidence: { source_candidates: candidates, watermark_fresh: 0 },
      }],
      upstream_incidents: [],
    },
  };
}

test("two cycles against one unchanged rehearsal receipt comment once", async () => {
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
});

test("a changed rehearsal receipt still comments", async () => {
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
