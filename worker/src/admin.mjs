// Operator read routes under /admin/* — FAIL CLOSED until ADMIN_KEY is set.
// Shared gate: checkAdminKey (query ?key= or Authorization: Bearer).
//
// Routes:
//   GET /admin/subs          — confirmed subscription roster (redacted emails; legacy)
//   GET /admin/feedback      — stored feedback rows
//   GET /admin/roster        — full roster + last-sent (emails for admin only)
//   GET /admin/sends         — day-by-day digest sends + drill-down + correctness
//   GET /admin/ops           — combined payload for the internal ops dashboard
//
// Subscriber emails are personal data: never returned without checkAdminKey,
// never logged, never placed in URLs by these handlers.

import { redactEmail } from "./lib/subscriptions.mjs";
import { describeFilter } from "./lib/confirm_email.mjs";
import {
  dayRange,
  summarizeDay,
  toRosterRow,
  searchInterestSignal,
  correctnessCheck,
  recountFresh,
  digestDayLogKey,
  noticeDeepLink,
} from "./lib/digest_ops.mjs";
import { compileSub } from "./lib/compile.mjs";
import { compileSub_d1, toDigestRow, OFF_MIRROR_LENSES } from "./lib/compile_d1.mjs";
import { buildNoticesQuery } from "./lib/notices.mjs";

// Shared auth gate for every /admin/* route: key via ?key= or an Authorization: Bearer header.
// FAIL CLOSED — 404 (not 401) until ADMIN_KEY is configured, so an unconfigured deploy doesn't
// even reveal the route exists. Returns { ok:true } or { ok:false, res:<Response to return> }.
export function checkAdminKey(req, env) {
  if (!env.ADMIN_KEY) return { ok: false, res: json({ error: "not found" }, 404) };
  const url = new URL(req.url);
  const key = url.searchParams.get("key") || (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (key !== env.ADMIN_KEY) return { ok: false, res: json({ error: "unauthorized" }, 401) };
  return { ok: true };
}

export async function handleAdminSubs(req, env) {
  const auth = checkAdminKey(req, env);
  if (!auth.ok) return auth.res;
  if (!env.SUBS) return json({ error: "no-store" }, 503);

  const subs = [];
  const sampleKeys = [];
  let cursor, totalKeys = 0;
  do {
    const res = await env.SUBS.list({ cursor });
    totalKeys += res.keys.length;
    for (const k of res.keys) {
      if (sampleKeys.length < 12) sampleKeys.push(maskKey(k.name));
      if (k.name.startsWith("sub:")) {
        let v = null;
        try { v = JSON.parse(await env.SUBS.get(k.name)); } catch { /* skip */ }
        if (v) subs.push({ email: redactEmail(v.email), lens: v.lens, filter: v.filter, freq: v.freq, createdAt: v.createdAt });
      }
    }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);

  return json({ confirmedSubs: subs.length, totalKeysInStore: totalKeys, subs, sampleKeys }, 200);
}

// GET /admin/feedback?key=… — operator read of stored feedback rows, straight from the worker's
// OWN FEEDBACK binding. FAIL CLOSED: 404 until ADMIN_KEY is set. Read-only. Newest first. Emails
// are redacted here (the notification email carries the real Reply-To); only `fb:` rows are read,
// so the rate-limit counters (rl:*) in the same namespace stay out of the listing.
export async function handleAdminFeedback(req, env) {
  const auth = checkAdminKey(req, env);
  if (!auth.ok) return auth.res;
  if (!env.FEEDBACK) return json({ error: "no-store" }, 503);

  const items = [];
  let cursor, totalKeys = 0;
  do {
    const res = await env.FEEDBACK.list({ prefix: "fb:", cursor });
    totalKeys += res.keys.length;
    for (const k of res.keys) {
      let v = null;
      try { v = JSON.parse(await env.FEEDBACK.get(k.name)); } catch { /* skip */ }
      if (v) items.push({
        id: k.name,
        category: v.category,
        message: v.message,
        email: v.email ? redactEmail(v.email) : "",
        ip: v.ip,
        ua: v.ua,
        at: v.at,
      });
    }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);

  items.sort((a, b) => (String(a.at) < String(b.at) ? 1 : -1)); // newest first
  return json({ feedbackCount: items.length, totalFbKeys: totalKeys, items }, 200);
}

// GET /admin/roster?key=… — full subscriber roster for the ops dashboard.
// Emails are returned in full (admin-gated only). Cache-Control: private, no-store.
export async function handleAdminRoster(req, env) {
  const auth = checkAdminKey(req, env);
  if (!auth.ok) return auth.res;
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
  if (!env.SUBS) return json({ error: "no-store" }, 503);

  const { roster, queries } = await loadRosterAndQueries(env);
  return jsonPrivate({
    asOf: new Date().toISOString(),
    subscriberCount: roster.length,
    roster,
    queries,
  });
}

// GET /admin/sends?key=…&days=14&day=YYYY-MM-DD&correctness=1
// Day-by-day digest sends with drill-down. Zero-send days are present in the range
// (absence visible). Optional correctness=1 runs a fresh recount for `day` (or today).
export async function handleAdminSends(req, env) {
  const auth = checkAdminKey(req, env);
  if (!auth.ok) return auth.res;
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
  if (!env.ALERT_STATE) return json({ error: "no-store" }, 503);

  const url = new URL(req.url);
  const days = clampInt(url.searchParams.get("days"), 14, 1, 90);
  const today = new Date().toISOString().slice(0, 10);
  const focusDay = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("day") || "")
    ? url.searchParams.get("day")
    : today;
  const wantCorrectness = url.searchParams.get("correctness") === "1"
    || url.searchParams.get("correctness") === "true";

  const range = dayRange(today, days);
  const daysOut = [];
  for (const day of range) {
    const [dayLog, receipt, sendcount] = await Promise.all([
      readJson(env.ALERT_STATE, digestDayLogKey(day)),
      readJson(env.ALERT_STATE, `digest:run:${day}`),
      readInt(env.ALERT_STATE, `sendcount:${day}`),
    ]);
    daysOut.push(summarizeDay({ day, dayLog, receipt, sendcount }));
  }

  let correctness = null;
  if (wantCorrectness) {
    const dayLog = await readJson(env.ALERT_STATE, digestDayLogKey(focusDay));
    correctness = await runCorrectness(env, focusDay, dayLog);
  }

  const focus = daysOut.find((d) => d.day === focusDay) || null;
  return jsonPrivate({
    asOf: new Date().toISOString(),
    today,
    focusDay,
    days: daysOut,
    focus,
    correctness,
  });
}

