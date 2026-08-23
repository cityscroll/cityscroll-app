/**
 * Land ZAP lookup KV cutover: SODA sell-facing → ALERT_STATE, committed twin floor.
 *
 *   node --test worker/test/zap_projects_lookup_kv.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  handleZapProjectsLookup,
  refreshZapProjectsLookup,
  ZAP_PROJECTS_LOOKUP_KV_KEY,
} from "../src/zap_projects_lookup.mjs";
import {
  committedZapProjectsLookupFloor,
  loadZapProjectsLookup,
  parseZapProjectsLookupRecord,
  sodaSellFacingLookupUrl,
  zapProjectsLookupKvAcceptable,
} from "../src/lib/zap_projects_lookup_kv.mjs";
import { lookupZapFromWarehouseMaterialization } from "../src/lib/zap_warehouse_lookup.mjs";
import { fetchOpenDataRow } from "../src/zap_outcomes.mjs";

const FLOOR = committedZapProjectsLookupFloor();
const NOW = new Date("2026-08-23T08:00:00.000Z");

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

function sodaRows(n = 110) {
  const canaries = [
    { project_id: "2025Q0331", project_name: "44-17 Greenpoint Avenue Rezoning", public_status: "In Public Review" },
    { project_id: "2026K0123", project_name: "1550 Bedford Avenue Rezoning", public_status: "In Public Review" },
    { project_id: "2022M0258", project_name: "Demo", public_status: "Active" },
  ];
  const extra = Array.from({ length: n - canaries.length }, (_, i) => ({
    project_id: `2026X${String(i + 1).padStart(4, "0")}`,
    project_name: `Project ${i}`,
    public_status: "Filed",
    current_milestone_date: "2026-08-01T00:00:00.000",
  }));
  return [...canaries, ...extra];
}

function sodaFetch(rows = sodaRows()) {
  return async (url) => {
    const href = String(url);
    if (!href.includes("hgx4-8ukb.json")) {
      throw new Error(`unexpected fetch ${href}`);
    }
    return { ok: true, json: async () => rows };
  };
}

test("committed floor is the shape fetchOpenDataRow already consumes", () => {
  assert.equal(FLOOR.schema_version, 1);
  assert.ok(Array.isArray(FLOOR.rows) && FLOOR.rows.length >= 100);
  assert.ok(FLOOR.rows.some((row) => row.project_id === "2025Q0331"));
  assert.ok(FLOOR.rows.some((row) => row.project_id === "2026K0123"));
  const parsed = parseZapProjectsLookupRecord(JSON.stringify(FLOOR));
  assert.equal(parsed.row_count, FLOOR.row_count);
  assert.equal(zapProjectsLookupKvAcceptable(parsed), true);
});

test("cold, empty, unparseable, and failed KV fall back to the committed twin", async () => {
  const none = await loadZapProjectsLookup({});
  assert.equal(none.source, "committed_floor");
  assert.equal(none.record, FLOOR);

  const empty = await loadZapProjectsLookup({ ALERT_STATE: memoryKV() });
  assert.equal(empty.source, "committed_floor");
  assert.equal(empty.record.row_count, FLOOR.row_count);

  const garbage = await loadZapProjectsLookup({
    ALERT_STATE: memoryKV({ [ZAP_PROJECTS_LOOKUP_KV_KEY]: "{not-json" }),
  });
  assert.equal(garbage.source, "committed_floor");

  const tooSmall = await loadZapProjectsLookup({
    ALERT_STATE: memoryKV({
      [ZAP_PROJECTS_LOOKUP_KV_KEY]: JSON.stringify({
        schema_version: 1,
        rows: [{ project_id: "2025Q0331" }],
      }),
    }),
  });
  assert.equal(tooSmall.source, "committed_floor");

  const throwing = await loadZapProjectsLookup({
    ALERT_STATE: { async get() { throw new Error("kv down"); } },
  });
  assert.equal(throwing.source, "committed_floor");
  assert.ok(throwing.record.rows.some((row) => row.project_id === "2026K0123"));
});

test("GET /zap-projects-lookup serves KV when present and the floor when not", async () => {
  const live = {
    ...FLOOR,
    materialized_at: "2099-01-01T00:00:00.000Z",
  };
  const kvHit = await handleZapProjectsLookup(
    new Request("https://api.cityscroll.org/zap-projects-lookup"),
    { ALERT_STATE: memoryKV({ [ZAP_PROJECTS_LOOKUP_KV_KEY]: JSON.stringify(live) }) },
  );
  assert.equal(kvHit.status, 200);
  const kvBody = await kvHit.json();
  assert.equal(kvBody.schema_version, 1);
  assert.equal(kvBody.materialized_at, "2099-01-01T00:00:00.000Z");
  assert.equal(kvBody.rows.length, FLOOR.rows.length);
  assert.equal("stale" in kvBody, true);

  const floorHit = await handleZapProjectsLookup(
    new Request("https://api.cityscroll.org/zap-projects-lookup"),
    { ALERT_STATE: memoryKV() },
  );
  assert.equal(floorHit.status, 200);
  const floorBody = await floorHit.json();
  assert.equal(floorBody.rows.length, FLOOR.rows.length);

  const noBinding = await handleZapProjectsLookup(
    new Request("https://api.cityscroll.org/zap-projects-lookup"),
    {},
  );
  assert.equal(noBinding.status, 200);
  assert.equal((await noBinding.json()).rows.length, FLOOR.rows.length);
});

test("refresh writes the SODA sell-facing table into ALERT_STATE without new secrets", async () => {
  const kv = memoryKV();
  const result = await refreshZapProjectsLookup(
    { ALERT_STATE: kv },
    { fetchImpl: sodaFetch(), now: NOW },
  );
  assert.equal(result.status, "success");
  assert.ok(result.row_count >= 110);
  const stored = parseZapProjectsLookupRecord(kv.values.get(ZAP_PROJECTS_LOOKUP_KV_KEY));
  assert.ok(stored);
  assert.equal(stored.mode, "soda_sell_facing");
  assert.equal(stored.dataset_id, "hgx4-8ukb");
  assert.ok(stored.rows.some((row) => row.project_id === "2025Q0331"));
  assert.ok(stored.rows.some((row) => row.project_id === "2026K0123"));
  assert.equal((await refreshZapProjectsLookup({})).status, "skipped");
});

test("lookup and fetchOpenDataRow consume the KV payload shape", async () => {
  const live = parseZapProjectsLookupRecord(JSON.stringify({
    ...FLOOR,
    materialized_at: "2099-01-01T00:00:00.000Z",
  }));
  const hit = lookupZapFromWarehouseMaterialization("2025Q0331", live);
  assert.equal(hit.hit, true);
  assert.equal(hit.path, "warehouse");
  const row = await fetchOpenDataRow("2025Q0331", { lookupDoc: live });
  assert.equal(row.project_id, "2025Q0331");
  assert.equal(row.lookup_path, "warehouse");
});

test("scheduled land lookup refresh is a public SODA page, not a secret-bearing path", () => {
  const worker = readFileSync(new URL("../src/worker.mjs", import.meta.url), "utf8");
  const lib = readFileSync(new URL("../src/lib/zap_projects_lookup_kv.mjs", import.meta.url), "utf8");
  assert.match(worker, /event\.cron === "0 8 \* \* \*"/);
  assert.match(worker, /refreshZapProjectsLookup\(env\)/);
  assert.match(lib, /hgx4-8ukb/);
  assert.match(lib, /sodaSellFacingLookupUrl/);
  assert.equal(sodaSellFacingLookupUrl({ limit: 50 }).includes("hgx4-8ukb.json"), true);
  assert.doesNotMatch(lib, /process\.env|SECRET|API_KEY|LEGISTAR|token=/i);
});
