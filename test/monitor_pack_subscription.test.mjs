import assert from "node:assert/strict";
import test from "node:test";

import {
  monitorPackChildren,
  monitorPackSubscribePayload,
  normalizeFilter,
} from "../site/watch_templates.mjs";
import { buildMonitorPackView, renderComposedObjectDocument } from "../site/composed_object_documents.mjs";
import { handleMonitorPackSubscribe } from "../worker/src/monitor_packs.mjs";
import { buildSubscription, subscriptionKey } from "../worker/src/lib/subscriptions.mjs";

function kv() {
  const values = new Map();
  return {
    async get(key) { return values.get(key) ?? null; },
    async put(key, value) { values.set(key, value); },
    async delete(key) { values.delete(key); },
    async list() { return { keys: [], list_complete: true }; },
    values,
  };
}

function env(store) {
  return {
    TOKEN_SECRET: "test-secret", RESEND_API_KEY: "test-key", SUBS: store,
    async enrollAndWelcome(_env, candidate) {
      const key = await subscriptionKey(buildSubscription(candidate));
      await store.put(key, JSON.stringify(candidate));
      return { key, record: candidate, created: true };
    },
  };
}

const PACK = {
  id: "housing-watch-set",
  title: "Shelter tracking",
  watches: [
    {
      label: "Money contract",
      lens: "money",
      filter: {
        procurement_id: "procurement:contract:CT107120258801626",
        noticeType: "award",
        text_query: { version: 1, all: [[{ kind: "term", value: "shelter" }]] },
        subject_refs_all: ["exam:1234"],
        entity_refs_all: ["pin:07124E0044001"],
      },
    },
    {
      label: "Meetings at Brooklyn CB15",
      lens: "meetings",
      filter: {
        communityBoard: "community-board:brooklyn-cb-15",
        text_query: { version: 1, all: [[{ kind: "term", value: "shelter" }]] },
        subject_refs_all: ["exam:1234"],
        entity_refs_all: ["bbl:3088150590"],
      },
    },
  ],
};

test("pack payload preserves every supported child filter and lens", () => {
  const payload = monitorPackSubscribePayload(PACK, { email: "reader@example.com" });
  assert.equal(payload.children.length, 2);
  assert.deepEqual(payload.children.map(({ label, lens, filter }) => ({ label, lens, filter })), [
    {
      label: "Money contract",
      lens: "money",
      filter: {
        procurement_id: "procurement:contract:CT107120258801626",
        noticeType: "award",
        text_query: { version: 1, all: [[{ kind: "term", value: "shelter" }]] },
        subject_refs_all: ["exam:1234"],
        entity_refs_all: ["pin:07124E0044001"],
      },
    },
    {
      label: "Meetings at Brooklyn CB15",
      lens: "meetings",
      filter: {
        communityBoard: "community-board:brooklyn-cb-15",
        text_query: { version: 1, all: [[{ kind: "term", value: "shelter" }]] },
        subject_refs_all: ["exam:1234"],
        entity_refs_all: ["bbl:3088150590"],
      },
    },
  ]);
});

test("pack confirmation names every child before the single approved action", () => {
  const view = buildMonitorPackView({ templates: [PACK] }, PACK.id);
  const html = renderComposedObjectDocument(view);
  assert.match(html, /Watch this pack/);
  assert.match(html, /Money contract/);
  assert.match(html, /Meetings at Brooklyn CB15/);
  assert.match(html, /name="freq" value="weekly"/);
  assert.match(html, /action="https:\/\/api\.cityscroll\.org\/subscribe-pack"/);
  assert.doesNotMatch(html, /action="https:\/\/api\.cityscroll\.org\/subscribe"/);
});

test("one pack action creates all children and replay is idempotent", async () => {
  const store = kv();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("{}", { status: 200 });
  try {
    const body = monitorPackSubscribePayload(PACK, { email: "reader@example.com" });
    const request = () => new Request("https://api.cityscroll.org/subscribe-pack", {
      method: "POST", headers: { origin: "https://cityscroll.org", "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const first = await handleMonitorPackSubscribe(request(), env(store));
    const firstBody = await first.json();
    assert.equal(first.status, 200, JSON.stringify(firstBody));
    assert.equal(firstBody.created, 2);
    assert.deepEqual(firstBody.missing_children, []);
    const second = await handleMonitorPackSubscribe(request(), env(store));
    const secondBody = await second.json();
    assert.equal(second.status, 200);
    assert.equal(secondBody.created, 0);
    assert.equal(secondBody.receipt.children.filter((child) => child.status === "created").length, 2);
    assert.equal([...store.values.keys()].filter((key) => key.startsWith("sub:")).length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("invalid mixed child is rejected instead of discarded", async () => {
  const store = kv();
  const body = monitorPackSubscribePayload(PACK, { email: "reader@example.com" });
  body.children[1].filter = { communityBoard: "not-a-board", text_query: { all: ["shelter"] } };
  const response = await handleMonitorPackSubscribe(new Request("https://api.cityscroll.org/subscribe-pack", {
    method: "POST", headers: { origin: "https://cityscroll.org", "content-type": "application/json" }, body: JSON.stringify(body),
  }), env(store));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).reason, "invalid-child");
  assert.equal(store.values.size, 0);
});

test("partial failure records progress and retry creates only the missing child", async () => {
  const store = kv();
  let subWrites = 0;
  store.failSecondChild = true;
  const originalPut = store.put;
  store.put = async (key, value) => {
    if (store.failSecondChild && key.startsWith("sub:") && ++subWrites === 2) {
      throw Object.assign(new Error("injected child write failure"), { code: "save-failed" });
    }
    return originalPut(key, value);
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("{}", { status: 200 });
  try {
    const body = monitorPackSubscribePayload(PACK, { email: "reader@example.com" });
    const request = () => new Request("https://api.cityscroll.org/subscribe-pack", {
      method: "POST", headers: { origin: "https://cityscroll.org", "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const failed = await handleMonitorPackSubscribe(request(), env(store));
    const failedBody = await failed.json();
    assert.equal(failed.status, 502);
    assert.deepEqual(failedBody.missing_children, [1]);
    store.failSecondChild = false;
    const retried = await handleMonitorPackSubscribe(request(), env(store));
    const retriedBody = await retried.json();
    assert.equal(retried.status, 200);
    assert.equal(retriedBody.created, 1);
    assert.deepEqual(retriedBody.missing_children, []);
    assert.equal([...store.values.keys()].filter((key) => key.startsWith("sub:")).length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("normalization retains the supported pack identity fields", () => {
  assert.deepEqual(normalizeFilter(PACK.watches[0].filter), PACK.watches[0].filter);
  assert.equal(monitorPackChildren(PACK).length, 2);
});
