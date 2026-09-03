// Homepage CTA + explicit Following signup both enroll immediately under single opt-in.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handleSubscribe } from "../src/subscribe.mjs";

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

async function post(environment, { body, contentType, accept }, sent) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("api.resend.com")) {
      sent.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ id: "msg_test" }), { status: 200 });
    }
    throw new Error("unexpected fetch: " + url);
  };
  const headers = {
    "Content-Type": contentType,
    Origin: "https://cityscroll.org",
    "CF-Connecting-IP": "198.51.100.10",
  };
  if (accept) headers.Accept = accept;
  try {
    return await handleSubscribe(new Request("https://api.cityscroll.org/subscribe", {
      method: "POST",
      headers,
      body,
    }), environment);
  } finally {
    globalThis.fetch = realFetch;
  }
}

function submit(environment, body, sent) {
  return post(environment, { body: JSON.stringify(body), contentType: "application/json" }, sent);
}

// The homepage box is a real <form method="post" action=".../subscribe">, so with JavaScript
// off the browser sends the fields url-encoded and renders whatever HTML comes back. That
// navigation is the only confirmation a no-JS reader ever sees.
function submitForm(environment, fields, sent) {
  return post(environment, {
    body: new URLSearchParams(fields).toString(),
    contentType: "application/x-www-form-urlencoded",
    accept: "text/html,application/xhtml+xml",
  }, sent);
}

test("the homepage form posts the exact allowlisted intent the worker accepts", () => {
  const homepage = readFileSync(new URL("../../site/index.html", import.meta.url), "utf8");
  assert.match(homepage, /id="homeCtaTopics"[^>]*href="\/following\/\?onboarding=1"|href="\/following\/\?onboarding=1"[^>]*id="homeCtaTopics"/);
  assert.match(homepage, /id="homeCtaForm"[^>]*method="post"[^>]*action="https:\/\/api\.cityscroll\.org\/subscribe"/);
  assert.match(homepage, /id="homeCtaEmail"[^>]*name="email"/);
  assert.match(homepage, /id="homeCtaSubmit"/);
  assert.match(homepage, /name="no_topic" value="true"/);
  assert.match(homepage, /name="source" value="top-of-site"/);
});

test("topicless submit without the disclosed homepage source is rejected without creating a watch", async () => {
  const environment = configured();
  const sent = [];
  const response = await submit(environment, {
    email: "Reader@Example.com",
    no_topic: true,
    source: "some-other-caller",
    lang: "en",
  }, sent);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { ok: false, reason: "bad-intent" });
  assert.equal([...environment.SUBS.store.keys()].filter((key) => key.startsWith("sub:")).length, 0);
  assert.equal(sent.length, 0);
});

test("topicless submit with no source at all is rejected without creating a watch", async () => {
  const environment = configured();
  const sent = [];
  const response = await submit(environment, { email: "reader@example.com", no_topic: true }, sent);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { ok: false, reason: "bad-intent" });
  assert.equal([...environment.SUBS.store.keys()].filter((key) => key.startsWith("sub:")).length, 0);
  assert.equal(sent.length, 0);
});

test("the exact disclosed homepage-default intent creates one weekly Contracts watch", async () => {
  const environment = configured();
  const sent = [];
  const response = await submit(environment, {
    email: "Reader@Example.com",
    no_topic: true,
    source: "top-of-site",
    lang: "en",
  }, sent);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.created, true);
  assert.equal(body.no_topic, true);
  assert.deepEqual(body.watch, {
    watch_id: body.watch.watch_id,
    lens: "money",
    filter: {},
    freq: "weekly",
    label: body.watch.label,
    followingUrl: "/following/",
  });
  assert.match(body.watch.watch_id, /^watch:/);
  // The safe projection never exposes the address, KV key, or preference/unsubscribe credentials.
  assert.doesNotMatch(JSON.stringify(body), /reader@example\.com/i);
  assert.doesNotMatch(JSON.stringify(body), /token/i);

  const subKeys = [...environment.SUBS.store.keys()].filter((key) => key.startsWith("sub:"));
  assert.equal(subKeys.length, 1);
  assert.equal(sent.length, 1);
});

