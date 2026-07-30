// Pure helpers for email magic-link sessions and the server pin store.
//
// Tokens reuse optin-token (HMAC + exp). Scope is explicit: payload.sc === "pins"
// means READ + pin sync only. Account-affecting actions (unsubscribe, confirm,
// email change) use their own purpose tokens and never the session cookie.

import { normalizeEmail } from "./subscriptions.mjs";
import { opaqueActorId } from "./meter.mjs";

/** Email-link token lifetime (~30 days). Fresh digests re-issue, renewing quietly. */
export const EMAIL_SESSION_TTL_SECONDS = 30 * 24 * 3600;
/** Session cookie lifetime after a successful exchange (~14 days). */
export const SESSION_COOKIE_TTL_SECONDS = 14 * 24 * 3600;
export const SESSION_COOKIE_NAME = "cs_session";
export const SESSION_SCOPE = "pins";
export const MAX_SESSION_ATTEMPTS_PER_IP_DAY = 60;

export const SAFE_NEXT_ORIGINS = new Set([
  "https://cityscroll.org",
  "https://www.cityscroll.org",
  "https://crol-list.org",
  "https://www.crol-list.org",
  "https://cityscroll.pages.dev",
  "https://crol-list.jimdc.com",
  "https://jimdc.github.io",
  "http://localhost:8000",
  "http://localhost:8787",
  "http://localhost:8888",
]);

/** Build the payload for a pins-scoped magic-link or session token. */
export function sessionPayload(email) {
  return { e: normalizeEmail(email), sc: SESSION_SCOPE };
}

/** True when a verified optin-token payload is pins-scoped and carries an email. */
export function isPinsSessionPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.sc !== SESSION_SCOPE) return false;
  const e = normalizeEmail(payload.e);
  return e.length > 0 && e.includes("@");
}

/** Opaque KV key for a subscriber's pin store (email never appears in the key). */
export async function pinsKeyForEmail(email) {
  const id = await opaqueActorId(normalizeEmail(email));
  return `pins:${id}`;
}

/**
 * Bound "next" redirect targets so /session cannot become an open redirect.
 * Returns a safe absolute URL (defaults to the site home).
 */
export function safeNextUrl(raw, fallback = "https://cityscroll.org/") {
  if (raw == null || raw === "") return fallback;
  let s = String(raw);
  // Allow bare hash destinations from digests that only know the fragment.
  if (s.startsWith("#")) s = "https://cityscroll.org/" + s;
  try {
    const u = new URL(s);
    if (!SAFE_NEXT_ORIGINS.has(u.origin)) return fallback;
    // Drop any residual magic-link token query params from the final location.
    u.searchParams.delete("s");
    u.searchParams.delete("token");
    // Hash routes may carry query-like params after the fragment
    // (e.g. #notice/1?s=TOKEN) — strip those token keys too.
    if (u.hash && (u.hash.includes("?") || u.hash.includes("&"))) {
      const hashBody = u.hash.slice(1); // drop leading #
      const qi = hashBody.indexOf("?");
      if (qi >= 0) {
        const pathPart = hashBody.slice(0, qi);
        const qs = new URLSearchParams(hashBody.slice(qi + 1));
        qs.delete("s");
        qs.delete("token");
        const rest = qs.toString();
        u.hash = rest ? `#${pathPart}?${rest}` : `#${pathPart}`;
      }
    }
    return u.toString();
  } catch {
    return fallback;
  }
}

