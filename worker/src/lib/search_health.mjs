// search_health — a saved watch that has matched nothing for months is a silent dead end its
// owner still believes is working. This tracks, per subscription, the last time a digest run
// found a genuine new match, and — once a watch has been quiet past a threshold — lets the next
// digest say so plainly and link back to the alerts builder with the watch pre-filled, where the
// existing "understood as" echo (see NL.alerts in index.html) helps broaden it.
//
// Storage lives entirely inside the subscription's own SUBS KV record (a `health` field on the
// same object subscriptions.mjs already defines) — no separate per-user KV entry. `matched` is
// judged from the digest's own `fresh` count, the same signal the send decision already uses, so
// quiet status and the note shown can never disagree about what "matched" means.

import { daysBetween } from "./digest.mjs";
import { emailT } from "./i18n.mjs";

// 8 weeks: long enough that a normal slow stretch for a narrow watch doesn't false-positive,
// short enough that "gone quiet" still means something to the reader.
export const QUIET_THRESHOLD_DAYS = 56;

// Pure: the health record to persist after this run, given the PRIOR stored record (possibly
// missing or malformed — any shape mismatch is treated as "no history yet," never thrown) and
// whether this run found a genuine new match.
export function nextSearchHealth(prevHealth, matched, today) {
  if (matched) return { lastMatchAt: today };
  const lastMatchAt = prevHealth && typeof prevHealth.lastMatchAt === "string" ? prevHealth.lastMatchAt : null;
  return { lastMatchAt };
}

// Pure: is this subscription currently quiet, and for how long. `createdAt` (already stored on
// every subscription) anchors a watch that has never matched — otherwise a brand-new watch would
// read as "quiet since forever" the moment it's created, which is not the same claim as "this
// used to work and stopped." Any malformed/missing date fails soft to "not quiet": an uncertain
// read must never manufacture a false alarm.
export function searchHealthStatus({ health, createdAt, today, thresholdDays = QUIET_THRESHOLD_DAYS }) {
  const lastMatchAt = health && typeof health.lastMatchAt === "string" ? health.lastMatchAt : null;
  const anchor = lastMatchAt || (typeof createdAt === "string" ? createdAt : null);
  if (!anchor) return { quiet: false, quietDays: null };
  const quietDays = daysBetween(anchor, today);
  if (!Number.isFinite(quietDays)) return { quiet: false, quietDays: null };
  return { quiet: quietDays >= thresholdDays, quietDays };
}

// The fix-path link: the alerts page, pre-filled with this watch's own {lens,filter,freq} — the
// same shape already stored on the subscription — so the site's existing interpretation echo
// (a money-lens watch renders as "moneynl," which already echoes "understood as" chips on a
// zero-match preview) helps the reader see, and broaden, exactly what's being searched.
export function alertsFixUrl(lens, filter, freq, base = "https://crol-list.org") {
  const params = new URLSearchParams();
  params.set("lens", lens || "");
  params.set("filter", JSON.stringify(filter || {}));
  if (freq) params.set("freq", freq);
  return `${base}/#alerts?${params.toString()}`;
}

// The note appended to whichever digest HTML fires for a quiet run — never its own email; it
// rides the existing cadence. `weeks` is derived from the actual quiet span, not hardcoded, so
// the copy can't drift from the gate that decided to show it.
export function searchHealthNoteHtml({ lang = "en", quietDays, url }) {
  const esc = (s) => String(s == null ? "" : s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  const weeks = Math.max(1, Math.round((Number.isFinite(quietDays) ? quietDays : QUIET_THRESHOLD_DAYS) / 7));
  return `<p style="color:#a42;font-size:13px;margin-top:14px;padding-top:12px;border-top:1px solid #ddd">${esc(emailT(lang, "search_health_quiet", { weeks }))} <a href="${esc(url)}">${esc(emailT(lang, "search_health_fix"))}</a></p>`;
}
