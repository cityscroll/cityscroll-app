// Precise-watch edits must govern queued email without losing watch identity,
// delivered history, or another watch's entitlement.
//
// verify: node --test worker/test/watch_text_query_edit_delivery.test.mjs worker/test/subscription_identity.test.mjs worker/test/digest_outbox_rollup.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { signToken } from "optin-token";

import { processAccountRollup, processOneSub } from "../src/alerts.mjs";
import { sanitize } from "../src/lib/filter.mjs";
import { prefsPayload } from "../src/lib/prefs.mjs";
import { handlePrefs } from "../src/prefs.mjs";
import {
  QUERY_REVISION_CANCEL_REASON,
  enqueueEvaluatedSection,
  listWatchMembership,
  SECTION_STATUS,
} from "../src/lib/digest_outbox.mjs";
import {
  QUERY_REVISION_CUTOFF,
  QUERY_REVISION_SUPPRESSION,
  queryRevisionForFilter,
  reconcileWatchOwedMembership,
  stampWatchQueryRevision,
} from "../src/lib/watch_query_revision.mjs";
import { deriveSubscriberId, deriveWatchId } from "../src/lib/subscriptions.mjs";

const outboxMigration = readFileSync(new URL("../migrations/0018_digest_outbox.sql", import.meta.url), "utf8");
const revisionMigration = readFileSync(new URL("../migrations/0030_digest_outbox_query_revision.sql", import.meta.url), "utf8");
const titleSnapshot = JSON.parse(readFileSync(
  new URL("../../test/fixtures/watch_text_query/procurement_titles_snapshot.json", import.meta.url),
  "utf8",
));

const CLOCK = "2026-09-09";
const NOW = new Date("2026-09-09T13:00:00.000Z");
const SECRET = "s".repeat(32);
const EMAIL = "owed@example.com";

const SOLARWINDS = "20260723004";
const E2_IDS = ["20260709018", "20260713010", "20260713036"];
const E1_IDS = [...E2_IDS, SOLARWINDS];

const term = (value) => ({ kind: "term", value });
const softwareQuery = { version: 1, all: [[term("software")]] };
const softwareNoMaint = {
  version: 1,
  all: [[term("software")]],
  none: [term("maintenance")],
};

const awardRows = titleSnapshot.rows.filter((row) => E1_IDS.includes(row.request_id));

function kv(map = {}) {
  return {
    get: async (k) => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null),
    put: async (k, v) => { map[k] = typeof v === "string" ? v : String(v); },
    delete: async (k) => { delete map[k]; },
    list: async (options = {}) => {
      const prefix = options.prefix || "";
      const keys = Object.keys(map).filter((k) => k.startsWith(prefix)).map((k) => ({ name: k }));
      return { keys, list_complete: true };
    },
    _map: map,
  };
}

