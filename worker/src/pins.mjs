// GET /pins  — read the recognized subscriber's pin store.
// PUT /pins  — write (replace with merged client payload) the pin store.
//
// Requires a pins-scoped session cookie. Account-affecting routes never use this.
// Anonymous callers get { ok:true, recognized:false } — not an error page.

import { corsHeaders, isAllowedRequestOrigin } from "./lib/cors.mjs";
import { emailFromRequest } from "./session.mjs";
import {
  pinsKeyForEmail,
  normalizePinStore,
  mergePinStores,
  serializePinStore,
} from "./lib/session.mjs";
import { appendActionLog } from "./lib/action_log.mjs";

const CORS_OPTS = {
  methods: "GET, PUT, OPTIONS",
  headers: "Content-Type",
  credentials: true,
};

export async function handlePins(req, env) {
  const origin = req.headers.get("origin") || "";
  const cors = corsHeaders(origin, env, CORS_OPTS);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  if (origin && !isAllowedRequestOrigin(origin, env)) {
    return json({ ok: true, recognized: false }, 200, cors);
  }

  if (!env.SUBS || !env.TOKEN_SECRET) {
    return json({ ok: true, recognized: false }, 200, cors);
  }

  const email = await emailFromRequest(req, env);
  if (!email) {
    return json({ ok: true, recognized: false }, 200, cors);
  }

  const key = await pinsKeyForEmail(email);

  if (req.method === "GET") {
    let store = null;
    try {
      const raw = await env.SUBS.get(key);
      if (raw) store = normalizePinStore(JSON.parse(raw));
    } catch { /* treat as empty */ }
    return json({ ok: true, recognized: true, pins: store }, 200, cors);
  }

  if (req.method === "PUT") {
    let body;
    try { body = await req.json(); } catch {
      return json({ ok: false, reason: "bad-json" }, 400, cors);
    }
    // Optional client-side merge: when body.merge is true, union with server first.
    let next = normalizePinStore(body.pins || body);
    if (!next) {
      return json({ ok: false, reason: "bad-payload" }, 400, cors);
    }
    if (body.merge) {
      let server = null;
      try {
        const raw = await env.SUBS.get(key);
        if (raw) server = normalizePinStore(JSON.parse(raw));
      } catch { /* empty */ }
      next = mergePinStores(next, server);
    }
    const serialized = serializePinStore(next);
    if (!serialized) {
      return json({ ok: false, reason: "too-large" }, 400, cors);
    }
    try {
      await env.SUBS.put(key, JSON.stringify(serialized));
    } catch {
      return json({ ok: false, reason: "store-failed" }, 500, cors);
    }
    const investigations = Object.values(serialized.invs || {});
    await appendActionLog(env, {
      action_type: "pins_saved",
      object: { type: "pin_store", id: "recognized" },
      method: { name: "session_pins", version: "v1" },
      metadata: {
        source: "pins",
        merge: body.merge === true,
        investigation_count: investigations.length,
        item_count: investigations.reduce((sum, inv) => sum + (Array.isArray(inv?.items) ? inv.items.length : 0), 0),
      },
    });
    return json({ ok: true, recognized: true, pins: normalizePinStore(serialized) }, 200, cors);
  }

  return json({ ok: false, reason: "method" }, 405, cors);
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
