// /unsubscribe?token=… — removes one subscription. The token is a signed payload { k: <KV key> }
// issued in every digest footer + the manage page. Supports GET (a clicked link → HTML page) and
// POST (RFC 8058 List-Unsubscribe-Post one-click → empty 200). Idempotent: deleting an already-
// gone key is fine, so a replayed link just shows "unsubscribed" again.

import { verifyToken } from "optin-token";
import { htmlPage } from "./lib/confirm_email.mjs";

export async function handleUnsubscribe(req, env) {
  const oneClick = req.method === "POST";
  if (!env.TOKEN_SECRET || !env.SUBS) return oneClick ? new Response(null, { status: 503 }) : page("Unavailable", "This link isn't available right now.", 503);

  const token = new URL(req.url).searchParams.get("token") || "";
  const res = await verifyToken(env.TOKEN_SECRET, token);
  const key = res.valid && res.payload ? res.payload.k : null;
  if (typeof key !== "string" || !key.startsWith("sub:")) {
    return oneClick ? new Response(null, { status: 400 }) : page("Link not valid", "This unsubscribe link is invalid or has expired.", 400);
  }

  try { await env.SUBS.delete(key); } catch { /* idempotent: ignore */ }

  return oneClick ? new Response(null, { status: 200 }) : page("Unsubscribed", "You're off that alert. You can re-subscribe any time on crol-list.org.", 200);
}

function page(title, message, status) {
  return new Response(htmlPage(title, message), { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