function d1(sqlite) {
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

function noticesSchema(sqlite) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS notices (
      request_id TEXT PRIMARY KEY,
      section TEXT,
      agency TEXT,
      type_of_notice TEXT,
      category TEXT,
      short_title TEXT,
      description TEXT,
      vendor_name TEXT,
      pin TEXT,
      contract_amount REAL,
      contract_amount_valid INTEGER,
      start_date TEXT,
      due_date TEXT,
      haystack TEXT
    );
    CREATE TABLE IF NOT EXISTS ingest_state (k TEXT PRIMARY KEY, v TEXT);
  `);
  sqlite.prepare("INSERT OR REPLACE INTO ingest_state (k, v) VALUES ('notices_cursor', ?)").run(CLOCK);
}

function seedNotices(sqlite, rows) {
  const insert = sqlite.prepare(`
    INSERT INTO notices (
      request_id, agency, type_of_notice, category, short_title, description,
      vendor_name, pin, contract_amount, contract_amount_valid, start_date, haystack
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  sqlite.exec("BEGIN");
  for (const row of rows) {
    const title = row.short_title || "";
    insert.run(
      row.request_id,
      row.agency_name || row.agency || null,
      row.type_of_notice_description || row.type_of_notice || null,
      row.category_description || row.category || null,
      title,
      row.additional_description_1 || row.description || "",
      row.vendor_name || null,
      row.pin || null,
      null,
      1,
      String(row.start_date || "").slice(0, 10),
      title.toLowerCase(),
    );
  }
  sqlite.exec("COMMIT");
}

function makeDb() {
  const sqlite = new DatabaseSync(":memory:");
  noticesSchema(sqlite);
  seedNotices(sqlite, awardRows);
  sqlite.exec(outboxMigration);
  sqlite.exec(revisionMigration);
  return { sqlite, DB: d1(sqlite) };
}

function rowFor(id) {
  const source = awardRows.find((row) => row.request_id === id);
  return {
    request_id: id,
    short_title: source.short_title,
    type_of_notice_description: "Award",
    start_date: source.start_date,
  };
}

async function watchRecord({ key, filter, extra = {} }) {
  const subscriber_id = extra.subscriber_id || await deriveSubscriberId(EMAIL);
  const watch_id = extra.watch_id || await deriveWatchId(key);
  const record = {
    email: EMAIL,
    lens: "money",
    filter: sanitize("money", { noticeType: "award", keywords: [], ...filter }),
    freq: extra.freq || "daily",
    channel: "email",
    lang: "en",
    key,
    subscriber_id,
    watch_id,
    createdAt: "2026-08-01T00:00:00.000Z",
    ...extra,
  };
  return stampWatchQueryRevision(record).record;
}

function insertOwed(sqlite, { watchId, subscriberId, itemId, payload }) {
  sqlite.prepare(`INSERT INTO digest_outbox_items
    (watch_id, subscriber_id, item_id, lens, item_kind, payload_json, source_observed_at, first_owed_at, owed_origin)
    VALUES (?, ?, ?, 'money', 'award', ?, '2026-07-29', '2026-08-01T12:00:00Z', 'test')`)
    .run(watchId, subscriberId, itemId, JSON.stringify(payload));
}

function queueE1(sqlite, watch) {
  for (const id of E1_IDS) {
    insertOwed(sqlite, {
      watchId: watch.watch_id,
      subscriberId: watch.subscriber_id,
      itemId: `notice:${id}`,
      payload: rowFor(id),
    });
  }
}

function ctx() {
  let sends = 0;
  return {
    FROM: "CityScroll <alerts@cityscroll.org>",
    LIVE: true,
    today: CLOCK,
    now: NOW,
    isMonday: false,
    heartbeatDays: 14,
    counts: () => ({ "per-run": sends, daily: sends }),
    caps: { "per-run": 25, daily: 50 },
    onSent: async () => { sends++; },
    capturePreviews: true,
  };
}

function envFor({ DB, SUBS, ALERT_STATE }) {
  return {
    DB,
    SUBS,
    ALERT_STATE: ALERT_STATE || kv(),
    ALERTS_LIVE: "true",
    RESEND_API_KEY: "test",
    TOKEN_SECRET: SECRET,
    CONFIRM_BASE: "https://api.cityscroll.org",
    MAX_PER_RUN: "25",
    MAX_SENDS_PER_DAY: "50",
  };
}

async function withCapturedProvider(fn) {
  const original = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, options) => {
    const target = String(url);
    if (target.includes("api.resend.com/emails")) {
      sent.push({
        body: JSON.parse(options.body),
        idempotencyKey: options.headers?.["Idempotency-Key"] || options.headers?.["idempotency-key"] || null,
      });
      return { ok: true, json: async () => ({ id: "provider:test" }) };
    }
    if (target.includes("data.cityofnewyork.us") || target.includes("resource/")) {
      throw new Error(`publisher fetch is not allowed: ${target}`);
    }
    return { ok: true, json: async () => [] };
  };
  try {
    return await fn(sent);
  } finally {
    globalThis.fetch = original;
  }
}

async function prefsToken() {
  return signToken(SECRET, prefsPayload(EMAIL), { ttlSeconds: 3600 });
}

async function prefsUpdate(env, key, filter) {
  const token = await prefsToken();
  return handlePrefs(new Request("https://api.cityscroll.org/prefs", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ token, action: "update", key, filter }),
  }), env);
}

function statuses(sqlite, watchId) {
  return Object.fromEntries(
    sqlite.prepare("SELECT item_id, status, last_error FROM digest_outbox_items WHERE watch_id = ? ORDER BY item_id")
      .all(watchId)
      .map((row) => [row.item_id, `${row.status}${row.last_error ? `:${row.last_error}` : ""}`]),
  );
}

test("query revision fingerprints equivalent expressions together and changes on exclusion", () => {
  const software = queryRevisionForFilter({ text_query: softwareQuery });
  const reordered = queryRevisionForFilter({
    text_query: { version: 1, all: [[term("SOFTWARE")]] },
  });
  const excluded = queryRevisionForFilter({ text_query: softwareNoMaint });
  assert.equal(software, reordered);
  assert.notEqual(software, excluded);
  assert.match(software, /^qr:v1:/);
  assert.equal(QUERY_REVISION_CUTOFF, "before-provider-submit");
});

