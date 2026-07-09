import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCheckbookTransactions,
  addDuration,
  calculateWarningDate,
  getWatchedStems,
  runCheckbookPipeline
} from "../src/checkbook.mjs";

test("parseCheckbookTransactions extracts transaction fields correctly", () => {
  const xml = `<response><status><result>success</result></status><transactions><transaction>`
    + `<prime_contract_id>CTA123</prime_contract_id>`
    + `<prime_vendor>SINERGIA INC</prime_vendor>`
    + `<prime_contract_current_amount>1000000</prime_contract_current_amount>`
    + `<prime_contract_registration_date>2026-07-01</prime_contract_registration_date>`
    + `<prime_contract_end_date>2029-07-01</prime_contract_end_date>`
    + `</transaction></transactions></response>`;

  const txs = parseCheckbookTransactions(xml);
  assert.equal(txs.length, 1);
  assert.equal(txs[0].id, "CTA123");
  assert.equal(txs[0].vendor, "SINERGIA INC");
  assert.equal(txs[0].current, 1000000);
  assert.equal(txs[0].registered, "2026-07-01");
  assert.equal(txs[0].end, "2029-07-01");
});

test("addDuration adds years and months correctly", () => {
  assert.equal(addDuration("2026-07-01", "3 Years"), "2029-07-01");
  assert.equal(addDuration("2026-07-01", "6 Months"), "2027-01-01");
  assert.equal(addDuration("2026-07-01", "invalid"), null);
});

test("calculateWarningDate subtracts 180 days correctly", () => {
  assert.equal(calculateWarningDate("2026-07-01"), "2026-01-02");
});

test("getWatchedStems resolves watches and subs into normalized agency stems", () => {
  const watches = [
    { agency: "Design and Construction" }
  ];
  const subs = [
    { lens: "entity", filter: { kind: "agency", name: "Sinergia Inc" } },
    { lens: "money", filter: { agency: "Buildings" } }
  ];
  const stems = getWatchedStems(watches, subs);
  assert.ok(stems.includes("DESIGN AND CONSTRUCTION"));
  assert.ok(stems.includes("SINERGIA"));
  assert.ok(stems.includes("BUILDINGS"));
});

test("runCheckbookPipeline fetches, parses, and puts to KV", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (url.includes("data.cityofnewyork.us")) {
      return {
        ok: true,
        json: async () => [
          {
            request_id: "REQ123",
            start_date: "2026-07-01",
            agency_name: "Design and Construction",
            vendor_name: "SINERGIA INC",
            pin: "PIN_SINERGIA_123",
            contract_amount: "1000000"
          }
        ]
      };
    }
    if (url.includes("checkbooknyc.com")) {
      const xml = `<response><status><result>success</result></status><transactions><transaction>`
        + `<prime_contract_id>CTA123</prime_contract_id>`
        + `<prime_vendor>SINERGIA INC</prime_vendor>`
        + `<prime_contract_current_amount>1000000</prime_contract_current_amount>`
        + `<prime_contract_registration_date>2026-07-01</prime_contract_registration_date>`
        + `<prime_contract_end_date>2029-07-01</prime_contract_end_date>`
        + `</transaction></transactions></response>`;
      return {
        ok: true,
        text: async () => xml
      };
    }
    return { ok: false };
  };

  const kvStore = {};
  const env = {
    ALERT_STATE: {
      put: async (key, val) => {
        kvStore[key] = val;
      }
    }
  };

  const watches = [{ agency: "Design and Construction" }];
  const res = await runCheckbookPipeline(env, watches, []);
  
  globalThis.fetch = originalFetch; // restore

  assert.equal(res.status, "success");
  assert.ok(kvStore["fc:DESIGN AND CONSTRUCTION"]);
  
  const forecasts = JSON.parse(kvStore["fc:DESIGN AND CONSTRUCTION"]);
  assert.equal(forecasts.length, 1);
  assert.equal(forecasts[0].contract_id, "CTA123");
  assert.equal(forecasts[0].vendor_name, "SINERGIA INC");
  assert.equal(forecasts[0].expiration_date, "2029-07-01");
  assert.equal(forecasts[0].warning_date, "2029-01-02");
});
