#!/usr/bin/env node

/**
 * Repeatable producer for Desk evidence-publication production observations.
 *
 * Live capture reads scheduled Deploy Cloudflare Pages runs, Reliability
 * watchdog observer cycles, the scheduler heartbeat, and the private Desk
 * destination. For each consecutive successful scheduled Pages run it retrieves
 * the retained per-run publication receipt from the workflow artifact and
 * emits qualifying receipts under consecutive_unattended_publication_cycles.
 * Observer cycles are not publication. Receipts are never synthesized from
 * GitHub run metadata.
 *
 *   CITYSCROLL_ADMIN_KEY_FILE=/path/to/key node tools/capture_desk_publication_production_read.mjs
 *   node tools/capture_desk_publication_production_read.mjs --check
 *
 * The admin credential arrives only as CITYSCROLL_ADMIN_KEY_FILE. It is read
 * in-process and is never printed, echoed, passed on argv, or written into the
 * envelope.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  consecutiveUnattendedPublicationCycles,
  isQualifyingUnattendedPublicationReceipt,
  publicationReceiptRetentionGap,
} from "./desk_health_publication_cycle.mjs";
import { resolveCredentialSource } from "./lib/credential_files.mjs";
import { extractNamedJsonFromZip } from "./lib/zip_json.mjs";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const SCHEMA = "cityscroll.desk_publication_production_observation.v1";
export const EVIDENCE_DIR_RELATIVE = "docs/evidence/desk-health-publication-liveness";
export const HISTORICAL_ENVELOPE_NAME = "production-watchdog-read.json";
export const DATED_ENVELOPE_PATTERN = /^production-watchdog-read-(\d{4}-\d{2}-\d{2})(?:T\d{4})?\.json$/;
export const PUBLICATION_RECEIPT_ARTIFACT_PREFIX = "data-source-graph-";
export const PUBLICATION_RECEIPT_ZIP_PATH = ".artifacts/desk-health-publication-cycle.json";
export const PUBLICATION_RECEIPT_RETENTION_SOURCE = "scheduled Pages workflow artifact data-source-graph-<run_id>";
export const PAGES_WORKFLOW_FILE = "deploy-cloudflare-pages.yml";
export const PAGES_WORKFLOW_NAME = "Deploy Cloudflare Pages";
export const WATCHDOG_WORKFLOW_FILE = "reliability-watchdogs.yml";
export const WATCHDOG_WORKFLOW_NAME = "Reliability watchdogs";
export const DATASET_REFRESH_WORKFLOW_FILE = "first-class-refresh.yml";
export const DATASET_REFRESH_WORKFLOW_NAME = "First-class dataset refresh";
export const DEFAULT_OWNER = "cityscroll";
export const DEFAULT_REPO = "cityscroll-app";
export const DEFAULT_API_BASE = "https://api.github.com";
export const DEFAULT_SCHEDULER_URL = "https://api.cityscroll.org/admin/reliability/scheduler";
export const DEFAULT_DESTINATION_URL = "https://desk.cityscroll.org/data-sources";
export const OBSERVER_CYCLE_COUNT = 2;

export const CURRENCY_STATUSES = Object.freeze(["current", "stale", "zero-successes"]);

const USER_AGENT = "cityscroll-desk-publication-read";

export function evidenceDir(root = ROOT) {
  return join(root, EVIDENCE_DIR_RELATIVE);
}

export function listedDatedProductionObservationNames(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => DATED_ENVELOPE_PATTERN.test(name))
    .sort();
}

export function newestDatedProductionObservationPath(dir) {
  const names = listedDatedProductionObservationNames(dir);
  if (!names.length) {
    throw new Error(`no dated production observation envelopes in ${dir}`);
  }
  return join(dir, names[names.length - 1]);
}

export function loadNewestDatedProductionObservation(dir) {
  const path = newestDatedProductionObservationPath(dir);
  return { path, envelope: JSON.parse(readFileSync(path, "utf8")) };
}

function validInstant(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) ? new Date(epoch).toISOString() : null;
}

function utcDay(value) {
  const instant = validInstant(value) || validInstant(String(value));
  return instant ? instant.slice(0, 10) : null;
}

export function datedEnvelopeName(now, existingNames = []) {
  const day = utcDay(now);
  if (!day) throw new Error("dated envelope name requires a valid now timestamp");
  const daily = `production-watchdog-read-${day}.json`;
  const names = new Set(existingNames);
  if (!names.has(daily)) return daily;
  const instant = validInstant(now);
  const hhmm = instant.slice(11, 16).replace(":", "");
  return `production-watchdog-read-${day}T${hhmm}.json`;
}

function headerGet(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return String(headers.get(name) || "");
  const direct = headers[name] ?? headers[String(name).toLowerCase()];
  return direct == null ? "" : String(direct);
}

function runSummary(run, extra = {}) {
  if (!run) return null;
  const summary = {
    run_id: String(run.id ?? run.run_id ?? ""),
    event: run.event || null,
    conclusion: run.conclusion || null,
    created_at: run.created_at || null,
    head_sha: run.head_sha || null,
    url: run.html_url || run.url || null,
  };
  if (extra.failing_job) summary.failing_job = extra.failing_job;
  if (extra.named_stage) summary.named_stage = extra.named_stage;
  return summary;
}

function isScheduled(run) {
  return run && run.event === "schedule";
}

function isScheduledSuccess(run) {
  return isScheduled(run) && run.conclusion === "success";
}

export function consecutiveScheduledSuccesses(runs, limit = 10) {
  const scheduled = (Array.isArray(runs) ? runs : []).filter(isScheduled);
  const streak = [];
  for (const run of scheduled) {
    if (run.conclusion !== "success") break;
    streak.push(run);
    if (streak.length >= limit) break;
  }
  return streak.slice().reverse();
}

export function consecutiveObserverCycles(runs, count = OBSERVER_CYCLE_COUNT) {
  const scheduled = (Array.isArray(runs) ? runs : []).filter(isScheduled);
  const streak = [];
  for (const run of scheduled) {
    if (run.conclusion !== "success") break;
    streak.push(run);
    if (streak.length >= count) break;
  }
  return streak.slice().reverse().map((run) => runSummary(run));
}

export function scheduledCyclesFromObservation(envelope) {
  const publication = envelope?.publication_dependency_and_backlog?.scheduled_pages_publication || {};
  const listed = Array.isArray(publication.consecutive_successful_scheduled_runs)
    ? publication.consecutive_successful_scheduled_runs
    : [];
  if (listed.length) return listed.filter(isScheduledSuccess);
  const last = publication.last_successful_scheduled_run;
  return last && isScheduledSuccess(last) ? [last] : [];
}

/**
 * Compare a retained envelope against later scheduled publication cycles.
 * An envelope older than the two most recent scheduled successes is stale,
 * even if a reader would otherwise treat a failed last attempt as zero
 * successes.
 */
