// Regression guard for the confirm/unsubscribe token contract crol-worker depends on, now that
// signToken/verifyToken live in the `optin-token` package (extracted 2026-07-02). The exhaustive
// unit suite ships with the package; this asserts the specific properties /subscribe, /confirm,
// and /unsubscribe rely on, exercised through the real dependency so a bad swap fails CI here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { signToken, verifyToken } from "optin-token";

const SECRET = "test-secret-key-do-not-use-in-prod";
const T0 = 1_700_000_000_000;

test("a confirm token round-trips its subscription payload", async () => {
  // shape mirrors subscribe.mjs: { e, l, f, c, q }
  const tok = await signToken(SECRET, { e: "a@b.com", l: "money", f: {}, c: "email", q: "daily" }, { ttlSeconds: 86400, now: T0 });
  const res = await verifyToken(SECRET, tok, { now: T0 + 1000 });
  assert.equal(res.valid, true);
  assert.equal(res.payload.e, "a@b.com");
  assert.equal(res.payload.l, "money");
});

test("a forged token (wrong secret) is rejected", async () => {
  const tok = await signToken(SECRET, { e: "a@b.com" }, { ttlSeconds: 60, now: T0 });
  const res = await verifyToken("a-different-secret", tok, { now: T0 });
  assert.equal(res.valid, false);
  assert.equal(res.reason, "bad-signature");
});

test("an expired confirm link is rejected (so /confirm can say 'expired, subscribe again')", async () => {
  const tok = await signToken(SECRET, { e: "a@b.com" }, { ttlSeconds: 60, now: T0 });
  const res = await verifyToken(SECRET, tok, { now: T0 + 61_000 });
  assert.equal(res.valid, false);
  assert.equal(res.reason, "expired");
});

test("malformed tokens never throw (so a garbage ?token= is a 400, not a 500)", async () => {
  for (const bad of ["", "nodot", "...", "x."]) {
    assert.equal((await verifyToken(SECRET, bad, { now: T0 })).valid, false);
  }
});
