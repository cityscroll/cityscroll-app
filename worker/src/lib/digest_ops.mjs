// Pure helpers for the operator digest dashboard: day-by-day send logs, roster
// shaping, and the "is it correct?" recount check. No I/O — unit-testable.

import { redactEmail } from "./subscriptions.mjs";
import { describeFilter } from "./confirm_email.mjs";

/** KV key for the durable per-day send log (ALERT_STATE). */
export function digestDayLogKey(day) {
  return `digest:daylog:${day}`;
}

/**
 * Collapse one processOneSub / config-watch result into a day-log entry.
 * Never stores a raw email — redacted only. Notice ids are public City Record ids.
 */
export function toDayLogEntry(result = {}, { day = null } = {}) {
  if (!result || typeof result !== "object") return null;
  // Queue fan-out placeholder is not a per-sub outcome.
  if (result.mode === "queue") return null;

  const noticeIds = Array.isArray(result.noticeIds)
    ? result.noticeIds.map(String).filter(Boolean).slice(0, 100)
    : [];
  // noticeCount = NEW notices included in a send (fresh / unseen).
  const noticeCount = Number.isFinite(result.new) ? Number(result.new) : noticeIds.length;
  // found = all query matches this run (including already-seen). Used for silent-miss checks.
  const found = Number.isFinite(result.found) ? Number(result.found) : null;
  const sent = !!result.sent;
  const dryRun = !!result.dryRun;
  const capped = !!result.capped;
  const action = result.action || (result.skipped ? `skipped:${result.skipped}` : null);
  // Watermark recovery: stamp traffic_class so ops can distinguish multi-day catch-up
  // from a normal daily drip (action alone is enough for historical rows).
  const isCatchUp =
    action === "catch_up" ||
    result.mode === "catch_up" ||
    result.traffic_class === "catch_up";
  const zeroMatch =
    result.zeroMatch === true ||
    (noticeCount === 0 && found === 0 && action === "none") ||
    (noticeCount === 0 && found === 0 && !sent && !dryRun && !result.error && !result.skipped);

  return {
    day: day || result.day || null,
    kind: result.watch ? "config_watch" : "subscription",
    id: result.watch || result.sub || result.subKey || null,
    lens: result.lens || result.type || null,
    query: result.queryLabel || result.query || result.label || null,
    email: result.emailRedacted || (result.email ? redactEmail(result.email) : null),
    found,
    noticeCount,
    noticeIds,
    noticeLinks: noticeIds.map(noticeDeepLink),
    action,
    traffic_class: isCatchUp ? "catch_up" : (result.traffic_class || null),
    sent,
    dryRun,
    capped,
    zeroMatch,
    error: result.error || null,
    forecasts: Number(result.forecasts) || 0,
  };
}

/** True when a day-log entry is a watermark-recovery catch-up send (not a daily drip). */
export function isCatchUpDayLogEntry(entry, dayLog = null) {
  if (!entry || typeof entry !== "object") return false;
  if (entry.action === "catch_up") return true;
  if (entry.traffic_class === "catch_up") return true;
  if (entry.mode === "catch_up") return true;
  // Pure catch-up day log (no mixed daily rows): exempt every recountable entry.
  if (dayLog && dayLog.mode === "catch_up") return true;
  return false;
}

/** Public site deep link for a City Record request id (no PII). */
export function noticeDeepLink(requestId) {
  return `https://cityscroll.org/#notice/${encodeURIComponent(String(requestId))}`;
}

/**
 * Build the durable day log body from a run's result list.
 * Includes zero-match rows so absence is visible, not skipped.
 */
export function buildDayLog({ day, ranAt, live, mode, results = [] } = {}) {
  const entries = [];
  for (const r of results) {
    const e = toDayLogEntry(r, { day });
    if (e) entries.push(e);
  }
  const sentEntries = entries.filter((e) => e.sent);
  const zeroSend = entries.filter((e) => e.zeroMatch || (e.noticeCount === 0 && !e.sent && !e.error));
  const totalNotices = sentEntries.reduce((n, e) => n + (e.noticeCount || 0), 0);
  return {
    day: day || null,
    ranAt: ranAt || new Date().toISOString(),
    live: !!live,
    mode: mode || "inline",
    entryCount: entries.length,
    sentCount: sentEntries.length,
    zeroSendCount: zeroSend.length,
    totalNotices,
    entries,
  };
}