export function evaluateProductionObservationCurrency(envelope, { scheduledCycles = [] } = {}) {
  const successes = [...scheduledCycles]
    .filter(isScheduledSuccess)
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
  const twoMostRecent = successes.slice(0, 2);
  const observedMs = Date.parse(envelope?.observed_at || "");
  if (twoMostRecent.length >= 2 && Number.isFinite(observedMs)) {
    const olderOfTwo = Math.min(...twoMostRecent.map((run) => Date.parse(run.created_at)));
    if (Number.isFinite(olderOfTwo) && observedMs < olderOfTwo) {
      return {
        status: "stale",
        reason: "retained observation predates the two most recent scheduled publication cycles",
        two_most_recent_scheduled_cycles: twoMostRecent,
      };
    }
  }
  const recorded = scheduledCyclesFromObservation(envelope);
  if (!recorded.length) {
    return {
      status: "zero-successes",
      reason: "no successful scheduled publication cycle is recorded",
      two_most_recent_scheduled_cycles: twoMostRecent,
    };
  }
  return {
    status: "current",
    reason: "retained observation includes a successful scheduled publication cycle",
    two_most_recent_scheduled_cycles: twoMostRecent,
  };
}

export function validateProductionObservation(envelope) {
  if (!envelope || envelope.schema !== SCHEMA) {
    throw new Error(`envelope schema must be ${SCHEMA}`);
  }
  if (envelope.evidence_class !== "live-production-read") {
    throw new Error("envelope evidence_class must be live-production-read");
  }
  if (envelope.isolated !== false) {
    throw new Error("live production observation must not be labeled isolated");
  }
  if (!validInstant(envelope.observed_at)) {
    throw new Error("envelope observed_at must be a valid timestamp");
  }
  const cycles = envelope.consecutive_unattended_observer_cycles;
  if (!Array.isArray(cycles) || cycles.length !== OBSERVER_CYCLE_COUNT) {
    throw new Error(`envelope must record ${OBSERVER_CYCLE_COUNT} consecutive observer cycles`);
  }
  if (!cycles.every((row) => row?.event === "schedule")) {
    throw new Error("observer cycles must be scheduled runs");
  }
  const publication = envelope.publication_dependency_and_backlog?.scheduled_pages_publication;
  const lastSuccess = publication?.last_successful_scheduled_run;
  const lastAttempt = publication?.last_scheduled_attempt;
  if (!lastAttempt || lastAttempt.event !== "schedule") {
    throw new Error("last scheduled Pages attempt must be a scheduled run");
  }
  for (const field of ["run_id", "conclusion", "created_at", "url"]) {
    if (!lastAttempt[field]) throw new Error(`last scheduled attempt is missing ${field}`);
  }
  if (lastSuccess) {
    if (lastSuccess.event !== "schedule" || lastSuccess.conclusion !== "success") {
      throw new Error("last successful scheduled run must be a successful scheduled Pages run");
    }
    for (const field of ["run_id", "created_at", "head_sha", "url"]) {
      if (!lastSuccess[field]) throw new Error(`last successful scheduled run is missing ${field}`);
    }
  }
  const destination = envelope.publication_dependency_and_backlog?.private_destination;
  if (destination !== DEFAULT_DESTINATION_URL) {
    throw new Error("private destination must be the operator-visible Desk graph");
  }
  const publicationCycles = envelope.consecutive_unattended_publication_cycles;
  if (!Array.isArray(publicationCycles)) {
    throw new Error("envelope must record consecutive_unattended_publication_cycles as an array");
  }
  if (publicationCycles.some((row) => !isQualifyingUnattendedPublicationReceipt(row))) {
    throw new Error("consecutive_unattended_publication_cycles must contain only retained qualifying publication receipts");
  }
  const expectedCycles = consecutiveUnattendedPublicationCycles(publicationCycles);
  if (JSON.stringify(publicationCycles) !== JSON.stringify(expectedCycles)) {
    throw new Error("consecutive_unattended_publication_cycles must be the reader-qualified streak in chronological order");
  }
  const retention = envelope.publication_receipt_retention;
  if (!retention || typeof retention !== "object") {
    throw new Error("envelope must record publication_receipt_retention");
  }
  if (retention.source !== PUBLICATION_RECEIPT_RETENTION_SOURCE) {
    throw new Error("publication receipt retention source must name the per-run Pages artifact");
  }
  if (publicationCycles.length === 0 && !retention.empty_reason) {
    throw new Error("empty consecutive_unattended_publication_cycles must explain the retention gap");
  }
  const serialized = JSON.stringify(envelope);
  if (/cloudflareaccess\.com/i.test(serialized)) {
    throw new Error("envelope must not record private access-challenge URLs");
  }
  return envelope;
}

