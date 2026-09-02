import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEPRECATED_OPT_IN_RECOVERY_SOURCE,
  SIGNUP_LIFECYCLE,
  SUPPORTED_LANGS,
  buildSubscription,
  buildTopiclessIntent,
  isDeveloperTestEmail,
  isSelfOriginEmail,
  OWNED_EMAIL_DOMAINS,
  isTestSubscriber,
  isRealSubscriber,
  isTopiclessIntent,
  isValidEmail,
  normalizeEmail,
  redactEmail,
  maskKeyForLog,
  maskDigestResultForLog,
  signupLifecycleFromRecord,
  summarizeSignupLifecycle,
  formatSignupLifecycleSummary,
  subCanonical,
  topiclessIntentKey,
} from "../src/lib/subscriptions.mjs";

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

test("topicless default has a stable distinct key and a disclosed weekly contracts lens", async () => {
  const record = buildTopiclessIntent({ email: " Reader@Example.com ", now: 0 });
  assert.equal(isTopiclessIntent(record), true);
  assert.deepEqual({
    no_topic: record.no_topic,
    no_topic_default: record.no_topic_default,
    source: record.source,
    state: record.state,
    lens: record.lens,
    filter: record.filter,
    freq: record.freq,
  }, {
    no_topic: true,
    no_topic_default: true,
    source: "top-of-site",
    state: "confirmed",
    lens: "money",
    filter: {},
    freq: "weekly",
  });
  assert.equal(await topiclessIntentKey(" Reader@Example.com "), await topiclessIntentKey("reader@example.com"));

  const legacy = { email: "reader@example.com", lens: "money", filter: {} };
  assert.equal(isTopiclessIntent(legacy), false);
});

test("redactEmail hides the local part for logs", () => {
  assert.equal(redactEmail("janedoe@example.com"), "ja***@example.com");
  assert.equal(redactEmail("ab@x.co"), "a***@x.co");
});

test("maskKeyForLog is 256-way and only for shared logs", () => {
  assert.equal(maskKeyForLog("sub:36abcdef01234567"), "sub:36***");
  assert.equal(maskKeyForLog("sub:36fedcba76543210"), "sub:36***");
  assert.equal(maskKeyForLog("account:alice@example.com"), "account:al***@example.com");
  assert.equal(maskKeyForLog("rl:addr:owner@example.com"), "rl:addr:ow***@example.com");
});

