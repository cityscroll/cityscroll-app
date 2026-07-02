// POST /feedback — public feedback intake (bug / feature idea / general). Mirrors /subscribe's
// posture exactly: Turnstile-gated, per-IP + per-address daily rate limits (KV), strict field
// validation, and FAIL CLOSED (503) until TURNSTILE_SECRET + RESEND_API_KEY + FEEDBACK are set —
// so deploying it is safe before Turnstile is provisioned (like /usage 404ing without USAGE_KEY).
//
// On a valid submission it does BOTH:
//   (1) STORE an archive row in the FEEDBACK KV namespace
//         fb:<ts>:<rand> → { category, message, email, ip, ua, at }
//       so there's a reviewable record (read it back via /admin/feedback), and
//   (2) NOTIFY the operator by email via Resend — To FEEDBACK_TO (default feedback@crol-list.org),
//       From alerts@crol-list.org, Reply-To the submitter IF they left an address so the operator
//       can just hit Reply.
// It deliberately does NOT auto-file GitHub issues (a public form that opens issues is a spam
// vector); the operator triages the archive and files real issues by hand.

import { validateFeedback } from "./lib/feedback.mjs";

const ALLOW = new Set([
  "https://crol-list.org", "https://www.crol-list.org",
  "https://crol-list.jimdc.com", "https://jimdc.github.io",
  "http://localhost:8000", "http://localhost:8787",
]);
const MAX_FB_PER_IP_DAY = 10;
const MAX_FB_PER_ADDR_DAY = 5;
const DEFAULT_TO = "feedback@crol-list.org"; // routed by the crol-list.org catch-all; no personal inbox in source

export async function handleFeedback(req, env) {
  const cors = corsHeaders(req.headers.get("origin") || "");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ ok: false, reason: "method" }, 405, cors);

  if (!env.TURNSTILE_SECRET || !env.RESEND_API_KEY || !env.FEEDBACK) {
    return json({ ok: false, reason: "not-configured" }, 503, cors);
  }

  let body;
  try { body = await req.json(); } catch { return json({ ok: false, reason: "bad-json" }, 400, cors); }

  const v = validateFeedback(body);
  if (!v.ok) return json({ ok: false, reason: v.reason }, 400, cors);
  const { category, message, email } = v.value;

  const ip = req.headers.get("CF-Connecting-IP") || "";
  // Cheap KV rate-limit BEFORE spending a Turnstile verify, a store, or an email send.
  if (await overLimit(env, ip, email)) return json({ ok: false, reason: "rate-limited" }, 429, cors);
  if (!(await verifyTurnstile(env, body.turnstileToken, ip))) return json({ ok: false, reason: "turnstile" }, 403, cors);

  const record = {
    category, message, email,
    ip,
    ua: (req.headers.get("User-Agent") || "").slice(0, 300),
    at: new Date().toISOString(),
  };

  // STORE first (the durable archive), THEN notify. Either failing → send-failed so the browser
  // can prompt a retry; a stored-but-unsent row is still recoverable via /admin/feedback.
  try {
    await env.FEEDBACK.put(`fb:${Date.now()}:${rand()}`, JSON.stringify(record));
  } catch {
    return json({ ok: false, reason: "send-failed" }, 502, cors);
  }
  try {
    await notifyOperator(env, record);
  } catch {
    return json({ ok: false, reason: "send-failed" }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

function rand() {
  return [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function notifyOperator(env, r) {
  const from = env.ALERTS_FROM || "CROL-List <alerts@crol-list.org>";
  const to = env.FEEDBACK_TO || DEFAULT_TO;
  const label = { bug: "Bug", feature: "Feature idea", general: "General" }[r.category] || r.category;
  const payload = {
    from, to,
    subject: `[CROL-List] ${label}: ${firstLine(r.message)}`,
    html: notifyHtml(r, label),
    text: notifyText(r, label),
  };
  if (r.email) payload.reply_to = r.email; // Resend REST: reply-to so the operator can just Reply
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.RESEND_API_KEY}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

function firstLine(s) {
  const one = String(s).replace(/\s+/g, " ").trim();
  return one.length > 80 ? one.slice(0, 77) + "…" : one;
}
function notifyText(r, label) {
  return [
    "New CROL-List feedback",
    "",
    `Category: ${label}`,
    `From:     ${r.email || "(no email given)"}`,
    `When:     ${r.at}`,
    `IP:       ${r.ip || "(unknown)"}`,
    `UA:       ${r.ua || "(unknown)"}`,
    "",
    r.message,
  ].join("\n");
}
function notifyHtml(r, label) {
  const rows = [
    ["Category", label],
    ["From", r.email || "(no email given)"],
    ["When", r.at],
    ["IP", r.ip || "(unknown)"],
    ["UA", r.ua || "(unknown)"],
  ].map(([k, val]) => `<tr><td style="padding:2px 12px 2px 0;color:#5c5349;vertical-align:top">${k}</td><td>${escHtml(val)}</td></tr>`).join("");
  return `<div style="font:15px/1.6 Georgia,serif;color:#1a1714;max-width:640px">
    <h2 style="font:700 16px/1.3 ui-sans-serif,system-ui,sans-serif;margin:0 0 8px">New CROL-List feedback</h2>
    <table style="font:13px/1.6 ui-sans-serif,system-ui,sans-serif;border-collapse:collapse;margin:0 0 14px">${rows}</table>
    <div style="white-space:pre-wrap;border-left:3px solid #cdbfa6;padding-left:12px">${escHtml(r.message)}</div>
    ${r.email ? `<p style="font:13px/1.5 ui-sans-serif,system-ui,sans-serif;color:#5c5349">Reply directly to this email to respond to the sender.</p>` : ""}
  </div>`;
}
function escHtml(s) {
  return String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
}

async function verifyTurnstile(env, token, ip) {
  if (!token) return false;
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: String(token), remoteip: ip }),
    });
    const j = await r.json();
    return !!(j && j.success);
  } catch {
    return false;
  }
}

async function overLimit(env, ip, email) {
  const day = new Date().toISOString().slice(0, 10);
  const ipOver = ip ? await bump(env, `rl:ip:${ip}:${day}`, MAX_FB_PER_IP_DAY) : false;
  const addrOver = email ? await bump(env, `rl:addr:${email}:${day}`, MAX_FB_PER_ADDR_DAY) : false;
  return ipOver || addrOver;
}
async function bump(env, key, max) {
  const n = (Number(await env.FEEDBACK.get(key)) || 0) + 1;
  await env.FEEDBACK.put(key, String(n), { expirationTtl: 172800 });
  return n > max;
}

function corsHeaders(origin) {
  const o = ALLOW.has(origin) ? origin : "https://crol-list.org";
  return {
    "Access-Control-Allow-Origin": o,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