function githubHeaders(token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function githubJson(fetchImpl, url, token) {
  const response = await fetchImpl(url, { headers: githubHeaders(token) });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} GET ${new URL(url).pathname}`);
  }
  return response.json();
}

async function githubBytes(fetchImpl, url, token) {
  const response = await fetchImpl(url, {
    headers: githubHeaders(token),
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} GET ${new URL(url).pathname}`);
  }
  if (typeof response.arrayBuffer === "function") {
    return Buffer.from(await response.arrayBuffer());
  }
  if (typeof response.bytes === "function") {
    return Buffer.from(await response.bytes());
  }
  throw new Error("artifact download requires an arrayBuffer response");
}

export function publicationReceiptArtifactName(runId) {
  return `${PUBLICATION_RECEIPT_ARTIFACT_PREFIX}${runId}`;
}

export function buildPublicationReceiptRetention({ retrieved = [], qualifying = [] } = {}) {
  const retrievedCount = retrieved.length;
  const qualifyingCount = qualifying.length;
  const retention = {
    source: PUBLICATION_RECEIPT_RETENTION_SOURCE,
    retrieved_count: retrievedCount,
    qualifying_count: qualifyingCount,
  };
  if (qualifyingCount === 0) {
    retention.empty_reason = publicationReceiptRetentionGap(retrieved);
  }
  return retention;
}

