#!/usr/bin/env node

import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  createGitHubClient,
  persistScheduleResult,
  replayOutbox,
} from "./external_schedule_outbox.mjs";
import { loadSourceContracts } from "./source_contracts.mjs";
import {
  buildSourceHealthObservations,
  loadSourceHealthInputs,
} from "./source_health_observations.mjs";
import {
  evaluatePublicationCycle,
  independentWatchdogFinding,
  loadPublicationCycleContract,
} from "./desk_health_publication_cycle.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const JOBS_PATH = join(ROOT, "tools", "external_schedule_jobs.json");

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function runKey(now = new Date()) {
  return now.toISOString().slice(0, 16).replace(/:/g, "-");
}

async function runProcess(command, args, options = {}) {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, { cwd: options.cwd, env: { ...process.env, ...(options.env || {}) } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code, signal) => resolveResult({ code: code ?? 1, signal, stdout, stderr }));
  });
}

function issueBody(result, marker) {
  return `${result.body || "The independent correctness monitor reported a failure."}\n\nObserved at: ${result.observed_at}\n${marker}`;
}

function issueIntent(job, run, result, mode, extra = {}) {
  const issue = {
    mode,
    title: extra.title || job.issue_title,
    title_aliases: extra.title_aliases || [],
    body_contains: extra.body_contains || [],
    body: issueBody(result, ""),
  };
  return issue;
}

async function runActionLinks(job, context) {
  const dir = join(context.stateDir, "jobs", job.id);
  await mkdir(dir, { recursive: true });
  const reportPath = join(dir, "action-link-integrity.json");
  const healthPath = join(dir, "action_link_health.json");
  const scriptPath = join(dir, "action_link_health.js");
  const audit = await runProcess(process.execPath, ["tools/audit-action-links.mjs", "--live", "--output", reportPath], { cwd: ROOT });
  await writeFile(join(dir, `${context.runKey}.log`), `${audit.stdout}${audit.stderr}`, "utf8");
  const update = await runProcess(process.execPath, [
    "tools/update-action-link-health.mjs", "--report", reportPath, "--previous", healthPath,
    "--output", healthPath, "--script-output", scriptPath, "--escalation-after", "2",
  ], { cwd: ROOT });
  let health = {};
  try { health = JSON.parse(await readFile(healthPath, "utf8")); } catch {}
  const summary = health.summary || {};
  const observed = new Date().toISOString();
  const result = {
    observed_at: observed,
    status: audit.code === 0 && update.code === 0 ? "healthy" : "degraded",
    command_exit: audit.code,
    summary,
    body: `The action-link audit found ${summary.degraded_patterns?.length || 0} degraded pattern(s).`,
  };
  const mode = summary.newly_escalated_patterns?.length ? "open"
    : summary.recovered_patterns?.length && !(summary.degraded_patterns || []).length ? "close" : "none";
  return { result, issue: issueIntent(job, context.runKey, result, mode) };
}

function sourceFailures(output) {
  return [...output.matchAll(/^error ([a-z0-9-]+): (.+)$/gm)].map((match) => ({ id: match[1], detail: match[2] }));
}

function sourceHealthy(output) {
  return [...output.matchAll(/^ok ([a-z0-9-]+):/gm)].map((match) => match[1]);
}

function classify(detail) {
  if (/stale/i.test(detail)) return "stale";
  if (/fetch failed|HTTP 5\d\d|ENOTFOUND|timed out|DNS/i.test(detail)) return "outage";
  return "schema drift";
}

