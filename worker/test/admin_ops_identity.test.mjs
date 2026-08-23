// Authenticated /admin/subs and digest results must show the full sub key and
// address. The old 2-hex mask (sub:XX***) is only 256-way and collides on the
// live roster.
import { test } from "node:test";
import assert from "node:assert/strict";

import { handleAdminSubs } from "../src/admin.mjs";
import { toDayLogEntry } from "../src/lib/digest_ops.mjs";
import { accountLogId } from "../src/lib/rollup.mjs";

class KV {
  constructor(map = {}) { this.data = new Map(Object.entries(map)); }
  async get(key) { return this.data.has(key) ? this.data.get(key) : null; }
  async put(key, value) { this.data.set(key, String(value)); }
  async list({ prefix = "" } = {}) {
    return {
      keys: [...this.data.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
    };
  }
}

test("admin roster keeps two sub keys that share a 2-hex prefix distinct and shows full addresses", async () => {
  const shelly = "sub:36abcdef01234567";
  const owner = "sub:36fedcba76543210";
  const env = {
    ADMIN_KEY: "secret",
    SUBS: new KV({
      [shelly]: JSON.stringify({
        email: "shelly.ronen@gmail.com",
        lens: "money",
        filter: {},
        freq: "weekly",
      }),
      [owner]: JSON.stringify({
        email: "owner@example.com",
        lens: "award",
        filter: { requestId: "20250110001" },
        freq: "daily",
      }),
    }),
  };
  const res = await handleAdminSubs(new Request("https://w/admin/subs?key=secret"), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  const keys = body.subs.map((row) => row.key).sort();
  assert.deepEqual(keys, [shelly, owner].sort());
  assert.deepEqual(body.sampleKeys.sort(), [shelly, owner].sort());
  assert.equal(new Set(keys).size, 2);
  assert.ok(!body.sampleKeys.some((key) => key.includes("***")));
  assert.deepEqual(body.subs.map((row) => row.email).sort(), [
    "owner@example.com",
    "shelly.ronen@gmail.com",
  ]);

  const html = await (await handleAdminSubs(
    new Request("https://w/admin/subs?key=secret&view=html"),
    env,
  )).text();
  assert.match(html, /shelly\.ronen@gmail\.com/);
  assert.match(html, /owner@example\.com/);
  assert.match(html, /sub:36abcdef01234567/);
  assert.match(html, /sub:36fedcba76543210/);
  assert.doesNotMatch(html, /sub:36\*\*\*/);
});

test("daylog identity uses the full sub key and address, not the 2-hex mask", () => {
  const a = toDayLogEntry({
    sub: "sub:36abcdef01234567",
    email: "shelly.ronen@gmail.com",
    lens: "money",
    new: 1,
    noticeIds: ["20250110001"],
    action: "match",
    sent: true,
  });
  const b = toDayLogEntry({
    sub: "sub:36fedcba76543210",
    email: "owner@example.com",
    lens: "award",
    new: 1,
    noticeIds: ["20250110002"],
    action: "match",
    sent: true,
  });
  assert.equal(a.id, "sub:36abcdef01234567");
  assert.equal(b.id, "sub:36fedcba76543210");
  assert.notEqual(a.id, b.id);
  assert.equal(a.email, "shelly.ronen@gmail.com");
  assert.equal(b.email, "owner@example.com");
  assert.equal(accountLogId("shelly.ronen@gmail.com"), "account:shelly.ronen@gmail.com");
  assert.notEqual(accountLogId("shelly.ronen@gmail.com"), accountLogId("sharon@example.com"));
});