export async function loadPublicationReceiptFromArtifact(fetchImpl, {
  apiBase = DEFAULT_API_BASE,
  owner = DEFAULT_OWNER,
  repo = DEFAULT_REPO,
  runId,
  token = null,
} = {}) {
  if (!runId) return null;
  const listUrl = `${apiBase.replace(/\/$/, "")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${encodeURIComponent(runId)}/artifacts?per_page=20`;
  let body;
  try {
    body = await githubJson(fetchImpl, listUrl, token);
  } catch {
    return null;
  }
  const artifacts = Array.isArray(body?.artifacts) ? body.artifacts : [];
  const wanted = publicationReceiptArtifactName(runId);
  const artifact = artifacts.find((row) => row?.name === wanted && row?.expired !== true);
  if (!artifact?.id) return null;
  const zipUrl = `${apiBase.replace(/\/$/, "")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/artifacts/${encodeURIComponent(artifact.id)}/zip`;
  try {
    const zip = await githubBytes(fetchImpl, zipUrl, token);
    return extractNamedJsonFromZip(zip, PUBLICATION_RECEIPT_ZIP_PATH);
  } catch {
    return null;
  }
}

async function listWorkflowRuns(fetchImpl, {
  apiBase, owner, repo, workflow, token, event = "schedule", perPage = 20,
}) {
  const params = new URLSearchParams({ per_page: String(perPage) });
  if (event) params.set("event", event);
  const url = `${apiBase.replace(/\/$/, "")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflow)}/runs?${params}`;
  const body = await githubJson(fetchImpl, url, token);
  return Array.isArray(body.workflow_runs) ? body.workflow_runs : [];
}

async function failingJobName(fetchImpl, { apiBase, owner, repo, runId, token }) {
  const url = `${apiBase.replace(/\/$/, "")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${encodeURIComponent(runId)}/jobs?per_page=20`;
  const body = await githubJson(fetchImpl, url, token);
  const jobs = Array.isArray(body.jobs) ? body.jobs : [];
  const failed = jobs.find((job) => job?.conclusion === "failure");
  return failed?.name || null;
}

