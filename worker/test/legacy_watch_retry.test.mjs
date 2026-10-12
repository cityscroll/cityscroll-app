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

for (const phase of ["headers", "body"]) {
  test(`legacy watch deadline cancels a stalled ${phase} read`, async () => {
    let signal;
    const stalled = () => new Promise(() => {});
    const read = fetchSodaRowsWithRetry("https://example.test/soda", {
      budgetMs: 15,
      fetchFn: async (_url, options) => {
        signal = options?.signal;
        if (phase === "headers") return stalled();
        return { ok: true, json: stalled };
      },
    });
    const outcome = await Promise.race([
      read.then(() => "unexpected-success", (error) => error),
      new Promise((resolve) => setTimeout(() => resolve("deadline-not-enforced"), 100)),
    ]);
    assert.ok(outcome instanceof Error, String(outcome));
    assert.match(outcome.message, /deadline|timed out/i);
    assert.equal(outcome.upstream_source, "soda");
    assert.equal(signal?.aborted, true);
  });
}
