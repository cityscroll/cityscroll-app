import assert from "node:assert/strict";
import test from "node:test";

import { deliverRumBatch } from "../site/rum_delivery.mjs";

const BATCH = Object.freeze({ schema: "cityscroll.rum.batch.v1", observations: [] });

test("browser RUM delivery is inert unless explicitly enabled", async () => {
  let calls = 0;
  const result = await deliverRumBatch(BATCH, {
    enabled: false,
    runtime: {
      navigator: { sendBeacon() { calls += 1; } },
      fetch() { calls += 1; },
    },
  });
  assert.deepEqual(result, { state: "disabled" });
  assert.equal(calls, 0);
});

test("browser RUM delivery prefers a distinct beacon endpoint without a developer header", async () => {
  const calls = [];
  const result = await deliverRumBatch(BATCH, {
    enabled: true,
    endpoint: "https://api.cityscroll.org/performance-events",
    runtime: {
      navigator: {
        sendBeacon(url, body) {
          calls.push([url, body]);
          return true;
        },
      },
      fetch() { throw new Error("fetch should not run"); },
    },
  });
  assert.deepEqual(result, { state: "queued", transport: "beacon" });
  assert.equal(calls[0][0], "https://api.cityscroll.org/performance-events");
  assert.equal(calls[0][1], JSON.stringify(BATCH));
});

test("developer delivery skips beacon so token validity remains an opaque request header", async () => {
  let beacons = 0;
  let request;
  const result = await deliverRumBatch(BATCH, {
    enabled: true,
    developerToken: "opaque-token",
    runtime: {
      navigator: { sendBeacon() { beacons += 1; return true; } },
      async fetch(url, init) { request = { url, init }; return new Response(null, { status: 204 }); },
    },
  });
  assert.deepEqual(result, { state: "queued", transport: "fetch" });
  assert.equal(beacons, 0);
  assert.equal(request.url, "https://api.cityscroll.org/performance-events");
  assert.equal(request.init.headers["X-CROL-Analytics-Dev"], "opaque-token");
  assert.equal(request.init.keepalive, true);
});

test("beacon, fetch, serialization, and missing-API failures never reject into page behavior", async (t) => {
  const runtimes = [
    {},
    {
      navigator: { sendBeacon() { throw new Error("beacon unavailable"); } },
      fetch() { return Promise.reject(new Error("network unavailable")); },
    },
  ];
  for (const runtime of runtimes) {
    await t.test("transport failure", async () => {
      await assert.doesNotReject(deliverRumBatch(BATCH, { enabled: true, runtime }));
      assert.deepEqual(await deliverRumBatch(BATCH, { enabled: true, runtime }), { state: "unavailable" });
    });
  }

  const circular = {};
  circular.self = circular;
  assert.deepEqual(await deliverRumBatch(circular, { enabled: true }), { state: "unavailable" });
});
