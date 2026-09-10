import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { processOneSub } from "../src/alerts.mjs";
import { reconcileTemporalCandidates } from "../src/lib/alert_temporal.mjs";

const CORPUS = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "fixtures/money-watch-coverage-current-corpus.json"),
  "utf8",
));

class MockKV {
  constructor() { this.store = new Map(); }
  async get(k) { return this.store.has(k) ? this.store.get(k) : null; }
  async put(k, v) { this.store.set(k, String(v)); }
}

const SUB_KEY = "sub:abcdef0123456789";

function notice(requestId, extra = {}) {
  return {
    request_id: requestId,
    digest_id: requestId,
    start_date: extra.start_date || "2026-09-09T00:00:00.000",
    due_date: extra.due_date || "2026-10-09",
    agency_name: "DDC",
    short_title: extra.short_title || `Solicitation ${requestId}`,
    section_name: "Procurement",
    type_of_notice_description: "Solicitation",
  };
}

function mockFetch(notices) {
  return async (url) => {
    const u = String(url);
    if (u.includes("data.cityofnewyork.us") || u.includes("dg92-zbpx")) {
      return Response.json(notices);
    }
    if (u.includes("api.resend.com")) {
      return Response.json({ id: "email_1" });
    }
    throw new Error("unexpected fetch: " + u);
  };
}

function ctx(today = "2026-09-10") {
  return {
    FROM: "CityScroll <alerts@cityscroll.org>",
    LIVE: true,
    heartbeatDays: 14,
    today,
    isMonday: false,
    counts: () => ({ "per-run": 0, daily: 0 }),
    caps: { "per-run": 25, daily: 50 },
    onSent: async () => {},
  };
}

function subscription() {
  return {
    key: SUB_KEY,
    email: "tester@example.com",
    lens: "money",
    filter: { keywords: ["construction"] },
    freq: "daily",
    channel: "email",
    createdAt: "2026-06-30T00:00:00.000Z",
    lang: "en",
  };
}

test("A3: M candidates of which N are delivered; remaining are offered on the next run", () => {
  const rows = ["a", "b", "c", "d", "e"].map((id) => notice(`20260831${id}`));
  const seen = new Set();
  const first = reconcileTemporalCandidates({
    lens: "money",
    rows,
    seen,
    idField: "digest_id",
  });
  assert.equal(first.fresh.length, 5, "all five candidates are unseen");
  assert.deepEqual(first.markSeenIds, first.fresh.map((row) => row.digest_id));
  const delivered = first.markSeenIds.slice(0, 2);
  delivered.forEach((id) => seen.add(id));
  assert.equal(seen.size, 2);
  const second = reconcileTemporalCandidates({
    lens: "money",
    rows,
    seen,
    idField: "digest_id",
  });
  assert.equal(second.fresh.length, 3);
  assert.deepEqual(
    second.fresh.map((row) => row.digest_id),
    first.markSeenIds.slice(2),
  );
});

test("processOneSub persists only delivered ids so unseen remainder stays available", async () => {
  const delivered = [notice("20260831001"), notice("20260831002")];
  const remainder = [notice("20260831003"), notice("20260831004"), notice("20260831005")];
  const SUBS = new MockKV();
  const ALERT_STATE = new MockKV();
  await SUBS.put(SUB_KEY, JSON.stringify(subscription()));
  const env = {
    SUBS,
    ALERT_STATE,
    ALERTS_LIVE: "true",
    RESEND_API_KEY: "rk",
    TOKEN_SECRET: "s".repeat(32),
  };
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = mockFetch(delivered);
    const first = await processOneSub(env, subscription(), ctx());
    assert.equal(first.sent, true);
    assert.equal(first.new, 2);
    const seenAfterFirst = JSON.parse(await ALERT_STATE.get(`seen:${SUB_KEY}`));
    assert.deepEqual(seenAfterFirst.sort(), ["20260831001", "20260831002"]);

    globalThis.fetch = mockFetch([...delivered, ...remainder]);
    const second = await processOneSub(env, subscription(), ctx("2026-09-11"));
    assert.equal(second.sent, true);
    assert.equal(second.new, 3);
    const seenAfterSecond = JSON.parse(await ALERT_STATE.get(`seen:${SUB_KEY}`));
    assert.deepEqual(
      seenAfterSecond.sort(),
      ["20260831001", "20260831002", "20260831003", "20260831004", "20260831005"],
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("re-send guard: the current seen corpus is not mailed when coverage expands", async () => {
  const corpus = CORPUS.seen_ids;
  const newlyPublished = "20260831025";
  assert.equal(corpus.includes(newlyPublished), false);
  const page = [
    ...corpus.slice(0, 3).map((id) => notice(id, { short_title: `Seen ${id}` })),
    notice(newlyPublished, { start_date: "2026-09-09T00:00:00.000", short_title: "New construction solicitation" }),
  ];
  const SUBS = new MockKV();
  const ALERT_STATE = new MockKV();
  await SUBS.put(SUB_KEY, JSON.stringify(subscription()));
  await ALERT_STATE.put(`seen:${SUB_KEY}`, JSON.stringify(corpus));
  const env = {
    SUBS,
    ALERT_STATE,
    ALERTS_LIVE: "true",
    RESEND_API_KEY: "rk",
    TOKEN_SECRET: "s".repeat(32),
  };
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("data.cityofnewyork.us") || u.includes("dg92-zbpx")) return Response.json(page);
    if (u.includes("api.resend.com")) {
      sent.push(JSON.parse(opts.body));
      return Response.json({ id: "email_1" });
    }
    throw new Error("unexpected fetch: " + u);
  };
  try {
    const result = await processOneSub(env, subscription(), ctx());
    assert.equal(result.sent, true);
    assert.equal(result.new, 1);
    assert.equal(sent.length, 1);
    assert.match(sent[0].html, /20260831025/);
    assert.match(sent[0].html, /New /);
    for (const id of corpus.slice(0, 3)) {
      assert.doesNotMatch(sent[0].html, new RegExp(id));
    }
    const seen = JSON.parse(await ALERT_STATE.get(`seen:${SUB_KEY}`));
    assert.equal(seen.includes(newlyPublished), true);
    assert.equal(seen.length, corpus.length + 1);
    for (const id of corpus) assert.equal(seen.includes(id), true);
  } finally {
    globalThis.fetch = realFetch;
  }
});
