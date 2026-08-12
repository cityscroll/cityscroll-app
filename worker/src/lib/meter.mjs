// Shared daily meters — the denial-of-wallet pattern from /nl, generalized so every
// paid surface (LLM calls, outbound replies) has a hard ceiling. Callers opt into
// fail-closed behavior when a meter outage must withhold spend; the default remains
// fail-open for callers whose existing behavior depends on it.
// KV eventual consistency can slightly under-count near a cap; fine for a soft stop.
//
// Keys live in NL_METER (surface meters, `m:<name>:<day>`) and other KV namespaces
// (per-actor rate limits, `rl:<name>:a:<sha256>:<day>`) — both self-expire. Actor
// identifiers never appear directly in KV key names.

const DAY_TTL = 172800; // 2 days

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Stable, opaque identifier for a normalized email address or IP string. This is
// pseudonymization, not anonymization; callers must still treat the source identifier as PII.
export async function opaqueActorId(actor) {
  const normalized = String(actor).trim().toLowerCase();
  const data = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return `a:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// Global per-surface daily ceiling. Returns true when the surface is OVER its cap
// (callers must then degrade / refuse). Increments on every allowed call.
export async function overSurfaceCap(store, name, max, options = {}) {
  const failClosed = options?.failClosed === true;
  try {
    if (!store) return failClosed;
    const key = `m:${name}:${today()}`;
    const cur = parseInt((await store.get(key)) || "0", 10) || 0;
    if (cur >= max) return true;
    await store.put(key, String(cur + 1), { expirationTtl: DAY_TTL });
    return false;
  } catch {
    return failClosed;
  }
}

// Per-actor (sender address, IP) daily limit. Counts ATTEMPTS — deliberate: work is
// spent before we know if a request is legitimate. Returns true when over.
export async function overActorLimit(store, name, actor, max, options = {}) {
  const failClosed = options?.failClosed === true;
  try {
    if (!store) return failClosed;
    if (!actor) return false;
    const key = `rl:${name}:${await opaqueActorId(actor)}:${today()}`;
    const n = (Number(await store.get(key)) || 0) + 1;
    await store.put(key, String(n), { expirationTtl: DAY_TTL });
    return n > max;
  } catch {
    return failClosed;
  }
}
