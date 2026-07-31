// GET /admin/subs?key=… — operator read of confirmed subscriptions, straight from the worker's
// OWN SUBS binding. This answers "what does the worker actually see" independent of any external
// CLI/dashboard view of the namespace. FAIL CLOSED: 404 until ADMIN_KEY is set. Read-only.
//
// GET /admin/digest-rollup?key=…&email=… — dry-run account rollup for one email (no Resend send).

import { redactEmail } from "./lib/subscriptions.mjs";
import { dryRunRollupForEmail, digestSendTestForEmail, runCatchUpDigests } from "./alerts.mjs";
import { toReviewItems } from "../../entity_resolution/review/index.mjs";

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

// GET /admin/possibly-same?key=… — read-only desk view of candidate vendor pairs.
// Pair data is supplied by the operator through ER_REVIEW_PAIRS (JSON), which keeps this
// surface useful for fixtures and dry runs without introducing a writable ER API or a new table.
export async function handleAdminPossiblySame(req, env) {
  const auth = checkAdminKey(req, env);
  if (!auth.ok) return auth.res;
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);

  let pairs = [];
  try {
    const raw = env.ER_REVIEW_PAIRS || env.ENTITY_REVIEW_FIXTURE || "[]";
    pairs = JSON.parse(raw);
  } catch {
    return json({ error: "invalid-review-pairs" }, 500);
  }
  const items = toReviewItems(pairs);
  if ((req.headers.get("accept") || "").includes("application/json")) {
    return json({ reviewVersion: "possibly_same_v1", count: items.length, items }, 200);
  }
  return new Response(renderPossiblySamePage(items), {
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

export function renderPossiblySamePage(items = []) {
  const cards = items.map((item) => `<article class="pair" data-pair-id="${escapeHtml(item.id)}">
    <p class="eyebrow">${escapeHtml(item.label)}</p>
    <h2>${escapeHtml(item.left.name)} <span aria-hidden="true">↔</span> ${escapeHtml(item.right.name)}</h2>
    <p class="score">${escapeHtml(confidenceLabel(item.confidence))} · ${escapeHtml(item.method)}</p>
    <dl><div><dt>Source record</dt><dd>${escapeHtml(item.left.id || "Not supplied")}</dd></div>
      <div><dt>Candidate record</dt><dd>${escapeHtml(item.right.id || "Not supplied")}</dd></div></dl>
    <p class="note">This is a review lead, not a finding. Confirm identity from the underlying records before taking action.</p>
    <label>Review note <textarea readonly aria-label="Review note for ${escapeHtml(item.id)}" placeholder="Notes are not saved by this read-only view."></textarea></label>
  </article>`).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Possibly same vendors</title>
    <style>body{font:16px system-ui,sans-serif;max-width:960px;margin:40px auto;padding:0 20px;color:#17202a;background:#f6f3ed}.pair{background:white;border:1px solid #d8d2c8;border-radius:12px;padding:22px;margin:18px 0;box-shadow:0 2px 8px #0000000d}.eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#795548;font-weight:700}.pair h2{font-size:22px;margin:8px 0}.score{color:#40566a;font-family:ui-monospace,monospace}.pair dl{display:grid;grid-template-columns:1fr 1fr;gap:12px}.pair dl div{background:#f5f7f8;padding:10px;border-radius:6px}.pair dt{font-size:12px;color:#687783}.pair dd{margin:4px 0 0;overflow-wrap:anywhere}.note{border-left:3px solid #d39b36;padding-left:10px}.pair textarea{display:block;width:100%;min-height:60px;margin-top:6px;box-sizing:border-box}.empty{padding:24px;background:#fff;border-radius:12px}</style></head><body>
    <header><p class="eyebrow">Desk review · read-only</p><h1>Possibly same vendors</h1><p>These candidate pairs are surfaced for human review. They are not combined, asserted, or exposed in the public site.</p></header>
    ${cards || '<p class="empty">No candidate pairs are queued.</p>'}
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