test("maskDigestResultForLog masks identity on nested digest results", () => {
  const masked = maskDigestResultForLog({
    sub: "sub:36abcdef01234567",
    email: "owner@example.com",
    emailRedacted: "ow***@example.com",
    sections: [{ sub: "sub:36fedcba76543210", key: "sub:36fedcba76543210", new: 1 }],
  });
  assert.equal(masked.sub, "sub:36***");
  assert.equal(masked.email, "ow***@example.com");
  assert.equal(masked.emailRedacted, "ow***@example.com");
  assert.equal(masked.sections[0].sub, "sub:36***");
  assert.equal(masked.sections[0].key, "sub:36***");
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

test("isDeveloperTestEmail recognizes plus-tagged e2e and scope-watch addresses only", () => {
  assert.equal(isDeveloperTestEmail("jamesca2ro+scope-watch-e2e-20260806@gmail.com"), true);
  assert.equal(isDeveloperTestEmail("qa+e2e@example.com"), true);
  assert.equal(isDeveloperTestEmail("ops+scope-watch@example.com"), true);
  assert.equal(isDeveloperTestEmail("reader+newsletter@example.com"), false);
  assert.equal(isDeveloperTestEmail("devinbalkind@gmail.com"), false);
  assert.equal(isTestSubscriber({ email: "jamesca2ro+scope-watch-e2e-20260806@gmail.com" }), true);
  assert.equal(isTestSubscriber({ email: "reader@example.com", developer_test: true }), true);
  assert.equal(isTestSubscriber({ email: "reader@example.com" }), false);
});

test("isSelfOriginEmail recognizes owned sending domains and any subdomain, not lookalikes", () => {
  assert.ok(OWNED_EMAIL_DOMAINS.length >= 2, "covers the canonical and compatibility apexes");
  for (const domain of OWNED_EMAIL_DOMAINS) {
    assert.equal(isSelfOriginEmail(`alerts@${domain}`), true, `apex ${domain} is owned`);
    assert.equal(isSelfOriginEmail(`delivery@send.${domain}`), true, `a subdomain of ${domain} is owned`);
  }
  assert.equal(isSelfOriginEmail("reader@gmail.com"), false);
  assert.equal(isSelfOriginEmail(`reader@not${OWNED_EMAIL_DOMAINS[0]}`), false, "must not match a domain that merely ends in the same text");
  assert.equal(isSelfOriginEmail(""), false);
});

test("self-origin addresses are machine accounts, kept in their own lifecycle bucket", () => {
  const machine = { email: "delivery@send.cityscroll.org" };
  assert.equal(isTestSubscriber(machine), true, "excluded from real delivery/counts");
  assert.equal(isRealSubscriber(machine), false);
  assert.deepEqual(signupLifecycleFromRecord(machine), {
    signup_lifecycle: SIGNUP_LIFECYCLE.SELF_ORIGIN,
    status: SIGNUP_LIFECYCLE.SELF_ORIGIN,
  });
  const summary = summarizeSignupLifecycle([
    { email: machine.email, ...signupLifecycleFromRecord(machine) },
    { email: "person@gmail.com", signup_lifecycle: SIGNUP_LIFECYCLE.ENROLLED, status: SIGNUP_LIFECYCLE.ENROLLED },
  ]);
  assert.equal(summary.self_origin, 1);
  assert.equal(summary.enrolled, 1, "a real user is not miscounted as machine");
  const selfOrigin = summary.categories.find((c) => c.id === "self_origin");
  assert.equal(selfOrigin.count, 1);
  assert.equal(selfOrigin.label, "machine / self-origin");
});

test("signupLifecycleFromRecord projects recovered pending-enrollment before first digest", () => {
  const recovered = {
    email: "ninodepaola@gmail.com",
    source: DEPRECATED_OPT_IN_RECOVERY_SOURCE,
    delivery_not_before: "2026-08-18T23:00:00.000Z",
  };
  assert.deepEqual(signupLifecycleFromRecord(recovered, { lastSent: "2026-08-18" }), {
    signup_lifecycle: SIGNUP_LIFECYCLE.RECOVERED,
    status: SIGNUP_LIFECYCLE.PENDING_ENROLLMENT,
  });
  assert.deepEqual(signupLifecycleFromRecord(recovered, { lastSent: "2026-08-25" }), {
    signup_lifecycle: SIGNUP_LIFECYCLE.ENROLLED,
    status: SIGNUP_LIFECYCLE.ENROLLED,
  });
});

test("summarizeSignupLifecycle keeps recovered pending as the intermediate category before enrollment", () => {
  const recovered = {
    email: "de***@gmail.com",
    signup_lifecycle: SIGNUP_LIFECYCLE.RECOVERED,
    status: SIGNUP_LIFECYCLE.PENDING_ENROLLMENT,
  };
  const pending = summarizeSignupLifecycle([recovered, recovered, recovered]);
  assert.equal(pending.recovered_pending, 3);
  assert.equal(pending.enrolled, 0);
  assert.equal(pending.summary, "3 recovered, pending");
  assert.equal(pending.categories[0].id, "recovered_pending");
  assert.equal(pending.categories[1].id, "enrolled");

  const enrolledRow = {
    email: "de***@gmail.com",
    signup_lifecycle: SIGNUP_LIFECYCLE.ENROLLED,
    status: SIGNUP_LIFECYCLE.ENROLLED,
  };
  const enrolled = summarizeSignupLifecycle([enrolledRow, enrolledRow, enrolledRow]);
  assert.equal(enrolled.recovered_pending, 0);
  assert.equal(enrolled.enrolled, 3);
  assert.equal(enrolled.summary, "3 enrolled");
  assert.equal(formatSignupLifecycleSummary({ recovered_pending: 3, enrolled: 12 }), "3 recovered, pending · 12 enrolled");
});

test("subCanonical excludes lang — changing language does not produce a different id", () => {
  const base = { email: "a@b.com", lens: "money", filter: { q: "affordable housing" } };
  const en = subCanonical({ ...base });
  const es = subCanonical({ ...base, lang: "es" });
  assert.equal(en, es, "subCanonical must be identical regardless of lang");
});
