import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { processOneSub } from "../src/alerts.mjs";
import { compileSub, useProcurementDigestSnapshot } from "../src/lib/compile.mjs";
import { sanitize } from "../src/lib/filter.mjs";
import { buildSharedProcurementReadModel } from "../../site/shared_procurement_read_model.mjs";
import { buildProcurementDigestSnapshot } from "../../site/procurement_digest_compile.mjs";
import { evaluateProcurementProcessWatch } from "../../site/procurement_process_watch.mjs";
import { extractLensIdentity } from "../src/lib/digest_outbox.mjs";

const migration = readFileSync(new URL("../migrations/0018_digest_outbox.sql", import.meta.url), "utf8");
const DAY = "2026-08-18";
const PROCUREMENT_ID = "procurement:contract:CTWATCH";
const AGENCY = "Department of Transportation";

function sourceRecord(sourceSystemId, snapshot) {
  return {
    source_system: "passport_public_contracts",
    source_system_id: sourceSystemId,
    content_hash: `hash:${sourceSystemId}`,
    normalized_snapshot: JSON.stringify(snapshot),
    raw_snapshot: JSON.stringify(snapshot),
    ingested_at: "2026-08-18T19:46:32Z",
  };
}

const PENDING = sourceRecord("contract:EPINWATCH:CTR-1", {
  ctr_id: "CTR-1",
  epin: "EPIN-WATCH",
  contract_id: "CT-WATCH",
  title: "Bridge inspection program",
  agency_name: AGENCY,
  status: "Pending Registration Package Compilation",
  status_date: "2026-12-04",
});

const REGISTERED = sourceRecord("contract:EPINWATCH:CTR-2", {
  ctr_id: "CTR-2",
  epin: "EPIN-WATCH",
  contract_id: "CT-WATCH",
  title: "Bridge inspection program",
  agency_name: AGENCY,
  status: "Registered",
  registration_date: "2027-01-17",
});

function snapshotFor(records) {
  return buildProcurementDigestSnapshot(buildSharedProcurementReadModel({
    sourceRecords: records,
    generatedAt: "2026-08-18T20:00:00Z",
  }));
}

function kv() {
  const values = new Map();
  return {
    async get(key) { return values.get(key) || null; },
    async put(key, value) { values.set(key, String(value)); },
    async delete(key) { values.delete(key); },
    async list() { return { keys: [], list_complete: true }; },
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

function makeDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(migration);
  return { sqlite, DB: d1(sqlite) };
}

function watch(filter) {
  return {
    key: "sub:procurement-process",
    email: "owed@example.com",
    lens: "money",
    filter,
    freq: "daily",
    channel: "email",
    lang: "en",
    subscriber_id: "subscriber:test",
    watch_id: "watch:procurement-process",
    createdAt: "2026-08-01T00:00:00.000Z",
  };
}

function runCtx(day = DAY) {
  let sends = 0;
  return {
    FROM: "CityScroll <alerts@cityscroll.org>",
    LIVE: true,
    today: day,
    now: new Date(`${day}T13:00:00.000Z`),
    isMonday: false,
    heartbeatDays: 14,
    counts: () => ({ "per-run": sends, daily: sends }),
    caps: { "per-run": 25, daily: 50 },
    onSent: async () => { sends++; },
    capturePreviews: true,
  };
}

function env(DB, ALERT_STATE) {
  return {
    DB,
    ALERT_STATE,
    ALERTS_LIVE: "true",
    RESEND_API_KEY: "test",
    TOKEN_SECRET: "s".repeat(32),
    CONFIRM_BASE: "https://api.cityscroll.org",
    MAX_PER_RUN: "25",
    MAX_SENDS_PER_DAY: "50",
  };
}

async function withFetch(fn) {
  const original = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, options) => {
    const target = String(url);
    if (target.includes("api.resend.com/emails")) {
      sent.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ id: "provider:test" }) };
    }
    return { ok: true, json: async () => [] };
  };
  try { return await fn(sent); } finally { globalThis.fetch = original; }
}

