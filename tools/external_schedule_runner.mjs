#!/usr/bin/env node

import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  createGitHubClient,
  persistScheduleResult,
  replayOutbox,
} from "./external_schedule_outbox.mjs";
import {
  CREDENTIAL_FAILURES,
  credentialFailureLine,
  resolveCredential,
  resolveCredentialSource,
} from "./lib/credential_files.mjs";
import {
  GITHUB_APP_FILE_VARS,
  appCredentialFailureLine,
  createInstallationTokenSource,
  resolveGitHubAppCredential,
} from "./github_app_identity.mjs";
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
import {
  mergeRepairFindings,
  missedSlotFindings,
  monitorRepairFindings,
} from "./repair_findings.mjs";
import {
  STATS_PUBLICATION_ISSUE_MARKER,
  STATS_PUBLICATION_ISSUE_TITLE,
  evaluateStatsPublication,
  statsPublicationIssueBody,
} from "./stats_publication_monitor.mjs";

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

/**
 * The live verifier prints a machine-readable companion line for every
 * freshness error. It carries both clocks — the publisher's own updated stamp
 * and the vintage our retained snapshot states — so the issue this job opens
 * says which side is stale instead of leaving a bare day count to guess at.
 */
export function sourceFindings(output) {
  const findings = new Map();
  for (const match of output.matchAll(/^finding (\{.*\})$/gm)) {
    try {
      const finding = JSON.parse(match[1]);
      if (finding?.source_contract_id) findings.set(finding.source_contract_id, finding);
    } catch { /* a malformed companion line never hides the error it accompanies */ }
  }
  return findings;
}

function clockLines(finding) {
  if (!finding) return [];
  const side = {
    publisher: "Stale side: the publisher. Our retained snapshot is at or after the publisher clock.",
    acquisition: "Stale side: our acquisition. The publisher has published past our retained snapshot.",
    unknown: "Stale side: undetermined. This source declares no retained vintage to compare.",
  }[finding.stale_side] || "Stale side: undetermined.";
  return [
    "",
    `Publisher clock (${finding.publisher_clock_basis}): ${finding.publisher_updated_at || "unknown"} (${finding.publisher_age_days} days; limit ${finding.limit_days}).`,
    `Our retained vintage: ${finding.retained_vintage_at || "not declared"}`
      + `${finding.retained_vintage_artifact ? ` (${finding.retained_vintage_artifact} ${finding.retained_vintage_field})` : ""}.`,
    side,
  ];
}

function classify(detail) {
  if (/stale/i.test(detail)) return "stale";
  if (/fetch failed|HTTP 5\d\d|ENOTFOUND|timed out|DNS/i.test(detail)) return "outage";
  return "schema drift";
}

/** The issue text one drifted source contract opens, naming both clocks. */
export function sourceContractIssueBody(failure, finding) {
  return [
    `Classification: ${classify(failure.detail)}.`,
    `Source contract: ${failure.id}.`,
    `Detail: ${failure.detail}`,
    ...clockLines(finding),
  ].join("\n");
}