async function runSourceContracts(job, context) {
  const resultRun = await runProcess(process.execPath, ["tools/verify_source_contracts.mjs", "--live"], { cwd: ROOT });
  const output = `${resultRun.stdout}${resultRun.stderr}`;
  const failures = sourceFailures(output);
  const healthy = sourceHealthy(output);
  const observed = new Date().toISOString();
  const receipts = [
    ...healthy.map((id) => ({
      schema: "cityscroll.source_acquisition_receipt.v1",
      source_contract_id: id,
      observed_at: observed,
      status: "succeeded",
      run_id: `${context.runKey}:${id}`,
      publisher_clock_basis: null,
      publisher_updated_at: null,
      clock_kind: "check",
    })),
    ...failures.map((failure) => ({
      schema: "cityscroll.source_acquisition_receipt.v1",
      source_contract_id: failure.id,
      observed_at: observed,
      status: "failed",
      run_id: `${context.runKey}:${failure.id}`,
      publisher_clock_basis: null,
      publisher_updated_at: null,
      clock_kind: "check",
      exact_error: failure.detail,
    })),
  ];
  const result = {
    observed_at: observed,
    status: resultRun.code === 0 ? "healthy" : "degraded",
    command_exit: resultRun.code,
    failures,
    healthy,
    receipts,
    scheduler_heartbeat: {
      observed_at: observed,
      status: "succeeded",
      run_id: context.runKey,
    },
    body: output.slice(-12000),
  };
  const intents = failures.map((failure) => ({
    result,
    issue: issueIntent(job, context.runKey, { ...result, body: [`Classification: ${classify(failure.detail)}.`, `Source contract: ${failure.id}.`, `Detail: ${failure.detail}`].join("\n") }, "open", {
      title: `Live civic-data source contract drift: ${failure.id}`,
      title_aliases: ["Live civic-data source contract drift"],
      body_contains: [`error ${failure.id}:`],
    }),
  }));
  if (healthy.length) {
    intents.push({
      result,
      issue: {
        mode: "close-recovered",
        title_prefix: job.issue_title_prefix,
        title_aliases: ["Live civic-data source contract drift"],
        healthy_ids: healthy,
        body: "Classification: resolved. The source contract is healthy again.",
      },
    });
  }
  return { result, intents };
}

async function runFreshnessWatchdog(job, context) {
  const registry = loadSourceContracts();
  const inputs = loadSourceHealthInputs(ROOT, registry, { externalScheduleStateDir: context.stateDir });
  const projection = buildSourceHealthObservations(registry, { ...inputs, asOf: context.now.toISOString() });
  const stale = projection.observations
    .filter((row) => row.freshness_watchdog?.status === "STALE")
    .map((row) => ({
      source_contract_id: row.source_id,
      observed_at: row.freshness_watchdog.observed_at,
      status: "failed",
      run_id: row.freshness_watchdog.receipts?.[0]?.run_id || null,
      reasons: row.freshness_watchdog.reason_codes,
    }));
  const healthy = stale.length === 0;
  const publicationContract = loadPublicationCycleContract();
  const publicationCycle = evaluatePublicationCycle({
    now: context.now.toISOString(),
    trigger: { installed: true },
    monitor_attempt: { at: context.now.toISOString(), basis: "source-freshness-watchdog" },
    collection: { status: "succeeded", completed_at: projection.generated_at },
    publication: { status: "unknown" },
    isolated: false,
  }, publicationContract);
  const publicationFinding = independentWatchdogFinding(publicationCycle, {
    now: context.now.toISOString(),
    isolated: false,
    observer: publicationContract.installed_trigger.independent_watchdog,
  });
  const result = {
    observed_at: context.now.toISOString(),
    status: healthy && publicationFinding.ok ? "healthy" : "degraded",
    stale_sources: stale,
    publication_cycle: {
      failing_stage: publicationFinding.failing_stage,
      findings: publicationFinding.findings,
    },
    body: [
      healthy
        ? "Source evidence freshness watchdog is current."
        : `Source evidence freshness is STALE for ${stale.length} source contract(s).`,
      publicationFinding.ok
        ? "Desk publication cycle is current."
        : `Desk publication cycle failing_stage=${publicationFinding.failing_stage || "unknown"}: ${publicationFinding.findings.join("; ")}`,
    ].join(" "),
  };
  return {
    result,
    issue: issueIntent(job, context.runKey, result, healthy ? "close" : "open"),
  };
}

function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
  if (typeof value !== "string") return value;
  return value.replace(/([?&](?:token|s)=)[^&\s]+/gi, "$1[redacted]").replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]");
}

