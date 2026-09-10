/**
 * A publisher that has frozen keeps reporting success. These cases pin the monitor's
 * independence from that self-report, its failure and recovery on controlled specimens, and
 * the single identity a repeated observation lands on.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { withTempDir } from "../tools/lib/with_temp_dir.mjs";

import {
  STATS_UNPUBLISHED_ISSUE_TITLE,
  STATS_PUBLICATION_ISSUE_MARKER,
  STATS_PUBLICATION_ISSUE_TITLE,
  STATS_PUBLICATION_JOB_ID,
  dayBeforeMeasurement,
  evaluateStatsPublication,
  promisedPublicationDays,
  promisedSnapshotDay,
  publicationHorizonStart,
  statsPublicationIssueBody,
} from "../tools/stats_publication_monitor.mjs";
import { applyIssueIntent } from "../tools/external_schedule_outbox.mjs";
import { monitorRepairFindings } from "../tools/repair_findings.mjs";
import { runScheduledJob } from "../tools/external_schedule_runner.mjs";

const NOW = "2026-09-06T12:00:00Z";

function specimen(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/stats-publication/${name}.json`, import.meta.url), "utf8"));
}

test("the promised day is derived from the clock, never from the publisher", () => {
  // A day closes at midnight and the cycle that publishes it runs after that, so the promise
  // covers one normal run plus one missed one and no more.
  assert.equal(promisedSnapshotDay("2026-09-06T12:00:00Z"), "2026-09-04");
  // Just after midnight the previous day is still inside its grace, so it is not yet promised.
  assert.equal(promisedSnapshotDay("2026-09-06T00:10:00Z"), "2026-09-03");
  assert.equal(promisedSnapshotDay("2026-09-07T08:00:00Z"), "2026-09-05");
});

test("the promised day set starts at max(measured_since, retention_start)", () => {
  const now = "2026-09-10T11:47:00Z";
  assert.equal(publicationHorizonStart({
    now, measuredSince: "2026-09-09T00:00:00.000Z", receiptRetentionDays: 30,
  }), "2026-09-09");
  assert.deepEqual(promisedPublicationDays({
    now, measuredSince: "2026-09-09T00:00:00.000Z", receiptRetentionDays: 30,
  }), ["2026-09-09"]);
  assert.equal(dayBeforeMeasurement("2026-09-08", "2026-09-09T00:00:00.000Z"), true);
  assert.equal(dayBeforeMeasurement("2026-09-09", "2026-09-09T00:00:00.000Z"), false);
  // Measurement older than the receipt window still promises from retention start.
  assert.equal(publicationHorizonStart({
    now, measuredSince: "2026-07-01T00:00:00.000Z", receiptRetentionDays: 30,
  }), "2026-08-11");
});

test("a frozen publisher is named even while it reports a fresh verification", () => {
  const finding = evaluateStatsPublication({ now: NOW, observation: specimen("failure") });
  assert.equal(finding.ok, false);
  assert.equal(finding.failing_stage, "frozen-publisher");
  assert.equal(finding.evidence.refresh_state, "fresh", "the self-report said healthy");
  assert.match(finding.findings.join("\n"), /newest dated day is still 2026-09-01/);
  // Nothing about a reader, a query, or a store crosses into a body that becomes a public issue.
  const body = statsPublicationIssueBody(finding);
  assert.doesNotMatch(body, /ALERT_STATE|stats:public:|search:exec|query|visitor|subscriber|Bearer/i);
  assert.match(body, new RegExp(STATS_PUBLICATION_ISSUE_MARKER));
});

test("the same specimen after a catch-up run reports recovery", () => {
  const finding = evaluateStatsPublication({ now: NOW, observation: specimen("recovered") });
  assert.equal(finding.ok, true);
  assert.equal(finding.failing_stage, null);
  assert.deepEqual(finding.findings, []);
  assert.match(statsPublicationIssueBody(finding), /is published/);
});

test("an unreadable observation is a check that could not run, not a failed publication", () => {
  const finding = evaluateStatsPublication({ now: NOW, observation: specimen("unreadable") });
  assert.equal(finding.ok, false);
  assert.equal(finding.failing_stage, "observation-unavailable");
  assert.match(finding.notes.join(" "), /not evidence that publication failed/);
});

test("a plain missing day, a divergent day and a stale verification each name their own stage", () => {
  const missing = evaluateStatsPublication({
    now: NOW,
    observation: {
      lineage: { available: true, newest_day: "2026-09-01", missing_days: ["2026-09-04"], unrecoverable_days: [], reconciliation: { rows: [] } },
      published: { refresh: { state: "failed", verified_at: "2026-09-05T09:00:00.000Z" } },
    },
  });
  assert.equal(missing.failing_stage, "missing-daily-aggregate", "a stale self-report is not a frozen one");

  const divergent = evaluateStatsPublication({
    now: NOW,
    observation: {
      lineage: {
        available: true,
        newest_day: "2026-09-05",
        missing_days: [],
        unrecoverable_days: [],
        reconciliation: { rows: [{ day: "2026-09-02", state: "divergent" }] },
      },
      published: { refresh: { state: "fresh", verified_at: "2026-09-06T09:00:00.000Z" } },
    },
  });
  assert.equal(divergent.failing_stage, "divergent-aggregate");

  const stale = evaluateStatsPublication({
    now: NOW,
    observation: {
      lineage: { available: true, newest_day: "2026-09-05", missing_days: [], unrecoverable_days: [], reconciliation: { rows: [] } },
      published: { refresh: { state: "stale", verified_at: "2026-09-01T09:00:00.000Z" } },
    },
  });
  assert.equal(stale.failing_stage, "stale-verification");
});

test("days before measurement are not_measured, a later gap is missing, and a stall is frozen", () => {
  const measuredSince = "2026-09-09T00:00:00.000Z";
  const healthy = evaluateStatsPublication({
    now: "2026-09-10T11:47:00Z",
    observation: {
      published: {
        measurement: { measured_since: measuredSince },
        refresh: { state: "fresh", verified_at: "2026-09-10T08:00:26.790Z" },
      },
      lineage: {
        available: true,
        measured_since: measuredSince,
        newest_day: "2026-09-09",
        receipt_retention_days: 30,
        // Old payload shape: every absent day in the 90-day window listed as missing.
        missing_days: ["2026-08-11", "2026-09-08"],
        unrecoverable_days: ["2026-08-11"],
        reconciliation: { rows: [{ day: "2026-09-09", state: "matched" }] },
      },
    },
  });
  assert.equal(healthy.ok, true);
  assert.equal(healthy.failing_stage, null);
  assert.deepEqual(healthy.evidence.missing_days, []);
  assert.deepEqual(healthy.evidence.before_measurement, ["2026-08-11", "2026-09-08"]);
  assert.equal(healthy.evidence.horizon_start, "2026-09-09");
  const healthyBody = statsPublicationIssueBody(healthy);
  assert.match(healthyBody, /is published/);
  assert.match(healthyBody, /Measurement began on 2026-09-09/);
  assert.match(healthyBody, /not measured/);
  assert.doesNotMatch(healthyBody, /cannot be recovered/);

  const gap = evaluateStatsPublication({
    now: NOW,
    observation: {
      published: {
        measurement: { measured_since: "2026-09-01T00:00:00.000Z" },
        refresh: { state: "failed", verified_at: "2026-09-05T09:00:00.000Z" },
      },
      lineage: {
        available: true,
        measured_since: "2026-09-01T00:00:00.000Z",
        newest_day: "2026-09-05",
        missing_days: ["2026-09-04"],
        before_measurement: [],
        unrecoverable_days: [],
        receipt_retention_days: 30,
        reconciliation: { rows: [] },
      },
    },
  });
  assert.equal(gap.ok, false);
  assert.equal(gap.failing_stage, "missing-daily-aggregate");
  assert.deepEqual(gap.evidence.missing_days, ["2026-09-04"]);

  const frozen = evaluateStatsPublication({
    now: NOW,
    observation: {
      published: {
        measurement: { measured_since: "2026-09-01T00:00:00.000Z" },
        refresh: { state: "fresh", verified_at: "2026-09-06T09:00:00.000Z" },
      },
      lineage: {
        available: true,
        measured_since: "2026-09-01T00:00:00.000Z",
        newest_day: "2026-09-02",
        missing_days: ["2026-09-03", "2026-09-04", "2026-09-05"],
        before_measurement: [],
        unrecoverable_days: [],
        receipt_retention_days: 30,
        reconciliation: { rows: [] },
      },
    },
  });
  assert.equal(frozen.ok, false);
  assert.equal(frozen.failing_stage, "frozen-publisher");
  assert.match(statsPublicationIssueBody(frozen), /Measurement began on 2026-09-01/);
});

test("a gap beyond the receipts is a note, not a card reopened every day", () => {
  const finding = evaluateStatsPublication({
    now: NOW,
    observation: {
      lineage: {
        available: true,
        newest_day: "2026-09-05",
        missing_days: ["2026-07-01"],
        unrecoverable_days: ["2026-07-01"],
        reconciliation: { rows: [] },
      },
      published: { refresh: { state: "fresh", verified_at: "2026-09-06T09:00:00.000Z" } },
    },
  });
  assert.equal(finding.ok, true);
  assert.match(finding.notes.join(" "), /cannot be recovered/);
});

/**
 * The runner's own leg: the two observations are read from two sides, the finding is persisted
 * through the shared outbox, and a repeated observation lands on one identity rather than a
 * second card. No production traffic is touched — both reads are supplied by a stub.
 */
