import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveCredential } from "./lib/credential_files.mjs";
import {
  UNCHANGED_OBSERVATION,
  appendDigestShadowMonitorObservation,
  digestShadowObservationFingerprint,
  findingSeverity,
  lastObservationPath,
  observationFromCycle,
  observationMarker,
  stateObservationPath,
} from "./digest_shadow_monitor_observation.mjs";

export const DIGEST_SHADOW_READY_STATUS = "READY";
export const DIGEST_SHADOW_DEGRADED_UPSTREAM_STATUS = "DEGRADED_UPSTREAM";
export const DIGEST_SHADOW_UPSTREAM_ISSUE_TITLE = "Digest shadow source is unavailable";

function adminKey() {
  return resolveCredential({
    inlineVars: ["CITYSCROLL_ADMIN_KEY", "ADMIN_KEY"],
    fileVars: ["CITYSCROLL_ADMIN_KEY_FILE"],
  });
}

function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
  if (typeof value !== "string") return value;
  return value.replace(/([?&](?:token|s)=)[^&\s]+/gi, "$1[redacted]").replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]");
}

function issueBody(result) {
  return `${result.body || "The independent correctness monitor reported a failure."}\n\nObserved at: ${result.observed_at}`;
}

function issueIntent(job, result, mode, extra = {}) {
  const issue = {
    mode,
    title: extra.title || job.issue_title,
    title_aliases: extra.title_aliases || [],
    body_contains: extra.body_contains || [],
    body: issueBody(result),
  };
  if (extra.observation_marker) issue.observation_marker = extra.observation_marker;
  return issue;
}

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

async function recordDigestShadowCycle(job, context, {
  result,
  fingerprint = null,
  marker = null,
  commentWritten = false,
  commentSuppressed = null,
}) {
  await mkdir(join(context.stateDir, "jobs", job.id), { recursive: true });
  if (fingerprint) {
    await writeFile(lastObservationPath(context.stateDir, job.id), `${JSON.stringify({
      fingerprint,
      marker,
      run_key: context.runKey,
      observed_at: result.observed_at,
    }, null, 2)}\n`, "utf8");
  }
  const observation = observationFromCycle({
    runKey: context.runKey,
    result,
    commentWritten,
    commentSuppressed,
  });
  const paths = [stateObservationPath(context.stateDir, job.id)];
  if (context.observationPath) paths.push(context.observationPath);
  for (const path of [...new Set(paths)]) {
    await appendDigestShadowMonitorObservation(path, observation, { now: context.now });
  }
  return observation;
}

/** Probe GET /admin/digest-shadow and decide whether to open, comment, or stay quiet. */
export async function runDigestShadowJob(job, context) {
  const url = process.env.CITYSCROLL_DIGEST_SHADOW_URL || "https://api.cityscroll.org/admin/digest-shadow";
  const fetchImpl = context.fetchImpl || globalThis.fetch;
  const key = adminKey();
  if (!key) {
    const result = {
      observed_at: context.now.toISOString(),
      status: "degraded",
      http_status: null,
      degraded_reason: "admin-credential-missing",
      summary: {},
      finding_severity: "attention",
      comment_written: true,
      comment_suppressed: null,
      body: "The digest shadow probe has no admin credential, so the rehearsal was not contacted. This is a scheduler configuration fault, not an upstream failure.",
    };
    const fingerprint = digestShadowObservationFingerprint({}, { degraded_reason: "admin-credential-missing" });
    await recordDigestShadowCycle(job, context, {
      result,
      fingerprint,
      marker: observationMarker(fingerprint),
      commentWritten: true,
    });
    return { result, issue: issueIntent(job, result, "open", { title: "Digest shadow probe has no admin credential" }) };
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
  const fingerprint = digestShadowObservationFingerprint(summary, { degraded_reason: degradedReason });
  const observationMark = observationMarker(fingerprint);
  const previousPath = lastObservationPath(context.stateDir, job.id);
  let previous = null;
  try { previous = JSON.parse(await readFile(previousPath, "utf8")); } catch { previous = null; }
  const opening = !(healthy || upstream);
  const unchanged = Boolean(previous?.fingerprint && previous.fingerprint === fingerprint);
  const commentWritten = opening && !unchanged;
  const commentSuppressed = opening && unchanged ? UNCHANGED_OBSERVATION : null;
  const severity = findingSeverity({ healthy, summary, opening });
  const result = {
    observed_at: context.now.toISOString(),
    status: healthy ? "healthy" : "degraded",
    http_status: response.status,
    degraded_reason: degradedReason,
    fault_domain: healthy ? null : upstream ? "upstream_source" : unreachable ? "rehearsal_reachability" : "digest_build",
    summary: sanitize(summary),
    finding_severity: severity,
    comment_written: commentWritten,
    comment_suppressed: commentSuppressed,
    body: digestShadowIssueBody({ healthy, upstream, unreachable, observed, redlines, incidents, report }),
  };
  const digestFinding = {
    ...result,
    body: upstream
      ? "The digest shadow rehearsal found no fault in the digest. This finding is closed; the source that did not answer is reported separately."
      : result.body,
  };
  const intents = [{
    result: digestFinding,
    issue: issueIntent(job, digestFinding, healthy || upstream ? "close" : "open", {
      observation_marker: observationMark,
    }),
  }];
  if (upstream) {
    intents.push({
      result,
      issue: issueIntent(job, result, "open", { title: DIGEST_SHADOW_UPSTREAM_ISSUE_TITLE }),
    });
  } else if (!unreachable) {
    const clearedSource = {
      ...result,
      body: "Every source the digest shadow rehearsal reads answered on this run.",
    };
    intents.push({
      result: clearedSource,
      issue: issueIntent(job, clearedSource, "close", { title: DIGEST_SHADOW_UPSTREAM_ISSUE_TITLE }),
    });
  }
  await recordDigestShadowCycle(job, context, {
    result: digestFinding,
    fingerprint,
    marker: observationMark,
    commentWritten,
    commentSuppressed,
  });
  return { result, intents };
}
