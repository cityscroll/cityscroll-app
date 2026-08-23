import test from "node:test";
import assert from "node:assert/strict";
import { signToken } from "optin-token";

import { handleSubscribe } from "../src/subscribe.mjs";
import { handleConfirm } from "../src/confirm.mjs";
import { handlePrefs } from "../src/prefs.mjs";
import { handleAdminSubs } from "../src/admin.mjs";
import { compileSub } from "../src/lib/compile.mjs";
import { WATCHLOG_LATEST_KEY } from "../src/lib/watchlog.mjs";

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

async function requestTopicless(environment) {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ id: "welcome" }), { status: 200 });
  };
  try {
    const response = await handleSubscribe(new Request("https://api.cityscroll.org/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://cityscroll.org" },
      body: JSON.stringify({ email: EMAIL, no_topic: true, source: "top-of-site" }),
    }), environment);
    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = realFetch;
  }
  return sent[0];
}

test("admin and ops expose the immediate topicless-default enrollment", async () => {
  const environment = env();
  await requestTopicless(environment);
  const [record] = records(environment);
  assert.equal(record.state, "confirmed");
  const compiled = compileSub(record, "2026-08-18");
  assert.ok(compiled, "the marked default reaches the normal digest compiler");
  assert.match(compiled.url, /dg92-zbpx/);

  const response = await handleAdminSubs(
    new Request("https://api.cityscroll.org/admin/subs?key=admin"),
    environment,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.topiclessIntentCount, 1);
  assert.deepEqual(body.topiclessIntents, [{
    email: "reader@example.com",
    status: "confirmed",
    source: "top-of-site",
    createdAt: record.createdAt,
    intentState: "confirmed",
  }]);
  assert.equal(body.subs[0].status, "confirmed");
  assert.equal(body.subs[0].lens, "money");
  assert.equal(body.subs[0].freq, "weekly");

  const ops = JSON.parse(await environment.ALERT_STATE.get(WATCHLOG_LATEST_KEY));
  assert.equal(ops.length, 1);
  assert.deepEqual({
    action: ops[0].action,
    source: ops[0].source,
    lens: ops[0].lens,
    label: ops[0].label,
    freq: ops[0].freq,
  }, {
    action: "subscribe",
    source: "top-of-site",
    lens: "money",
    label: "Contracts and RFPs — all notices",
    freq: "weekly",
  });
  assert.equal(environment.actionRows.length, 1);
  assert.equal(environment.actionRows[0][2], "watch_confirmed");
  assert.equal(environment.actionRows[0][6], "single_opt_in");
  assert.deepEqual(JSON.parse(environment.actionRows[0][8]), {
    lens: "money",
    source: "top-of-site",
    freq: "weekly",
  });
});

test("welcome manage link opens the normal weekly contracts watch and can delete it", async () => {
  const environment = env();
  const welcome = await requestTopicless(environment);
  const manageUrl = welcome.html.match(/href="(https:\/\/cityscroll\.org\/prefs\?token=[^"]+)"/)?.[1]?.replaceAll("&amp;", "&");
  assert.ok(manageUrl);
  const [record] = records(environment);

  const prefs = await handlePrefs(new Request(manageUrl), environment);
  const prefsHtml = await prefs.text();
  assert.match(prefsHtml, /Contracts and RFPs — all notices/);
  assert.match(prefsHtml, /weekly/);
  assert.doesNotMatch(prefsHtml, /choose a topic before|no civic digest/i);

  const token = new URL(manageUrl).searchParams.get("token");
  const deleted = await handlePrefs(new Request("https://cityscroll.org/prefs", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ token, key: record.key, action: "delete" }),
  }), environment);
  assert.equal(deleted.status, 200);
  assert.equal(records(environment).length, 0);
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