function sanitizeSchedulerRead(status, body) {
  const heartbeat = body?.publication_heartbeat && typeof body.publication_heartbeat === "object"
    ? {
      workflow: body.publication_heartbeat.workflow || null,
      run_id: body.publication_heartbeat.run_id || null,
      result: body.publication_heartbeat.result || null,
      observed_at: body.publication_heartbeat.observed_at || null,
      destination: body.publication_heartbeat.destination || null,
    }
    : null;
  const alert = body?.alert && typeof body.alert === "object"
    ? {
      sent: body.alert.sent ?? null,
      reason: body.alert.reason ?? null,
    }
    : null;
  return {
    http_ok: status === 200,
    http_status: status,
    publication_ok: body?.publication_ok === true,
    scheduler_ok: body?.scheduler_ok === true,
    failing_stage: body?.failing_stage ?? null,
    alert,
    publication_heartbeat: heartbeat,
  };
}

function watchdogNote({ observerCycles, lastSuccess, scheduler, publicationCycles, receiptRetention }) {
  const observerCount = observerCycles.length;
  const observer = observerCount
    ? `The independent observer completed ${observerCount} consecutive unattended scheduled cycle(s).`
    : "No consecutive unattended observer cycles were retained.";
  const publication = lastSuccess
    ? `A scheduled ${PAGES_WORKFLOW_NAME} run succeeded at ${lastSuccess.created_at} (${lastSuccess.url}). Observer cycles do not count as publication.`
    : `No successful scheduled ${PAGES_WORKFLOW_NAME} run was observed. Observer cycles do not count as publication.`;
  const retained = publicationCycles.length
    ? `The envelope carries ${publicationCycles.length} retained unattended publication receipt(s).`
    : (receiptRetention?.empty_reason
      || "No consecutive unattended publication receipts met the liveness reader constraints.");
  const heartbeat = scheduler.publication_ok
    ? "The scheduler heartbeat reports Desk publication as healthy."
    : "The scheduler heartbeat does not yet show a healthy Desk publication cycle.";
  return `${observer} ${publication} ${retained} ${heartbeat}`;
}

function destinationCheck(status, location) {
  const accessProtected = /cloudflareaccess\.com/i.test(location) || status === 302 || status === 401 || status === 403;
  return {
    http_status: status,
    access_protected: accessProtected,
  };
}

function datasetRefreshNote(runs) {
  if (!runs.length) {
    return "No observed runs of this workflow. Missing that scheduler input is not proof the Pages collector is stopped. Opening a pull request would still not be successful Desk publication.";
  }
  return "Observed runs remain backlog. Opening a pull request is not successful Desk publication.";
}