export function sessionCookieHeader(token, { maxAge = SESSION_COOKIE_TTL_SECONDS, clear = false } = {}) {
  if (clear) {
    return `${SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
  }
  return `${SESSION_COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

/** Parse Cookie header for our session cookie value (or null). */
export function readSessionCookie(cookieHeader) {
  if (typeof cookieHeader !== "string" || !cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (name === SESSION_COOKIE_NAME) {
      const v = part.slice(i + 1).trim();
      return v || null;
    }
  }
  return null;
}

// ---- pin store merge (union, dedupe by type+id) ----------------------------

const INV_TYPES = new Set(["notice", "vendor", "agency", "matter"]);

function itemKey(it) {
  return `${String(it?.t || "")}|${String(it?.id || "")}`;
}

function clampItem(it) {
  if (!it || typeof it !== "object") return null;
  const t = String(it.t || "").slice(0, 12);
  const id = String(it.id || "").slice(0, 120);
  if (!id || !INV_TYPES.has(t)) return null;
  return {
    t,
    id,
    title: String(it.title || "").slice(0, 300),
    meta: String(it.meta || "").slice(0, 300),
    note: String(it.note || "").slice(0, 1000),
    added: String(it.added || "").slice(0, 10),
  };
}

function mergeItems(a, b) {
  const map = new Map();
  for (const raw of [...(a || []), ...(b || [])]) {
    const it = clampItem(raw);
    if (!it) continue;
    const k = itemKey(it);
    const prev = map.get(k);
    if (!prev) {
      map.set(k, it);
      continue;
    }
    // Prefer the longer non-empty note; keep the earlier added date when both exist.
    map.set(k, {
      ...prev,
      title: it.title.length >= prev.title.length ? it.title : prev.title,
      meta: it.meta.length >= prev.meta.length ? it.meta : prev.meta,
      note: (it.note || "").length >= (prev.note || "").length ? it.note : prev.note,
      added: prev.added && it.added
        ? (prev.added <= it.added ? prev.added : it.added)
        : (prev.added || it.added),
    });
  }
  return [...map.values()];
}

function emptyInv(name = "My investigation") {
  return {
    name: String(name).slice(0, 80) || "My investigation",
    created: new Date().toISOString().slice(0, 10),
    items: [],
  };
}

/**
 * Normalize a pin store (localStorage inv shape or server payload) to a stable
 * { current, invs } object. Returns null when nothing usable is present.
 */
export function normalizePinStore(raw) {
  if (!raw || typeof raw !== "object") return null;
  const invsIn = raw.invs && typeof raw.invs === "object" ? raw.invs : null;
  // Allow a bare items array as a single investigation (defensive).
  if (!invsIn) {
    if (Array.isArray(raw.items)) {
      return {
        current: "inv1",
        invs: { inv1: { ...emptyInv(raw.name), items: mergeItems(raw.items, []) } },
      };
    }
    return null;
  }
  const invs = {};
  for (const [id, inv] of Object.entries(invsIn)) {
    if (!inv || typeof inv !== "object") continue;
    const sid = String(id).slice(0, 40);
    if (!sid) continue;
    invs[sid] = {
      name: String(inv.name || "My investigation").slice(0, 80),
      created: String(inv.created || new Date().toISOString().slice(0, 10)).slice(0, 10),
      items: mergeItems(inv.items || [], []),
    };
  }
  if (!Object.keys(invs).length) return null;
  let current = String(raw.current || "").slice(0, 40);
  if (!current || !invs[current]) current = Object.keys(invs)[0];
  return { current, invs };
}

/**
 * Union two pin stores. Dedupe items by (type, id). Inv workspaces with the
 * same id merge; distinct ids are kept. Prefer server current when both set.
 */
export function mergePinStores(local, server) {
  const a = normalizePinStore(local);
  const b = normalizePinStore(server);
  if (!a && !b) {
    return { current: "inv1", invs: { inv1: emptyInv() } };
  }
  if (!a) return b;
  if (!b) return a;

  const invs = {};
  const ids = new Set([...Object.keys(a.invs), ...Object.keys(b.invs)]);
  for (const id of ids) {
    const la = a.invs[id];
    const lb = b.invs[id];
    if (la && lb) {
      invs[id] = {
        name: (lb.name && lb.name !== "My investigation" ? lb.name : la.name).slice(0, 80),
        created: (la.created && lb.created
          ? (la.created <= lb.created ? la.created : lb.created)
          : (la.created || lb.created)),
        items: mergeItems(la.items, lb.items),
      };
    } else {
      invs[id] = la || lb;
    }
  }
  let current = b.current && invs[b.current] ? b.current
    : (a.current && invs[a.current] ? a.current : Object.keys(invs)[0]);
  return { current, invs };
}

/** Serialize a pin store for KV (byte-capped). */
export function serializePinStore(store, { maxBytes = 65536 } = {}) {
  const n = normalizePinStore(store);
  if (!n) return null;
  const out = {
    current: n.current,
    invs: n.invs,
    updatedAt: new Date().toISOString(),
  };
  const json = JSON.stringify(out);
  if (json.length > maxBytes) return null;
  return out;
}
