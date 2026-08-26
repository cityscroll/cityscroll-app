import { test } from "node:test";
import assert from "node:assert/strict";
import { validateFeedback, FEEDBACK_CATEGORIES, REPORT_CATEGORIES, MSG_MIN, MSG_MAX } from "../src/lib/feedback.mjs";
import { handleFeedback } from "../src/feedback.mjs";
import { overActorLimit } from "../src/lib/meter.mjs";
import { buildContractReportTarget } from "../../site/report_issue.mjs";

const good = (over = {}) => ({ category: "bug", message: "Something broke on the money tab.", email: "", ...over });

test("validateFeedback accepts a well-formed submission", () => {
  const r = validateFeedback(good());
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { category: "bug", message: "Something broke on the money tab.", email: "" });
});

test("validateFeedback keeps a Contract report target and optional evidence attached", () => {
  const target = buildContractReportTarget({
    procurement_id: "procurement:contract:CT123",
    canonical_href: "/procurements/procurement%3Acontract%3ACT123",
    short_title: "Street repair contract",
    vendor_name: "Acme Works",
    source_observation_refs: ["passport_public_contracts:row-1"],
  });
  const result = validateFeedback({
    category: "information_wrong",
    message: "The published vendor name does not match the source record.",
    evidence: "See the attached public contract row.",
    report_target: target,
    email: "",
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.category, "report");
  assert.equal(result.value.report.category, "information_wrong");
  assert.equal(result.value.report_target.target_id, target.target_id);
  assert.equal(result.value.report_target.canonical_url, target.canonical_url);
  assert.equal(result.value.evidence, "See the attached public contract row.");
});

test("object reports reject generic categories and malformed targets", () => {
  assert.ok(REPORT_CATEGORIES.includes("information_wrong"));
  assert.equal(validateFeedback({
    category: "bug", message: "This is long enough.", report_target: {},
  }).reason, "bad-report-category");
  assert.equal(validateFeedback({
    category: "information_wrong", message: "This is long enough.", report_target: {},
  }).reason, "bad-report-target");
});

test("every known category is accepted", () => {
  for (const c of FEEDBACK_CATEGORIES) {
    assert.equal(validateFeedback(good({ category: c })).ok, true, `should accept ${c}`);
  }
});

test("category is trimmed and case-insensitive", () => {
  assert.equal(validateFeedback(good({ category: " Bug " })).value.category, "bug");
  assert.equal(validateFeedback(good({ category: "GENERAL" })).value.category, "general");
});

test("unknown / empty / non-string category is rejected as bad-category", () => {
  for (const c of ["", "spam", "urgent", "  ", null, undefined, 42, {}]) {
    const r = validateFeedback(good({ category: c }));
    assert.equal(r.ok, false, `should reject ${JSON.stringify(c)}`);
    assert.equal(r.reason, "bad-category");
  }
});

test("message shorter than MSG_MIN is rejected as bad-message", () => {
  const r = validateFeedback(good({ message: "x".repeat(MSG_MIN - 1) }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bad-message");
});

test("message is trimmed BEFORE the length check", () => {
  const r = validateFeedback(good({ message: "   " + "x".repeat(MSG_MIN - 1) + "   " }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bad-message");
});

test("message longer than MSG_MAX is rejected as bad-message", () => {
  const r = validateFeedback(good({ message: "x".repeat(MSG_MAX + 1) }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bad-message");
});

test("message exactly at the MIN and MAX bounds is accepted", () => {
  assert.equal(validateFeedback(good({ message: "x".repeat(MSG_MIN) })).ok, true);
  assert.equal(validateFeedback(good({ message: "x".repeat(MSG_MAX) })).ok, true);
});

test("email is optional — blank or missing is fine", () => {
  assert.equal(validateFeedback(good({ email: "" })).ok, true);
  const noEmail = good();
  delete noEmail.email;
  const r = validateFeedback(noEmail);
  assert.equal(r.ok, true);
  assert.equal(r.value.email, "");
});

test("a malformed email is rejected as bad-email", () => {
  for (const bad of ["not-an-email", "a@b", "a b@c.com", "x@@y.com"]) {
    const r = validateFeedback(good({ email: bad }));
    assert.equal(r.ok, false, `should reject ${bad}`);
    assert.equal(r.reason, "bad-email");
  }
});

test("a valid email is normalized (trimmed + lowercased)", () => {
  const r = validateFeedback(good({ email: "  Me@Example.COM " }));
  assert.equal(r.ok, true);
  assert.equal(r.value.email, "me@example.com");
});

test("validateFeedback tolerates a null / undefined / garbage body", () => {
  assert.equal(validateFeedback(null).ok, false);
  assert.equal(validateFeedback(undefined).ok, false);
  assert.equal(validateFeedback("nope").ok, false);
});

// ── endpoint gating (drives handleFeedback with a fake Request + env; no network) ─────────────

// Minimal fake Workers KV, seeded from a { key: value } map.
function kv(map = {}) {
  return {
    get: async (k) => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null),
    put: async (k, v) => { map[k] = v; },
    list: async () => ({ keys: [], list_complete: true }),
  };
}
const configured = () => ({ RESEND_API_KEY: "rk", FEEDBACK: kv() });
const post = (body, headers = {}) =>
  new Request("https://w/feedback", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

function withMockResend(fn) {
  return async () => {
    const prev = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes("api.resend.com")) {
        return new Response(JSON.stringify({ id: "mock" }), { status: 200 });
      }
      return prev ? prev(url) : new Response("unexpected", { status: 500 });
    };
    try {
      await fn();
    } finally {
      globalThis.fetch = prev;
    }
  };
}

test("FAIL CLOSED: 503 not-configured until RESEND_API_KEY + FEEDBACK both exist (Turnstile not required)", async () => {
  for (const env of [{}, { RESEND_API_KEY: "rk" }, { FEEDBACK: kv() }, { TURNSTILE_SECRET: "ts", FEEDBACK: kv() }]) {
    const r = await handleFeedback(post(good()), env);
    assert.equal(r.status, 503);
    assert.equal((await r.json()).reason, "not-configured");
  }
});

test("accepts submission without turnstile token when Turnstile is not configured", withMockResend(async () => {
  const store = {};
  const env = { RESEND_API_KEY: "rk", FEEDBACK: kv(store), FEEDBACK_TO: "feedback@cityscroll.org" };
  const body = good(); // no turnstileToken field
  const r = await handleFeedback(post(body, { "CF-Connecting-IP": "203.0.113.10", origin: "https://cityscroll.org" }), env);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
  const fbKeys = Object.keys(store).filter((k) => k.startsWith("fb:"));
  assert.equal(fbKeys.length, 1);
}));

test("stores a Contract report as structured feedback with its target and evidence", async () => {
  const store = {};
  const target = buildContractReportTarget({
    procurement_id: "procurement:contract:CT123",
    canonical_href: "/procurements/procurement%3Acontract%3ACT123",
    short_title: "Street repair contract",
    vendor_name: "Acme Works",
  });
  const previous = globalThis.fetch;
  let notification = null;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("api.resend.com")) {
      notification = JSON.parse(options.body);
      return new Response(JSON.stringify({ id: "mock" }), { status: 200 });
    }
    return previous ? previous(url, options) : new Response("unexpected", { status: 500 });
  };
  try {
    const response = await handleFeedback(post({
      category: "information_wrong",
      message: "The vendor should be checked against the source record.",
      evidence: "Public contract source row",
      email: "",
      report_target: target,
      report: { category: "information_wrong", explanation: "The vendor should be checked against the source record.", evidence: "Public contract source row" },
    }, { "CF-Connecting-IP": "203.0.113.11", origin: "https://cityscroll.org" }), {
      RESEND_API_KEY: "rk",
      FEEDBACK: {
        put: async (key, value) => { store[key] = value; },
      },
    });
    assert.equal(response.status, 200);
    const record = JSON.parse(Object.values(store)[0]);
    assert.equal(record.category, "report");
    assert.equal(record.report_target.target_id, target.target_id);
    assert.equal(record.report_target.canonical_url, target.canonical_url);
    assert.equal(record.evidence, "Public contract source row");
    assert.match(notification.text, /Object ID:\s+procurement:contract:CT123/);
    assert.match(notification.text, /Public contract source row/);
  } finally {
    globalThis.fetch = previous;
  }
});

test("rejects empty / too-short message with 400 bad-message", async () => {
  const r = await handleFeedback(post(good({ message: "" })), configured());
  assert.equal(r.status, 400);
  assert.equal((await r.json()).reason, "bad-message");
});

test("OPTIONS preflight → 204 with CORS for an allowed origin, no config needed", async () => {
  const r = await handleFeedback(
    new Request("https://w/feedback", { method: "OPTIONS", headers: { origin: "http://localhost:8000" } }),
    {},
  );
  assert.equal(r.status, 204);
  assert.equal(r.headers.get("access-control-allow-origin"), "http://localhost:8000");
  assert.equal(r.headers.get("access-control-allow-methods"), "POST, OPTIONS");
});

test("non-POST → 405", async () => {
  const r = await handleFeedback(new Request("https://w/feedback", { method: "GET" }), configured());
  assert.equal(r.status, 405);
});

test("malformed JSON body → 400 bad-json", async () => {
  const r = await handleFeedback(post("{not json"), configured());
  assert.equal(r.status, 400);
  assert.equal((await r.json()).reason, "bad-json");
});

test("invalid fields are rejected (400) before any network call", async () => {
  const r = await handleFeedback(post(good({ category: "nope" })), configured());
  assert.equal(r.status, 400);
  assert.equal((await r.json()).reason, "bad-category");
});

test("rate-limited (429) once the per-IP daily counter is exceeded", async () => {
  const ip = "203.0.113.7";
  const store = {};
  const env = { RESEND_API_KEY: "rk", FEEDBACK: kv(store) };
  for (let i = 0; i < 10; i++) {
    assert.equal(await overActorLimit(env.FEEDBACK, "ip", ip, 10), false);
  }
  const r = await handleFeedback(post(good(), { "CF-Connecting-IP": ip }), env);
  assert.equal(r.status, 429);
  assert.equal((await r.json()).reason, "rate-limited");

  const keys = Object.keys(store);
  assert.equal(keys.length, 1);
  assert.match(keys[0], /^rl:ip:a:[0-9a-f]{64}:\d{4}-\d{2}-\d{2}$/);
  assert.ok(!keys[0].includes(ip));
});