test("A1 queued SolarWinds is excluded from the next captured email after a maintenance edit", async () => {
  const { sqlite, DB } = makeDb();
  const key = "sub:software-watch";
  const record = await watchRecord({ key, filter: { text_query: softwareQuery } });
  const SUBS = kv({ [key]: JSON.stringify(record) });
  queueE1(sqlite, record);

  const env = envFor({ DB, SUBS });
  const edited = await prefsUpdate(env, key, { keywords: [], noticeType: "award", text_query: softwareNoMaint });
  assert.equal(edited.status, 200);
  const stored = JSON.parse(SUBS._map[key]);
  assert.equal(stored.watch_id, record.watch_id);
  assert.equal(stored.subscriber_id, record.subscriber_id);
  assert.equal(stored.key || key, key);
  assert.equal(statuses(sqlite, record.watch_id)[`notice:${SOLARWINDS}`], `cancelled:${QUERY_REVISION_SUPPRESSION}`);
  for (const id of E2_IDS) {
    assert.equal(statuses(sqlite, record.watch_id)[`notice:${id}`], "owed");
  }

  await withCapturedProvider(async (sent) => {
    const result = await processOneSub(env, { ...stored, key }, ctx());
    assert.equal(result.sent, true);
    assert.equal(sent.length, 1);
    assert.doesNotMatch(sent[0].body.html, /SolarWinds Software Maintenance/);
    assert.match(sent[0].body.html, /Acronis Cyber Protection Software License/);
    assert.match(sent[0].body.html, /Komprise Multi-Year Software Renewal/);
    assert.match(sent[0].body.html, /CRO-660 Software/);
    assert.equal(sqlite.prepare("SELECT status FROM digest_outbox_items WHERE item_id = ?").get(`notice:${SOLARWINDS}`).status, "cancelled");
    assert.notEqual(sqlite.prepare("SELECT status FROM digest_outbox_items WHERE item_id = ?").get(`notice:${SOLARWINDS}`).status, "delivered");
    for (const id of E2_IDS) {
      assert.equal(sqlite.prepare("SELECT status FROM digest_outbox_items WHERE item_id = ?").get(`notice:${id}`).status, "delivered");
    }
  });
  sqlite.close();
});

test("A2 two-watch rollup keeps SolarWinds on the unchanged watch and never marks exclusion delivered", async () => {
  const { sqlite, DB } = makeDb();
  const softwareKey = "sub:software-a";
  const otherKey = "sub:software-b";
  const software = await watchRecord({ key: softwareKey, filter: { text_query: softwareQuery } });
  const other = await watchRecord({
    key: otherKey,
    filter: { text_query: softwareQuery },
    extra: { watch_id: await deriveWatchId(otherKey) },
  });
  assert.equal(software.subscriber_id, other.subscriber_id);
  assert.notEqual(software.watch_id, other.watch_id);
  const SUBS = kv({
    [softwareKey]: JSON.stringify(software),
    [otherKey]: JSON.stringify(other),
  });
  queueE1(sqlite, software);
  insertOwed(sqlite, {
    watchId: other.watch_id,
    subscriberId: other.subscriber_id,
    itemId: `notice:${SOLARWINDS}`,
    payload: rowFor(SOLARWINDS),
  });
  insertOwed(sqlite, {
    watchId: "watch:unrelated-account",
    subscriberId: "subscriber:someone-else",
    itemId: `notice:${SOLARWINDS}`,
    payload: rowFor(SOLARWINDS),
  });

  const env = envFor({ DB, SUBS });
  await prefsUpdate(env, softwareKey, { keywords: [], noticeType: "award", text_query: softwareNoMaint });

  const softwareStatus = statuses(sqlite, software.watch_id)[`notice:${SOLARWINDS}`];
  assert.equal(softwareStatus, `cancelled:${QUERY_REVISION_SUPPRESSION}`);
  const membership = await listWatchMembership(DB, software.watch_id);
  const cancelled = membership.find((row) => row.item_id === `notice:${SOLARWINDS}`);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.last_error, QUERY_REVISION_CANCEL_REASON);
  const suppression = sqlite.prepare("SELECT suppression_json FROM digest_outbox_items WHERE watch_id = ? AND item_id = ?")
    .get(software.watch_id, `notice:${SOLARWINDS}`);
  const details = JSON.parse(suppression.suppression_json);
  assert.equal(details.reason, QUERY_REVISION_SUPPRESSION);
  assert.equal(details.exclusion.value, "maintenance");
  assert.equal(statuses(sqlite, other.watch_id)[`notice:${SOLARWINDS}`], "owed");
  assert.equal(sqlite.prepare("SELECT status FROM digest_outbox_items WHERE watch_id = 'watch:unrelated-account'").get().status, "owed");

  await withCapturedProvider(async (sent) => {
    const result = await processAccountRollup(env, [
      { ...JSON.parse(SUBS._map[softwareKey]), key: softwareKey },
      { ...other, key: otherKey },
    ], ctx());
    assert.equal(result.sent, true);
    assert.equal(sent.length, 1);
    assert.match(sent[0].body.html, /SolarWinds Software Maintenance/);
    assert.equal(sqlite.prepare("SELECT status FROM digest_outbox_items WHERE watch_id = ? AND item_id = ?")
      .get(software.watch_id, `notice:${SOLARWINDS}`).status, "cancelled");
    assert.equal(sqlite.prepare("SELECT status FROM digest_outbox_items WHERE watch_id = ? AND item_id = ?")
      .get(other.watch_id, `notice:${SOLARWINDS}`).status, "delivered");
    assert.equal(sqlite.prepare("SELECT status FROM digest_outbox_items WHERE watch_id = 'watch:unrelated-account'").get().status, "owed");
  });
  sqlite.close();
});

