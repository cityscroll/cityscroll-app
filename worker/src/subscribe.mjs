// POST /subscribe — the public signup endpoint. Model-free: the browser submits the
// already-compiled lens filter (re-sanitized here, never trusted), and we email a signed,
// expiring CONFIRM link. Nothing is stored until the user clicks it (stateless pending) — so
// double opt-in means a stranger can, at most, make us send ONE confirmation to an address
// that then ignores it.
//
// FAIL CLOSED: returns 503 until TURNSTILE_SECRET + TOKEN_SECRET + RESEND_API_KEY + SUBS are
// all configured (mirrors /usage 404ing without USAGE_KEY). So deploying it is safe before
// Turnstile is provisioned. Defenses: Turnstile (bots), per-IP + per-address daily rate limits
// (KV), strict validation (one address, known lenses only), and the existing send caps.

import { sanitize, LENSES } from "./lib/filter.mjs";
import { isValidEmail, buildSubscription } from "./lib/subscriptions.mjs";
import { signToken } from "optin-token";
import { confirmSubject, confirmEmailHtml } from "./lib/confirm_email.mjs";

const ALLOW = new Set([
  "https://crol-list.org", "https://www.crol-list.org",
  "https://crol-list.jimdc.com", "https://jimdc.github.io",
  "http://localhost:8000", "http://localhost:8787",
]);
// Subscribable lenses = the content tabs + entity follows. "alerts" is the delivery wrapper.
const SUBSCRIBABLE = new Set(["money", "people", "land", "property", "rules", "meetings", "entity"]);
const CONFIRM_TTL = 24 * 3600;       // confirm link lifetime (s)
const MAX_SUB_PER_IP_DAY = 20;
const MAX_SUB_PER_ADDR_DAY = 5;

export async function handleSubscribe(req, env) {
  const cors = corsHeaders(req.headers.get("origin") || "");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ ok: false, reason: "method" }, 405, cors);

  if (!env.TURNSTILE_SECRET || !env.TOKEN_SECRET || !env.RESEND_API_KEY || !env.SUBS) {
    return json({ ok: false, reason: "not-configured" }, 503, cors);
  }

  let body;
  try { body = await req.json(); } catch { return json({ ok: false, reason: "bad-json" }, 400, cors); }

  const email = String(body.email || "");
  const lens = SUBSCRIBABLE.has(body.lens) ? body.lens : null;
  if (!isValidEmail(email)) return json({ ok: false, reason: "bad-email" }, 400, cors);
  if (!lens) return json({ ok: false, reason: "bad-lens" }, 400, cors);
  if ((body.channel || "email") !== "email") return json({ ok: false, reason: "channel-unsupported" }, 400, cors); // SMS later

  const ip = req.headers.get("CF-Connecting-IP") || "";
  // Cheap KV rate-limit BEFORE spending a Turnstile verify or an email send.
  if (await overLimit(env, ip, email)) return json({ ok: false, reason: "rate-limited" }, 429, cors);
  if (!(await verifyTurnstile(env, body.turnstileToken, ip))) return json({ ok: false, reason: "turnstile" }, 403, cors);

  const filter = sanitize(lens, body.filter);
  const sub = buildSubscription({ email, lens, filter, channel: "email", freq: body.freq });
  const token = await signToken(
    env.TOKEN_SECRET,
    { e: sub.email, l: lens, f: filter, c: "email", q: sub.freq },
    { ttlSeconds: CONFIRM_TTL }
  );
  const base = env.CONFIRM_BASE || new URL(req.url).origin;
  const confirmUrl = `${base}/confirm?token=${encodeURIComponent(token)}`;

  try {
    await sendConfirm(env, sub.email, lens, filter, sub.freq, confirmUrl);
  } catch {
    return json({ ok: false, reason: "send-failed" }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

// Exported: /mcp create_watch and the inbound-email handler reuse the same
// double-opt-in confirmation email (one sender identity, one template).
export async function sendConfirm(env, to, lens, filter, freq, confirmUrl) {
  const from = env.ALERTS_FROM || "CROL-List <alerts@crol-list.org>";
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.RESEND_API_KEY}` },
    body: JSON.stringify({ from, to, subject: confirmSubject(), html: confirmEmailHtml({ confirmUrl, lens, filter, freq }) }),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
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
  const ipOver = ip ? await bump(env, `rl:ip:${ip}:${day}`, MAX_SUB_PER_IP_DAY) : false;
  const addrOver = await bump(env, `rl:addr:${email.toLowerCase()}:${day}`, MAX_SUB_PER_ADDR_DAY);
  return ipOver || addrOver;
}
async function bump(env, key, max) {
  const n = (Number(await env.SUBS.get(key)) || 0) + 1;
  await env.SUBS.put(key, String(n), { expirationTtl: 172800 });
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
