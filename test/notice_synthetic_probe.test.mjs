// The scheduled synthetic probe: its committed page list, its rendered job
// definition, its command, and what it is allowed to escalate.
//
// The probe exists because the Notice surface does not retain enough resident
// observations to answer a readiness question inside a review cycle. It is a
// second, labelled measurement group — so these cases hold it to being visibly
// synthetic end to end, bounded in what it costs, and quiet unless the probe
// itself is broken.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  NOTICE_SYNTHETIC_PROBE_ESCALATION,
  NOTICE_SYNTHETIC_PROBE_PAGES,
  noticeSyntheticProbeBody,
  noticeSyntheticProbeIssueMode,
  runScheduledJob,
} from "../tools/external_schedule_runner.mjs";
import { RUM_MEASUREMENT_GROUPS } from "../tools/lib/rum_measurement_groups.mjs";

const ROOT = new URL("../", import.meta.url);
const JOB_ID = "notice-synthetic-probe";
const PROBE_SCRIPT = new URL("tools/run_notice_synthetic_probe.py", ROOT).pathname;

const jobs = JSON.parse(readFileSync(new URL("tools/external_schedule_jobs.json", ROOT), "utf8"));
const pages = JSON.parse(readFileSync(new URL(NOTICE_SYNTHETIC_PROBE_PAGES, ROOT), "utf8"));
const job = jobs.jobs.find((candidate) => candidate.id === JOB_ID);

// Every scratch directory is removed even when a case fails: an interrupted run
// that skips its cleanup is exactly the residue the temp-leak gate catches.
const scratchDirs = [];
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "crol-synthetic-probe-"));
  scratchDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("the job is registered on the independent scheduler with several slots a day", () => {
  assert.ok(job, `${JOB_ID} is not registered`);
  assert.equal(jobs.scheduler.ownership, "independent");
  assert.equal(job.runner, JOB_ID);
  assert.equal(job.pages, NOTICE_SYNTHETIC_PROBE_PAGES);
  assert.ok(job.schedule.length >= 2, "a single daily slot is not several");
  const hours = job.schedule.map((expression) => {
    const [minute, hour, day, month, weekday] = expression.trim().split(/\s+/);
    assert.match(minute, /^\d{1,2}$/, `slot ${expression} has no fixed minute`);
    assert.match(hour, /^\d{1,2}$/, `slot ${expression} has no fixed hour`);
    assert.deepEqual([day, month, weekday], ["*", "*", "*"], `slot ${expression} is not daily`);
    return Number(hour);
  });
  assert.equal(new Set(hours).size, hours.length, "two slots land in the same hour");
  // Slots are spread across the day rather than bunched, so a slow hour on the
  // operator's host cannot dominate the retained distribution.
  const sorted = [...hours].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i += 1) {
    assert.ok(sorted[i] - sorted[i - 1] >= 4, `slots ${sorted[i - 1]} and ${sorted[i]} are less than four hours apart`);
  }
});

test("the job definition carries no secret and no credential of its own", () => {
  const serialized = JSON.stringify(job);
  assert.equal(/token|secret|key|password|authorization|bearer/i.test(serialized), false);
  // The probe reads public pages; it names a page list and a title, nothing else.
  assert.deepEqual(Object.keys(job).sort(), ["id", "issue_title", "pages", "runner", "schedule"]);
});

