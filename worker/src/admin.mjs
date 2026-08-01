// GET /admin/subs?key=… — operator read of confirmed subscriptions, straight from the worker's
// OWN SUBS binding. This answers "what does the worker actually see" independent of any external
// CLI/dashboard view of the namespace. FAIL CLOSED: 404 until ADMIN_KEY is set. Read-only.
//
// GET /admin/digest-rollup?key=…&email=… — dry-run account rollup for one email (no Resend send).

import { redactEmail } from "./lib/subscriptions.mjs";
import {
  WATCHLOG_LATEST_KEY,
  enrichWatchLogEvents,
  maskKey as watchLogMaskKey,
  readWatchLog,
} from "./lib/watchlog.mjs";
import { dryRunRollupForEmail, digestSendTestForEmail, runCatchUpDigests } from "./alerts.mjs";
import { toReviewItems } from "../../entity_resolution/review/index.mjs";
import { readPossiblySamePairs } from "./lib/possibly_same.mjs";
import {
  FALSE_SPLIT_EVIDENCE_VERSION,
  appendFalseSplitDisposition,
  readFalseSplitDispositions,
} from "./lib/false_split_evidence.mjs";

// Store digests rather than publishing the desk's private recipient addresses in this repo.
const DIGEST_TEST_SEND_ALLOWLIST = new Set([
  "a17c00b69ea8339da4543a92b20605a87efbd45067ebb8bce88fbe3e29368e03",
  "ba4676e7d45accb8101c2cc1acdd8e5681319413608bd723e44b4081b19c9bec",
  "aa0b61da59b2ad5210a4f4e425534b7437e6a0b8d0a388d82d660b60be1693e2",
  "7878af20a7538ed0a03e11f6b0f67f9ad8cc29b7116da0b10d7a7fc078d503fe",
]);

async function isAllowedDigestTestRecipient(email) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email.trim().toLowerCase()));
  const digest = [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return DIGEST_TEST_SEND_ALLOWLIST.has(digest);
}

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

// The digest test-send probe also accepts the analytics developer-exclusion credential. It is
// an operator probe key, not a Cloudflare-issued administrator credential.
export function checkOperatorProbeKey(req, env) {
  if (!env.ADMIN_KEY && !env.ANALYTICS_DEV_KEY) return { ok: false, res: json({ error: "not found" }, 404) };
  const url = new URL(req.url);
  const key = url.searchParams.get("key") || (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (key !== env.ADMIN_KEY && key !== env.ANALYTICS_DEV_KEY) return { ok: false, res: json({ error: "unauthorized" }, 401) };
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
        if (v) subs.push({ email: redactEmail(v.email), lens: v.lens, filter: v.filter, freq: v.freq, paused: !!v.paused, createdAt: v.createdAt });
      }
    }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);

  return json({ confirmedSubs: subs.length, totalKeysInStore: totalKeys, subs, sampleKeys }, 200);
}

// GET /admin/watch-log?key=…&days=7 — operator read of watch lifecycle changes.
export async function handleAdminWatchLog(req, env) {
  const auth = checkAdminKey(req, env);
  if (!auth.ok) return auth.res;
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
  const days = new URL(req.url).searchParams.get("days") || "7";
  const events = await readWatchLog(env, days);
  return json({ days: Math.max(1, Math.min(31, Number(days) || 7)), events }, 200);
}

// POST /admin/watch-log/enrich?key=… — retrofit thin stored lifecycle events from live SUBS.
// JSON: { days?: 1..31, date?: "YYYY-MM-DD", overrides?: [{ at?, subKeyMasked?, action?, label, freq?, detail? }] }
// `date` selects the newest UTC day and is intended for bounded historical repairs.
export async function handleAdminWatchLogEnrich(req, env) {
  const auth = checkAdminKey(req, env);
  if (!auth.ok) return auth.res;
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!env.ALERT_STATE || !env.SUBS) return json({ error: "no-store" }, 503);

  let body = {};
  try {
    const raw = await req.text();
    if (raw) body = JSON.parse(raw);
  } catch {
    return json({ error: "invalid-json" }, 400);
  }
  const days = Math.max(1, Math.min(31, Number(body.days) || 7));
  const hasDate = body.date != null;
  const endDate = hasDate && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
    ? new Date(`${body.date}T00:00:00.000Z`)
    : new Date();
  if (hasDate && (!/^\d{4}-\d{2}-\d{2}$/.test(body.date)
      || Number.isNaN(endDate.valueOf()) || endDate.toISOString().slice(0, 10) !== body.date)) {
    return json({ error: "invalid-date" }, 400);
  }
  const overrides = Array.isArray(body.overrides) ? body.overrides : [];
  const liveSubsByMask = await liveWatchRecordsByMask(env.SUBS);
  const keys = [WATCHLOG_LATEST_KEY];
  const cursor = new Date(endDate);
  cursor.setUTCHours(0, 0, 0, 0);
  for (let i = 0; i < days; i++) {
    keys.push(`watchlog:${cursor.toISOString().slice(0, 10)}`);
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }

  let scanned = 0;
  let enriched = 0;
  let unchanged = 0;
  for (const key of keys) {
    let raw;
    try { raw = await env.ALERT_STATE.get(key); } catch { continue; }
    if (!raw) continue;
    let events;
    try { events = JSON.parse(raw); } catch { continue; }
    if (!Array.isArray(events)) continue;
    const result = enrichWatchLogEvents(events, liveSubsByMask, overrides);
    if (result.enriched) {
      try {
        await env.ALERT_STATE.put(key, JSON.stringify(result.events));
      } catch {
        return json({ error: "write-failed", scanned, enriched, unchanged }, 503);
      }
    }
    scanned += events.length;
    enriched += result.enriched;
    unchanged += result.unchanged;
  }
  return json({ scanned, enriched, unchanged }, 200);
}