test("A3 prefs upgrade and equivalent save keep identity, cadence, and delivered history", async () => {
  const { sqlite, DB } = makeDb();
  const key = "sub:upgrade-watch";
  const legacy = {
    email: EMAIL,
    lens: "money",
    filter: { keywords: ["software"], noticeType: "award" },
    freq: "weekly",
    channel: "email",
    lang: "en",
    createdAt: "2026-08-01T00:00:00.000Z",
  };
  const SUBS = kv({ [key]: JSON.stringify(legacy) });
  const env = envFor({ DB, SUBS });

  const upgraded = await prefsUpdate(env, key, { keywords: [], noticeType: "award", text_query: softwareQuery });
  assert.equal(upgraded.status, 200);
  const first = JSON.parse(SUBS._map[key]);
  assert.equal(first.watch_id, await deriveWatchId(key));
  assert.equal(first.subscriber_id, await deriveSubscriberId(EMAIL));
  assert.equal(first.freq, "weekly");
  assert.ok(SUBS._map[key]);
  const revision = first.query_revision;

  insertOwed(sqlite, {
    watchId: first.watch_id,
    subscriberId: first.subscriber_id,
    itemId: `notice:${E2_IDS[0]}`,
    payload: rowFor(E2_IDS[0]),
  });
  sqlite.prepare(`UPDATE digest_outbox_items SET status = 'delivered', delivered_at = ?, delivery_id = 'digest:prior'
    WHERE item_id = ?`).run("2026-08-20T13:00:00.000Z", `notice:${E2_IDS[0]}`);

  const duplicate = await prefsUpdate(env, key, {
    keywords: [],
    noticeType: "award",
    text_query: { version: 1, all: [[term("SOFTWARE")]] },
  });
  assert.equal(duplicate.status, 200);
  const second = JSON.parse(SUBS._map[key]);
  assert.equal(second.watch_id, first.watch_id);
  assert.equal(second.subscriber_id, first.subscriber_id);
  assert.equal(second.query_revision, revision);
  assert.equal(Object.keys(SUBS._map).filter((name) => name.startsWith("sub:")).length, 1);
  assert.equal(sqlite.prepare("SELECT status FROM digest_outbox_items WHERE item_id = ?").get(`notice:${E2_IDS[0]}`).status, "delivered");

  for (const id of E1_IDS.filter((value) => value !== E2_IDS[0])) {
    insertOwed(sqlite, {
      watchId: second.watch_id,
      subscriberId: second.subscriber_id,
      itemId: `notice:${id}`,
      payload: rowFor(id),
    });
  }
  const sendCtx = ctx();
  sendCtx.isMonday = true;
  await withCapturedProvider(async (sent) => {
    const result = await processOneSub(env, { ...second, key }, sendCtx);
    assert.equal(result.sent, true);
    assert.doesNotMatch(sent[0].body.html, /Komprise Multi-Year Software Renewal/);
    assert.equal(sqlite.prepare("SELECT status, delivered_at FROM digest_outbox_items WHERE item_id = ?")
      .get(`notice:${E2_IDS[0]}`).delivered_at, "2026-08-20T13:00:00.000Z");
  });
  sqlite.close();
});

