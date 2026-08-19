// GET /confirm?token=… — compatibility for signed confirmation links issued before the
// single-opt-in cutover. A valid legacy link may create its watch once; an already-enrolled watch
// is an idempotent no-op. New signups never depend on this endpoint.

import { verifyToken } from "optin-token";
import {
  buildSubscription,
  deriveSubscriberId,
  deriveWatchId,
  isTopiclessIntent,
  normalizeEmail,
  subscriptionKey,
} from "./lib/subscriptions.mjs";
import { describeFilter, htmlPage } from "./lib/confirm_email.mjs";
import { emitUsageEvent } from "./lib/analytics.mjs";
import { appendWatchLog, watchLabel } from "./lib/watchlog.mjs";
import { prefsLink } from "./prefs.mjs";

export async function handleConfirm(req, env) {
  if (!env.TOKEN_SECRET || !env.SUBS) return page("Unavailable", "This link isn't available right now.", 503);

  const token = new URL(req.url).searchParams.get("token") || "";
  const res = await verifyToken(env.TOKEN_SECRET, token);
  if (!res.valid) {
    const msg = res.reason === "expired"
      ? "This older signup link has expired. Subscribe again on cityscroll.org."
      : "This signup link is invalid.";
    return page("Link not valid", msg, 400);
  }

  const payload = res.payload;
  if (payload.nt === 1) return legacyTopiclessLanding(env, payload);

  const sub = buildSubscription({
    email: payload.e,
    lens: payload.l,
    filter: payload.f,
    channel: payload.c,
    freq: payload.q,
    lang: payload.lng || "en",
  });
  const key = await subscriptionKey(sub);
  let existing = null;
  try {
    const raw = await env.SUBS.get(key);
    existing = raw ? JSON.parse(raw) : null;
    if (!existing) {
      sub.source = "legacy-confirm";
      sub.subscriber_id = await deriveSubscriberId(sub.email);
      sub.watch_id = await deriveWatchId(key);
      await env.SUBS.put(key, JSON.stringify(sub));
      emitUsageEvent(env, { event: "alert_confirmed", lens: sub.lens, surface: "legacy-confirm" });
      await appendWatchLog(env, {
        action: "subscribe",
        email: sub.email,
        subKey: key,
        lens: sub.lens,
        label: watchLabel(sub),
        freq: sub.freq,
        source: "legacy-confirm",
        at: sub.createdAt,
      });
    }
  } catch {
    return page("Something went wrong", "We couldn't save your subscription — please try again.", 500);
  }

  const active = existing || sub;
  const desc = escHtml(describeFilter(active.lens, active.filter));
  const manageUrl = await prefsLink(env, active.email);
  const manage = manageUrl
    ? `<br><br><a href="${escAttr(manageUrl)}">Manage or unsubscribe from this watch</a>`
    : "";
  return page(
    "You're subscribed ✅",
    `Your watch for <b>${desc}</b> is active. Every email has a one-click unsubscribe.${manage}`,
    200,
  );
}

async function legacyTopiclessLanding(env, payload) {
  const key = typeof payload.k === "string" && payload.k.startsWith("sub:") ? payload.k : null;
  if (!key || payload.s !== "top-of-site") return page("Link not valid", "This signup link is invalid.", 400);
  let record = null;
  try {
    const raw = await env.SUBS.get(key);
    record = raw ? JSON.parse(raw) : null;
  } catch { /* handled below */ }
  if (!isTopiclessIntent(record)
      || normalizeEmail(record.email) !== normalizeEmail(payload.e)
      || record.source !== payload.s) {
    return page("Link not valid", "This signup is no longer active.", 400);
  }
  const manageUrl = await prefsLink(env, record.email);
  const manage = manageUrl ? `<br><br><a href="${escAttr(manageUrl)}">Manage or remove this interest</a>` : "";
  return page(
    "You're subscribed ✅",
    `Your weekly NYC contracts digest is active. It covers new contract solicitations, awards, and other procurement notices across the city. <a href="https://cityscroll.org/following/">Choose another topic in Following</a>.${manage}`,
    200,
  );
}

function escHtml(s) {
  return String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
}
function escAttr(s) {
  return String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
}
function page(title, message, status) {
  return new Response(htmlPage(title, message), { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