async function runDigestShadow(job, context) {
  const url = process.env.CITYSCROLL_DIGEST_SHADOW_URL || "https://api.cityscroll.org/admin/digest-shadow";
  const key = process.env.CITYSCROLL_ADMIN_KEY || process.env.ADMIN_KEY;
  const response = await fetch(url, { headers: key ? { Authorization: `Bearer ${key}` } : {} });
  let report = {};
  try { report = await response.json(); } catch { report = { error: `HTTP ${response.status}` }; }
  const summary = report.summary || report;
  const today = new Date().toISOString().slice(0, 10);
  const healthy = response.ok && summary.run_day === today && summary.status === "READY";
  const redlines = Array.isArray(summary.redlines) ? summary.redlines : [];
  const result = {
    observed_at: new Date().toISOString(),
    status: healthy ? "healthy" : "degraded",
    http_status: response.status,
    summary: sanitize(summary),
    body: healthy ? "The digest shadow rehearsal is READY." : `The digest shadow rehearsal reported ${summary.status || "UNAVAILABLE"}.\n\n${JSON.stringify({ redlines: sanitize(redlines), degraded_receipt: sanitize(report.degraded_receipt || null) }, null, 2).slice(0, 16000)}`,
  };
  return { result, issue: issueIntent(job, context.runKey, result, healthy ? "close" : "open") };
}

export async function runScheduledJob(job, options = {}) {
  const now = options.now || new Date();
  const stateDir = options.stateDir || process.env.CROL_EXTERNAL_SCHEDULE_STATE_DIR || join(ROOT, ".external-schedule-state");
  const context = { now, runKey: options.runKey || runKey(now), stateDir };
  let output;
  if (job.runner === "action-links") output = await runActionLinks(job, context);
  else if (job.runner === "source-contracts") output = await runSourceContracts(job, context);
  else if (job.runner === "source-freshness") output = await runFreshnessWatchdog(job, context);
  else if (job.runner === "digest-shadow") output = await runDigestShadow(job, context);
  else throw new Error(`unknown external schedule runner: ${job.runner}`);
  if (output.intents) {
    for (const [index, intent] of output.intents.entries()) await persistScheduleResult({
      stateDir,
      jobId: job.id,
      runKey: context.runKey,
      eventRunKey: `${context.runKey}-source-${index}`,
      result: intent.result,
      issue: intent.issue,
    });
  } else {
    await persistScheduleResult({ stateDir, jobId: job.id, runKey: context.runKey, result: output.result, issue: output.issue });
  }
  return output;
}

function fieldMatches(value, current) {
  if (value === "*") return true;
  return value.split(",").some((part) => {
    if (part.includes("-")) { const [start, end] = part.split("-").map(Number); return current >= start && current <= end; }
    if (part.includes("/")) { const [base, step] = part.split("/"); return (base === "*" || Number(base) === current) && current % Number(step) === 0; }
    return Number(part) === current;
  });
}

export function cronMatches(expression, date) {
  const [minute, hour, day, month, weekday] = expression.trim().split(/\s+/);
  if (!minute || !weekday) return false;
  return fieldMatches(minute, date.getUTCMinutes()) && fieldMatches(hour, date.getUTCHours())
    && fieldMatches(day, date.getUTCDate()) && fieldMatches(month, date.getUTCMonth() + 1)
    && fieldMatches(weekday, date.getUTCDay());
}

async function loadJobs() { return JSON.parse(await readFile(JOBS_PATH, "utf8")); }

async function pendingOutboxCount(stateDir) {
  try {
    const names = await readdir(join(stateDir, "outbox"));
    let pending = 0;
    for (const name of names.filter((item) => item.endsWith(".json"))) {
      try {
        const event = JSON.parse(await readFile(join(stateDir, "outbox", name), "utf8"));
        if (event.status === "pending") pending++;
      } catch {}
    }
    return pending;
  } catch { return 0; }
}

export const SCHEDULER_WORKFLOW = "com.cityscroll.external-schedules";

