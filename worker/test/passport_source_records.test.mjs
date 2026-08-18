// PASSPort immutable observation promotion without a City Record seed.
//
//   node --test worker/test/passport_source_records.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  ingestPassportPublic,
  passportSourceSystemId,
  PASSPORT_SOURCE_RECORD_DUAL_WRITE_FLAG,
} from "../src/passport.mjs";

const CROL_NEGATIVE_CONTRACT = [
  "CTR-NON-CROL-77", "84126P0001001", "CT1841260001", "Bridge inspection",
  "Transportation", "HNTB Corporation", "", "M/WBE Small Purchase", "Expense",
  "Registered", "$100", "$125", "$125", "$25", "07/01/2026", "06/30/2029",
  "07/20/2026", "Engineering", "", "", "", "",
];
const CROL_NEGATIVE_RFX = [
  "RFX-NON-CROL-88", "BPM-88", "", "Engineering", "84126P0001001",
  "Bridge inspection", "Transportation", "Released", "06/01/2026", "08/01/2026",
  "Engineering", "RFP",
];

function d1FromSqlite(db) {
  return {
    prepare(sql) {
      return {
        bind(...values) {
          const statement = db.prepare(sql);
          const args = values;
          return {
            async run() { statement.run(...args); return { success: true }; },
            async all() { return { results: statement.all(...args) }; },
            async first() { return statement.get(...args) ?? null; },
          };
        },
        async run() { db.prepare(sql).run(); return { success: true }; },
        async all() { return { results: db.prepare(sql).all() }; },
        async first() { return db.prepare(sql).get() ?? null; },
      };
    },
    async batch(statements) {
      for (const statement of statements) await statement.run();
      return [];
    },
  };
}

function database({ observations = true } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../migrations/0007_passport_public.sql", import.meta.url), "utf8"));
  if (observations) {
    sqlite.exec(readFileSync(new URL("../migrations/0008_source_records.sql", import.meta.url), "utf8"));
  }
  return { sqlite, DB: d1FromSqlite(sqlite) };
}

async function withPassportDumps(fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => new Response(
    String(url).includes("contractData")
      ? `var public_ctr_data = ${JSON.stringify([CROL_NEGATIVE_CONTRACT])};`
      : `var public_rfx_data = ${JSON.stringify([CROL_NEGATIVE_RFX])};`,
    { status: 200 },
  );
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("CROL-negative PASSPort rows promote with exact publisher identity", async () => {
  const { sqlite, DB } = database();
  await withPassportDumps(async () => {
    const result = await ingestPassportPublic({
      DB,
      [PASSPORT_SOURCE_RECORD_DUAL_WRITE_FLAG]: "true",
    });
    assert.equal(result.ok, true);
    assert.equal(result.contracts, 1);
    assert.equal(result.rfx, 1);

    const rows = sqlite.prepare(
      `SELECT source_system, source_system_id, raw_snapshot
         FROM source_records
        ORDER BY source_system`,
    ).all();
    assert.equal(rows.length, 2);
    const contract = rows.find((row) => row.source_system === "passport_public_contracts");
    const rfx = rows.find((row) => row.source_system === "passport_public_rfx");
    assert.equal(
      contract.source_system_id,
      passportSourceSystemId("contract", {
        epin: "84126P0001001",
        ctr_id: "CTR-NON-CROL-77",
      }),
    );
    assert.equal(
      rfx.source_system_id,
      passportSourceSystemId("rfx", {
        epin: "84126P0001001",
        rfp_id: "RFX-NON-CROL-88",
      }),
    );
    const snapshot = JSON.parse(contract.raw_snapshot);
    assert.equal(snapshot.ctr_id, "CTR-NON-CROL-77");
    assert.equal(snapshot.epin, "84126P0001001");
    assert.equal(snapshot.contract_id, "CT1841260001");

    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS n FROM passport_contracts").get().n,
      1,
    );
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS n FROM passport_rfx").get().n,
      1,
    );
  });
  sqlite.close();
});

test("PASSPort observation failure is fail-soft for product materialization", async () => {
  const { sqlite, DB } = database({ observations: false });
  await withPassportDumps(async () => {
    const result = await ingestPassportPublic({
      DB,
      [PASSPORT_SOURCE_RECORD_DUAL_WRITE_FLAG]: "true",
    });
    assert.equal(result.ok, true);
    assert.equal(
      sqlite.prepare("SELECT ctr_id FROM passport_contracts").get().ctr_id,
      "CTR-NON-CROL-77",
    );
    assert.equal(
      sqlite.prepare("SELECT rfp_id FROM passport_rfx").get().rfp_id,
      "RFX-NON-CROL-88",
    );
  });
  sqlite.close();
});