// GET /admin/ops?key=…&days=14 — combined roster + day-by-day sends + correctness for today.
// One round-trip for the internal dashboard page.
export async function handleAdminOps(req, env) {
  const auth = checkAdminKey(req, env);
  if (!auth.ok) return auth.res;
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);

  const url = new URL(req.url);
  const days = clampInt(url.searchParams.get("days"), 14, 1, 90);
  const today = new Date().toISOString().slice(0, 10);
  const focusDay = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("day") || "")
    ? url.searchParams.get("day")
    : today;

  const rosterBlock = env.SUBS
    ? await loadRosterAndQueries(env)
    : { roster: [], queries: [] };

  const daysOut = [];
  if (env.ALERT_STATE) {
    const range = dayRange(today, days);
    for (const day of range) {
      const [dayLog, receipt, sendcount] = await Promise.all([
        readJson(env.ALERT_STATE, digestDayLogKey(day)),
        readJson(env.ALERT_STATE, `digest:run:${day}`),
        readInt(env.ALERT_STATE, `sendcount:${day}`),
      ]);
      daysOut.push(summarizeDay({ day, dayLog, receipt, sendcount }));
    }
  }

  const focusLog = env.ALERT_STATE
    ? await readJson(env.ALERT_STATE, digestDayLogKey(focusDay))
    : null;
  const correctness = await runCorrectness(env, focusDay, focusLog);

  return jsonPrivate({
    asOf: new Date().toISOString(),
    today,
    focusDay,
    subscriberCount: rosterBlock.roster.length,
    roster: rosterBlock.roster,
    queries: rosterBlock.queries,
    days: daysOut,
    focus: daysOut.find((d) => d.day === focusDay) || null,
    correctness,
  });
}

// ---- internals ------------------------------------------------------------

async function loadRosterAndQueries(env) {
  const roster = [];
  let cursor;
  do {
    const res = await env.SUBS.list({ prefix: "sub:", cursor });
    for (const k of res.keys) {
      let v = null;
      try { v = JSON.parse(await env.SUBS.get(k.name)); } catch { /* skip */ }
      if (!v || !v.email) continue;
      let lastSent = null;
      if (env.ALERT_STATE) {
        try { lastSent = await env.ALERT_STATE.get(`lastsent:${k.name}`); } catch { /* ignore */ }
      }
      const row = toRosterRow(v, { lastSent, key: maskKey(k.name) });
      if (row) roster.push(row);
    }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);

  roster.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  const queries = searchInterestSignal(roster);
  return { roster, queries };
}

/**
 * Fresh recount of what each logged subscription should have matched.
 * Uses D1 when available + mirror-backed; falls back to "unchecked" per entry
 * when the query cannot be re-run (land/ZAP, missing DB, compile null).
 *
 * For the recount we re-run the subscription query and count ALL current matches
 * that are not in the still-stored seen: set — same definition of "fresh" the
 * digest uses. Divergence vs the day's logged noticeCount is the correctness signal.
 */
