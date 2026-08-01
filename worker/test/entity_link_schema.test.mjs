// er-07: entity_link + resolution_run schema dual-write (opt-in, no consumers).
//
//   node --test test/entity_link_schema.test.mjs   (from crol-list/worker/)
//
// Asserts migration columns exist (real SQLite apply) and the shadow writer
// only emits exact-stem auto_link rows when ENTITY_LINK_DUAL_WRITE is true.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import {
  CANONICAL_ENTITY_COLUMNS,
  DECISION,
  ENTITY_LINK_COLUMNS,
  ENTITY_LINK_DUAL_WRITE_FLAG,
  EXACT_STEM_AUTO_CONFIDENCE,
  RESOLUTION_RUN_COLUMNS,
  buildExactStemAutoCase,
  canonicalVendorIdForStem,
  ensureEntityLinkSchema,
  entityLinkDualWriteEnabled,
  shadowWriteExactStemAutoLinks,
} from "../src/lib/entity_link.mjs";
import {
  VENDOR_STEM_METHOD,
  VENDOR_STEM_VERSION,
  vendorStem,
} from "../src/lib/normalize.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = join(__dirname, "../migrations/0009_entity_link.sql");

function tableColumns(db, table) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => row.name);
}

function applyMigrationSql(db, sql) {
  db.exec(sql);
}

/** Minimal D1-shaped adapter over node:sqlite for the shadow writer. */
function d1FromSqlite(db) {
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        bind(...args) {
          return {
            async run() {
              stmt.run(...args);
              return { success: true };
            },
            async first() {
              return stmt.get(...args) ?? null;
            },
            async all() {
              return { results: stmt.all(...args) };
            },
          };
        },
        async run() {
          stmt.run();
          return { success: true };
        },
        async first() {
          return stmt.get() ?? null;
        },
        async all() {
          return { results: stmt.all() };
        },
      };
    },
    async batch(stmts) {
      for (const s of stmts) {
        await s.run();
      }
      return [];
    },
  };
}

