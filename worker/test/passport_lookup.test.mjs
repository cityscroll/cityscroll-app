// Regression: PASSPort D1 lookup honesty when the materialization path fails.
//
// Reproduces the production failure shape from 2026-07-30: missing passport_*
// tables (migrations never applied) threw on every SELECT, and the silent catch
// marked lookup_status contracts/rfx = "error" for ~75% of money notices.
//
// Three-state honesty:
//   - ok: query succeeded (empty rows are genuine unmatched, not operational failure)
//   - error: query/schema failure → unavailable register, never confident empty
//   - skipped: no DB or no PIN
//
//   node --test test/passport_lookup.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ensurePassportSchema,
  lookupPassportForPin,
} from "../src/passport.mjs";
import { enrichLifecycleWithPassport } from "../src/lib/passport_lifecycle.mjs";
import { assembleLifecycle } from "../src/lib/checkbook_lifecycle.mjs";

/** In-memory D1 stub that tracks tables and can simulate missing-schema errors. */
function fakePassportDB({ missingTables = false, rowsByTable = {} } = {}) {
  const tables = new Set(missingTables ? [] : ["passport_contracts", "passport_rfx", "passport_ingest_meta"]);
  const store = {
    passport_contracts: rowsByTable.passport_contracts || [],
    passport_rfx: rowsByTable.passport_rfx || [],
  };

  function prepare(sql) {
    const q = String(sql);
    return {
      _sql: q,
      _args: [],
      bind(...a) {
        this._args = a;
        return this;
      },
      async all() {
        if (/passport_contracts/.test(q) && !tables.has("passport_contracts")) {
          throw new Error("D1_ERROR: no such table: passport_contracts: SQLITE_ERROR");
        }
        if (/passport_rfx/.test(q) && !tables.has("passport_rfx")) {
          throw new Error("D1_ERROR: no such table: passport_rfx: SQLITE_ERROR");
        }
        if (/CREATE TABLE/i.test(q) || /CREATE INDEX/i.test(q)) {
          return { results: [] };
        }
        const table = /FROM passport_contracts/.test(q)
          ? "passport_contracts"
          : /FROM passport_rfx/.test(q)
            ? "passport_rfx"
            : null;
        if (!table) return { results: [] };

        let rows = store[table] || [];
        // Exact match on epin_norm = ?
        if (/epin_norm = \?/.test(q)) {
          const want = this._args[0];
          rows = rows.filter((r) => r.epin_norm === want);
        }
        // LIKE prefix
        if (/epin_norm LIKE \?/.test(q)) {
          const like = String(this._args[0] || "").replace(/%/g, "");
          rows = rows.filter((r) => String(r.epin_norm).startsWith(like));
        }
        return {
          results: rows.slice(0, 25).map((r) => ({
            payload: JSON.stringify(r),
            epin_norm: r.epin_norm,
          })),
        };
      },
      async run() {
        if (/CREATE TABLE IF NOT EXISTS passport_contracts/.test(q)) {
          tables.add("passport_contracts");
        }
        if (/CREATE TABLE IF NOT EXISTS passport_rfx/.test(q)) {
          tables.add("passport_rfx");
        }
        if (/CREATE TABLE IF NOT EXISTS passport_ingest_meta/.test(q)) {
          tables.add("passport_ingest_meta");
        }
        return { success: true };
      },
      async first() {
        const all = await this.all();
        return all.results?.[0] || null;
      },
    };
  }

  return {
    _tables: tables,
    prepare,
    async batch(stmts) {
      for (const s of stmts) {
        if (typeof s.run === "function") await s.run();
        else if (s?._sql) await prepare(s._sql).run();
      }
      return [];
    },
  };
}

test("missing passport tables: ensurePassportSchema creates them", async () => {
  const db = fakePassportDB({ missingTables: true });
  assert.equal(db._tables.has("passport_contracts"), false);
  const r = await ensurePassportSchema({ DB: db });
  assert.equal(r.ok, true);
  assert.equal(db._tables.has("passport_contracts"), true);
  assert.equal(db._tables.has("passport_rfx"), true);
});

test("lookup after schema ensure on empty tables returns ok, not error", async () => {
  // Reproduced failure: SELECT threw "no such table" → lookup_status error.
  // After ensure, empty tables are a successful miss (source coverage), not ops failure.
  const db = fakePassportDB({ missingTables: true });
  const out = await lookupPassportForPin({ DB: db }, "84125B0005001");
  assert.deepEqual(out.lookupStatus, { contracts: "ok", rfx: "ok" });
  assert.equal(out.contracts.length, 0);
  assert.equal(out.rfx.length, 0);
  assert.equal(out.lookupError, undefined);
});

