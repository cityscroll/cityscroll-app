import {
  DIGEST_SHADOW_ATTENTION,
  DIGEST_SHADOW_DEGRADED_UPSTREAM,
  DIGEST_SHADOW_READY,
  applyFreshnessDegradation,
  compactDigestShadowResult,
  validateDigestShadowRun,
  validateDigestShadowTargets,
} from "./digest_shadow.mjs";
import {
  loadDigestSubscription,
  runAlerts,
  processAccountRollup,
  processOneSub,
  listDigestSubscriptions,
} from "./alerts.mjs";
import cfg from "../alerts.config.json" with { type: "json" };
import { buildDigestJobs, isWatchActive } from "./lib/rollup.mjs";
import { digestIdForJob, recordDigestShadowHoldState } from "./digest_shadow_hold.mjs";
import { recordDigestShadowReceipt } from "./reliability_watchdogs.mjs";

export const DIGEST_SHADOW_REBUILD_SCHEMA = "cityscroll.digest-shadow-rebuild.v1";
export const DIGEST_SHADOW_REBUILD_RUN_TABLE = "digest_shadow_rebuild_runs";
export const DIGEST_SHADOW_REBUILD_ITEM_TABLE = "digest_shadow_rebuild_items";

// Automatic recovery for a same-day STARTED row that never finalized (Monday-stall shape).
// Reuses the checkpointed rebuild queue; does not send subscriber mail.
export const DIGEST_SHADOW_STARTED_RECOVERY_SCHEMA = "cityscroll.digest-shadow-started-recovery.v1";
export const DIGEST_SHADOW_STARTED_RECOVERY_GRACE_MS = 12 * 60 * 1000;
export const DIGEST_SHADOW_STARTED_RECOVERY_MAX_ATTEMPTS = 3;
export const DIGEST_SHADOW_STARTED_RECOVERY_LOOKBACK_DAYS = 3;
export const DIGEST_SHADOW_STARTED_RECOVERY_BACKOFF_MS = Object.freeze([
  0,
  15 * 60 * 1000,
  45 * 60 * 1000,
]);

const MAX_DIGEST_IDS = 100;
const MAX_DIGEST_ID_LENGTH = 160;

function iso(value) {
  return new Date(value == null ? Date.now() : value).toISOString();
}

function day(value) {
  return iso(value).slice(0, 10);
}

export function startedRecoveryReceiptKey(runDay) {
  return `digest:shadow:started-recovery:${runDay}`;
}

