// Homepage CTA + explicit Following signup both enroll immediately under single opt-in.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verifyToken } from "optin-token";
import { handleSubscribe } from "../src/subscribe.mjs";
import { handleUnsubscribe } from "../src/unsubscribe.mjs";

class MockKV {
  constructor() { this.store = new Map(); }
  async get(k) { return this.store.has(k) ? this.store.get(k) : null; }
  async put(k, v) { this.store.set(k, String(v)); }
  async delete(k) { this.store.delete(k); }
  async list({ prefix = "" } = {}) {
    return {
      keys: [...this.store.keys()].filter((name) => name.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
    };
  }
}

function configured() {
  return {
    TOKEN_SECRET: "tok-secret-for-tests-32bytes-min!!",
    RESEND_API_KEY: "rk",
    SUBS: new MockKV(),
    ALERT_STATE: new MockKV(),
    CONFIRM_BASE: "https://api.cityscroll.org",
    ALERTS_FROM: "CityScroll <alerts@cityscroll.org>",
  };
}

async function submit(environment, body, sent) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("api.resend.com")) {
      sent.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ id: "msg_test" }), { status: 200 });
    }
    throw new Error("unexpected fetch: " + url);
  };
  try {
    return await handleSubscribe(new Request("https://api.cityscroll.org/subscribe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://cityscroll.org",
        "CF-Connecting-IP": "198.51.100.10",
      },
      body: JSON.stringify(body),
    }), environment);
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("homepage CTA sends an explicit topicless source marker", () => {
  for (const path of ["../../site/home_entry.mjs", "../../site/app/boot.mjs", "../../site/app/alerts.mjs"]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(source, /no_topic:\s*true/, path);
    assert.match(source, /source:\s*["']top-of-site["']/, path);
  }
});

test("topicless submit immediately creates the disclosed weekly NYC-contracts default", async () => {
  const environment = configured();
  const sent = [];
  const response = await submit(environment, {
    email: "Reader@Example.com",
    no_topic: true,
    source: "top-of-site",
    lang: "en",
  }, sent);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);

  const subKeys = [...environment.SUBS.store.keys()].filter((key) => key.startsWith("sub:"));
  assert.equal(subKeys.length, 1);
  const record = JSON.parse(await environment.SUBS.get(subKeys[0]));
  assert.deepEqual({
    email: record.email,
    no_topic: record.no_topic,
    no_topic_default: record.no_topic_default,
    source: record.source,
    state: record.state,
    lens: record.lens,
    filter: record.filter,
    freq: record.freq,
  }, {
    email: "reader@example.com",
    no_topic: true,
    no_topic_default: true,
    source: "top-of-site",
    state: "confirmed",
    lens: "money",
    filter: {},
    freq: "weekly",
  });
  assert.ok(Number.isFinite(Date.parse(record.createdAt)));
  assert.match(record.subscriber_id, /^subscriber:/);
  assert.match(record.watch_id, /^watch:/);

  assert.equal(sent.length, 1);
  const welcome = sent[0];
  assert.match(welcome.subject, /subscribed/i);
  assert.match(welcome.html, /weekly NYC contracts digest/i);
  assert.match(welcome.html, /solicitations, awards, and other procurement notices/i);
  assert.match(welcome.html, /Manage subscription/i);
  assert.match(welcome.html, /Unsubscribe/i);
  assert.match(welcome.headers["List-Unsubscribe"], /^<https:\/\/api\.cityscroll\.org\/unsubscribe\?token=/);
  assert.equal(welcome.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");

  const unsubUrl = welcome.headers["List-Unsubscribe"].slice(1, -1);
  const verified = await verifyToken(environment.TOKEN_SECRET, new URL(unsubUrl).searchParams.get("token"));
  assert.equal(verified.valid, true);
  assert.deepEqual(verified.payload.k, subKeys[0]);
  const removed = await handleUnsubscribe(new Request(unsubUrl, { method: "POST" }), environment);
  assert.equal(removed.status, 200);
  assert.equal(await environment.SUBS.get(subKeys[0]), null);
});

test("explicit watch submit is also enrolled immediately with its exact scope", async () => {
  const environment = configured();
  const sent = [];
  const response = await submit(environment, {
    email: "reader@example.com",
    lens: "rules",
    filter: { keywords: ["housing"], borough: "Brooklyn" },
    freq: "daily",
    lang: "en",
  }, sent);
  assert.equal(response.status, 200);
  const subKeys = [...environment.SUBS.store.keys()].filter((key) => key.startsWith("sub:"));
  assert.equal(subKeys.length, 1);
  const record = JSON.parse(await environment.SUBS.get(subKeys[0]));
  assert.equal(record.lens, "rules");
  assert.deepEqual(record.filter, { keywords: ["housing"], agency: null, process: null });
  assert.equal(record.freq, "daily");
  assert.equal(record.no_topic, undefined);
  assert.equal(record.source, undefined, "ordinary explicit SUBS records keep their legacy byte shape");
  assert.match(sent[0].html, /Rules — about “housing” \(daily\)/);
  assert.doesNotMatch(sent[0].html, /weekly NYC contracts digest/i);
});

test("signup rate limits still stop the sixth request for one address", async () => {
  const environment = configured();
  for (let i = 0; i < 5; i++) {
    const response = await submit(environment, {
      email: "reader@example.com",
      lens: "rules",
      filter: { keywords: [`housing-${i}`] },
    }, []);
    assert.equal(response.status, 200);
  }
  const limited = await submit(environment, {
    email: "reader@example.com",
    lens: "rules",
    filter: { keywords: ["sixth"] },
  }, []);
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).reason, "rate-limited");
});

test("e2e plus-tag signups are marked test and stay out of real subscriber delivery", async () => {
  const environment = configured();
  const sent = [];
  const response = await submit(environment, {
    email: "jamesca2ro+scope-watch-e2e-20260806@gmail.com",
    no_topic: true,
    source: "top-of-site",
  }, sent);
  assert.equal(response.status, 200);
  const subKeys = [...environment.SUBS.store.keys()].filter((key) => key.startsWith("sub:"));
  assert.equal(subKeys.length, 1);
  const record = JSON.parse(await environment.SUBS.get(subKeys[0]));
  assert.equal(record.developer_test, true);
  assert.equal(record.signup_lifecycle, "test");
  assert.equal(record.status, "test");
  assert.equal(sent.length, 1, "welcome still discloses the watch; real digests stay skipped");
});