export function buildProductionObservation({
  now,
  pagesRuns,
  watchdogRuns,
  datasetRefreshRuns,
  lastAttemptExtra = {},
  scheduler,
  destination,
  observerRunId = null,
  retrievedPublicationReceipts = [],
}) {
  const lastAttemptRun = (pagesRuns || []).find(isScheduled) || null;
  const lastSuccessRun = (pagesRuns || []).find(isScheduledSuccess) || null;
  const successfulStreak = consecutiveScheduledSuccesses(pagesRuns).map((run) => runSummary(run));
  const observerCycles = consecutiveObserverCycles(watchdogRuns);
  const lastSuccess = runSummary(lastSuccessRun);
  const lastAttempt = runSummary(lastAttemptRun, lastAttemptRun && lastAttemptRun.conclusion !== "success"
    ? lastAttemptExtra
    : {});
  const datasetRuns = (datasetRefreshRuns || []).slice(0, 5).map((run) => ({
    run_id: String(run.id ?? run.run_id ?? ""),
    event: run.event || null,
    conclusion: run.conclusion || null,
    created_at: run.created_at || null,
    url: run.html_url || run.url || null,
  }));
  const retrieved = Array.isArray(retrievedPublicationReceipts) ? retrievedPublicationReceipts : [];
  const publicationCycles = consecutiveUnattendedPublicationCycles(retrieved);
  const receiptRetention = buildPublicationReceiptRetention({
    retrieved,
    qualifying: publicationCycles,
  });
  const envelope = {
    schema: SCHEMA,
    evidence_class: "live-production-read",
    isolated: false,
    observed_at: now,
    observer: {
      workflow: WATCHDOG_WORKFLOW_NAME,
      schedule: "existing GitHub Actions reliability-watchdogs.yml",
      endpoint: DEFAULT_SCHEDULER_URL,
    },
    consecutive_unattended_observer_cycles: observerCycles,
    consecutive_unattended_publication_cycles: publicationCycles,
    publication_receipt_retention: receiptRetention,
    publication_dependency_and_backlog: {
      scheduled_pages_publication: {
        workflow: PAGES_WORKFLOW_NAME,
        consecutive_successful_scheduled_runs: successfulStreak,
        last_successful_scheduled_run: lastSuccess,
        last_scheduled_attempt: lastAttempt,
      },
      unrelated_successful_push_deploys: "Recent successful main-branch Pages deploys are application-code deploys. They are not Desk evidence-publication cycles.",
      dataset_refresh_pull_requests: {
        workflow: DATASET_REFRESH_WORKFLOW_NAME,
        observed_runs: datasetRuns,
        role: "backlog-only",
        note: datasetRefreshNote(datasetRuns),
      },
      private_destination: DEFAULT_DESTINATION_URL,
      private_destination_check: destination,
    },
    watchdog_read: {
      run_id: observerRunId || observerCycles[observerCycles.length - 1]?.run_id || null,
      http_ok: scheduler.http_ok === true,
      alert: scheduler.alert,
      publication_ok: scheduler.publication_ok === true,
      publication_heartbeat_run_id: scheduler.publication_heartbeat?.run_id || null,
      note: watchdogNote({
        observerCycles, lastSuccess, scheduler, publicationCycles, receiptRetention,
      }),
    },
  };
  return validateProductionObservation(envelope);
}

