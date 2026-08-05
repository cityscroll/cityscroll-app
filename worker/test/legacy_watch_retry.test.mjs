import assert from "node:assert/strict";
import { test } from "node:test";

import { fetchSodaRowsWithRetry } from "../src/alerts.mjs";

test("legacy watch fetch retries a transient SODA 524 once", async () => {
  const responses = [
    new Response(null, { status: 524 }),
    Response.json([{ request_id: "20260805001" }]),
  ];
  const waits = [];
  let calls = 0;

  const rows = await fetchSodaRowsWithRetry("https://example.test/soda", {
    fetchFn: async () => responses[calls++],
    waitFn: async (milliseconds) => { waits.push(milliseconds); },
  });

  assert.deepEqual(rows, [{ request_id: "20260805001" }]);
  assert.equal(calls, 2);
  assert.equal(waits.length, 1);
});

test("legacy watch fetch does not retry a non-transient SODA response", async () => {
  let calls = 0;
  await assert.rejects(
    fetchSodaRowsWithRetry("https://example.test/soda", {
      fetchFn: async () => {
        calls++;
        return new Response(null, { status: 400 });
      },
      waitFn: async () => { throw new Error("must not wait"); },
    }),
    /SODA 400/,
  );
  assert.equal(calls, 1);
});