async function runSourceContracts(job, context) {
  const resultRun = await runProcess(process.execPath, ["tools/verify_source_contracts.mjs", "--live"], { cwd: ROOT });
  const output = `${resultRun.stdout}${resultRun.stderr}`;
  const failures = sourceFailures(output);
  const healthy = sourceHealthy(output);
  const findings = sourceFindings(output);
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
      publisher_clock_basis: findings.get(failure.id)?.publisher_clock_basis ?? null,
      publisher_updated_at: findings.get(failure.id)?.publisher_updated_at ?? null,
      retained_vintage_at: findings.get(failure.id)?.retained_vintage_at ?? null,
      stale_side: findings.get(failure.id)?.stale_side ?? null,
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
    issue: issueIntent(job, context.runKey, {
      ...result,
      body: sourceContractIssueBody(failure, findings.get(failure.id)),
    }, "open", {
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
  const fetchImpl = context.fetchImpl || globalThis.fetch;
  // The scheduler runs under a launch agent with no login shell, so the admin
  // credential usually arrives as a mode-0600 file rather than an inherited
  // export. Resolving it the same way every other scheduler call does keeps an
  // unauthenticated probe from reporting the upstream service as unavailable.
  const key = adminKey();
  if (!key) {
    const result = {
      observed_at: context.now.toISOString(),
      status: "degraded",
      http_status: null,
      degraded_reason: "admin-credential-missing",
      summary: {},
      body: "The digest shadow probe has no admin credential, so the rehearsal was not contacted. This is a scheduler configuration fault, not an upstream failure.",
    };
    return { result, issue: issueIntent(job, context.runKey, result, "open", { title: "Digest shadow probe has no admin credential" }) };
  }
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${key}` } });
  let report = {};
  let parseFailure = null;
  try { report = await response.json(); } catch (error) { parseFailure = String(error?.message || error); report = {}; }
  const summary = report.summary || (report.status ? report : {});
  const today = context.now.toISOString().slice(0, 10);
  const observed = summary.status || null;
  const healthy = response.ok && summary.run_day === today && observed === DIGEST_SHADOW_READY_STATUS;
  const upstream = observed === DIGEST_SHADOW_DEGRADED_UPSTREAM_STATUS && summary.run_day === today;
  const redlines = Array.isArray(summary.redlines) ? summary.redlines : [];
  const incidents = Array.isArray(summary.upstream_incidents) ? summary.upstream_incidents : [];
  // A run that never produced a summary used to be reported as the bare word UNAVAILABLE, which
  // says only that the probe learned nothing. The route already states why in its own response;
  // that reason is carried through instead of being dropped on the floor.
  const unreachable = digestShadowUnreachableReason({ response, report, summary, parseFailure, today });
  const degradedReason = healthy
    ? null
    : upstream
      ? "upstream-source-unavailable"
      : unreachable
        ? unreachable.reason
        : response.status === 401 || response.status === 403
          ? "admin-credential-rejected"
          : "rehearsal-not-ready";
  const result = {
    observed_at: context.now.toISOString(),
    status: healthy ? "healthy" : "degraded",
    http_status: response.status,
    degraded_reason: degradedReason,
    // Whether the finding is about the digest we build or about a source that did not answer.
    // The two need different repairs and only one of them is ours to make.
    fault_domain: healthy ? null : upstream ? "upstream_source" : unreachable ? "rehearsal_reachability" : "digest_build",
    summary: sanitize(summary),
    body: digestShadowIssueBody({ healthy, upstream, unreachable, observed, redlines, incidents, report }),
  };
  // Two findings, kept apart on purpose, because they have different owners. One is about the
  // digest this monitor exists to judge; the other is about a source it reads. A run that cannot
  // reach the rehearsal at all makes no claim about the source either way.
  const digestFinding = {
    ...result,
    body: upstream
      ? "The digest shadow rehearsal found no fault in the digest. This finding is closed; the source that did not answer is reported separately."
      : result.body,
  };
  const intents = [{
    result: digestFinding,
    issue: issueIntent(job, context.runKey, digestFinding, healthy || upstream ? "close" : "open"),
  }];
  if (upstream) {
    intents.push({
      result,
      issue: issueIntent(job, context.runKey, result, "open", { title: DIGEST_SHADOW_UPSTREAM_ISSUE_TITLE }),
    });
  } else if (!unreachable) {
    const clearedSource = {
      ...result,
      body: "Every source the digest shadow rehearsal reads answered on this run.",
    };
    intents.push({
      result: clearedSource,
      issue: issueIntent(job, context.runKey, clearedSource, "close", { title: DIGEST_SHADOW_UPSTREAM_ISSUE_TITLE }),
    });
  }
  return { result, intents };
}

const DIGEST_SHADOW_READY_STATUS = "READY";
const DIGEST_SHADOW_DEGRADED_UPSTREAM_STATUS = "DEGRADED_UPSTREAM";
const DIGEST_SHADOW_UPSTREAM_ISSUE_TITLE = "Digest shadow source is unavailable";

/**
 * Why the probe holds no rehearsal to judge. Reachability failures are a class of their own:
 * nothing is known about the digest, so nothing may be said about it.
 */
function digestShadowUnreachableReason({ response, report, summary, parseFailure, today }) {
  if (parseFailure) return { reason: "rehearsal-response-unreadable", detail: `the response body did not parse: ${parseFailure}` };
  if (report?.error === "not-run") return { reason: "rehearsal-not-run", detail: `no rehearsal is stored for ${today}` };
  if (report?.error === "no-store") return { reason: "rehearsal-store-unavailable", detail: "the rehearsal store was not reachable" };
  if (report?.error === "shadow-read-failed") return { reason: "rehearsal-read-failed", detail: `the stored rehearsal could not be read: ${report.detail || "no detail given"}` };
  if (report?.error) return { reason: "rehearsal-error", detail: `the rehearsal route answered ${JSON.stringify(report.error)}` };
  if (!summary?.status) return { reason: "rehearsal-summary-absent", detail: `HTTP ${response.status} carried no rehearsal summary` };
  if (summary.run_day !== today) return { reason: "rehearsal-stale", detail: `the newest stored rehearsal is for ${summary.run_day || "an unknown day"}, not ${today}` };
  return null;
}

function digestShadowIssueBody({ healthy, upstream, unreachable, observed, redlines, incidents, report }) {
  if (healthy) return "The digest shadow rehearsal is READY.";
  if (unreachable) {
    return `The digest shadow rehearsal could not be read: ${unreachable.detail}. Nothing is claimed about the digest itself.\n\n${JSON.stringify({ reason: unreachable.reason, route_error: sanitize(report?.error || null), detail: sanitize(report?.detail || null) }, null, 2)}`;
  }
  if (upstream) {
    return `The digest shadow rehearsal found no fault in the digest; a source it reads did not answer.\n\n${JSON.stringify({ upstream_incidents: sanitize(incidents) }, null, 2).slice(0, 16000)}`;
  }
  return `The digest shadow rehearsal reported ${observed || "an unnamed status"}.\n\n${JSON.stringify({ redlines: sanitize(redlines), upstream_incidents: sanitize(incidents), degraded_receipt: sanitize(report?.degraded_receipt || null) }, null, 2).slice(0, 16000)}`;
}

/**
 * Observe whether the promised daily search-use snapshot exists, and report it.
 *
 * Two reads, deliberately from two sides. The public summary is read without a credential and
 * supplies only what the publisher claims about its own freshness; the dated series is read
 * from the authenticated desk and supplies what was actually stored. The evaluator then uses
 * the second to judge the first, which is what makes this independent of a publisher that has
 * frozen while still reporting success.
 *
 * The admin credential is resolved exactly the way every other call in this cycle resolves it.
 * A missing one is a scheduler configuration fault and is reported as such, never as a failed
 * publication.
 */
async function runStatsDailySnapshot(job, context) {
  const fetchImpl = context.fetchImpl || globalThis.fetch;
  const publicUrl = process.env.CITYSCROLL_STATS_URL || "https://api.cityscroll.org/stats";
  const adminUrl = process.env.CITYSCROLL_ADMIN_STATS_URL || "https://api.cityscroll.org/admin/stats";
  const observedAt = context.now.toISOString();

  const key = adminKey();
  if (!key) {
    const result = {
      observed_at: observedAt,
      status: "degraded",
      degraded_reason: "admin-credential-missing",
      body: "The daily search-use snapshot monitor has no admin credential, so the stored aggregate series was not read. This is a scheduler configuration fault, not a publication failure.",
    };
    return {
      result,
      issue: issueIntent(job, context.runKey, result, "open", {
        title: "Daily search-use snapshot monitor has no admin credential",
      }),
    };
  }

  const observation = { published: null, lineage: null };
  try {
    const response = await fetchImpl(publicUrl);
    const body = response.ok ? await response.json() : null;
    observation.published = body?.search_usage || null;
  } catch {
    observation.published = null;
  }
  try {
    const response = await fetchImpl(adminUrl, { headers: { Authorization: `Bearer ${key}` } });
    const body = response.ok ? await response.json() : null;
    const lineage = body?.search_usage_lineage || null;
    observation.lineage = lineage?.series
      ? { ...lineage.series, reconciliation: lineage.reconciliation || null }
      : null;
  } catch {
    observation.lineage = null;
  }

  const finding = evaluateStatsPublication({ now: observedAt, observation });
  const result = {
    observed_at: observedAt,
    status: finding.ok ? "healthy" : "degraded",
    failing_stage: finding.failing_stage,
    promised_day: finding.promised_day,
    evidence: sanitize(finding.evidence),
    body: statsPublicationIssueBody(finding),
  };
  return {
    result,
    issue: issueIntent(job, context.runKey, result, finding.ok ? "close" : "open", {
      title: STATS_PUBLICATION_ISSUE_TITLE,
      title_aliases: [STATS_PUBLICATION_ISSUE_TITLE],
      body_contains: [STATS_PUBLICATION_ISSUE_MARKER],
    }),
  };
}

/**
 * Run one slot of the scheduled Notice synthetic probe and report on the probe.
 *
 * The probe measures the deployed surface under a fixed device and network
 * profile on a committed page list; its observations are marked synthetic and
 * are read back as their own group. This runner therefore judges the probe, not
 * the surface: a slow page is the measurement, so only a probe that reached
 * nothing, emitted an unmarked observation, or could not start is a fault.
 *
 * One bad slot is not a fault either. Consecutive failed slots are counted in
 * the job's own state, and an issue is filed only once the probe has failed
 * NOTICE_SYNTHETIC_PROBE_ESCALATION times in a row.
 */
export const NOTICE_SYNTHETIC_PROBE_ESCALATION = 3;
export const NOTICE_SYNTHETIC_PROBE_PAGES = "data/performance/notice-synthetic-probe-pages.json";
const NOTICE_SYNTHETIC_PROBE_SCRIPT = "tools/run_notice_synthetic_probe.py";

export function noticeSyntheticProbeIssueMode(consecutiveFailures, previousConsecutiveFailures) {
  if (consecutiveFailures >= NOTICE_SYNTHETIC_PROBE_ESCALATION) return "open";
  if (consecutiveFailures === 0 && previousConsecutiveFailures >= NOTICE_SYNTHETIC_PROBE_ESCALATION) return "close";
  return "none";
}

export function noticeSyntheticProbeBody(report, consecutiveFailures) {
  if (!report) {
    return `The Notice synthetic probe did not produce a result for ${consecutiveFailures} consecutive slot(s). No synthetic observation was retained for those slots.`;
  }
  const lines = [
    `Notice synthetic probe: ${report.status}.`,
    `Pages listed ${report.pages_listed}, visited ${report.pages_visited}.`,
    `Observations emitted ${report.observations_emitted} (marked ${report.traffic_class}).`,
  ];
  if (report.unmarked_beacons) {
    lines.push(`${report.unmarked_beacons} beacon(s) left the probe without the synthetic marker; those observations would be retained as resident traffic.`);
  }
  if (report.budget_exhausted) lines.push("The slot ran out of its runtime budget before every page was visited.");
  for (const failure of report.failures || []) {
    lines.push(`Unreachable: ${failure.path} (${failure.reason}${failure.http_status ? ` ${failure.http_status}` : ""}).`);
  }
  lines.push(`Consecutive failed slots: ${consecutiveFailures}.`);
  return lines.join("\n");
}

async function readProbeHealth(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    const value = Number(parsed?.consecutive_failures);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

async function runNoticeSyntheticProbe(job, context) {
  const dir = join(context.stateDir, "jobs", job.id);
  await mkdir(dir, { recursive: true });
  const resultPath = join(dir, "probe-result.json");
  const healthPath = join(dir, "probe-health.json");
  const previousFailures = await readProbeHealth(healthPath);

  // The probe is spawned exactly as it is documented, with no credential: it
  // visits public pages and the observation path needs no key.
  const command = context.probeRunner || (() => runProcess(
    process.env.CROL_NOTICE_SYNTHETIC_PROBE_PYTHON || "python3",
    [
      NOTICE_SYNTHETIC_PROBE_SCRIPT,
      "--pages", job.pages || NOTICE_SYNTHETIC_PROBE_PAGES,
      "--base", process.env.CITYSCROLL_PUBLIC_BASE || "https://cityscroll.org",
      "--run-key", context.runKey,
      "--out", resultPath,
    ],
    { cwd: ROOT },
  ));
  const run = await command({ resultPath, runKey: context.runKey, job });
  await writeFile(join(dir, `${context.runKey}.log`), `${run.stdout || ""}${run.stderr || ""}`, "utf8");

  let report = null;
  try { report = JSON.parse(await readFile(resultPath, "utf8")); } catch { report = null; }
  const failed = run.code !== 0 || !report || report.status === "failed";
  const consecutiveFailures = failed ? previousFailures + 1 : 0;
  await writeFile(healthPath, `${JSON.stringify({
    schema: "cityscroll.notice_synthetic_probe_health.v1",
    job_id: job.id,
    observed_at: context.now.toISOString(),
    consecutive_failures: consecutiveFailures,
    escalation_after: NOTICE_SYNTHETIC_PROBE_ESCALATION,
  }, null, 2)}\n`, "utf8");

  const result = {
    observed_at: context.now.toISOString(),
    status: failed ? "degraded" : "healthy",
    command_exit: run.code,
    traffic_class: "synthetic",
    measurement_group: "synthetic",
    pages_listed: report?.pages_listed ?? null,
    pages_visited: report?.pages_visited ?? null,
    observations_emitted: report?.observations_emitted ?? null,
    unmarked_beacons: report?.unmarked_beacons ?? null,
    failures: report?.failures || [],
    consecutive_failures: consecutiveFailures,
    body: noticeSyntheticProbeBody(report, consecutiveFailures),
  };
  return {
    result,
    issue: issueIntent(job, context.runKey, result, noticeSyntheticProbeIssueMode(consecutiveFailures, previousFailures)),
  };
}

export async function runScheduledJob(job, options = {}) {
  const now = options.now || new Date();
  const stateDir = options.stateDir || process.env.CROL_EXTERNAL_SCHEDULE_STATE_DIR || join(ROOT, ".external-schedule-state");
  const context = {
    now,
    runKey: options.runKey || runKey(now),
    stateDir,
    fetchImpl: options.fetchImpl,
    probeRunner: options.probeRunner,
  };
  let output;
  if (job.runner === "action-links") output = await runActionLinks(job, context);
  else if (job.runner === "source-contracts") output = await runSourceContracts(job, context);
  else if (job.runner === "source-freshness") output = await runFreshnessWatchdog(job, context);
  else if (job.runner === "digest-shadow") output = await runDigestShadow(job, context);
  else if (job.runner === "stats-daily-snapshot") output = await runStatsDailySnapshot(job, context);
  else if (job.runner === "notice-synthetic-probe") output = await runNoticeSyntheticProbe(job, context);
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

/**
 * A scheduled slot is a promise, so the cycle keeps a ledger of it.
 *
 * The trigger polls on an interval rather than at a wall-clock instant, and the
 * phase of that poll drifts: each cycle starts a fixed interval after the last
 * one *exited*, so the clock the cycle samples slides forward by however long
 * the previous cycle took. Once that slide crosses a minute boundary, one
 * wall-clock minute has no cycle in it at all. Deciding due-ness by comparing a
 * cron expression against the single instant the cycle happened to sample means
 * a job whose only slot falls in that minute is never due: it does not run, it
 * writes no result, and nothing anywhere records that the slot existed. A daily
 * job then simply skips a day and the only symptom is a missing file.
 *
 * The ledger replaces the instant with an interval. Each job remembers the last
 * slot it accounted for; the next cycle asks which of its slots have passed
 * since then and settles every one of them, either by running it or by writing
 * down why it was not run. A slot is never silently dropped again.
 */
export const SLOT_LEDGER_SCHEMA = "cityscroll.external-schedule-slot-ledger.v1";
export const MISSED_SLOT_SCHEMA = "cityscroll.external-schedule-missed-slot.v1";
export const SLOT_LEDGER_FILE = "schedule.json";

// How far back a cycle will settle slots it has not accounted for. A day plus
// two hours, so a daily job recovers on the first cycle after an outage while a
// long silence still resolves to one run rather than a backlog of them.
export const SLOT_CATCH_UP_MINUTES = 26 * 60;

export const MISSED_SUPERSEDED = "superseded-by-a-later-slot";
export const MISSED_OUTSIDE_WINDOW = "outside-the-catch-up-window";
export const MISSED_RUNNER_ERROR = "runner-error";

const MINUTE_MS = 60_000;

function minuteFloor(date) {
  return new Date(Math.floor(date.getTime() / MINUTE_MS) * MINUTE_MS);
}

export function slotKey(date) {
  return runKey(date);
}

export function slotInstant(key) {
  const text = String(key || "");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}$/.test(text)) return null;
  const parsed = Date.parse(`${text.replace(/T(\d{2})-(\d{2})$/, "T$1:$2")}:00Z`);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

/** Every slot a job declares in (after, through], oldest first. */
export function slotsBetween(job, after, through, options = {}) {
  const horizonMinutes = options.horizonMinutes || SLOT_CATCH_UP_MINUTES;
  const end = minuteFloor(through);
  const earliest = new Date(end.getTime() - horizonMinutes * MINUTE_MS);
  const start = after && after.getTime() > earliest.getTime() ? minuteFloor(after) : earliest;
  const expressions = Array.isArray(job?.schedule) ? job.schedule : [];
  const slots = [];
  for (let at = start.getTime() + MINUTE_MS; at <= end.getTime(); at += MINUTE_MS) {
    const candidate = new Date(at);
    if (expressions.some((expression) => cronMatches(expression, candidate))) slots.push(candidate);
  }
  return slots;
}

/**
 * Decide what this cycle owes one job: which slot to run, and which slots to
 * write down as missed.
 *
 * Only the newest outstanding slot is run. These are monitors, so a later
 * observation subsumes an earlier one; running each skipped slot in turn would
 * report the same present state several times and open the same issue twice.
 * The older ones are still recorded, because "the 10:30 slot was superseded by
 * the 10:30 slot a day later" is an operational fact, and a silent slot is the
 * failure this whole ledger exists to end.
 *
 * A job with no ledger adopts the newest slot strictly before now without
 * running it. A fresh state directory then behaves exactly as an unscheduled
 * one did — no burst of five jobs on the first cycle, and no invented history
 * of slots the trigger was not installed for.
 */
export function planScheduledSlots(job, options = {}) {
  const now = options.now || new Date();
  const horizonMinutes = options.horizonMinutes || SLOT_CATCH_UP_MINUTES;
  const ledger = options.ledger || null;
  const lastSlotAt = ledger?.last_slot ? slotInstant(ledger.last_slot) : null;
  const nowFloor = minuteFloor(now);
  if (!lastSlotAt) {
    const before = slotsBetween(job, null, new Date(nowFloor.getTime() - MINUTE_MS), { horizonMinutes });
    return {
      seeded: true,
      run: null,
      missed: [],
      last_slot: slotKey(before.length ? before.at(-1) : new Date(nowFloor.getTime() - MINUTE_MS)),
    };
  }
  const horizonStart = new Date(nowFloor.getTime() - horizonMinutes * MINUTE_MS);
  const truncated = lastSlotAt.getTime() < horizonStart.getTime();
  const slots = slotsBetween(job, lastSlotAt, now, { horizonMinutes });
  const missed = slots.slice(0, -1).map((slot) => ({ slot: slotKey(slot), reason: MISSED_SUPERSEDED }));
  if (truncated) {
    // The record is addressed to the edge of the window rather than to the last
    // slot the ledger settled, because that slot did run; what went unobserved
    // is the stretch between them.
    missed.unshift({
      slot: slotKey(horizonStart),
      reason: MISSED_OUTSIDE_WINDOW,
      detail: {
        since: ledger.last_slot,
        detail: `slots after ${ledger.last_slot} and before ${slotKey(horizonStart)} were older than the ${horizonMinutes}-minute catch-up window and were not evaluated`,
      },
    });
  }
  if (!slots.length) {
    return { seeded: false, run: null, missed, last_slot: truncated ? slotKey(horizonStart) : ledger.last_slot };
  }
  const run = slots.at(-1);
  return { seeded: false, run: slotKey(run), missed, last_slot: slotKey(run) };
}

function slotLedgerPath(stateDir, jobId) {
  return join(stateDir, "jobs", jobId, SLOT_LEDGER_FILE);
}

export async function readSlotLedger(stateDir, jobId) {
  try { return JSON.parse(await readFile(slotLedgerPath(stateDir, jobId), "utf8")); } catch { return null; }
}

export async function writeSlotLedger(stateDir, jobId, ledger) {
  const path = slotLedgerPath(stateDir, jobId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ schema: SLOT_LEDGER_SCHEMA, job_id: jobId, ...ledger }, null, 2)}\n`, "utf8");
  return ledger;
}

/**
 * A slot that was not run leaves a record saying so. It is written beside the
 * results rather than among them, because it is evidence about the schedule and
 * not an observation of the world the job watches.
 */
export async function recordMissedSlot(stateDir, jobId, slot, reason, detail = {}) {
  const record = {
    schema: MISSED_SLOT_SCHEMA,
    job_id: jobId,
    slot,
    reason,
    observed_at: new Date().toISOString(),
    ...detail,
  };
  const dir = join(stateDir, "missed", jobId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${slot.replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

/**
 * Run one slot, and settle it either way.
 *
 * A runner that threw used to take the whole cycle down with it: the loop was
 * unguarded and everything after it — the remaining jobs, the outbox replay,
 * the liveness heartbeat — never happened. One broken job then presented as a
 * dead scheduler, with nothing anywhere naming the job that broke. The failure
 * is now a settled slot: recorded, named, and survivable.
 */
export async function settleScheduledSlot(job, options = {}) {
  const { stateDir, now, slot, run = runScheduledJob, log = console.error } = options;
  try {
    const output = await run(job, { stateDir, now, runKey: slot });
    // The output travels back so the repair rail can read what this monitor
    // observed. It is the same run, read once, never a second invocation.
    return { summary: { id: job.id, slot, status: output.result.status }, missed: null, record: null, output };
  } catch (error) {
    const detail = sanitize(String(error?.message || error)).slice(0, 400);
    const record = await recordMissedSlot(stateDir, job.id, slot, MISSED_RUNNER_ERROR, { detail });
    log(`scheduled job ${job.id} slot ${slot} failed: ${detail}`);
    return {
      summary: { id: job.id, slot, status: "failed", detail },
      missed: { id: job.id, slot, reason: MISSED_RUNNER_ERROR },
      record,
    };
  }
}

/** Settle every slot this job owes, then advance its ledger past them. */
export async function settleScheduledJob(job, options = {}) {
  const { stateDir, now } = options;
  const plan = planScheduledSlots(job, {
    now,
    ledger: await readSlotLedger(stateDir, job.id),
    ...(options.horizonMinutes ? { horizonMinutes: options.horizonMinutes } : {}),
  });
  const missed = [];
  for (const miss of plan.missed) {
    await recordMissedSlot(stateDir, job.id, miss.slot, miss.reason, miss.detail || {});
    missed.push({ id: job.id, slot: miss.slot, reason: miss.reason });
  }
  const settled = plan.run
    ? await settleScheduledSlot(job, { ...options, slot: plan.run })
    : { summary: null, missed: null };
  if (settled.missed) missed.push(settled.missed);
  await writeSlotLedger(stateDir, job.id, {
    last_slot: plan.last_slot,
    updated_at: now.toISOString(),
    ...(plan.seeded ? { seeded_at: now.toISOString() } : {}),
    ...(settled.summary ? {
      last_run_slot: settled.summary.slot,
      last_run_at: now.toISOString(),
      last_run_status: settled.summary.status,
    } : {}),
  });
  return { plan, summary: settled.summary, missed, output: settled.output || null };
}

/**
 * Which unsettled slots are worth repairing, and which are the ledger working.
 *
 * A slot recorded as superseded or outside the catch-up window was skipped
 * deliberately: these are monitors, a later observation subsumes an earlier
 * one, and the newest outstanding slot ran in this same cycle. Re-running them
 * would report the same present state again and open the same issue twice,
 * which is exactly what the ledger exists to avoid.
 *
 * A slot that was attempted and threw is different. Nothing was recorded for
 * it, the ledger has already advanced past it, so no later cycle will try it
 * again — and a single bounded re-run is a genuine deterministic remedy. That
 * is the one class that becomes a repair finding.
 */
export function missedSlotRepairFindings(missedSlots, jobs, now) {
  const byJob = new Map();
  for (const miss of Array.isArray(missedSlots) ? missedSlots : []) {
    if (miss?.reason !== MISSED_RUNNER_ERROR || !miss.slot) continue;
    const slots = byJob.get(miss.id) || [];
    slots.push(miss.slot);
    byJob.set(miss.id, slots);
  }
  const observations = [];
  for (const [id, slots] of byJob) {
    const job = (Array.isArray(jobs) ? jobs : []).find((row) => row?.id === id) || { id };
    observations.push(missedSlotFindings(job, slots, { observedAt: now.toISOString() }));
  }
  return observations;
}

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

// The credential-file discipline itself now lives beside the other shared
// helpers, because two identities read files the same way: the delivery token
// and each of the three files a GitHub App identity is assembled from. It is
// re-exported here so the runner stays the single import for everything a
// cycle's credential handling needs.
export { CREDENTIAL_FAILURES, credentialFailureLine, resolveCredential, resolveCredentialSource };

function adminKey() {
  return resolveCredential({
    inlineVars: ["CITYSCROLL_ADMIN_KEY", "ADMIN_KEY"],
    fileVars: ["CITYSCROLL_ADMIN_KEY_FILE"],
  });
}

/**
 * The delivery identity for the issue loop: a dedicated account's fine-grained
 * token with issue read/write on this repository only. It arrives by the same
 * file route as the admin key, so no secret is written into the trigger.
 *
 * The resolution is returned whole rather than as a bare token, because the
 * cycle has to say which variable failed and how. The caller emits exactly one
 * line for it, so a redacted, actionable receipt survives into the log and the
 * heartbeat instead of one message per layer.
 */
export function githubTokenResolution(env = process.env) {
  return resolveCredentialSource({
    inlineVars: ["GH_TOKEN", "GITHUB_TOKEN"],
    fileVars: ["GH_TOKEN_FILE", "GITHUB_TOKEN_FILE"],
    env,
    requireOwnerOnly: true,
  });
}

export function githubToken() {
  return githubTokenResolution().value;
}

/**
 * The reason a cycle carries when it has no delivery identity. It names the
 * configured variable and the failure class, so an operator reading only the
 * heartbeat knows which file to reinstall; an unconfigured scheduler is a
 * distinct, quieter case.
 */
export function outboxDeliveryReason(resolution) {
  if (!resolution || !resolution.failure) return null;
  if (resolution.failure === "unconfigured") return "github-token-unconfigured";
  return `${resolution.variable}:${resolution.failure}`;
}

export const DELIVERY_REPOSITORY = { owner: "cityscroll", repo: "cityscroll-app" };

/**
 * The client surface the issue loop calls. It is stated here so the refreshing
 * client below cannot silently omit a method the shared client grows, and a
 * test pins the two against each other rather than trusting this list.
 */
export const GITHUB_CLIENT_METHODS = Object.freeze([
  "listIssues",
  "listComments",
  "createIssue",
  "createComment",
  "updateIssue",
]);

/**
 * A client whose credential is resolved per request rather than captured once.
 *
 * An installation token expires in about an hour and a cycle can run longer
 * than that — one bounded repair task alone is allowed ten minutes — so a
 * client built around a single captured string would fail partway through a
 * replay. Each call asks the token source for a current token, which mints on
 * first use and re-mints inside the safety margin, and builds the shared client
 * around it. The token is never held anywhere outside that call.
 *
 * A cycle whose token source has already failed raises rather than requesting
 * with no credential, so a mint failure surfaces as a delivery error the outbox
 * records against the intent instead of an unauthenticated write.
 */
export function createRefreshingGitHubClient({ source, owner, repo, apiBase, fetchImpl }) {
  const call = async (method, args) => {
    const token = await source.token();
    if (!token) throw new Error(`GitHub App identity has no usable installation token: ${source.failure}`);
    return createGitHubClient({ token, owner, repo, apiBase, fetchImpl })[method](...args);
  };
  return Object.fromEntries(GITHUB_CLIENT_METHODS.map((method) => [method, (...args) => call(method, args)]));
}

/**
 * Resolve the one delivery identity this cycle will use, and build the GitHub
 * client for it.
 *
 * Two identities are supported and they are not peers. A GitHub App installed
 * on this repository alone is the intended one: its authority is an
 * installation rather than an account, its permissions are visible in the
 * response to every mint, and the credential that actually authorizes a request
 * expires in about an hour. Naming any of the three App file variables selects
 * that path for the whole cycle — the file token is not consulted, and a broken
 * App configuration reports its own reason rather than silently handing the
 * issue loop to whatever other credential the host carries. That precedence is
 * the entire point: a half-installed App must not deliver under a fallback
 * identity nobody chose.
 *
 * With none of the App variables configured, the file-token path behaves
 * exactly as it did before, which is what keeps a workstation rehearsal and an
 * already-deployed host running unchanged.
 *
 * The client is handed a function rather than a string, so a cycle that outlives
 * an installation token re-mints mid-flight instead of failing partway through
 * a replay.
 */
export function resolveDeliveryIdentity({
  env = process.env,
  owner = DELIVERY_REPOSITORY.owner,
  repo = DELIVERY_REPOSITORY.repo,
  apiBase = env.GITHUB_API_URL,
  fetchImpl = fetch,
  now = () => new Date(),
  log = console.error,
  readTextFile,
  statFile,
} = {}) {
  const app = resolveGitHubAppCredential({
    env,
    ...(readTextFile ? { readTextFile } : {}),
    ...(statFile ? { statFile } : {}),
  });
  if (app.configured) {
    if (app.failure) {
      log(`outbox delivery is offline: ${appCredentialFailureLine(app)}`);
      return {
        kind: null,
        github: null,
        reason: `${app.variable}:${app.failure}`,
        summary: { identity_kind: "app", app_id: null, installation_id: null, permissions: [], repository_selection: null, repositories: [], failure: null, token_expires_at: null },
        source: null,
      };
    }
    const source = createInstallationTokenSource({
      credential: app.credential,
      owner,
      repo,
      ...(apiBase ? { apiBase } : {}),
      fetchImpl,
      now,
    });
    const github = createRefreshingGitHubClient({ source, owner, repo, apiBase, fetchImpl });
    return { kind: "app", github, reason: null, summary: source.summary(), source };
  }

  const delivery = githubTokenResolution(env);
  const github = createGitHubClient({ token: delivery.value, owner, repo, apiBase, fetchImpl });
  if (!github) {
    log(delivery.failure === "unconfigured"
      ? "outbox delivery is offline: no delivery identity is configured; point GH_APP_ID_FILE, GH_APP_INSTALLATION_ID_FILE and GH_APP_PRIVATE_KEY_FILE at mode-0600 files, or GH_TOKEN_FILE at one holding a token"
      : `outbox delivery is offline: ${credentialFailureLine(delivery)}`);
  }
  return {
    kind: github ? "file" : null,
    github,
    reason: outboxDeliveryReason(delivery),
    // A file token carries no expiry the cycle can read and no installation to
    // name, so the summary states the kind and leaves the rest empty rather
    // than inventing a field shape the identity cannot fill.
    summary: { identity_kind: github ? "file" : null, app_id: null, installation_id: null, permissions: [], repository_selection: null, repositories: [], failure: null, token_expires_at: null },
    source: null,
  };
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
  // 3 is the item, not the condition: the signature is not an identity this rail
  // reads, so there is nothing to retry and nothing to decide. The queue retires
  // it rather than parking it for a person to answer again tomorrow.
  if (code === 3) return "unkeyable";
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
  const {
    fetchImpl = fetch,
    cycleResult = "succeeded",
    outboxDelivery = null,
    outboxDeliveryReason: deliveryReason = null,
    outboxDeliveryIdentity = null,
    outboxDeliveryTokenExpiresAt = null,
    missedSlots = [],
  } = options;
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
    // Whether this cycle held a delivery identity at all. Without it, a cycle
    // with no credential is indistinguishable from one with nothing to deliver:
    // pending intents simply sit with attempts 0 and no error. "credentialed"
    // states only that a credential was loaded; whether that identity is the
    // intended account, and whether GitHub accepts it, is proven by the
    // delivery attempts themselves and never asserted here.
    outbox_delivery: outboxDelivery,
    // Which configured variable failed and how, when it did. Deliberately a
    // class rather than a path or a value, so the receipt stays publishable.
    outbox_delivery_reason: deliveryReason,
    // Which of the two identities the cycle was configured to deliver with. Two
    // cycles can both report "credentialed" while writing under entirely
    // different authorities, so an operator reading only the heartbeat needs
    // this to tell an installed App from a rehearsal token.
    outbox_delivery_identity: outboxDeliveryIdentity,
    // When the held credential stops being usable, for an identity that has an
    // expiry to state. An App installation token lasts about an hour, so a
    // cycle that keeps reporting the same expiry is one that stopped refreshing.
    // A file token has no readable expiry and reports null rather than a guess.
    outbox_delivery_token_expires_at: outboxDeliveryTokenExpiresAt,
    // Which promised slots this cycle settled without running. A slot that is
    // skipped, superseded or thrown out is a scheduling fact the heartbeat has
    // to carry, because the alternative — the one this field exists to end — is
    // a daily job that quietly misses a day and leaves nothing behind at all.
    missed_slots: Array.isArray(missedSlots) ? missedSlots.slice(0, 30) : [],
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
  // The same heartbeat carries what this cycle's monitors just observed. A
  // degraded run enters the queue as one item per failure signature; a run that
  // recovered states the scope it evaluated, and the queue closes what is no
  // longer failing inside it. Both are bounded and redacted before they leave
  // this host.
  const observed = options.monitorFindings || { findings: [], recovered: [] };
  const payload = {
    ...base,
    pending_outbox: await pendingOutboxCount(stateDir),
    repair_dispatch: canDispatch,
    repair_results: repairResults,
    repair_findings: observed.findings || [],
    repair_recovered: observed.recovered || [],
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
    // What this cycle put into the queue and what it closed, so the local
    // receipt shows the whole loop and not only the pickup half.
    repair_observed: payload.repair_findings.length,
    repair_queued: Array.isArray(accepted?.repair_queue?.queued) ? accepted.repair_queue.queued.length : 0,
    // Named `closed` rather than `recovered` so a count on the receipt is never
    // confused with the recovery scopes the payload carries.
    repair_closed: Array.isArray(accepted?.repair_queue?.recovered) ? accepted.repair_queue.recovered.length : 0,
    repair_leased: Array.isArray(accepted?.repair_queue?.items) ? accepted.repair_queue.items.length : 0,
    repair_items: Array.isArray(accepted?.repair_queue?.items) ? accepted.repair_queue.items : [],
  });
}

async function main() {
  const jobs = await loadJobs();
  const stateDir = arg("--state-dir") || process.env.CROL_EXTERNAL_SCHEDULE_STATE_DIR || join(ROOT, ".external-schedule-state");
  // Delivery without an identity used to be silent. It is now stated exactly
  // once per cycle, in the log and on the heartbeat, so pending intents are
  // visibly undeliverable rather than merely unattempted. The line names the
  // variable and the failure class and nothing else, so it can be pasted into
  // a ticket without carrying the credential or the host's layout with it.
  const delivery = resolveDeliveryIdentity();
  // An App identity is proven before the cycle writes under it. The scope
  // assertions live at the mint, so this first exchange is where an
  // installation granted more than the agreed one repository, or more than the
  // agreed two permissions, resolves to no credential — by class, before a
  // single intent is replayed, so nothing is delivered under an authority
  // nobody agreed to and no attempt counter moves because of it.
  const identityFailure = delivery.source ? await delivery.source.ensure() : null;
  const github = identityFailure ? null : delivery.github;
  const deliveryReason = delivery.reason || identityFailure;
  // A cycle that could not read its configured file replays nothing and touches
  // no attempt counter, so every pending intent stays exactly as retryable as
  // it was before the credential broke.
  const outboxDelivery = github ? "credentialed" : "offline";
  const replayBefore = await replayOutbox({ stateDir, github, offlineReason: deliveryReason });
  const selected = arg("--job");
  const now = new Date();
  const summaries = [];
  const missedSlots = [];
  // What each settled monitor observed, folded into repair-queue findings. The
  // settle path already ran the job, so this reads its result rather than
  // running anything a second time.
  const observations = [];
  if (selected) {
    // An operator forcing a run observes the world now; it neither claims nor
    // consumes a scheduled slot, so the ledger is left exactly where it was.
    for (const job of jobs.jobs.filter((job) => job.id === selected)) {
      const settled = await settleScheduledSlot(job, { stateDir, now, slot: runKey(now) });
      summaries.push(settled.summary);
      if (settled.missed) missedSlots.push(settled.missed);
      if (settled.output) observations.push(monitorRepairFindings(job, settled.output, { now: now.toISOString() }));
    }
  } else {
    for (const job of jobs.jobs) {
      const settled = await settleScheduledJob(job, { stateDir, now });
      if (settled.summary) summaries.push(settled.summary);
      missedSlots.push(...settled.missed);
      if (settled.output) observations.push(monitorRepairFindings(job, settled.output, { now: now.toISOString() }));
    }
  }
  // The slot ledger accounts for every slot that passed, so the cycle no longer
  // has to go looking for one. Of the three ways a slot goes unsettled, only a
  // slot the cycle attempted and that threw is repairable: the other two name a
  // slot a later run in this same cycle already subsumed, which is the ledger
  // working rather than something to re-run.
  observations.push(...missedSlotRepairFindings(missedSlots, jobs.jobs, now));
  const monitorFindings = mergeRepairFindings(observations);
  const replayAfter = await replayOutbox({ stateDir, github });
  // Scheduler liveness is a postcondition of the real cycle, distinct from every
  // scheduled-job and digest-shadow receipt. A rejected write makes the cycle fail.
  // The cycle result travels with the heartbeat so a degraded run cannot read as
  // healthy liveness, and a healthy digest cannot stand in for a missing write.
  const degraded = summaries.some((summary) => summary.status !== "healthy");
  // Read after the replays, so the expiry on the heartbeat is the one the cycle
  // actually delivered under rather than the one it was configured with.
  const deliverySummary = delivery.source ? delivery.source.summary() : delivery.summary;
  const heartbeat = await publishHeartbeat(stateDir, new Date(), summaries.map((summary) => summary.id), {
    cycleResult: degraded ? "degraded" : "succeeded",
    missedSlots,
    outboxDelivery,
    outboxDeliveryReason: deliveryReason,
    outboxDeliveryIdentity: delivery.kind,
    outboxDeliveryTokenExpiresAt: deliverySummary.token_expires_at,
    monitorFindings,
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
    // Which authority this cycle wrote under, and what GitHub said it may do.
    // No token, no assertion, no key and no path: the receipt is publishable as
    // it stands, and it still tells two identities apart.
    delivery: { status: outboxDelivery, reason: deliveryReason, ...deliverySummary },
    replayBefore,
    heartbeat: heartbeatReceipt,
    due: summaries,
    replayAfter,
    repair: {
      observed: monitorFindings.findings.length,
      queued: heartbeat.repair_queued ?? 0,
      closed: heartbeat.repair_closed ?? 0,
      dispatched: repairResults.length,
      outcomes: repairResults.map((row) => row.outcome),
    },
  }, null, 2)}\n`);
  if (heartbeat.status !== "succeeded" || degraded) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error?.stack || error); process.exitCode = 1; });