/**
 * Merge one queue job outcome into an existing day log (or create a fresh one).
 * Idempotent enough for retries: same `id` replaces the prior entry for that sub.
 */
export function mergeDayLogEntry(existing, entry, { day, ranAt, live, mode } = {}) {
  const base = existing && typeof existing === "object"
    ? { ...existing, entries: Array.isArray(existing.entries) ? [...existing.entries] : [] }
    : {
        day: day || null,
        ranAt: ranAt || new Date().toISOString(),
        live: !!live,
        mode: mode || "queue",
        entryCount: 0,
        sentCount: 0,
        zeroSendCount: 0,
        totalNotices: 0,
        entries: [],
      };
  if (!entry) return recomputeDayLogTotals(base);
  const id = entry.id;
  if (id) {
    const idx = base.entries.findIndex((e) => e && e.id === id);
    if (idx >= 0) base.entries[idx] = entry;
    else base.entries.push(entry);
  } else {
    base.entries.push(entry);
  }
  if (day) base.day = day;
  if (ranAt) base.updatedAt = ranAt;
  if (live != null) base.live = !!live;
  if (mode) base.mode = mode;
  return recomputeDayLogTotals(base);
}

function recomputeDayLogTotals(log) {
  const entries = Array.isArray(log.entries) ? log.entries : [];
  const sentEntries = entries.filter((e) => e && e.sent);
  const zeroSend = entries.filter((e) => e && (e.zeroMatch || (e.noticeCount === 0 && !e.sent && !e.error)));
  return {
    ...log,
    entryCount: entries.length,
    sentCount: sentEntries.length,
    zeroSendCount: zeroSend.length,
    totalNotices: sentEntries.reduce((n, e) => n + (Number(e.noticeCount) || 0), 0),
  };
}