test("lookup exact EPIN hit returns contracts with ok status", async () => {
  const row = {
    epin: "84125B0005001",
    epin_norm: "84125B0005001",
    status: "Registered",
    vendor: "IBI ARMORED SERVICES, INC",
    contract_id: "CT184120278800998",
  };
  const db = fakePassportDB({
    rowsByTable: { passport_contracts: [row], passport_rfx: [] },
  });
  const out = await lookupPassportForPin({ DB: db }, "84125B0005001");
  assert.deepEqual(out.lookupStatus, { contracts: "ok", rfx: "ok" });
  assert.equal(out.contracts.length, 1);
  assert.equal(out.contracts[0].vendor, "IBI ARMORED SERVICES, INC");
  assert.deepEqual(out.contractJoin, { method: "exact", epin: "84125B0005001" });
});

test("lookup without DB is skipped, not error", async () => {
  const out = await lookupPassportForPin({}, "84125B0005001");
  assert.deepEqual(out.lookupStatus, { contracts: "skipped", rfx: "skipped" });
});

test("query failure mid-lookup surfaces error status (not confident empty)", async () => {
  const db = {
    prepare(sql) {
      return {
        bind() { return this; },
        async all() {
          throw new Error("D1_ERROR: database is locked");
        },
        async run() { return { success: true }; },
      };
    },
    async batch() {
      // schema ensure succeeds so we reach the query path
      return [];
    },
  };
  // ensurePassportSchema uses batch of prepares with run — stub needs run on prepare
  db.prepare = function (sql) {
    const q = String(sql);
    return {
      bind() { return this; },
      async all() {
        if (/CREATE/i.test(q)) return { results: [] };
        throw new Error("D1_ERROR: database is locked");
      },
      async run() { return { success: true }; },
    };
  };
  const out = await lookupPassportForPin({ DB: db }, "84125B0005001");
  assert.deepEqual(out.lookupStatus, { contracts: "error", rfx: "error" });
  assert.equal(out.contracts.length, 0);
  assert.ok(out.lookupError);
});

test("enrichment on lookup error marks pending/registered unavailable, not gap_sources miss", () => {
  const notice = {
    request_id: "20260724012",
    pin: "84125B0005001",
    agency_name: "Transportation",
    type_of_notice_description: "Award",
    short_title: "Armored Car",
    start_date: "2026-07-24",
    contract_amount: 1,
    vendor_name: "IBI",
  };
  const base = assembleLifecycle(notice, [], [], [], {
    pinStrategy: "exact",
    lookupStatus: { pending: "ok", registered: "ok", spending: "ok" },
  });
  const enriched = enrichLifecycleWithPassport(base, notice, {
    contracts: [],
    rfx: [],
    lookupStatus: { contracts: "error", rfx: "error" },
  });
  assert.deepEqual(enriched.passport.lookup_status, {
    contracts: "error",
    rfx: "error",
  });
  const pending = enriched.timeline.find((e) => e.stage === "pending");
  const registered = enriched.timeline.find((e) => e.stage === "registered");
  // Must not claim "we searched PASSPort and found nothing" when lookup failed.
  assert.equal(pending.passport_lookup, "unavailable");
  assert.equal(registered.passport_lookup, "unavailable");
  assert.ok(!pending.gap_sources?.includes("passport-public-contracts"));
});

test("enrichment on lookup error marks solicitation RFx unavailable (not unknown empty)", () => {
  const notice = {
    request_id: "20260701001",
    pin: "81026B0003",
    agency_name: "DOE",
    type_of_notice_description: "Solicitation",
    short_title: "Test RFx",
    start_date: "2026-07-01",
  };
  const base = assembleLifecycle(notice, [], [], [], {
    pinStrategy: "exact",
    lookupStatus: { pending: "ok", registered: "ok", spending: "ok" },
  });
  const enriched = enrichLifecycleWithPassport(base, notice, {
    contracts: [],
    rfx: [],
    lookupStatus: { contracts: "error", rfx: "error" },
  });
  const sol = enriched.timeline.find((e) => e.stage === "solicitation");
  assert.ok(sol);
  assert.equal(sol.rfx?.status, "unavailable");
  assert.equal(sol.passport_lookup, "unavailable");
});
