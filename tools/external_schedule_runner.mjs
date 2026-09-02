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
  const result = {
    observed_at: context.now.toISOString(),
    status: healthy ? "healthy" : "degraded",
    stale_sources: stale,
    body: healthy
      ? "Source evidence freshness watchdog is current."
      : `Source evidence freshness is STALE for ${stale.length} source contract(s).`,
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
  const payload = { ...base, pending_outbox: await pendingOutboxCount(stateDir) };
  delete payload.schema;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
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
  process.stdout.write(`${JSON.stringify({ replayBefore, heartbeat, due: summaries, replayAfter }, null, 2)}\n`);
  if (heartbeat.status !== "succeeded" || degraded) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error?.stack || error); process.exitCode = 1; });
