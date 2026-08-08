// alerts — scheduled daily digest. The Worker's `scheduled` handler (cron in
// wrangler.toml: "0 13 * * *") calls runAlerts().
//
// It re-runs each saved query — both the legacy alerts.config.json watches AND every confirmed
// self-serve subscription in SUBS KV (compileSub maps {lens,filter} → a City Record / ZAP query)
// — diffs results against last run (Workers KV), and emails any NEW notices to the subscriber's
// OWN address via Resend (REST, no SDK), with a one-click unsubscribe.
//
// SAFETY: never sends mail "as James." The From is the app's own domain (ALERTS_FROM);
// the To is the subscriber's opted-in address from the config. DRY-RUN by default —
// only sends when env.ALERTS_LIVE === "true". Until then it just logs what it would send.
//
// SPEND GUARDS: MAX_PER_RUN + MAX_SENDS_PER_DAY (KV-counted) bound how much this can ever
// send, so a bug, a test, or a stuffed config can't run up a bill. A capped watch DEFERS to
// the next run (left unseen) rather than dropping its notices silently. The guard itself is
// the `sendcap` package (a pure "may I make one more paid action?" decision).

import cfg from "../alerts.config.json" with { type: "json" };
import { capDecision } from "@jimdc/sendcap";
import { signToken, listUnsubscribe } from "optin-token";
import { issueEmailSessionToken } from "./session.mjs";
import { compileSub, vendorStem } from "./lib/compile.mjs";
import { compileSub_d1, toDigestRow, OFF_MIRROR_LENSES } from "./lib/compile_d1.mjs";
import { buildNoticesQuery, searchNotices } from "./lib/notices.mjs";
import { describeFilter } from "./lib/confirm_email.mjs";
import { emailT } from "./lib/i18n.mjs";
import { digestDecision, dedupeFreshByContent, shortDate, matchEvidence } from "./lib/digest.mjs";
import { itemAwarenessHtml } from "./lib/digest_item_awareness.mjs";
import {
  groupDigestRowsByActionBand,
  rulesActionBandLabel,
} from "./lib/rules_action_bands.mjs";
import { encodeWatchFilter } from "./lib/filter.mjs";
import { runCheckbookPipeline } from "./checkbook.mjs";
import { runMocsPlanPipeline } from "./mocs_plan.mjs";
import { bumpStatAllTime, bumpCategoryStat, bumpHistDay } from "./lib/stats.mjs";
import { emitUsageEvent } from "./lib/analytics.mjs";
import { nextSearchHealth, searchHealthStatus, alertsFixUrl, searchHealthNoteHtml } from "./lib/search_health.mjs";
import { currentAwardCandidates } from "./external_award.mjs";
import { redactEmail, normalizeEmail } from "./lib/subscriptions.mjs";
import {
  digestDayLogKey,
  buildDayLog,
  toDayLogEntry,
  mergeDayLogEntry,
} from "./lib/digest_ops.mjs";
import {
  groupSubsByEmail,
  shouldRollup,
  buildDigestJobs,
  isWatchActive,
  rollupSendDecision,
  rollupSubject,
  rollupBodySections,
  toRollupDayLogEntry,
  accountLogId,
  sectionWantsSend,
} from "./lib/rollup.mjs";
import { prefsLink } from "./prefs.mjs";
import { RULES_KV_KEY } from "./rules.mjs";
import { reconcileTemporalCandidates } from "./lib/alert_temporal.mjs";
import { evaluatePropertyWatch, propertyWatchStageLabel } from "./lib/property_saved_watch.mjs";
import { groupDistrictDigestRows } from "../../site/district_weekly_digest.mjs";
import { landProjectDisplayTitle } from "../../site/display_title.mjs";
import { normalizeHearing } from "./lib/hearings.mjs";
import {
  forecastSentIdentity,
  forecastIsDeliverableOn,
} from "./lib/contract_forecast_predictions.mjs";
import {
  completeDigestShadowRecovery,
  digestShadowId,
  isDigestHeld,
  partitionDigestJobsByHold,
  resolveDigestShadowHold,
} from "./digest_shadow_hold.mjs";

// A sent digest's category breakdown for the all-time stats: one bump per distinct City
// Record section_name it carried (falling back to the watch's lens for sections without
// one, e.g. land/ZAP notices). Counts topics touched per digest, not per notice row.
async function bumpDigestCategories(env, rows, fallbackCategory) {
  const cats = new Set(rows.map((r) => r.section_name || fallbackCategory).filter(Boolean));
  for (const c of cats) await bumpCategoryStat(env.ALERT_STATE, "digest", c);
}

// ---- durable per-run receipt (ALERT_STATE) ---------------------------------
// Digest operational keys live under sendcount:/seen:/lastsent:/sent:/digest:run:* /
// digest:daylog:* — deliberately disjoint from usage dual-write keys (stats:usage_*,
// stats:page_view, stats:catday:*, stats:alert_confirmed) so a list-prefix scan or
// exact get can never confuse a page-view counter with a send cap or last-sent clock.
export const DIGEST_RUN_LATEST_KEY = "digest:run:latest";

export function digestRunDayKey(day) {
  return `digest:run:${day}`;
}
export { digestDayLogKey };

/** District presets are honest-absent: no all-empty weekly filler email. */
export function subDigestDecision({ lens, freshCount, freq, lastSentDate, today, heartbeatDays } = {}) {
  if (lens === "district") return { action: Number(freshCount) > 0 ? "match" : "none" };
  return digestDecision({ freshCount, freq, lastSentDate, today, heartbeatDays });
}

// Collapse one cron (or queue-consumer aggregate) into a public, low-cardinality receipt.
// A silent skip must leave a non-null skipped_reason — never an empty "looks like nothing ran."
export function summarizeDigestRun({ ranAt, day, live, mode, sentThisRun, sentToday, results = [], enqueued = 0 } = {}) {
  const tallies = {
    matched: 0,
    sent: 0,
    dry_run: 0,
    capped: 0,
    errors: 0,
    skipped_weekly: 0,
    skipped_quiet: 0,
    skipped_other: 0,
    enqueued: Number(enqueued) || 0,
  };
  for (const r of results) {
    if (!r || typeof r !== "object") continue;
    if (r.mode === "queue") {
      tallies.enqueued = Number(r.enqueued) || tallies.enqueued;
      continue;
    }
    if (r.error) { tallies.errors++; continue; }
    if (r.capped) tallies.capped++;
    const fresh = Number(r.new) || 0;
    const forecasts = Number(r.forecasts) || 0;
    if (fresh > 0 || forecasts > 0 || r.action === "match") tallies.matched++;
    if (r.sent) tallies.sent++;
    else if (r.dryRun) tallies.dry_run++;
    else if (r.skipped === "weekly") tallies.skipped_weekly++;
    else if (r.action === "none") tallies.skipped_quiet++;
    else if (r.skipped || r.action === "weekly-empty" || r.action === "heartbeat") {
      // weekly-empty/heartbeat without send are counted above when dry/capped; remaining skips
      if (!r.capped && !r.dryRun) tallies.skipped_other++;
    } else if (!r.sent && !r.capped && underWantsSend(r)) {
      tallies.skipped_other++;
    }
  }
  // Prefer the live counters when present (inline path advances them); fall back to tallies.
  const sent = Number.isFinite(sentThisRun) ? sentThisRun : tallies.sent;
  const matched = tallies.matched;
  let skipped_reason = null;
  if (mode === "queue" && tallies.enqueued > 0 && sent === 0 && tallies.errors === 0 && tallies.matched === 0) {
    // Cron only enqueued — consumers have not reported final outcomes yet.
    skipped_reason = "queue_pending";
  } else if (sent > 0) {
    skipped_reason = null;
  } else if (results.some((result) => result?.skipped === "shadow-hold")
    && results.every((result) => result?.mode === "queue" || result?.skipped === "shadow-hold")) {
    skipped_reason = "shadow_hold";
  } else if (tallies.errors > 0) {
    skipped_reason = "errors";
  } else if (tallies.capped > 0 && matched > 0) {
    skipped_reason = "capped";
  } else if (tallies.dry_run > 0) {
    skipped_reason = "dry_run";
  } else if (matched === 0 && tallies.skipped_quiet > 0) {
    skipped_reason = "all_quiet";
  } else if (matched === 0 && tallies.enqueued === 0 && results.length === 0) {
    skipped_reason = "no_subscriptions";
  } else if (matched === 0) {
    skipped_reason = "no_matches";
  } else {
    skipped_reason = "skipped";
  }
  return {
    ranAt: ranAt || new Date().toISOString(),
    day: day || null,
    live: !!live,
    mode: mode || "inline",
    matched,
    sent,
    sentToday: Number.isFinite(sentToday) ? sentToday : sent,
    enqueued: tallies.enqueued,
    skipped_reason,
    tallies,
  };
}

function underWantsSend(r) {
  return r.action === "match" || r.action === "heartbeat" || r.action === "weekly-empty" || (Number(r.new) || 0) > 0;
}

async function writeDigestRunReceipt(env, receipt) {
  if (!env?.ALERT_STATE || !receipt) return;
  try {
    const body = JSON.stringify(receipt);
    const puts = [env.ALERT_STATE.put(DIGEST_RUN_LATEST_KEY, body)];
    if (receipt.day) puts.push(env.ALERT_STATE.put(digestRunDayKey(receipt.day), body));
    await Promise.all(puts);
  } catch {
    // Receipt is observability, not load-bearing for delivery — never break the cron.
  }
}

// Per-subscription day log: which digests went out, which notices, and zero-match
// rows so quiet days stay visible. Fail-soft — never break the cron.
export async function writeDigestDayLog(env, dayLog) {
  if (!env?.ALERT_STATE || !dayLog?.day) return;
  try {
    await env.ALERT_STATE.put(digestDayLogKey(dayLog.day), JSON.stringify(dayLog));
  } catch {
    /* observability only */
  }
}

