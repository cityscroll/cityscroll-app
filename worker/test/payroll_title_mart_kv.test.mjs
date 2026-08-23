/**
 * Payroll title mart KV cutover: SODA group-by → ALERT_STATE, committed twin floor.
 *
 *   node --test worker/test/payroll_title_mart_kv.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  PAYROLL_TITLE_MART_KV_KEY,
  committedPayrollTitleMartFloor,
  loadPayrollTitleMart,
  parsePayrollTitleMartRecord,
  refreshPayrollTitleMart,
} from "../src/lib/payroll_title_mart_kv.mjs";
import { suggestionCountParams } from "../src/lib/suggestions.mjs";
import { runSuggestionValidation } from "../src/suggest.mjs";

const TODAY = "2026-08-23";
const FLOOR = committedPayrollTitleMartFloor();

function memoryKV(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    values,
    async get(key) {
      return values.has(key) ? values.get(key) : null;
    },
    async put(key, value) {
      values.set(key, value);
    },
  };
}

function sodaTitles(n = 1100) {
  return Array.from({ length: n }, (_, i) => ({
    title_description: i === 0 ? "POLICE OFFICER" : i === 1 ? "FIREFIGHTER" : `TITLE ${i}`,
    n: String(10 + i),
    mn: "40000",
    mx: "80000",
    avg: "60000",
  }));
}

function sodaFetch(rows = sodaTitles()) {
  return async (url) => {
    const href = String(url);
    if (!href.includes("k397-673e.json")) {
      throw new Error(`unexpected fetch ${href}`);
    }
    if (href.includes("count(1)") && !href.includes("title_description")) {
      const n = href.includes("fiscal_year") ? "550219" : "6775830";
      return { ok: true, json: async () => [{ n }] };
    }
    return { ok: true, json: async () => rows };
  };
}

test("committed floor is the shape the suggestion path already consumes", () => {
  assert.equal(FLOOR.schema_version, 1);
  assert.equal(FLOOR.fiscal_year, 2025);
  assert.ok(Array.isArray(FLOOR.rows) && FLOOR.rows.length >= 1000);
  assert.ok(FLOOR.rows.some((row) => row.title_description === "POLICE OFFICER"));
  assert.ok(FLOOR.rows.some((row) => row.title_description === "FIREFIGHTER"));
  const parsed = parsePayrollTitleMartRecord(JSON.stringify(FLOOR));
  assert.equal(parsed.title_count, FLOOR.title_count);
});

test("cold, empty, unparseable, and failed KV fall back to the committed twin", async () => {
  const none = await loadPayrollTitleMart({});
  assert.equal(none.source, "committed_floor");
  assert.equal(none.record, FLOOR);

  const empty = await loadPayrollTitleMart({ ALERT_STATE: memoryKV() });
  assert.equal(empty.source, "committed_floor");
  assert.equal(empty.record.title_count, FLOOR.title_count);

  const garbage = await loadPayrollTitleMart({
    ALERT_STATE: memoryKV({ [PAYROLL_TITLE_MART_KV_KEY]: "{not-json" }),
  });
  assert.equal(garbage.source, "committed_floor");

  const tooSmall = await loadPayrollTitleMart({
    ALERT_STATE: memoryKV({
      [PAYROLL_TITLE_MART_KV_KEY]: JSON.stringify({
        schema_version: 1,
        fiscal_year: 2025,
        rows: [{ title_description: "POLICE OFFICER", n: 1, mn: 1, mx: 1, avg: 1 }],
      }),
    }),
  });
  assert.equal(tooSmall.source, "committed_floor");

  const throwing = await loadPayrollTitleMart({
    ALERT_STATE: {
      async get() { throw new Error("kv down"); },
    },
  });
  assert.equal(throwing.source, "committed_floor");
  assert.ok(throwing.record.rows.some((row) => row.title_description === "POLICE OFFICER"));
});

test("usable KV payload wins and keeps the read-path shape", async () => {
  const live = {
    ...FLOOR,
    materialized_at: "2099-01-01T00:00:00.000Z",
    title_count: FLOOR.rows.length,
  };
  const loaded = await loadPayrollTitleMart({
    ALERT_STATE: memoryKV({ [PAYROLL_TITLE_MART_KV_KEY]: JSON.stringify(live) }),
  });
  assert.equal(loaded.source, "kv");
  assert.equal(loaded.record.materialized_at, "2099-01-01T00:00:00.000Z");
  assert.equal(loaded.record.schema_version, 1);
  assert.ok(Array.isArray(loaded.record.rows));
});

test("refresh writes the SODA group-by into ALERT_STATE without new secrets", async () => {
  const kv = memoryKV();
  const result = await refreshPayrollTitleMart(
    { ALERT_STATE: kv },
    sodaFetch(),
    new Date("2026-08-23T13:00:00.000Z"),
  );
  assert.equal(result.status, "success");
  assert.equal(result.title_count, 1100);
  const stored = parsePayrollTitleMartRecord(kv.values.get(PAYROLL_TITLE_MART_KV_KEY));
  assert.ok(stored);
  assert.equal(stored.mode, "soda_groupby");
  assert.equal(stored.dataset_id, "k397-673e");
  assert.ok(stored.rows.some((row) => row.title_description === "POLICE OFFICER"));
  assert.ok(stored.rows.some((row) => row.title_description === "FIREFIGHTER"));
  assert.equal((await refreshPayrollTitleMart({})).status, "skipped");
});

test("People suggestion counting still hits the floor when KV is cold", async () => {
  const q = suggestionCountParams(
    "people",
    { keywords: ["paramedic"], lookupType: "role" },
    TODAY,
    { payrollTitleMart: (await loadPayrollTitleMart({})).record },
  );
  assert.equal(q.source, "payroll_title_mart");
  assert.ok(q.count >= 1017);

  const kvStore = {};
  const env = {
    ANTHROPIC_API_KEY: "test-key",
    ALERT_STATE: {
      get: async (k) => kvStore[k] ?? null,
      put: async (k, v) => { kvStore[k] = v; },
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("api.anthropic.com")) {
      const body = JSON.parse((opts && opts.body) || "{}");
      const text = body.messages[0].content;
      if (/paramedic/i.test(text)) {
        return {
          ok: true,
          json: async () => ({
            content: [{
              type: "tool_use",
              name: "build_filter",
              input: { keywords: ["paramedic"], lookupType: "role" },
            }],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          content: [{ type: "tool_use", name: "build_filter", input: { keywords: ["x"] } }],
        }),
      };
    }
    return { ok: true, json: async () => [{ n: "0" }] };
  };
  try {
    const res = await runSuggestionValidation(env);
    assert.ok(res.status === "success" || res.status === "skipped");
    if (res.status === "success") {
      const people = res.byLens.people || [];
      assert.ok(people.some((row) => row.idx === 0 && row.count >= 1017));
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("scheduled payroll refresh is a public SODA group-by, not a secret-bearing path", () => {
  const worker = readFileSync(new URL("../src/worker.mjs", import.meta.url), "utf8");
  const lib = readFileSync(new URL("../src/lib/payroll_title_mart_kv.mjs", import.meta.url), "utf8");
  assert.match(worker, /refreshPayrollTitleMart\(env\)/);
  assert.match(worker, /runSuggestionValidation\(env\)/);
  assert.ok(
    worker.lastIndexOf("await refreshPayrollTitleMart")
      < worker.lastIndexOf("await runSuggestionValidation"),
  );
  assert.match(lib, /PAYROLL_SODA_DATASET/);
  assert.match(lib, /data\.cityofnewyork\.us\/resource/);
  assert.match(lib, /\$group/);
  assert.doesNotMatch(lib, /process\.env|SECRET|API_KEY|token=/i);
});
