// HMAC token helpers for double-opt-in confirm + one-click unsubscribe links.
// Runtime-agnostic: uses Web Crypto (globalThis.crypto.subtle), present in BOTH the
// Cloudflare Workers runtime and the Node 20+ test runner. No Buffer / node: imports,
// so it bundles for Workers with no nodejs_compat.
//
// Token format:  base64url(JSON payload) "." base64url(HMAC-SHA256 of that JSON)
// The payload carries the subscription intent + iat/exp. The signature proves WE issued it
// (can't be forged or guessed); exp bounds its lifetime. SINGLE-USE is enforced at the KV
// layer (a confirmed/removed subscription can't be re-confirmed), not in the token itself.

const subtle = () => globalThis.crypto.subtle; // lazy: avoid import-time crash on old runtimes
const enc = new TextEncoder();
const dec = new TextDecoder();

function bytesToB64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToBytes(str) {
  const pad = str.length % 4 === 0 ? 0 : 4 - (str.length % 4);
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function keyFor(secret) {
  return subtle().importKey("raw", enc.encode(String(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

// Sign `payload` (plus iat/exp) into a token. ttlSeconds bounds its lifetime.
export async function signToken(secret, payload, { ttlSeconds, now = Date.now() }) {
  const nowS = Math.floor(now / 1000);
  const body = { ...payload, iat: nowS, exp: nowS + ttlSeconds };
  const json = JSON.stringify(body);
  const sig = new Uint8Array(await subtle().sign("HMAC", await keyFor(secret), enc.encode(json)));
  return bytesToB64url(enc.encode(json)) + "." + bytesToB64url(sig);
}

// Verify a token. Returns { valid, payload?, reason? }. Never throws on bad input.
export async function verifyToken(secret, token, { now = Date.now() } = {}) {
  if (typeof token !== "string" || token.indexOf(".") < 1 || token.endsWith(".")) {
    return { valid: false, reason: "malformed" };
  }
  const [p, s] = token.split(".");
  let jsonBytes, sigBytes;
  try {
    jsonBytes = b64urlToBytes(p);
    sigBytes = b64urlToBytes(s);
  } catch {
    return { valid: false, reason: "malformed" };
  }
  let ok = false;
  try {
    ok = await subtle().verify("HMAC", await keyFor(secret), sigBytes, jsonBytes);
  } catch {
    return { valid: false, reason: "malformed" };
  }
  if (!ok) return { valid: false, reason: "bad-signature" };
  let payload;
  try {
    payload = JSON.parse(dec.decode(jsonBytes));
  } catch {
    return { valid: false, reason: "malformed" };
  }
  if (typeof payload.exp !== "number" || Math.floor(now / 1000) > payload.exp) {
    return { valid: false, reason: "expired", payload };
  }
  return { valid: true, payload };
}
