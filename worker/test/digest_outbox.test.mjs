import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  SECTION_STATUS,
  enqueueEvaluatedSection,
  enqueueEvaluatedSections,
  extractLensIdentity,
  sectionResultStatus,
  reserveDeliveryOccasion,
  listOwedItems,
  finalizeAcceptedDelivery,
  failDelivery,
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

function makeDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(migration);
  return { sqlite, db: d1FromSQLite(sqlite) };
}

function rows(sqlite) {
  return sqlite.prepare("SELECT * FROM digest_outbox_items ORDER BY item_id").all();
}

const shared = {
  watch_id: "watch:one",
  subscriber_id: "subscriber:one",
  source_observed_at: "2026-08-10T12:00:00.000Z",
  owed_origin: "unit-test",
  now: "2026-08-10T12:01:00.000Z",
};

test("lens identity policies keep land projects distinct and use request_id for notice lenses", () => {
  assert.deepEqual(extractLensIdentity("land", { project_id: "2022M0258", short_title: "same" }), {
    identityField: "project_id", identityValue: "2022M0258", itemId: "land:2022M0258", itemKind: "land",
  });
  assert.deepEqual(extractLensIdentity("money", { request_id: "20260810001", pin: "same" }), {
    identityField: "request_id", identityValue: "20260810001", itemId: "notice:20260810001", itemKind: "money",
  });
  assert.deepEqual(extractLensIdentity("meetings", { request_id: "20260810001", short_title: "same" }), {
    identityField: "request_id", identityValue: "20260810001", itemId: "notice:20260810001", itemKind: "meetings",
  });
});
test("rules identity is the semantic action key, not the notice content or request id", () => {
  const row = {
    request_id: "20260810001",
    temporal_action: { kind: "rules-comment-open", event_at: "2026-08-20" },
    short_title: "same title",
  };
  assert.deepEqual(extractLensIdentity("rules", row), {
    identityField: "action_key",
    identityValue: "temporal:rules:20260810001:comment-open:2026-08-20",
    itemId: "rules:temporal:rules:20260810001:comment-open:2026-08-20",
    itemKind: "rules",
  });
  assert.throws(() => extractLensIdentity("rules", { request_id: "20260810001" }), /action key/);
});

test("enqueue writes one owed row per land project and preserves the render snapshot", async () => {
  const { sqlite, db } = makeDb();
  const section = {
    ...shared,
    lens: "land",
    kind: "rezone",
    status: "success",
    freshRows: [
      { project_id: "P-1", project_name: "Same title", render_snapshot: { title: "P-1" } },
      { project_id: "P-2", project_name: "Same title", render_snapshot: { title: "P-2" } },
      { project_id: "P-3", project_name: "Same title", render_snapshot: { title: "P-3" } },
      { project_id: "P-4", project_name: "Same title", render_snapshot: { title: "P-4" } },
    ],
  };
  const result = await enqueueEvaluatedSection(db, section);
  assert.equal(result.status, SECTION_STATUS.SUCCESS);
  assert.equal(result.enqueued, 4);
  assert.deepEqual(rows(sqlite).map((row) => row.item_id), ["land:P-1", "land:P-2", "land:P-3", "land:P-4"]);
  assert.deepEqual(JSON.parse(rows(sqlite)[0].payload_json), { title: "P-1" });
  assert.equal(rows(sqlite)[0].status, "owed");
  assert.equal(rows(sqlite)[0].delivered_at, null);
  assert.equal(rows(sqlite)[0].source_observed_at, shared.source_observed_at);
  assert.equal(rows(sqlite)[0].owed_origin, "unit-test");
  sqlite.close();
});

test("repeating the same watch/item enqueue is idempotent", async () => {
  const { sqlite, db } = makeDb();
  const section = {
    ...shared,
    lens: "meetings",
    status: "success",
    freshRows: [{ request_id: "20260810001", short_title: "updated render" }],
  };
  const first = await enqueueEvaluatedSection(db, section);
  const second = await enqueueEvaluatedSection(db, { ...section, freshRows: [{ request_id: "20260810001", short_title: "newer render" }] });
  assert.equal(first.enqueued, 1);
  assert.equal(second.enqueued, 0);
  assert.equal(second.duplicates, 1);
  assert.equal(rows(sqlite).length, 1);
  assert.equal(JSON.parse(rows(sqlite)[0].payload_json).short_title, "updated render");
  sqlite.close();
});

test("failed and partial sections report status and enqueue nothing", async () => {
  const { sqlite, db } = makeDb();
  const failed = await enqueueEvaluatedSection(db, {
    ...shared,
    lens: "money",
    status: "failed",
    error: "source unavailable",
    freshRows: [{ request_id: "never-owed" }],
  });
  const partial = await enqueueEvaluatedSection(db, {
    ...shared,
    lens: "meetings",
    status: "partial_error",
    freshRows: [{ request_id: "also-never-owed" }],
  });
  assert.equal(failed.status, SECTION_STATUS.FAILED);
  assert.equal(partial.status, SECTION_STATUS.PARTIAL_ERROR);
  assert.equal(failed.enqueued, 0);
  assert.equal(partial.enqueued, 0);
  assert.equal(rows(sqlite).length, 0);
  sqlite.close();
});