test("the no-JavaScript form post confirms the weekly Contracts subscription in HTML", async () => {
  const environment = configured();
  const sent = [];
  const response = await submitForm(environment, {
    no_topic: "true",
    source: "top-of-site",
    lang: "en",
    email: "Reader@Example.com",
  }, sent);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/html/);
  const html = await response.text();
  assert.match(html, /You're subscribed/);
  assert.match(html, /weekly NYC contracts digest/);
  assert.match(html, /href="https:\/\/cityscroll\.org\/following\/"/);
  // The confirmation page is served to an anonymous browser: it may not leak the address,
  // the KV key, or a manage/unsubscribe credential into a bookmarkable URL.
  assert.doesNotMatch(html, /reader@example\.com/i);
  assert.doesNotMatch(html, /token/i);

  const subKeys = [...environment.SUBS.store.keys()].filter((key) => key.startsWith("sub:"));
  assert.equal(subKeys.length, 1, "the no-JS path stores exactly one default watch");
  const record = JSON.parse(await environment.SUBS.get(subKeys[0]));
  assert.equal(record.lens, "money");
  assert.equal(record.freq, "weekly");
  assert.equal(sent.length, 1);
});

test("the no-JavaScript path still rejects a topicless post from another source", async () => {
  const environment = configured();
  const sent = [];
  const response = await submitForm(environment, {
    no_topic: "true",
    source: "some-other-caller",
    email: "reader@example.com",
  }, sent);
  assert.equal(response.status, 400);
  const html = await response.text();
  assert.match(html, /That signup source is not recognized/);
  assert.doesNotMatch(html, /weekly NYC contracts digest/);
  assert.equal([...environment.SUBS.store.keys()].filter((key) => key.startsWith("sub:")).length, 0);
  assert.equal(sent.length, 0);
});

test("a no-JavaScript reader whose welcome email fails is told the subscription is still active", async () => {
  const environment = configured();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("api.resend.com")) return new Response("upstream down", { status: 500 });
    throw new Error("unexpected fetch: " + url);
  };
  let response;
  try {
    response = await handleSubscribe(new Request("https://api.cityscroll.org/subscribe", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://cityscroll.org",
        "CF-Connecting-IP": "198.51.100.10",
      },
      body: new URLSearchParams({ no_topic: "true", source: "top-of-site", email: "reader@example.com" }).toString(),
    }), environment);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(response.status, 502);
  const html = await response.text();
  assert.match(html, /You're subscribed/);
  assert.match(html, /welcome email could not be sent/);
  assert.equal(
    [...environment.SUBS.store.keys()].filter((key) => key.startsWith("sub:")).length,
    1,
    "the watch is stored even when the welcome send fails, which is what the copy claims",
  );
});

test("repeated homepage-default submission for the same address reuses the stable key with no duplicate", async () => {
  const environment = configured();
  const first = await submit(environment, { email: "reader@example.com", no_topic: true, source: "top-of-site" }, []);
  const firstBody = await first.json();
  assert.equal(firstBody.created, true);

  const second = await submit(environment, { email: "Reader@Example.com", no_topic: true, source: "top-of-site" }, []);
  const secondBody = await second.json();
  assert.equal(second.status, 200);
  assert.equal(secondBody.created, false);
  assert.equal(secondBody.watch.watch_id, firstBody.watch.watch_id);

  const subKeys = [...environment.SUBS.store.keys()].filter((key) => key.startsWith("sub:"));
  assert.equal(subKeys.length, 1, "the normalized address maps to exactly one stored default watch");
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

test("e2e plus-tag explicit watches are marked test and stay out of real subscriber delivery", async () => {
  const environment = configured();
  const sent = [];
  const response = await submit(environment, {
    email: "jamesca2ro+scope-watch-e2e-20260806@gmail.com",
    lens: "rules",
    filter: { keywords: ["e2e"] },
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
