#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdir, readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const OUTBOX_SCHEMA = "cityscroll.external-schedule-outbox.v1";

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObject(value[key])]));
}

export function stableJson(value) {
  return JSON.stringify(sortObject(value));
}

export function eventId(jobId, runKey) {
  return createHash("sha256").update(`${jobId}\n${runKey}`).digest("hex").slice(0, 32);
}

export function markerFor(event) {
  return `<!-- cityscroll-external-schedule:${event.job_id}:${event.run_key} -->`;
}

async function atomicWrite(path, value) {
  await mkdir(join(path, ".."), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
}

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

function eventFor({ jobId, runKey, result, issue }) {
  return {
    schema: OUTBOX_SCHEMA,
    event_id: eventId(jobId, runKey),
    job_id: jobId,
    run_key: runKey,
    observed_at: result.observed_at,
    result,
    issue: { ...issue, marker: markerFor({ job_id: jobId, run_key: runKey }) },
    status: "pending",
    attempts: 0,
    created_at: new Date().toISOString(),
  };
}

/** Persist one observation and its one replayable issue intent. Re-running the same
 * scheduled slot replaces the same result/event instead of creating a duplicate. */
export async function persistScheduleResult({ stateDir, jobId, runKey, eventRunKey = runKey, result, issue }) {
  const resultPath = join(stateDir, "results", jobId, `${runKey.replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`);
  const event = eventFor({ jobId, runKey: eventRunKey, result, issue });
  const eventPath = join(stateDir, "outbox", `${event.event_id}.json`);
  const previous = await readJson(eventPath);
  if (previous?.status === "delivered") {
    event.status = "delivered";
    event.delivered_at = previous.delivered_at;
  }
  await atomicWrite(resultPath, { schema: OUTBOX_SCHEMA, job_id: jobId, run_key: runKey, ...result });
  await atomicWrite(eventPath, event);
  return { resultPath, eventPath, event };
}

function issueMatches(issue, descriptor) {
  if (!issue || issue.pull_request) return false;
  const titles = [descriptor.title, ...(descriptor.title_aliases || [])].filter(Boolean);
  if (titles.includes(issue.title)) return true;
  return (descriptor.body_contains || []).some((needle) => String(issue.body || "").includes(needle));
}

async function commentAlreadyExists(github, issueNumber, marker) {
  const comments = await github.listComments(issueNumber);
  return comments.some((comment) => String(comment.body || "").includes(marker));
}

function withMarker(body, marker) {
  return `${body || ""}\n\n${marker}`.trim();
}

/** Apply one issue intent. Markers make create-comment and close replay safe after
 * a timeout that may have happened after GitHub accepted the mutation. */
export async function applyIssueIntent(github, issue) {
  if (!issue || issue.mode === "none") return { action: "noop" };
  const openIssues = await github.listIssues({ state: "open" });
  if (issue.mode === "close-recovered") {
    const candidates = openIssues.filter((candidate) => {
      if (candidate.pull_request) return false;
      const titleMatch = issue.title_prefix && String(candidate.title || "").startsWith(issue.title_prefix);
      const aliasMatch = (issue.title_aliases || []).includes(candidate.title);
      return titleMatch || aliasMatch;
    });
    let closed = 0;
    for (const candidate of candidates) {
      const ids = [...new Set([
        ...[...String(candidate.title || "").matchAll(/drift: ([a-z0-9-]+)/g)].map((match) => match[1]),
        ...[...String(candidate.body || "").matchAll(/(?:error|ok) ([a-z0-9-]+):/g)].map((match) => match[1]),
      ])];
      if (!ids.length || !ids.every((id) => issue.healthy_ids.includes(id))) continue;
      if (!(await commentAlreadyExists(github, candidate.number, issue.marker))) {
        await github.createComment(candidate.number, withMarker(issue.body, issue.marker));
      }
      await github.updateIssue(candidate.number, { state: "closed", state_reason: "completed" });
      closed += 1;
    }
    return closed ? { action: "closed", closed_count: closed } : { action: "already-recovered" };
  }
  const existing = openIssues.find((candidate) => issueMatches(candidate, issue));
  if (issue.mode === "open") {
    if (!existing) {
      const created = await github.createIssue({ title: issue.title, body: withMarker(issue.body, issue.marker) });
      return { action: "created", issue_number: created.number };
    }
    // The create request may have succeeded before the network timed out. The
    // marker is stored in the issue body as well as comments so that replay
    // does not turn that ambiguous outcome into a duplicate comment.
    if (String(existing.body || "").includes(issue.marker)) {
      return { action: "already-recorded", issue_number: existing.number };
    }
    if (await commentAlreadyExists(github, existing.number, issue.marker)) {
      return { action: "already-recorded", issue_number: existing.number };
    }
    await github.createComment(existing.number, withMarker(issue.body, issue.marker));
    return { action: "commented", issue_number: existing.number };
  }
  if (issue.mode === "close") {
    if (!existing) return { action: "already-recovered" };
    if (!(await commentAlreadyExists(github, existing.number, issue.marker))) {
      await github.createComment(existing.number, withMarker(issue.body, issue.marker));
    }
    await github.updateIssue(existing.number, { state: "closed", state_reason: "completed" });
    return { action: "closed", issue_number: existing.number };
  }
  throw new Error(`unsupported issue intent mode: ${issue.mode}`);
}

export function createGitHubClient({ token, owner, repo, apiBase = "https://api.github.com", fetchImpl = fetch }) {
  if (!token) return null;
  const base = `${apiBase.replace(/\/$/, "")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  async function request(path, options = {}) {
    const response = await fetchImpl(`${base}${path}`, {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(options.headers || {}),
      },
    });
    if (!response.ok) throw new Error(`GitHub API ${response.status} ${options.method || "GET"} ${path}`);
    return response.status === 204 ? null : response.json();
  }
  return {
    listIssues: ({ state = "open" } = {}) => request(`/issues?state=${state}&per_page=100`),
    listComments: (number) => request(`/issues/${number}/comments?per_page=100`),
    createIssue: ({ title, body }) => request("/issues", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, body }),
    }),
    createComment: (number, body) => request(`/issues/${number}/comments`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body }),
    }),
    updateIssue: (number, patch) => request(`/issues/${number}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
    }),
  };
}

export async function replayOutbox({ stateDir, github }) {
  if (!github) return { status: "offline", delivered: 0, pending: 0, errors: [] };
  const outboxDir = join(stateDir, "outbox");
  await mkdir(outboxDir, { recursive: true });
  const names = (await readdir(outboxDir)).filter((name) => name.endsWith(".json")).sort();
  const summary = { status: "ok", delivered: 0, pending: 0, errors: [] };
  for (const name of names) {
    const path = join(outboxDir, name);
    const event = await readJson(path);
    if (!event || event.status === "delivered") continue;
    try {
      const result = await applyIssueIntent(github, event.issue);
      await atomicWrite(path, { ...event, status: "delivered", delivered_at: new Date().toISOString(), attempts: event.attempts + 1, replay: result });
      summary.delivered += 1;
    } catch (error) {
      summary.status = "degraded";
      summary.pending += 1;
      summary.errors.push(`${event.job_id}: ${error?.message || String(error)}`);
      await atomicWrite(path, { ...event, attempts: event.attempts + 1, last_error: error?.message || String(error) });
    }
  }
  return summary;
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  process.stdout.write("external_schedule_outbox.mjs is a library; use external_schedule_runner.mjs\n");
}
