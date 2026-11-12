// Ingest records RFx commodity category coverage in passport_ingest_meta.
//
//   node --test worker/test/passport_category_coverage_ingest.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { ingestPassportPublic, readPassportIngestMeta } from "../src/passport.mjs";

const SAMPLE = readFileSync(new URL("../../test/fixtures/passport/rfx_commodity_sample.js", import.meta.url), "utf8");
const CONTRACT = [
  "CTR-1", "84126P0001001", "CT1841260001", "Bridge inspection", "Transportation", "HNTB Corporation", "",
  "M/WBE Small Purchase", "Expense", "Registered", "$100", "$125", "$125", "$25", "07/01/2026",
  "06/30/2029", "07/20/2026", "Engineering", "", "", "", "",
];

function d1(db) {
  const wrap = (sql, args = []) => ({
    async run() { db.prepare(sql).run(...args); return { success: true }; },
    async all() { return { results: db.prepare(sql).all(...args) }; },
    async first() { return db.prepare(sql).get(...args) ?? null; },
  });
  return {
    prepare(sql) { return { ...wrap(sql), bind: (...args) => wrap(sql, args) }; },
    async batch(statements) { for (const statement of statements) await statement.run(); return []; },
  };
}

async function ingest(rfxBody) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../migrations/0007_passport_public.sql", import.meta.url), "utf8"));
  const env = { DB: d1(sqlite) };
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => new Response(
    String(url).includes("contractData") ? `var public_ctr_data = ${JSON.stringify([CONTRACT])};` : rfxBody,
    { status: 200 },
  );
  try {
    const result = await ingestPassportPublic(env);
    return { result, meta: await readPassportIngestMeta(env) };
  } finally {
    globalThis.fetch = original;
  }
}

test("ingest publishes matched, unmatched, total and by-status coverage with the materialization", async () => {
  const { result, meta } = await ingest(SAMPLE);
  assert.equal(result.ok, true);
  assert.equal(result.rfx, 19);
  const coverage = JSON.parse(meta.rfx_category_coverage);
  assert.equal(coverage.measured_at, meta.ingested_at);
  assert.deepEqual([coverage.state, coverage.total, coverage.matched, coverage.unmatched], ["measured", 19, 11, 8]);
  assert.deepEqual(result.rfx_category_coverage, coverage);
  assert.equal(Object.values(coverage.by_status).reduce((sum, row) => sum + row.total, 0), 19);
});

test("failure: a feed without the field still materializes and says the field is absent", async () => {
  const row = '["1","2","P","I","81026B0003","Name","A","Released","1/1/2026","2/1/2026","Competitive Sealed Bid"]';
  const { result, meta } = await ingest(`var public_rfx_data = [\n${row}\n];`);
  assert.equal(result.ok, true);
  const coverage = JSON.parse(meta.rfx_category_coverage);
  assert.deepEqual([coverage.state, coverage.total, coverage.matched, coverage.no_label], ["field_absent", 1, 0, 1]);
});