function adminKey() {
  const inline = process.env.CITYSCROLL_ADMIN_KEY || process.env.ADMIN_KEY;
  if (inline) return inline;
  // launchd starts an agent with no login shell, so the credential arrives as a
  // mode-0600 file named by the job definition rather than an inherited export.
  const file = process.env.CITYSCROLL_ADMIN_KEY_FILE;
  if (!file) return null;
  try { return readFileSync(file, "utf8").trim() || null; } catch { return null; }
}

/**
 * The source revision the cycle is actually running, so a heartbeat can be
 * matched back to the code that produced it. Recorded as unknown rather than
 * guessed when the checkout cannot answer.
 */
export function sourceRevision(root = ROOT) {
  const env = process.env.CITYSCROLL_SOURCE_REVISION || process.env.GITHUB_SHA;
  if (env && /^[0-9a-f]{7,40}$/i.test(env.trim())) return env.trim().toLowerCase();
  const head = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
  const sha = String(head.stdout || "").trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

export function schedulerRunId(now = new Date(), { host = hostname(), pid = process.pid } = {}) {
  return `${runKey(now)}:${host}:${pid}`;
}

// rel-12: the bounded debug/fix task the cycle runs for one leased repair item.
// The command is operator configuration, never anything a queue record carries —
// an item can describe a failure but can never name something to execute.
export const REPAIR_DISPATCH_TIMEOUT_MS = 10 * 60 * 1000;
export const REPAIR_SUMMARY_LIMIT = 400;
const REPAIR_RESULTS_FILE = "pending-results.json";

export function repairDispatchCommand(env = process.env) {
  const command = String(env.CITYSCROLL_REPAIR_DISPATCH_COMMAND || "").trim();
  return command || null;
}

function repairResultsPath(stateDir) {
  return join(stateDir, "repair", REPAIR_RESULTS_FILE);
}

/**
 * Results outlive the process. A cycle that dies between running a repair and
 * reporting it re-reports on the next heartbeat rather than losing the outcome,
 * and the worker's lease check discards a report whose lease has moved on.
 */
async function readPendingRepairResults(stateDir) {
  try {
    const parsed = JSON.parse(await readFile(repairResultsPath(stateDir), "utf8"));
    return Array.isArray(parsed?.results) ? parsed.results : [];
  } catch { return []; }
}

async function writePendingRepairResults(stateDir, results) {
  const dir = join(stateDir, "repair");
  await mkdir(dir, { recursive: true });
  await writeFile(repairResultsPath(stateDir), `${JSON.stringify({
    schema: "cityscroll.repair-dispatch-pending-results.v1",
    results,
  }, null, 2)}\n`, "utf8");
  return results;
}

export function repairOutcomeFromExit(code, signal) {
  if (signal) return "failed";
  if (code === 0) return "repaired";
  // A dispatcher exits 2 when the fix needs a decision it is not allowed to
  // make — a security-sensitive change, a destructive step, an ambiguous root
  // cause. That is the judgment boundary, not a retry.
  if (code === 2) return "judgment";
  return "failed";
}

/**
 * One leased item, one bounded task. The item arrives on stdin so nothing from
 * the queue can reach a shell, output is capped, and the summary that travels
 * back is prose rather than a log.
 */
export async function runRepairTask(item, options = {}) {
  const command = options.command ?? repairDispatchCommand();
  const timeoutMs = options.timeoutMs || REPAIR_DISPATCH_TIMEOUT_MS;
  if (!command) {
    return {
      signature: item.signature,
      lease_id: item.lease?.lease_id || null,
      outcome: "judgment",
      judgment_reason: "no repair dispatcher is configured for this cycle",
      summary: "The cycle leased this item but has no configured repair dispatcher.",
    };
  }
  const spawnImpl = options.spawnImpl || spawn;
  const child = spawnImpl(command, ["--repair-item"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      CITYSCROLL_REPAIR_SCOPE: String(item.repair_scope || ""),
      CITYSCROLL_REPAIR_SIGNATURE: String(item.signature || ""),
    },
  });
  return new Promise((resolveResult) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch {}
      resolveResult({
        signature: item.signature,
        lease_id: item.lease?.lease_id || null,
        outcome: "failed",
        summary: `The repair task exceeded its ${Math.round(timeoutMs / 1000)}s bound and was stopped.`,
      });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-8000); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8000); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({
        signature: item.signature,
        lease_id: item.lease?.lease_id || null,
        outcome: "failed",
        summary: sanitize(String(error?.message || error)).slice(0, REPAIR_SUMMARY_LIMIT),
      });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const outcome = repairOutcomeFromExit(code, signal);
      const text = sanitize(`${stdout}${stderr}`).replace(/\s+/g, " ").trim();
      resolveResult({
        signature: item.signature,
        lease_id: item.lease?.lease_id || null,
        outcome,
        summary: text.slice(-REPAIR_SUMMARY_LIMIT),
        ...(outcome === "judgment" ? { judgment_reason: text.slice(-REPAIR_SUMMARY_LIMIT) } : {}),
      });
    });
    try {
      child.stdin.end(JSON.stringify(item));
    } catch {
      /* the error handler above reports a dispatcher that never opened stdin */
    }
  });
}

