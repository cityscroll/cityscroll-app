import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  backfillPassportSourceRecordsFromProduct,
  classifyPassportDumpBody,
  ingestPassportPublic,
  passportIngestIsStale,
  passportSourceSystemId,
  PASSPORT_FETCH_HEADERS,
  PASSPORT_STALE_AFTER_MS,
  recordPassportIngestFailure,
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
    const result = await ingestPassportPublic(env);
    const after = currentRows(sqlite);
    assert.deepEqual(after, before);

    // Ingest path dual-write stamps operator telemetry and leaves source_records rows.
    assert.equal(result.ok, true);
    assert.ok(result.dual_write?.contracts >= 1, `contracts dual-write=${result.dual_write?.contracts}`);
    assert.ok(result.dual_write?.rfx >= 1, `rfx dual-write=${result.dual_write?.rfx}`);

    const first = sqlite.prepare("SELECT source_system, source_system_id, content_hash FROM source_records ORDER BY source_system").all();
    assert.equal(first.length, 2);
    assert.deepEqual(first.map((row) => row.source_system), ["passport_public_contracts", "passport_public_rfx"]);
    // Named metric: row_count > 0 is what moves passport streams out of empty-declared-live.
    assert.ok(
      sqlite.prepare(
        "SELECT COUNT(*) AS n FROM source_records WHERE source_system = 'passport_public_contracts'",
      ).get().n > 0,
    );
    assert.ok(
      sqlite.prepare(
        "SELECT COUNT(*) AS n FROM source_records WHERE source_system = 'passport_public_rfx'",
      ).get().n > 0,
    );

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

test("passportIngestIsStale guards missing, invalid, and aged timestamps", () => {
  const now = Date.parse("2026-08-01T12:00:00.000Z");
  assert.equal(passportIngestIsStale(null, now), true);
  assert.equal(passportIngestIsStale("not-a-date", now), true);
  // Bulk-load stamp from 2026-07-30T20:00:58Z is ~40h earlier — still inside the 48h window.
  assert.equal(passportIngestIsStale("2026-07-30T20:00:58Z", now), false);
  // Same stamp against a later "now" is stale.
  assert.equal(
    passportIngestIsStale("2026-07-30T20:00:58Z", Date.parse("2026-08-02T00:00:00.000Z")),
    true,
  );
  assert.equal(
    passportIngestIsStale("2026-08-01T00:00:00.000Z", now, PASSPORT_STALE_AFTER_MS),
    false,
  );
  assert.equal(
    passportIngestIsStale(
      "2026-07-29T12:00:00.000Z",
      now,
      PASSPORT_STALE_AFTER_MS,
    ),
    true,
  );
});

test("classifyPassportDumpBody rejects HTML challenges and empty bodies", () => {
  assert.equal(classifyPassportDumpBody("", "contracts"), "contracts-body-empty");
  assert.equal(
    classifyPassportDumpBody("<!DOCTYPE html><html>blocked</html>", "contracts"),
    "contracts-body-html",
  );
  assert.equal(classifyPassportDumpBody("var other = []", "rfx"), "rfx-body-missing-var");
  assert.equal(classifyPassportDumpBody("var public_ctr_data = [];", "contracts"), null);
});

test("PASSPORT_FETCH_HEADERS carries a non-empty User-Agent", () => {
  assert.ok(PASSPORT_FETCH_HEADERS["User-Agent"]);
  assert.match(PASSPORT_FETCH_HEADERS["User-Agent"], /CityScroll/i);
});

