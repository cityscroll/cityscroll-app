// Pure helpers for account-level digest rollup.
//
// Account = one email identity aggregating one or more watches (SUBS rows).
// When an account has more than one active watch, the daily run sends one
// consolidated email with a section per watch that has content (or a quiet
// summary), not one email per watch. One rollup email counts as one send unit
// toward MAX_PER_RUN / MAX_SENDS_PER_DAY.
//
// Cutover: preference-center edits (pause, keywords, freq, delete) are stored
// immediately on the SUBS record and take effect on the next daily cron
// (~13:00 UTC / ~9am Eastern).

import { normalizeEmail, redactEmail } from "./subscriptions.mjs";

/** Active = not paused. Missing/false paused → active. */
export function isWatchActive(sub) {
  if (!sub || typeof sub !== "object") return false;
  return !sub.paused;
}

/**
 * Group confirmed SUBS rows by normalized email.
 * Returns Map<email, sub[]> with stable key order (insertion by first sighting).
 */
export function groupSubsByEmail(subs = []) {
  const map = new Map();
  for (const s of subs || []) {
    if (!s || !s.email) continue;
    const e = normalizeEmail(s.email);
    if (!e) continue;
    let list = map.get(e);
    if (!list) {
      list = [];
      map.set(e, list);
    }
    list.push(s);
  }
  return map;
}

/** Rollup when more than one active (non-paused) watch shares the email. */
export function shouldRollup(subsForEmail = []) {
  const active = (subsForEmail || []).filter(isWatchActive);
  return active.length > 1;
}

/**
 * Build queue fan-out jobs from a full SUBS list.
 * - Multi-active-watch accounts → one { type:"rollup", email, keys }
 * - Single active watch → one { type:"sub", key } (legacy shape also sets key for consumers)
 * Paused-only accounts produce no job.
 */
export function buildDigestJobs(subs = []) {
  const jobs = [];
  const byEmail = groupSubsByEmail(subs);
  for (const [email, list] of byEmail) {
    const active = list.filter(isWatchActive);
    if (active.length === 0) continue;
    if (active.length > 1) {
      jobs.push({
        type: "rollup",
        email,
        keys: active.map((s) => s.key).filter(Boolean),
      });
    } else {
      const key = active[0].key;
      jobs.push({ type: "sub", key, email });
    }
  }
  return jobs;
}

/**
 * Whether a single section evaluation wants to contribute to a send.
 * Mirrors processOneSub's underCap want (action !== none or forecasts).
 */
export function sectionWantsSend(section) {
  if (!section || section.error || section.skipped) return false;
  if (section.paused) return false;
  const fresh = Number(section.new) || 0;
  const forecasts = Number(section.forecasts) || 0;
  if (fresh > 0 || forecasts > 0) return true;
  const action = section.action;
  return action === "match" || action === "heartbeat" || action === "weekly-empty";
}

/**
 * Aggregate section evaluations into one account-level send decision.
 * wantSend when any section wants send. subject parts from sections with content.
 */
export function rollupSendDecision(sections = []) {
  const list = Array.isArray(sections) ? sections : [];
  const wanting = list.filter(sectionWantsSend);
  const totalNew = list.reduce((n, s) => n + (Number(s.new) || 0), 0);
  const totalForecasts = list.reduce((n, s) => n + (Number(s.forecasts) || 0), 0);
  const labels = wanting
    .map((s) => s.queryLabel || s.label || s.lens || "watch")
    .filter(Boolean);
  return {
    wantSend: wanting.length > 0,
    sectionCount: list.length,
    wantingCount: wanting.length,
    totalNew,
    totalForecasts,
    labels,
  };
}

/**
 * Subject line for a rollup digest (English; i18n can wrap later).
 *
 * When the account has more than one active watch (`watchCount > 1`), always use the
 * multi-watch form — even if only one section had matches. Naming the single wanting
 * label made a real account-level rollup look like a single-watch notification.
 */
export function rollupSubject({ totalNew, totalForecasts, labels = [], quiet = false, watchCount = null } = {}) {
  const nWatches = Number(watchCount);
  const multi = (Number.isFinite(nWatches) && nWatches > 1) || labels.length > 1;
  const multiN = (Number.isFinite(nWatches) && nWatches > 1) ? nWatches : (labels.length || 1);

  if (quiet || (totalNew === 0 && totalForecasts === 0)) {
    if (multi) return `CityScroll: still watching — ${multiN} watches`;
    return `CityScroll: still watching — ${labels[0] || "your watches"}`;
  }
  const parts = [];
  if (totalNew > 0) parts.push(`${totalNew} new`);
  if (totalForecasts > 0) parts.push(`${totalForecasts} forecast(s)`);
  const head = parts.join(" & ") || "update";
  if (multi) return `CityScroll: ${head} — ${multiN} watches`;
  if (labels.length === 1) return `CityScroll: ${head} — ${labels[0]}`;
  return `CityScroll: ${head}`;
}

/**
 * Sections to render in a rollup body.
 * Multi-watch accounts always include every evaluated watch (quiet + skipped cadence),
 * not only sections that wanted send — so one match cannot collapse the email to a
 * single-watch shape.
 */
export function rollupBodySections(sections = []) {
  const list = Array.isArray(sections) ? sections : [];
  return list.filter((s) => {
    if (!s || s.error) return false;
    // Composite district watches use honest-absent action groups. When the
    // materialized district list has no fresh items, omit the whole watch from
    // a sibling-triggered rollup instead of rendering "nothing this week".
    if (s.lens === "district" || s.lens === "obligations") return (Number(s.new) || 0) > 0;
    return true;
  });
}