export async function runLeasedRepairTasks(stateDir, items, options = {}) {
  const results = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item?.signature || !item?.lease?.lease_id) continue;
    results.push(await runRepairTask(item, options));
  }
  await writePendingRepairResults(stateDir, results);
  return results;
}

async function persistHeartbeatReceipt(stateDir, receipt) {
  // A local receipt outlives the process, so a restarted or paused scheduler
  // still shows what its last cycle attempted and how the write was answered.
  const dir = join(stateDir, "heartbeat");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "latest.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  await writeFile(join(dir, `${receipt.run_id.replaceAll(":", "_")}.json`), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return receipt;
}

/**
 * Scheduler liveness is a postcondition of the real cycle: this writes the
 * heartbeat, then re-reads it and confirms the stored receipt carries THIS
 * run's identity. The endpoint's overall ok folds in the mail leg, so it is not
 * evidence that the write landed; the round-tripped run_id is.
 */
export async function publishHeartbeat(stateDir, now, dueJobs, options = {}) {
  const { fetchImpl = fetch, cycleResult = "succeeded" } = options;
  const url = process.env.CITYSCROLL_SCHEDULER_HEARTBEAT_URL
    || "https://api.cityscroll.org/admin/reliability/scheduler";
  const runId = options.runId || schedulerRunId(now);
  const revision = options.sourceRevision === undefined ? sourceRevision() : options.sourceRevision;
  const base = {
    schema: "cityscroll.external-scheduler-heartbeat-attempt.v1",
    workflow: SCHEDULER_WORKFLOW,
    run_id: runId,
    source_revision: revision,
    result: cycleResult,
    observed_at: now.toISOString(),
    run_key: runKey(now),
    due_jobs: dueJobs,
  };
  const key = adminKey();
  // An unpublishable heartbeat is a failed cycle, not a quiet one: the runner
  // exits nonzero and leaves the reason behind instead of returning silently.
  if (!url) return persistHeartbeatReceipt(stateDir, { ...base, status: "failed", reason: "heartbeat-url-missing" });
  if (!key) return persistHeartbeatReceipt(stateDir, { ...base, status: "failed", reason: "admin-credential-missing" });
  if (!revision) return persistHeartbeatReceipt(stateDir, { ...base, status: "failed", reason: "source-revision-unresolved" });
  // rel-12: the same heartbeat reports the previous cycle's repair outcomes and
  // asks for the next leases. A cycle with no dispatcher says so, and the queue
  // then declines to lease rather than promising a pickup it cannot make.
  const repairResults = options.repairResults ?? await readPendingRepairResults(stateDir);
  const canDispatch = options.repairDispatch ?? Boolean(repairDispatchCommand());
  const payload = {
    ...base,
    pending_outbox: await pendingOutboxCount(stateDir),
    repair_dispatch: canDispatch,
    repair_results: repairResults,
  };
  delete payload.schema;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  let accepted = null;
  if (response.ok) {
    try { accepted = await response.json(); } catch { accepted = null; }
    // Results are cleared only once the worker has taken them, so a refused or
    // unparseable answer re-reports them next cycle instead of dropping them.
    if (accepted?.ok === true && repairResults.length) await writePendingRepairResults(stateDir, []);
  }
  if (!response.ok) {
    let rejected = null;
    try { rejected = (await response.json())?.rejected || null; } catch {}
    return persistHeartbeatReceipt(stateDir, {
      ...base,
      status: "failed",
      reason: response.status === 400 ? "heartbeat-rejected" : "heartbeat-write-refused",
      http_status: response.status,
      rejected,
    });
  }
  const verification = await fetchImpl(url, { headers: { authorization: `Bearer ${key}` } });
  let snapshot = null;
  try { snapshot = await verification.json(); } catch {}
  const stored = snapshot?.heartbeat || null;
  // The response status folds in the mail leg and the cycle result, so only the
  // round-tripped identity proves this run's write actually landed.
  const verified = Boolean(stored?.run_id === runId && stored?.workflow === SCHEDULER_WORKFLOW);
  return persistHeartbeatReceipt(stateDir, {
    ...base,
    status: verified ? "succeeded" : "failed",
    reason: verified ? null : "heartbeat-not-verified",
    http_status: response.status,
    verification_status: verification.status,
    verified,
    stored_run_id: stored?.run_id || null,
    pending_outbox: payload.pending_outbox,
    repair_dispatch: canDispatch,
    repair_reported: repairResults.length,
    repair_leased: Array.isArray(accepted?.repair_queue?.items) ? accepted.repair_queue.items.length : 0,
    repair_items: Array.isArray(accepted?.repair_queue?.items) ? accepted.repair_queue.items : [],
  });
}

