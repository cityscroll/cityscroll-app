/**
 * D1 migration sequence must succeed against both a fresh database and a
 * production-shaped database that already carries encumbered_amount outside
 * d1_migrations (the Worker ensurePassportSchemaOnce safety net).
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(ROOT, "worker/migrations");

let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {}

function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
}

function applyMigrations(db, names) {
  for (const name of names) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
    db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(name);
  }
}

function ensureMigrationsTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
}

function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
}

function tableNames(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
}

test("all migrations apply cleanly to a fresh database", { skip: !DatabaseSync }, () => {
  const db = new DatabaseSync(":memory:");
  ensureMigrationsTable(db);
  const names = migrationFiles();
  assert.ok(names.includes("0007_passport_public.sql"));
  assert.ok(names.includes("0032_passport_action_families.sql"));
  applyMigrations(db, names);

  const columns = columnNames(db, "passport_contracts");
  assert.ok(columns.includes("encumbered_amount"), "fresh DB must define encumbered_amount");
  assert.ok(tableNames(db).includes("d1_publication_batches"));
  assert.ok(tableNames(db).includes("ops_emergency_deliveries"));
  assert.ok(tableNames(db).includes("digest_shadow_rebuild_runs"));
  const recorded = db.prepare("SELECT name FROM d1_migrations ORDER BY id").all().map((row) => row.name);
  assert.deepEqual(recorded, names);
});

test("migrations succeed when encumbered_amount already exists outside d1_migrations", { skip: !DatabaseSync }, () => {
  const db = new DatabaseSync(":memory:");
  ensureMigrationsTable(db);
  const names = migrationFiles();
  const before0032 = names.filter((name) => name < "0032_passport_action_families.sql");
  const from0032 = names.filter((name) => name >= "0032_passport_action_families.sql");

  // Simulate production before the backlog: 0001..0031 applied from the historical
  // 0007 shape (no encumbered_amount in CREATE), then the Worker safety net added
  // the column without recording 0032 in d1_migrations.
  for (const name of before0032) {
    if (name === "0007_passport_public.sql") {
      db.exec(`
        CREATE TABLE IF NOT EXISTS passport_contracts (
          epin TEXT NOT NULL,
          epin_norm TEXT NOT NULL,
          ctr_id TEXT,
          contract_id TEXT,
          title TEXT,
          agency TEXT,
          vendor TEXT,
          status TEXT,
          procurement_method TEXT,
          contract_type TEXT,
          award_amount REAL,
          current_amount REAL,
          paid_amount REAL,
          start_date TEXT,
          end_date TEXT,
          registration_date TEXT,
          payload TEXT,
          ingested_at TEXT NOT NULL,
          PRIMARY KEY (epin_norm, ctr_id)
        );
        CREATE INDEX IF NOT EXISTS idx_passport_contracts_epin ON passport_contracts(epin_norm);
        CREATE INDEX IF NOT EXISTS idx_passport_contracts_status ON passport_contracts(status);
        CREATE TABLE IF NOT EXISTS passport_rfx (
          epin TEXT NOT NULL,
          epin_norm TEXT NOT NULL,
          rfp_id TEXT,
          procurement_name TEXT,
          agency TEXT,
          rfx_status TEXT,
          release_date TEXT,
          due_date TEXT,
          procurement_method TEXT,
          main_commodity TEXT,
          industry TEXT,
          payload TEXT,
          ingested_at TEXT NOT NULL,
          PRIMARY KEY (epin_norm, rfp_id)
        );
        CREATE INDEX IF NOT EXISTS idx_passport_rfx_epin ON passport_rfx(epin_norm);
        CREATE TABLE IF NOT EXISTS passport_ingest_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    } else {
      db.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
    }
    db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(name);
  }
  db.exec("ALTER TABLE passport_contracts ADD COLUMN encumbered_amount REAL");
  assert.ok(columnNames(db, "passport_contracts").includes("encumbered_amount"));

  assert.doesNotThrow(() => applyMigrations(db, from0032));
  assert.ok(columnNames(db, "passport_contracts").includes("encumbered_amount"));
  assert.ok(tableNames(db).includes("ops_emergency_deliveries"));
  assert.ok(tableNames(db).includes("digest_shadow_rebuild_runs"));
  const recorded = db.prepare("SELECT name FROM d1_migrations WHERE name >= '0032_passport_action_families.sql' ORDER BY id")
    .all()
    .map((row) => row.name);
  assert.deepEqual(recorded, from0032);
});

test("deploy workflow applies migrations without snapshot or fence gates", () => {
  const workflow = readFileSync(join(ROOT, ".github/workflows/deploy-worker.yml"), "utf8");
  const start = workflow.indexOf("- name: Apply D1 migrations");
  assert.ok(start >= 0);
  const end = workflow.indexOf("\n      - name:", start + 1);
  const step = workflow.slice(start, end === -1 ? undefined : end);
  assert.match(step, /d1 migrations apply crol-notices --remote/);
  assert.doesNotMatch(
    step,
    /if:[\s\S]*(d1-publication-gate|d1-prior-snapshot|d1-generation-claim)/,
  );
  assert.ok(
    start < workflow.indexOf("- name: Claim D1 publication generation"),
    "migrations must run before the generation claim",
  );
  assert.ok(
    start < workflow.indexOf("- name: Read prior published D1 snapshot"),
    "migrations must run before prior-snapshot reads",
  );
});
