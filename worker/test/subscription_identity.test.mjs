import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { signToken } from "optin-token";

import { handlePrefs } from "../src/prefs.mjs";
import {
  deriveSubscriberId,
  deriveWatchId,
  ensureSubscriptionIdentity,
  subCanonical,
} from "../src/lib/subscriptions.mjs";

const migration = readFileSync(new URL("../migrations/0018_digest_outbox.sql", import.meta.url), "utf8");
const SECRET = "test-secret-0123456789abcdef0123456789abcdef";

class MockKV {
  constructor(values = {}) { this.store = new Map(Object.entries(values)); }
  async get(key) { return this.store.has(key) ? this.store.get(key) : null; }
  async put(key, value) { this.store.set(key, String(value)); }
  async delete(key) { this.store.delete(key); }
  async list({ prefix = "" } = {}) {
    return { keys: [...this.store.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
  }
}

test("outbox migration is rerunnable and enforces immutable identities plus delivery state", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(migration);
  db.exec(migration);

  db.prepare(`INSERT INTO digest_outbox_items
    (watch_id, subscriber_id, item_id, lens, item_kind, payload_json, source_observed_at, first_owed_at, owed_origin)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "watch:w1", "subscriber:s1", "item:1", "rules", "notice", "{}",
    "2026-08-10T12:00:00Z", "2026-08-10T12:00:01Z", "test",
  );
  assert.throws(() => db.prepare(`INSERT INTO digest_outbox_items
    (watch_id, subscriber_id, item_id, lens, item_kind, payload_json, source_observed_at, first_owed_at, owed_origin)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "watch:w1", "subscriber:s1", "item:1", "rules", "notice", "{}",
    "2026-08-10T12:00:00Z", "2026-08-10T12:00:01Z", "repeat",
  ), /UNIQUE|constraint/i);
  assert.throws(() => db.prepare(`INSERT INTO digest_outbox_items
    (watch_id, subscriber_id, item_id, lens, item_kind, payload_json, source_observed_at, first_owed_at, owed_origin, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "watch:w2", "subscriber:s1", "item:2", "rules", "notice", "{}",
    "2026-08-10T12:00:00Z", "2026-08-10T12:00:01Z", "test", "delivered",
  ), /CHECK|constraint/i);
  db.prepare(`INSERT INTO digest_outbox_items
    (watch_id, subscriber_id, item_id, lens, item_kind, payload_json, source_observed_at, first_owed_at, owed_origin, status, delivered_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "watch:w2", "subscriber:s1", "item:2", "rules", "notice", "{}",
    "2026-08-10T12:00:00Z", "2026-08-10T12:00:01Z", "test", "delivered", "2026-08-10T13:00:00Z",
  );
  db.prepare(`INSERT INTO digest_outbox_deliveries
    (subscriber_id, scheduled_day, delivery_id, status, reserved_at)
    VALUES (?, ?, ?, ?, ?)`).run("subscriber:s1", "2026-08-10", "delivery:1", "reserved", "2026-08-10T13:00:00Z");
  assert.throws(() => db.prepare(`INSERT INTO digest_outbox_deliveries
    (subscriber_id, scheduled_day, delivery_id, status, reserved_at)
    VALUES (?, ?, ?, ?, ?)`).run("subscriber:s1", "2026-08-10", "delivery:2", "reserved", "2026-08-10T13:00:01Z"), /UNIQUE|constraint/i);
  db.close();
});

test("identity derivation is stable, account-scoped, and independent of mutable filter contents", async () => {
  const subscriber = await deriveSubscriberId(" Person@Example.com ");
  assert.equal(subscriber, await deriveSubscriberId("person@example.com"));
  assert.notEqual(subscriber, await deriveSubscriberId("other@example.com"));

  const legacyKey = "sub:0123456789abcdef";
  assert.notEqual(await deriveWatchId(legacyKey), await deriveWatchId("sub:fedcba9876543210"));
  const first = await ensureSubscriptionIdentity({
    email: "person@example.com", lens: "rules", filter: { keywords: ["housing"] },
  }, legacyKey);
  const edited = await ensureSubscriptionIdentity({
    ...first.record, filter: { keywords: ["schools"] },
  }, legacyKey);
  assert.equal(first.record.watch_id, await deriveWatchId(legacyKey));
  assert.equal(edited.record.watch_id, first.record.watch_id);
  assert.equal(edited.record.subscriber_id, first.record.subscriber_id);
});

test("legacy /prefs filter edit preserves the outbox watch identity and KV address", async () => {
  const key = "sub:legacy-watch-01";
  const legacy = {
    email: "person@example.com", lens: "rules", filter: { keywords: ["housing"] },
    freq: "daily", channel: "email", createdAt: "2026-08-01T00:00:00.000Z", lang: "en",
  };
  const subs = new MockKV({ [key]: JSON.stringify(legacy) });
  const token = await signToken(SECRET, { sc: "prefs", e: legacy.email }, { ttlSeconds: 3600 });
  const body = new URLSearchParams({
    token, action: "update", key, keywords: "schools",
  });
  const response = await handlePrefs(new Request("https://api.cityscroll.org/prefs", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body,
  }), { TOKEN_SECRET: SECRET, SUBS: subs });
  assert.equal(response.status, 200);
  const stored = JSON.parse(await subs.get(key));
  assert.deepEqual(stored.filter, { keywords: ["schools"], agency: null, process: null });
  assert.notEqual(
    subCanonical(legacy),
    subCanonical({ ...legacy, filter: stored.filter }),
    "the legacy filter hash changes, which is why it cannot be the outbox identity",
  );
  assert.equal(stored.watch_id, await deriveWatchId(key));
  assert.equal(stored.subscriber_id, await deriveSubscriberId(legacy.email));
  assert.equal(subs.store.has(key), true);
});
