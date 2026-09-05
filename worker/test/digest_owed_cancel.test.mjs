// Contract: an over-scoped catch-up evaluation must be reversible before the
// next scheduled send, and the writer that reverses it must not be able to
// reverse anything else.
//
// Field case (2026-09-05): a catch-up run invoked with an empty body evaluated
// every lagging account rather than the approved ones, and the newly owed rows
// were scheduled to send. The only durable writers at the time either enqueued
// rows or delivered them, so there was no way to withdraw an obligation that
// should never have been recorded.
//
// The guards under test are the ones that keep the reversal narrower than the
// mistake: a named subscriber set, a required first_owed_at floor, a dry run by
// default, and delivered tombstones that stay delivered.
// verify: node --test worker/test/digest_owed_cancel.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import worker from "../src/worker.mjs";
import {
  OWED_CANCEL_MAX_SUBSCRIBERS,
  OWED_CANCEL_REASON,
  cancelOwedItems,
  countOwedCancelCandidates,
  listOwedItems,
  normalizeOwedCancelScope,
} from "../src/lib/digest_outbox.mjs";

const migration = readFileSync(new URL("../migrations/0018_digest_outbox.sql", import.meta.url), "utf8");

function d1FromSQLite(sqlite) {
  return {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return {
        bind(...params) {
          return {
            run() {
              const result = statement.run(...params);
              return { meta: { changes: Number(result.changes || 0) } };
            },
            all() { return { results: statement.all(...params) }; },
            first() { return statement.get(...params) || null; },
          };
        },
      };
    },
    async batch(statements) { return statements.map((statement) => statement.run()); },
  };
}

// The over-scoped run stamped this instant on every row it newly owed.
const FLOOR = "2026-09-05T20:55:00.000Z";
const APPROVED = "subscriber:approved";
const UNAPPROVED_A = "subscriber:unapproved-a";
const UNAPPROVED_B = "subscriber:unapproved-b";