async function liveWatchRecordsByMask(store) {
  const records = new Map();
  let cursor;
  try {
    do {
      const page = await store.list({ prefix: "sub:", cursor });
      for (const key of page.keys) {
        const masked = watchLogMaskKey(key.name);
        if (!masked) continue;
        let record;
        try { record = JSON.parse(await store.get(key.name)); } catch { continue; }
        // The mask deliberately hides most of the key. Do not guess when two live keys collide.
        if (records.has(masked)) records.set(masked, null);
        else if (record) records.set(masked, record);
      }
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
  } catch { /* return the records collected so far */ }
  return records;
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

// GET/POST /admin/possibly-same?key=… — desk evidence for candidate vendor pairs.
// POST appends a disposition audit event; it never mutates source records or entity links.
export async function handleAdminPossiblySame(req, env) {
  const auth = checkAdminKey(req, env);
  if (!auth.ok) return auth.res;
  if (!new Set(["GET", "POST"]).has(req.method)) return json({ error: "method not allowed" }, 405);
  if (!env.DB) return json({ error: "no-store" }, 503);

  let pairs = [];
  try {
    pairs = await readPossiblySamePairs(env.DB);
  } catch {
    return json({ error: "review-data-unavailable" }, 503);
  }
  if (req.method === "POST") {
    let body;
    try {
      body = (req.headers.get("content-type") || "").includes("application/json")
        ? await req.json()
        : Object.fromEntries(await req.formData());
    } catch {
      return json({ error: "invalid-body" }, 400);
    }
    const pair = pairs.find((candidate) => candidate.id === String(body?.pair_id || ""));
    let event;
    try {
      event = await appendFalseSplitDisposition(env.DB, pair, body);
    } catch {
      return json({ error: "disposition-write-failed" }, 503);
    }
    if (event.error) return json({ error: event.error }, event.error === "pair-not-found" ? 404 : 400);
    if ((req.headers.get("accept") || "").includes("application/json")) {
      return json({ event }, 201);
    }
    const target = new URL(req.url);
    target.searchParams.set("saved", event.id);
    return new Response(null, { status: 303, headers: { Location: target.toString(), "Cache-Control": "no-store" } });
  }

  const items = toReviewItems(pairs);
  let events;
  try {
    events = await readFalseSplitDispositions(env.DB, items.map((item) => item.id));
  } catch {
    return json({ error: "review-data-unavailable" }, 503);
  }
  const eventsByPair = Object.groupBy(events, (event) => event.pair_id);
  if ((req.headers.get("accept") || "").includes("application/json")) {
    return json({
      reviewVersion: FALSE_SPLIT_EVIDENCE_VERSION,
      source: "live_dual_write",
      count: items.length,
      measured: { candidates: items.length, disposition_events: events.length },
      items: items.map((item) => ({ ...item, dispositions: eventsByPair[item.id] || [] })),
    }, 200);
  }
  return new Response(renderPossiblySamePage(items, eventsByPair), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>\"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  }[char]));
}

function confidenceLabel(value) {
  return value == null ? "Score unavailable" : `${Math.round(value * 100)}% candidate score`;
}

function candidateBasis(evidence = {}) {
  const keys = Array.isArray(evidence.shared_keys) ? evidence.shared_keys : [];
  if (!keys.length) return "Blocking overlap";
  return keys.map((key) => {
    if (key.startsWith("stem:")) return `same normalized stem: ${key.slice(5)}`;
    if (key.startsWith("tok:")) return `shared token: ${key.slice(4)}`;
    return `shared key: ${key}`;
  }).join(" · ");
}

function observedFieldsHtml(side) {
  const rows = Object.entries(side.observed_fields || {}).map(([field, value]) =>
    `<tr><th scope="row">${escapeHtml(field)}</th><td>${escapeHtml(value)}</td></tr>`).join("");
  return rows || '<tr><td colspan="2">No normalized fields recorded.</td></tr>';
}

function sourceRecordHtml(side, label) {
  const source = side.source_url
    ? `<a href="${escapeHtml(side.source_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(side.source || "Open source")}</a>`
    : escapeHtml(side.source || "Source unavailable");
  return `<section class="record"><h3>${escapeHtml(label)} · ${escapeHtml(side.name)}</h3>
    <dl><div><dt>Source</dt><dd>${source}</dd></div>
      <div><dt>Source-record key</dt><dd>${escapeHtml(side.source_record_key || "Not supplied")}</dd></div>
      <div><dt>Snapshot ID</dt><dd>${escapeHtml(side.id || "Not supplied")}</dd></div>
      <div><dt>Observed</dt><dd>${escapeHtml(side.observed_at || "Not supplied")}</dd></div></dl>
    <table><caption>Observed fields</caption><tbody>${observedFieldsHtml(side)}</tbody></table></section>`;
}

function comparisonFeaturesHtml(evidence = {}) {
  const features = evidence.comparison_features || {};
  const rows = Object.entries(features).map(([field, value]) =>
    `<tr><th scope="row">${escapeHtml(field)}</th><td>${escapeHtml(Array.isArray(value) ? value.join(", ") || "—" : value)}</td></tr>`).join("");
  return `<details><summary>Comparison features</summary><table><tbody>${rows || '<tr><td>No comparison features recorded.</td></tr>'}</tbody></table></details>`;
}

function dispositionHistoryHtml(events = []) {
  if (!events.length) return '<p class="empty-history">No dispositions recorded.</p>';
  return `<ol class="history">${events.map((event) => `<li><strong>${escapeHtml(event.decision)}</strong> by ${escapeHtml(event.actor)}
    <time datetime="${escapeHtml(event.created_at)}">${escapeHtml(event.created_at)}</time>
    ${event.note ? `<p>${escapeHtml(event.note)}</p>` : ""}
    <small>${escapeHtml(event.evidence_version)} · event ${escapeHtml(event.id)}</small></li>`).join("")}</ol>`;
}

export function renderPossiblySamePage(items = [], eventsByPair = {}) {
  const cards = items.map((item) => `<article class="pair" data-pair-id="${escapeHtml(item.id)}">
    <p class="eyebrow">${escapeHtml(item.label)}</p>
    <h2>${escapeHtml(item.left.name)} <span aria-hidden="true">↔</span> ${escapeHtml(item.right.name)}</h2>
    <p class="score">${escapeHtml(confidenceLabel(item.confidence))} · ${escapeHtml(item.method)}</p>
    <p><strong>Candidate basis:</strong> ${escapeHtml(candidateBasis(item.evidence))}</p>
    <div class="records">${sourceRecordHtml(item.left, "Record A")}${sourceRecordHtml(item.right, "Record B")}</div>
    ${comparisonFeaturesHtml(item.evidence)}
    <p class="note">This is a review lead, not a finding. Confirm identity from the underlying records before taking action.</p>
    <section><h3>Disposition history</h3>${dispositionHistoryHtml(eventsByPair[item.id] || [])}</section>
    <form method="post"><input type="hidden" name="pair_id" value="${escapeHtml(item.id)}">
      <label>Operator <input name="actor" required maxlength="120" autocomplete="username"></label>
      <label>Evidence note <textarea name="note" maxlength="2000" aria-label="Evidence note for ${escapeHtml(item.id)}"></textarea></label>
      <fieldset><legend>Append disposition</legend>
        <button name="decision" value="same">Same</button>
        <button name="decision" value="different">Different</button>
        <button name="decision" value="defer">Defer</button></fieldset>
      <small>Saving appends a ${FALSE_SPLIT_EVIDENCE_VERSION} audit event. It does not change entity links.</small>
    </form>
  </article>`).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Possibly same vendors</title>
    <style>body{font:16px system-ui,sans-serif;max-width:1120px;margin:40px auto;padding:0 20px;color:#17202a;background:#f6f3ed}.pair{background:white;border:1px solid #d8d2c8;border-radius:12px;padding:22px;margin:18px 0;box-shadow:0 2px 8px #0000000d}.eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#795548;font-weight:700}.pair h2{font-size:22px;margin:8px 0}.score{color:#40566a;font-family:ui-monospace,monospace}.records{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px}.record{min-width:0;background:#f5f7f8;padding:14px;border-radius:8px}.pair dl{display:grid;grid-template-columns:1fr 1fr;gap:8px}.pair dl div{min-width:0}.pair dt{font-size:12px;color:#687783}.pair dd{margin:4px 0 0;overflow-wrap:anywhere}.pair table{width:100%;border-collapse:collapse;font-size:13px}.pair th,.pair td{text-align:left;vertical-align:top;border-top:1px solid #d8dfe3;padding:6px;overflow-wrap:anywhere}.pair th{width:35%}.note{border-left:3px solid #d39b36;padding-left:10px}.pair input,.pair textarea{display:block;width:100%;padding:8px;margin:6px 0 12px;box-sizing:border-box}.pair textarea{min-height:70px}.pair fieldset{border:0;padding:0;margin:8px 0}.pair button{padding:8px 14px;margin:4px 6px 4px 0}.history time,.history small{display:block;color:#687783}.empty,.empty-history{padding:18px;background:#fff;border-radius:12px}@media(max-width:720px){.records,.pair dl{grid-template-columns:1fr}}</style></head><body>
    <header><p class="eyebrow">Authenticated desk review</p><h1>Possibly same vendors</h1><p>These candidate pairs are surfaced for human review. Dispositions are an append-only evidence trail; records are not combined or exposed in the public site.</p></header>
    ${cards || '<p class="empty">No candidate pairs are currently surfaced from recent dual-write observations.</p>'}
  </body></html>`;
}

/**
 * GET /admin/digest-rollup?key=…&email=…
 * Dry-run the account digest (rollup when >1 active watch) without sending mail.
 * Forces ALERTS_LIVE-off evaluation; returns sections + day-log preview.
 */
export async function handleAdminDigestRollup(req, env) {
  const auth = checkAdminKey(req, env);
  if (!auth.ok) return auth.res;
  if (req.method !== "GET") return json({ error: "method" }, 405);
  const email = new URL(req.url).searchParams.get("email") || "";
  if (!email) return json({ error: "email-required" }, 400);
  try {
    const out = await dryRunRollupForEmail(env, email);
    return json(out, 200);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
}

/**
 * POST /admin/digest-send-test?key=…
 * Evaluate, or send once through, the normal digest path for one email.
 * State advancement is opt-in; test sends do not consume watermarks by default.
 */
export async function handleAdminDigestSendTest(req, env) {
  const auth = checkOperatorProbeKey(req, env);
  if (!auth.ok) return auth.res;
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body = {};
  try {
    const raw = await req.text();
    if (raw) body = JSON.parse(raw);
  } catch {
    return json({ error: "invalid-json" }, 400);
  }
  const email = typeof body.email === "string" ? body.email : "";
  if (!email) return json({ error: "email-required" }, 400);
  if (!await isAllowedDigestTestRecipient(email)) return json({ error: "recipient-not-allowed" }, 403);
  if (body.live !== undefined && typeof body.live !== "boolean") return json({ error: "live-must-be-boolean" }, 400);
  if (body.advanceState !== undefined && typeof body.advanceState !== "boolean") return json({ error: "advanceState-must-be-boolean" }, 400);
  try {
    const out = await digestSendTestForEmail(env, email, {
      live: body.live === true,
      advanceState: body.advanceState === true,
    });
    return json(out, 200);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
}

function maskKey(n) {
  return n.replace(/^(sub:|rl:addr:)([^@:]{0,2})[^@:]*/, "$1$2***");
}
function json(obj, status) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// POST /admin/digest-catchup?key=… — operator-triggered watermark recovery. Selects subs
// whose lastsent lags by >= minLagDays (default 2) and sends one catch-up digest each.
// Optional body: { minLagDays?: number, subKeys?: string[] }. FAIL CLOSED until ADMIN_KEY set.
export async function handleAdminDigestCatchUp(req, env) {
  const auth = checkAdminKey(req, env);
  if (!auth.ok) return auth.res;
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let opts = {};
  try {
    const body = await req.text();
    if (body) opts = JSON.parse(body);
  } catch { /* empty body is fine */ }

  const minLagDays = Number(opts.minLagDays) || 2;
  const subKeys = Array.isArray(opts.subKeys) ? opts.subKeys.filter((k) => typeof k === "string") : null;

  const result = await runCatchUpDigests(env, { minLagDays, subKeys });
  return json({
    mode: "catch_up",
    live: result.live,
    candidates: result.candidates,
    sentThisRun: result.sentThisRun,
    sentToday: result.sentToday,
    results: result.results.map((r) => ({
      sub: r.sub, lens: r.lens, action: r.action,
      new: r.new || 0, found: r.found || 0, sent: !!r.sent,
      capped: !!r.capped, error: r.error || null, zeroMatch: !!r.zeroMatch,
    })),
  }, 200);
}