test("migration 0009 defines resolution_run, canonical_entity, and entity_link with required columns", () => {
  const sql = readFileSync(MIGRATION_PATH, "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS resolution_run/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS canonical_entity/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS entity_link/);

  const db = new DatabaseSync(":memory:");
  applyMigrationSql(db, sql);

  const runCols = tableColumns(db, "resolution_run");
  for (const col of RESOLUTION_RUN_COLUMNS) {
    assert.ok(runCols.includes(col), `resolution_run missing column ${col}`);
  }

  const linkCols = tableColumns(db, "entity_link");
  for (const col of ENTITY_LINK_COLUMNS) {
    assert.ok(linkCols.includes(col), `entity_link missing column ${col}`);
  }

  const canonCols = tableColumns(db, "canonical_entity");
  for (const col of CANONICAL_ENTITY_COLUMNS) {
    assert.ok(canonCols.includes(col), `canonical_entity missing column ${col}`);
  }

  db.close();
});

test("entityLinkDualWriteEnabled is false unless flag is exactly true", () => {
  assert.equal(entityLinkDualWriteEnabled({}), false);
  assert.equal(entityLinkDualWriteEnabled({ [ENTITY_LINK_DUAL_WRITE_FLAG]: "false" }), false);
  assert.equal(entityLinkDualWriteEnabled({ [ENTITY_LINK_DUAL_WRITE_FLAG]: "1" }), false);
  assert.equal(entityLinkDualWriteEnabled({ [ENTITY_LINK_DUAL_WRITE_FLAG]: "true" }), true);
  assert.equal(entityLinkDualWriteEnabled({ [ENTITY_LINK_DUAL_WRITE_FLAG]: "TRUE" }), true);
});

test("buildExactStemAutoCase: empty / blank names are not auto cases", () => {
  assert.equal(buildExactStemAutoCase({ source_record_id: "sr1", vendor_name: "" }), null);
  assert.equal(buildExactStemAutoCase({ source_record_id: "sr1", vendor_name: null }), null);
  assert.equal(buildExactStemAutoCase({ source_record_id: "", vendor_name: "Acme Inc" }), null);
});

test("buildExactStemAutoCase: suffix variants share stem, method, and auto_link decision", () => {
  const a = buildExactStemAutoCase({
    source_record_id: "city_record:20260701001:abc",
    vendor_name: "Sinergia Inc",
  });
  const b = buildExactStemAutoCase({
    source_record_id: "city_record:20260701002:def",
    vendor_name: "Sinergia Incorporated",
  });
  assert.ok(a);
  assert.ok(b);
  assert.equal(a.decision, DECISION.AUTO_LINK);
  assert.equal(a.method, VENDOR_STEM_METHOD);
  assert.equal(a.matcher_version, VENDOR_STEM_VERSION);
  assert.equal(a.confidence, EXACT_STEM_AUTO_CONFIDENCE);
  assert.equal(a.stem, vendorStem("Sinergia Inc"));
  assert.equal(a.stem, b.stem);
  assert.equal(a.canonical_entity_id, b.canonical_entity_id);
  assert.equal(a.canonical_entity_id, canonicalVendorIdForStem("SINERGIA"));
});

test("shadow writer: flag off writes nothing", async () => {
  const db = new DatabaseSync(":memory:");
  applyMigrationSql(db, readFileSync(MIGRATION_PATH, "utf8"));
  const env = { DB: d1FromSqlite(db) };
  const result = await shadowWriteExactStemAutoLinks(env, [
    { source_record_id: "sr-a", vendor_name: "Sinergia Inc" },
  ]);
  assert.equal(result.skipped, "flag-off");
  assert.equal(result.written, 0);
  const links = db.prepare("SELECT COUNT(*) AS n FROM entity_link").get();
  assert.equal(links.n, 0);
  const runs = db.prepare("SELECT COUNT(*) AS n FROM resolution_run").get();
  assert.equal(runs.n, 0);
  db.close();
});

test("shadow writer: flag on writes exact-stem auto_link only (one run, shared canonical)", async () => {
  const db = new DatabaseSync(":memory:");
  applyMigrationSql(db, readFileSync(MIGRATION_PATH, "utf8"));
  const env = {
    DB: d1FromSqlite(db),
    [ENTITY_LINK_DUAL_WRITE_FLAG]: "true",
  };
  const now = "2026-07-31T12:00:00.000Z";
  const result = await shadowWriteExactStemAutoLinks(
    env,
    [
      { source_record_id: "sr-a", vendor_name: "Sinergia Inc" },
      { source_record_id: "sr-b", vendor_name: "Sinergia Incorporated" },
      { source_record_id: "sr-c", vendor_name: "Acme Construction LLC" },
      { source_record_id: "sr-empty", vendor_name: "" },
    ],
    { now, scope_note: "unit-test exact-stem" },
  );

  assert.equal(result.skipped, undefined);
  assert.equal(result.considered, 4);
  assert.equal(result.eligible, 3);
  assert.equal(result.written, 3);
  assert.equal(result.method, VENDOR_STEM_METHOD);
  assert.equal(result.matcher_version, VENDOR_STEM_VERSION);
  assert.ok(result.run_id);

  const runs = db.prepare("SELECT * FROM resolution_run").all();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].method, VENDOR_STEM_METHOD);
  assert.equal(runs[0].matcher_version, VENDOR_STEM_VERSION);
  assert.equal(runs[0].status, "completed");
  assert.equal(runs[0].entity_type, "vendor");
  const runMetrics = JSON.parse(runs[0].metrics_json);
  assert.deepEqual(runMetrics.decisions, {
    auto_link: 3,
    separate: 0,
    review: 0,
    never_auto: 0,
  });
  assert.deepEqual(runMetrics.score_distribution, {
    population: "eligible_exact_stem_links",
    count: 3,
    minimum: 1,
    p50: 1,
    p90: 1,
    maximum: 1,
    buckets: {
      "[0,0.5)": 0,
      "[0.5,0.8)": 0,
      "[0.8,0.9)": 0,
      "[0.9,0.95)": 0,
      "[0.95,1]": 3,
    },
  });

  const links = db.prepare("SELECT * FROM entity_link ORDER BY source_record_id").all();
  assert.equal(links.length, 3);
  for (const link of links) {
    assert.equal(link.decision, DECISION.AUTO_LINK);
    assert.equal(link.method, VENDOR_STEM_METHOD);
    assert.equal(link.matcher_version, VENDOR_STEM_VERSION);
    assert.equal(link.confidence, EXACT_STEM_AUTO_CONFIDENCE);
    assert.equal(link.resolution_run_id, result.run_id);
    assert.equal(link.review_status, null);
    const evidence = JSON.parse(link.evidence_json);
    assert.equal(evidence.match, "exact_stem");
    assert.ok(evidence.stem);
  }

  // Two Sinergia spellings share one canonical; Acme is distinct.
  const canonIds = new Set(links.map((l) => l.canonical_entity_id));
  assert.equal(canonIds.size, 2);
  assert.ok(canonIds.has(canonicalVendorIdForStem("SINERGIA")));
  assert.ok(canonIds.has(canonicalVendorIdForStem(vendorStem("Acme Construction LLC"))));

  const entities = db.prepare("SELECT * FROM canonical_entity").all();
  assert.equal(entities.length, 2);
  assert.ok(entities.every((e) => e.entity_type === "vendor"));

  db.close();
});

test("shadow writer: repeat call is idempotent under UNIQUE (no duplicate links)", async () => {
  const db = new DatabaseSync(":memory:");
  applyMigrationSql(db, readFileSync(MIGRATION_PATH, "utf8"));
  const env = {
    DB: d1FromSqlite(db),
    [ENTITY_LINK_DUAL_WRITE_FLAG]: "true",
  };
  const obs = [{ source_record_id: "sr-a", vendor_name: "CAMBA, Inc." }];
  await shadowWriteExactStemAutoLinks(env, obs, { now: "2026-07-31T12:00:00.000Z" });
  await shadowWriteExactStemAutoLinks(env, obs, { now: "2026-07-31T12:00:00.000Z" });
  const links = db.prepare("SELECT COUNT(*) AS n FROM entity_link").get();
  assert.equal(links.n, 1);
  db.close();
});

test("ensureEntityLinkSchema creates tables when migration was not applied", async () => {
  const db = new DatabaseSync(":memory:");
  const env = { DB: d1FromSqlite(db) };
  const r = await ensureEntityLinkSchema(env);
  assert.equal(r.ok, true);
  for (const col of ENTITY_LINK_COLUMNS) {
    assert.ok(tableColumns(db, "entity_link").includes(col), col);
  }
  for (const col of RESOLUTION_RUN_COLUMNS) {
    assert.ok(tableColumns(db, "resolution_run").includes(col), col);
  }
  db.close();
});