async function main() {
  const jobs = await loadJobs();
  const stateDir = arg("--state-dir") || process.env.CROL_EXTERNAL_SCHEDULE_STATE_DIR || join(ROOT, ".external-schedule-state");
  const github = createGitHubClient({ token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN, owner: "cityscroll", repo: "cityscroll-app", apiBase: process.env.GITHUB_API_URL });
  const replayBefore = await replayOutbox({ stateDir, github });
  const selected = arg("--job");
  const now = new Date();
  const due = selected ? jobs.jobs.filter((job) => job.id === selected) : jobs.jobs.filter((job) => job.schedule.some((expression) => cronMatches(expression, now)));
  const summaries = [];
  for (const job of due) {
    const output = await runScheduledJob(job, { stateDir, now });
    summaries.push({ id: job.id, status: output.result.status });
  }
  const replayAfter = await replayOutbox({ stateDir, github });
  // Scheduler liveness is a postcondition of the real cycle, distinct from every
  // scheduled-job and digest-shadow receipt. A rejected write makes the cycle fail.
  // The cycle result travels with the heartbeat so a degraded run cannot read as
  // healthy liveness, and a healthy digest cannot stand in for a missing write.
  const degraded = summaries.some((summary) => summary.status !== "healthy");
  const heartbeat = await publishHeartbeat(stateDir, new Date(), due.map((job) => job.id), {
    cycleResult: degraded ? "degraded" : "succeeded",
  });
  // Repair runs after liveness is proven, on the leases this cycle was granted.
  // Outcomes are reported on the next heartbeat, so a repair never becomes mail
  // and a crashed cycle re-reports rather than losing the result.
  const repairResults = heartbeat.repair_items?.length
    ? await runLeasedRepairTasks(stateDir, heartbeat.repair_items)
    : [];
  const heartbeatReceipt = { ...heartbeat };
  delete heartbeatReceipt.repair_items;
  process.stdout.write(`${JSON.stringify({
    replayBefore,
    heartbeat: heartbeatReceipt,
    due: summaries,
    replayAfter,
    repair: { dispatched: repairResults.length, outcomes: repairResults.map((row) => row.outcome) },
  }, null, 2)}\n`);
  if (heartbeat.status !== "succeeded" || degraded) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error?.stack || error); process.exitCode = 1; });