test("A4 removing an exclusion restores cancelled membership; retry without an edit does not", async () => {
  const { sqlite, DB } = makeDb();
  const key = "sub:restore-watch";
  const record = await watchRecord({ key, filter: { text_query: softwareQuery } });
  const SUBS = kv({ [key]: JSON.stringify(record) });
  const env = envFor({ DB, SUBS });
  queueE1(sqlite, record);

  await prefsUpdate(env, key, { keywords: [], noticeType: "award", text_query: softwareNoMaint });
  assert.equal(statuses(sqlite, record.watch_id)[`notice:${SOLARWINDS}`], `cancelled:${QUERY_REVISION_SUPPRESSION}`);

  await enqueueEvaluatedSection(DB, {
    lens: "money",
    kind: "award",
    status: SECTION_STATUS.SUCCESS,
    freshRows: [rowFor(SOLARWINDS)],
  }, {
    watchId: record.watch_id,
    subscriberId: record.subscriber_id,
    now: NOW,
  });
  assert.equal(
    sqlite.prepare("SELECT status FROM digest_outbox_items WHERE item_id = ?").get(`notice:${SOLARWINDS}`).status,
    "cancelled",
    "ordinary retry must not resurrect a query-revision cancellation",
  );

  await prefsUpdate(env, key, { keywords: [], noticeType: "award", text_query: softwareQuery });
  assert.equal(statuses(sqlite, record.watch_id)[`notice:${SOLARWINDS}`], "owed");
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS n FROM digest_outbox_items WHERE watch_id = ? AND item_id = ?").get(record.watch_id, `notice:${SOLARWINDS}`).n,
    1,
    "restore is an in-place transition, not a second row",
  );
  sqlite.close();
});

test("A5 edit during preparation is reevaluated at the provider-submit cutoff; accepted mail is not recalled", async () => {
  const { sqlite, DB } = makeDb();
  const key = "sub:race-watch";
  const record = await watchRecord({ key, filter: { text_query: softwareQuery } });
  const SUBS = kv({ [key]: JSON.stringify(record) });
  queueE1(sqlite, record);
  const env = envFor({ DB, SUBS });
  const runCtx = ctx();
  runCtx.onBeforeQueryRevisionCutoff = async () => {
    await prefsUpdate(env, key, { keywords: [], noticeType: "award", text_query: softwareNoMaint });
  };

  await withCapturedProvider(async (sent) => {
    const result = await processOneSub(env, { ...record, key }, runCtx);
    assert.equal(result.sent, true);
    assert.equal(sent.length, 1);
    assert.ok(sent[0].idempotencyKey, "unchanged retries keep the reserved delivery id as Idempotency-Key");
    assert.doesNotMatch(sent[0].body.html, /SolarWinds Software Maintenance/);
    assert.match(sent[0].body.html, /Acronis Cyber Protection Software License/);
    assert.equal(QUERY_REVISION_CUTOFF, "before-provider-submit");
    assert.equal(sqlite.prepare("SELECT status FROM digest_outbox_items WHERE item_id = ?").get(`notice:${SOLARWINDS}`).status, "cancelled");
  });

  // After provider acceptance, a later exclusion does not recall delivered rows.
  const deliveredId = `notice:${E2_IDS[0]}`;
  assert.equal(sqlite.prepare("SELECT status FROM digest_outbox_items WHERE item_id = ?").get(deliveredId).status, "delivered");
  await prefsUpdate(env, key, { keywords: [], noticeType: "award", text_query: { version: 1, all: [[term("nope")]] } });
  assert.equal(sqlite.prepare("SELECT status FROM digest_outbox_items WHERE item_id = ?").get(deliveredId).status, "delivered");
  sqlite.close();
});

