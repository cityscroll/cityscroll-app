import test from "node:test";
import assert from "node:assert/strict";
import { signToken } from "optin-token";

import { handleSubscribe } from "../src/subscribe.mjs";
import { handleConfirm } from "../src/confirm.mjs";

const SECRET = "topicless-tests-token-secret-32bytes-minimum";
const EMAIL = "reader@example.com";

class KV {
  constructor() { this.data = new Map(); }
  async get(key) { return this.data.has(key) ? this.data.get(key) : null; }
  async put(key, value) { this.data.set(key, String(value)); }
  async delete(key) { this.data.delete(key); }
  async list({ prefix = "" } = {}) {
    return {
      keys: [...this.data.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
    };
  }
}

function env() {
  const actionRows = [];
  return {
    TOKEN_SECRET: SECRET,
    RESEND_API_KEY: "resend-key",
    SUBS: new KV(),
    ALERT_STATE: new KV(),
    CONFIRM_BASE: "https://api.cityscroll.org",
    ADMIN_KEY: "admin",
    actionRows,
    DB: {
      prepare() {
        return {
          bind(...values) {
            return { async run() { actionRows.push(values); } };
          },
        };
      },
    },
  };
}

function records(environment) {
  return [...environment.SUBS.data.entries()]
    .filter(([key]) => key.startsWith("sub:"))
    .map(([key, raw]) => ({ key, ...JSON.parse(raw) }));
}

test("topicless signup requires a selected watch and creates no record", async () => {
  const environment = env();
  const response = await handleSubscribe(new Request("https://api.cityscroll.org/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://cityscroll.org" },
    body: JSON.stringify({ email: EMAIL, no_topic: true, source: "top-of-site" }),
  }), environment);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { ok: false, reason: "topic-required" });
  assert.deepEqual(records(environment), []);
  assert.deepEqual(environment.actionRows, []);
});

test("legacy confirmation links are idempotent after immediate enrollment", async () => {
  const environment = env();
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ id: "welcome" }), { status: 200 });
  };
  try {
    await handleSubscribe(new Request("https://api.cityscroll.org/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://cityscroll.org" },
      body: JSON.stringify({ email: EMAIL, lens: "rules", filter: { keywords: ["housing"] }, freq: "daily" }),
    }), environment);
  } finally {
    globalThis.fetch = realFetch;
  }
  const [before] = records(environment);
  const token = await signToken(SECRET, {
    e: EMAIL, l: "rules", f: before.filter, c: "email", q: "daily", lng: "en",
  }, { ttlSeconds: 3600 });
  const response = await handleConfirm(new Request(
    `https://api.cityscroll.org/confirm?token=${encodeURIComponent(token)}`,
  ), environment);
  assert.equal(response.status, 200);
  const after = records(environment);
  assert.equal(after.length, 1);
  assert.equal(after[0].key, before.key);
  assert.equal(after[0].createdAt, before.createdAt);
  assert.match(await response.text(), /watch.*active/i);
});
