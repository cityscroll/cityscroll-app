#!/usr/bin/env node

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  createGitHubClient,
  persistScheduleResult,
  replayOutbox,
} from "./external_schedule_outbox.mjs";

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
  const result = { observed_at: observed, status: resultRun.code === 0 ? "healthy" : "degraded", command_exit: resultRun.code, failures, healthy, body: output.slice(-12000) };
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

async function main() {
  const jobs = await loadJobs();
  const stateDir = arg("--state-dir") || process.env.CROL_EXTERNAL_SCHEDULE_STATE_DIR || join(ROOT, ".external-schedule-state");
  const github = createGitHubClient({ token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN, owner: "cityscroll", repo: "crol-list", apiBase: process.env.GITHUB_API_URL });
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
  process.stdout.write(`${JSON.stringify({ replayBefore, due: summaries, replayAfter }, null, 2)}\n`);
  if (summaries.some((summary) => summary.status !== "healthy")) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error?.stack || error); process.exitCode = 1; });
