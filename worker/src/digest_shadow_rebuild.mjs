import { buildDigestShadowSummary, readDigestShadow } from "./digest_shadow.mjs";
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

const MAX_DIGEST_IDS = 100;
const MAX_DIGEST_ID_LENGTH = 160;

function iso(value) {
  return new Date(value == null ? Date.now() : value).toISOString();
}

function day(value) {
  return iso(value).slice(0, 10);
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
  return buildDigestShadowSummary({
    run: { results: [result] },
    history: [],
    now,
  });
}

async function readRun(db, runId) {
  const row = await db.prepare(`SELECT run_id, run_day, requested_digest_ids_json, status,
      total_count, completed_count, failed_count, receipt_json, error, created_at, updated_at
      FROM ${DIGEST_SHADOW_REBUILD_RUN_TABLE} WHERE run_id = ?`).bind(runId).first();
  if (!row) return null;
  return {
    ...row,
    complete: row.status === "complete",
    requested_digest_ids: JSON.parse(row.requested_digest_ids_json || "null"),
    receipt: JSON.parse(row.receipt_json || "null"),
  };
}

async function readItems(db, runId) {
  const out = await db.prepare(`SELECT run_id, digest_id, job_json, status, attempt_count,
      result_json, error, started_at, completed_at FROM ${DIGEST_SHADOW_REBUILD_ITEM_TABLE}
      WHERE run_id = ? ORDER BY digest_id`).bind(runId).all();
  return (out.results || []).map((row) => ({
    ...row,
    job: JSON.parse(row.job_json || "null"),
    result: JSON.parse(row.result_json || "null"),
  }));
}

async function updateRun(db, runId, values) {
  const fields = Object.entries(values);
  if (!fields.length) return;
  await db.prepare(`UPDATE ${DIGEST_SHADOW_REBUILD_RUN_TABLE} SET ${fields.map(([key]) => `${key} = ?`).join(", ")}
    WHERE run_id = ?`).bind(...fields.map(([, value]) => value), runId).run();
}

