// GET /admin/subs?key=… — operator read of confirmed subscriptions, straight from the worker's
// OWN SUBS binding. This answers "what does the worker actually see" independent of any external
// CLI/dashboard view of the namespace. FAIL CLOSED: 404 until ADMIN_KEY is set. Read-only.

import { redactEmail } from "./lib/subscriptions.mjs";

export async function handleAdminSubs(req, env) {
  if (!env.ADMIN_KEY) return json({ error: "not found" }, 404);
  const url = new URL(req.url);
  const key = url.searchParams.get("key") || (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (key !== env.ADMIN_KEY) return json({ error: "unauthorized" }, 401);
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
  if (!env.ADMIN_KEY) return json({ error: "not found" }, 404);
  const url = new URL(req.url);
  const key = url.searchParams.get("key") || (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (key !== env.ADMIN_KEY) return json({ error: "unauthorized" }, 401);
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

function maskKey(n) {
  return n.replace(/^(sub:|rl:addr:)([^@:]{0,2})[^@:]*/, "$1$2***");
}
function json(obj, status) {
  return new Response(JSON.stringify(obj, null, 2), { status, headers: { "Content-Type": "application/json" } });
}