async function runCorrectness(env, day, dayLog) {
  if (!dayLog || !Array.isArray(dayLog.entries) || dayLog.entries.length === 0) {
    return correctnessCheck({ day, dayLog, recounts: {} });
  }

  const recounts = {};
  // Map masked sub ids back to full keys via SUBS list when possible.
  const keyByMask = env.SUBS ? await mapMaskedSubKeys(env) : new Map();

  for (const e of dayLog.entries) {
    if (!e || !e.id || e.kind === "config_watch") continue;
    if (e.action === "heartbeat" || e.action === "weekly-empty") continue;
    if (e.action && String(e.action).startsWith("skipped:")) continue;
    if (e.capped || e.error) continue;

    const fullKey = keyByMask.get(e.id) || null;
    const sub = fullKey && env.SUBS ? await loadSubRecord(env, fullKey) : null;
    if (!sub) continue;

    try {
      const rc = await recountOneSub(env, sub, day);
      if (rc) recounts[e.id] = rc;
    } catch {
      /* leave unchecked */
    }
  }

  return correctnessCheck({ day, dayLog, recounts });
}

async function recountOneSub(env, s, todayISO) {
  if (s.lens === "award") {
    // Award watches are one-shot; correctness is "did we notify on new candidates" —
    // skip automated recount (requires external award state).
    return null;
  }
  if (OFF_MIRROR_LENSES.has(s.lens)) return null;

  const q = compileSub(s, todayISO);
  if (!q) return null;

  let rows = [];
  let usedD1 = false;
  if (env.DB && !OFF_MIRROR_LENSES.has(s.lens)) {
    try {
      const d1 = compileSub_d1(s, todayISO);
      if (d1) {
        const { sql, params } = buildNoticesQuery(d1.opts);
        const res = await env.DB.prepare(sql).bind(...params).all();
        let mapped = (res.results ?? []).map(toDigestRow);
        if (d1.postFilter) mapped = mapped.filter(d1.postFilter);
        rows = mapped;
        usedD1 = true;
      }
    } catch {
      usedD1 = false;
    }
  }
  if (!usedD1) {
    // Live SODA recount is opt-in expensive; when DB is absent, mark unchecked.
    // Admin dashboard still shows the day log for human spot-check.
    if (!env.DB) return null;
    try {
      const r = await fetch(`${q.url}?${new URLSearchParams(q.params).toString()}`);
      if (!r.ok) return null;
      rows = await r.json();
      if (q.postFilter) rows = rows.filter(q.postFilter);
    } catch {
      return null;
    }
  }

  const seenIds = await loadSeenIds(env, s.key);
  // Day-scoped recount: prefer notices whose start_date falls on `todayISO`.
  // This matches the "what landed today" operator question better than the
  // unbounded fresh set (which depends on historical seen: state).
  const dayScoped = rows.filter((r) => {
    const sd = r.start_date || r.startDate || "";
    return String(sd).slice(0, 10) === todayISO;
  });
  // Compare against the day's logged "new" count using day-scoped rows (not seen:).
  // Seen-state is not durable across days in a recoverable form for historical
  // "what was new then" — day-scoped is the checkable definition of correctness.
  return recountFresh({ rows: dayScoped, idField: q.idField, seenIds: [] });
}

async function loadSeenIds(env, id) {
  if (!env?.ALERT_STATE) return [];
  try {
    const raw = await env.ALERT_STATE.get(`seen:${id}`);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function loadSubRecord(env, key) {
  try {
    const v = JSON.parse(await env.SUBS.get(key));
    return v && v.email ? { key, ...v } : null;
  } catch {
    return null;
  }
}

async function mapMaskedSubKeys(env) {
  const map = new Map();
  let cursor;
  try {
    do {
      const res = await env.SUBS.list({ prefix: "sub:", cursor });
      for (const k of res.keys) {
        map.set(maskKey(k.name), k.name);
      }
      cursor = res.list_complete ? null : res.cursor;
    } while (cursor);
  } catch { /* empty map */ }
  return map;
}

async function readJson(kv, key) {
  if (!kv) return null;
  try {
    const raw = await kv.get(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function readInt(kv, key) {
  if (!kv) return 0;
  try {
    return Number(await kv.get(key)) || 0;
  } catch {
    return 0;
  }
}

function clampInt(raw, fallback, min, max) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function maskKey(n) {
  return String(n).replace(/^(sub:|rl:addr:)([^@:]{0,2})[^@:]*/, "$1$2***");
}

function json(obj, status) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Admin payloads: never cache publicly; emails may be present. */
function jsonPrivate(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

// Re-export for tests / dashboard deep links.
export { noticeDeepLink, describeFilter };
