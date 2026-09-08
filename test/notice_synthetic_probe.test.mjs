// The scheduled synthetic probe: its committed page list, its rendered job
// definition, its command, and what it is allowed to escalate.
//
// The probe exists because the Notice surface does not retain enough resident
// observations to answer a readiness question inside a review cycle. It is a
// second, labelled measurement group — so these cases hold it to being visibly
// synthetic end to end, bounded in what it costs, and quiet unless the probe
// itself is broken.
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import {
  NOTICE_SYNTHETIC_PROBE_ESCALATION,
  NOTICE_SYNTHETIC_PROBE_PAGES,
  NOTICE_SYNTHETIC_PROBE_RUNTIME_MISSING,
  NOTICE_SYNTHETIC_PROBE_RUNTIME_PYTHON,
  NOTICE_SYNTHETIC_PROBE_SETUP_COMMAND,
  noticeSyntheticProbeBody,
  noticeSyntheticProbeIssueMode,
  noticeSyntheticProbePython,
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

// --- The runtime the probe drives a browser with -----------------------------
//
// The first scheduled slot failed on `from playwright.sync_api import
// sync_playwright`. launchd hands the cycle the system default PATH and no
// login shell, so a bare `python3` there was the operating system's own
// interpreter, which carries no Playwright and no browser. The probe exited
// before it could measure anything and the slot looked like any other failed
// slot. These cases hold the runtime to being the checkout's own, pinned, and
// unmistakable in the log when it is absent.

const ROOT_DIR = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
const RUNTIME_REQUIREMENTS = join(ROOT_DIR, "ops/notice-probe/requirements.txt");
const SETUP_SCRIPT = join(ROOT_DIR, NOTICE_SYNTHETIC_PROBE_SETUP_COMMAND);
const INSTALLER = join(ROOT_DIR, "tools/install_external_schedule_launchd.sh");
const PLIST_TEMPLATE = "ops/launchd/com.cityscroll.external-schedules.plist.template";

test("the scheduler resolves the probe interpreter absolutely instead of searching a PATH", () => {
  const resolved = noticeSyntheticProbePython({});
  assert.equal(resolved.path, join(ROOT_DIR, NOTICE_SYNTHETIC_PROBE_RUNTIME_PYTHON));
  assert.equal(resolved.managed, true);
  // The environment the runtime lives in is inside the checkout, so it is
  // rebuilt from the repository and removed by deleting a directory.
  assert.match(NOTICE_SYNTHETIC_PROBE_RUNTIME_PYTHON, /^ops\/notice-probe\/\.venv\//);
  assert.equal(/^python3?$/.test(NOTICE_SYNTHETIC_PROBE_RUNTIME_PYTHON), false, "the probe interpreter is a bare name");

  // A rehearsal against another environment is still possible, and is taken
  // verbatim rather than merged with the managed path.
  const overridden = noticeSyntheticProbePython({ CROL_NOTICE_SYNTHETIC_PROBE_PYTHON: "/elsewhere/bin/python3" });
  assert.deepEqual(overridden, { path: "/elsewhere/bin/python3", managed: false });
});

test("the runtime is pinned exactly and shares the browser gate's Playwright version", () => {
  const requirements = readFileSync(RUNTIME_REQUIREMENTS, "utf8");
  const pins = requirements.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  assert.ok(pins.length >= 1, "the runtime pins nothing");
  for (const pin of pins) {
    assert.match(pin, /^[A-Za-z0-9_.-]+==[0-9][^\s]*$/, `${pin} is not an exact pin`);
  }
  // The transitive distributions are pinned too, because the setup script
  // installs with --no-deps: a resolver free to choose is a measurement whose
  // browser build nobody wrote down.
  const setup = readFileSync(SETUP_SCRIPT, "utf8");
  assert.match(setup, /--no-deps/);
  assert.ok(pins.length >= 2, "only the top-level distribution is pinned while --no-deps is used");

  // One Playwright version across the repository: the scheduled measurement
  // and the browser gate exercise the same Chromium build.
  const gate = readFileSync(join(ROOT_DIR, ".github/actions/setup-playwright/requirements.txt"), "utf8");
  const gatePin = gate.match(/^playwright==\S+$/m);
  const runtimePin = requirements.match(/^playwright==\S+$/m);
  assert.ok(gatePin && runtimePin, "one of the two Playwright pins is missing");
  assert.equal(runtimePin[0], gatePin[0], "the probe runtime and the browser gate pin different Playwright versions");
});

test("the browser is installed inside the checkout rather than into a shared cache", () => {
  const setup = readFileSync(SETUP_SCRIPT, "utf8");
  assert.match(setup, /PLAYWRIGHT_BROWSERS_PATH="\$browsers_dir"/);
  assert.match(setup, /browsers_dir="\$runtime_dir\/browsers"/);
  // Nothing may reach a global or user-site interpreter: an install that
  // escapes the checkout cannot be undone by removing the checkout's runtime.
  assert.equal(/pip install[^\n]*--user/.test(setup), false, "the setup script installs outside the environment");
  assert.equal(/ms-playwright/.test(setup), false, "the setup script names the shared browser cache");

  const ignored = readFileSync(join(ROOT_DIR, ".gitignore"), "utf8");
  for (const path of ["ops/notice-probe/.venv/", "ops/notice-probe/browsers/", "ops/notice-probe/runtime-receipt.json"]) {
    assert.ok(ignored.includes(path), `${path} is host state and is not ignored`);
  }
});

test("an absent runtime is reported by its own name and never mistaken for a measurement", async () => {
  const stateDir = scratch();
  const previous = process.env.CROL_NOTICE_SYNTHETIC_PROBE_PYTHON;
  process.env.CROL_NOTICE_SYNTHETIC_PROBE_PYTHON = join(scratch(), "no-such-runtime/bin/python3");
  let output;
  try {
    output = await runScheduledJob(job, { stateDir, now: new Date("2026-09-14T02:07:00.000Z") });
  } finally {
    if (previous === undefined) delete process.env.CROL_NOTICE_SYNTHETIC_PROBE_PYTHON;
    else process.env.CROL_NOTICE_SYNTHETIC_PROBE_PYTHON = previous;
  }

  // The slot log is where an operator reads this, so the named error has to be
  // in the file rather than only in a return value.
  const log = readFileSync(join(stateDir, "jobs", job.id, "2026-09-14T02-07.log"), "utf8");
  assert.match(log, /probe runtime not set up: run tools\/setup_notice_probe_runtime\.sh/);
  assert.match(log, /no interpreter at/);
  assert.equal(NOTICE_SYNTHETIC_PROBE_RUNTIME_MISSING, `probe runtime not set up: run ${NOTICE_SYNTHETIC_PROBE_SETUP_COMMAND}`);
  assert.equal(output.result.status, "degraded");
  assert.equal(output.result.consecutive_failures, 1);
  // One bad slot still escalates nothing; the setup fault is legible from the
  // first slot without an issue being filed for it.
  assert.equal(output.issue.mode, "none");
});

test("the probe reports the same named error for a runtime with no package and one with no browser", () => {
  const stub = scratch();
  const emptyBrowsers = join(scratch(), "browsers");
  mkdirSync(emptyBrowsers, { recursive: true });

  // A stub package on PYTHONPATH shadows whatever the host happens to have, so
  // both absences are exercised the same way on any machine.
  mkdirSync(join(stub, "playwright"), { recursive: true });
  writeFileSync(join(stub, "playwright", "__init__.py"), "");
  writeFileSync(join(stub, "playwright", "sync_api.py"), 'raise ImportError("stub: no sync_api")\n');
  assert.throws(
    () => execFileSync("python3", [PROBE_SCRIPT, "--check-runtime"], {
      stdio: "pipe",
      env: { ...process.env, PYTHONPATH: stub, PLAYWRIGHT_BROWSERS_PATH: emptyBrowsers },
    }),
    (error) => {
      const stderr = String(error.stderr);
      assert.match(stderr, /probe runtime not set up: run tools\/setup_notice_probe_runtime\.sh/);
      assert.match(stderr, /no Playwright for/);
      return true;
    },
  );

  // The package present with no browser build is the same fault to an
  // operator — the same command repairs it — so it reports the same name.
  writeFileSync(join(stub, "playwright", "sync_api.py"), "def sync_playwright():\n    raise AssertionError('never launched')\n");
  assert.throws(
    () => execFileSync("python3", [PROBE_SCRIPT, "--check-runtime"], {
      stdio: "pipe",
      env: { ...process.env, PYTHONPATH: stub, PLAYWRIGHT_BROWSERS_PATH: emptyBrowsers },
    }),
    (error) => {
      const stderr = String(error.stderr);
      assert.match(stderr, /probe runtime not set up: run tools\/setup_notice_probe_runtime\.sh/);
      assert.match(stderr, /no Chromium build under/);
      return true;
    },
  );
});

test("rendering the job trigger says whether the probe runtime exists yet", () => {
  // Rendered against a throwaway copy of the checkout, so the result does not
  // depend on whether this particular machine has already run setup, and so
  // nothing is written to a real launch-agent directory.
  const fake = scratch();
  mkdirSync(join(fake, "tools"), { recursive: true });
  mkdirSync(join(fake, dirname(PLIST_TEMPLATE)), { recursive: true });
  copyFileSync(INSTALLER, join(fake, "tools/install_external_schedule_launchd.sh"));
  copyFileSync(join(ROOT_DIR, PLIST_TEMPLATE), join(fake, PLIST_TEMPLATE));

  const home = join(scratch(), "home");
  mkdirSync(home, { recursive: true });
  const rendered = execFileSync("bash", [join(fake, "tools/install_external_schedule_launchd.sh")], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: home,
      CITYSCROLL_INSTALL_RENDER_ONLY: "1",
      CROL_EXTERNAL_SCHEDULE_STATE_DIR: join(scratch(), "state"),
    },
  });
  assert.match(rendered, /rendered .*com\.cityscroll\.external-schedules\.plist without loading it/);

  // The trigger renders fine with no runtime present. That is exactly why the
  // installer has to say so: configuring the schedule is not installing the
  // browser the probe drives.
  const plist = readFileSync(join(home, "Library/LaunchAgents/com.cityscroll.external-schedules.plist"), "utf8");
  assert.match(plist, /external_schedule_runner\.mjs/);
  assert.equal(/__[A-Z_]+__/.test(plist), false, "the rendered trigger still carries a placeholder");
  const installer = readFileSync(INSTALLER, "utf8");
  assert.match(installer, /probe runtime not set up/);
  assert.match(installer, /tools\/setup_notice_probe_runtime\.sh/);
});
