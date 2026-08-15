import assert from "node:assert/strict";
import test from "node:test";

import { handleFranchiseConcessions } from "../src/franchise_concession.mjs";
import { handleContractLifecycle } from "../src/checkbook_lifecycle.mjs";
import { handleHearings } from "../src/hearings.mjs";
import { handleMeetingOutcomes } from "../src/meeting_outcomes.mjs";
import { handleProperties } from "../src/property.mjs";
import { handleRules } from "../src/rules.mjs";
import { handleZapOutcomes, kvKey } from "../src/zap_outcomes.mjs";

function kvWith(entries) {
  const values = new Map(Object.entries(entries));
  return {
    async get(key) { return values.get(key) || null; },
    async put() { throw new Error("resident GET attempted a KV write"); },
  };
}

const handlers = [
  {
    name: "rules",
    url: "https://api.cityscroll.org/rules",
    key: "rules:materialized:v2",
    handle: handleRules,
    payload: { schema_version: 2, generated_at: "2099-01-01T00:00:00.000Z", source: { enrichment: { status: "ok" } }, rules: [] },
    missingStatus: 503,
  },
  {
    name: "hearings",
    url: "https://api.cityscroll.org/hearings",
    key: "hearings:location:v1",
    handle: handleHearings,
    payload: { generated_at: "2099-01-01T00:00:00.000Z", source_extraction_version: 2, hearings: [] },
    missingStatus: 503,
  },
  {
    name: "property",
    url: "https://api.cityscroll.org/property-locations?full=1",
    key: "property:location:v1",
    handle: handleProperties,
    payload: { generated_at: "2099-01-01T00:00:00.000Z", properties: [], disposition_spines: [] },
    missingStatus: 503,
  },
  {
    name: "franchise",
    url: "https://api.cityscroll.org/franchise-concessions",
    key: "franchise-concession:spines:v1",
    handle: handleFranchiseConcessions,
    payload: { generated_at: "2099-01-01T00:00:00.000Z", notices: [], franchise_spines: [] },
    missingStatus: 503,
  },
  {
    name: "meeting outcomes",
    url: "https://api.cityscroll.org/meeting-outcomes",
    key: "meeting-outcomes:materialized:v2",
    handle: handleMeetingOutcomes,
    payload: { schema_version: 1, generated_at: "2099-01-01T00:00:00.000Z", records: [] },
    missingStatus: 503,
  },
  {
    name: "ZAP outcomes",
    url: "https://api.cityscroll.org/zap-outcomes?id=2024Q0135",
    key: kvKey("2024Q0135"),
    handle: handleZapOutcomes,
    payload: { project_id: "2024Q0135", generated_at: "2099-01-01T00:00:00.000Z", join: { matched: false }, spine: { events: [] } },
    missingStatus: 404,
  },
];

test("snapshot-only handlers make zero publisher requests for fresh, stale, and missing materializations", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    throw new Error("publisher egress blocked");
  };
  try {
    for (const item of handlers) {
      const fresh = await item.handle(new Request(item.url), { ALERT_STATE: kvWith({ [item.key]: JSON.stringify(item.payload) }) });
      assert.equal(fresh.status, 200, `${item.name} fresh snapshot`);

      const stalePayload = { ...item.payload, generated_at: "2000-01-01T00:00:00.000Z" };
      const stale = await item.handle(new Request(item.url), { ALERT_STATE: kvWith({ [item.key]: JSON.stringify(stalePayload) }) });
      assert.equal(stale.status, 200, `${item.name} stale snapshot`);
      assert.equal((await stale.json()).stale, true, `${item.name} reports stale vintage`);

      const missing = await item.handle(new Request(item.url), { ALERT_STATE: kvWith({}) });
      assert.equal(missing.status, item.missingStatus, `${item.name} missing snapshot`);
    }
    const lifecycle = {
      ok: true,
      assembly_version: 4,
      timeline: [],
      ocp_award: { status: "unmatched" },
      civic_events: [],
      award_prime_goal: { status: "unavailable" },
    };
    const lifecycleDb = (value) => ({
      prepare() {
        return {
          bind() { return this; },
          async first() { return value ? { lifecycle: JSON.stringify(value) } : null; },
        };
      },
    });
    const lifecycleRequest = new Request("https://api.cityscroll.org/contract-lifecycle?id=20250110001");
    const lifecycleFresh = await handleContractLifecycle(lifecycleRequest, { DB: lifecycleDb(lifecycle) });
    assert.equal(lifecycleFresh.status, 200, "contract lifecycle cached snapshot");
    const lifecycleMissing = await handleContractLifecycle(lifecycleRequest, { DB: lifecycleDb(null) });
    assert.equal(lifecycleMissing.status, 503, "contract lifecycle missing snapshot");
    assert.equal(attempts, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