export async function captureDeskPublicationProductionRead({
  now,
  fetchImpl,
  githubToken = null,
  adminKey,
  owner = DEFAULT_OWNER,
  repo = DEFAULT_REPO,
  apiBase = DEFAULT_API_BASE,
  schedulerUrl = DEFAULT_SCHEDULER_URL,
  destinationUrl = DEFAULT_DESTINATION_URL,
} = {}) {
  const observedAt = validInstant(now);
  if (!observedAt) throw new Error("capture requires an injected now timestamp");
  if (typeof fetchImpl !== "function") throw new Error("capture requires an injected fetch implementation");
  if (!adminKey) throw new Error("CITYSCROLL_ADMIN_KEY_FILE is required");

  const [pagesRuns, watchdogRuns, datasetRefreshRuns] = await Promise.all([
    listWorkflowRuns(fetchImpl, {
      apiBase, owner, repo, workflow: PAGES_WORKFLOW_FILE, token: githubToken,
    }),
    listWorkflowRuns(fetchImpl, {
      apiBase, owner, repo, workflow: WATCHDOG_WORKFLOW_FILE, token: githubToken,
    }),
    listWorkflowRuns(fetchImpl, {
      apiBase, owner, repo, workflow: DATASET_REFRESH_WORKFLOW_FILE, token: githubToken, event: "",
    }),
  ]);

  const lastAttemptRun = pagesRuns.find(isScheduled) || null;
  let lastAttemptExtra = {};
  if (lastAttemptRun && lastAttemptRun.conclusion !== "success") {
    const failingJob = await failingJobName(fetchImpl, {
      apiBase, owner, repo, runId: lastAttemptRun.id, token: githubToken,
    });
    lastAttemptExtra = {
      failing_job: failingJob,
      named_stage: "frozen-publication",
    };
  }

  const schedulerResponse = await fetchImpl(schedulerUrl, {
    headers: {
      Authorization: `Bearer ${adminKey}`,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
  });
  let schedulerBody = null;
  try {
    schedulerBody = await schedulerResponse.json();
  } catch {
    schedulerBody = null;
  }
  const scheduler = sanitizeSchedulerRead(schedulerResponse.status, schedulerBody);

  const destinationResponse = await fetchImpl(destinationUrl, {
    method: "GET",
    redirect: "manual",
    headers: { "User-Agent": USER_AGENT },
  });
  const destination = destinationCheck(
    destinationResponse.status,
    headerGet(destinationResponse.headers, "location"),
  );

  const successfulStreak = consecutiveScheduledSuccesses(pagesRuns);
  const retrievedPublicationReceipts = [];
  for (const run of successfulStreak) {
    const receipt = await loadPublicationReceiptFromArtifact(fetchImpl, {
      apiBase, owner, repo, runId: run.id ?? run.run_id, token: githubToken,
    });
    if (receipt) retrievedPublicationReceipts.push(receipt);
  }

  return buildProductionObservation({
    now: observedAt,
    pagesRuns,
    watchdogRuns,
    datasetRefreshRuns,
    lastAttemptExtra,
    scheduler,
    destination,
    retrievedPublicationReceipts,
  });
}

export function checkRetainedProductionObservations(dir = evidenceDir()) {
  const { path, envelope } = loadNewestDatedProductionObservation(dir);
  validateProductionObservation(envelope);
  const historicalPath = join(dir, HISTORICAL_ENVELOPE_NAME);
  if (existsSync(historicalPath)) {
    const historical = JSON.parse(readFileSync(historicalPath, "utf8"));
    const scheduledCycles = scheduledCyclesFromObservation(envelope);
    const verdict = evaluateProductionObservationCurrency(historical, { scheduledCycles });
    if (scheduledCycles.filter(isScheduledSuccess).length >= 2 && verdict.status !== "stale") {
      throw new Error("historical envelope older than the two most recent scheduled cycles must be reported as stale, not as zero successes");
    }
  }
  return { path, envelope };
}

function readAdminKey(env = process.env) {
  const resolution = resolveCredentialSource({
    inlineVars: [],
    fileVars: ["CITYSCROLL_ADMIN_KEY_FILE"],
    env,
  });
  if (resolution.value) return resolution.value;
  if (resolution.failure === "unconfigured") {
    throw new Error("CITYSCROLL_ADMIN_KEY_FILE is required");
  }
  throw new Error(`CITYSCROLL_ADMIN_KEY_FILE is ${resolution.failure}`);
}

function readGitHubToken(env = process.env) {
  const resolution = resolveCredentialSource({
    inlineVars: ["GH_TOKEN", "GITHUB_TOKEN"],
    fileVars: ["GH_TOKEN_FILE", "GITHUB_TOKEN_FILE"],
    env,
  });
  return resolution.value || null;
}

function parseArgs(argv) {
  const args = { check: false, write: null, now: null, dir: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--check") args.check = true;
    else if (token === "--write") {
      args.write = argv[index + 1];
      index += 1;
    } else if (token === "--now") {
      args.now = argv[index + 1];
      index += 1;
    } else if (token === "--dir") {
      args.dir = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`unknown argument: ${token}`);
    }
  }
  return args;
}

function serialized(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const dir = args.dir || evidenceDir();
  if (args.check) {
    const checked = checkRetainedProductionObservations(dir);
    console.log(`checked ${checked.path}`);
    return;
  }
  // determinism-lint: allow clock observed_at is the only live clock and is unused in --check
  const now = args.now || new Date().toISOString();
  const adminKey = readAdminKey(env);
  const githubToken = readGitHubToken(env);
  const envelope = await captureDeskPublicationProductionRead({
    now,
    // determinism-lint: inject network live capture delegates to fetch; tests supply a hermetic fetchImpl
    fetchImpl: fetch,
    githubToken,
    adminKey,
  });
  const output = args.write || join(dir, datedEnvelopeName(now, listedDatedProductionObservationNames(dir)));
  // determinism-lint: allow write dated envelope is written only outside --check
  writeFileSync(output, serialized(envelope));
  console.log(`wrote ${output}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
}
