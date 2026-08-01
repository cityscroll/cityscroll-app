import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  ingestPassportPublic,
  passportSourceSystemId,
} from "../src/passport.mjs";

const CONTRACT = [
  "CTR-77", "84126P0001001", "CT1841260001", "Bridge inspection", "Transportation",
  "HNTB Corporation", "", "Request for Proposals", "Expense", "Registered",
  "$100", "$125", "$125", "$25", "07/01/2026", "06/30/2029", "07/20/2026", "Engineering",
  "", "", "", "",
];
const RFX = [
  "RFX-88", "BPM-88", "", "Engineering", "84126P0001001", "Bridge inspection",
  "Transportation", "Released", "06/01/2026", "08/01/2026", "Engineering", "RFP",
];

const CONTRACT_DUMP = `var public_ctr_data = ${JSON.stringify([CONTRACT])};`;
const RFX_DUMP = `var public_rfx_data = ${JSON.stringify([RFX])};`;

function d1FromSqlite(db) {
  return {
    prepare(sql) {
      const statement = db.prepare(sql);
      let args = [];
      const wrapper = {
        bind(...values) { args = values; return wrapper; },
        async run() { statement.run(...args); return { success: true }; },
        async all() { return { results: statement.all(...args) }; },
        async first() { return statement.get(...args) ?? null; },
      };
      return wrapper;
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
    String(url).includes("contractData") ? CONTRACT_DUMP : RFX_DUMP,
    { status: 200, headers: { "last-modified": "Fri, 31 Jul 2026 12:00:00 GMT" } },
  );
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function currentRows(sqlite) {
  return {
    contracts: sqlite.prepare("SELECT epin, ctr_id, contract_id, title, agency, vendor, payload FROM passport_contracts ORDER BY epin, ctr_id").all(),
    rfx: sqlite.prepare("SELECT epin, rfp_id, procurement_name, agency, payload FROM passport_rfx ORDER BY epin, rfp_id").all(),
  };
}

test("PASSPort source keys follow materialization identity", () => {
  assert.equal(passportSourceSystemId("contract", { epin_norm: "84126P0001001", ctr_id: "CTR-77" }), "contract:84126P0001001:CTR-77");
  assert.equal(passportSourceSystemId("rfx", { epin_norm: "84126P0001001", rfp_id: "RFX-88" }), "rfx:84126P0001001:RFX-88");
});

test("PASSPort observation capture is explicitly enabled only for production", () => {
  const wrangler = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const [production, beta = ""] = wrangler.split("[env.beta.vars]");
  assert.match(production, /PASSPORT_SOURCE_RECORD_DUAL_WRITE\s*=\s*"true"/);
  assert.match(beta, /PASSPORT_SOURCE_RECORD_DUAL_WRITE\s*=\s*"false"/);
});

test("flag off preserves current PASSPort materialization without observations", async () => {
  const { sqlite, DB } = database();
  await withPassportDumps(async () => {
    const result = await ingestPassportPublic({ DB });
    assert.equal(result.ok, true);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM source_records").get().n, 0);
    assert.equal(currentRows(sqlite).contracts.length, 1);
    assert.equal(currentRows(sqlite).rfx.length, 1);
  });
  sqlite.close();
});

test("flag on adds stable immutable observations and repeat ingest does not duplicate them", async () => {
  const { sqlite, DB } = database();
  await withPassportDumps(async () => {
    await ingestPassportPublic({ DB });
    const before = currentRows(sqlite);

    const env = { DB, PASSPORT_SOURCE_RECORD_DUAL_WRITE: "true" };
    await ingestPassportPublic(env);
    const after = currentRows(sqlite);
    assert.deepEqual(after, before);

    const first = sqlite.prepare("SELECT source_system, source_system_id, content_hash FROM source_records ORDER BY source_system").all();
    assert.equal(first.length, 2);
    assert.deepEqual(first.map((row) => row.source_system), ["passport_public_contracts", "passport_public_rfx"]);

    await ingestPassportPublic(env);
    const replay = sqlite.prepare("SELECT source_system, source_system_id, content_hash FROM source_records ORDER BY source_system").all();
    assert.deepEqual(replay, first);
  });
  sqlite.close();
});

test("observation failure remains fail-soft for current PASSPort consumers", async () => {
  const { sqlite, DB } = database({ observations: false });
  await withPassportDumps(async () => {
    const result = await ingestPassportPublic({ DB, PASSPORT_SOURCE_RECORD_DUAL_WRITE: "true" });
    assert.equal(result.ok, true);
    assert.equal(currentRows(sqlite).contracts.length, 1);
    assert.equal(currentRows(sqlite).rfx.length, 1);
  });
  sqlite.close();
});
