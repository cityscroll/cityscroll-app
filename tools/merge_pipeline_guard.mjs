#!/usr/bin/env node

import { readFile } from "node:fs/promises";

export const DEFAULT_STALL_MINUTES = 30;
export const DEFAULT_CANARY_MINUTES = 30;
export const BLOCKING_STATES = new Set(["DIRTY", "CONFLICTING", "BLOCKED"]);

function numberArg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

export function mergeState(pr) {
  return String(firstDefined(pr.merge_state_status, pr.mergeStateStatus, pr.mergeable_state, "UNKNOWN"))
    .toUpperCase();
}

export function isMainPullRequest(pr, baseBranch = "main") {
  return pr?.state !== "closed" && firstDefined(pr?.base?.ref, baseBranch) === baseBranch;
}

/** A ready PR is an open, non-draft PR targeting main. GitHub's merge state and
 * auto-merge request are then used to distinguish safe work from blockers. */
export function isReadyPullRequest(pr, baseBranch = "main") {
  return isMainPullRequest(pr, baseBranch) && pr.draft !== true;
}

export function hasAutoMerge(pr) {
  return Boolean(pr?.auto_merge || pr?.autoMergeRequest);
}

export function isCanaryCandidate(pr, baseBranch = "main") {
  return isMainPullRequest(pr, baseBranch) && (isReadyPullRequest(pr, baseBranch) || hasAutoMerge(pr));
}

function createdAt(pr) {
  const value = firstDefined(pr.created_at, pr.createdAt);
  return value ? new Date(value).getTime() : NaN;
}

function repositoryForHead(pr) {
  return firstDefined(pr?.head?.repo?.full_name, pr?.head?.repository?.full_name);
}

export function assessPullRequest(pr, {
  now = Date.now(),
  stallMinutes = DEFAULT_STALL_MINUTES,
  repository = null,
  baseBranch = "main",
} = {}) {
  const state = mergeState(pr);
  const ready = isReadyPullRequest(pr, baseBranch);
  const ageMs = Number.isFinite(createdAt(pr)) ? Math.max(0, now - createdAt(pr)) : null;
  const unmergedMinutes = ageMs === null ? null : Math.floor(ageMs / 60000);
  const sameRepository = !repository || !repositoryForHead(pr) || repositoryForHead(pr) === repository;
  const canUpdate = ready && state === "BEHIND" && pr.mergeable !== false && sameRepository;
  const updateBlocked = ready && state === "BEHIND" && !canUpdate;
  const aged = ready && unmergedMinutes !== null && unmergedMinutes > stallMinutes;

  return {
    number: pr.number,
    state,
    ready,
    autoMerge: hasAutoMerge(pr),
    sameRepository,
    unmergedMinutes,
    aged,
    shouldUpdate: canUpdate,
    updateBlocked,
    shouldComment: BLOCKING_STATES.has(state) || aged || updateBlocked,
  };
}

function tipDate(mainTip) {
  return firstDefined(
    mainTip?.committed_at,
    mainTip?.committedAt,
    mainTip?.commit?.commit?.committer?.date,
    mainTip?.commit?.committer?.date,
  );
}

export function assessLiveness(mainTip, prs, {
  now = Date.now(),
  canaryMinutes = DEFAULT_CANARY_MINUTES,
  baseBranch = "main",
} = {}) {
  const candidates = prs.filter((pr) => isCanaryCandidate(pr, baseBranch));
  const committedAt = tipDate(mainTip);
  const committedMs = committedAt ? new Date(committedAt).getTime() : NaN;
  const ageMinutes = Number.isFinite(committedMs) ? Math.floor(Math.max(0, now - committedMs) / 60000) : null;
  return {
    candidateCount: candidates.length,
    mainTipAt: committedAt || null,
    ageMinutes,
    stale: candidates.length > 0 && ageMinutes !== null && ageMinutes > canaryMinutes,
    unknown: candidates.length > 0 && ageMinutes === null,
  };
}

function displayList(values = [], empty = "none reported") {
  const unique = [...new Set(values.filter(Boolean))];
  return unique.length ? unique.slice(0, 8).map((value) => `\`${value}\``).join(", ") : empty;
}