test("repeated observations update one finding identity through the existing outbox", async () => {
  await withTempDir("stats-publication", async (stateDir) => {
  const failure = specimen("failure");
  const responses = (url) => (
    String(url).includes("/admin/stats")
      ? { ok: true, json: async () => ({ search_usage_lineage: { series: failure.lineage, reconciliation: failure.lineage.reconciliation } }) }
      : { ok: true, json: async () => ({ search_usage: failure.published }) }
  );
  const job = {
    id: STATS_PUBLICATION_JOB_ID,
    schedule: ["47 11 * * *"],
    runner: "stats-daily-snapshot",
    issue_title: STATS_PUBLICATION_ISSUE_TITLE,
  };
  const run = async (runKey) => runScheduledJob(job, {
    stateDir,
    now: new Date(NOW),
    runKey,
    fetchImpl: async (url) => responses(url),
  });

  process.env.CITYSCROLL_ADMIN_KEY = "specimen-key";
  try {
    const first = await run("2026-09-06T12-00");
    assert.equal(first.result.status, "degraded");
    assert.equal(first.result.failing_stage, "frozen-publisher");
    assert.equal(first.issue.mode, "open");
    assert.equal(first.issue.title, STATS_PUBLICATION_ISSUE_TITLE);
    assert.deepEqual(first.issue.body_contains, [STATS_PUBLICATION_ISSUE_MARKER]);

    await run("2026-09-06T13-00");
    // Both observations describe the same condition and carry the same title and marker, so
    // the delivery leg updates one card. Two cards would be two pieces of work for one fault.
    const intents = readdirSync(join(stateDir, "outbox"))
      .map((name) => JSON.parse(readFileSync(join(stateDir, "outbox", name), "utf8")));
    assert.equal(intents.length, 2, "each run keeps its own observation");
    assert.deepEqual([...new Set(intents.map((event) => event.issue.title))], [STATS_PUBLICATION_ISSUE_TITLE]);
    assert.deepEqual([...new Set(intents.map((event) => event.job_id))], [STATS_PUBLICATION_JOB_ID]);

    // And the recovery leg closes rather than opening something else.
    const recovered = specimen("recovered");
    const closing = await runScheduledJob(job, {
      stateDir,
      now: new Date(NOW),
      runKey: "2026-09-06T14-00",
      fetchImpl: async (url) => (
        String(url).includes("/admin/stats")
          ? { ok: true, json: async () => ({ search_usage_lineage: { series: recovered.lineage, reconciliation: recovered.lineage.reconciliation } }) }
          : { ok: true, json: async () => ({ search_usage: recovered.published }) }
      ),
    });
    assert.equal(closing.result.status, "healthy");
    assert.equal(closing.issue.mode, "close");
  } finally {
    delete process.env.CITYSCROLL_ADMIN_KEY;
  }
  });
});

