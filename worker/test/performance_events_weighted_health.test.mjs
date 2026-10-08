import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { handlePerformanceEvents, RUM_BATCH_SCHEMA, RUM_OBSERVATION_SCHEMA } from "../src/performance_events.mjs";
import { bumpStat, STATS_TTL } from "../src/lib/stats.mjs";

const NOW = new Date("2026-10-08T12:00:00Z");
const DAY = "2026-10-08";
const observation = {
  schema: RUM_OBSERVATION_SCHEMA, state: "measured", metric_id: "ttfb_ms",
  metric_version: "1.0.0", unit: "ms", value: 123.5, surface_id: "home",
  component_id: "none", device_class: "mobile", navigation_type: "navigate",
  delivery_class: "static", result_state: "content", collector_version: "rum-browser-v1",
  manifest_version: "rum-surfaces-v1", release_id: "a".repeat(40),
};
function spyKV({ failGet = false, failPut = false } = {}) {
  const store = new Map(), gets = [], puts = [];
  return { store, gets, puts,
    async get(key) { gets.push(key); if (failGet) throw new Error("get unavailable"); return store.get(key) ?? null; },
    async put(key, value, options) { puts.push({ key, value, options }); if (failPut) throw new Error("put unavailable"); store.set(key, value); },
  };
}
async function intake(count, { kv = spyKV(), analyticsFail = false, missingAnalytics = false, developer = false, invalid = false } = {}) {
  const points = [];
  const env = { RUM_INGEST_ENABLED: "true", ANALYTICS_ENVIRONMENT: "production", ALERT_STATE: kv };
  if (!missingAnalytics) env.RUM_ANALYTICS = { writeDataPoint(point) { if (analyticsFail) throw new Error("analytics unavailable"); points.push(point); } };
  const headers = { Origin: "https://cityscroll.org", "Content-Type": "application/json" };
  if (developer) {
    const secret = "test-only-weighted-rum-exclusion-key";
    env.ANALYTICS_DEV_KEY = secret;
    const timestamp = Math.floor(NOW.getTime() / 1000);
    const signature = createHmac("sha256", secret).update(`crol-analytics-dev-exclusion\n${timestamp}`).digest("base64url");
    headers["X-CROL-Analytics-Dev"] = `v1.${timestamp}.${signature}`;
  }
  const payload = { schema: RUM_BATCH_SCHEMA, observations: Array.from({ length: count }, () => ({ ...observation })) };
  if (invalid) payload.schema = "unsupported";
  const response = await handlePerformanceEvents(new Request("https://api.cityscroll.org/performance-events", { method: "POST", headers, body: JSON.stringify(payload) }), env, { nowMs: NOW.getTime() });
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
  return { kv, points };
}
for (const count of [1, 16]) test(`accepted weight ${count} preserves observations with three puts`, async () => {
  const kv = spyKV();
  kv.store.set(`stats:rum_health.accepted:${DAY}`, "7");
  const { points } = await intake(count, { kv });
  assert.equal(points.length, count);
  assert.equal(kv.gets.length, 2);
  assert.equal(kv.puts.length, 3);
  assert.equal(kv.store.get(`stats:rum_health.accepted:${DAY}`), String(7 + count));
  assert.equal(kv.store.get(`stats:rum_health.storage_configured:${DAY}`), "1");
  assert.equal(kv.store.get("rum:health:latest-accepted"), NOW.toISOString());
  for (const put of kv.puts.filter(p => p.key.startsWith("stats:"))) assert.equal(put.options.expirationTtl, STATS_TTL);
});
for (const option of ["analyticsFail", "missingAnalytics", "developer", "invalid"]) test(`${option} stays excluded or unavailable without accepted freshness`, async () => {
  const { kv, points } = await intake(16, { [option]: true });
  assert.equal(points.length, 0);
  assert.equal(kv.store.has(`stats:rum_health.accepted:${DAY}`), false);
  assert.equal(kv.store.has("rum:health:latest-accepted"), false);
  assert.ok(kv.puts.length <= 2);
});
for (const option of ["failGet", "failPut"]) test(`KV ${option} cannot reject accepted Analytics Engine observations`, async () => {
  const kv = spyKV({ [option]: true });
  const { points } = await intake(16, { kv });
  assert.equal(points.length, 16);
  assert.ok(kv.puts.length <= 3);
});
test("missing KV does not suppress Analytics Engine observations", async () => {
  const { points } = await intake(16, { kv: null });
  assert.equal(points.length, 16);
});
test("invalid or unsafe counter weights produce no KV operations", async () => {
  const kv = spyKV();
  for (const weight of [0, -1, 1.5, 17, NaN, Infinity, "16"]) await bumpStat(kv, "test", NOW, weight);
  assert.equal(kv.gets.length, 0);
  assert.equal(kv.puts.length, 0);
});
