// POST /subscribe — the public signup endpoint. Model-free: the browser submits the
// already-compiled lens filter (re-sanitized here, never trusted), and we email a signed,
// expiring CONFIRM link. Nothing is stored until the user clicks it (stateless pending) — so
// double opt-in means a stranger can, at most, make us send ONE confirmation to an address
// that then ignores it.
//
// FAIL CLOSED: returns 503 until TOKEN_SECRET + RESEND_API_KEY + SUBS are configured
// (mirrors /usage 404ing without USAGE_KEY). Bot friction is rate limits + double opt-in;
// Cloudflare Turnstile was removed from this path for UX (feedback still uses it). Re-add
// behind an explicit env flag if the sends dashboard shows abuse.

import { sanitize } from "./lib/filter.mjs";
import { isValidEmail, buildSubscription } from "./lib/subscriptions.mjs";
import { signToken } from "optin-token";
import { confirmSubject, confirmEmailHtml, htmlPage } from "./lib/confirm_email.mjs";
import { corsHeaders, isAllowedRequestOrigin } from "./lib/cors.mjs";
import { overActorLimit } from "./lib/meter.mjs";

// Subscribable lenses = the content tabs + entity follows. "alerts" is the delivery wrapper.
// "award" is the one-notice award-arrival watch (see lib/filter.mjs's LENSES.award comment).
const SUBSCRIBABLE = new Set(["money", "people", "land", "property", "rules", "meetings", "district", "entity", "award"]);
const CONFIRM_TTL = 24 * 3600;       // confirm link lifetime (s)
const MAX_SUB_PER_IP_DAY = 20;
const MAX_SUB_PER_ADDR_DAY = 5;

export async function handleSubscribe(req, env) {
  const origin = req.headers.get("origin") || "";
  const cors = corsHeaders(origin, env);
  if (!isAllowedRequestOrigin(origin, env)) {
    return reply(req, { ok: false, reason: "origin" }, 403, cors);
  }
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return reply(req, { ok: false, reason: "method" }, 405, cors);

  if (!env.TOKEN_SECRET || !env.RESEND_API_KEY || !env.SUBS) {
    return reply(req, { ok: false, reason: "not-configured" }, 503, cors);
  }

  let body = {};
  const contentType = req.headers.get("content-type") || "";
  try {
    if (contentType.includes("application/json")) body = await req.json();
    else body = Object.fromEntries(new URLSearchParams(await req.text()).entries());
    if (typeof body.filter === "string") body.filter = JSON.parse(body.filter || "{}");
  } catch { return reply(req, { ok: false, reason: "bad-request" }, 400, cors); }

  const email = String(body.email || "");
  const lens = SUBSCRIBABLE.has(body.lens) ? body.lens : null;
  if (!isValidEmail(email)) return reply(req, { ok: false, reason: "bad-email" }, 400, cors);
  if (!lens) return reply(req, { ok: false, reason: "bad-lens" }, 400, cors);
  if ((body.channel || "email") !== "email") return reply(req, { ok: false, reason: "channel-unsupported" }, 400, cors); // SMS later

  const ip = req.headers.get("CF-Connecting-IP") || "";
  // Cheap KV rate-limit BEFORE spending an email send.
  if (await overLimit(env, ip, email)) return reply(req, { ok: false, reason: "rate-limited" }, 429, cors);

  const lang = typeof body.lang === "string" ? body.lang : "en";
  const filter = sanitize(lens, body.filter);
  const sub = buildSubscription({ email, lens, filter, channel: "email", freq: body.freq, lang });
  const token = await signToken(
    env.TOKEN_SECRET,
    { e: sub.email, l: lens, f: filter, c: "email", q: sub.freq, lng: sub.lang },
    { ttlSeconds: CONFIRM_TTL }
  );
  const base = env.CONFIRM_BASE || new URL(req.url).origin;
  const confirmUrl = `${base}/confirm?token=${encodeURIComponent(token)}`;

  try {
    await sendConfirm(env, sub.email, lens, filter, sub.freq, confirmUrl, sub.lang);
  } catch {
    return reply(req, { ok: false, reason: "send-failed" }, 502, cors);
  }
  return reply(req, { ok: true }, 200, cors);
}

// Exported: /mcp create_watch and the inbound-email handler reuse the same
// double-opt-in confirmation email (one sender identity, one template).
export async function sendConfirm(env, to, lens, filter, freq, confirmUrl, lang = "en") {
  const from = env.ALERTS_FROM || "CityScroll <alerts@crol-list.org>";
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.RESEND_API_KEY}` },
    body: JSON.stringify({ from, to, subject: confirmSubject(lang), html: confirmEmailHtml({ confirmUrl, lens, filter, freq, lang }) }),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
}

async function overLimit(env, ip, email) {
  const ipOver = ip ? await overActorLimit(env.SUBS, "ip", ip, MAX_SUB_PER_IP_DAY) : false;
  const addrOver = await overActorLimit(env.SUBS, "addr", email, MAX_SUB_PER_ADDR_DAY);
  return ipOver || addrOver;
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

function reply(req, obj, status, cors) {
  const accepts = req.headers.get("accept") || "";
  const contentType = req.headers.get("content-type") || "";
  const wantsHtml = accepts.includes("text/html") || contentType.includes("application/x-www-form-urlencoded");
  if (!wantsHtml) return json(obj, status, cors);
  const copy = {
    origin: ["Request not accepted", "Open the form from cityscroll.org and try again."],
    method: ["Request not accepted", "Use the Following form to create a watch."],
    "not-configured": ["Temporarily unavailable", "Watch signup is not available right now. Please try again later."],
    "bad-request": ["Check the form", "The saved scope could not be read. Return to Following and preview it again."],
    "bad-email": ["Check the email address", "Enter a complete email address and try again."],
    "bad-lens": ["Check the saved scope", "That topic cannot be followed. Return to Following and choose another topic."],
    "channel-unsupported": ["Email only", "CityScroll currently sends watches by email."],
    "rate-limited": ["Try again tomorrow", "Too many confirmation emails were requested for this address or network."],
    "send-failed": ["Confirmation not sent", "The confirmation email could not be sent. Please try again shortly."],
  };
  const [title, message] = obj.ok
    ? ["Check your inbox", "We sent a confirmation link. The watch starts only after you click it. You can close this page or return to Following."]
    : (copy[obj.reason] || ["Something went wrong", "Return to Following and try again."]);
  return new Response(htmlPage(title, `${message}<br><br><a href="https://cityscroll.org/following/">Return to Following</a>`), {
    status,
    headers: { ...cors, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}