export async function readDigestDayLog(env, day) {
  if (!env?.ALERT_STATE || !day) return null;
  try {
    const raw = await env.ALERT_STATE.get(digestDayLogKey(day));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function appendQueueDayLogEntry(env, day, jobResult) {
  if (!env?.ALERT_STATE || !day || !jobResult) return;
  try {
    const entry = jobResult.kind === "rollup"
      ? toRollupDayLogEntry(jobResult, { day })
      : toDayLogEntry(jobResult, { day });
    if (!entry) return;
    const key = digestDayLogKey(day);
    let existing = null;
    try { existing = JSON.parse((await env.ALERT_STATE.get(key)) || "null"); } catch { existing = null; }
    const merged = mergeDayLogEntry(existing, entry, {
      day,
      ranAt: new Date().toISOString(),
      live: true,
      mode: "queue",
    });
    await env.ALERT_STATE.put(key, JSON.stringify(merged));
  } catch {
    /* observability only */
  }
}

export async function readDigestRunReceipt(env) {
  if (!env?.ALERT_STATE) return null;
  try {
    const raw = await env.ALERT_STATE.get(DIGEST_RUN_LATEST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// Queue consumers merge their final outcome into the day's receipt so a silent zero after
// fan-out cannot hide behind "queue_pending" forever.
async function recordQueueJobOutcome(env, day, jobResult) {
  if (!env?.ALERT_STATE || !day || !jobResult) return;
  try {
    const key = digestRunDayKey(day);
    let base = null;
    try { base = JSON.parse((await env.ALERT_STATE.get(key)) || "null"); } catch { base = null; }
    if (!base || typeof base !== "object") {
      base = {
        ranAt: new Date().toISOString(),
        day,
        live: true,
        mode: "queue",
        matched: 0,
        sent: 0,
        sentToday: await getSendCount(env, day),
        enqueued: 0,
        skipped_reason: null,
        tallies: {
          matched: 0, sent: 0, dry_run: 0, capped: 0, errors: 0,
          skipped_weekly: 0, skipped_quiet: 0, skipped_other: 0, enqueued: 0,
          jobs_done: 0,
        },
      };
    }
    const t = base.tallies || (base.tallies = {});
    t.jobs_done = (Number(t.jobs_done) || 0) + 1;
    if (jobResult.error) t.errors = (Number(t.errors) || 0) + 1;
    else {
      const fresh = Number(jobResult.new) || 0;
      const forecasts = Number(jobResult.forecasts) || 0;
      if (fresh > 0 || forecasts > 0 || jobResult.action === "match") t.matched = (Number(t.matched) || 0) + 1;
      if (jobResult.capped) t.capped = (Number(t.capped) || 0) + 1;
      if (jobResult.sent) t.sent = (Number(t.sent) || 0) + 1;
      else if (jobResult.dryRun) t.dry_run = (Number(t.dry_run) || 0) + 1;
      else if (jobResult.skipped === "weekly") t.skipped_weekly = (Number(t.skipped_weekly) || 0) + 1;
      else if (jobResult.action === "none") t.skipped_quiet = (Number(t.skipped_quiet) || 0) + 1;
      else if (!jobResult.sent && !jobResult.skipped) t.skipped_other = (Number(t.skipped_other) || 0) + 1;
    }
    base.matched = Number(t.matched) || 0;
    base.sent = Number(t.sent) || 0;
    base.sentToday = await getSendCount(env, day);
    base.updatedAt = new Date().toISOString();
    // Re-derive skipped_reason from the aggregate so /stats always has an explicit reason.
    if (base.sent > 0) base.skipped_reason = null;
    else if ((Number(t.errors) || 0) > 0) base.skipped_reason = "errors";
    else if ((Number(t.capped) || 0) > 0 && base.matched > 0) base.skipped_reason = "capped";
    else if ((Number(t.dry_run) || 0) > 0) base.skipped_reason = "dry_run";
    else if (base.matched === 0 && (Number(t.skipped_quiet) || 0) > 0) base.skipped_reason = "all_quiet";
    else if (base.matched === 0) base.skipped_reason = "no_matches";
    else base.skipped_reason = "skipped";
    // Clear queue_pending once any job has finished reporting.
    if (base.skipped_reason === "queue_pending") base.skipped_reason = "no_matches";
    const body = JSON.stringify(base);
    await Promise.all([
      env.ALERT_STATE.put(key, body),
      env.ALERT_STATE.put(DIGEST_RUN_LATEST_KEY, body),
    ]);
  } catch {
    /* observability only */
  }
}

const SODA = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";
const REQ_URL = (id) => `https://a856-cityrecord.nyc.gov/RequestDetail/${encodeURIComponent(id)}`;
const RETRYABLE_SODA_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 524]);
const SODA_RETRY_DELAY_MS = 250;

export async function runDigestShadowRecoveryCatchUp(env, shadowHold, {
  now = new Date(),
  runCatchUpFn = runCatchUpDigests,
} = {}) {
  if (!shadowHold?.catch_up_required) return null;
  const result = await runCatchUpFn(env, { minLagDays: 1 });
  const incomplete = (result?.results || []).filter((item) => item?.error || item?.capped);
  if (incomplete.length) {
    throw new Error(`digest shadow recovery catch-up incomplete for ${incomplete.length} subscription(s)`);
  }
  if (result?.live !== true) {
    return { result, receipt: null, pending: true };
  }
  const receipt = await completeDigestShadowRecovery(env.ALERT_STATE, {
    now,
    recoveryOf: shadowHold.recovery_of,
    catchUp: {
      candidates: Number(result?.candidates) || 0,
      sent: Number(result?.sentThisRun) || 0,
      live: result?.live === true,
    },
  });
  console.error("digest shadow recovery catch-up:", JSON.stringify(receipt));
  return { result, receipt };
}

export async function runAlerts(env, watches = cfg.watches || [], options = {}) {
  const FROM = env.ALERTS_FROM || "CityScroll <alerts@cityscroll.org>";
  const LIVE = options.live == null ? env.ALERTS_LIVE === "true" : options.live === true;
  const maxPerRun = Number(env.MAX_PER_RUN) || 25;            // most emails one cron firing may send
  const maxPerDay = Number(env.MAX_SENDS_PER_DAY) || 50;      // daily ceiling, kept below Resend's free 100/day
  const heartbeatDays = Number(env.HEARTBEAT_DAYS) || 14;     // quiet days before a daily sub gets a liveness ping
  const now = options.now == null ? new Date() : new Date(options.now);
  const day = now.toISOString().slice(0, 10);
  const shadowHold = options.shadowHoldState || (options.capturePreviews
    ? null
    : await resolveDigestShadowHold(env.DB, {
      now,
      persist: true,
      receiptStore: env.ALERT_STATE,
    }));
  const heldDigestIds = new Set(shadowHold?.active_digest_ids || []);
  const holdAllDigests = shadowHold?.delivery_policy === "ALL_DIGESTS_HELD";
  const shadowRecovery = options.capturePreviews
    ? null
    : await runDigestShadowRecoveryCatchUp(env, shadowHold, { now });
  let sentToday = await getSendCount(env, day);
  let sentThisRun = 0;
  const results = [];

  // Refresh Checkbook renewal estimates and purge disabled MOCS plan caches.
  try {
    await runMocsPlanPipeline(env);
    const subs = await subWatches(env);
    await runCheckbookPipeline(env, watches, subs);
  } catch (e) {
    console.error("alerts: forecasting pipelines error:", e);
  }


  for (const w of watches) {
    const watchDigestId = `watch:${w.id}`;
    if (isDigestHeld(shadowHold, watchDigestId)) {
      results.push({
        watch: w.id,
        kind: "config_watch",
        skipped: "shadow-hold",
        action: "none",
        sent: false,
        holdContract: shadowHold.contract,
      });
      continue;
    }
    try {
      const rows = await runWatch(w);
      const seen = await getSeen(env, w.id);
      const fresh = dedupeFreshByContent(rows.filter((r) => r.request_id && !seen.has(r.request_id)));

      const { allow: underCap, capped } = capDecision({
        want: fresh.length > 0 && !!w.email,
        counts: { "per-run": sentThisRun, daily: sentToday },
        caps: { "per-run": maxPerRun, daily: maxPerDay },
      });
      const send = underCap && LIVE;

      let preview = null;
      if (underCap) {
        const subject = `CityScroll: ${fresh.length} new for "${w.label}"`;
        const html = digestHtml(w, fresh);
        const listUnsub = listUnsubscribe(FROM, w.id);
        const payload = emailPayload(env, FROM, w.email, subject, html, listUnsub);
        if (options.capturePreviews) {
          preview = { subject, html, listUnsubscribe: listUnsub || null };
        }
        if (send) {
          await sendEmail(env, FROM, w.email, subject, html, listUnsub);
          sentThisRun++; sentToday++;
          await setSendCount(env, day, sentToday);
          await bumpStatAllTime(env.ALERT_STATE, "digest");
          await bumpHistDay(env.ALERT_STATE, "digest", now);
          await bumpDigestCategories(env, fresh, w.type);
          emitUsageEvent(env, { event: "digest_sent", lens: w.type, surface: "email" });
        } else {
          // ALERTS_LIVE dry-run: render full payload, never call Resend / never bump counters.
          logDryRunEmail(payload);
          if (options.simulateDryRunCounters) { sentThisRun++; sentToday++; }
        }
      }

      // Mark seen ONLY on a real send — never advance the seen set when the email wasn't
      // delivered (dry-run, cap-deferred, or any path where send stays false). Marking on
      // observe rather than on delivery was the watermark-poisoning bug: a run with no send
      // silently swallowed fresh notices so the next run treated them as already-seen.
      if (send && rows.length) await markSeen(env, w.id, rows.map((r) => r.request_id).filter(Boolean));

      results.push({
        watch: w.id,
        ...(options.capturePreviews ? { previewId: `watch:${w.id}` } : {}),
        lens: w.type || null,
        queryLabel: w.label || w.id,
        emailRedacted: w.email ? redactEmail(w.email) : null,
        found: rows.length,
        new: fresh.length,
        noticeIds: fresh.map((r) => r.request_id).filter(Boolean).slice(0, 100),
        action: fresh.length > 0 ? "match" : "none",
        zeroMatch: fresh.length === 0,
        sent: send,
        capped,
        dryRun: underCap && !LIVE,
        ...(preview ? { preview } : {}),
      });
    } catch (e) {
      results.push({
        watch: w.id,
        ...(options.capturePreviews ? { previewId: watchDigestId } : {}),
        error: String(e?.message || e),
      });
    }
  }

  // ---- replay confirmed subscriptions from SUBS KV (the self-serve path) ----
  // Account-level rollup: when an email has >1 active watch, one consolidated email
  // (sections per watch). One rollup email = one send unit. Single-watch emails keep
  // the per-watch path. Paused watches are skipped for delivery (still listed in prefs).
  //
  // Two delivery modes:
  //   inline (default): group by email, process rollup or single per account.
  //   queue  (QUEUE_DIGESTS="true" + DIGEST_QUEUE bound): one job per account
  //   (type rollup | sub); the DAILY cap remains the hard spend ceiling.
  const today = day;
  const isMonday = now.getUTCDay() === 1;
  const ctx = {
    FROM, LIVE, heartbeatDays, today, isMonday,
    counts: () => ({ "per-run": options.queueCapSemantics ? 0 : sentThisRun, daily: sentToday }),
    caps: { "per-run": maxPerRun, daily: maxPerDay },
    onSent: async () => { sentThisRun++; sentToday++; await setSendCount(env, day, sentToday); },
    onDryRun: options.simulateDryRunCounters ? async () => { sentThisRun++; sentToday++; } : null,
    capturePreviews: options.capturePreviews === true,
    advanceState: options.advanceState,
    heldDigestIds,
    holdAllDigests,
    holdContract: shadowHold?.contract || null,
  };
  let mode = "inline";
  let enqueued = 0;
  const allSubs = await subWatches(env);
  if (!options.forceInline && env.QUEUE_DIGESTS === "true" && env.DIGEST_QUEUE) {
    mode = "queue";
    const jobs = buildDigestJobs(allSubs);
    const partition = await partitionDigestJobsByHold(jobs, shadowHold);
    for (const job of partition.eligible) {
      await env.DIGEST_QUEUE.send(job);
      enqueued++;
    }
    for (const held of partition.held) {
      results.push({
        sub: "digest:held",
        kind: held.job.type === "rollup" ? "rollup" : "subscription",
        skipped: "shadow-hold",
        action: "none",
        sent: false,
        holdContract: shadowHold.contract,
      });
    }
    results.push({ mode: "queue", enqueued });
  } else {
    const byEmail = groupSubsByEmail(allSubs);
    for (const [, list] of byEmail) {
      const active = list.filter(isWatchActive);
      if (active.length === 0) continue;
      if (shouldRollup(list)) {
        results.push(await processAccountRollup(env, active, ctx));
      } else {
        results.push(await processOneSub(env, active[0], ctx));
      }
    }
  }

  const deferred = results.filter((r) => r.capped).length;
  if (deferred) console.warn(`alerts: ${deferred} watch(es) deferred by send caps (perRun=${maxPerRun}, perDay=${maxPerDay})`);
  const ranAt = now.toISOString();
  const receipt = summarizeDigestRun({
    ranAt, day, live: LIVE, mode, sentThisRun, sentToday, results, enqueued,
  });
  if (options.persist !== false) await writeDigestRunReceipt(env, receipt);
  // Day log carries per-sub notice ids + zero-match rows for the ops dashboard.
  // Queue mode only has the fan-out stub here; consumers append via mergeDayLogEntry.
  if (options.persist !== false) {
    if (mode !== "queue") {
      await writeDigestDayLog(env, buildDayLog({
        day,
        ranAt,
        live: LIVE,
        mode,
        results,
        shadowHoldDecision: shadowHold?.degraded_receipt || shadowRecovery?.receipt || null,
      }));
    } else {
      // Seed an empty/queue daylog so the day is present even before consumers finish.
      await writeDigestDayLog(env, buildDayLog({
        day,
        ranAt,
        live: LIVE,
        mode,
        results: [],
        shadowHoldDecision: shadowHold?.degraded_receipt || shadowRecovery?.receipt || null,
      }));
    }
  }
  const summary = {
    ranAt,
    live: LIVE,
    sentThisRun,
    sentToday,
    caps: { perRun: maxPerRun, perDay: maxPerDay },
    shadowHold: shadowHold ? {
      contract: shadowHold.contract,
      source_status: shadowHold.source_status,
      delivery_policy: shadowHold.delivery_policy,
      active_count: heldDigestIds.size,
      hold_all: holdAllDigests,
      expires_at: shadowHold.expires_at,
      degraded_receipt: shadowHold.degraded_receipt || null,
    } : null,
    shadowRecovery,
    receipt,
    results,
  };
  const logSummary = options.capturePreviews
    ? { ...summary, results: results.map(({ preview: _preview, ...result }) => result) }
    : summary;
  console.log("alerts run:", JSON.stringify(logSummary));
  return summary;
}

// One subscription, end to end: compile → fetch → forecasts → confidence decision →
// cap check → send → bookkeeping. ctx supplies identity, caps, counters, and clock so
// the inline loop and the queue consumer share this logic exactly.
//
// For multi-watch accounts use processAccountRollup() instead — one email, one send unit.
export async function processOneSub(env, s, ctx) {
  const digestId = await digestShadowId("digest", s.key);
  const previewId = ctx.capturePreviews ? digestId : null;
  if (ctx.holdAllDigests || ctx.heldDigestIds?.has(digestId)) {
    return {
      sub: maskKey(s.key),
      kind: "subscription",
      skipped: "shadow-hold",
      action: "none",
      sent: false,
      holdContract: ctx.holdContract,
    };
  }
  try {
    if (s.paused) return { sub: maskKey(s.key), skipped: "paused", kind: "subscription" };
    if (s.freq === "weekly" && !ctx.isMonday) return { sub: maskKey(s.key), skipped: "weekly", kind: "subscription" };
    // Award-arrival watches are one-notice, one-shot-per-award content, not a standing notices
    // query — they never run through compileSub()/digestDecision()'s heartbeat/weekly-empty
    // logic (a "still nothing" ping would contradict the whole point of a silent watch). See
    // processAwardSub() below.
    if (s.lens === "award") return processAwardSub(env, s, ctx);
    const q = compileSub(s, ctx.today);
    if (!q) return { sub: maskKey(s.key), skipped: `lens:${s.lens}` };

    const forecasts = await matchForecasts(env, s, ctx.today);

    // D1 fast path: use the notices mirror when DB is bound and its cursor is within 2 days
    // of today (mirror is fresh). Falls back to the live-SODA path on any failure or when the
    // mirror is stale — graceful degradation per the mission rule.
    // land/ZAP lenses are NOT in the D1 mirror and always use the SODA path (explicit, not accidental).
    let rows;
    let usedD1 = false;
    if (env.DB && !OFF_MIRROR_LENSES.has(s.lens)) {
      try {
        const fresh = await isMirrorFresh(env.DB, ctx.today);
        if (fresh) {
          const d1 = compileSub_d1(s, ctx.today);
          if (d1) {
            const { results: d1Rows } = await (async () => {
              const { sql, params } = buildNoticesQuery(d1.opts);
              const res = await env.DB.prepare(sql).bind(...params).all();
              return res;
            })();
            let mapped = (d1Rows ?? []).map(toDigestRow);
            if (d1.postFilter) mapped = mapped.filter(d1.postFilter);
            rows = mapped;
            usedD1 = true;
          }
        }
      } catch (e) {
        console.warn("alerts: D1 fast path failed, falling back to SODA:", String(e?.message || e));
      }
    }
    if (!usedD1) {
      rows = await fetchRows(q.url, q.params, q.transformRows);
      if (q.postFilter && s.lens !== "property") rows = rows.filter(q.postFilter); // property needs the full parcel stream for stage transitions
    }
    const seen = await getSeen(env, s.key);
    let propertyStageSeenIds = [];
    if (s.lens === "property") {
      const evaluated = evaluatePropertyWatch(rows, s.filter, seen, ctx.today);
      rows = evaluated.rows;
      propertyStageSeenIds = evaluated.markSeenIds;
    }
    const rulesView = s.lens === "rules" ? await readJsonKv(env.ALERT_STATE, RULES_KV_KEY) : null;
    const reconciled = reconcileTemporalCandidates({ lens: s.lens, rows, seen, rulesView, idField: q.idField });
    reconciled.markSeenIds.push(...propertyStageSeenIds);
    for (const row of rows) {
      if (row.property_watch?.transition && !reconciled.fresh.some((freshRow) => freshRow.request_id === row.request_id)) reconciled.fresh.push(row);
    }
    const fresh = dedupeFreshByContent(reconciled.fresh);

    // Search health: has this watch matched anything new lately? Judged from `fresh` alone (not
    // forecasts — those are a different kind of content), and recorded on the sub's own SUBS
    // record regardless of the send decision below, so email caps/quiet-heartbeat pacing never
    // distort the underlying "is the query itself still finding anything" signal.
    const matched = fresh.length > 0;
    const health = nextSearchHealth(s.health, matched, ctx.today);
    const healthStatus = searchHealthStatus({ health, createdAt: s.createdAt, today: ctx.today });
    if (ctx.advanceState !== false) await saveSubHealth(env, s, health);

    // Confidence: decide whether to break silence (a weekly check-in or a daily heartbeat) even
    // with no fresh notices, so a quiet inbox never looks like a broken alert. `since` = when we
    // last emailed this sub (falls back to signup), rendered as "since <date>".
    const since = (await getLastSent(env, s.key)) || s.createdAt || null;
    const effectiveCount = fresh.length + forecasts.length;
    const decision = subDigestDecision({ lens: s.lens, freshCount: effectiveCount, freq: s.freq, lastSentDate: since, today: ctx.today, heartbeatDays: ctx.heartbeatDays });

    const { allow: underCap, capped } = capDecision({
      want: (decision.action !== "none" || forecasts.length > 0) && !!s.email,
      counts: ctx.counts(),
      caps: ctx.caps,
    });
    const send = underCap && ctx.LIVE;

    let manageUrlPresent = false;
    let preview = null;
    if (underCap) {
      const label = describeFilter(s.lens, s.filter);
      const unsubUrl = await unsubLink(env, s.key);
      let subject, html;

      const lang = s.lang || "en";
      const hasActivity = fresh.length > 0 || forecasts.length > 0;
      // Never its own email — it only ever rides a digest that's sending anyway — and never
      // shown alongside a real match (matched===true always resets healthStatus.quiet to false).
      const healthNote = healthStatus.quiet
        ? searchHealthNoteHtml({ lang, quietDays: healthStatus.quietDays, url: alertsFixUrl(s.lens, s.filter, s.freq) })
        : "";
      const manageUrl = await prefsLink(env, s.email);
      manageUrlPresent = !!manageUrl;
      if (hasActivity) {
        const freshLabel = fresh.length > 0 ? `${fresh.length} new` : "";
        const forecastLabel = forecasts.length > 0 ? `${forecasts.length} forecast(s)` : "";
        const parts = [freshLabel, forecastLabel].filter(Boolean).join(" & ");
        subject = `CityScroll: ${parts} — ${label}`;
        const keywords = Array.isArray(s.filter && s.filter.keywords) ? s.filter.keywords : [];
        // w12-12: carry this watch's own {lens, filter} into every notice link so the site can
        // re-render the same Matched-evidence + interpretation-echo the subscriber would see
        // running the watch themselves. null for a watch with nothing worth carrying (e.g. a
        // bare amount-only bigaward watch's minAmount alone still round-trips — see
        // encodeWatchFilter()) or a lens deep-links don't cover (rezone links straight to ZAP
        // below, never through here).
        const w = encodeWatchFilter(s.lens, s.filter);
        // Pins-scoped magic-link token: every notice link carries it so a click
        // quietly recognizes the browser (session cookie) without a login form.
        const sessionTok = await issueEmailSessionToken(env, s.email);
        html = subDigestHtml(label, q.kind, fresh, unsubUrl, since, env.CONFIRM_BASE || "https://api.cityscroll.org", forecasts, lang, keywords, w, healthNote, sessionTok, manageUrl);
      } else {
        subject = decision.action === "weekly-empty"
          ? `CityScroll: nothing new this week — ${label}`
          : `CityScroll: still watching — ${label}`;
        html = quietHtml(label, decision.action, since, unsubUrl, lang, healthNote, manageUrl);
      }
      const payload = emailPayload(env, ctx.FROM, s.email, subject, html, `<${unsubUrl}>`, true);
      if (ctx.capturePreviews) preview = { subject, html, listUnsubscribe: `<${unsubUrl}>` };
      if (send) {
        await sendEmail(env, ctx.FROM, s.email, subject, html, `<${unsubUrl}>`, true);
        await ctx.onSent();
        if (ctx.advanceState !== false) {
          await setLastSent(env, s.key, ctx.today);   // only on a real send, so the heartbeat clock tracks actual email
          await bumpStatAllTime(env.ALERT_STATE, "digest");
          await bumpHistDay(env.ALERT_STATE, "digest", new Date());
          if (fresh.length) await bumpDigestCategories(env, fresh, s.lens);
          emitUsageEvent(env, { event: "digest_sent", lens: s.lens, surface: "email" });
        }
      } else {
        // ALERTS_LIVE dry-run: render full payload, never call Resend / never bump counters.
        logDryRunEmail(payload);
        if (ctx.onDryRun) await ctx.onDryRun();
      }
    }

    // Mark seen ONLY on a real send — advancing the seen set without delivery was the
    // watermark-poisoning bug (dry-run, quiet, or any path where send stays false).
    if (send && ctx.advanceState !== false && reconciled.markSeenIds.length) {
      await markSeen(env, s.key, reconciled.markSeenIds);
    }
    // Multi-day lag after a delivery outage: stamp traffic_class so desk ops can exempt
    // day-scoped phantom_send without treating a normal daily match as recovery.
    // Email copy stays the normal daily subject/body (not catch-up branded).
    const lagRecovery = isMultiDayLagRecovery(since, ctx.today, fresh.length);
    return {
      sub: maskKey(s.key),
      ...(previewId ? { previewId } : {}),
      kind: "subscription",
      lens: s.lens,
      queryLabel: describeFilter(s.lens, s.filter),
      emailRedacted: redactEmail(s.email),
      found: rows.length,
      new: fresh.length,
      noticeIds: fresh.map((r) => r[q.idField]).filter(Boolean).slice(0, 100),
      forecasts: forecasts.length,
      action: decision.action,
      traffic_class: lagRecovery ? "catch_up" : null,
      zeroMatch: fresh.length === 0 && forecasts.length === 0 && decision.action === "none",
      sent: send,
      dryRun: underCap && !ctx.LIVE,
      manageUrlPresent,
      capped,
      sendUnits: send || (underCap && !ctx.LIVE) ? 1 : 0,
      ...(preview ? { preview } : {}),
    };
  } catch (e) {
    return { sub: maskKey(s.key), ...(previewId ? { previewId } : {}), kind: "subscription", error: String(e?.message || e) };
  }
}

/**
 * Account-level digest rollup: evaluate every active watch for one email, then
 * send at most one consolidated HTML email. Counts as one send unit.
 *
 * Preference-center edits (pause/freq/keywords) take effect next cron because
 * this always reads the current SUBS records.
 */
export async function processAccountRollup(env, subs, ctx) {
  const email = normalizeEmail(subs?.[0]?.email || "");
  const accountId = accountLogId(email);
  const digestId = await digestShadowId("digest", (subs || []).map((sub) => sub.key).sort().join("|"));
  const previewId = ctx.capturePreviews ? digestId : null;
  if (ctx.holdAllDigests || ctx.heldDigestIds?.has(digestId)) {
    return {
      sub: accountId,
      kind: "rollup",
      emailRedacted: redactEmail(email),
      skipped: "shadow-hold",
      action: "none",
      sent: false,
      holdContract: ctx.holdContract,
    };
  }
  if (!email || !subs?.length) {
    return { sub: accountId, ...(previewId ? { previewId } : {}), kind: "rollup", skipped: "empty", emailRedacted: redactEmail(email) };
  }

  try {
    const sections = [];
    let manageUrlPresent = false;
    let preview = null;
    for (const s of subs) {
      if (!isWatchActive(s)) {
        sections.push({
          sub: maskKey(s.key),
          subKey: s.key,
          lens: s.lens,
          queryLabel: describeFilter(s.lens, s.filter),
          skipped: "paused",
          new: 0,
          forecasts: 0,
          action: "none",
        });
        continue;
      }
      sections.push(await evaluateSubSection(env, s, ctx));
    }

    const decision = rollupSendDecision(sections);
    const wanting = sections.filter(sectionWantsSend);
    const { allow: underCap, capped } = capDecision({
      want: decision.wantSend && !!email,
      counts: ctx.counts(),
      caps: ctx.caps,
    });
    const send = underCap && ctx.LIVE;

    const allNoticeIds = [];
    let totalFound = 0;
    for (const sec of sections) {
      totalFound += Number(sec.found) || 0;
      if (Array.isArray(sec.noticeIds)) allNoticeIds.push(...sec.noticeIds);
    }

    if (underCap && decision.wantSend) {
      const lang = (wanting[0] && wanting[0].lang) || (subs[0] && subs[0].lang) || "en";
      const unsubAllUrl = await unsubAllLink(env, email);
      const manageUrl = await prefsLink(env, email);
      manageUrlPresent = !!manageUrl;
      const sessionTok = await issueEmailSessionToken(env, email);
      const base = env.CONFIRM_BASE || "https://api.cityscroll.org";
      // Account watch count (all evaluated sections, including quiet/weekly) drives the
      // multi-watch subject form even when only one section wanted send.
      const watchCount = sections.length;
      const bodySections = rollupBodySections(sections);
      const subject = rollupSubject({
        totalNew: decision.totalNew,
        totalForecasts: decision.totalForecasts,
        labels: decision.labels,
        quiet: decision.totalNew === 0 && decision.totalForecasts === 0,
        watchCount,
      });
      const html = rollupDigestHtml({
        sections: bodySections.length ? bodySections : wanting,
        wantingCount: wanting.length,
        watchCount,
        unsubAllUrl,
        manageUrl,
        lang,
        sessionTok,
        base,
      });
      const payload = emailPayload(env, ctx.FROM, email, subject, html, `<${unsubAllUrl}>`, true);
      if (ctx.capturePreviews) preview = { subject, html, listUnsubscribe: `<${unsubAllUrl}>` };
      // List-Unsubscribe points at all-watches for rollup (account-level one-click).
      if (send) {
        await sendEmail(env, ctx.FROM, email, subject, html, `<${unsubAllUrl}>`, true);
        await ctx.onSent();
        if (ctx.advanceState !== false) {
          for (const sec of sections) {
            if (sec.subKey && sectionWantsSend(sec)) {
              await setLastSent(env, sec.subKey, ctx.today);
            }
          }
          await bumpStatAllTime(env.ALERT_STATE, "digest");
          await bumpHistDay(env.ALERT_STATE, "digest", new Date());
          for (const sec of sections) {
            if (sec.freshRows?.length) await bumpDigestCategories(env, sec.freshRows, sec.lens);
          }
          emitUsageEvent(env, { event: "digest_sent", lens: "account", surface: "email" });
        }
      } else {
        logDryRunEmail(payload);
        if (ctx.onDryRun) await ctx.onDryRun();
      }
    }

    // Mark seen ONLY on a real send (same watermark-poisoning fix as single-sub path).
    if (send && ctx.advanceState !== false) {
      for (const sec of sections) {
        if (sec.markSeenIds?.length && sec.seenId) {
          await markSeen(env, sec.seenId, sec.markSeenIds);
        }
      }
    }

    // Stamp account rollup when any section with fresh notices lagged >1 day (same
    // desk-exemption path as single-sub lag recovery; email stays normal daily copy).
    const lagRecovery = sections.some(
      (sec) => isMultiDayLagRecovery(sec.since, ctx.today, Number(sec.new) || 0),
    );
    const result = {
      sub: accountId,
      ...(previewId ? { previewId } : {}),
      kind: "rollup",
      emailRedacted: redactEmail(email),
      queryLabel: `${sections.length} watches`,
      found: totalFound,
      new: decision.totalNew,
      noticeIds: allNoticeIds.slice(0, 100),
      forecasts: decision.totalForecasts,
      action: decision.wantSend
        ? (decision.totalNew > 0 || decision.totalForecasts > 0 ? "match" : "quiet-rollup")
        : "none",
      traffic_class: lagRecovery ? "catch_up" : null,
      zeroMatch: !decision.wantSend,
      sent: !!send,
      dryRun: underCap && decision.wantSend && !ctx.LIVE,
      manageUrlPresent,
      capped,
      sendUnits: (send || (underCap && decision.wantSend && !ctx.LIVE)) ? 1 : 0,
      sections: sections.map((sec) => ({
        sub: sec.sub,
        ...(sec.previewId ? { previewId: sec.previewId } : {}),
        lens: sec.lens,
        queryLabel: sec.queryLabel,
        new: sec.new,
        found: sec.found,
        action: sec.action,
        skipped: sec.skipped || null,
        error: sec.error || null,
        forecasts: sec.forecasts || 0,
      })),
      ...(preview ? { preview } : {}),
    };
    return result;
  } catch (e) {
    return { sub: accountId, ...(previewId ? { previewId } : {}), kind: "rollup", emailRedacted: redactEmail(email), error: String(e?.message || e) };
  }
}

/**
 * Evaluate one watch for rollup without sending. Side effects: search-health write.
 * markSeen is deferred to the rollup caller so caps can defer the whole account.
 */
async function evaluateSubSection(env, s, ctx) {
  const base = {
    sub: maskKey(s.key),
    ...((ctx.capturePreviews && s.key) ? { previewId: await digestShadowId("watch", s.key) } : {}),
    subKey: s.key,
    lens: s.lens,
    queryLabel: describeFilter(s.lens, s.filter),
    lang: s.lang || "en",
    email: s.email,
    new: 0,
    found: 0,
    forecasts: 0,
    noticeIds: [],
    action: "none",
  };
  try {
    if (s.freq === "weekly" && !ctx.isMonday) {
      return { ...base, skipped: "weekly" };
    }
    if (s.lens === "award") {
      return evaluateAwardSection(env, s, ctx, base);
    }
    const q = compileSub(s, ctx.today);
    if (!q) return { ...base, skipped: `lens:${s.lens}` };

    const forecasts = await matchForecasts(env, s, ctx.today);
    let rows;
    let usedD1 = false;
    if (env.DB && !OFF_MIRROR_LENSES.has(s.lens)) {
      try {
        const fresh = await isMirrorFresh(env.DB, ctx.today);
        if (fresh) {
          const d1 = compileSub_d1(s, ctx.today);
          if (d1) {
            const { sql, params } = buildNoticesQuery(d1.opts);
            const res = await env.DB.prepare(sql).bind(...params).all();
            let mapped = (res.results ?? []).map(toDigestRow);
            if (d1.postFilter) mapped = mapped.filter(d1.postFilter);
            rows = mapped;
            usedD1 = true;
          }
        }
      } catch (e) {
        console.warn("alerts: D1 fast path failed (rollup), falling back to SODA:", String(e?.message || e));
      }
    }
    if (!usedD1) {
      rows = await fetchRows(q.url, q.params, q.transformRows);
      if (q.postFilter && s.lens !== "property") rows = rows.filter(q.postFilter);
    }
    const seen = await getSeen(env, s.key);
    let propertyStageSeenIds = [];
    if (s.lens === "property") {
      const evaluated = evaluatePropertyWatch(rows, s.filter, seen, ctx.today);
      rows = evaluated.rows;
      propertyStageSeenIds = evaluated.markSeenIds;
    }
    const rulesView = s.lens === "rules" ? await readJsonKv(env.ALERT_STATE, RULES_KV_KEY) : null;
    const reconciled = reconcileTemporalCandidates({ lens: s.lens, rows, seen, rulesView, idField: q.idField });
    reconciled.markSeenIds.push(...propertyStageSeenIds);
    for (const row of rows) {
      if (row.property_watch?.transition && !reconciled.fresh.some((freshRow) => freshRow.request_id === row.request_id)) reconciled.fresh.push(row);
    }
    const fresh = dedupeFreshByContent(reconciled.fresh);

    const matched = fresh.length > 0;
    const health = nextSearchHealth(s.health, matched, ctx.today);
    const healthStatus = searchHealthStatus({ health, createdAt: s.createdAt, today: ctx.today });
    if (ctx.advanceState !== false) await saveSubHealth(env, s, health);

    const since = (await getLastSent(env, s.key)) || s.createdAt || null;
    const effectiveCount = fresh.length + forecasts.length;
    const decision = subDigestDecision({
      lens: s.lens,
      freshCount: effectiveCount,
      freq: s.freq,
      lastSentDate: since,
      today: ctx.today,
      heartbeatDays: ctx.heartbeatDays,
    });

    const keywords = Array.isArray(s.filter && s.filter.keywords) ? s.filter.keywords : [];
    const w = encodeWatchFilter(s.lens, s.filter);
    const healthNote = healthStatus.quiet
      ? searchHealthNoteHtml({ lang: s.lang || "en", quietDays: healthStatus.quietDays, url: alertsFixUrl(s.lens, s.filter, s.freq) })
      : "";

    return {
      ...base,
      found: rows.length,
      new: fresh.length,
      noticeIds: fresh.map((r) => r[q.idField]).filter(Boolean).slice(0, 100),
      forecasts: forecasts.length,
      action: decision.action,
      since,
      kind: q.kind,
      freshRows: fresh,
      forecastRows: forecasts,
      keywords,
      w,
      healthNote,
      label: base.queryLabel,
      markSeenIds: reconciled.markSeenIds,
      seenId: s.key,
    };
  } catch (e) {
    return { ...base, error: String(e?.message || e) };
  }
}

async function evaluateAwardSection(env, s, ctx, base) {
  const filter = s.filter || {};
  if (typeof filter.requestId !== "string" || !filter.requestId) {
    return { ...base, skipped: "malformed-award-watch" };
  }
  const { ok, candidates } = await currentAwardCandidates(env, filter.requestId, filter.agency, ctx.nowMs);
  if (!ok) return { ...base, skipped: "award-lookup-failed" };
  const seenId = `award:${s.key}`;
  const seen = await getSeen(env, seenId);
  const fresh = candidates.filter((c) => c.key && !seen.has(c.key));
  return {
    ...base,
    found: candidates.length,
    new: fresh.length,
    noticeIds: fresh.length ? [filter.requestId].filter(Boolean) : [],
    action: fresh.length > 0 ? "match" : "none",
    kind: "award",
    awardCandidates: fresh,
    awardFilter: filter,
    label: base.queryLabel,
    markSeenIds: candidates.map((c) => c.key).filter(Boolean),
    seenId,
  };
}

// One award-arrival watch: diff the notice's current award candidates (currentAwardCandidates,
// external_award.mjs — the SAME precomputed state the notice page itself reads) against what
// this sub has already been told about, and notify only on genuinely new ones.
//
// Deliberately NOT digestDecision()-shaped: a one-notice watch has no "still nothing" heartbeat
// or weekly-empty check-in to send — "when nothing new appears, then silence" (see AGENTS.md).
// Reuses the exact same getSeen/markSeen KV mechanism every other lens's fresh/seen diff uses,
// just under a distinct key namespace (`award:<sub key>`) so it can never collide with a notices
// "seen" set even if a (email,lens,filter) hash were ever reused across lenses.
export async function processAwardSub(env, s, ctx) {
  const previewId = ctx.capturePreviews ? await digestShadowId("digest", s.key) : null;
  try {
    const filter = s.filter || {};
    if (typeof filter.requestId !== "string" || !filter.requestId) {
      return { sub: maskKey(s.key), skipped: "malformed-award-watch" };
    }

    const { ok, candidates } = await currentAwardCandidates(env, filter.requestId, filter.agency, ctx.nowMs);
    if (!ok) return { sub: maskKey(s.key), skipped: "award-lookup-failed" };

    const seenId = `award:${s.key}`;
    const seen = await getSeen(env, seenId);
    const fresh = candidates.filter((c) => c.key && !seen.has(c.key));

    const { allow: underCap, capped } = capDecision({
      want: fresh.length > 0 && !!s.email,
      counts: ctx.counts(),
      caps: ctx.caps,
    });
    const send = underCap && ctx.LIVE;

    let preview = null;
    if (underCap) {
      const lang = s.lang || "en";
      const unsubUrl = await unsubLink(env, s.key);
      const subject = emailT(lang, "award_watch_subject", { agency: filter.agency || "" });
      const sessionTok = await issueEmailSessionToken(env, s.email);
      const html = awardWatchDigestHtml(fresh, filter, unsubUrl, lang, sessionTok);
      const payload = emailPayload(env, ctx.FROM, s.email, subject, html, `<${unsubUrl}>`, true);
      if (ctx.capturePreviews) preview = { subject, html, listUnsubscribe: `<${unsubUrl}>` };
      if (send) {
        await sendEmail(env, ctx.FROM, s.email, subject, html, `<${unsubUrl}>`, true);
        await ctx.onSent();
        await setLastSent(env, s.key, ctx.today);
        await bumpStatAllTime(env.ALERT_STATE, "digest");
        await bumpHistDay(env.ALERT_STATE, "digest", new Date());
        await bumpCategoryStat(env.ALERT_STATE, "digest", "award-watch");
        emitUsageEvent(env, { event: "digest_sent", surface: "email" });
      } else {
        logDryRunEmail(payload);
        if (ctx.onDryRun) await ctx.onDryRun();
      }
    }

    // Mark seen ONLY on a real send — same watermark-poisoning fix as the other lenses.
    if (send && candidates.length) await markSeen(env, seenId, candidates.map((c) => c.key).filter(Boolean));

    return {
      sub: maskKey(s.key),
      ...(previewId ? { previewId } : {}),
      lens: "award",
      queryLabel: describeFilter("award", filter),
      emailRedacted: redactEmail(s.email),
      found: candidates.length,
      new: fresh.length,
      noticeIds: fresh.length ? [filter.requestId].filter(Boolean) : [],
      action: fresh.length > 0 ? "match" : "none",
      zeroMatch: fresh.length === 0,
      sent: send,
      dryRun: underCap && !ctx.LIVE,
      capped,
      ...(preview ? { preview } : {}),
    };
  } catch (e) {
    return { sub: maskKey(s.key), ...(previewId ? { previewId } : {}), error: String(e?.message || e) };
  }
}

// award_watch email body — exact NYCHA matches render as a confident line, ABO fuzzy candidates
// as an explicitly-labeled "possible" one, mirroring the notice page's nychaAwardBoxHTML() /
// aboAwardsTimelineHTML() visual+verbal distinction (index.html).
function awardWatchDigestHtml(candidates, filter, unsubUrl, lang = "en", sessionTok = null) {
  const usd = (n) => (n == null || n === "" || !n ? "" : "$" + Number(n).toLocaleString("en-US"));
  const esc = (s) => String(s == null ? "" : s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  // Route award-watch notice clicks through /session so the device is recognized
  // (pins-scoped cookie) before landing on the notice permalink — token never stays in the URL.
  const dest = `https://cityscroll.org/notices/${encodeURIComponent(filter.requestId)}`;
  const base = "https://api.cityscroll.org";
  const noticeUrl = sessionTok
    ? `${base}/session?token=${encodeURIComponent(sessionTok)}&next=${encodeURIComponent(dest)}`
    : dest;
  const items = candidates.map((c) => {
    const vendor = c.vendor ? esc(c.vendor) : esc(emailT(lang, "award_watch_vendor_unlisted"));
    const meta = [vendor, usd(c.amount), c.date ? esc(String(c.date).slice(0, 10)) : ""].filter(Boolean).join(" · ");
    if (c.kind === "exact") {
      return `<li data-digest-item="1" style="margin:0 0 14px"><b>${esc(emailT(lang, "award_watch_exact_label"))}</b><br>
        <span style="color:#555;font-size:13px">${meta}</span></li>`;
    }
    return `<li data-digest-item="1" style="margin:0 0 14px;font-style:italic;color:#555"><b>${esc(emailT(lang, "award_watch_fuzzy_label"))}</b><br>
      <span style="font-size:13px">${meta}</span><br>
      <span style="font-size:12px">${esc(emailT(lang, "award_watch_fuzzy_note"))}</span></li>`;
  }).join("");
  return `<div style="font-family:Georgia,serif;max-width:620px">
    <h2 style="font-family:system-ui">CityScroll — ${esc(emailT(lang, "award_watch_heading"))}</h2>
    <ul style="list-style:none;padding:0">${items}</ul>
    <p style="font-size:13px"><a href="${noticeUrl}">${esc(emailT(lang, "award_watch_view_notice"))}</a></p>
    <p style="color:#999;font-size:12px;margin-top:20px">${esc(emailT(lang, "digest_subscribed"))} <a href="${esc(unsubUrl)}">${esc(emailT(lang, "digest_unsubscribe"))}</a> (one-click).</p>
  </div>`;
}

// Queue consumer entry: one job = one account (single sub or rollup).
// Body shapes:
//   { type:"sub", key } | { key }           — legacy single-watch job
//   { type:"rollup", email, keys: [...] }   — multi-watch account rollup
//
// Reads the daily send count fresh per job (consumer max_concurrency=1 keeps the counter honest).
// Errors that prevented a real send are re-thrown so the queue retries (and eventually
// DLQs) instead of acking a silent failure.
export async function consumeDigestJob(env, jobOrKey, options = {}) {
  // Back-compat: tests and old queue messages may pass a bare key string.
  const job = typeof jobOrKey === "string"
    ? { type: "sub", key: jobOrKey }
    : (jobOrKey && typeof jobOrKey === "object" ? jobOrKey : {});
  const now = options.now == null ? new Date() : new Date(options.now);
  const day = now.toISOString().slice(0, 10);
  const shadowHold = options.shadowHoldState || await resolveDigestShadowHold(env.DB, {
    now,
    persist: true,
    receiptStore: env.ALERT_STATE,
  });
  let daily = await getSendCount(env, day);
  const ctx = {
    FROM: env.ALERTS_FROM || "CityScroll <alerts@cityscroll.org>",
    LIVE: env.ALERTS_LIVE === "true",
    heartbeatDays: Number(env.HEARTBEAT_DAYS) || 14,
    today: day,
    isMonday: now.getUTCDay() === 1,
    // Per-run pacing is the queue's job now; the DAILY ceiling stays hard.
    counts: () => ({ "per-run": 0, daily }),
    caps: { "per-run": Number(env.MAX_PER_RUN) || 25, daily: Number(env.MAX_SENDS_PER_DAY) || 50 },
    onSent: async () => { daily++; await setSendCount(env, day, daily); },
    heldDigestIds: new Set(shadowHold.active_digest_ids || []),
    holdAllDigests: shadowHold.delivery_policy === "ALL_DIGESTS_HELD",
    holdContract: shadowHold.contract,
  };

  let r;
  if (job.type === "rollup" && Array.isArray(job.keys) && job.keys.length) {
    const subs = [];
    for (const k of job.keys) {
      const s = await loadSub(env, k);
      if (s && isWatchActive(s)) subs.push(s);
    }
    if (!subs.length) {
      r = { sub: accountLogId(job.email), kind: "rollup", skipped: "gone" };
    } else {
      // Always the account rollup path for type:"rollup" jobs — even if only one key
      // still loads. Falling back to processOneSub made a multi-watch account emit a
      // single-watch subject/body when other watches were quiet, paused mid-queue, or
      // failed to load.
      r = await processAccountRollup(env, subs, ctx);
    }
  } else {
    const key = job.key;
    if (!key) {
      r = { sub: "?", skipped: "bad-job" };
    } else {
      const s = await loadSub(env, key);
      if (!s) {
        r = { sub: maskKey(key), kind: "subscription", skipped: "gone" };
      } else {
        r = await processOneSub(env, s, ctx);
      }
    }
  }

  console.log("digest job:", JSON.stringify(r));
  await recordQueueJobOutcome(env, day, r);
  await appendQueueDayLogEntry(env, day, r);
  if (r?.error) {
    throw new Error(`digest job error for ${r.sub || "?"}: ${r.error}`);
  }
  return r;
}

// ---- watermark recovery (catch-up digests) --------------------------------
//
// When delivery was broken for days (e.g. a Resend outage), recovery must re-send the
// MISSED STREAM since the delivery watermark (lastsent:<key>), not a single post-unclog
// drip. Catch-up mode:
//   1. Select subs whose lastsent lags behind today by >= minLagDays.
//   2. For each: clear seen, recompute the full query with a raised limit + start_date
//      floor at the watermark, send ONE clearly-labeled catch-up email, then advance the
//      watermark only on success.
//   3. Track separately from normal daily volume so /stats shows recovery honestly.
//
// Prefer admin-triggered over automatic on every cron (avoid surprise multi-day dumps).

const CATCHUP_RUN_LATEST_KEY = "digest:catchup:run:latest";
function catchupRunDayKey(day) { return `digest:catchup:run:${day}`; }

function catchUpOutcome(result) {
  if (result?.sent) return "sent";
  if (result?.error) return "error";
  if (result?.capped) return "capped";
  if (result?.skipped === "source-stale") return "source_stale";
  if (result?.skipped === "queue_pending") return "queue_pending";
  if (result?.zeroMatch || result?.skipped) return "no_matches";
  return null;
}

function catchUpOutcomeCounts(results) {
  const counts = { sent: 0, all_quiet: 0, no_matches: 0, capped: 0, error: 0, queue_pending: 0, source_stale: 0 };
  for (const result of results) {
    const outcome = catchUpOutcome(result);
    if (outcome && counts[outcome] !== undefined) counts[outcome]++;
  }
  return counts;
}

export async function runCatchUpDigests(env, { minLagDays = 2, subKeys = null, maxPerRun = null } = {}) {
  const FROM = env.ALERTS_FROM || "CityScroll <alerts@cityscroll.org>";
  const LIVE = env.ALERTS_LIVE === "true";
  const day = new Date().toISOString().slice(0, 10);
  const maxRun = Number(maxPerRun || env.MAX_PER_RUN) || 25;
  const maxDay = Number(env.MAX_SENDS_PER_DAY) || 50;
  let sentToday = await getSendCount(env, day);
  let sentThisRun = 0;
  const results = [];

  // Entitlement is the active-watch set used by the normal cron/queue path.
  // Paused watches remain in SUBS for preference management but must not receive
  // recovery mail or consume a catch-up cap.
  const allSubs = (await subWatches(env)).filter(isWatchActive);
  const today = day;

  // Select lagging subs or explicit subKeys.
  let targets = [];
  if (subKeys && subKeys.length) {
    const keySet = new Set(subKeys);
    targets = allSubs.filter((s) => keySet.has(s.key));
  } else {
    for (const s of allSubs) {
      const lastsent = await getLastSent(env, s.key);
      const lagDays = lastsent ? daysBetweenUTC(lastsent, today) : Infinity;
      if (lagDays >= minLagDays) targets.push(s);
    }
  }

  const ctx = {
    FROM, LIVE, today,
    counts: () => ({ "per-run": sentThisRun, daily: sentToday }),
    caps: { "per-run": maxRun, daily: maxDay },
    onSent: async () => { sentThisRun++; sentToday++; await setSendCount(env, day, sentToday); },
  };

  for (const s of targets) {
    try {
      results.push(await processCatchUpSub(env, s, ctx));
    } catch (e) {
      results.push({ sub: maskKey(s.key), error: String(e?.message || e), action: "catch_up", status: "error" });
    }
  }

  const ranAt = new Date().toISOString();
  const receipt = {
    ranAt, day, live: LIVE, mode: "catch_up",
    matched: results.filter((r) => !r.error && (Number(r.new) || 0) > 0).length,
    sent: results.filter((r) => r.sent).length,
    sentToday,
    candidates: targets.length,
    results,
    skipped_reason: results.some((r) => r.sent)
      ? null
      : (targets.length === 0
        ? "no_lagging_subs"
        : (results.some((r) => r.error) ? "errors" : (results.some((r) => r.capped) ? "capped" : "no_matches"))),
    status: results.some((r) => r.sent)
      ? "sent"
      : (results.some((r) => r.error) ? "error" : (results.some((r) => r.capped) ? "capped" : "no_matches")),
    outcomes: catchUpOutcomeCounts(results),
  };
  await writeCatchUpReceipt(env, receipt);
  // Always merge catch-up entries into the day log — including QUEUE_DIGESTS mode.
  // Queue daily fan-out only seeds an empty daylog; catch-up is a separate path that
  // must still stamp action/traffic_class catch_up so desk ops can exempt multi-day
  // recovery from phantom_send without heuristics alone.
  try {
    const existing = await readDigestDayLog(env, day);
    const catchUpEntries = results.map((r) => toDayLogEntry(r, { day })).filter(Boolean);
    const merged = existing
      ? { ...existing, entries: [...(existing.entries || []), ...catchUpEntries] }
      : buildDayLog({ day, ranAt, live: LIVE, mode: "catch_up", results });
    await writeDigestDayLog(env, recomputeDayLogTotalsLocal(merged));
  } catch { /* observability only */ }
  console.log("catch-up run:", JSON.stringify({ ranAt, sentThisRun, sentToday, candidates: targets.length }));
  return { ranAt, live: LIVE, sentThisRun, sentToday, candidates: targets.length, receipt, results };
}

/**
 * Daily-path lag recovery: lastsent (or createdAt fallback) is more than one UTC day
 * behind today and this run has fresh notices. Stamps traffic_class catch_up for desk
 * exemption; does not change email branding (unlike runCatchUpDigests).
 */
export function isMultiDayLagRecovery(lastSentOrCreated, today, freshCount) {
  if (!(Number(freshCount) > 0) || !lastSentOrCreated || !today) return false;
  const lag = daysBetweenUTC(String(lastSentOrCreated).slice(0, 10), String(today).slice(0, 10));
  return Number.isFinite(lag) && lag > 1;
}

function recomputeDayLogTotalsLocal(log) {
  const entries = Array.isArray(log.entries) ? log.entries : [];
  const sentEntries = entries.filter((e) => e && e.sent);
  return {
    ...log,
    entryCount: entries.length,
    sentCount: sentEntries.length,
    totalNotices: sentEntries.reduce((n, e) => n + (Number(e.noticeCount) || 0), 0),
  };
}

async function writeCatchUpReceipt(env, receipt) {
  if (!env?.ALERT_STATE || !receipt) return;
  try {
    const body = JSON.stringify(receipt);
    const puts = [env.ALERT_STATE.put(CATCHUP_RUN_LATEST_KEY, body)];
    if (receipt.day) puts.push(env.ALERT_STATE.put(catchupRunDayKey(receipt.day), body));
    await Promise.all(puts);
  } catch { /* observability only */ }
}

export async function readCatchUpReceipt(env) {
  if (!env?.ALERT_STATE) return null;
  try {
    const raw = await env.ALERT_STATE.get(CATCHUP_RUN_LATEST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch { return null; }
}

// One subscription in catch-up mode: clear seen → fetch full window → send one email →
// advance watermark on success. No heartbeat/weekly-empty logic — catch-up only fires when
// there is real missed content to deliver.
async function processCatchUpSub(env, s, ctx) {
  try {
    const watermark = await getLastSent(env, s.key) || s.createdAt || null;
    if (!watermark) return { sub: maskKey(s.key), skipped: "no-watermark", action: "catch_up", status: "error" };

    // Award watches are per-notice one-shots — catch-up clears their seen set and re-runs
    // normally; the award candidate diff is the same mechanism.
    if (s.lens === "award") {
      const seenId = `award:${s.key}`;
      await clearSeen(env, seenId);
      // Delegate to processAwardSub with a fresh ctx (it handles its own cap/send/markSeen).
      return processAwardSub(env, s, ctx);
    }

    const q = compileSub(s, ctx.today);
    if (!q) return { sub: maskKey(s.key), skipped: `lens:${s.lens}`, action: "catch_up", status: "no_matches" };

    // Clear seen so all notices since the watermark are treated as fresh.
    await clearSeen(env, s.key);

    // Raise the limit and add a start_date floor at the watermark for City Record queries.
    const catchUpParams = { ...q.params };
    catchUpParams["$limit"] = "100";
    if (catchUpParams.$where && q.idField === "request_id") {
      catchUpParams.$where += ` AND start_date >= '${watermark}'`;
    }

    let rows;
    if (env.DB && !OFF_MIRROR_LENSES.has(s.lens)) {
      try {
        const fresh = await isMirrorFresh(env.DB, ctx.today);
        if (fresh) {
          const d1 = compileSub_d1(s, ctx.today);
          if (d1) {
            const { sql, params } = buildNoticesQuery(d1.opts);
            const res = await env.DB.prepare(sql).bind(...params).all();
            let mapped = (res.results ?? []).map(toDigestRow);
            if (d1.postFilter) mapped = mapped.filter(d1.postFilter);
            rows = mapped;
          }
        }
      } catch (e) {
        console.warn("catch-up: D1 path failed, falling back to SODA:", String(e?.message || e));
      }
    }
    if (!rows) {
      rows = await fetchRows(q.url, catchUpParams, q.transformRows);
      if (q.postFilter && s.lens !== "property") rows = rows.filter(q.postFilter);
    }
    let propertyStageSeenIds = [];
    if (s.lens === "property") {
      const seen = await getSeen(env, s.key);
      const evaluated = evaluatePropertyWatch(rows, s.filter, seen, ctx.today);
      rows = evaluated.rows;
      propertyStageSeenIds = evaluated.markSeenIds;
    }

    const fresh = dedupeFreshByContent(rows.filter((r) => r[q.idField]));

    if (fresh.length === 0) {
      // No send means no watermark advancement. Keeping the last successful
      // delivery boundary makes a later retry replay the same entitled window.
      return {
        sub: maskKey(s.key), lens: s.lens,
        queryLabel: describeFilter(s.lens, s.filter),
        emailRedacted: redactEmail(s.email),
        found: rows.length, new: 0,
        noticeIds: [], forecasts: 0,
        action: "catch_up", zeroMatch: true,
        sent: false, dryRun: false, capped: false, status: "no_matches",
      };
    }

    const { allow: underCap, capped } = capDecision({
      want: !!s.email,
      counts: ctx.counts(),
      caps: ctx.caps,
    });
    const send = underCap && ctx.LIVE;

    if (underCap) {
      const label = describeFilter(s.lens, s.filter);
      const unsubUrl = await unsubLink(env, s.key);
      const lang = s.lang || "en";
      const keywords = Array.isArray(s.filter && s.filter.keywords) ? s.filter.keywords : [];
      const w = encodeWatchFilter(s.lens, s.filter);
      const sessionTok = await issueEmailSessionToken(env, s.email);
      const subject = emailT(lang, "catch_up_subject", { n: fresh.length, label });
      const html = catchUpDigestHtml(label, q.kind, fresh, unsubUrl, watermark,
        env.CONFIRM_BASE || "https://api.cityscroll.org", lang, keywords, w, sessionTok);
      if (send) {
        await sendEmail(env, ctx.FROM, s.email, subject, html, `<${unsubUrl}>`, true);
        await ctx.onSent();
        await setLastSent(env, s.key, ctx.today);
        await bumpStatAllTime(env.ALERT_STATE, "digest_catchup");
        await bumpHistDay(env.ALERT_STATE, "digest_catchup", new Date());
        if (fresh.length) await bumpDigestCategories(env, fresh, s.lens);
        emitUsageEvent(env, { event: "digest_sent", lens: s.lens, surface: "email", mode: "catch_up" });
      } else {
        logDryRunEmail(emailPayload(env, ctx.FROM, s.email, subject, html, `<${unsubUrl}>`, true));
      }
    }

    // Mark seen ONLY on a real send (same watermark-poisoning fix).
    if (send && rows.length) await markSeen(env, s.key, [...rows.map((r) => r[q.idField]).filter(Boolean), ...propertyStageSeenIds]);
    return {
      sub: maskKey(s.key), lens: s.lens,
      queryLabel: describeFilter(s.lens, s.filter),
      emailRedacted: redactEmail(s.email),
      found: rows.length, new: fresh.length,
      noticeIds: fresh.map((r) => r[q.idField]).filter(Boolean).slice(0, 100),
      forecasts: 0,
      action: "catch_up",
      zeroMatch: fresh.length === 0,
      sent: send, dryRun: underCap && !ctx.LIVE, capped,
      status: send ? "sent" : (capped ? "capped" : "no_matches"),
    };
  } catch (e) {
    return { sub: maskKey(s.key), error: String(e?.message || e), action: "catch_up", status: "error" };
  }
}

// Catch-up email: same item list as a normal digest, but with a clear "delivery was
// interrupted" intro so it never reads as a normal daily drip. Apology framing is the
// product decision: the subscriber should understand why they're getting a batch.
function catchUpDigestHtml(label, kind, rows, unsubUrl, watermark, base, lang, keywords, w, sessionTok) {
  const esc = (s) => String(s == null ? "" : s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  const body = subDigestHtml(label, kind, rows, unsubUrl, watermark, base, [], lang, keywords, w, "", sessionTok);
  const intro = emailT(lang, "catch_up_intro", { n: rows.length, date: shortDate(watermark) });
  return body.replace(
    /(<h2[^>]*>CityScroll[^<]*<\/h2>)/,
    `$1<p style="color:#a42;font-size:13px">${esc(intro)}</p>`,
  );
}

function daysBetweenUTC(fromDay, toDay) {
  const a = new Date(fromDay + "T00:00:00Z").getTime();
  const b = new Date(toDay + "T00:00:00Z").getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
  return Math.round((b - a) / 86400000);
}

/**
 * Admin / dry-run: evaluate rollup for an email without sending or advancing caps.
 * LIVE is forced false so markSeen (send-gated) does not advance. Health writes may
 * still occur via evaluateWatchForRollup; prefer a dedicated operator env for deep probes.
 */
export async function dryRunRollupForEmail(env, email) {
  const want = normalizeEmail(email);
  if (!want) return { ok: false, reason: "bad-email" };
  const all = await subWatches(env);
  const list = all.filter((s) => normalizeEmail(s.email) === want);
  const active = list.filter(isWatchActive);
  if (!active.length) {
    return {
      ok: true,
      emailRedacted: redactEmail(want),
      watchCount: list.length,
      activeCount: 0,
      wouldSend: false,
      mode: list.length ? "all_paused" : "no_watches",
      manageUrlPresent: false,
      sections: list.map((s) => ({
        key: maskKey(s.key),
        lens: s.lens,
        query: describeFilter(s.lens, s.filter),
        paused: !!s.paused,
      })),
    };
  }
  const day = new Date().toISOString().slice(0, 10);
  const ctx = {
    FROM: env.ALERTS_FROM || "CityScroll <alerts@cityscroll.org>",
    LIVE: false,
    heartbeatDays: Number(env.HEARTBEAT_DAYS) || 14,
    today: day,
    isMonday: new Date().getUTCDay() === 1,
    counts: () => ({ "per-run": 0, daily: 0 }),
    caps: { "per-run": 9999, daily: 9999 },
    onSent: async () => {},
    advanceState: true,
  };
  let result;
  if (active.length === 1) {
    result = await processOneSub(env, active[0], ctx);
  } else {
    result = await processAccountRollup(env, active, ctx);
  }
  return {
    ok: true,
    emailRedacted: redactEmail(want),
    watchCount: list.length,
    activeCount: active.length,
    rollup: active.length > 1,
    wouldSend: !!(result.dryRun || result.sent),
    mode: active.length > 1 ? "rollup" : "single",
    result,
    dayLogPreview: active.length > 1
      ? toRollupDayLogEntry(result, { day })
      : toDayLogEntry(result, { day }),
  };
}

/**
 * Admin test-send: run the normal digest path with live delivery enabled for this request only.
 * State advancement is opt-in so a test message cannot consume tomorrow's notices by default.
 */
export async function digestSendTestForEmail(env, email, { live = false, advanceState = false } = {}) {
  const want = normalizeEmail(email);
  if (!want) return { ok: false, reason: "bad-email" };
  const all = await subWatches(env);
  const list = all.filter((s) => normalizeEmail(s.email) === want);
  const active = list.filter(isWatchActive);
  if (!active.length) {
    return {
      ok: true,
      emailRedacted: redactEmail(want),
      watchCount: list.length,
      activeCount: 0,
      wouldSend: false,
      mode: list.length ? "all_paused" : "no_watches",
      manageUrlPresent: false,
      sections: list.map((s) => ({ key: maskKey(s.key), lens: s.lens, query: describeFilter(s.lens, s.filter), paused: !!s.paused })),
    };
  }
  const day = new Date().toISOString().slice(0, 10);
  const ctx = {
    FROM: env.ALERTS_FROM || "CityScroll <alerts@cityscroll.org>",
    LIVE: !!live,
    advanceState: !!advanceState,
    heartbeatDays: Number(env.HEARTBEAT_DAYS) || 14,
    today: day,
    isMonday: new Date().getUTCDay() === 1,
    counts: () => ({ "per-run": 0, daily: 0 }),
    caps: { "per-run": 9999, daily: 9999 },
    onSent: async () => {},
  };
  const result = active.length === 1
    ? await processOneSub(env, active[0], ctx)
    : await processAccountRollup(env, active, ctx);
  return {
    ok: true,
    live: !!live,
    advanceState: !!advanceState,
    emailRedacted: redactEmail(want),
    watchCount: list.length,
    activeCount: active.length,
    rollup: active.length > 1,
    wouldSend: !!(result.dryRun || result.sent),
    mode: active.length > 1 ? "rollup" : "single",
    manageUrlPresent: !!result.manageUrlPresent,
    sections: result.sections || [{ lens: result.lens, query: result.queryLabel, new: result.new, action: result.action }],
    result,
  };
}

async function loadSub(env, key) {
  if (!env.SUBS) return null;
  try {
    const v = JSON.parse(await env.SUBS.get(key));
    return v && v.email ? { key, ...v } : null;
  } catch {
    return null;
  }
}

// Persist the updated health record onto the subscription's own SUBS entry — no separate KV
// namespace, per the "no new per-user tracking beyond the already-stored subscription" rule.
// Fail-soft: a write failure here must never break digest compilation for this (or any other) sub.
async function saveSubHealth(env, s, health) {
  if (!env.SUBS) return;
  try {
    const { key, ...record } = s;
    await env.SUBS.put(s.key, JSON.stringify({ ...record, health }));
  } catch { /* ignore — health tracking is best-effort */ }
}

// ---- query a watch against the City Record -------------------------------

// Honest deadline label: due dates in year >= 2090 are rolling placeholders (EDA:
// pre-qualified-list entries), not real deadlines — never render them as dates.
export function dueLabel(dueDate) {
  if (!dueDate) return "";
  const s = String(dueDate);
  const year = Number(s.slice(0, 4));
  if (Number.isFinite(year) && year >= 2090) return "no fixed deadline (rolling)";
  return "due " + s.slice(0, 10);
}

export async function fetchSodaRowsWithRetry(url, {
  fetchFn = fetch,
  waitFn = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const attempts = 2;
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let response;
    try {
      response = await fetchFn(url);
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) throw error;
      await waitFn(SODA_RETRY_DELAY_MS);
      continue;
    }
    if (response.ok) return response.json();
    lastError = new Error(`SODA ${response.status}`);
    if (!RETRYABLE_SODA_STATUSES.has(response.status) || attempt === attempts - 1) {
      throw lastError;
    }
    await waitFn(SODA_RETRY_DELAY_MS);
  }
  throw lastError;
}

async function runWatch(w) {
  const params = new URLSearchParams();
  params.set("$select", "request_id,start_date,agency_name,short_title,pin,contract_amount,vendor_name,due_date,contact_name,contact_phone,email,street_address_1,section_name,type_of_notice_description,address_to_request,selection_method_description,additional_description_1");
  params.set("$limit", String(w.limit || 25));
  params.set("$order", "start_date DESC");

  if (w.type === "awards") {
    // Cap excludes data-entry errors (EDA: 3 rows >= $10B, max legit ≈ $6.68B) which
    // would otherwise dominate any amount-sorted digest.
    params.set("$where", `type_of_notice_description='Award' AND contract_amount >= ${Number(w.min) || 1000000} AND contract_amount < 10000000000`);
  } else if (w.where || w.q) {
    if (w.where) params.set("$where", w.where);
    if (w.q) params.set("$q", w.q);
  }

  return fetchSodaRowsWithRetry(`${SODA}?${params.toString()}`);
}

// ---- actionable digest (phone / email / links per item) ------------------

// ---- match-evidence rendering (shared by digestHtml + subDigestHtml) -----
// ev comes from matchEvidence() (lib/digest.mjs); esc is the caller's own HTML-escaper.
//
// titleHtml: the item's title, term <mark>-highlighted when the TITLE is what matched.
// ev.index is an offset into the unescaped title, so slicing happens before escaping --
// otherwise an escaped "&amp;" earlier in the string could shift the highlight off-target.
function titleHtml(title, ev, esc) {
  if (!ev || ev.field !== "title") return esc(title);
  const before = esc(title.slice(0, ev.index));
  const hit = esc(title.slice(ev.index, ev.index + ev.term.length));
  const after = esc(title.slice(ev.index + ev.term.length));
  return `${before}<mark style="background:#ffe58a;padding:0 1px">${hit}</mark>${after}`;
}
// evidenceLineHtml: a one-line "why this matched" note for a match NOT in the title -- a
// snippet from the description, or (last resort, ev.field==="unknown") just the term -- so
// an item never appears with nothing visible explaining the match.
function evidenceLineHtml(ev, esc, lang) {
  if (!ev || ev.field === "title") return "";
  const mark = (s) => `<mark style="background:#ffe58a;padding:0 1px">${esc(s)}</mark>`;
  const html = ev.field === "description"
    ? emailT(lang, "digest_match_snippet", { snippet: `${esc(ev.before)}${mark(ev.hit)}${esc(ev.after)}` })
    : emailT(lang, "digest_match_unknown", { term: mark(ev.term) });
  return `<div style="color:#666;font-size:12px;font-style:italic;margin-top:2px">${html}</div>`;
}

// Time + action awareness (phase, open/closing-soon/closed, extracted next step).
// Pure render in digest_item_awareness.mjs — reuses site action_registry handoffs.
// opts.kind is the digest query kind (rfp/award/rules/meetings/property/rezone/…).
function temporalActionHtml(row, esc, lang = "en", opts = {}) {
  return itemAwarenessHtml(row, esc, lang, opts);
}

function digestMeetingDetailsHtml(row, esc, calendarBase = "https://api.cityscroll.org") {
  const isMeeting = row?.section_name === "Public Hearings and Meetings"
    || (row?.section_name === "Agency Rules" && row?.type_of_notice_description === "Public Hearings");
  if (!isMeeting || !row?.event_date) return "";
  const normalized = normalizeHearing(row);
  const access = normalized.meeting_access || {};
  const mode = access.mode === "remote" ? "Remote" : access.mode === "hybrid" ? "Hybrid" : access.mode === "in-person" ? "In person" : "Mode not stated";
  const facts = [`Mode: ${mode}`];
  if (access.in_person_location) facts.push(`Location: ${access.in_person_location}`);
  const join = access.remote_join_url;
  if (join) facts.push(`<a href="${esc(join)}">Join online</a>`);
  if (access.dial_in?.length) facts.push(`Dial-in: ${access.dial_in.join(", ")}`);
  const calendar = row.request_id
    ? `${calendarBase}/meeting.ics?id=${encodeURIComponent(row.request_id)}`
    : null;
  if (calendar) facts.push(`<a href="${esc(calendar)}">Add to calendar</a>`);
  return `<div data-meeting-access="1" style="color:#444;font-size:13px;margin:3px 0">${facts.map((fact) => fact.includes("<a ") ? fact : esc(fact)).join(" · ")}</div>`;
}

function digestHtml(w, rows) {
  const money = (n) => (n == null || n === "" ? "" : "$" + Number(n).toLocaleString("en-US"));
  const esc = (s) => String(s == null ? "" : s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  const keywords = w.q ? [String(w.q)] : [];
  const digestKind = w.type === "awards" ? "award" : "rfp";
  const today = new Date().toISOString().slice(0, 10);
  const items = rows
    .map((r) => {
      const titleText = r.short_title || r.section_name || "Notice";
      const ev = matchEvidence(titleText, r.additional_description_1, keywords);
      const acts = [];
      if (r.email) acts.push(`<a href="mailto:${esc(r.email)}">✉ Email</a>`);
      if (r.contact_phone) acts.push(`<a href="tel:${esc(String(r.contact_phone).replace(/[^0-9+]/g, ""))}">☎ Call</a>`);
      acts.push(`<a href="${REQ_URL(r.request_id)}">↗ View in City Record</a>`);
      const sub = [r.agency_name, r.pin ? "PIN " + r.pin : "", money(r.contract_amount), dueLabel(r.due_date)]
        .filter(Boolean).map(esc).join(" · ");
      return `<li data-digest-item="1" style="margin:0 0 14px"><b><a href="${REQ_URL(r.request_id)}">${titleHtml(titleText, ev, esc)}</a></b><br>
        <span style="color:#555;font-size:13px">${sub}</span><br>
        ${temporalActionHtml(r, esc, "en", { kind: digestKind, today })}
        ${digestMeetingDetailsHtml(r, esc)}
        ${evidenceLineHtml(ev, esc, "en")}
        <span style="font-size:13px">${acts.join(" &nbsp; ")}</span></li>`;
    })
    .join("");
  return `<div style="font-family:Georgia,serif;max-width:620px">
    <h2 style="font-family:system-ui">CityScroll — ${esc(w.label)}</h2>
    <p style="color:#555">${rows.length} new ${rows.length === 1 ? "notice" : "notices"} in The City Record.</p>
    <ul style="list-style:none;padding:0">${items}</ul>
    <p style="color:#999;font-size:12px">You subscribed to this slice on cityscroll.org. <a href="mailto:alerts@cityscroll.org?subject=unsubscribe">Unsubscribe</a>.</p>
  </div>`;
}

// Human replies need a mailbox that can actually receive. cityscroll.org has no apex MX
// (so replies to alerts@cityscroll.org bounce); crol-list.org still has Cloudflare email
// routing. Prefer ALERTS_REPLY_TO, then the address that used to be the digest From.
function replyToAddress(env) {
  return env.ALERTS_REPLY_TO || "alerts@crol-list.org";
}

// Build the Resend payload shape used by both live sends and ALERTS_LIVE dry-run logging.
function emailPayload(env, from, to, subject, html, listUnsub, oneClick) {
  const body = { from, to, subject, html, reply_to: replyToAddress(env) };
  // List-Unsubscribe: clients render a native Unsubscribe button. mailto form (legacy config
  // watches) lands at the reply address; https form + List-Unsubscribe-Post = RFC 8058 one-click.
  if (listUnsub) {
    body.headers = { "List-Unsubscribe": listUnsub };
    if (oneClick) body.headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }
  return body;
}

function logDryRunEmail(payload) {
  const safeUrl = (value) => String(value || "").replace(/([?&](?:token|s)=)[^&>\s]+/gi, "$1[redacted]");
  const safeHtml = payload.html ? payload.html.replace(/([?&](?:token|s)=)[^\"'&\s<]+/gi, "$1[redacted]") : payload.html;
  console.log("alerts dry-run (no send):", JSON.stringify({
    from: payload.from,
    reply_to: payload.reply_to,
    to: payload.to,
    subject: payload.subject,
    listUnsub: safeUrl(payload.headers?.["List-Unsubscribe"] || null),
    htmlBytes: payload.html ? payload.html.length : 0,
    html: safeHtml,
    headers: payload.headers ? { ...payload.headers, "List-Unsubscribe": safeUrl(payload.headers["List-Unsubscribe"]) } : null,
  }));
}

async function sendEmail(env, from, to, subject, html, listUnsub, oneClick) {
  // Callers must gate on ALERTS_LIVE / ctx.LIVE before invoking — this only hits Resend.
  const body = emailPayload(env, from, to, subject, html, listUnsub, oneClick);
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.RESEND_API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
  return r.json();
}

// ---- per-watch "already seen" state (Workers KV) -------------------------

async function getSeen(env, id) {
  if (!env.ALERT_STATE) return new Set();
  try {
    const raw = await env.ALERT_STATE.get(`seen:${id}`);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch { return new Set(); }
}

async function readJsonKv(namespace, key) {
  if (!namespace) return null;
  try {
    const raw = await namespace.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function markSeen(env, id, ids) {
  if (!env.ALERT_STATE) return;
  try {
    const prev = await getSeen(env, id);
    ids.forEach((x) => prev.add(x));
    // keep the last ~500 ids so the value doesn't grow without bound
    await env.ALERT_STATE.put(`seen:${id}`, JSON.stringify([...prev].slice(-500)));
  } catch { /* ignore */ }
}

// Reset the seen set for a subscription key — used by catch-up recovery so every notice
// since the delivery watermark is treated as fresh, regardless of what a prior poisoned run
// may have marked. This is the replay-from-last-success-watermark procedure: clear seen,
// re-send the full missed stream, then markSeen advances only on the successful catch-up send.
async function clearSeen(env, id) {
  if (!env.ALERT_STATE) return;
  try { await env.ALERT_STATE.put(`seen:${id}`, "[]"); } catch { /* ignore */ }
}

// ---- daily send counter (the denial-of-wallet ceiling, Workers KV) -------

async function getSendCount(env, day) {
  if (!env.ALERT_STATE) return 0;
  try { return Number(await env.ALERT_STATE.get(`sendcount:${day}`)) || 0; } catch { return 0; }
}

async function setSendCount(env, day, n) {
  if (!env.ALERT_STATE) return;
  // expire after 2 days so per-day counter keys self-clean
  try { await env.ALERT_STATE.put(`sendcount:${day}`, String(n), { expirationTtl: 3456000 }); } catch { /* ignore */ } // 40d: /stats reads a 7-day window; cap logic only ever reads today
}

// ---- per-sub "last time we emailed them" (Workers KV) --------------------
// Drives the confidence feature: the "since <date>" window and the daily heartbeat cadence.
// Durable (no TTL); value is a date string like "2026-07-02".

async function getLastSent(env, id) {
  if (!env.ALERT_STATE) return null;
  try { return (await env.ALERT_STATE.get(`lastsent:${id}`)) || null; } catch { return null; }
}

async function setLastSent(env, id, date) {
  if (!env.ALERT_STATE) return;
  try { await env.ALERT_STATE.put(`lastsent:${id}`, date); } catch { /* ignore */ }
}

// ---- confirmed subscriptions (SUBS KV) -----------------------------------

async function subWatches(env) {
  if (!env.SUBS) return [];
  const out = [];
  let cursor;
  try {
    do {
      const res = await env.SUBS.list({ prefix: "sub:", cursor });
      for (const k of res.keys) {
        try {
          const v = JSON.parse(await env.SUBS.get(k.name));
          if (v && v.email) out.push({ key: k.name, ...v });
        } catch { /* skip a malformed record */ }
      }
      cursor = res.list_complete ? null : res.cursor;
    } while (cursor);
  } catch { /* SUBS unavailable → no self-serve sends this run */ }
  return out;
}

async function fetchRows(url, params, transformRows) {
  const r = await fetch(`${url}?${new URLSearchParams(params).toString()}`);
  if (!r.ok) throw new Error(`open-data ${r.status}`);
  const payload = await r.json();
  return typeof transformRows === "function" ? transformRows(payload) : payload;
}

// Check whether the D1 notices mirror is fresh enough to trust for digest matching.
// "Fresh" = the ingest_cursor (max ingested start_date) is within 2 days of today.
// A stale or missing cursor means the mirror hasn't been updated recently; fall back to SODA.
async function isMirrorFresh(db, todayISO) {
  try {
    const row = await db.prepare("SELECT v FROM ingest_state WHERE k = ?").bind("ingest_cursor").first();
    if (!row || !row.v) return false;
    const cursor = String(row.v).slice(0, 10);
    const cursorMs = new Date(cursor + "T00:00:00Z").getTime();
    const todayMs  = new Date(todayISO  + "T00:00:00Z").getTime();
    return (todayMs - cursorMs) <= 2 * 86400_000; // within 2 days
  } catch {
    return false; // any error → treat as stale, use SODA
  }
}

// A one-click unsubscribe URL: a long-lived signed token carrying the sub's KV key.
async function unsubLink(env, subKey) {
  if (!env.TOKEN_SECRET) return "mailto:alerts@cityscroll.org?subject=unsubscribe";
  const base = env.CONFIRM_BASE || "https://api.cityscroll.org"; // branded custom domain (workers.dev stays an alias)
  const token = await signToken(env.TOKEN_SECRET, { k: subKey }, { ttlSeconds: 60 * 24 * 3600 });
  return `${base}/unsubscribe?token=${encodeURIComponent(token)}`;
}

// Account-level unsubscribe: removes every watch for this email.
async function unsubAllLink(env, email) {
  if (!env.TOKEN_SECRET) return "mailto:alerts@cityscroll.org?subject=unsubscribe-all";
  const base = env.CONFIRM_BASE || "https://api.cityscroll.org";
  const token = await signToken(
    env.TOKEN_SECRET,
    { all: 1, e: normalizeEmail(email) },
    { ttlSeconds: 60 * 24 * 3600 },
  );
  return `${base}/unsubscribe?token=${encodeURIComponent(token)}`;
}

function maskKey(n) {
  return String(n).replace(/^(sub:)([^@:]{0,2})[^@:]*/, "$1$2***");
}

function districtGroupedListHtml(rows, renderItem, esc) {
  return groupDistrictDigestRows(rows).map((section) => (
    `<section class="district-action-section" data-district-section="${esc(section.id)}" style="margin:20px 0 0">`
      + `<h3 style="font-family:system-ui;margin:0 0 10px">${esc(section.label)}</h3>`
      + `<ul style="list-style:none;padding:0;margin:0">${section.items.map(renderItem).join("")}</ul>`
      + "</section>"
  )).join("");
}

// Digest for a self-serve sub — award / rfp (City Record) or rezone (ZAP) items.
// keywords: the sub's filter.keywords (money/property/rules/meetings lenses only -- entity
// subs match by name, not keyword, so they pass none and get no evidence line, correctly).
// w: this watch's encodeWatchFilter() output (w12-12) — null for a rezone digest, which links
// straight to ZAP below and never touches CityScroll's own notice view.
export function subDigestHtml(label, kind, rows, unsubUrl, since, base = "https://api.cityscroll.org", forecasts = [], lang = "en", keywords = [], w = null, healthNote = "", sessionTok = null, manageUrl = null) {
  const usd = (n) => (n == null || n === "" ? "" : "$" + Number(n).toLocaleString("en-US"));
  const esc = (s) => String(s == null ? "" : s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  const cr = (id) => `https://a856-cityrecord.nyc.gov/RequestDetail/${encodeURIComponent(id)}`;
  // Event-clock "today" for open / closing-soon / closed — render-only; does not affect send timing.
  const today = new Date().toISOString().slice(0, 10);
  const item = (r) => {
    const itemKind = kind === "district" ? r.district_kind : kind;
    const itemClass = kind === "district" ? ' class="district-item"' : "";
    if (itemKind === "exam") {
      const link = `https://cityscroll.org/exams/${encodeURIComponent(r.exam_number)}/`;
      const dates = r.application_start && r.application_end
        ? `${String(r.application_start).slice(0, 10)}–${String(r.application_end).slice(0, 10)}`
        : "";
      const meta = [`Exam ${r.exam_number}`, dates, r.open_window_band].filter(Boolean).map(esc).join(" · ");
      const noe = r.notice_url ? `<span style="color:#33691e;font-size:13px">NOE posted</span><br>` : "";
      return `<li data-digest-item="1"${itemClass} style="margin:0 0 14px"><b><a href="${link}">${esc(r.title || "Civil-service exam")}</a></b><br>
        <span style="color:#555;font-size:13px">${meta}</span><br>${noe}
        <span style="font-size:13px"><a href="${link}">↗ View exam on CityScroll</a>${r.notice_url ? ` &nbsp; <a href="${esc(r.notice_url)}">Official NOE</a>` : ""}</span></li>`;
    }
    if (itemKind === "rezone") {
      // ZAP rows: project_name/public_status shape. Action rail uses zoningHandoff via
      // itemAwarenessHtml (View/comment on ZAP + phase status when published).
      const meta = [r.borough, r.community_district ? "CD " + r.community_district : "", r.public_status, r.primary_applicant, /^[ty1]/i.test(String(r.mih_flag || "")) ? "affordable housing" : ""]
        .filter(Boolean).map(esc).join(" · ");
      return `<li data-digest-item="1"${itemClass} style="margin:0 0 14px"><b><a href="https://zap.planning.nyc.gov/projects/${encodeURIComponent(r.project_id)}">${esc(landProjectDisplayTitle(r))}</a></b><br>
        <span style="color:#555;font-size:13px">${meta}</span><br>
        ${temporalActionHtml(r, esc, lang, { kind: "rezone", today })}
        <span style="font-size:13px"><a href="https://zap.planning.nyc.gov/projects/${encodeURIComponent(r.project_id)}">↗ View &amp; comment on ZAP</a></span></li>`;
    }
    const titleText = r.short_title || "Notice";
    const ev = matchEvidence(titleText, r.additional_description_1, keywords);
    const acts = [];
    if (r.email) acts.push(`<a href="mailto:${esc(r.email)}">✉ Email</a>`);
    const tel = String(r.contact_phone || "").replace(/[^0-9+]/g, "");
    if (tel.length >= 7) acts.push(`<a href="tel:${tel}">☎ Call</a>`);
    // Count-only click-through (R·B tier 3, team-approved 2026-07-02): /r bumps a per-day
    // counter and 302s to the permalink — no per-recipient tracking (see src/redirect.mjs).
    // The ?w= param (w12-12) rides along through the redirect unread and lands in the
    // permalink's own hash fragment — see src/redirect.mjs. `w` is already encodeWatchFilter()'s
    // own percent-encoded output, so it's placed directly, not re-encoded (that would double-encode).
    // Optional `s=` carries a pins-scoped magic-link token; /r exchanges it for a session
    // cookie and never forwards the token to the final cityscroll.org URL.
    const qs = [];
    if (sessionTok) qs.push(`s=${encodeURIComponent(sessionTok)}`);
    if (w) qs.push(`w=${w}`);
    const noticeLink = `${base}/r/${encodeURIComponent(itemKind)}/${encodeURIComponent(r.request_id)}${qs.length ? `?${qs.join("&")}` : ""}`;
    acts.push(`<a href="${noticeLink}">↗ View on CityScroll</a>`);
    acts.push(`<a href="${cr(r.request_id)}">City Record</a>`);
    if (kind === "rules" && r.action_band?.action_url) {
      const bandAct = r.action_band.band_id === "comment_open"
        ? "Comment on NYC Rules"
        : r.action_band.band_id === "hearing"
          ? "Hearing details"
          : "Official rule page";
      acts.unshift(`<a href="${esc(r.action_band.action_url)}">${esc(bandAct)}</a>`);
    }
    const meta = [r.agency_name, usd(r.contract_amount),
      dueLabel(r.due_date),
      r.event_date ? "event " + String(r.event_date).slice(0, 10) : ""]
      .filter(Boolean).map(esc).join(" · ");
    const propertyStage = itemKind === "property" && r.property_watch
      ? `<span style="color:#555;font-size:13px"><b>Matched at:</b> ${esc(propertyWatchStageLabel(r.property_watch.matched_at_stage))}${r.property_watch.transition ? ` · <b>${esc(r.property_watch.transition.label)}</b>` : ""}</span><br>`
      : "";
    return `<li data-digest-item="1"${itemClass} style="margin:0 0 14px"><b><a href="${noticeLink}">${titleHtml(titleText, ev, esc)}</a></b><br>
      <span style="color:#555;font-size:13px">${meta}</span><br>
      ${propertyStage}
      ${temporalActionHtml(r, esc, lang, { kind: itemKind, today })}
      ${digestMeetingDetailsHtml(r, esc, base)}
      ${evidenceLineHtml(ev, esc, lang)}
      <span style="font-size:13px">${acts.join(" &nbsp; ")}</span></li>`;
  };

  let forecastsHtml = "";
  if (forecasts.length > 0) {
    const fItems = forecasts.map(f => (
      `<li data-digest-item="1" style="margin:0 0 14px"><b>Forecast renewal: ${esc(f.vendor_name || "Vendor")}</b><br>
        <span style="color:#555;font-size:13px">${esc(f.agency_name)} · Amount ${usd(f.amount)}</span><br>
        <span style="color:#a42;font-size:13px">Predicted Expiration: ${f.expiration_date} · 6-Month Warning: ${f.warning_date}</span></li>`
    )).join("");
    forecastsHtml = `<h3 style="margin-top:20px;border-top:1px solid #ddd;padding-top:15px;font-family:system-ui">Upcoming Procurement Forecasts (Early Warning)</h3>
      <p style="font-size:13px;color:#666;font-style:italic;margin-bottom:12px">These are estimated contract expirations, not active open solicitations.</p>
      <ul style="list-style:none;padding:0">${fItems}</ul>`;
  }

  // Rules digests: group by what you can do now (comment open / hearing / adopted / other).
  let listHtml;
  if (rows.length === 0) {
    listHtml = `<p style="color:#666;font-style:italic">No new active notices matching your criteria.</p>`;
  } else if (kind === "district") {
    listHtml = districtGroupedListHtml(rows, item, esc);
  } else if (kind === "rules") {
    try {
      const groups = groupDigestRowsByActionBand(rows, { now: today });
      const bandEn = {
        rule_band_comment_open: "Comment window open",
        rule_band_comment_open_days: (v) => `Comment window open (${v?.n ?? "?"} days left)`,
        rule_band_hearing: "Hearing scheduled — attend",
        rule_band_hearing_dated: (v) => `Hearing scheduled — attend on ${v?.date || ""}`,
        rule_band_adopted: "Adopted",
        rule_band_adopted_effective: (v) => `Adopted — takes effect ${v?.date || ""}`,
        rule_band_other: "Other rule notices",
      };
      const blocks = groups.map((g) => {
        const labelText = rulesActionBandLabel({
          band_id: g.band_id,
          days_left: g.days_left,
          hearing_date: g.hearing_date,
          effective_date: g.effective_date,
        }, (key, vars) => {
          const v = bandEn[key];
          return typeof v === "function" ? v(vars) : (v || key);
        });
        const items = g.entries.map((e) => {
          const row = { ...(e.primary || e) };
          if (e.action_band) row.action_band = e.action_band;
          return item(row);
        }).join("");
        return `<h3 style="margin:16px 0 8px;font-family:system-ui;font-size:14px;color:#1a1a1a;border-bottom:1px solid #ddd;padding-bottom:4px">${esc(labelText)}</h3>
          <ul style="list-style:none;padding:0">${items}</ul>`;
      });
      listHtml = blocks.join("") || `<ul style="list-style:none;padding:0">${rows.map(item).join("")}</ul>`;
    } catch {
      listHtml = `<ul style="list-style:none;padding:0">${rows.map(item).join("")}</ul>`;
    }
  } else {
    listHtml = `<ul style="list-style:none;padding:0">${rows.map(item).join("")}</ul>`;
  }
  const itemWord = rows.length === 1
    ? emailT(lang, "digest_new_item_singular")
    : emailT(lang, "digest_new_item_plural");
  const countLine = since
    ? emailT(lang, "digest_new_items", { n: rows.length, item: itemWord, date: shortDate(since) })
    : emailT(lang, "digest_no_date", { n: rows.length, item: itemWord });

  const manageLine = manageUrl
    ? ` · <a href="${esc(manageUrl)}">${esc(emailT(lang, "digest_manage"))}</a>`
    : "";
  return `<div style="font-family:Georgia,serif;max-width:620px">
    <h2 style="font-family:system-ui">CityScroll — ${esc(label)}</h2>
    <p style="color:#555">${esc(countLine)}</p>
    ${listHtml}
    ${forecastsHtml}
    ${healthNote}
    <p style="color:#999;font-size:12px;margin-top:20px">${esc(emailT(lang, "digest_subscribed"))} <a href="${esc(unsubUrl)}">${esc(emailT(lang, "digest_unsubscribe"))}</a> (one-click)${manageLine}.</p>
  </div>`;
}

// The "no news" email — a weekly check-in or a daily heartbeat. Same house style as the digest so
// silence never reads as a malfunction: the subscriber hears from us on a predictable cadence.
function quietHtml(label, action, since, unsubUrl, lang = "en", healthNote = "", manageUrl = null) {
  const esc = (s) => String(s == null ? "" : s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  const sinceStr = since ? `since ${shortDate(since)}` : "so far";
  const leadKey = action === "weekly-empty" ? "quiet_nothing_week" : "quiet_still_watching";
  const leadTpl = emailT(lang, leadKey, { label, since: sinceStr });
  // Replace the label placeholder with bold markup (emailT escapes nothing; we escape the label)
  const lead = leadTpl.replace(esc(label), `<b>${esc(label)}</b>`);
  const manageLine = manageUrl
    ? ` · <a href="${esc(manageUrl)}">${esc(emailT(lang, "digest_manage"))}</a>`
    : "";
  return `<div style="font-family:Georgia,serif;max-width:620px">
    <h2 style="font-family:system-ui">CityScroll</h2>
    <p style="color:#333">${lead}</p>
    <p style="color:#666;font-size:13px">${esc(emailT(lang, "quiet_working"))}</p>
    ${healthNote}
    <p style="color:#999;font-size:12px">${esc(emailT(lang, "quiet_subscribed"))} <a href="${esc(unsubUrl)}">${esc(emailT(lang, "digest_unsubscribe"))}</a> (one-click)${manageLine}.</p>
  </div>`;
}

/**
 * Consolidated multi-watch digest HTML: one section per evaluated watch (matches,
 * quiet, or cadence-skipped). Footer: manage prefs + unsub all.
 */
function rollupDigestHtml({
  sections = [],
  wantingCount = null,
  watchCount = null,
  unsubAllUrl,
  manageUrl,
  lang = "en",
  sessionTok = null,
  base = "https://api.cityscroll.org",
} = {}) {
  const esc = (s) => String(s == null ? "" : s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
  const usd = (n) => (n == null || n === "" ? "" : "$" + Number(n).toLocaleString("en-US"));
  const cr = (id) => `https://a856-cityrecord.nyc.gov/RequestDetail/${encodeURIComponent(id)}`;
  const nTotal = Number.isFinite(Number(watchCount)) ? Number(watchCount) : sections.length;
  const nWant = Number.isFinite(Number(wantingCount))
    ? Number(wantingCount)
    : sections.filter((s) => (Number(s.new) || 0) > 0 || (Number(s.forecasts) || 0) > 0 || s.action === "match" || s.action === "heartbeat" || s.action === "weekly-empty").length;
  const summaryLine = nTotal > 1
    ? `${nWant} of ${nTotal} watches with updates`
    : `${nWant} watch${nWant === 1 ? "" : "es"} with updates`;

  const sectionHtml = sections.map((sec) => {
    const label = sec.label || sec.queryLabel || sec.lens || "Watch";
    if (sec.skipped) {
      const skipNote = sec.skipped === "weekly"
        ? "This watch is weekly — next check is Monday."
        : sec.skipped === "paused"
          ? "This watch is paused."
          : `Skipped (${sec.skipped}).`;
      return `<section style="margin:0 0 28px;padding-bottom:18px;border-bottom:1px solid #e5dfd3">
        <h3 style="font-family:system-ui;margin:0 0 8px">${esc(label)}</h3>
        <p style="color:#666;font-style:italic;margin:0">${esc(skipNote)}</p>
      </section>`;
    }
    if (sec.kind === "award" && Array.isArray(sec.awardCandidates)) {
      const items = sec.awardCandidates.map((c) => {
        const vendor = c.vendor ? esc(c.vendor) : esc(emailT(lang, "award_watch_vendor_unlisted"));
        const meta = [vendor, usd(c.amount), c.date ? esc(String(c.date).slice(0, 10)) : ""].filter(Boolean).join(" · ");
        return `<li data-digest-item="1" style="margin:0 0 10px">${meta}</li>`;
      }).join("");
      const requestId = sec.awardFilter?.requestId;
      const contextLink = requestId
        ? `<p style="font-size:13px"><a href="https://cityscroll.org/notices/${encodeURIComponent(requestId)}">View the watched notice on CityScroll</a></p>`
        : "";
      return `<section style="margin:0 0 28px;padding-bottom:18px;border-bottom:1px solid #e5dfd3">
        <h3 style="font-family:system-ui;margin:0 0 8px">${esc(label)}</h3>
        <ul style="list-style:none;padding:0;margin:0">${items || `<li style="color:#666;font-style:italic">No new award updates.</li>`}</ul>
        ${contextLink}
      </section>`;
    }

    const rows = sec.freshRows || [];
    const forecasts = sec.forecastRows || [];
    const keywords = sec.keywords || [];
    const w = sec.w || null;
    const today = new Date().toISOString().slice(0, 10);
    const renderRow = (r) => {
      const itemKind = sec.kind === "district" ? r.district_kind : sec.kind;
      const itemClass = sec.kind === "district" ? ' class="district-item"' : "";
      if (itemKind === "exam") {
        const link = `https://cityscroll.org/exams/${encodeURIComponent(r.exam_number)}/`;
        const dates = r.application_start && r.application_end ? `${String(r.application_start).slice(0, 10)}–${String(r.application_end).slice(0, 10)}` : "";
        const meta = [`Exam ${r.exam_number}`, dates, r.open_window_band].filter(Boolean).map(esc).join(" · ");
        return `<li data-digest-item="1"${itemClass} style="margin:0 0 12px"><b><a href="${link}">${esc(r.title || "Civil-service exam")}</a></b><br>
          <span style="color:#555;font-size:13px">${meta}</span><br>
          ${r.notice_url ? `<span style="color:#33691e;font-size:13px">NOE posted</span><br>` : ""}
          <span style="font-size:13px"><a href="${link}">↗ View exam on CityScroll</a>${r.notice_url ? ` · <a href="${esc(r.notice_url)}">Official NOE</a>` : ""}</span></li>`;
      }
      if (itemKind === "rezone") {
        const meta = [r.borough, r.community_district ? "CD " + r.community_district : "", r.public_status]
          .filter(Boolean).map(esc).join(" · ");
        return `<li data-digest-item="1"${itemClass} style="margin:0 0 12px"><b><a href="https://zap.planning.nyc.gov/projects/${encodeURIComponent(r.project_id)}">${esc(landProjectDisplayTitle(r))}</a></b><br>
          <span style="color:#555;font-size:13px">${meta}</span><br>
          ${temporalActionHtml(r, esc, lang, { kind: "rezone", today })}</li>`;
      }
      const titleText = r.short_title || "Notice";
      const ev = matchEvidence(titleText, r.additional_description_1, keywords);
      const qs = [];
      if (sessionTok) qs.push(`s=${encodeURIComponent(sessionTok)}`);
      if (w) qs.push(`w=${w}`);
      const rowKind = itemKind || "rfp";
      const noticeLink = `${base}/r/${encodeURIComponent(rowKind)}/${encodeURIComponent(r.request_id)}${qs.length ? `?${qs.join("&")}` : ""}`;
      const meta = [r.agency_name, usd(r.contract_amount), dueLabel(r.due_date)].filter(Boolean).map(esc).join(" · ");
      const propertyStage = itemKind === "property" && r.property_watch
        ? `<span style="color:#555;font-size:13px"><b>Matched at:</b> ${esc(propertyWatchStageLabel(r.property_watch.matched_at_stage))}${r.property_watch.transition ? ` · <b>${esc(r.property_watch.transition.label)}</b>` : ""}</span><br>`
        : "";
      return `<li data-digest-item="1"${itemClass} style="margin:0 0 12px"><b><a href="${noticeLink}">${titleHtml(titleText, ev, esc)}</a></b><br>
        <span style="color:#555;font-size:13px">${meta}</span><br>
        ${propertyStage}
        ${temporalActionHtml(r, esc, lang, { kind: rowKind, today })}
        ${digestMeetingDetailsHtml(r, esc, base)}
        ${evidenceLineHtml(ev, esc, lang)}
        <span style="font-size:13px"><a href="${noticeLink}">↗ View on CityScroll</a> · <a href="${cr(r.request_id)}">City Record</a></span></li>`;
    };
    const items = rows.map(renderRow).join("");

    let forecastsHtml = "";
    if (forecasts.length) {
      forecastsHtml = `<p style="font-size:13px;color:#666;margin:10px 0 6px">Forecasts</p><ul style="list-style:none;padding:0">${forecasts.map((f) =>
        `<li data-digest-item="1" style="margin:0 0 8px;font-size:13px">${esc(f.vendor_name || "Vendor")} · ${usd(f.amount)} · exp ${esc(f.expiration_date || "")}</li>`
      ).join("")}</ul>`;
    }

    const quiet = rows.length === 0 && forecasts.length === 0;
    const body = quiet
      ? `<p style="color:#666;font-style:italic;margin:0">Nothing new for this watch.</p>${sec.healthNote || ""}`
      : `${sec.kind === "district" ? districtGroupedListHtml(rows, renderRow, esc) : `<ul style="list-style:none;padding:0;margin:0">${items}</ul>`}${forecastsHtml}${sec.healthNote || ""}`;

    return `<section style="margin:0 0 28px;padding-bottom:18px;border-bottom:1px solid #e5dfd3">
      <h3 style="font-family:system-ui;margin:0 0 8px">${esc(label)}</h3>
      ${body}
    </section>`;
  }).join("");

  const manageLine = manageUrl
    ? `<a href="${esc(manageUrl)}">${esc(emailT(lang, "digest_manage"))}</a> · `
    : "";
  return `<div style="font-family:Georgia,serif;max-width:620px">
    <h2 style="font-family:system-ui">CityScroll — your daily digest</h2>
    <p style="color:#555;font-size:14px">${esc(summaryLine)}</p>
    ${sectionHtml}
    <p style="color:#999;font-size:12px;margin-top:20px">
      ${manageLine}<a href="${esc(unsubAllUrl)}">${esc(emailT(lang, "digest_unsubscribe_all"))}</a> (one-click).
      Preference changes take effect on the next daily run (~9am Eastern).
    </p>
  </div>`;
}

export async function matchForecasts(env, s, today) {
  const matched = [];
  if (!env.ALERT_STATE) return matched;

  const stems = [];
  if (s.lens === "entity" && s.filter && s.filter.name) {
    stems.push(vendorStem(s.filter.name));
  }
  if (s.lens === "money" && s.filter && s.filter.agency) {
    stems.push(vendorStem(s.filter.agency));
  }

  const LIVE = env.ALERTS_LIVE === "true";

  for (const stem of stems) {
    if (stem.length < 3) continue;

    // Checkbook expirations
    const fcRaw = await env.ALERT_STATE.get(`fc:${stem}`);
    if (fcRaw) {
      const list = JSON.parse(fcRaw);
      for (const fx of list) {
        // warning_date single-fire maps to the approaching band in the prediction
        // ontology; delivery identity stays the historical sent:fc:… key.
        if (forecastIsDeliverableOn(fx, today)) {
          const forecastId = forecastSentIdentity(fx.contract_id, s.key);
          const sent = await env.ALERT_STATE.get(`sent:${forecastId}`);
          if (!sent) {
            matched.push(fx);
            if (LIVE) {
              await env.ALERT_STATE.put(`sent:${forecastId}`, "1");
            }
          }
        }
      }
    }
  }

  return matched;
}
