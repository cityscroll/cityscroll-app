// GET /confirm?token=… — the double-opt-in landing. Verifies the signed, unexpired token
// (issued by /subscribe) and only THEN writes the ACTIVE subscription to KV. Replaying an
// expired/forged token does nothing. Returns a small HTML page (it's clicked from an email).

import { verifyToken } from "./lib/token.mjs";
import { buildSubscription, subCanonical } from "./lib/subscriptions.mjs";
import { describeFilter, htmlPage } from "./lib/confirm_email.mjs";

export async function handleConfirm(req, env) {
  if (!env.TOKEN_SECRET || !env.SUBS) return page("Unavailable", "This link isn't available right now.", 503);

  const token = new URL(req.url).searchParams.get("token") || "";
  const res = await verifyToken(env.TOKEN_SECRET, token);
  if (!res.valid) {
    const msg = res.reason === "expired"
      ? "This confirmation link has expired. Please subscribe again on crol-list.org."
      : "This confirmation link is invalid.";
    return page("Link not valid", msg, 400);
  }

  const p = res.payload; // { e, l, f, c, q }
  const sub = buildSubscription({ email: p.e, lens: p.l, filter: p.f, channel: p.c, freq: p.q });
  const key = `sub:${sub.email}:${await subId(sub)}`;
  try {
    await env.SUBS.put(key, JSON.stringify(sub));
  } catch {
    return page("Something went wrong", "We couldn't save your subscription — please try again.", 500);
  }

  const desc = escHtml(describeFilter(sub.lens, sub.filter));
  return page(
    "You're subscribed ✅",
    `You'll get <b>${desc}</b> the moment there's a new notice — and nothing on quiet days. Every email has a one-click unsubscribe.`,
    200
  );
}

// Stable short id for a (email, lens, filter) so re-confirming is idempotent (same key).
async function subId(sub) {
  const data = new TextEncoder().encode(subCanonical(sub));
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function escHtml(s) {
  return String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
}
function page(title, message, status) {
  return new Response(htmlPage(title, message), { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
