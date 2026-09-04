import assert from "node:assert/strict";
import test from "node:test";

import { fetchFederatedSearch, allSourcesFederatedSearchPath, scopedFederatedSearchPath } from "../site/federated_search_client.mjs";

test("federated search client uses the shared /search HTTP adapter", async () => {
  const calls = [];
  const result = { object_ref: "meeting:preview" };
  const rows = await fetchFederatedSearch("  mosquito  ", {
    timeoutMs: 321,
    fetcher: async (...args) => {
      calls.push(args);
      return { ok: true, status: 200, json: async () => ({ results: [result] }) };
    },
  });

  assert.deepEqual(rows, [result]);
  assert.deepEqual(calls, [["/search?q=mosquito", null, 321]]);
});

test("federated search client fails closed for unavailable or malformed responses", async () => {
  await assert.rejects(
    fetchFederatedSearch("mosquito", {
      fetcher: async () => ({ ok: false, status: 503 }),
    }),
    /federated search HTTP 503/,
  );
  await assert.rejects(
    fetchFederatedSearch("mosquito", {
      fetcher: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    }),
    /invalid search\.federated@1 response/,
  );
});

test("the all-sources path serializes no scope and the scoped path stays allowlisted", () => {
  assert.equal(allSourcesFederatedSearchPath("  parks  "), "/search?q=parks");
  assert.ok(!allSourcesFederatedSearchPath("parks").includes("scope="));
  assert.equal(
    scopedFederatedSearchPath("parks", ["notices", "vendors"]),
    "/search?q=parks&scope=notices&scope=vendors",
  );
  assert.throws(() => allSourcesFederatedSearchPath("   "), /requires a query/);
  assert.throws(() => allSourcesFederatedSearchPath("x".repeat(241)), /too long/);
});