test("A6 paused/deleted controls, save failure, and single/rollup parity", async () => {
  const { sqlite, DB } = makeDb();
  const key = "sub:controls-watch";
  const record = await watchRecord({ key, filter: { text_query: softwareQuery } });
  const failingSubs = kv({ [key]: JSON.stringify(record) });
  const originalPut = failingSubs.put.bind(failingSubs);
  failingSubs.put = async () => { throw new Error("kv-unavailable"); };
  const failEnv = envFor({ DB, SUBS: failingSubs });
  const failed = await prefsUpdate(failEnv, key, { keywords: [], noticeType: "award", text_query: softwareNoMaint });
  assert.equal(failed.status, 400);
  const failBody = await failed.json();
  assert.equal(failBody.ok, false);
  assert.ok(failBody.submitted);
  assert.equal(failBody.submitted.filter.text_query.none[0].value, "maintenance");
  assert.equal(failBody.watch.key, key);
  assert.deepEqual(JSON.parse(failingSubs._map[key]).filter.text_query.all, softwareQuery.all);
  failingSubs.put = originalPut;

  queueE1(sqlite, record);
  const paused = { ...record, paused: true, key };
  const SUBS = kv({ [key]: JSON.stringify(paused) });
  const env = envFor({ DB, SUBS });
  await withCapturedProvider(async (sent) => {
    const result = await processOneSub(env, paused, ctx());
    assert.equal(result.skipped, "paused");
    assert.equal(sent.length, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM digest_outbox_items WHERE status = 'owed' AND watch_id = ?").get(record.watch_id).n, 4);
  });

  const token = await prefsToken();
  const deleted = await handlePrefs(new Request("https://api.cityscroll.org/prefs", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ token, action: "delete", key }),
  }), env);
  assert.equal(deleted.status, 200);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM digest_outbox_items WHERE status = 'owed' AND watch_id = ?").get(record.watch_id).n, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM digest_outbox_items WHERE status = 'cancelled' AND watch_id = ?").get(record.watch_id).n, 4);

  const rollupKeyA = "sub:parity-a";
  const rollupKeyB = "sub:parity-b";
  const a = await watchRecord({ key: rollupKeyA, filter: { text_query: softwareQuery } });
  const b = await watchRecord({
    key: rollupKeyB,
    filter: { text_query: softwareQuery },
    extra: { watch_id: await deriveWatchId(rollupKeyB) },
  });
  const rollupSubs = kv({
    [rollupKeyA]: JSON.stringify(a),
    [rollupKeyB]: JSON.stringify(b),
  });
  for (const id of E1_IDS) {
    insertOwed(sqlite, { watchId: a.watch_id, subscriberId: a.subscriber_id, itemId: `notice:${id}`, payload: rowFor(id) });
  }
  const rollupEnv = envFor({ DB, SUBS: rollupSubs });
  await prefsUpdate(rollupEnv, rollupKeyA, { keywords: [], noticeType: "award", text_query: softwareNoMaint });
  await withCapturedProvider(async (sent) => {
    const result = await processAccountRollup(rollupEnv, [
      { ...JSON.parse(rollupSubs._map[rollupKeyA]), key: rollupKeyA },
      { ...b, key: rollupKeyB },
    ], ctx());
    assert.equal(result.kind, "rollup");
    assert.equal(result.sent, true);
    assert.equal(sent.length, 1);
    assert.doesNotMatch(sent[0].body.html.split("parity")[0] || sent[0].body.html, /unused/);
    assert.equal(sqlite.prepare("SELECT status FROM digest_outbox_items WHERE watch_id = ? AND item_id = ?")
      .get(a.watch_id, `notice:${SOLARWINDS}`).status, "cancelled");
  });
  sqlite.close();
});

test("reconcile is a no-op without a database and never cancels another watch", async () => {
  const { sqlite, DB } = makeDb();
  const keep = await watchRecord({ key: "sub:keep", filter: { text_query: softwareQuery } });
  const change = await watchRecord({
    key: "sub:change",
    filter: { text_query: softwareNoMaint },
    extra: { watch_id: await deriveWatchId("sub:change") },
  });
  insertOwed(sqlite, {
    watchId: keep.watch_id,
    subscriberId: keep.subscriber_id,
    itemId: `notice:${SOLARWINDS}`,
    payload: rowFor(SOLARWINDS),
  });
  insertOwed(sqlite, {
    watchId: change.watch_id,
    subscriberId: change.subscriber_id,
    itemId: `notice:${SOLARWINDS}`,
    payload: rowFor(SOLARWINDS),
  });
  const withoutDb = await reconcileWatchOwedMembership(null, { watch: change });
  assert.equal(withoutDb.skipped, "no-db");
  await reconcileWatchOwedMembership(DB, { watch: change });
  assert.equal(statuses(sqlite, keep.watch_id)[`notice:${SOLARWINDS}`], "owed");
  assert.equal(statuses(sqlite, change.watch_id)[`notice:${SOLARWINDS}`], `cancelled:${QUERY_REVISION_SUPPRESSION}`);
  sqlite.close();
});