test("failed fetch records last_error meta and dual-write backfills from product rows", async () => {
  const { sqlite, DB } = database();
  // Seed product tables as if an older bulk load succeeded without dual-write.
  sqlite.prepare(
    `INSERT INTO passport_contracts
      (epin, epin_norm, ctr_id, contract_id, title, agency, vendor, status,
       procurement_method, contract_type, award_amount, current_amount, paid_amount,
       start_date, end_date, registration_date, payload, ingested_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    "84126P0001001", "84126P0001001", "CTR-77", "CT1841260001", "Bridge inspection",
    "Transportation", "HNTB Corporation", "Registered", "Request for Proposals", "Expense",
    100, 125, 25, "07/01/2026", "06/30/2029", "07/20/2026",
    JSON.stringify({
      epin: "84126P0001001", epin_norm: "84126P0001001", ctr_id: "CTR-77",
      contract_id: "CT1841260001", title: "Bridge inspection", agency: "Transportation",
      vendor: "HNTB Corporation", status: "Registered",
    }),
    "2026-07-30T20:00:58Z",
  );
  sqlite.prepare(
    `INSERT INTO passport_rfx
      (epin, epin_norm, rfp_id, procurement_name, agency, rfx_status,
       release_date, due_date, procurement_method, main_commodity, industry,
       payload, ingested_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    "84126P0001001", "84126P0001001", "RFX-88", "Bridge inspection", "Transportation",
    "Released", "06/01/2026", "08/01/2026", "RFP", "Engineering", "Engineering",
    JSON.stringify({
      epin: "84126P0001001", epin_norm: "84126P0001001", rfp_id: "RFX-88",
      procurement_name: "Bridge inspection", agency: "Transportation", rfx_status: "Released",
    }),
    "2026-07-30T20:00:58Z",
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("<!DOCTYPE html><html>denied</html>", { status: 403 });
  try {
    const result = await ingestPassportPublic({
      DB,
      PASSPORT_SOURCE_RECORD_DUAL_WRITE: "true",
    });
    assert.equal(result.ok, false);
    assert.match(String(result.reason), /http-403|body-html/);
    const meta = Object.fromEntries(
      sqlite.prepare("SELECT key, value FROM passport_ingest_meta").all().map((r) => [r.key, r.value]),
    );
    assert.equal(meta.last_ok, "false");
    assert.ok(meta.last_error);
    assert.ok(meta.last_attempt_at);
    // Product rows from the bulk load must not be wiped on failed fetch.
    assert.equal(currentRows(sqlite).contracts.length, 1);
    assert.equal(currentRows(sqlite).rfx.length, 1);
    // Dual-write backfill recovers observations from product payloads.
    const obs = sqlite.prepare(
      "SELECT source_system FROM source_records ORDER BY source_system",
    ).all();
    assert.equal(obs.length, 2);
    assert.deepEqual(
      obs.map((r) => r.source_system),
      ["passport_public_contracts", "passport_public_rfx"],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  sqlite.close();
});

test("recordPassportIngestFailure stamps last_error without clearing ingested_at", async () => {
  const { sqlite, DB } = database();
  sqlite.prepare(
    "INSERT INTO passport_ingest_meta (key, value) VALUES (?, ?)",
  ).run("ingested_at", "2026-07-30T20:00:58Z");
  await recordPassportIngestFailure({ DB }, "contracts-http-403");
  const meta = Object.fromEntries(
    sqlite.prepare("SELECT key, value FROM passport_ingest_meta").all().map((r) => [r.key, r.value]),
  );
  assert.equal(meta.ingested_at, "2026-07-30T20:00:58Z");
  assert.equal(meta.last_error, "contracts-http-403");
  assert.equal(meta.last_ok, "false");
  sqlite.close();
});

test("backfillPassportSourceRecordsFromProduct writes passport source_records", async () => {
  const { sqlite, DB } = database();
  sqlite.prepare(
    `INSERT INTO passport_contracts
      (epin, epin_norm, ctr_id, contract_id, title, agency, vendor, status,
       procurement_method, contract_type, award_amount, current_amount, paid_amount,
       start_date, end_date, registration_date, payload, ingested_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    "84126P0001001", "84126P0001001", "CTR-77", null, null, null, null, null,
    null, null, null, null, null, null, null, null,
    JSON.stringify({ epin: "84126P0001001", epin_norm: "84126P0001001", ctr_id: "CTR-77" }),
    "2026-07-30T20:00:58Z",
  );
  const result = await backfillPassportSourceRecordsFromProduct({
    DB,
    PASSPORT_SOURCE_RECORD_DUAL_WRITE: "true",
  });
  assert.equal(result.ok, true);
  assert.equal(result.contracts, 1);
  assert.equal(
    sqlite.prepare(
      "SELECT COUNT(*) AS n FROM source_records WHERE source_system = 'passport_public_contracts'",
    ).get().n,
    1,
  );
  sqlite.close();
});
