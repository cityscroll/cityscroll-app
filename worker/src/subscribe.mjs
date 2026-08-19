// POST /subscribe — the public single-opt-in signup endpoint. The browser submits an
// already-compiled lens filter (re-sanitized here, never trusted), and the worker stores the
// subscription before sending a transactional welcome with manage + one-click unsubscribe.
// Topicless homepage requests get the disclosed weekly NYC-contracts default plus provenance.
//
// FAIL CLOSED: returns 503 until TOKEN_SECRET + RESEND_API_KEY + SUBS are configured.
// Rate limits are the primary bot friction on this no-CAPTCHA path and run before any write/send.

import { resolveLens, sanitize } from "./lib/filter.mjs";
import {
  TOPICLESS_SOURCE,
  isValidEmail,
  buildSubscription,
  buildTopiclessIntent,
  deriveSubscriberId,
  deriveWatchId,
  isDeveloperTestEmail,
  isTopiclessIntent,
  SIGNUP_LIFECYCLE,
  subscriptionKey,
  topiclessIntentKey,
} from "./lib/subscriptions.mjs";
import { signToken } from "optin-token";
import { htmlPage, welcomeEmailHtml, welcomeSubject } from "./lib/confirm_email.mjs";
import { corsHeaders, isAllowedRequestOrigin } from "./lib/cors.mjs";
import { overActorLimit } from "./lib/meter.mjs";
import { emitUsageEvent } from "./lib/analytics.mjs";
import { prefsLink } from "./prefs.mjs";
import { appendWatchLog, watchLabel } from "./lib/watchlog.mjs";

const SUBSCRIBABLE = new Set([
  "money", "people", "land", "property", "rules", "meetings", "district", "entity", "award",
  "mandates", "obligations",
]);
const UNSUBSCRIBE_TTL_SECONDS = 60 * 24 * 3600;
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
  const topicless = body.no_topic === true || body.no_topic === "true";
  const requestedLens = String(body.lens || "");
  const lens = SUBSCRIBABLE.has(requestedLens) ? resolveLens(requestedLens) : null;
  if (!isValidEmail(email)) return reply(req, { ok: false, reason: "bad-email" }, 400, cors);
  if (topicless && body.source !== TOPICLESS_SOURCE) return reply(req, { ok: false, reason: "bad-intent" }, 400, cors);
  if (!topicless && !lens) return reply(req, { ok: false, reason: "bad-lens" }, 400, cors);
  if ((body.channel || "email") !== "email") return reply(req, { ok: false, reason: "channel-unsupported" }, 400, cors);

  const ip = req.headers.get("CF-Connecting-IP") || "";
  if (await overLimit(env, ip, email)) return reply(req, { ok: false, reason: "rate-limited" }, 429, cors);

  const lang = typeof body.lang === "string" ? body.lang : "en";
  const sub = topicless
    ? buildTopiclessIntent({ email, source: TOPICLESS_SOURCE, lang })
    : buildSubscription({
      email,
      lens,
      filter: sanitize(lens, body.filter),
      channel: "email",
      freq: body.freq,
      lang,
    });
  try {
    const enrolled = await enrollAndWelcome(env, sub, {
      source: topicless ? TOPICLESS_SOURCE : "following",
    });
    return reply(req, { ok: true, no_topic: topicless, key: enrolled.key }, 200, cors);
  } catch (error) {
    const reason = error?.code === "save-failed" ? "save-failed" : "send-failed";
    return reply(req, { ok: false, reason, subscribed: error?.subscribed === true }, reason === "save-failed" ? 503 : 502, cors);
  }
}

