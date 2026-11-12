// The scheduling side of the legal source watch: one job on the existing external
// scheduler, one runner branch, and two declared judgment classes on the repair rail.
// node:test + built-ins only; every fetch is an injected stub, so nothing here touches
// the network. The watch comparison itself is covered by
// test/procurement_legal_change_docket.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runScheduledJob, runLegalSourceWatch } from "../tools/external_schedule_runner.mjs";
import { monitorRepairFindings, REPAIR_FAILURE_CLASSES, parseRepairSignature } from "../tools/repair_findings.mjs";
import { REPAIR_JUDGMENT_CLASSES, selectRepairPlaybook } from "../tools/repair_playbooks.mjs";
import { auditSchedulerOwnership } from "../tools/audit_scheduler_ownership.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const jobsConfig = JSON.parse(readFileSync(join(ROOT, "tools/external_schedule_jobs.json"), "utf8"));
const JOB = jobsConfig.jobs.find((job) => job.id === "legal-source-watch");
const register = JSON.parse(readFileSync(join(ROOT, "ontology/procurement_legal_register.v1.json"), "utf8"));
const targets = JSON.parse(readFileSync(join(ROOT, "ontology/procurement_legal_source_targets.v1.json"), "utf8"));
const SOURCES = join(ROOT, "test/fixtures/procurement_legal_register/sources");

const retained = (file) => readFileSync(join(SOURCES, file), "utf8");

// Scratch dirs are tracked and removed on exit/SIGTERM/SIGINT so a gate's
// leaked-temp snapshot stays clean (mirrors tools/lib/with_temp_dir.mjs).
const TEMP_DIRS = new Set();
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), "cityscroll-legal-source-watch-")); TEMP_DIRS.add(dir); return dir; };
function cleanupTempDirs() {
  for (const dir of [...TEMP_DIRS]) { try { rmSync(dir, { recursive: true, force: true }); TEMP_DIRS.delete(dir); } catch { /* retry on a later signal */ } }
}
process.on("exit", cleanupTempDirs);
process.on("SIGTERM", () => { cleanupTempDirs(); process.exit(143); });
process.on("SIGINT", () => { cleanupTempDirs(); process.exit(130); });

/**
 * Build the three mirror aggregates from the retained sections surrounded by filler.
 * The stored byte offsets in the shipped targets file name the real mirror, not this
 * stub, so the runner exercises its capped full-stream fallback and still finds every
 * section — which is exactly the network-independent path a test should take.
 */
