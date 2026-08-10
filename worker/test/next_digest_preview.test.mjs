import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import worker from "../src/worker.mjs";
import { handleAdminNextDigestPreview } from "../src/admin.mjs";
import { processOneSub } from "../src/alerts.mjs";

const migration = readFileSync(new URL("../migrations/0018_digest_outbox.sql", import.meta.url), "utf8");
const NOW = new Date("2026-08-10T12:00:00.000Z");
const SUBSCRIBER_ID = "subscriber:test";
const WATCH_ID = "watch:sub:one";

function d1(sqlite, writes) {
  return {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return {
        bind(...params) {
          return {
            all: async () => ({ results: statement.all(...params) }),
            first: async () => statement.get(...params) || null,
            run: async () => {
              writes.push(sql);
              const result = statement.run(...params);
              return { meta: { changes: Number(result.changes || 0) } };
            },
          };
        },
        all: async () => ({ results: statement.all() }),
        first: async () => statement.get() || null,
        run: async () => {
          writes.push(sql);
          const result = statement.run();
          return { meta: { changes: Number(result.changes || 0) } };
        },
      };
    },
    async batch(statements) {
      writes.push("BATCH");
      return statements.map((statement) => statement.run());
    },
  };
}

function kv(values = {}, writes = []) {
  return {
    values: new Map(Object.entries(values)),
    async get(key) { return this.values.get(key) || null; },
    async put(key, value) { writes.push(key); this.values.set(key, String(value)); },
    async delete(key) { writes.push(key); this.values.delete(key); },
    async list({ prefix = "" } = {}) {
      return {
        keys: [...this.values.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((name) => ({ name })),
        list_complete: true,
      };
    },
  };
}

function makeEnv({ owed = true } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(migration);
  if (owed) {
    sqlite.prepare(`INSERT INTO digest_outbox_items
      (watch_id, subscriber_id, item_id, lens, item_kind, payload_json, source_observed_at, first_owed_at, owed_origin)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(WATCH_ID, SUBSCRIBER_ID, "land:OWED-1", "land", "rezone",
        JSON.stringify({ project_id: "OWED-1", project_name: "Owed harbor project", public_status: "In review" }),
        "2026-08-09T11:00:00Z", "2026-08-09T12:00:00Z", "test");
  }
  const subWrites = [];
  const alertWrites = [];
  const dbWrites = [];
  const subscription = {
    email: "person@example.com",
    lens: "land",
    filter: { status: "all" },
    freq: "daily",
    lang: "en",
    subscriber_id: SUBSCRIBER_ID,
    watch_id: WATCH_ID,
    createdAt: "2026-08-01T00:00:00.000Z",
  };
  const env = {
    ADMIN_KEY: "secret",
    DB: d1(sqlite, dbWrites),
    SUBS: kv({ "sub:one": JSON.stringify(subscription) }, subWrites),
    ALERT_STATE: kv({}, alertWrites),
    CONFIRM_BASE: "https://api.cityscroll.org",
    ALERTS_FROM: "CityScroll <alerts@cityscroll.org>",
  };
  return { env, sqlite, subscription, subWrites, alertWrites, dbWrites };
}

test("next digest preview shares the drain renderer and does not send or mutate state", async () => {
  const fixture = makeEnv();
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("api.resend.com/emails")) {
      providerCalls += 1;
      throw new Error("preview must not call provider");
    }
    return { ok: true, json: async () => [] };
  };
  try {
    const response = await handleAdminNextDigestPreview(
      new Request("https://w/admin/next-digest-preview?key=secret&subscriber=subscriber%3Atest"),
      fixture.env,
      { now: NOW },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.next_scheduled_at, "2026-08-10T13:00:00.000Z");
    assert.equal(body.subscriber_label, "pe***@example.com");
    assert.equal(body.owed_item_count, 1);
    assert.equal(body.empty, false);
    assert.match(body.digest_html, /Owed harbor project/);
    assert.match(body.digest_text, /Owed harbor project/);
    assert.equal(providerCalls, 0);
    assert.deepEqual(fixture.subWrites, []);
    assert.deepEqual(fixture.alertWrites, []);
    assert.deepEqual(fixture.dbWrites, []);
    assert.equal(fixture.sqlite.prepare("SELECT status FROM digest_outbox_items").get().status, "owed");
    assert.equal(fixture.sqlite.prepare("SELECT COUNT(*) AS n FROM digest_outbox_deliveries").get().n, 0);

    const direct = await processOneSub(fixture.env, fixture.subscription, {
      FROM: fixture.env.ALERTS_FROM,
      LIVE: false,
      previewOnly: true,
      capturePreviews: true,
      advanceState: false,
      today: "2026-08-10",
      now: NOW,
      nowMs: NOW.getTime(),
      isMonday: true,
      heartbeatDays: 14,
      counts: () => ({ "per-run": 0, daily: 0 }),
      caps: { "per-run": 9999, daily: 9999 },
      onSent: async () => {},
    });
    assert.equal(body.subject, direct.preview.subject);
    assert.equal(body.digest_html, direct.preview.html);
  } finally {
    globalThis.fetch = originalFetch;
    fixture.sqlite.close();
  }
});

test("next digest preview fails closed, supports the redacted label, and has an empty state", async () => {
  const fixture = makeEnv({ owed: false });
  assert.equal((await handleAdminNextDigestPreview(new Request("https://w/admin/next-digest-preview"), fixture.env)).status, 401);
  assert.equal((await handleAdminNextDigestPreview(new Request("https://w/admin/next-digest-preview?key=secret", { method: "POST" }), fixture.env)).status, 405);

  const index = await handleAdminNextDigestPreview(
    new Request("https://w/admin/next-digest-preview?key=secret"), fixture.env,
  );
  assert.equal(index.status, 200);
  const indexBody = await index.json();
  assert.equal(indexBody.subscribers.length, 1);
  assert.match(indexBody.subscribers[0].preview_url, /subscriber=subscriber%3Atest/);
  assert.doesNotMatch(JSON.stringify(indexBody), /person@example\.com/);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => [] });
  try {
    const empty = await handleAdminNextDigestPreview(
      new Request("https://w/admin/next-digest-preview?key=secret&subscriber=pe%2A%2A%2A%40example.com"),
      fixture.env,
      { now: NOW },
    );
    assert.equal(empty.status, 200);
    const body = await empty.json();
    assert.equal(body.empty, true);
    assert.equal(body.digest_html, null);
    assert.equal(body.digest_text, null);
    assert.equal(body.owed_item_count, 0);

    const emptyHtml = await handleAdminNextDigestPreview(
      new Request("https://w/admin/next-digest-preview?key=secret&subscriber=pe%2A%2A%2A%40example.com&view=html"),
      fixture.env,
      { now: NOW },
    );
    assert.equal(emptyHtml.status, 200);
    assert.match(await emptyHtml.text(), /No owed delivery items/);
  } finally {
    globalThis.fetch = originalFetch;
    fixture.sqlite.close();
  }
});

test("worker registers the next digest preview route and stats links to its index", async () => {
  const fixture = makeEnv({ owed: false });
  const response = await worker.fetch(
    new Request("https://w/admin/next-digest-preview?key=secret"),
    fixture.env,
    {},
  );
  assert.equal(response.status, 200);
  const stats = await worker.fetch(
    new Request("https://w/admin/stats?key=secret&view=html"),
    fixture.env,
    {},
  );
  assert.equal(stats.status, 200);
  assert.match(await stats.text(), /href="\/admin\/next-digest-preview\?key=secret"/);
  fixture.sqlite.close();
});