async function mergeCompletedSummary(env, run, items, now) {
  const current = await readDigestShadow(env.DB, { day: run.run_day });
  const base = current?.summary || {
    run_day: run.run_day,
    ran_at: iso(now),
    evaluated_count: 0,
    previews: [],
    redlines: [],
    upstream_incidents: [],
    observations: [],
    ontology_delta: null,
  };
  const touched = new Set(items.map((item) => item.digest_id));
  const targetSummaries = items.map((item) => item.result).filter(Boolean);
  const targetRedlines = targetSummaries.flatMap((summary) => summary.redlines || []);
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
  const merged = {
    ...base,
    run_day: run.run_day,
    ran_at: iso(now),
    ok: redlines.length === 0,
    status: redlines.length === 0 ? "READY" : "NEEDS_ATTENTION",
    digest_count: [...previewById.values()].length,
    total_items: [...previewById.values()].reduce((sum, preview) => sum + (Number(preview.item_count) || 0), 0),
    redlines,
    affected_digest_ids: [...new Set(redlines.map((finding) => finding.digest_id).filter((id) => id && id !== "run"))].sort(),
    upstream_incidents: upstreamIncidents,
    upstream_sources_unavailable: [...new Set(upstreamIncidents.map((item) => item.evidence?.source).filter(Boolean))].sort(),
    previews: [...previewById.values()].sort((a, b) => String(a.digest_id).localeCompare(String(b.digest_id))),
    rebuild_run_id: run.run_id,
    repair: {
      ...(base.repair || {}),
      state: redlines.length ? "dispatch_required" : "none",
      affected_digest_ids: [...new Set(redlines.map((finding) => finding.digest_id).filter((id) => id && id !== "run"))].sort(),
      rerun_method: "POST /admin/digest-shadow",
      rerun_scope: "checkpointed_digest_queue",
    },
  };
  const rawPreviews = targetSummaries.flatMap((summary) => summary._rendered_previews || []);
  const publicSummary = { ...merged };
  delete publicSummary._rendered_previews;
  const statements = [
    env.DB.prepare(`INSERT INTO digest_shadow_runs
      (run_day, ran_at, status, digest_count, total_items, summary_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_day) DO UPDATE SET ran_at = excluded.ran_at, status = excluded.status,
      digest_count = excluded.digest_count, total_items = excluded.total_items,
      summary_json = excluded.summary_json`)
      .bind(run.run_day, merged.ran_at, merged.status, merged.digest_count, merged.total_items, json(publicSummary)),
  ];
  for (const digestId of touched) {
    statements.push(env.DB.prepare(`DELETE FROM digest_shadow_previews WHERE run_day = ? AND digest_id = ?`)
      .bind(run.run_day, digestId));
  }
  for (const preview of rawPreviews) {
    statements.push(env.DB.prepare(`INSERT INTO digest_shadow_previews
      (run_day, digest_id, recipient_redacted, subject, html, item_count, watch_counts_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(run.run_day, preview.digest_id, preview.recipient_redacted, preview.subject,
        preview.html, preview.item_count, json(preview.watch_counts)));
  }
  await env.DB.batch(statements);
  merged.hold = await recordDigestShadowHoldState(env.DB, merged, { now, receiptStore: env.ALERT_STATE });
  const receipt = await recordDigestShadowReceipt(env, merged, new Date(now));
  await updateRun(env.DB, run.run_id, { receipt_json: json(receipt), updated_at: iso(now) });
  return { merged, receipt };
}

export async function createDigestShadowRebuild(env, { affectedDigestIds = null, now = new Date() } = {}) {
  if (!env?.DB?.prepare || !env?.DIGEST_SHADOW_QUEUE?.send) throw new Error("digest shadow rebuild queue unavailable");
  const requested = normalizeDigestShadowRebuildScope(affectedDigestIds);
  const at = iso(now);
  const runId = `digest-shadow-rebuild:${at}:${crypto.randomUUID()}`;
  await env.DB.prepare(`INSERT INTO ${DIGEST_SHADOW_REBUILD_RUN_TABLE}
    (run_id, run_day, requested_digest_ids_json, status, total_count, completed_count,
     failed_count, receipt_json, error, created_at, updated_at)
    VALUES (?, ?, ?, 'queued', 0, 0, 0, NULL, NULL, ?, ?)`)
    .bind(runId, day(now), json(requested), at, at).run();
  try {
    await env.DIGEST_SHADOW_QUEUE.send({ type: "expand", run_id: runId });
  } catch (error) {
    await updateRun(env.DB, runId, { status: "failed", error: String(error?.message || error), updated_at: iso(now) });
    throw error;
  }
  return { run_id: runId, status: "queued", requested_digest_ids: requested };
}

async function expandRun(env, runId, now) {
  const run = await readRun(env.DB, runId);
  if (!run || run.status === "complete" || run.status === "failed") return run;
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
  const items = await readItems(env.DB, runId);
  const failed = items.filter((item) => item.status === "failed").length;
  await updateRun(env.DB, runId, {
    status: items.length && failed === items.length ? "failed" : (items.length ? "running" : "complete"),
    total_count: items.length,
    completed_count: items.filter((item) => item.status === "complete").length,
    failed_count: failed,
    error: missing.length ? "one or more requested digest ids were not found" : null,
    updated_at: iso(now),
  });
  for (const item of items.filter((candidate) => candidate.status === "queued")) {
    await env.DIGEST_SHADOW_QUEUE.send({ type: "digest", run_id: runId, digest_id: item.digest_id });
  }
  if (!items.length) {
    const current = await readDigestShadow(env.DB, { day: run.run_day });
    if (current?.summary) {
      const receipt = await recordDigestShadowReceipt(env, { ...current.summary, rebuild_run_id: runId }, now);
      await updateRun(env.DB, runId, { receipt_json: json(receipt), updated_at: iso(now) });
    }
  }
  return readRun(env.DB, runId);
}

async function processItem(env, runId, digestId, now) {
  const run = await readRun(env.DB, runId);
  if (!run) throw new Error("digest shadow rebuild run not found");
  const item = (await readItems(env.DB, runId)).find((candidate) => candidate.digest_id === digestId);
  if (!item || item.status === "complete" || item.status === "failed") return run;
  await env.DB.prepare(`UPDATE ${DIGEST_SHADOW_REBUILD_ITEM_TABLE}
    SET status = 'running', attempt_count = attempt_count + 1, started_at = ?, error = NULL
    WHERE run_id = ? AND digest_id = ? AND status = 'queued'`)
    .bind(iso(now), runId, digestId).run();
  try {
    const summary = await runTarget(env, item.job, now);
    await env.DB.prepare(`UPDATE ${DIGEST_SHADOW_REBUILD_ITEM_TABLE}
      SET status = 'complete', result_json = ?, completed_at = ?, error = NULL
      WHERE run_id = ? AND digest_id = ?`)
      .bind(json(summary), iso(now), runId, digestId).run();
  } catch (error) {
    await env.DB.prepare(`UPDATE ${DIGEST_SHADOW_REBUILD_ITEM_TABLE}
      SET status = 'queued', error = ? WHERE run_id = ? AND digest_id = ?`)
      .bind(String(error?.message || error), runId, digestId).run();
    throw error;
  }
  const items = await readItems(env.DB, runId);
  const complete = items.filter((candidate) => candidate.status === "complete").length;
  const failed = items.filter((candidate) => candidate.status === "failed").length;
  const updated = { completed_count: complete, failed_count: failed, updated_at: iso(now) };
  if (complete + failed === items.length) {
    const finalized = await mergeCompletedSummary(env, run, items, now);
    updated.status = failed ? "failed" : "complete";
    updated.receipt_json = json(finalized.receipt);
  } else {
    updated.status = "running";
    updated.receipt_json = json(await recordDigestShadowReceipt(env, {
      ok: false,
      rebuild_run_id: runId,
      rebuild_complete: false,
    }, new Date(now)));
  }
  await updateRun(env.DB, runId, updated);
  return readRun(env.DB, runId);
}

export async function handleDigestShadowRebuildQueueMessage(env, message, { now = new Date() } = {}) {
  const body = message?.body || message || {};
  if (!body.run_id) throw new Error("digest shadow rebuild message missing run_id");
  if (body.type === "expand") return expandRun(env, body.run_id, now);
  if (body.type === "digest") return processItem(env, body.run_id, body.digest_id, now);
  throw new Error("unknown digest shadow rebuild message");
}

export async function readDigestShadowRebuildStatus(db, runId) {
  if (!db?.prepare || !runId) return null;
  const run = await readRun(db, runId);
  if (!run) return null;
  return { ...run, items: await readItems(db, runId) };
}