/** Stable anchor id for a rollup section (email TOC jump links). */
export function rollupSectionAnchorId(label, index = 0) {
  const slug = String(label || "watch")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "watch";
  return `watch-${Number(index) || 0}-${slug}`;
}

/**
 * Whether a body section should render as a one-line quiet summary (no item chrome).
 * Quiet honesty still includes the section so multi-watch mail cannot look single-watch.
 */
export function isQuietRollupSection(section) {
  if (!section || section.error) return false;
  if (section.skipped) return true;
  // Award-arrival watches (lens "award") render candidates, not City Record freshRows.
  if (section.lens === "award" && Array.isArray(section.awardCandidates)) {
    return section.awardCandidates.length === 0;
  }
  const fresh = Number(section.new);
  const freshCount = Number.isFinite(fresh)
    ? fresh
    : Array.isArray(section.freshRows) ? section.freshRows.length : 0;
  const forecasts = Number(section.forecasts);
  const forecastCount = Number.isFinite(forecasts)
    ? forecasts
    : Array.isArray(section.forecastRows) ? section.forecastRows.length : 0;
  return freshCount === 0 && forecastCount === 0;
}

/**
 * TOC entries for multi-watch rollup bodies: total-new jump index per watch.
 * Each entry: { id, label, count, quiet, skipped, statusLabel }.
 */
export function rollupTocEntries(sections = []) {
  return (Array.isArray(sections) ? sections : []).map((sec, i) => {
    const label = sec.label || sec.queryLabel || sec.lens || "Watch";
    const id = rollupSectionAnchorId(label, i);
    if (sec.skipped) {
      const statusLabel = sec.skipped === "weekly"
        ? "weekly — next Monday"
        : sec.skipped === "paused"
          ? "paused"
          : `skipped (${sec.skipped})`;
      return { id, label, count: 0, quiet: true, skipped: sec.skipped, statusLabel };
    }
    const fresh = Number(sec.new);
    const count = Number.isFinite(fresh)
      ? fresh
      : Array.isArray(sec.freshRows) ? sec.freshRows.length : 0;
    const forecasts = Number(sec.forecasts);
    const forecastCount = Number.isFinite(forecasts)
      ? forecasts
      : Array.isArray(sec.forecastRows) ? sec.forecastRows.length : 0;
    const quiet = isQuietRollupSection(sec);
    let statusLabel;
    if (quiet) statusLabel = "no new matches";
    else if (count > 0 && forecastCount > 0) statusLabel = `${count} new · ${forecastCount} forecast(s)`;
    else if (count > 0) statusLabel = `${count} new`;
    else statusLabel = `${forecastCount} forecast(s)`;
    return { id, label, count, quiet, skipped: null, statusLabel };
  });
}

/**
 * One-line quiet section copy: "Hearings — no new matches."
 * Full item chrome stays on sections with matches.
 */
export function quietRollupSectionLine(label, statusLabel = "no new matches") {
  const name = String(label || "Watch").trim() || "Watch";
  const status = String(statusLabel || "no new matches").trim() || "no new matches";
  return `${name} — ${status}`;
}

/**
 * Day-log entry for an account-level rollup send (or dry-run).
 * Never stores a raw email — redacted only.
 */
export function toRollupDayLogEntry(result = {}, { day = null } = {}) {
  if (!result || typeof result !== "object") return null;
  const noticeIds = Array.isArray(result.noticeIds)
    ? result.noticeIds.map(String).filter(Boolean).slice(0, 100)
    : [];
  const noticeCount = Number.isFinite(result.new) ? Number(result.new) : noticeIds.length;
  const action = result.action || (result.skipped ? `skipped:${result.skipped}` : "rollup");
  // Mirror toDayLogEntry: stamp traffic_class for multi-day lag recovery / catch-up.
  const isCatchUp =
    action === "catch_up" ||
    result.mode === "catch_up" ||
    result.traffic_class === "catch_up";
  const sections = Array.isArray(result.sections)
    ? result.sections.map((sec) => ({
        id: sec.sub || sec.subKey || sec.key || null,
        lens: sec.lens || null,
        query: sec.queryLabel || sec.label || null,
        noticeCount: Number(sec.new) || 0,
        action: sec.action || null,
        skipped: sec.skipped || null,
        error: sec.error || null,
      }))
    : [];
  return {
    day: day || result.day || null,
    kind: "rollup",
    id: result.sub || result.accountId || null,
    lens: "account",
    query: result.queryLabel || (sections.length ? `${sections.length} watches` : "account rollup"),
    email: result.emailRedacted || (result.email ? redactEmail(result.email) : null),
    found: Number.isFinite(result.found) ? Number(result.found) : null,
    noticeCount,
    noticeIds,
    noticeLinks: noticeIds.map((id) => `https://cityscroll.org/notices/${encodeURIComponent(id)}`),
    action,
    traffic_class: isCatchUp ? "catch_up" : (result.traffic_class || null),
    sent: !!result.sent,
    dryRun: !!result.dryRun,
    capped: !!result.capped,
    zeroMatch: result.zeroMatch === true || (noticeCount === 0 && !result.sent && !result.dryRun && !result.error),
    error: result.error || null,
    forecasts: Number(result.forecasts) || 0,
    sections,
    sendUnits: 1, // one rollup email = one send unit
  };
}

/** Opaque short account id for daylog / results (no PII). */
export function accountLogId(email) {
  const e = normalizeEmail(email);
  if (!e) return "account:***";
  const at = e.indexOf("@");
  const u = at > 0 ? e.slice(0, Math.min(2, at)) : e.slice(0, 2);
  return `account:${u}***`;
}