function filler(label, count = 40) {
  return Array.from({ length: count }, (_, i) => `## § ${i + 1}-99 ${label} filler ${i}.\n\n**Citation:** x\n\nfiller body ${"y".repeat(120)}\n\n---\n`).join("\n");
}
function buildAggregates() {
  const make = (head, files) => {
    const parts = [`${head}\n\n---\n`, filler(head, 200)];
    for (const file of files) parts.push(retained(file), filler(`after-${file}`, 3));
    return Buffer.from(parts.join("\n"));
  };
  return {
    "markdown/admin_code.md": make("# Admin", ["admin-code-6-129.md"]),
    "markdown/charter.md": make("# Charter", ["charter-311.md"]),
    "markdown/rules.md": make("# Rules", ["ppb-1-01.md", "ppb-1-02.md", "ppb-3-04.md", "ppb-3-08.md", "ppb-3-16.md"]),
  };
}
function makeStub(aggregates, { etag = "e1", behaviour = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET" });
    const parsed = new URL(url);
    const key = parsed.pathname.split("/data/index/")[1];
    const hook = behaviour[key];
    if (hook) { const override = await hook({ url, init }); if (override) return override; }
    const body = aggregates[key];
    if (!body) return new Response("nope", { status: 404 });
    const headers = { etag: `"${etag}-${key}"`, "content-length": String(body.length) };
    if (init.method === "HEAD") return new Response(null, { status: 200, headers });
    const range = init.headers?.Range?.match(/^bytes=(\d+)-(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Math.min(Number(range[2]), body.length - 1);
      const slice = body.subarray(start, end + 1);
      return new Response(slice, { status: 206, headers: { ...headers, "content-length": String(slice.length) } });
    }
    return new Response(body, { status: 200, headers });
  };
  return { fetchImpl, calls };
}

const run = (fetchImpl, { now = new Date("2026-11-12T12:17:00Z") } = {}) => runScheduledJob(JOB, { stateDir: tempDir(), now, fetchImpl });

/* ---------------------------------------------------------------- registration */

test("the job is registered on the existing scheduler with a free daily slot and no new infrastructure", () => {
  assert.ok(JOB, "legal-source-watch is in tools/external_schedule_jobs.json");
  assert.equal(JOB.runner, "legal-source-watch");
  assert.deepEqual(JOB.schedule, ["17 12 * * *"]);
  assert.equal(JOB.issue_title_prefix, "Procurement legal source");
  assert.equal(jobsConfig.scheduler.ownership, "independent");
  // the chosen minute collides with no other job
  const slots = jobsConfig.jobs.flatMap((job) => job.schedule);
  assert.equal(slots.filter((slot) => slot === "17 12 * * *").length, 1);
});

test("the scheduler ownership audit still passes with the new job", async () => {
  const audit = await auditSchedulerOwnership(ROOT);
  assert.equal(audit.ok, true, JSON.stringify(audit.errors));
});

test("both failure classes are declared judgment classes with no playbook", () => {
  for (const name of ["legal-source-changed", "legal-source-unreachable"]) {
    assert.ok(REPAIR_FAILURE_CLASSES.includes(name), `${name} is a known failure class`);
    assert.ok(Object.prototype.hasOwnProperty.call(REPAIR_JUDGMENT_CLASSES, name), `${name} is declared judgment`);
    const selected = selectRepairPlaybook(`monitor:legal-source-watch:${name}:ppb-3-08.md`);
    assert.equal(selected.playbook, null, `${name} has no playbook`);
    assert.match(selected.reason, /deliberately left to a person/, `${name} is routed to judgment`);
  }
});

/* ---------------------------------------------------------------- clean run */

test("a clean run is healthy, opens nothing, and emits closing intents the issue loop can retire", async () => {
  const output = await run(makeStub(buildAggregates()).fetchImpl);
  assert.equal(output.result.status, "healthy");
  assert.equal(output.result.changes_found, false);
  assert.equal(output.result.could_not_check, false);
  assert.deepEqual(output.result.summary, { unchanged: 7, changed: 0, fetch_failed: 0, not_checked: 0 });
  assert.ok(!output.intents.some((intent) => intent.issue.mode === "open"), "a clean run opens no issue");
  assert.ok(output.intents.some((intent) => intent.issue.mode === "close" && intent.issue.title === "Procurement legal sources could not be checked"));
  const findings = monitorRepairFindings(JOB, output);
  assert.deepEqual(findings.findings, [], "a clean run raises no repair finding");
});

/* ---------------------------------------------------------------- a changed source */

test("a changed source opens its own issue and raises a legal-source-changed judgment finding", async () => {
  const aggregates = buildAggregates();
  const rules = aggregates["markdown/rules.md"].toString("utf8").replace("small purchases", "small purchasez");
  assert.notEqual(rules, aggregates["markdown/rules.md"].toString("utf8"), "the mutation changed the rules aggregate");
  aggregates["markdown/rules.md"] = Buffer.from(rules);
  const output = await run(makeStub(aggregates, { etag: "e2" }).fetchImpl);

  assert.equal(output.result.status, "degraded");
  assert.equal(output.result.changes_found, true);
  const changed = output.result.changed_sources.map((row) => row.source_file);
  assert.ok(changed.includes("ppb-3-08.md"), JSON.stringify(changed));
  const opened = output.intents.find((intent) => intent.issue.mode === "open" && intent.issue.title === "Procurement legal source changed: ppb-3-08.md");
  assert.ok(opened, "the changed source opens a titled issue");
  assert.match(opened.issue.body, /not legal advice/i);

  const findings = monitorRepairFindings(JOB, output);
  const finding = findings.findings.find((row) => parseRepairSignature(row.signature)?.failure_class === "legal-source-changed");
  assert.ok(finding, "a legal-source-changed finding is raised");
  assert.equal(parseRepairSignature(finding.signature).monitor, "legal-source-watch");
});

/* ---------------------------------------------------------------- an unreachable source */

test("an unreachable source opens the could-not-be-checked issue and raises a legal-source-unreachable finding", async () => {
  const stub = makeStub(buildAggregates(), {
    behaviour: { "markdown/charter.md": async () => new Response("down", { status: 503 }) },
  });
  const output = await run(stub.fetchImpl);

  assert.equal(output.result.status, "degraded");
  assert.equal(output.result.could_not_check, true);
  const unreachable = output.result.unreachable_sources.map((row) => row.source_file);
  assert.ok(unreachable.includes("charter-311.md"), JSON.stringify(unreachable));
  const opened = output.intents.find((intent) => intent.issue.mode === "open" && intent.issue.title === "Procurement legal sources could not be checked");
  assert.ok(opened, "the unreachable source opens the could-not-be-checked issue");
  assert.match(opened.issue.body, /never reported as all-clear/i);

  const findings = monitorRepairFindings(JOB, output);
  const finding = findings.findings.find((row) => parseRepairSignature(row.signature)?.failure_class === "legal-source-unreachable");
  assert.ok(finding, "a legal-source-unreachable finding is raised");
});

/* ---------------------------------------------------------------- the register is never written */

test("the run leaves the register byte-identical", async () => {
  const before = readFileSync(join(ROOT, "ontology/procurement_legal_register.v1.json"), "utf8");
  await runLegalSourceWatch({ ...JOB }, { stateDir: tempDir(), now: new Date("2026-11-12T12:17:00Z"), fetchImpl: makeStub(buildAggregates()).fetchImpl });
  assert.equal(readFileSync(join(ROOT, "ontology/procurement_legal_register.v1.json"), "utf8"), before);
  assert.ok(register.schema, "register loaded");
  assert.ok(targets.targets.length === 7, "targets cover the seven sources");
});
