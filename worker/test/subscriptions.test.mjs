import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidEmail, normalizeEmail, buildSubscription, redactEmail, subCanonical, SUPPORTED_LANGS } from "../src/lib/subscriptions.mjs";

test("isValidEmail accepts well-formed and rejects junk", () => {
  for (const ok of ["a@b.co", "Jane.Doe@example.com", "x+y@sub.domain.org"]) {
    assert.equal(isValidEmail(ok), true, `should accept ${ok}`);
  }
  for (const bad of ["", "no-at", "a@b", "a b@c.com", "a@@b.com", "x".repeat(250) + "@b.com"]) {
    assert.equal(isValidEmail(bad), false, `should reject ${JSON.stringify(bad)}`);
  }
});

test("normalizeEmail lowercases and trims", () => {
  assert.equal(normalizeEmail("  Jane@Example.COM "), "jane@example.com");
});

test("buildSubscription normalizes email and clamps channel/freq to safe defaults", () => {
  const s = buildSubscription({
    email: " A@B.com ", lens: "money", filter: { minAmount: 1000000 },
    channel: "carrier-pigeon", freq: "hourly", now: 0,
  });
  assert.equal(s.email, "a@b.com");
  assert.equal(s.lens, "money");
  assert.equal(s.channel, "email"); // unknown channel → default
  assert.equal(s.freq, "daily");    // unknown freq → default
  assert.deepEqual(s.filter, { minAmount: 1000000 });
  assert.equal(s.createdAt, new Date(0).toISOString());
});

test("buildSubscription keeps valid channel/freq", () => {
  const s = buildSubscription({ email: "a@b.com", lens: "land", filter: {}, channel: "sms", freq: "weekly", now: 0 });
  assert.equal(s.channel, "sms");
  assert.equal(s.freq, "weekly");
});

test("redactEmail hides the local part for logs", () => {
  assert.equal(redactEmail("janedoe@example.com"), "ja***@example.com");
  assert.equal(redactEmail("ab@x.co"), "a***@x.co");
});

test("SUPPORTED_LANGS exports at least en and es", () => {
  assert.ok(Array.isArray(SUPPORTED_LANGS), "SUPPORTED_LANGS must be an array");
  assert.ok(SUPPORTED_LANGS.includes("en"), "must include en");
  assert.ok(SUPPORTED_LANGS.includes("es"), "must include es");
});

test("buildSubscription stores valid lang and clamps unknown to en", () => {
  const es = buildSubscription({ email: "a@b.com", lens: "money", filter: {}, lang: "es", now: 0 });
  assert.equal(es.lang, "es");
  const bad = buildSubscription({ email: "a@b.com", lens: "money", filter: {}, lang: "klingon", now: 0 });
  assert.equal(bad.lang, "en", "unknown lang must clamp to en");
  const def = buildSubscription({ email: "a@b.com", lens: "money", filter: {}, now: 0 });
  assert.equal(def.lang, "en", "default lang must be en");
});

test("subCanonical excludes lang — changing language does not produce a different id", () => {
  const base = { email: "a@b.com", lens: "money", filter: { q: "affordable housing" } };
  const en = subCanonical({ ...base });
  const es = subCanonical({ ...base, lang: "es" });
  assert.equal(en, es, "subCanonical must be identical regardless of lang");
});