test("the runner carries measured_since so a stored first day is healthy", async () => {
  await withTempDir("stats-publication-horizon", async (stateDir) => {
    const measuredSince = "2026-09-09T00:00:00.000Z";
    process.env.CITYSCROLL_ADMIN_KEY = "specimen-key";
    try {
      const output = await runScheduledJob({
        id: STATS_PUBLICATION_JOB_ID,
        schedule: ["47 11 * * *"],
        runner: "stats-daily-snapshot",
        issue_title: STATS_PUBLICATION_ISSUE_TITLE,
      }, {
        stateDir,
        now: new Date("2026-09-10T11:47:00Z"),
        runKey: "2026-09-10T11-47",
        fetchImpl: async (url) => ({
          ok: true,
          json: async () => String(url).includes("/admin/stats")
            ? {
              search_usage_lineage: {
                measured_since: measuredSince,
                series: {
                  available: true,
                  newest_day: "2026-09-09",
                  missing_days: ["2026-09-08"],
                  unrecoverable_days: [],
                  receipt_retention_days: 30,
                },
                reconciliation: { rows: [{ day: "2026-09-09", state: "matched" }] },
              },
            }
            : {
              search_usage: {
                measurement: { measured_since: measuredSince },
                refresh: { state: "fresh", verified_at: "2026-09-10T08:00:26.790Z" },
              },
            },
        }),
      });
      assert.equal(output.result.status, "healthy");
      assert.equal(output.issue.mode, "close");
      assert.match(output.result.body, /Measurement began on 2026-09-09/);
      assert.match(output.result.body, /not measured/);
    } finally {
      delete process.env.CITYSCROLL_ADMIN_KEY;
    }
  });
});

