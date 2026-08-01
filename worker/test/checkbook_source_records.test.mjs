// Checkbook Contracts immutable observation dual-write (source coverage gap-close).
//
//   cd worker && node --test test/checkbook_source_records.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { computeLifecycle } from "../src/checkbook_lifecycle.mjs";
import {
  checkbookContractSourceSystemId,
  CHECKBOOK_SOURCE_RECORD_DUAL_WRITE_FLAG,
  CHECKBOOK_CONTRACTS_SOURCE_SYSTEM,
} from "../src/lib/checkbook_source_records.mjs";
import { parseContractTransaction } from "../src/lib/checkbook_lifecycle.mjs";

function d1FromSqlite(db) {
  return {
    prepare(sql) {
      // Each bind() must return an independent statement handle so multi-row
      // batch dual-writes do not clobber one another (matches D1 semantics).
      return {
        bind(...values) {
          const statement = db.prepare(sql);
          const args = values;
          return {
            bind(...next) { return d1FromSqlite(db).prepare(sql).bind(...next); },
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
  if (observations) {
    sqlite.exec(readFileSync(new URL("../migrations/0008_source_records.sql", import.meta.url), "utf8"));
  }
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS notices (
      request_id TEXT PRIMARY KEY,
      start_date TEXT,
      agency TEXT,
      type_of_notice TEXT,
      short_title TEXT,
      pin TEXT,
      contract_amount REAL,
      vendor_name TEXT
    );
  `);
  sqlite.prepare(
    `INSERT INTO notices
      (request_id, start_date, agency, type_of_notice, short_title, pin, contract_amount, vendor_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "20240723114",
    "2024-07-23",
    "Transportation",
    "Award",
    "Bridge inspection",
    "84126P0001001",
    100000,
    "HNTB Corporation",
  );
  return { sqlite, DB: d1FromSqlite(sqlite) };
}

function contractTx(fields) {
  const f = {
    id: "CT107120248803393",
    vendor: "HNTB Corporation",
    agency: "Transportation",
    pin: "84126P0001001",
    status: "registered",
    vendor_record_type: "Prime Vendor",
    current: "4020000.00",
    original: "4000000.00",
    spent: "4020000.00",
    start: "2024-01-01",
    end: "2026-12-31",
    registered: "2024-02-01",
    received: "2024-01-15",
    ...fields,
  };
  return `<transaction>`
    + `<prime_contract_id>${f.id}</prime_contract_id>`
    + `<prime_vendor>${f.vendor}</prime_vendor>`
    + `<agency_name>${f.agency}</agency_name>`
    + `<pin>${f.pin}</pin>`
    + `<status>${f.status}</status>`
    + `<vendor_record_type>${f.vendor_record_type}</vendor_record_type>`
    + `<prime_contract_current_amount>${f.current}</prime_contract_current_amount>`
    + `<prime_contract_original_amount>${f.original}</prime_contract_original_amount>`
    + `<prime_vendor_spent_to_date>${f.spent}</prime_vendor_spent_to_date>`
    + `<prime_contract_start_date>${f.start}</prime_contract_start_date>`
    + `<prime_contract_end_date>${f.end}</prime_contract_end_date>`
    + `<prime_contract_registration_date>${f.registered}</prime_contract_registration_date>`
    + `<received_date>${f.received}</received_date>`
    + `</transaction>`;
}

function contractsXml(...txs) {
  return `<response><status><result>success</result></status><result_records>${txs.join("")}</result_records></response>`;
}

function spendingXml() {
  return `<response><status><result>success</result></status><result_records></result_records></response>`;
}

async function withCheckbook(recordsByStatus, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = String(init?.body || "");
    if (String(url).includes("checkbooknyc.com")) {
      if (body.includes("type_of_data>Spending")) {
        return new Response(spendingXml(), { status: 200 });
      }
      if (body.includes("<value>pending</value>")) {
        return new Response(contractsXml(...(recordsByStatus.pending || [])), { status: 200 });
      }
      if (body.includes("<value>registered</value>")) {
        return new Response(contractsXml(...(recordsByStatus.registered || [])), { status: 200 });
      }
      return new Response(contractsXml(), { status: 200 });
    }
    // SODA / other enrichments: empty success
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("Checkbook contract keys preserve Prime vs Sub Vendor slices", () => {
  const prime = parseContractTransaction(contractTx({ vendor_record_type: "Prime Vendor" }));
  const sub = parseContractTransaction(contractTx({
    vendor: "Subco LLC",
    vendor_record_type: "Sub Vendor",
    current: "0.00",
    spent: "0.00",
  }));
  assert.match(checkbookContractSourceSystemId(prime), /^contract:registered:CT107120248803393:HNTB CORPORATION:prime-vendor:/);
  assert.match(checkbookContractSourceSystemId(sub), /^contract:registered:CT107120248803393:SUBCO LLC:sub-vendor:/);
  assert.notEqual(checkbookContractSourceSystemId(prime), checkbookContractSourceSystemId(sub));
});

test("Checkbook observation capture is production-on / beta-off", () => {
  const wrangler = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const [production, beta = ""] = wrangler.split("[env.beta.vars]");
  assert.match(production, /CHECKBOOK_SOURCE_RECORD_DUAL_WRITE\s*=\s*"true"/);
  assert.match(beta, /CHECKBOOK_SOURCE_RECORD_DUAL_WRITE\s*=\s*"false"/);
});

test("flag off leaves lifecycle intact without observations", async () => {
  const { sqlite, DB } = database();
  await withCheckbook({
    registered: [contractTx({})],
  }, async () => {
    const { lifecycle, ok } = await computeLifecycle({ DB }, "20240723114");
    assert.equal(ok, true);
    assert.ok(lifecycle);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM source_records").get().n, 0);
  });
  sqlite.close();
});

test("flag on writes immutable contract rows and replay does not duplicate", async () => {
  const { sqlite, DB } = database();
  const env = { DB, [CHECKBOOK_SOURCE_RECORD_DUAL_WRITE_FLAG]: "true" };
  await withCheckbook({
    pending: [contractTx({ status: "pending", registered: "", received: "2023-12-01" })],
    registered: [
      contractTx({ vendor_record_type: "Prime Vendor" }),
      contractTx({
        vendor: "Subco LLC",
        vendor_record_type: "Sub Vendor",
        current: "0",
        original: "0",
        spent: "0",
      }),
    ],
  }, async () => {
    const first = await computeLifecycle(env, "20240723114");
    assert.equal(first.ok, true);

    const rows = sqlite.prepare(
      "SELECT source_system, source_system_id, content_hash FROM source_records ORDER BY source_system_id",
    ).all();
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.source_system === CHECKBOOK_CONTRACTS_SOURCE_SYSTEM));
    const keys = rows.map((r) => r.source_system_id);
    assert.equal(new Set(keys).size, 3, "prime/sub and pending stay distinct");

    const second = await computeLifecycle(env, "20240723114");
    assert.equal(second.ok, true);
    const replay = sqlite.prepare(
      "SELECT source_system, source_system_id, content_hash FROM source_records ORDER BY source_system_id",
    ).all();
    assert.deepEqual(replay, rows);
  });
  sqlite.close();
});

test("observation failure remains fail-soft for lifecycle consumers", async () => {
  const { sqlite, DB } = database({ observations: false });
  const env = { DB, [CHECKBOOK_SOURCE_RECORD_DUAL_WRITE_FLAG]: "true" };
  await withCheckbook({
    registered: [contractTx({})],
  }, async () => {
    const { lifecycle, ok } = await computeLifecycle(env, "20240723114");
    assert.equal(ok, true);
    assert.ok(lifecycle);
    assert.equal(lifecycle.ok, true);
  });
  sqlite.close();
});
