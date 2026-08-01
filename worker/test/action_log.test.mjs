import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { signToken } from "optin-token";

import {
  ACTION_LOG_COLUMNS,
  ACTION_LOG_SCHEMA_VERSION,
  actionLogDecisionFromDisposition,
  appendActionLog,
  normalizeActionEvent,
  reviewActionFromDisposition,
} from "../src/lib/action_log.mjs";
import { appendWatchLog } from "../src/lib/watchlog.mjs";
import { sessionPayload } from "../src/lib/session.mjs";
import { handlePins } from "../src/pins.mjs";

const migration = readFileSync(new URL("../migrations/0010_action_log.sql", import.meta.url), "utf8");

function d1(db) {
  return {
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        bind(...args) {
          return { async run() { statement.run(...args); return { success: true }; } };
        },
      };
    },
  };
}

test("migration defines the versioned action log columns", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(migration);
  const columns = db.prepare("PRAGMA table_info(action_log)").all().map((row) => row.name);
  for (const column of ACTION_LOG_COLUMNS) assert.ok(columns.includes(column), `missing ${column}`);
  db.close();
});

test("normalizer keeps only bounded action metadata and no personal identifiers", () => {
  const fixtureEmail = ["person", "example.test"].join("@");
  const event = normalizeActionEvent({
    action_type: "pins_saved",
    object: { type: "pin_store", id: "recognized" },
    ts: "2026-08-01T12:00:00Z",
    method: { name: "session_pins", version: "v1" },
    metadata: {
      source: "pins",
      item_count: 3,
      investigation_count: 1,
      merge: true,
      email: fixtureEmail,
      ip: "192.0.2.1",
      note: "free text is not action data",
    },
  }, { id: "event-1" });
  assert.equal(event.schema_version, ACTION_LOG_SCHEMA_VERSION);
  assert.deepEqual(event.metadata, {
    source: "pins",
    merge: true,
    item_count: 3,
    investigation_count: 1,
  });
  const encoded = JSON.stringify(event);
  assert.equal(encoded.includes(fixtureEmail), false);
  assert.doesNotMatch(encoded, /192\.0\.2\.1|free text/);
});

test("normalizer rejects email-shaped object ids and unknown methods", () => {
  const fixtureEmail = ["person", "example.test"].join("@");
  const base = {
    action_type: "watch_confirmed",
    object: { type: "watch", id: fixtureEmail },
    method: { name: "double_opt_in", version: "v1" },
  };
  assert.equal(normalizeActionEvent(base), null);
  assert.equal(normalizeActionEvent({ ...base, object: { type: "watch", id: "192.0.2.1" } }), null);
  assert.equal(normalizeActionEvent({ ...base, object: { type: "watch", id: "2001:db8::1" } }), null);
  assert.equal(normalizeActionEvent({ ...base, object: { type: "watch", id: "money" }, method: { name: "bad method", version: "v1" } }), null);
});

test("desk dispositions map to privacy-safe review actions", () => {
  assert.equal(actionLogDecisionFromDisposition("same"), "same");
  assert.equal(actionLogDecisionFromDisposition("different"), "different");
  assert.equal(actionLogDecisionFromDisposition("defer"), "unresolved");
  assert.equal(actionLogDecisionFromDisposition("merge"), undefined);

  const action = reviewActionFromDisposition({
    id: "disp-1",
    pair_id: "pair-abc",
    decision: "same",
    actor: "desk-actor:fixture",
    note: "should never reach the action log",
    created_at: "2026-08-01T12:00:00Z",
  });
  assert.deepEqual(action, {
    action_type: "review_decision",
    object: { type: "entity_pair", id: "pair-abc" },
    method: { name: "false_split_desk", version: "v1" },
    metadata: { source: "review_desk", decision: "same" },
    ts: "2026-08-01T12:00:00Z",
    id: "disp-1",
  });
  const encoded = JSON.stringify(action);
  assert.equal(encoded.includes("desk-actor"), false);
  assert.equal(encoded.includes("should never"), false);
});

test("append writes one queryable row with method lineage", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(migration);
  const ok = await appendActionLog({ DB: d1(db) }, {
    action_type: "review_decision",
    object: { type: "entity_pair", id: "pair-123" },
    method: { name: "clerical_review", version: "v1" },
    metadata: { source: "review_desk", decision: "different" },
    ts: "2026-08-01T12:00:00Z",
  }, { id: "event-review-1" });
  assert.equal(ok, true);
  const row = db.prepare("SELECT * FROM action_log").get();
  assert.equal(row.object_id, "pair-123");
  assert.equal(row.method_version, "v1");
  assert.deepEqual(JSON.parse(row.metadata_json), { source: "review_desk", decision: "different" });
  assert.equal(row.ts, "2026-08-01T12:00:00.000Z");
  db.close();
});

test("watch lifecycle dual-write does not depend on the operational log binding", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(migration);
  const fixtureEmail = ["person", "example.test"].join("@");
  await appendWatchLog({ DB: d1(db) }, {
    action: "pause",
    email: fixtureEmail,
    subKey: "sub:private",
    lens: "money",
    freq: "daily",
    source: "prefs",
    at: "2026-08-01T12:00:00Z",
  });
  const row = db.prepare("SELECT * FROM action_log").get();
  assert.equal(row.action_type, "watch_paused");
  assert.equal(row.object_id, "money");
  assert.equal(JSON.stringify(row).includes(fixtureEmail), false);
  assert.doesNotMatch(JSON.stringify(row), /sub:/);
  db.close();
});

test("recognized pin saves append counts without account or session identity", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(migration);
  const secret = "your-secret-key-here";
  const email = ["reader", "example.test"].join("@");
  const cookie = await signToken(secret, sessionPayload(email), { ttlSeconds: 3600 });
  const store = {};
  const env = {
    DB: d1(db),
    TOKEN_SECRET: secret,
    SUBS: {
      async get(key) { return store[key] || null; },
      async put(key, value) { store[key] = value; },
    },
  };
  const response = await handlePins(new Request("https://api.cityscroll.org/pins", {
    method: "PUT",
    headers: {
      Origin: "https://cityscroll.org",
      Cookie: `cs_session=${cookie}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      pins: {
        current: "one",
        invs: {
          one: {
            name: "One",
            items: [{ t: "notice", id: "20260801001", title: "A notice" }],
          },
        },
      },
    }),
  }), env);
  assert.equal(response.status, 200);
  const row = db.prepare("SELECT * FROM action_log").get();
  assert.equal(row.action_type, "pins_saved");
  assert.deepEqual(JSON.parse(row.metadata_json), {
    source: "pins",
    merge: false,
    item_count: 1,
    investigation_count: 1,
  });
  assert.equal(JSON.stringify(row).includes(email), false);
  assert.doesNotMatch(JSON.stringify(row), /cs_session/);
  db.close();
});

test("missing D1 or a failed insert is fail-soft", async () => {
  assert.equal(await appendActionLog({}, {}), false);
  assert.equal(await appendActionLog({ DB: { prepare() { throw new Error("offline"); } } }, {
    action_type: "pins_saved",
    object: { type: "pin_store", id: "recognized" },
    method: { name: "session_pins", version: "v1" },
  }), false);
});