test("a missing admin credential is a configuration fault, not a publication failure", async () => {
  await withTempDir("stats-publication-nokey", async (stateDir) => {
  const inherited = process.env.CITYSCROLL_ADMIN_KEY;
  const inheritedAlias = process.env.ADMIN_KEY;
  delete process.env.CITYSCROLL_ADMIN_KEY;
  delete process.env.ADMIN_KEY;
  try {
    const output = await runScheduledJob({
      id: STATS_PUBLICATION_JOB_ID,
      schedule: ["47 11 * * *"],
      runner: "stats-daily-snapshot",
      issue_title: STATS_PUBLICATION_ISSUE_TITLE,
    }, {
      stateDir,
      now: new Date(NOW),
      runKey: "2026-09-06T15-00",
      fetchImpl: async () => { throw new Error("the monitor must not reach a network without a credential"); },
    });
    assert.equal(output.result.degraded_reason, "admin-credential-missing");
    assert.match(output.issue.title, /no admin credential/);
    assert.notEqual(output.issue.title, STATS_PUBLICATION_ISSUE_TITLE, "a configuration fault is not the publication card");
  } finally {
    if (inherited !== undefined) process.env.CITYSCROLL_ADMIN_KEY = inherited;
    if (inheritedAlias !== undefined) process.env.ADMIN_KEY = inheritedAlias;
  }
  });
});


test("no stored day or verified instant means publication has not started", () => {
  const observation = specimen("unpublished");
  const finding = evaluateStatsPublication({ now: NOW, observation });
  assert.equal(finding.failing_stage, "publisher-not-yet-delivered");
  assert.equal(finding.promised_day, null);
  assert.equal(Object.hasOwn(finding.evidence, "missing_days"), false);
  assert.equal(Object.hasOwn(finding.evidence, "unrecoverable_days"), false);
  assert.deepEqual(finding.notes, []);
  assert.match(statsPublicationIssueBody(finding), /search-usage summary on the Stats page/);
  assert.doesNotMatch(JSON.stringify(finding), /missing_days|unrecoverable|cannot be recovered/);

  observation.lineage.newest_day = "2026-09-01";
  const missing = evaluateStatsPublication({ now: NOW, observation });
  assert.equal(missing.failing_stage, "missing-daily-aggregate");
  assert.equal(missing.promised_day, "2026-09-04");
  assert.deepEqual(missing.evidence.missing_days, ["2026-09-04"]);
  assert.deepEqual(missing.evidence.unrecoverable_days, ["2026-07-01"]);
  assert.match(missing.notes.join(" "), /1 day\(s\).*cannot be recovered/);

  observation.lineage.newest_day = null;
  observation.published.refresh = { state: "fresh", verified_at: NOW };
  assert.equal(evaluateStatsPublication({ now: NOW, observation }).failing_stage, "frozen-publisher");
});