test("section status accepts the existing evaluator error shape", () => {
  assert.equal(sectionResultStatus({}), SECTION_STATUS.SUCCESS);
  assert.equal(sectionResultStatus({ error: "boom" }), SECTION_STATUS.FAILED);
  assert.equal(sectionResultStatus({ errors: ["one"] }), SECTION_STATUS.PARTIAL_ERROR);
  assert.equal(sectionResultStatus({ skipped: "paused" }), SECTION_STATUS.SKIPPED);
});

test("multi-section enqueue preserves statuses while inserting only successful sections", async () => {
  const { sqlite, db } = makeDb();
  const result = await enqueueEvaluatedSections(db, [
    { ...shared, lens: "money", status: "partial_error", freshRows: [{ request_id: "M1" }] },
    { ...shared, lens: "land", status: "success", freshRows: [{ project_id: "P1" }] },
    { ...shared, lens: "rules", status: "failed", freshRows: [{ request_id: "R1", action_key: "A1" }] },
  ]);
  assert.equal(result.status, SECTION_STATUS.FAILED);
  assert.equal(result.enqueued, 1);
  assert.deepEqual(result.sections.map((section) => section.status), ["partial_error", "success", "failed"]);
  assert.deepEqual(rows(sqlite).map((row) => row.item_id), ["land:P1"]);
  sqlite.close();
});

test("delivery occasion is unique per subscriber and UTC day", async () => {
  const { sqlite, db } = makeDb();
  const first = await reserveDeliveryOccasion(db, "subscriber:one", "2026-08-10", "2026-08-10T13:00:00.000Z", "delivery:one");
  const second = await reserveDeliveryOccasion(db, "subscriber:one", "2026-08-10", "2026-08-10T13:01:00.000Z", "delivery:two");
  assert.deepEqual(first, { reserved: true, deliveryId: "delivery:one" });
  assert.deepEqual(second, { reserved: false, deliveryId: "delivery:two" });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM digest_outbox_deliveries").get().n, 1);
  sqlite.close();
});

test("accepted delivery flips only included owed rows and preserves partial failures", async () => {
  const { sqlite, db } = makeDb();
  const insert = sqlite.prepare(`INSERT INTO digest_outbox_items
    (watch_id, subscriber_id, item_id, lens, item_kind, payload_json, source_observed_at, first_owed_at, owed_origin)
    VALUES (?, ?, ?, 'money', 'rfp', '{}', ?, ?, 'test')`);
  insert.run("watch:one", "subscriber:one", "notice:one", "2026-08-10", "2026-08-10T12:00:00Z");
  insert.run("watch:one", "subscriber:one", "notice:two", "2026-08-10", "2026-08-10T12:01:00Z");
  const reservation = await reserveDeliveryOccasion(db, "subscriber:one", "2026-08-10", "2026-08-10T13:00:00Z", "delivery:one", 2);
  const owed = await listOwedItems(db, "subscriber:one");
  const done = await finalizeAcceptedDelivery(db, {
    subscriberId: "subscriber:one",
    scheduledDay: "2026-08-10",
    deliveryId: reservation.deliveryId,
    items: [owed[0]],
    acceptedAt: "2026-08-10T13:00:02Z",
    providerMessageId: "provider:one",
    status: "partial_error",
    error: { section: "meetings" },
    eligibleCount: 2,
  });
  assert.equal(done.status, "partial_error");
  assert.equal(sqlite.prepare("SELECT status FROM digest_outbox_items WHERE item_id = 'notice:one'").get().status, "delivered");
  assert.equal(sqlite.prepare("SELECT status FROM digest_outbox_items WHERE item_id = 'notice:two'").get().status, "owed");
  const receipt = sqlite.prepare("SELECT status, provider_message_id FROM digest_outbox_deliveries").get();
  assert.equal(receipt.status, "partial_error");
  assert.equal(receipt.provider_message_id, "provider:one");
  assert.equal(sqlite.prepare("SELECT eligible_count, delivered_count FROM digest_outbox_deliveries").get().eligible_count, 2);
  assert.equal(sqlite.prepare("SELECT eligible_count, delivered_count FROM digest_outbox_deliveries").get().delivered_count, 1);
  sqlite.close();
});

test("provider failure records failed occasion and leaves every item owed", async () => {
  const { sqlite, db } = makeDb();
  sqlite.prepare(`INSERT INTO digest_outbox_items
    (watch_id, subscriber_id, item_id, lens, item_kind, payload_json, source_observed_at, first_owed_at, owed_origin)
    VALUES ('watch:one', 'subscriber:one', 'notice:one', 'money', 'rfp', '{}', '2026-08-10', '2026-08-10T12:00:00Z', 'test')`).run();
  const reservation = await reserveDeliveryOccasion(db, "subscriber:one", "2026-08-10", "2026-08-10T13:00:00Z", "delivery:one");
  await failDelivery(db, {
    subscriberId: "subscriber:one",
    scheduledDay: "2026-08-10",
    deliveryId: reservation.deliveryId,
    error: { message: "provider unavailable" },
  });
  assert.equal(sqlite.prepare("SELECT status FROM digest_outbox_items WHERE item_id = 'notice:one'").get().status, "owed");
  assert.equal(sqlite.prepare("SELECT status FROM digest_outbox_deliveries").get().status, "failed");
  sqlite.close();
});