export function formatBlockerComment(pr, assessment, details = {}, {
  stallMinutes = DEFAULT_STALL_MINUTES,
  updateError = null,
} = {}) {
  const marker = `<!-- merge-pipeline-guard:pr-${pr.number} -->`;
  const reasons = [];
  if (BLOCKING_STATES.has(assessment.state)) {
    reasons.push(`GitHub reports merge state **${assessment.state}**.`);
  }
  if (assessment.aged) {
    reasons.push(`This ready pull request has remained unmerged for more than ${stallMinutes} minutes.`);
  }
  if (assessment.updateBlocked) {
    reasons.push(assessment.sameRepository
      ? "The branch was not updated because GitHub did not report it as safely updateable."
      : "The branch is from another repository, so this workflow did not write to it.");
  }
  if (updateError) reasons.push(`The automatic branch update failed: ${updateError}.`);
  if (!reasons.length) reasons.push("The merge pipeline reported a blocker.");

  const actions = [];
  if (["DIRTY", "CONFLICTING"].includes(assessment.state)) {
    actions.push("Resolve the branch conflicts and push a new commit.");
  } else if (assessment.state === "BLOCKED") {
    actions.push("Address the listed check or review requirement.");
  } else if (assessment.aged) {
    actions.push("Review the merge queue and branch-protection requirements.");
  }

  return [
    "### Merge pipeline blocker",
    "",
    reasons.map((reason) => `- ${reason}`).join("\n"),
    "",
    `- Failing checks: ${displayList(details.failingChecks)}`,
    `- Pending checks: ${displayList(details.pendingChecks)}`,
    `- Requested reviews: ${displayList(details.requestedReviews)}`,
    `- Changes requested by: ${displayList(details.changesRequested)}`,
    "",
    `**Next step:** ${actions.join(" ") || "Review the current merge requirements."}`,
    "",
    marker,
  ].join("\n");
}

export function dryRunReport({ pulls, mainTip, now, stallMinutes, canaryMinutes, repository }) {
  const assessments = pulls
    .filter((pr) => isReadyPullRequest(pr))
    .map((pr) => assessPullRequest(pr, { now, stallMinutes, repository }));
  return {
    dryRun: true,
    updates: assessments.filter((assessment) => assessment.shouldUpdate).map((assessment) => assessment.number),
    comments: assessments.filter((assessment) => assessment.shouldComment).map((assessment) => ({
      number: assessment.number,
      state: assessment.state,
      aged: assessment.aged,
      updateBlocked: assessment.updateBlocked,
    })),
    canary: assessLiveness(mainTip, pulls, { now, canaryMinutes }),
  };
}

function createGitHubClient({ token, owner, repo, apiBase = "https://api.github.com" }) {
  if (!token) throw new Error("GITHUB_TOKEN is required for live runs");
  const base = `${apiBase.replace(/\/$/, "")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  async function request(path, options = {}) {
    const response = await fetch(`${base}${path}`, {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(options.headers || {}),
      },
    });
    const body = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = body?.message ? `: ${body.message}` : "";
      throw new Error(`GitHub API ${response.status} ${options.method || "GET"} ${path}${detail}`);
    }
    return body;
  }
  async function paginate(path) {
    const rows = [];
    for (let page = 1; ; page += 1) {
      const result = await request(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      const pageRows = Array.isArray(result) ? result : result?.items || [];
      rows.push(...pageRows);
      if (pageRows.length < 100) return rows;
    }
  }
  return {
    listOpenPulls: () => paginate("/pulls?state=open&base=main&sort=updated&direction=desc"),
    getBranch: () => request("/branches/main"),
    getChecks: (sha) => request(`/commits/${encodeURIComponent(sha)}/check-runs`),
    getStatus: (sha) => request(`/commits/${encodeURIComponent(sha)}/status`),
    listReviews: (number) => paginate(`/pulls/${number}/reviews`),
    listComments: (number) => paginate(`/issues/${number}/comments`),
    updateBranch: (number, expectedHeadSha) => request(`/pulls/${number}/update-branch`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expected_head_sha: expectedHeadSha, update_method: "merge" }),
    }),
    createComment: (number, body) => request(`/issues/${number}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    }),
    updateComment: (commentId, body) => request(`/issues/comments/${commentId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    }),
  };
}

function checkDetails(checks, statuses, reviews, pr) {
  const checkRuns = checks?.check_runs || [];
  const failingChecks = checkRuns
    .filter((check) => ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(String(check.conclusion).toUpperCase()))
    .map((check) => `${check.name}: ${String(check.conclusion).toLowerCase()}`);
  const pendingChecks = checkRuns
    .filter((check) => check.status && check.status !== "completed")
    .map((check) => `${check.name}: ${check.status}`);
  for (const status of statuses?.statuses || []) {
    if (["failure", "error"].includes(status.state)) failingChecks.push(`${status.context}: ${status.state}`);
    if (status.state === "pending") pendingChecks.push(`${status.context}: pending`);
  }
  const latestByReviewer = new Map();
  for (const review of reviews || []) latestByReviewer.set(review.user?.login || review.user?.id, review);
  const changesRequested = [...latestByReviewer.values()]
    .filter((review) => review.state === "CHANGES_REQUESTED")
    .map((review) => review.user?.login || "reviewer");
  const requestedReviews = (pr.requested_reviewers || []).map((reviewer) => reviewer.login || reviewer.name);
  return { failingChecks, pendingChecks, requestedReviews, changesRequested };
}

async function readBlockerDetails(api, pr, log) {
  const [checks, statuses, reviews] = await Promise.all([
    api.getChecks(pr.head.sha).catch((error) => { log(`warning: checks unavailable for #${pr.number}: ${error.message}`); return {}; }),
    api.getStatus(pr.head.sha).catch((error) => { log(`warning: statuses unavailable for #${pr.number}: ${error.message}`); return {}; }),
    api.listReviews(pr.number).catch((error) => { log(`warning: reviews unavailable for #${pr.number}: ${error.message}`); return []; }),
  ]);
  return checkDetails(checks, statuses, reviews, pr);
}