/** Shared immediate-enrollment transaction for web, inbound email, and MCP surfaces. */
export async function enrollAndWelcome(env, candidate, { source = "following" } = {}) {
  const topicless = isTopiclessIntent(candidate);
  const key = topicless ? await topiclessIntentKey(candidate.email, candidate.source) : await subscriptionKey(candidate);
  let existing = null;
  try {
    const raw = await env.SUBS.get(key);
    existing = raw ? JSON.parse(raw) : null;
  } catch { /* a write below remains authoritative */ }

  const record = {
    ...candidate,
    createdAt: existing?.createdAt || candidate.createdAt,
  };
  if (candidate.source || existing?.source) record.source = candidate.source || existing.source;
  record.subscriber_id = existing?.subscriber_id || await deriveSubscriberId(record.email);
  record.watch_id = existing?.watch_id || await deriveWatchId(key);
  if (isDeveloperTestEmail(record.email)) {
    record.developer_test = true;
    record.signup_lifecycle = SIGNUP_LIFECYCLE.TEST;
    record.status = SIGNUP_LIFECYCLE.TEST;
  }
  try {
    await env.SUBS.put(key, JSON.stringify(record));
  } catch {
    const error = new Error("subscription save failed");
    error.code = "save-failed";
    throw error;
  }

  emitUsageEvent(env, { event: "alert_confirmed", lens: record.lens, surface: source });
  await appendWatchLog(env, {
    action: "subscribe",
    email: record.email,
    subKey: key,
    lens: record.lens,
    label: watchLabel(record),
    freq: record.freq,
    source,
    at: new Date().toISOString(),
  });

  const unsubscribeUrl = await unsubscribeLink(env, key);
  const manageUrl = await prefsLink(env, record.email);
  try {
    await sendWelcome(env, record.email, {
      manageUrl,
      unsubscribeUrl,
      lens: record.lens,
      filter: record.filter,
      freq: record.freq,
      lang: record.lang,
      noTopicDefault: topicless,
    });
  } catch (cause) {
    const error = new Error("welcome email send failed", { cause });
    error.code = "send-failed";
    error.subscribed = true;
    throw error;
  }
  return { key, record };
}

export async function sendWelcome(env, to, template) {
  const from = env.ALERTS_FROM || "CityScroll <alerts@crol-list.org>";
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.RESEND_API_KEY}` },
    body: JSON.stringify({
      from,
      to,
      subject: welcomeSubject(template.lang),
      html: welcomeEmailHtml(template),
      headers: {
        "List-Unsubscribe": `<${template.unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    }),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
}

async function unsubscribeLink(env, subKey) {
  const token = await signToken(env.TOKEN_SECRET, { k: subKey }, { ttlSeconds: UNSUBSCRIBE_TTL_SECONDS });
  const base = env.CONFIRM_BASE || "https://api.cityscroll.org";
  return `${base}/unsubscribe?token=${encodeURIComponent(token)}`;
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
    "bad-intent": ["Check the form", "That signup source is not recognized."],
    "bad-lens": ["Check the saved scope", "That topic cannot be followed. Return to Following and choose another topic."],
    "channel-unsupported": ["Email only", "CityScroll currently sends watches by email."],
    "rate-limited": ["Try again tomorrow", "Too many signup requests were made for this address or network."],
    "send-failed": obj.subscribed
      ? ["You're subscribed", "Your subscription is active, but the welcome email could not be sent. Try again to receive a manage link."]
      : ["Welcome not sent", "The welcome email could not be sent. Please try again shortly."],
    "save-failed": ["Temporarily unavailable", "We couldn't save your subscription. Please try again shortly."],
  };
  const topicLink = obj.no_topic
    ? '<br><br>You are subscribed to the weekly NYC contracts digest. <a href="https://cityscroll.org/following/">Manage or choose another topic in Following</a>.'
    : "";
  const [title, message] = obj.ok
    ? ["You're subscribed", `We'll email you. Manage or unsubscribe anytime.${topicLink}`]
    : (copy[obj.reason] || ["Something went wrong", "Return to Following and try again."]);
  return new Response(htmlPage(title, `${message}<br><br><a href="https://cityscroll.org/following/">Return to Following</a>`), {
    status,
    headers: { ...cors, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}