export function isDigestShadowStartedRecoveryDisabled(env) {
  const raw = String(env?.DIGEST_SHADOW_STARTED_RECOVERY_DISABLED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/** Accept YYYY-MM-DD or default to the UTC day of `now`. */
export function normalizeRebuildRunDay(runDay, now = new Date()) {
  if (runDay == null || runDay === "") return day(now);
  const value = String(runDay).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError("run_day must be YYYY-MM-DD");
  }
  return value;
}

function lookbackDaysFrom(now, lookbackDays) {
  const today = day(now);
  const start = Date.parse(`${today}T00:00:00.000Z`);
  const out = [];
  for (let i = 0; i < lookbackDays; i += 1) {
    out.push(new Date(start - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

export async function readStartedRecoveryReceipt(store, runDay) {
  if (!store?.get) return null;
  const raw = await store.get(startedRecoveryReceiptKey(runDay));
  if (!raw) return null;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return parsed?.schema === DIGEST_SHADOW_STARTED_RECOVERY_SCHEMA ? parsed : null;
  } catch {
    return null;
  }
}

async function writeStartedRecoveryReceipt(store, receipt) {
  if (!store?.put || !receipt?.run_day) return;
  await store.put(startedRecoveryReceiptKey(receipt.run_day), JSON.stringify(receipt));
}

/**
 * Public operator view of a STARTED-recovery ALERT_STATE receipt. Allowlisted
 * fields only — never echoes subscription ids, digests, or private payloads.
 */
export function projectStartedRecoveryView(receipt) {
  if (!receipt || receipt.schema !== DIGEST_SHADOW_STARTED_RECOVERY_SCHEMA) return null;
  return {
    schema: DIGEST_SHADOW_STARTED_RECOVERY_SCHEMA,
    run_day: receipt.run_day || null,
    status: receipt.status || null,
    attempts: Number.isFinite(Number(receipt.attempts)) ? Number(receipt.attempts) : 0,
    max_attempts: Number.isFinite(Number(receipt.max_attempts))
      ? Number(receipt.max_attempts)
      : DIGEST_SHADOW_STARTED_RECOVERY_MAX_ATTEMPTS,
    last_attempt_at: receipt.last_attempt_at || null,
    next_eligible_at: receipt.next_eligible_at || null,
    rebuild_run_id: receipt.rebuild_run_id || null,
    observed_at: receipt.observed_at || null,
    recovered_at: receipt.recovered_at || null,
    escalated_at: receipt.escalated_at || null,
  };
}

/**
 * Public operator view of the day's current rebuild owner from the STARTED
 * handoff summary. Allowlisted ownership fields only.
 */
export function projectCurrentRebuildOwner(summary) {
  if (!summary || typeof summary !== "object") return null;
  if (!summary.rebuild_run_id && !summary.phase && summary.status !== "STARTED") return null;
  return {
    status: summary.status || null,
    phase: summary.phase || null,
    rebuild_run_id: summary.rebuild_run_id || null,
    rebuild_complete: summary.rebuild_complete === true,
    rebuild_finalization_id: summary.rebuild_finalization_id || null,
    progress_at: summary.progress_at || null,
  };
}

function json(value) {
  return JSON.stringify(value == null ? null : value);
}

export function normalizeDigestShadowRebuildScope(value) {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_DIGEST_IDS) {
    throw new TypeError("affected_digest_ids must be a non-empty array with at most 100 ids");
  }
  const ids = [...new Set(value.map((item) => String(item || "").trim()))];
  if (ids.some((item) => !item || item.length > MAX_DIGEST_ID_LENGTH || item === "run")) {
    throw new TypeError("affected_digest_ids contains an invalid id");
  }
  return ids.sort();
}

export async function digestShadowRebuildJobId(job) {
  if (job?.type === "static") return `watch:${job.watch?.id || ""}`;
  return digestIdForJob(job);
}

function rebuildContext(env, now) {
  const at = new Date(now);
  const today = at.toISOString().slice(0, 10);
  return {
    FROM: env.ALERTS_FROM || "CityScroll <alerts@cityscroll.org>",
    LIVE: false,
    heartbeatDays: Number(env.HEARTBEAT_DAYS) || 14,
    today,
    now: at,
    nowMs: at.getTime(),
    isMonday: at.getUTCDay() === 1,
    counts: () => ({ "per-run": 0, daily: 0 }),
    caps: { "per-run": Number.MAX_SAFE_INTEGER, daily: Number.MAX_SAFE_INTEGER },
    onSent: async () => {},
    onDryRun: async () => {},
    suppressDryRunLogs: true,
    capturePreviews: true,
    previewOnly: true,
    advanceState: false,
    heldDigestIds: new Set(),
    holdAllDigests: false,
    holdContract: null,
  };
}

async function runTarget(env, job, now) {
  const ctx = rebuildContext(env, now);
  let result;
  if (job.type === "static") {
    const output = await runAlerts({ ...env, ALERTS_LIVE: "false", QUEUE_DIGESTS: "false" }, [job.watch], {
      now: new Date(now),
      live: false,
      forceInline: true,
      suppressDryRunLogs: true,
      capturePreviews: true,
      previewOnly: true,
      advanceState: false,
      persist: false,
      simulateDryRunCounters: true,
      skipSubscriptions: true,
      skipForecastingPipelines: true,
    });
    result = output.results?.[0] || { watch: job.watch?.id || "?", skipped: "missing" };
  } else if (job.type === "rollup" && Array.isArray(job.keys)) {
    const subs = [];
    for (const key of job.keys) {
      const sub = await loadDigestSubscription(env, key);
      if (sub && isWatchActive(sub)) subs.push(sub);
    }
    result = subs.length
      ? await processAccountRollup(env, subs, ctx)
      : { sub: job.email || "account", kind: "rollup", skipped: "gone" };
  } else {
    const sub = await loadDigestSubscription(env, job.key);
    result = sub
      ? await processOneSub(env, sub, ctx)
      : { sub: job.key || "?", kind: "subscription", skipped: "gone" };
  }
  return result;
}

async function readRun(db, runId) {
  const row = await db.prepare(`SELECT run_id, run_day, requested_digest_ids_json, base_summary_json, status,
      total_count, completed_count, failed_count, receipt_json, error, created_at, updated_at
      FROM ${DIGEST_SHADOW_REBUILD_RUN_TABLE} WHERE run_id = ?`).bind(runId).first();
  if (!row) return null;
  return {
    ...row,
    complete: row.status === "complete",
    requested_digest_ids: JSON.parse(row.requested_digest_ids_json || "null"),
    base_summary: JSON.parse(row.base_summary_json || "null"),
    receipt: JSON.parse(row.receipt_json || "null"),
  };
}

async function readItems(db, runId) {
  const out = await db.prepare(`SELECT run_id, digest_id, status, attempt_count,
      result_json IS NOT NULL AS result_available, error, started_at, completed_at
      FROM ${DIGEST_SHADOW_REBUILD_ITEM_TABLE} WHERE run_id = ? ORDER BY digest_id`).bind(runId).all();
  return (out.results || []).map((row) => ({ ...row, result_available: Boolean(row.result_available) }));
}

async function readTerminalItems(db, runId) {
  const items = [];
  const contentRedlines = [];
  let after = "";
  for (;;) {
    // Keyset pagination holds at most one serialized/parsed preview at a time.
    const row = await db.prepare(`SELECT digest_id, status, result_json, error
      FROM ${DIGEST_SHADOW_REBUILD_ITEM_TABLE} WHERE run_id = ? AND digest_id > ?
      ORDER BY digest_id LIMIT 1`).bind(runId, after).first();
    if (!row) break;
    const raw = JSON.parse(row.result_json || "null");
    const identity = raw?.previewId || raw?.sub || raw?.watch || "unknown";
    if (raw?.preview && identity !== row.digest_id) {
      items.push({ digest_id: row.digest_id, status: "failed", error: "preview identity does not match checkpoint", result: null });
    } else {
      const compact = compactDigestShadowResult(raw);
      items.push({ digest_id: row.digest_id, status: row.status, error: row.error, result: compact.result });
      contentRedlines.push(...compact.contentRedlines);
    }
    after = row.digest_id;
  }
  return { items, contentRedlines };
}

// The transaction's summary CAS is also the preview-copy fence. Bodies never
// leave D1 for promotion and only metadata from the validated summary is used.
function copyPreviews(db, run, finalizationId) {
  return db.prepare(`INSERT INTO digest_shadow_previews
    (run_day, digest_id, recipient_redacted, subject, html, item_count, watch_counts_json)
    SELECT r.run_day, json_extract(p.value, '$.digest_id'),
      json_extract(p.value, '$.recipient_redacted'), json_extract(p.value, '$.subject'),
      COALESCE(json_extract(i.result_json, '$.preview.html'), ''),
      json_extract(p.value, '$.item_count'), json_extract(p.value, '$.watch_counts')
    FROM digest_shadow_runs r, json_each(r.summary_json, '$.previews') p
    JOIN ${DIGEST_SHADOW_REBUILD_ITEM_TABLE} i ON i.run_id = ?
      AND i.digest_id = json_extract(p.value, '$.digest_id')
    WHERE r.run_day = ? AND json_extract(r.summary_json, '$.rebuild_finalization_id') = ?
      AND i.status = 'complete' AND json_type(i.result_json, '$.preview') = 'object'`)
    .bind(run.run_id, run.run_day, finalizationId);
}

async function updateRun(db, runId, values) {
  const fields = Object.entries(values);
  if (!fields.length) return;
  await db.prepare(`UPDATE ${DIGEST_SHADOW_REBUILD_RUN_TABLE} SET ${fields.map(([key]) => `${key} = ?`).join(", ")}
    WHERE run_id = ?`).bind(...fields.map(([, value]) => value), runId).run();
}

async function persistMergedSideEffects(env, run, merged, now) {
  merged.hold = await recordDigestShadowHoldState(env.DB, merged, { now, receiptStore: env.ALERT_STATE });
  if (merged.hold?.write_accepted === false) return { accepted: false, merged, receipt: null };
  const receipt = await recordDigestShadowReceipt(env, merged, new Date(now));
  await updateRun(env.DB, run.run_id, { receipt_json: json(receipt), updated_at: iso(now) });
  return { accepted: true, merged, receipt };
}

async function mergeCompletedSummary(env, run, items, now, contentRedlines) {
  const evaluationNow = new Date(run.created_at);
  const currentRow = await env.DB.prepare(
    "SELECT summary_json FROM digest_shadow_runs WHERE run_day = ?",
  ).bind(run.run_day).first();
  const currentSummary = currentRow?.summary_json ? JSON.parse(currentRow.summary_json) : null;
  if (currentSummary?.rebuild_run_id === run.run_id && currentSummary?.rebuild_finalization_id) {
    return persistMergedSideEffects(env, run, { ...currentSummary }, evaluationNow);
  }
  const base = run.base_summary || {
    run_day: run.run_day,
    ran_at: iso(evaluationNow),
    evaluated_count: 0,
    previews: [],
    redlines: [],
    upstream_incidents: [],
    observations: [],
    ontology_delta: null,
  };
  const touched = new Set(items.map((item) => item.digest_id));
  const rawResults = items.map((item) => item.result).filter(Boolean);
  const fullRebuild = run.requested_digest_ids == null;
  if (fullRebuild && !run.error) {
    // A failed target is still part of the full population. Target-only fallback
    // would lose aggregate findings that a later scoped repair must preserve.
    const results = items.map((item) => item.status === "complete" && item.result ? item.result : {
      previewId: item.digest_id,
      error: `Rebuild target failed: ${item.error || "result unavailable"}`,
    });
    const validated = await validateDigestShadowRun(env, { results }, {
      now: evaluationNow, renderedContentRedlines: contentRedlines,
    });
    const finalizationId = crypto.randomUUID();
    let merged = {
      ...validated,
      phase: "finalized",
      complete: true,
      rebuild_complete: true,
      rebuild_run_id: run.run_id,
      rebuild_finalization_id: finalizationId,
      result_revision: finalizationId,
      repair: {
        ...(validated.repair || {}),
        state: "none",
        rerun_scope: "checkpointed_digest_queue",
      },
    };
    // Preserve hold / degraded-decision and advisory freshness stamped on the
    // STARTED handoff after the rebuild's base snapshot (queue stamp, freshness).
    if (currentSummary?.hold) {
      merged = { ...merged, hold: currentSummary.hold };
    }
    if (currentSummary?.freshness?.degraded) {
      merged = applyFreshnessDegradation(merged, currentSummary.freshness);
    }
    const publicSummary = { ...merged };
    delete publicSummary._rendered_previews;
    // Ownership CAS: accept when this rebuild still owns the day's STARTED
    // handoff and no other finalization has landed. Whole-JSON equality rejects
    // legitimate post-base stamps (hold, freshness, rebuild_queued fields).
    const statements = [env.DB.prepare(`INSERT INTO digest_shadow_runs
      (run_day, ran_at, status, digest_count, total_items, summary_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_day) DO UPDATE SET ran_at = excluded.ran_at, status = excluded.status,
      digest_count = excluded.digest_count, total_items = excluded.total_items,
      summary_json = excluded.summary_json
      WHERE digest_shadow_runs.status = 'STARTED'
        AND json_extract(digest_shadow_runs.summary_json, '$.rebuild_run_id') = ?
        AND json_extract(digest_shadow_runs.summary_json, '$.rebuild_finalization_id') IS NULL`)
      .bind(run.run_day, merged.ran_at, merged.status, merged.digest_count, merged.total_items,
        json(publicSummary), run.run_id)];
    statements.push(env.DB.prepare(`DELETE FROM digest_shadow_previews WHERE run_day = ?
      AND EXISTS (SELECT 1 FROM digest_shadow_runs WHERE run_day = ?
        AND json_extract(summary_json, '$.rebuild_finalization_id') = ?)`)
      .bind(run.run_day, run.run_day, finalizationId));
    statements.push(copyPreviews(env.DB, run, finalizationId));
    await env.DB.batch(statements);
    const storedRow = await env.DB.prepare(
      "SELECT summary_json FROM digest_shadow_runs WHERE run_day = ?",
    ).bind(run.run_day).first();
    const stored = storedRow?.summary_json ? JSON.parse(storedRow.summary_json) : null;
    if (stored?.rebuild_finalization_id !== finalizationId) {
      if (stored?.rebuild_run_id === run.run_id && stored?.rebuild_finalization_id) {
        return persistMergedSideEffects(env, run, { ...stored }, evaluationNow);
      }
      return { accepted: false, merged: stored, receipt: null };
    }
    return persistMergedSideEffects(env, run, merged, evaluationNow);
  }
  const targetSummaries = await validateDigestShadowTargets(env, rawResults, { now: evaluationNow, renderedContentRedlines: contentRedlines });
  const targetRedlines = [
    ...(run.error ? [{ code: "rebuild_manifest_incomplete", digest_id: "run", watch_id: null,
      reason: "The rebuild could not confirm its complete manifest.", evidence: { error: run.error } }] : []),
    ...targetSummaries.flatMap((summary) => summary.redlines || []),
    ...items.filter((item) => item.status !== "complete" || !item.result).map((item) => ({
      code: "rebuild_target_failed",
      digest_id: item.digest_id,
      watch_id: null,
      reason: "The requested digest could not be rebuilt.",
      evidence: {
        status: item.status,
        error: item.error || "result unavailable",
      },
    })),
  ];
  const targetIncidents = targetSummaries.flatMap((summary) => summary.upstream_incidents || []);
  const targetPreviews = targetSummaries.flatMap((summary) => summary.previews || []);
  const previewById = new Map((base.previews || []).map((preview) => [preview.digest_id, preview]));
  for (const preview of targetPreviews) previewById.set(preview.digest_id, preview);
  for (const digestId of touched) {
    if (!targetPreviews.some((preview) => preview.digest_id === digestId)) previewById.delete(digestId);
  }
  const redlines = [
    ...(base.redlines || []).filter((finding) => !touched.has(finding.digest_id)),
    ...targetRedlines,
  ];
  const upstreamIncidents = [
    ...(base.upstream_incidents || []).filter((incident) => !touched.has(incident.digest_id)),
    ...targetIncidents,
  ];
  const incompleteBase = (!fullRebuild && base.complete !== true) || Boolean(run.error);
  if (incompleteBase) {
    redlines.push({
      code: "rebuild_partial_incomplete_base",
      digest_id: "run",
      watch_id: null,
      reason: "A scoped repair cannot certify an incomplete full-day rehearsal.",
      evidence: { base_status: base.status || null, requested_count: touched.size },
    });
  }
  const status = redlines.length
    ? DIGEST_SHADOW_ATTENTION
    : upstreamIncidents.length
      ? DIGEST_SHADOW_DEGRADED_UPSTREAM
      : DIGEST_SHADOW_READY;
  const finalizationId = crypto.randomUUID();
  const merged = {
    ...base,
    run_day: run.run_day,
    ran_at: iso(evaluationNow),
    ok: redlines.length === 0,
    status,
    phase: incompleteBase ? "partial_rebuild" : "finalized",
    complete: !incompleteBase,
    rebuild_complete: !incompleteBase,
    digest_count: [...previewById.values()].length,
    total_items: [...previewById.values()].reduce((sum, preview) => sum + (Number(preview.item_count) || 0), 0),
    redlines,
    affected_digest_ids: [...new Set(redlines.map((finding) => finding.digest_id).filter((id) => id && id !== "run"))].sort(),
    upstream_incidents: upstreamIncidents,
    upstream_sources_unavailable: [...new Set(upstreamIncidents.map((item) => item.evidence?.source).filter(Boolean))].sort(),
    previews: [...previewById.values()].sort((a, b) => String(a.digest_id).localeCompare(String(b.digest_id))),
    rebuild_run_id: run.run_id,
    rebuild_finalization_id: finalizationId,
    result_revision: finalizationId,
    repair: {
      ...(base.repair || {}),
      state: redlines.length ? "dispatch_required" : "none",
      affected_digest_ids: [...new Set(redlines.map((finding) => finding.digest_id).filter((id) => id && id !== "run"))].sort(),
      rerun_method: "POST /admin/digest-shadow",
      rerun_scope: "checkpointed_digest_queue",
    },
  };
  delete merged.invocation_id;
  const publicSummary = { ...merged };
  delete publicSummary._rendered_previews;
  const statements = [
    env.DB.prepare(`INSERT INTO digest_shadow_runs
      (run_day, ran_at, status, digest_count, total_items, summary_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_day) DO UPDATE SET ran_at = excluded.ran_at, status = excluded.status,
      digest_count = excluded.digest_count, total_items = excluded.total_items,
      summary_json = excluded.summary_json
      WHERE digest_shadow_runs.summary_json = ?`)
      .bind(run.run_day, merged.ran_at, merged.status, merged.digest_count, merged.total_items,
        json(publicSummary), run.base_summary_json),
  ];
  for (const digestId of touched) {
    statements.push(env.DB.prepare(`DELETE FROM digest_shadow_previews WHERE run_day = ? AND digest_id = ?
      AND EXISTS (SELECT 1 FROM digest_shadow_runs WHERE run_day = ?
        AND json_extract(summary_json, '$.rebuild_finalization_id') = ?)`)
      .bind(run.run_day, digestId, run.run_day, finalizationId));
  }
  statements.push(copyPreviews(env.DB, run, finalizationId));
  await env.DB.batch(statements);
  const storedRow = await env.DB.prepare(
    "SELECT summary_json FROM digest_shadow_runs WHERE run_day = ?",
  ).bind(run.run_day).first();
  const stored = storedRow?.summary_json ? JSON.parse(storedRow.summary_json) : null;
  if (stored?.rebuild_finalization_id !== finalizationId) {
    if (stored?.rebuild_run_id === run.run_id && stored?.rebuild_finalization_id) {
      return persistMergedSideEffects(env, run, { ...stored }, evaluationNow);
    }
    return { accepted: false, merged: stored, receipt: null };
  }
  return persistMergedSideEffects(env, run, merged, evaluationNow);
}

/**
 * When an unscoped rebuild is enqueued for a STARTED, not-yet-finalized day
 * (Worker STARTED recovery or admin POST), atomically transfer day ownership to
 * that rebuild so finalize's rebuild_run_id CAS can accept it. Preserves hold
 * and freshness stamps. No-ops when the row is absent, terminal, or already
 * finalized. Does not require cron invocation_id match — recovery has none.
 */
export async function claimStartedRebuildOwnership(env, {
  runDay,
  rebuildRunId,
  now = new Date(),
} = {}) {
  if (!env?.DB?.prepare || !runDay || !rebuildRunId) {
    return { write_accepted: false, reason: "missing-args" };
  }
  const row = await env.DB.prepare(
    "SELECT status, summary_json FROM digest_shadow_runs WHERE run_day = ?",
  ).bind(runDay).first();
  if (!row || row.status !== "STARTED" || !row.summary_json) {
    return { write_accepted: false, reason: "started-row-absent" };
  }
  let summary;
  try {
    summary = JSON.parse(row.summary_json);
  } catch {
    return { write_accepted: false, reason: "started-row-unreadable" };
  }
  if (summary.rebuild_finalization_id) {
    return { write_accepted: false, reason: "already-finalized" };
  }
  if (summary.rebuild_run_id === rebuildRunId && summary.phase === "rebuild_queued") {
    return { write_accepted: true, reason: "already-owned", summary };
  }
  const next = {
    ...summary,
    status: "STARTED",
    phase: "rebuild_queued",
    progress_at: iso(now),
    rebuild_run_id: rebuildRunId,
    rebuild_complete: false,
    repair: {
      ...(summary.repair || {}),
      state: "rebuild_queued",
      affected_digest_ids: summary.repair?.affected_digest_ids || [],
      rerun_method: "POST /admin/digest-shadow",
      rerun_scope: "checkpointed_digest_queue",
      rebuild_run_id: rebuildRunId,
    },
  };
  // Keep hold / freshness / invocation_id from the prior STARTED handoff.
  const write = await env.DB.prepare(`UPDATE digest_shadow_runs SET summary_json = ?
    WHERE run_day = ? AND status = 'STARTED'
    AND json_extract(summary_json, '$.rebuild_finalization_id') IS NULL`)
    .bind(JSON.stringify(next), runDay).run();
  return {
    write_accepted: Number(write?.meta?.changes) > 0,
    summary: next,
  };
}

export async function createDigestShadowRebuild(env, {
  affectedDigestIds = null,
  now = new Date(),
  runDay = null,
} = {}) {
  if (!env?.DB?.prepare || !env?.DIGEST_SHADOW_QUEUE?.send) throw new Error("digest shadow rebuild queue unavailable");
  const requested = normalizeDigestShadowRebuildScope(affectedDigestIds);
  const targetDay = normalizeRebuildRunDay(runDay, now);
  const at = iso(now);
  // Same-day rebuilds keep the enqueue clock (existing freeze-across-midnight contract).
  // Historical-day repair freezes at that day's 10:00 UTC so Monday weekly semantics hold.
  const evaluationAt = targetDay === day(now) ? at : `${targetDay}T10:00:00.000Z`;
  const runId = `digest-shadow-rebuild:${at}:${crypto.randomUUID()}`;
  const baseRow = await env.DB.prepare(
    "SELECT summary_json FROM digest_shadow_runs WHERE run_day = ?",
  ).bind(targetDay).first();
  const baseSummaryJson = baseRow?.summary_json || null;
  await env.DB.prepare(`INSERT INTO ${DIGEST_SHADOW_REBUILD_RUN_TABLE}
    (run_id, run_day, requested_digest_ids_json, base_summary_json, status, total_count, completed_count,
     failed_count, receipt_json, error, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'queued', 0, 0, 0, NULL, NULL, ?, ?)`)
    .bind(runId, targetDay, json(requested), baseSummaryJson, evaluationAt, at).run();
  try {
    await env.DIGEST_SHADOW_QUEUE.send({ type: "expand", run_id: runId });
  } catch (error) {
    await updateRun(env.DB, runId, { status: "failed", error: String(error?.message || error), updated_at: iso(now) });
    throw error;
  }
  // Unscoped rebuilds for a STARTED day (recovery / admin POST) must own the
  // handoff before finalize; cron already stamps via markDigestShadowRebuildQueued.
  if (requested == null) {
    await claimStartedRebuildOwnership(env, {
      runDay: targetDay,
      rebuildRunId: runId,
      now,
    });
  }
  return {
    run_id: runId,
    status: "queued",
    run_day: targetDay,
    requested_digest_ids: requested,
  };
}

async function readShadowRunRow(db, runDay) {
  if (!db?.prepare || !runDay) return null;
  return db.prepare(
    "SELECT run_day, status, ran_at, summary_json FROM digest_shadow_runs WHERE run_day = ?",
  ).bind(runDay).first();
}

async function hasActiveRebuildForDay(db, runDay) {
  if (!db?.prepare || !runDay) return false;
  const row = await db.prepare(
    `SELECT run_id FROM ${DIGEST_SHADOW_REBUILD_RUN_TABLE}
      WHERE run_day = ? AND status NOT IN ('complete', 'failed')
      ORDER BY created_at DESC LIMIT 1`,
  ).bind(runDay).first();
  return Boolean(row?.run_id);
}

/**
 * When a rehearsal left STARTED past the isolate grace window, enqueue the existing
 * checkpointed rebuild queue (unscoped) with bounded retries, backoff, a kill switch,
 * receipts, and terminal escalation. Delivery policy stays fail-open; no subscriber mail.
 */
export async function recoverStalledDigestShadowRuns(env, {
  now = new Date(),
  graceMs = DIGEST_SHADOW_STARTED_RECOVERY_GRACE_MS,
  maxAttempts = DIGEST_SHADOW_STARTED_RECOVERY_MAX_ATTEMPTS,
  backoffMs = DIGEST_SHADOW_STARTED_RECOVERY_BACKOFF_MS,
  lookbackDays = DIGEST_SHADOW_STARTED_RECOVERY_LOOKBACK_DAYS,
  enqueueRebuild = createDigestShadowRebuild,
  persistFailureFn = null,
} = {}) {
  const at = new Date(now);
  const actions = [];
  if (isDigestShadowStartedRecoveryDisabled(env)) {
    return { ok: true, disabled: true, actions };
  }
  if (!env?.DB?.prepare || !env?.DIGEST_SHADOW_QUEUE?.send) {
    return { ok: false, error: "rebuild queue unavailable", actions };
  }

  const { persistDigestShadowFailure } = persistFailureFn
    ? { persistDigestShadowFailure: persistFailureFn }
    : await import("./digest_shadow.mjs");

  for (const runDay of lookbackDaysFrom(at, lookbackDays)) {
    const row = await readShadowRunRow(env.DB, runDay);
    const prior = await readStartedRecoveryReceipt(env.ALERT_STATE, runDay);

    if (!row || row.status !== "STARTED") {
      if (prior && prior.status !== "recovered" && prior.status !== "exhausted") {
        const recovered = {
          ...prior,
          schema: DIGEST_SHADOW_STARTED_RECOVERY_SCHEMA,
          status: "recovered",
          recovered_at: iso(at),
          observation: row
            ? `rehearsal for ${runDay} is now ${row.status}`
            : `rehearsal row for ${runDay} is absent`,
        };
        await writeStartedRecoveryReceipt(env.ALERT_STATE, recovered);
        actions.push({ run_day: runDay, action: "recovered", receipt: recovered });
      }
      continue;
    }

    let summary = {};
    try {
      summary = row.summary_json ? JSON.parse(row.summary_json) : {};
    } catch {
      summary = {};
    }
    const startedAtMs = Date.parse(summary.ran_at || row.ran_at || summary.progress_at || "");
    if (!Number.isFinite(startedAtMs)) {
      actions.push({ run_day: runDay, action: "skipped", reason: "started-at-unreadable" });
      continue;
    }
    if (at.getTime() - startedAtMs < graceMs) {
      actions.push({ run_day: runDay, action: "skipped", reason: "within-grace" });
      continue;
    }

    if (await hasActiveRebuildForDay(env.DB, runDay)) {
      const busy = {
        schema: DIGEST_SHADOW_STARTED_RECOVERY_SCHEMA,
        run_day: runDay,
        status: "running",
        attempts: prior?.attempts || 0,
        max_attempts: maxAttempts,
        last_attempt_at: prior?.last_attempt_at || null,
        next_eligible_at: prior?.next_eligible_at || null,
        rebuild_run_id: prior?.rebuild_run_id || null,
        observed_at: iso(at),
        observation: "an active rebuild already covers this day",
      };
      await writeStartedRecoveryReceipt(env.ALERT_STATE, busy);
      actions.push({ run_day: runDay, action: "skipped", reason: "rebuild-in-flight", receipt: busy });
      continue;
    }

    const attempts = Number(prior?.attempts) || 0;
    if (prior?.status === "exhausted" || attempts >= maxAttempts) {
      if (prior?.status !== "exhausted") {
        const failureNow = new Date(`${runDay}T12:00:00.000Z`);
        const invocationId = summary.invocation_id || null;
        let failure = null;
        if (invocationId) {
          try {
            failure = await persistDigestShadowFailure(
              env,
              new Error("started rehearsal recovery attempts exhausted"),
              { now: failureNow, invocationId },
            );
          } catch (error) {
            failure = { error: String(error?.message || error) };
          }
        }
        const exhausted = {
          schema: DIGEST_SHADOW_STARTED_RECOVERY_SCHEMA,
          run_day: runDay,
          status: "exhausted",
          attempts,
          max_attempts: maxAttempts,
          last_attempt_at: prior?.last_attempt_at || null,
          next_eligible_at: null,
          rebuild_run_id: prior?.rebuild_run_id || null,
          observed_at: iso(at),
          escalated_at: iso(at),
          failure_status: failure?.status || null,
          observation: "recovery attempts exhausted; terminal failure receipt written when owned",
        };
        await writeStartedRecoveryReceipt(env.ALERT_STATE, exhausted);
        actions.push({ run_day: runDay, action: "exhausted", receipt: exhausted });
      } else {
        actions.push({ run_day: runDay, action: "skipped", reason: "already-exhausted" });
      }
      continue;
    }

    const delay = backoffMs[Math.min(attempts, backoffMs.length - 1)] ?? backoffMs.at(-1) ?? 0;
    const lastAttemptMs = Date.parse(prior?.last_attempt_at || "");
    if (Number.isFinite(lastAttemptMs) && at.getTime() < lastAttemptMs + delay) {
      actions.push({
        run_day: runDay,
        action: "skipped",
        reason: "backoff",
        next_eligible_at: new Date(lastAttemptMs + delay).toISOString(),
      });
      continue;
    }

    try {
      const queued = await enqueueRebuild(env, {
        affectedDigestIds: null,
        now: at,
        runDay,
      });
      const nextAttempts = attempts + 1;
      const nextDelay = backoffMs[Math.min(nextAttempts, backoffMs.length - 1)] ?? backoffMs.at(-1) ?? 0;
      const receipt = {
        schema: DIGEST_SHADOW_STARTED_RECOVERY_SCHEMA,
        run_day: runDay,
        status: nextAttempts >= maxAttempts ? "queued_final" : "queued",
        attempts: nextAttempts,
        max_attempts: maxAttempts,
        last_attempt_at: iso(at),
        next_eligible_at: new Date(at.getTime() + nextDelay).toISOString(),
        rebuild_run_id: queued.run_id,
        observed_at: iso(at),
        observation: "enqueued unscoped checkpointed rebuild for stalled STARTED rehearsal",
      };
      await writeStartedRecoveryReceipt(env.ALERT_STATE, receipt);
      actions.push({ run_day: runDay, action: "enqueued", receipt, queued });
    } catch (error) {
      const failed = {
        schema: DIGEST_SHADOW_STARTED_RECOVERY_SCHEMA,
        run_day: runDay,
        status: "enqueue_failed",
        attempts: attempts + 1,
        max_attempts: maxAttempts,
        last_attempt_at: iso(at),
        next_eligible_at: new Date(at.getTime() + (backoffMs[Math.min(attempts + 1, backoffMs.length - 1)] ?? 0)).toISOString(),
        rebuild_run_id: prior?.rebuild_run_id || null,
        observed_at: iso(at),
        observation: String(error?.message || error),
      };
      await writeStartedRecoveryReceipt(env.ALERT_STATE, failed);
      actions.push({ run_day: runDay, action: "enqueue_failed", receipt: failed });
    }
  }

  return { ok: true, disabled: false, actions };
}

async function expandRun(env, runId, now) {
  const run = await readRun(env.DB, runId);
  if (!run || run.status === "complete" || run.status === "failed") return run;
  if (run.status === "running") return finalizeProgress(env, run, now);
  if (run.status !== "dispatching") {
    const claim = await env.DB.prepare(`UPDATE ${DIGEST_SHADOW_REBUILD_RUN_TABLE}
      SET status = 'expanding', updated_at = ? WHERE run_id = ? AND status IN ('queued', 'expanding')`)
      .bind(iso(now), runId).run();
    if (!(Number(claim?.meta?.changes) > 0)) return readRun(env.DB, runId);
    const subscriptions = await listDigestSubscriptions(env);
    const wanted = new Set(run.requested_digest_ids || []);
    const jobs = [];
    for (const watch of cfg.watches || []) {
      const job = { type: "static", watch };
      const digestId = await digestShadowRebuildJobId(job);
      if (!wanted.size || wanted.has(digestId)) jobs.push({ ...job, digest_id: digestId });
    }
    for (const job of buildDigestJobs(subscriptions)) {
      const digestId = await digestShadowRebuildJobId(job);
      if (!wanted.size || wanted.has(digestId)) jobs.push({ ...job, digest_id: digestId });
    }
    const knownIds = new Set(jobs.map((job) => job.digest_id));
    const missing = [...wanted].filter((id) => !knownIds.has(id));
    const statements = jobs.map((job) => env.DB.prepare(`INSERT OR IGNORE INTO ${DIGEST_SHADOW_REBUILD_ITEM_TABLE}
      (run_id, digest_id, job_json, status, attempt_count, result_json, error, started_at, completed_at)
      VALUES (?, ?, ?, 'queued', 0, NULL, NULL, NULL, NULL)`)
      .bind(runId, job.digest_id, json(job)));
    for (const digestId of missing) {
      statements.push(env.DB.prepare(`INSERT OR IGNORE INTO ${DIGEST_SHADOW_REBUILD_ITEM_TABLE}
        (run_id, digest_id, job_json, status, attempt_count, result_json, error, started_at, completed_at)
        VALUES (?, ?, ?, 'failed', 0, NULL, ?, NULL, ?)`)
        .bind(runId, digestId, json({ type: "missing", digest_id: digestId }), "digest-not-found", iso(now)));
    }
    if (statements.length) await env.DB.batch(statements);
    const sealed = await env.DB.prepare(`UPDATE ${DIGEST_SHADOW_REBUILD_RUN_TABLE}
      SET status = 'dispatching', total_count = ?, error = ?, updated_at = ?
      WHERE run_id = ? AND status = 'expanding'`)
      .bind(statements.length, missing.length ? "one or more requested digest ids were not found" : null,
        iso(now), runId).run();
    if (!(Number(sealed?.meta?.changes) > 0)) return readRun(env.DB, runId);
  }
  const items = await readItems(env.DB, runId);
  for (const item of items.filter((candidate) => candidate.status === "queued")) {
    await env.DIGEST_SHADOW_QUEUE.send({ type: "digest", run_id: runId, digest_id: item.digest_id });
  }
  await env.DB.prepare(`UPDATE ${DIGEST_SHADOW_REBUILD_RUN_TABLE} SET status = 'running', updated_at = ?
    WHERE run_id = ? AND status = 'dispatching'`).bind(iso(now), runId).run();
  return finalizeProgress(env, await readRun(env.DB, runId), now);
}

async function processItem(env, runId, digestId, now, runTargetFn = runTarget) {
  const run = await readRun(env.DB, runId);
  if (!run) throw new Error("digest shadow rebuild run not found");
  const item = await env.DB.prepare(`SELECT job_json, status FROM ${DIGEST_SHADOW_REBUILD_ITEM_TABLE}
    WHERE run_id = ? AND digest_id = ?`).bind(runId, digestId).first();
  if (!item || run.status === "complete" || run.status === "failed") return run;
  if (item.status === "complete" || item.status === "failed") return finalizeProgress(env, run, now);
  const claim = await env.DB.prepare(`UPDATE ${DIGEST_SHADOW_REBUILD_ITEM_TABLE}
    SET status = 'running', attempt_count = attempt_count + 1, started_at = ?, error = NULL
    WHERE run_id = ? AND digest_id = ? AND status IN ('queued', 'running')
    RETURNING attempt_count`)
    .bind(iso(now), runId, digestId).first();
  if (!claim) return readRun(env.DB, runId);
  const attemptCount = claim.attempt_count;
  try {
    const summary = await runTargetFn(env, JSON.parse(item.job_json), new Date(run.created_at));
    const completed = await env.DB.prepare(`UPDATE ${DIGEST_SHADOW_REBUILD_ITEM_TABLE}
      SET status = 'complete', result_json = ?, completed_at = ?, error = NULL
      WHERE run_id = ? AND digest_id = ? AND status = 'running' AND attempt_count = ?`)
      .bind(json(summary), iso(now), runId, digestId, attemptCount).run();
    if (!(Number(completed?.meta?.changes) > 0)) return readRun(env.DB, runId);
  } catch (error) {
    await env.DB.prepare(`UPDATE ${DIGEST_SHADOW_REBUILD_ITEM_TABLE}
      SET status = 'queued', error = ? WHERE run_id = ? AND digest_id = ?
      AND status = 'running' AND attempt_count = ?`)
      .bind(String(error?.message || error), runId, digestId, attemptCount).run();
    throw error;
  }
  return finalizeProgress(env, run, now);
}

async function finalizeProgress(env, run, now) {
  const runId = run.run_id;
  if (["queued", "expanding", "dispatching", "complete", "failed"].includes(run.status)) return run;
  const counts = await env.DB.prepare(`SELECT COUNT(*) AS total,
    COALESCE(SUM(status = 'complete'), 0) AS completed,
    COALESCE(SUM(status = 'failed'), 0) AS failed
    FROM ${DIGEST_SHADOW_REBUILD_ITEM_TABLE} WHERE run_id = ?`).bind(runId).first();
  const complete = counts.completed;
  const failed = counts.failed;
  if (Number(run.total_count) !== counts.total) {
    run = { ...run, error: "rebuild manifest count does not match durable items" };
  }
  const updated = { completed_count: complete, failed_count: failed, updated_at: iso(now) };
  if (complete + failed === counts.total) {
    const { items, contentRedlines } = await readTerminalItems(env.DB, runId);
    const finalized = await mergeCompletedSummary(env, run, items, now, contentRedlines);
    updated.status = finalized.accepted ? (failed || run.error ? "failed" : "complete") : "failed";
    updated.receipt_json = finalized.accepted ? json(finalized.receipt) : null;
    updated.error = finalized.accepted ? run.error : "digest shadow changed during rebuild finalization";
  } else {
    updated.status = "running";
    updated.receipt_json = json(await recordDigestShadowReceipt(env, {
      ok: false,
      rebuild_run_id: runId,
      rebuild_complete: false,
    }, new Date(now)));
  }
  await env.DB.prepare(`UPDATE ${DIGEST_SHADOW_REBUILD_RUN_TABLE} SET
    completed_count = MAX(completed_count, ?), failed_count = MAX(failed_count, ?),
    updated_at = ?, status = CASE WHEN status IN ('complete', 'failed') THEN status ELSE ? END,
    receipt_json = CASE WHEN status IN ('complete', 'failed') THEN receipt_json ELSE ? END,
    error = CASE WHEN status IN ('complete', 'failed') THEN error ELSE ? END
    WHERE run_id = ?`)
    .bind(complete, failed, updated.updated_at, updated.status, updated.receipt_json,
      updated.error ?? run.error ?? null, runId).run();
  return readRun(env.DB, runId);
}

export async function handleDigestShadowRebuildQueueMessage(env, message, {
  now = new Date(),
  runTargetFn = runTarget,
} = {}) {
  const body = message?.body || message || {};
  if (!body.run_id) throw new Error("digest shadow rebuild message missing run_id");
  if (body.type === "expand") return expandRun(env, body.run_id, now);
  if (body.type === "digest") return processItem(env, body.run_id, body.digest_id, now, runTargetFn);
  throw new Error("unknown digest shadow rebuild message");
}

// Retry exhaustion is a receipt event, never a subscriber delivery failure.
// Throw until both the durable item decision and aggregate finalization succeed.
export async function handleDigestShadowRebuildDeadLetter(env, message, { now = new Date() } = {}) {
  const body = message?.body || message || {};
  const run = await readRun(env.DB, body.run_id);
  if (!run || ["complete", "failed"].includes(run.status)) return run;
  if (body.type === "digest") {
    const cutoff = iso(new Date(new Date(now).getTime() - 20 * 60 * 1000));
    await env.DB.prepare(`UPDATE ${DIGEST_SHADOW_REBUILD_ITEM_TABLE}
      SET status = 'failed', error = 'queue retries exhausted', completed_at = ?
      WHERE run_id = ? AND digest_id = ? AND (status = 'queued'
        OR (status = 'running' AND (started_at IS NULL OR started_at < ?)))`)
      .bind(iso(now), run.run_id, body.digest_id, cutoff).run();
    const item = await env.DB.prepare(`SELECT status FROM ${DIGEST_SHADOW_REBUILD_ITEM_TABLE}
      WHERE run_id = ? AND digest_id = ?`).bind(run.run_id, body.digest_id).first();
    // A duplicate old delivery must not cancel a newer, live claim. Keep this
    // receipt retryable; cron reconciles it if the DLQ's own retries exhaust.
    if (item?.status === "running") throw new Error("digest shadow claim still active");
  } else if (body.type === "expand" || body.type === "stale") {
    if (body.type === "expand" && run.status === "running") return finalizeProgress(env, run, now);
    await env.DB.batch([
      env.DB.prepare(`UPDATE ${DIGEST_SHADOW_REBUILD_ITEM_TABLE}
        SET status = 'failed', error = 'rebuild execution exhausted', completed_at = ?
        WHERE run_id = ? AND status IN ('queued', 'running')
          AND NOT EXISTS (SELECT 1 FROM ${DIGEST_SHADOW_REBUILD_ITEM_TABLE} active
            WHERE active.run_id = ? AND active.status = 'running' AND active.started_at >= ?)`)
        .bind(iso(now), run.run_id, run.run_id, iso(new Date(new Date(now).getTime() - 20 * 60 * 1000))),
      env.DB.prepare(`UPDATE ${DIGEST_SHADOW_REBUILD_RUN_TABLE}
        SET status = 'running', error = CASE WHEN status IN ('queued', 'expanding', 'dispatching')
          THEN 'rebuild expansion exhausted before dispatch completed' ELSE error END
        WHERE run_id = ? AND status NOT IN ('complete', 'failed')`).bind(run.run_id),
    ]);
  } else {
    throw new Error("unknown digest shadow dead letter");
  }
  return finalizeProgress(env, await readRun(env.DB, run.run_id), now);
}

// D1 is the retry authority if even the DLQ consumer is interrupted. Each cron
// retries a bounded oldest set; no queue message is required to remain alive.
export async function reconcileStaleDigestShadowRebuilds(env, { now = new Date() } = {}) {
  if (!env?.DB?.prepare) return [];
  const cutoff = iso(new Date(new Date(now).getTime() - 2 * 60 * 60 * 1000));
  const out = await env.DB.prepare(`SELECT run_id FROM ${DIGEST_SHADOW_REBUILD_RUN_TABLE} r
    WHERE status NOT IN ('complete', 'failed') AND updated_at < ?
      AND NOT EXISTS (SELECT 1 FROM ${DIGEST_SHADOW_REBUILD_ITEM_TABLE} i
        WHERE i.run_id = r.run_id AND i.status = 'running' AND i.started_at >= ?)
    ORDER BY updated_at, run_id LIMIT 2`).bind(cutoff, cutoff).all();
  const results = [];
  for (const row of out.results || []) {
    results.push(await handleDigestShadowRebuildDeadLetter(env, { type: "stale", run_id: row.run_id }, { now }));
  }
  return results;
}

export async function readDigestShadowRebuildStatus(db, runId) {
  if (!db?.prepare || !runId) return null;
  const run = await readRun(db, runId);
  if (!run) return null;
  const items = await readItems(db, runId);
  const { base_summary, base_summary_json, ...publicRun } = run;
  return { ...publicRun, items };
}