test("the committed page list spreads notice kinds and sizes and explains itself", () => {
  assert.equal(pages.traffic_class, RUM_MEASUREMENT_GROUPS.synthetic.traffic_class);
  assert.equal(pages.surface_id, "notice");
  assert.ok(pages.selection_rationale.length > 200, "the list does not explain why these pages");
  assert.ok(pages.maintenance.length > 0, "the list does not say what happens when a page stops resolving");
  assert.ok(pages.pages.length >= 6, "too few pages to spread anything across");

  const paths = pages.pages.map((page) => page.path);
  assert.equal(new Set(paths).size, paths.length, "the list repeats a page");
  for (const page of pages.pages) {
    assert.match(page.path, /^\/notices\/[0-9]+\/$/, `${page.path} is not a Notice route`);
    assert.ok(page.rationale.length > 20, `${page.path} carries no rationale`);
    assert.ok(Number.isInteger(page.document_bytes) && page.document_bytes > 0);
  }
  // A spread, not a repeat: several published notice kinds and a stated range of
  // document sizes with both ends named.
  assert.ok(new Set(pages.pages.map((page) => page.notice_kind)).size >= 4);
  const weights = pages.pages.map((page) => page.weight_class);
  assert.ok(weights.includes("heaviest") && weights.includes("lightest"));
  assert.equal(pages.document_bytes_measured_at, "2026-09-07");
});

test("the visit policy is a cold, single, bounded visit per page per slot", () => {
  assert.equal(pages.visit_policy.cold_cache_per_visit, true);
  assert.equal(pages.visit_policy.visits_per_page_per_slot, 1);
  assert.ok(pages.visit_policy.run_budget_ms > 0);
  assert.ok(pages.visit_policy.page_timeout_ms > 0);
  assert.equal(pages.device_profile.is_mobile, true);
  assert.ok(pages.device_profile.viewport.width <= 430, "the device profile is not a phone");
  assert.ok(pages.network_profile.latency_ms > 0, "the network profile applies no throttle");
  assert.ok(pages.network_profile.download_throughput_bytes_per_second > 0);
});

test("the probe command runs against a stubbed page list and resolves the visits it would make", () => {
  const dir = scratch();
  const stub = join(dir, "stub-pages.json");
  writeFileSync(stub, JSON.stringify({
    ...pages,
    pages: [
      { ...pages.pages[0], path: "/notices/19990101001/" },
      { ...pages.pages[1], path: "/notices/19990101002/" },
    ],
  }, null, 2));

  const out = join(dir, "plan.json");
  // `--plan` resolves the run without a browser or a network, so the command the
  // scheduler will invoke is exercised here rather than only described.
  execFileSync("python3", [PROBE_SCRIPT, "--pages", stub, "--base", "https://example.invalid", "--plan", "--out", out]);
  const plan = JSON.parse(readFileSync(out, "utf8"));

  assert.equal(plan.traffic_class, "synthetic");
  assert.equal(plan.marker.global, "CROL_RUM_TRAFFIC_CLASS");
  assert.equal(plan.marker.value, "synthetic");
  assert.equal(plan.marker.delivery_flag, "traffic_class=synthetic");
  assert.equal(plan.marker.inferred_from_user_agent, false);
  assert.equal(plan.marker.carried_on_page_url, false);
  assert.deepEqual(plan.visits.map((visit) => visit.url), [
    "https://example.invalid/notices/19990101001/",
    "https://example.invalid/notices/19990101002/",
  ]);
  for (const visit of plan.visits) {
    assert.equal(visit.cold_cache, true);
    assert.equal(visit.visits_in_slot, 1);
  }
});

test("the probe refuses a page list that would carry the marker on the page URL", () => {
  const dir = scratch();
  const stub = join(dir, "bad-pages.json");
  writeFileSync(stub, JSON.stringify({
    ...pages,
    pages: [{ ...pages.pages[0], path: "/notices/19990101001/?traffic_class=synthetic" }],
  }));
  assert.throws(
    () => execFileSync("python3", [PROBE_SCRIPT, "--pages", stub, "--plan"], { stdio: "pipe" }),
    /marker on the page URL/,
  );
});