test("a known process state compiles the canonical procurement projection without an amount", () => {
  const filter = sanitize("money", { processState: "registered" });
  assert.equal(filter.processState, "registered");
  const compiled = compileSub({ lens: "money", filter }, DAY);
  assert.equal(compiled.idField, "digest_id");
  const restore = useProcurementDigestSnapshot(snapshotFor([PENDING, REGISTERED]));
  try {
    const rows = compiled.mergeRows([]);
    assert.deepEqual(rows.map((row) => row.procurement_id), [PROCUREMENT_ID]);
    assert.deepEqual([...rows[0].process_states], ["pending_registration", "registered"]);
  } finally {
    restore();
  }
});

test("an unobserved state selects nothing rather than widening the watch", () => {
  const restore = useProcurementDigestSnapshot(snapshotFor([PENDING]));
  try {
    for (const processState of ["registered", "payment", "closed"]) {
      const compiled = compileSub({ lens: "money", filter: sanitize("money", { processState }) }, DAY);
      assert.deepEqual(compiled.mergeRows([]), []);
    }
  } finally {
    restore();
  }
});

test("a delivered transition is identified by its own stable deduplication key", () => {
  const seen = new Set();
  const pendingRows = buildProcurementDigestSnapshot(buildSharedProcurementReadModel({
    sourceRecords: [PENDING],
    generatedAt: "2026-08-18T20:00:00Z",
  })).rows;
  for (const id of evaluateProcurementProcessWatch(pendingRows, seen).markSeenIds) seen.add(id);
  const advanced = evaluateProcurementProcessWatch(buildProcurementDigestSnapshot(buildSharedProcurementReadModel({
    sourceRecords: [PENDING, REGISTERED],
    generatedAt: "2026-08-18T20:00:00Z",
  })).rows, seen).rows[0];
  const identity = extractLensIdentity({ lens: "money", row: advanced, kind: "award" });
  assert.equal(identity.identityField, "transition_key");
  assert.equal(identity.itemId, advanced.procurement_process_watch.transition.transition_key);

  // Without a transition the row keeps the canonical procurement delivery identity.
  const plain = extractLensIdentity({ lens: "money", row: pendingRows[0], kind: "award" });
  assert.equal(plain.identityField, "procurement_id");
  assert.equal(plain.itemId, PROCUREMENT_ID);
});

test("a later registered observation delivers one Following transition and never repeats", async () => {
  const { sqlite, DB } = makeDb();
  const state = kv();
  const sub = watch(sanitize("money", { noticeType: "award", agency: AGENCY }));
  try {
    // The object is first delivered while the publisher still reports pending registration.
    let restore = useProcurementDigestSnapshot(snapshotFor([PENDING]));
    await withFetch(async (sent) => {
      const result = await processOneSub(env(DB, state), sub, runCtx());
      assert.equal(result.error, undefined, result.error || "no error");
      assert.equal(result.new, 1);
      assert.deepEqual(result.noticeIds, [PROCUREMENT_ID]);
      assert.equal(sent.length, 1);
    });
    restore();

    // Refreshing the same observation is inert: no clock, no expiry, no repeat.
    restore = useProcurementDigestSnapshot(snapshotFor([PENDING]));
    await withFetch(async (sent) => {
      const result = await processOneSub(env(DB, state), sub, runCtx("2026-08-19"));
      assert.equal(result.new, 0);
      assert.equal(sent.some((email) => /Bridge inspection program/.test(email.html)), false);
    });
    restore();

    // A later source-backed registered observation is the transition.
    restore = useProcurementDigestSnapshot(snapshotFor([PENDING, REGISTERED]));
    await withFetch(async (sent) => {
      const result = await processOneSub(env(DB, state), sub, runCtx("2026-08-20"));
      assert.equal(result.error, undefined, result.error || "no error");
      assert.equal(result.new, 1);
      assert.deepEqual(result.noticeIds, [PROCUREMENT_ID]);
      assert.equal(sent.length, 1);
      assert.match(sent[0].html, /Bridge inspection program/);
    });
    restore();

    // The same pair of observations, seen again, delivers nothing further.
    restore = useProcurementDigestSnapshot(snapshotFor([PENDING, REGISTERED]));
    await withFetch(async (sent) => {
      const result = await processOneSub(env(DB, state), sub, runCtx("2026-08-21"));
      assert.equal(result.new, 0);
      assert.equal(sent.some((email) => /Bridge inspection program/.test(email.html)), false);
    });
    restore();
  } finally {
    sqlite.close();
  }
});
