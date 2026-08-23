// Daily land upcoming-hearings snapshot derived from already-materialized
// zap-outcome:v1 records plus the SODA sell-facing id list. A polite live ZAP
// sweep does not run here — that is the 13:00 prewarm. This job fits Worker
// cron CPU: SODA list + KV reads + a bounded fill of missing ids.

import {
  LAND_HEARING_SWEEP_STATUSES,
  buildUpcomingHearingsSnapshot,
  detectSyntheticUpcomingHearings,
  hearingsFromZapOutcomeRecord,
} from "../../tools/lib/land_upcoming_hearings.mjs";
import {
  LAND_UPCOMING_HEARINGS_KV_KEY,
  landUpcomingHearingsStale,
  loadLandUpcomingHearingsSnapshot,
} from "./lib/land_upcoming_hearings_kv.mjs";
import {
  listPrewarmProjectIds,
  prewarmOneZapOutcome,
  readZapOutcomeRecord,
  ZAP_PREWARM_DEMO_IDS,
} from "./zap_outcomes.mjs";

export { LAND_UPCOMING_HEARINGS_KV_KEY };

/** Cap of missing zap-outcome fills so a cold KV does not start a 235-project ZAP sweep. */
export const LAND_UPCOMING_HEARINGS_FILL_MAX = 40;
/** Skip the KV write when coverage would hide the committed floor. */
export const LAND_UPCOMING_HEARINGS_MIN_COVERAGE = 0.5;
const LAND_UPCOMING_HEARINGS_LIST_MAX = 500;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function response(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": status === 200 ? "public, max-age=1800" : "no-store",
    },
  });
}

function emptyMilestoneReview() {
  return {
    published_meeting_dates_evaluated: 0,
    hearing_shaped_candidates_reviewed: 0,
    accepted_by_class: {},
    reviewed_false_positive_sample: [],
  };
}

function mergeMilestoneReview(target, next) {
  target.published_meeting_dates_evaluated += next?.published_meeting_dates_evaluated || 0;
  target.hearing_shaped_candidates_reviewed += next?.hearing_shaped_candidates_reviewed || 0;
  for (const [eventClass, count] of Object.entries(next?.accepted_by_class || {})) {
    target.accepted_by_class[eventClass] = (target.accepted_by_class[eventClass] || 0) + count;
  }
  for (const row of next?.reviewed_false_positive_sample || []) {
    const key = `${row.project_id}|${row.source_title}|${row.meeting_date}`;
    if (target.reviewed_false_positive_sample.some((item) => (
      `${item.project_id}|${item.source_title}|${item.meeting_date}` === key
    ))) continue;
    if (target.reviewed_false_positive_sample.length >= 12) break;
    target.reviewed_false_positive_sample.push(row);
  }
  return target;
}

export async function refreshLandUpcomingHearings(env, {
  fetchImpl = fetch,
  now = new Date(),
  fillMissingMax = LAND_UPCOMING_HEARINGS_FILL_MAX,
  minCoverage = LAND_UPCOMING_HEARINGS_MIN_COVERAGE,
  build,
} = {}) {
  if (!env?.ALERT_STATE || typeof env.ALERT_STATE.put !== "function") {
    return { status: "skipped", reason: "no-kv" };
  }
  const listed = await listPrewarmProjectIds({
    fetchImpl,
    statuses: LAND_HEARING_SWEEP_STATUSES,
    max: LAND_UPCOMING_HEARINGS_LIST_MAX,
    demoIds: ZAP_PREWARM_DEMO_IDS,
  });
  const records = [];
  const missing = [];
  for (const projectId of listed) {
    const record = await readZapOutcomeRecord(env, projectId);
    if (record) records.push(record);
    else missing.push(projectId);
  }

  let filled = 0;
  const nowMs = now.getTime();
  // Fill only when some outcomes already exist — a fully cold KV must not start
  // a ZAP API sweep that would hide the committed floor behind a short snapshot.
  if (records.length && missing.length) {
    for (const projectId of missing) {
      if (filled >= fillMissingMax) break;
      const result = await prewarmOneZapOutcome(env, projectId, {
        nowMs,
        ...(build ? { build } : {}),
      });
      filled += 1;
      if (result.status === "computed" || result.status === "skipped") {
        const record = await readZapOutcomeRecord(env, projectId);
        if (record) records.push(record);
      }
    }
  }

  const hearings = [];
  const milestoneReview = emptyMilestoneReview();
  for (const record of records) {
    const extracted = hearingsFromZapOutcomeRecord(record);
    hearings.push(...extracted.hearings);
    mergeMilestoneReview(milestoneReview, extracted.milestone_review);
  }
  const fromKv = records.length;
  const failed = Math.max(0, listed.length - fromKv);

  const listedCount = listed.length;
  const coverage = listedCount ? fromKv / listedCount : 0;
  if (!fromKv || (listedCount >= 20 && coverage < minCoverage)) {
    return {
      status: "skipped",
      reason: "insufficient-outcomes",
      projects_listed: listedCount,
      projects_from_kv: fromKv,
      projects_filled: filled,
      projects_failed: failed,
      coverage,
    };
  }

  const snapshot = buildUpcomingHearingsSnapshot(hearings, {
    mode: "kv_zap_outcomes",
    today: now.toISOString().slice(0, 10),
    generated_at: now.toISOString(),
    projects_listed: listedCount,
    projects_fetched: fromKv,
    projects_failed: failed,
    statuses: LAND_HEARING_SWEEP_STATUSES.slice(),
    polite_delay_ms: null,
    milestone_review: milestoneReview,
  });
  const detection = detectSyntheticUpcomingHearings(snapshot);
  if (!detection.ok) {
    return {
      status: "skipped",
      reason: "detector",
      findings: detection.findings,
    };
  }
  await env.ALERT_STATE.put(LAND_UPCOMING_HEARINGS_KV_KEY, JSON.stringify(snapshot));
  return {
    status: "success",
    upcoming_count: snapshot.hearings.length,
    projects_listed: listedCount,
    projects_from_kv: fromKv,
    projects_filled: filled,
    projects_failed: failed,
    generated_at: snapshot.generated_at,
  };
}

export async function handleLandUpcomingHearings(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method !== "GET") {
    return response(JSON.stringify({ ok: false, reason: "method" }), 405);
  }
  const loaded = await loadLandUpcomingHearingsSnapshot(env);
  return response(JSON.stringify({
    ...loaded.record,
    stale: landUpcomingHearingsStale(loaded.record),
  }));
}
