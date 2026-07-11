// Shared daily meters — the denial-of-wallet pattern from /nl, generalized so every
// paid surface (LLM calls, outbound replies) has a hard ceiling that fails closed.
// KV eventual consistency can slightly under-count near a cap; fine for a soft stop.
//
// Keys live in NL_METER (surface meters, `m:<name>:<day>`) and SUBS (per-actor rate
// limits, `rl:<name>:<actor>:<day>`) — both self-expire.

const DAY_TTL = 172800; // 2 days

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Global per-surface daily ceiling. Returns true when the surface is OVER its cap
// (callers must then degrade / refuse). Increments on every allowed call.
export async function overSurfaceCap(store, name, max) {
  try {
    if (!store) return false;
    const key = `m:${name}:${today()}`;
    const cur = parseInt((await store.get(key)) || "0", 10) || 0;
    if (cur >= max) return true;
    await store.put(key, String(cur + 1), { expirationTtl: DAY_TTL });
    return false;
  } catch {
    return false; // meter store down → don't brick the feature; caps are defense-in-depth
  }
}

// Per-actor (sender address, IP) daily limit. Counts ATTEMPTS — deliberate: work is
// spent before we know if a request is legitimate. Returns true when over.
export async function overActorLimit(store, name, actor, max) {
  try {
    if (!store || !actor) return false;
    const key = `rl:${name}:${String(actor).toLowerCase()}:${today()}`;
    const n = (Number(await store.get(key)) || 0) + 1;
    await store.put(key, String(n), { expirationTtl: DAY_TTL });
    return n > max;
  } catch {
    return false;
  }
}