function insert(sqlite, row) {
  sqlite.prepare(`
    INSERT INTO digest_outbox_items
      (watch_id, subscriber_id, item_id, lens, item_kind, payload_json,
       source_observed_at, first_owed_at, owed_origin, status, delivered_at, delivery_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.watch_id,
    row.subscriber_id,
    row.item_id,
    row.lens || "rules",
    row.item_kind || "rules",
    JSON.stringify({ title: row.item_id }),
    "2026-09-01T00:00:00.000Z",
    row.first_owed_at,
    row.owed_origin || "catch-up",
    row.status || "owed",
    row.status === "delivered" ? "2026-09-04T13:00:00.000Z" : null,
    row.status === "delivered" ? "digest:prior" : null,
  );
}

function makeDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(migration);

  // Two accounts the site owner never approved, each owed by the over-scoped run.
  for (const subscriberId of [UNAPPROVED_A, UNAPPROVED_B]) {
    for (let index = 0; index < 3; index += 1) {
      insert(sqlite, {
        watch_id: `watch:${subscriberId}`,
        subscriber_id: subscriberId,
        item_id: `${subscriberId}:new:${index}`,
        first_owed_at: "2026-09-05T20:55:10.000Z",
      });
    }
  }
  // The same account also carries an older obligation the run did not create, and
  // one delivered tombstone.
  insert(sqlite, {
    watch_id: `watch:${UNAPPROVED_A}`,
    subscriber_id: UNAPPROVED_A,
    item_id: `${UNAPPROVED_A}:older`,
    first_owed_at: "2026-09-02T09:00:00.000Z",
  });
  insert(sqlite, {
    watch_id: `watch:${UNAPPROVED_A}`,
    subscriber_id: UNAPPROVED_A,
    item_id: `${UNAPPROVED_A}:delivered`,
    first_owed_at: "2026-09-05T20:55:10.000Z",
    status: "delivered",
  });
  // An approved account owed at the same instant, which must survive untouched.
  insert(sqlite, {
    watch_id: `watch:${APPROVED}`,
    subscriber_id: APPROVED,
    item_id: `${APPROVED}:new`,
    first_owed_at: "2026-09-05T20:55:10.000Z",
  });

  return { sqlite, db: d1FromSQLite(sqlite) };
}

function statuses(sqlite) {
  return Object.fromEntries(
    sqlite.prepare("SELECT item_id, status, last_error FROM digest_outbox_items ORDER BY item_id")
      .all()
      .map((row) => [row.item_id, `${row.status}${row.last_error ? `:${row.last_error}` : ""}`]),
  );
}

test("a dry run counts the rows it would cancel and changes nothing", async () => {
  const { sqlite, db } = makeDb();
  const before = statuses(sqlite);

  const result = await countOwedCancelCandidates(db, {
    subscriberIds: [UNAPPROVED_A, UNAPPROVED_B],
    firstOwedAtFrom: FLOOR,
  });

  assert.equal(result.matched, 6);
  assert.equal(result.cancelled, 0);
  assert.deepEqual(result.perSubscriber, [
    { subscriber_id: UNAPPROVED_A, matched: 3, cancelled: 0 },
    { subscriber_id: UNAPPROVED_B, matched: 3, cancelled: 0 },
  ]);
  assert.deepEqual(statuses(sqlite), before);
  sqlite.close();
});

test("a live run cancels only the named subscribers' owed rows at or after the floor", async () => {
  const { sqlite, db } = makeDb();

  const result = await cancelOwedItems(db, {
    subscriberIds: [UNAPPROVED_A, UNAPPROVED_B],
    firstOwedAtFrom: FLOOR,
  });

  assert.equal(result.matched, 6);
  assert.equal(result.cancelled, 6);
  assert.deepEqual(result.perSubscriber, [
    { subscriber_id: UNAPPROVED_A, matched: 3, cancelled: 3 },
    { subscriber_id: UNAPPROVED_B, matched: 3, cancelled: 3 },
  ]);

  const after = statuses(sqlite);
  for (const subscriberId of [UNAPPROVED_A, UNAPPROVED_B]) {
    for (let index = 0; index < 3; index += 1) {
      assert.equal(after[`${subscriberId}:new:${index}`], `cancelled:${OWED_CANCEL_REASON}`);
    }
  }
  // The earlier obligation, the other account, and the delivered tombstone are
  // outside the scope the operator named.
  assert.equal(after[`${UNAPPROVED_A}:older`], "owed");
  assert.equal(after[`${APPROVED}:new`], "owed");
  assert.equal(after[`${UNAPPROVED_A}:delivered`], "delivered");
  sqlite.close();
});

test("a cancelled row leaves the owed set the scheduled send reads", async () => {
  const { sqlite, db } = makeDb();
  assert.equal((await listOwedItems(db, UNAPPROVED_A)).length, 4);

  await cancelOwedItems(db, { subscriberIds: [UNAPPROVED_A], firstOwedAtFrom: FLOOR });

  const owed = await listOwedItems(db, UNAPPROVED_A);
  assert.deepEqual(owed.map((row) => row.item_id), [`${UNAPPROVED_A}:older`]);
  sqlite.close();
});

test("a floor written without milliseconds still means the instant it names", async () => {
  const { sqlite, db } = makeDb();
  insert(sqlite, {
    watch_id: `watch:${UNAPPROVED_B}`,
    subscriber_id: UNAPPROVED_B,
    item_id: `${UNAPPROVED_B}:at-floor`,
    first_owed_at: "2026-09-05T20:55:00Z",
  });

  const result = await cancelOwedItems(db, {
    subscriberIds: [UNAPPROVED_B],
    firstOwedAtFrom: "2026-09-05T20:55:00Z",
  });

  assert.equal(result.cancelled, 4);
  assert.equal(statuses(sqlite)[`${UNAPPROVED_B}:at-floor`], `cancelled:${OWED_CANCEL_REASON}`);
  sqlite.close();
});

test("an upper bound and a lens narrow the scope further", async () => {
  const { sqlite, db } = makeDb();
  insert(sqlite, {
    watch_id: `watch:${UNAPPROVED_B}`,
    subscriber_id: UNAPPROVED_B,
    item_id: `${UNAPPROVED_B}:later-money`,
    first_owed_at: "2026-09-06T12:00:00.000Z",
    lens: "money",
  });

  const bounded = await cancelOwedItems(db, {
    subscriberIds: [UNAPPROVED_B],
    firstOwedAtFrom: FLOOR,
    firstOwedAtTo: "2026-09-05T23:59:59.999Z",
  });
  assert.equal(bounded.cancelled, 3);
  assert.equal(statuses(sqlite)[`${UNAPPROVED_B}:later-money`], "owed");

  const byLens = await cancelOwedItems(db, {
    subscriberIds: [UNAPPROVED_B],
    firstOwedAtFrom: FLOOR,
    lens: "rules",
  });
  assert.equal(byLens.cancelled, 0, "the rules rows were already cancelled and the money row is another lens");
  assert.equal(statuses(sqlite)[`${UNAPPROVED_B}:later-money`], "owed");
  sqlite.close();
});

test("the scope refuses an unnamed subscriber set or an absent floor", () => {
  const cases = [
    [{ firstOwedAtFrom: FLOOR }, "subscriber-ids-required"],
    [{ subscriberIds: [], firstOwedAtFrom: FLOOR }, "subscriber-ids-required"],
    [{ subscriberIds: ["", "  "], firstOwedAtFrom: FLOOR }, "subscriber-ids-required"],
    [{ subscriberIds: [UNAPPROVED_A] }, "first-owed-at-from-required"],
    [{ subscriberIds: [UNAPPROVED_A], firstOwedAtFrom: "yesterday" }, "first-owed-at-from-required"],
    [{ subscriberIds: [UNAPPROVED_A], firstOwedAtFrom: FLOOR, firstOwedAtTo: "yesterday" }, "first-owed-at-to-invalid"],
    [
      { subscriberIds: [UNAPPROVED_A], firstOwedAtFrom: FLOOR, firstOwedAtTo: "2026-09-01T00:00:00.000Z" },
      "first-owed-at-range-invalid",
    ],
    [
      {
        subscriberIds: Array.from({ length: OWED_CANCEL_MAX_SUBSCRIBERS + 1 }, (_, index) => `subscriber:${index}`),
        firstOwedAtFrom: FLOOR,
      },
      "too-many-subscribers",
    ],
  ];
  for (const [scope, code] of cases) {
    assert.throws(() => normalizeOwedCancelScope(scope), (error) => error.code === code, JSON.stringify(scope));
  }
});

test("a scope with no floor cannot reach the database at all", async () => {
  const { sqlite, db } = makeDb();
  const before = statuses(sqlite);
  await assert.rejects(() => cancelOwedItems(db, { subscriberIds: [UNAPPROVED_A] }));
  await assert.rejects(() => cancelOwedItems(db, { firstOwedAtFrom: FLOOR }));
  assert.deepEqual(statuses(sqlite), before);
  sqlite.close();
});

function request(body) {
  return new Request("https://w/admin/owed-cancel?key=secret", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("the admin route dry-runs by default and only writes when the caller opts in", async () => {
  const { sqlite, db } = makeDb();
  const env = { ADMIN_KEY: "secret", DB: db };

  const preview = await worker.fetch(request({
    subscriberIds: [UNAPPROVED_A, UNAPPROVED_B],
    firstOwedAtFrom: FLOOR,
  }), env, {});
  assert.equal(preview.status, 200);
  assert.deepEqual(await preview.json(), {
    mode: "owed_cancel",
    dryRun: true,
    matched: 6,
    cancelled: 0,
    perSubscriber: [
      { subscriber_id: UNAPPROVED_A, matched: 3, cancelled: 0 },
      { subscriber_id: UNAPPROVED_B, matched: 3, cancelled: 0 },
    ],
  });
  assert.equal(statuses(sqlite)[`${UNAPPROVED_A}:new:0`], "owed");

  const live = await worker.fetch(request({
    subscriberIds: [UNAPPROVED_A, UNAPPROVED_B],
    firstOwedAtFrom: FLOOR,
    dryRun: false,
  }), env, {});
  assert.equal(live.status, 200);
  const body = await live.json();
  assert.equal(body.dryRun, false);
  assert.equal(body.matched, 6);
  assert.equal(body.cancelled, 6);
  assert.equal(statuses(sqlite)[`${UNAPPROVED_A}:new:0`], `cancelled:${OWED_CANCEL_REASON}`);
  assert.equal(statuses(sqlite)[`${APPROVED}:new`], "owed");
  sqlite.close();
});

test("the admin route refuses an unscoped request rather than cancelling everything", async () => {
  const { sqlite, db } = makeDb();
  const env = { ADMIN_KEY: "secret", DB: db };
  const before = statuses(sqlite);

  for (const [body, code] of [
    [{ firstOwedAtFrom: FLOOR, dryRun: false }, "subscriber-ids-required"],
    [{ subscriberIds: [], firstOwedAtFrom: FLOOR, dryRun: false }, "subscriber-ids-required"],
    [{ subscriberIds: [UNAPPROVED_A], dryRun: false }, "first-owed-at-from-required"],
    [{}, "subscriber-ids-required"],
  ]) {
    const response = await worker.fetch(request(body), env, {});
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json()).error, code);
  }

  // A non-boolean dryRun is refused rather than read as either mode.
  const coerced = await worker.fetch(request({
    subscriberIds: [UNAPPROVED_A],
    firstOwedAtFrom: FLOOR,
    dryRun: "false",
  }), env, {});
  assert.equal(coerced.status, 400);
  assert.equal((await coerced.json()).error, "invalid-dry-run");

  assert.deepEqual(statuses(sqlite), before);
  sqlite.close();
});

test("the admin route is authenticated and POST-only", async () => {
  const { sqlite, db } = makeDb();

  const authorized = await worker.fetch(request({
    subscriberIds: [UNAPPROVED_A],
    firstOwedAtFrom: FLOOR,
  }), { ADMIN_KEY: "secret", DB: db }, {});
  assert.equal(authorized.status, 200, "the fixture request carries the configured key");

  const wrongKey = await worker.fetch(new Request("https://w/admin/owed-cancel?key=wrong", {
    method: "POST",
    body: "{}",
  }), { ADMIN_KEY: "secret", DB: db }, {});
  assert.equal(wrongKey.status, 401);

  const unconfigured = await worker.fetch(request({
    subscriberIds: [UNAPPROVED_A],
    firstOwedAtFrom: FLOOR,
  }), { DB: db }, {});
  assert.equal(unconfigured.status, 404, "the route stays invisible until ADMIN_KEY is configured");

  const wrongMethod = await worker.fetch(new Request("https://w/admin/owed-cancel?key=secret"), { ADMIN_KEY: "secret", DB: db }, {});
  assert.equal(wrongMethod.status, 405);
  sqlite.close();
});
