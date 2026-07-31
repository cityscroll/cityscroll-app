// /unsubscribe?token=… — removes one watch or all watches for an email.
//
// Token shapes (optin-token):
//   { k: <KV key> }           — per-watch (digest footer List-Unsubscribe)
//   { all: 1, e: <email> }    — all watches for that account (preference center / rollup footer)
//
// GET → HTML page; POST → RFC 8058 List-Unsubscribe-Post one-click (empty 200).
// Idempotent: deleting an already-gone key is fine.

import { verifyToken } from "optin-token";
import { htmlPage } from "./lib/confirm_email.mjs";
import { normalizeEmail } from "./lib/subscriptions.mjs";

export async function handleUnsubscribe(req, env) {
  const oneClick = req.method === "POST";
  if (!env.TOKEN_SECRET || !env.SUBS) {
    return oneClick ? new Response(null, { status: 503 }) : page("Unavailable", "This link isn't available right now.", 503);
  }

  const token = new URL(req.url).searchParams.get("token") || "";
  const res = await verifyToken(env.TOKEN_SECRET, token);
  if (!res.valid || !res.payload) {
    return oneClick ? new Response(null, { status: 400 }) : page("Link not valid", "This unsubscribe link is invalid or has expired.", 400);
  }

  const payload = res.payload;

  // Account-level: unsubscribe every watch for this email.
  if (payload.all === 1 || payload.all === true) {
    const email = normalizeEmail(payload.e);
    if (!email || !email.includes("@")) {
      return oneClick ? new Response(null, { status: 400 }) : page("Link not valid", "This unsubscribe link is invalid or has expired.", 400);
    }
    const n = await deleteAllForEmail(env, email);
    return oneClick
      ? new Response(null, { status: 200 })
      : page(
        "Unsubscribed",
        n
          ? `You're off all CityScroll alerts for this address (${n} watch${n === 1 ? "" : "es"} removed). You can re-subscribe any time on cityscroll.org.`
          : "No alerts were active for this address. You can re-subscribe any time on cityscroll.org.",
        200,
      );
  }

  const key = payload.k;
  if (typeof key !== "string" || !key.startsWith("sub:")) {
    return oneClick ? new Response(null, { status: 400 }) : page("Link not valid", "This unsubscribe link is invalid or has expired.", 400);
  }

  try { await env.SUBS.delete(key); } catch { /* idempotent: ignore */ }

  return oneClick
    ? new Response(null, { status: 200 })
    : page("Unsubscribed", "You're off that alert. You can re-subscribe any time on cityscroll.org.", 200);
}

async function deleteAllForEmail(env, email) {
  const want = normalizeEmail(email);
  let deleted = 0;
  let cursor;
  const keys = [];
  try {
    do {
      const res = await env.SUBS.list({ prefix: "sub:", cursor });
      for (const k of res.keys) {
        try {
          const v = JSON.parse(await env.SUBS.get(k.name));
          if (v && normalizeEmail(v.email) === want) keys.push(k.name);
        } catch { /* skip */ }
      }
      cursor = res.list_complete ? null : res.cursor;
    } while (cursor);
    for (const k of keys) {
      try {
        await env.SUBS.delete(k);
        deleted++;
      } catch { /* continue */ }
    }
  } catch { /* partial */ }
  return deleted;
}

function page(title, message, status) {
  return new Response(htmlPage(title, message), { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
