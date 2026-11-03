#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const FIRST_CLASS_REFRESH_ISSUE_MARKER = "<!-- cityscroll:first-class-refresh-health -->";
export const FIRST_CLASS_REFRESH_ISSUE_TITLE = "First-class dataset refresh needs attention";
export const FIRST_CLASS_REFRESH_FAILURE_THRESHOLD = 2;
export const FIRST_CLASS_REFRESH_STALE_HOURS = 36;

const completed = (run) => run?.status === "completed" && run?.conclusion;
const succeeded = (run) => run.conclusion === "success";

export function evaluateFirstClassRefreshHealth(runs, {
  asOf = new Date().toISOString(),
  failureThreshold = FIRST_CLASS_REFRESH_FAILURE_THRESHOLD,
  staleHours = FIRST_CLASS_REFRESH_STALE_HOURS,
} = {}) {
  const now = Date.parse(asOf);
  if (!Number.isFinite(now)) throw new Error("first-class refresh health requires a valid evaluation timestamp");
  const scheduled = [...(runs || [])]
    .filter((run) => run?.event === "schedule" && completed(run))
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
  const recentFailures = [];
  for (const run of scheduled) {
    if (succeeded(run)) break;
    recentFailures.push(run);
  }
  const lastSuccess = scheduled.find(succeeded) || null;
  const lastSuccessAt = lastSuccess?.updated_at || lastSuccess?.created_at || null;
  const successAgeHours = lastSuccessAt ? (now - Date.parse(lastSuccessAt)) / 3_600_000 : null;
  const failureStreak = recentFailures.length >= failureThreshold;
  const successOverdue = lastSuccessAt == null || successAgeHours >= staleHours;
  const reasons = [];
  if (failureStreak) reasons.push(`${recentFailures.length} consecutive scheduled runs failed`);
  if (successOverdue) reasons.push(lastSuccessAt
    ? `no successful scheduled run for ${Math.floor(successAgeHours)} hours`
    : "no successful scheduled run is visible");
  return {
    healthy: reasons.length === 0,
    reasons,
    consecutive_failures: recentFailures.length,
    recent_failures: recentFailures,
    last_success: lastSuccess,
    last_success_at: lastSuccessAt,
    success_age_hours: successAgeHours,
  };
}

function firstFailingStep(jobs) {
  for (const job of jobs || []) {
    const step = (job.steps || []).find((candidate) => candidate.conclusion === "failure");
    if (step) return `${job.name}: ${step.name}`;
    if (job.conclusion === "failure") return job.name;
  }
  return "Unavailable from the run jobs API";
}

export function renderFirstClassRefreshIssue(evaluation, failures = []) {
  const rows = failures.length
    ? failures.map(({ run, failingStep }) => `| [${run.run_number}](${run.html_url}) | ${run.conclusion} | ${failingStep} |`).join("\n")
    : "| — | — | No failed run is currently visible |";
  return `${FIRST_CLASS_REFRESH_ISSUE_MARKER}
The scheduled First-class dataset refresh is unhealthy.

- ${evaluation.reasons.join("\n- ")}
- Last successful scheduled run: ${evaluation.last_success?.html_url ? `[${evaluation.last_success.run_number}](${evaluation.last_success.html_url})` : "none visible"}

| Scheduled run | Conclusion | First failing step |
| --- | --- | --- |
${rows}

This issue is maintained automatically and will close after a successful scheduled run restores the health window.
`;
}

function managedIssue(issue) {
  return !issue?.pull_request && String(issue?.body || "").includes(FIRST_CLASS_REFRESH_ISSUE_MARKER);
}

/** Load every managed issue, not only the first page shared with open pull requests. */
export async function loadManagedFirstClassRefreshIssues(request) {
  const issues = [];
  for (let page = 1; ; page += 1) {
    const payload = await request("GET", `/issues?state=open&per_page=100&page=${page}`);
    issues.push(...payload.filter(managedIssue));
    if (payload.length < 100) return issues;
  }
}

function canonicalIssue(issues) {
  return [...issues].sort((left, right) => Number(right.number) - Number(left.number))[0] || null;
}

async function closeIssue(request, issue, body) {
  await request("PATCH", `/issues/${issue.number}`, { state: "closed", body });
}

export async function reconcileFirstClassRefreshIssue({
  evaluation,
  failures = [],
  openIssue = null,
  openIssues = null,
  request,
}) {
  const managedIssues = openIssues || (openIssue ? [openIssue] : []);
  const canonical = canonicalIssue(managedIssues);
  const duplicates = managedIssues.filter((issue) => issue.number !== canonical?.number);
  if (evaluation.healthy) {
    if (!canonical) return { action: "none" };
    for (const issue of managedIssues) {
      await closeIssue(
        request,
        issue,
        `${issue.body || FIRST_CLASS_REFRESH_ISSUE_MARKER}\n\nRecovered after a successful scheduled refresh.`,
      );
    }
    return {
      action: "closed",
      issue_number: canonical.number,
      closed_issue_numbers: managedIssues.map((issue) => issue.number),
    };
  }
  const body = renderFirstClassRefreshIssue(evaluation, failures);
  if (!canonical) {
    const issue = await request("POST", "/issues", { title: FIRST_CLASS_REFRESH_ISSUE_TITLE, body });
    return { action: "created", issue_number: issue.number };
  }
  let action = "unchanged";
  if (canonical.title !== FIRST_CLASS_REFRESH_ISSUE_TITLE || canonical.body !== body) {
    await request("PATCH", `/issues/${canonical.number}`, { title: FIRST_CLASS_REFRESH_ISSUE_TITLE, body });
    action = "updated";
  }
  for (const duplicate of duplicates) {
    await closeIssue(
      request,
      duplicate,
      `${duplicate.body || FIRST_CLASS_REFRESH_ISSUE_MARKER}\n\nSuperseded by #${canonical.number} after automated reconciliation found more than one open issue for this condition.`,
    );
  }
  return {
    action: duplicates.length && action === "unchanged" ? "deduplicated" : action,
    issue_number: canonical.number,
    duplicate_issue_numbers: duplicates.map((issue) => issue.number),
  };
}

export async function checkFirstClassRefreshHealth({
  repository = process.env.GITHUB_REPOSITORY,
  token = process.env.GITHUB_TOKEN,
  apiUrl = process.env.GITHUB_API_URL || "https://api.github.com",
  asOf = new Date().toISOString(),
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!repository || !token) throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN are required");
  const prefix = `/repos/${repository}`;
  const request = async (method, path, body = null) => {
    const response = await fetchImpl(`${apiUrl}${prefix}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`GitHub API ${method} ${path} failed: HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
  };
  const runPayload = await request("GET", "/actions/workflows/first-class-refresh.yml/runs?event=schedule&per_page=50");
  const evaluation = evaluateFirstClassRefreshHealth(runPayload.workflow_runs, { asOf });
  const failures = [];
  for (const run of evaluation.recent_failures.slice(0, 5)) {
    const jobs = await request("GET", `/actions/runs/${run.id}/jobs?per_page=100`);
    failures.push({ run, failingStep: firstFailingStep(jobs.jobs) });
  }
  const openIssues = await loadManagedFirstClassRefreshIssues(request);
  return reconcileFirstClassRefreshIssue({
    evaluation,
    failures,
    openIssues,
    request: (method, path, body) => request(method, path, body),
  });
}

async function main() {
  const result = await checkFirstClassRefreshHealth();
  console.log(`first-class refresh health: ${result.action}${result.issue_number ? ` issue=${result.issue_number}` : ""}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