test("unpublished runs correct the existing issue once, skip repair, and close on first publication", async () => {
  await withTempDir("stats-first-publication", async (stateDir) => {
    const job = { id: STATS_PUBLICATION_JOB_ID, runner: "stats-daily-snapshot", issue_title: STATS_PUBLICATION_ISSUE_TITLE };
    const inherited = process.env.CITYSCROLL_ADMIN_KEY;
    process.env.CITYSCROLL_ADMIN_KEY = "specimen-key";
    const issues = [{ number: 1831, title: STATS_PUBLICATION_ISSUE_TITLE, body: "60 day(s) cannot be recovered", state: "open" }];
    let updates = 0;
    const github = {
      listIssues: async () => issues.filter((issue) => issue.state === "open"),
      updateIssue: async (number, patch) => { updates++; Object.assign(issues.find((issue) => issue.number === number), patch); },
      createIssue: async (issue) => { const created = { ...issue, number: 1832, state: "open" }; issues.push(created); return created; },
      listComments: async () => [],
      createComment: async () => {},
    };
    const run = async (observation, slot) => {
      const output = await runScheduledJob(job, {
        stateDir, now: new Date(NOW), runKey: slot,
        fetchImpl: async (url) => ({ ok: true, json: async () => String(url).includes("/admin/stats")
          ? { search_usage_lineage: { series: observation.lineage } }
          : { search_usage: observation.published } }),
      });
      const events = readdirSync(join(stateDir, "outbox")).map((name) => JSON.parse(readFileSync(join(stateDir, "outbox", name), "utf8")));
      return { output, intent: events.find((event) => event.run_key === slot).issue };
    };
    try {
      const first = await run(specimen("unpublished"), "2026-09-06T12-00");
      assert.equal(first.output.issue.mode, "open");
      assert.equal(first.intent.title, STATS_UNPUBLISHED_ISSUE_TITLE);
      assert.ok(first.intent.title_aliases.includes(STATS_PUBLICATION_ISSUE_TITLE));
      const repairs = monitorRepairFindings(job, first.output);
      assert.deepEqual(repairs.findings, []);
      assert.equal(repairs.recovered.length, 1, "prior false repair faults can retire");
      assert.equal((await applyIssueIntent(github, first.intent)).action, "updated");
      assert.equal((await applyIssueIntent(github, first.intent)).action, "already-recorded");
      assert.equal(updates, 1);
      assert.equal(issues[0].title, STATS_UNPUBLISHED_ISSUE_TITLE);
      assert.doesNotMatch(issues[0].body, /cannot be recovered|missing_days|Promised day/);
      const repeated = await run(specimen("unpublished"), "2026-09-06T13-00");
      await applyIssueIntent(github, repeated.intent);
      assert.equal(issues.length, 1);

      const recovered = specimen("recovered");
      const closing = await run(recovered, "2026-09-06T14-00");
      assert.equal(closing.intent.mode, "close");
      await applyIssueIntent(github, closing.intent);
      assert.equal(issues[0].state, "closed");

      const observation = specimen("unpublished");
      observation.lineage.newest_day = "2026-09-01";
      const missing = await run(observation, "2026-09-06T15-00");
      assert.equal(missing.intent.mode, "open");
      assert.equal(missing.intent.title, STATS_PUBLICATION_ISSUE_TITLE);
      assert.match(monitorRepairFindings(job, missing.output).findings[0].signature, /:stats-snapshot-missing:missing-daily-aggregate$/);
      // With no existing issue, the same unpublished intent creates just one.
      await applyIssueIntent(github, repeated.intent);
      await applyIssueIntent(github, repeated.intent);
      assert.equal(issues.filter((issue) => issue.state === "open").length, 1);
    } finally {
      if (inherited === undefined) delete process.env.CITYSCROLL_ADMIN_KEY;
      else process.env.CITYSCROLL_ADMIN_KEY = inherited;
    }
  });
});