async function upsertComment(api, pr, body) {
  const marker = `merge-pipeline-guard:pr-${pr.number}`;
  const comments = await api.listComments(pr.number);
  const existing = comments.find((comment) => String(comment.body || "").includes(marker));
  if (existing?.body === body) return "unchanged";
  if (existing) {
    await api.updateComment(existing.id, body);
    return "updated";
  }
  await api.createComment(pr.number, body);
  return "created";
}

function mainTipFromBranch(branch) {
  return { commit: branch?.commit, committed_at: branch?.commit?.commit?.committer?.date };
}

export async function runGuard({ api, now = Date.now(), dryRun = false, stallMinutes = DEFAULT_STALL_MINUTES, canaryMinutes = DEFAULT_CANARY_MINUTES, repository = null, log = console.log } = {}) {
  const pulls = await api.listOpenPulls();
  const branch = await api.getBranch();
  const mainTip = mainTipFromBranch(branch);
  const evaluations = [];
  for (const pr of pulls) {
    if (!isReadyPullRequest(pr)) continue;
    const assessment = assessPullRequest(pr, { now, stallMinutes, repository });
    let updateError = null;
    if (assessment.shouldUpdate) {
      if (dryRun) log(`dry-run: would update #${pr.number} from main without force-pushing`);
      else {
        try {
          await api.updateBranch(pr.number, pr.head.sha);
          log(`updated #${pr.number} from main`);
        } catch (error) {
          updateError = error.message;
          log(`warning: could not update #${pr.number}: ${updateError}`);
        }
      }
    }
    const shouldComment = assessment.shouldComment || updateError;
    if (shouldComment) {
      const details = dryRun ? {} : await readBlockerDetails(api, pr, log);
      const body = formatBlockerComment(pr, assessment, details, { stallMinutes, updateError });
      if (dryRun) log(`dry-run: would ${assessment.shouldComment ? "comment on" : "report update failure for"} #${pr.number}`);
      else log(`comment ${await upsertComment(api, pr, body)} on #${pr.number}`);
    }
    evaluations.push({ ...assessment, updateError });
  }
  const canary = assessLiveness(mainTip, pulls, { now, canaryMinutes });
  if (canary.stale) {
    const message = `Liveness canary: ${canary.candidateCount} ready or auto-merge PR(s) exist, while main's tip has not advanced for more than ${canaryMinutes} minutes.`;
    if (dryRun) log(`dry-run: ${message}`);
    else log(`::error title=Merge pipeline liveness::${message}`);
  } else if (canary.unknown) {
    log("warning: liveness canary could not determine the main tip commit time");
  }
  return { evaluations, canary, failed: canary.stale && !dryRun };
}

async function runFixture(path, now, stallMinutes, canaryMinutes, repository) {
  const fixture = JSON.parse(await readFile(path, "utf8"));
  return dryRunReport({
    pulls: fixture.pulls || [],
    mainTip: fixture.main_tip || {},
    now,
    stallMinutes,
    canaryMinutes,
    repository,
  });
}

async function main() {
  const dryRun = process.argv.includes("--dry-run") || String(process.env.DRY_RUN || "").toLowerCase() === "true";
  const stallMinutes = numberArg("--stall-minutes", Number(process.env.STALL_MINUTES) || DEFAULT_STALL_MINUTES);
  const canaryMinutes = numberArg("--canary-minutes", Number(process.env.CANARY_MINUTES) || DEFAULT_CANARY_MINUTES);
  const fixtureIndex = process.argv.indexOf("--fixture");
  const nowArg = process.argv.indexOf("--now") >= 0 ? process.argv[process.argv.indexOf("--now") + 1] : null;
  const now = nowArg ? new Date(nowArg).getTime() : Date.now();
  const repository = process.env.GITHUB_REPOSITORY || null;

  if (fixtureIndex >= 0) {
    const report = await runFixture(process.argv[fixtureIndex + 1], now, stallMinutes, canaryMinutes, repository);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const [owner, repo] = String(process.env.GITHUB_REPOSITORY || "").split("/");
  const api = createGitHubClient({ token: process.env.GITHUB_TOKEN, owner, repo, apiBase: process.env.GITHUB_API_URL });
  const result = await runGuard({ api, now, dryRun, stallMinutes, canaryMinutes, repository });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => { console.error(error?.stack || error); process.exitCode = 1; });
}