/** UTC day strings for the last N days ending at `endDay` (inclusive). */
export function dayRange(endDay, days = 14) {
  const n = Math.max(1, Math.min(90, Number(days) || 14));
  const end = parseDay(endDay) || new Date();
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function parseDay(day) {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(String(day))) return null;
  const d = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Shape a day summary for the dashboard table.
 * Days with no log still appear (absence visible) when included via dayRange.
 */
export function summarizeDay({ day, dayLog = null, receipt = null, sendcount = null } = {}) {
  const hasLog = !!(dayLog && Array.isArray(dayLog.entries));
  const entries = hasLog ? dayLog.entries : [];
  const sent = hasLog
    ? Number(dayLog.sentCount) || 0
    : (receipt && Number.isFinite(receipt.sent) ? Number(receipt.sent) : null);
  const matched = hasLog
    ? entries.filter((e) => (e.noticeCount || 0) > 0 || e.action === "match").length
    : (receipt && Number.isFinite(receipt.matched) ? Number(receipt.matched) : null);
  const totalNotices = hasLog
    ? Number(dayLog.totalNotices) || 0
    : null;
  const zeroSendCount = hasLog
    ? Number(dayLog.zeroSendCount) || 0
    : null;
  // Watermark-recovery rows for ops drill UI (pill / calm note, not daily drip).
  const catchUpSendCount = hasLog
    ? entries.filter((e) => e && isCatchUpDayLogEntry(e, dayLog) && e.sent).length
    : 0;
  const skipped_reason = receipt?.skipped_reason ?? (hasLog && sent === 0 && entries.length === 0 ? "no_log" : null);

  return {
    day,
    hasLog,
    sent,
    matched,
    totalNotices,
    zeroSendCount,
    catchUpSendCount,
    sendcount: sendcount == null ? null : Number(sendcount) || 0,
    skipped_reason,
    receipt: receipt
      ? {
          ranAt: receipt.ranAt || null,
          live: !!receipt.live,
          mode: receipt.mode || null,
          sent: Number(receipt.sent) || 0,
          matched: Number(receipt.matched) || 0,
          skipped_reason: receipt.skipped_reason || null,
        }
      : null,
    // Per-send rows for drill-down (empty array when no log — not omitted).
    // Each entry may carry action/traffic_class "catch_up" for recovery pills.
    sends: entries,
  };
}

/**
 * Roster row from a SUBS record + optional lastsent.
 * Full email is allowed only on admin-gated responses (caller responsibility).
 */
export function toRosterRow(sub, { lastSent = null, key = null } = {}) {
  if (!sub || typeof sub !== "object") return null;
  const lens = sub.lens || null;
  const filter = sub.filter || {};
  return {
    key: key || sub.key || null,
    email: sub.email || null,
    emailRedacted: redactEmail(sub.email),
    lens,
    filter,
    query: describeFilter(lens, filter),
    freq: sub.freq || "daily",
    channel: sub.channel || "email",
    lang: sub.lang || "en",
    // SUBS only holds confirmed watches (pending tokens never land here).
    confirmed: true,
    createdAt: sub.createdAt || null,
    lastSent: lastSent || null,
    health: sub.health || null,
  };
}

/**
 * Group roster into search/interest signal: unique queries and which addresses hold them.
 */
export function searchInterestSignal(roster = []) {
  const byQuery = new Map();
  for (const r of roster) {
    if (!r) continue;
    const qKey = JSON.stringify({ lens: r.lens, filter: r.filter || {} });
    let row = byQuery.get(qKey);
    if (!row) {
      row = {
        lens: r.lens,
        filter: r.filter || {},
        query: r.query,
        subscriberCount: 0,
        emailsRedacted: [],
        lastSentAny: null,
        createdAtEarliest: r.createdAt || null,
      };
      byQuery.set(qKey, row);
    }
    row.subscriberCount++;
    if (r.emailRedacted) row.emailsRedacted.push(r.emailRedacted);
    if (r.lastSent && (!row.lastSentAny || r.lastSent > row.lastSentAny)) {
      row.lastSentAny = r.lastSent;
    }
    if (r.createdAt && (!row.createdAtEarliest || r.createdAt < row.createdAtEarliest)) {
      row.createdAtEarliest = r.createdAt;
    }
  }
  return [...byQuery.values()].sort((a, b) => b.subscriberCount - a.subscriberCount);
}

/**
 * Compare one day's logged notice counts against a fresh recount.
 *
 * recounts: Map or object keyed by entry id -> { noticeCount, noticeIds? }
 *   The recount is day-scoped ("what matched with start_date = day").
 *
 * Catches the silent-outage class: logged zero / quiet when the query still
 * finds notices for that day. Exact count equality is checked when both sides
 * are positive; a zero-vs-positive mismatch is always a loud divergence.
 *
 * Catch-up / watermark-recovery sends intentionally cover a multi-day window
 * since lastsent. Day-scoped recounts often under-count those emails; do not
 * treat that as phantom_send or count_mismatch. Historical rows with only
 * `action: "catch_up"` (no traffic_class) remain recognized.
 */
export function correctnessCheck({ day, dayLog = null, recounts = {} } = {}) {
  const getRecount = (id) => {
    if (recounts == null) return null;
    if (typeof recounts.get === "function") return recounts.get(id) ?? null;
    return Object.prototype.hasOwnProperty.call(recounts, id) ? recounts[id] : null;
  };

  if (!dayLog || !Array.isArray(dayLog.entries) || dayLog.entries.length === 0) {
    return {
      day: day || dayLog?.day || null,
      status: "no_log",
      ok: false,
      summary: "No per-subscription send log for this day — cannot check correctness.",
      divergences: [],
      checked: 0,
      matched: 0,
      catchUpExempt: 0,
    };
  }

  const divergences = [];
  let checked = 0;
  let matched = 0;
  let catchUpExempt = 0;

  for (const e of dayLog.entries) {
    if (!e || e.error) continue;
    // Heartbeats / weekly-empty are intentional non-match emails — still check
    // that the query did not silently start matching again under a wrong action.
    if (e.action && String(e.action).startsWith("skipped:")) continue;
    if (e.capped) continue;

    const rc = getRecount(e.id);
    if (rc == null) continue;
    checked++;
    const loggedNew = Number(e.noticeCount) || 0;
    // Prefer `found` (all matches) for silent-miss; fall back to noticeCount.
    const loggedFound = Number.isFinite(e.found) ? Number(e.found) : loggedNew;
    const expected = Number(rc.noticeCount);
    if (!Number.isFinite(expected)) continue;

    // Primary outage signal: the query returned nothing (`found === 0`) while a
    // day-scoped recount still finds notices. Already-seen (found > 0, new = 0)
    // is healthy and must not flag.
    const silentMiss = loggedFound === 0 && expected > 0;
    // Secondary: both sides positive but the sent/new count exceeds what the day
    // holds (query drift / wrong window). Under-count alone is not always a bug
    // (seen: filtering), so only flag over-count vs day-scoped.
    const countMismatch = loggedNew > 0 && expected > 0 && loggedNew > expected;
    // Tertiary: sent "new" notices whose day-scoped recount is empty.
    const phantomSend = loggedNew > 0 && expected === 0;

    const catchUp = isCatchUpDayLogEntry(e, dayLog);
    // Catch-up recovery emails multi-day notices; day-scoped expected under-count
    // is expected. Do not flag phantom_send / count_mismatch. Successful catch-up
    // sends count as matched for the day-scoped check. silent_miss still flags.
    if (catchUp && (phantomSend || countMismatch) && !silentMiss) {
      matched++;
      catchUpExempt++;
      continue;
    }

    if (!silentMiss && !countMismatch && !phantomSend) {
      matched++;
      continue;
    }

    let reason = "count_mismatch";
    if (silentMiss) reason = "silent_miss";
    else if (phantomSend) reason = "phantom_send";

    divergences.push({
      id: e.id,
      lens: e.lens,
      query: e.query,
      reason,
      logged: loggedNew,
      loggedFound,
      expected,
      delta: expected - loggedFound,
      loggedIds: e.noticeIds || [],
      expectedIds: Array.isArray(rc.noticeIds) ? rc.noticeIds.map(String) : [],
      catchUp: !!catchUp,
    });
  }

  const catchUpNote = catchUpExempt > 0
    ? ` ${catchUpExempt} catch-up send(s) exempt from day-scoped phantom check.`
    : "";

  let status;
  let summary;
  if (checked === 0) {
    status = "unchecked";
    summary = "No recountable subscriptions for this day.";
  } else if (divergences.length === 0) {
    status = "ok";
    summary = `Correct: ${matched}/${checked} subscription(s) match a fresh recount.${catchUpNote}`;
  } else {
    status = "diverge";
    const silent = divergences.filter((d) => d.reason === "silent_miss").length;
    summary = silent > 0
      ? `DIVERGENCE: ${silent} silent miss(es) — digest reported zero while a fresh recount finds notices. (${divergences.length} total issue(s) of ${checked} checked)${catchUpNote}`
      : `DIVERGENCE: ${divergences.length} of ${checked} subscription(s) disagree with a fresh recount.${catchUpNote}`;
  }

  return {
    day: day || dayLog.day || null,
    status,
    ok: status === "ok",
    summary,
    divergences,
    checked,
    matched,
    catchUpExempt,
  };
}

/**
 * Pure: given a list of rows returned by a re-run of the subscription query and
 * a set of previously-seen ids, compute the "fresh" notice count the digest
 * would have treated as new. Used by the admin recount path and tests.
 */
export function recountFresh({ rows = [], idField = "request_id", seenIds = [] } = {}) {
  const seen = new Set((seenIds || []).map(String));
  const ids = [];
  for (const r of rows || []) {
    if (!r || typeof r !== "object") continue;
    const id = r[idField] != null ? String(r[idField]) : (r.request_id != null ? String(r.request_id) : null);
    if (!id || seen.has(id)) continue;
    if (!ids.includes(id)) ids.push(id);
  }
  return { noticeCount: ids.length, noticeIds: ids.slice(0, 100) };
}