test("the runner records a slot and stays quiet while the probe is working", async () => {
  const stateDir = scratch();
  const report = {
    schema: "cityscroll.notice_synthetic_probe_result.v1",
    status: "healthy",
    traffic_class: "synthetic",
    pages_listed: 8,
    pages_visited: 8,
    observations_emitted: 24,
    unmarked_beacons: 0,
    failures: [],
  };
  const output = await runScheduledJob(job, {
    stateDir,
    now: new Date("2026-09-14T02:07:00.000Z"),
    probeRunner: async ({ resultPath }) => {
      writeFileSync(resultPath, JSON.stringify(report));
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(output.result.status, "healthy");
  assert.equal(output.result.measurement_group, "synthetic");
  assert.equal(output.result.pages_visited, 8);
  assert.equal(output.result.observations_emitted, 24);
  assert.equal(output.result.consecutive_failures, 0);
  // Nothing is filed for a working probe, however slow the pages were.
  assert.equal(output.issue.mode, "none");
});

test("the runner files an issue only after the probe itself fails repeatedly", async () => {
  const stateDir = scratch();
  const fail = async () => ({ code: 1, stdout: "", stderr: "playwright is not installed" });
  const modes = [];
  for (let slot = 1; slot <= NOTICE_SYNTHETIC_PROBE_ESCALATION; slot += 1) {
    const output = await runScheduledJob(job, {
      stateDir,
      now: new Date(`2026-09-14T0${slot}:07:00.000Z`),
      probeRunner: fail,
    });
    modes.push(output.issue.mode);
    assert.equal(output.result.consecutive_failures, slot);
  }
  assert.deepEqual(modes, [...Array(NOTICE_SYNTHETIC_PROBE_ESCALATION - 1).fill("none"), "open"]);

  // Recovery closes what the escalation opened.
  const recovered = await runScheduledJob(job, {
    stateDir,
    now: new Date("2026-09-14T08:07:00.000Z"),
    probeRunner: async ({ resultPath }) => {
      writeFileSync(resultPath, JSON.stringify({ status: "healthy", pages_listed: 8, pages_visited: 8, observations_emitted: 24, unmarked_beacons: 0, failures: [] }));
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(recovered.result.consecutive_failures, 0);
  assert.equal(recovered.issue.mode, "close");
});

test("an unmarked beacon is a probe fault, because it would land in the resident group", async () => {
  const stateDir = scratch();
  const output = await runScheduledJob(job, {
    stateDir,
    now: new Date("2026-09-14T02:07:00.000Z"),
    probeRunner: async ({ resultPath }) => {
      writeFileSync(resultPath, JSON.stringify({
        status: "failed",
        pages_listed: 8,
        pages_visited: 8,
        observations_emitted: 0,
        unmarked_beacons: 2,
        failures: [],
        traffic_class: "synthetic",
      }));
      return { code: 1, stdout: "", stderr: "" };
    },
  });
  assert.equal(output.result.status, "degraded");
  assert.equal(output.result.unmarked_beacons, 2);
  assert.match(output.result.body, /retained as resident traffic/);
});

test("escalation and the reported body are decided by named, testable rules", () => {
  assert.equal(noticeSyntheticProbeIssueMode(0, 0), "none");
  assert.equal(noticeSyntheticProbeIssueMode(1, 0), "none");
  assert.equal(noticeSyntheticProbeIssueMode(NOTICE_SYNTHETIC_PROBE_ESCALATION, 2), "open");
  assert.equal(noticeSyntheticProbeIssueMode(0, NOTICE_SYNTHETIC_PROBE_ESCALATION), "close");
  assert.equal(noticeSyntheticProbeIssueMode(0, 1), "none");
  assert.match(noticeSyntheticProbeBody(null, 3), /did not produce a result for 3 consecutive slot/);
  assert.match(
    noticeSyntheticProbeBody({ status: "degraded", pages_listed: 8, pages_visited: 6, observations_emitted: 18, traffic_class: "synthetic", failures: [{ path: "/notices/1/", reason: "page_unreachable", http_status: 404 }] }, 1),
    /Unreachable: \/notices\/1\/ \(page_unreachable 404\)/,
  );
});
