import assert from "node:assert/strict";
import { test } from "node:test";

import { fetchSodaRowsWithRetry, runAlerts } from "../src/alerts.mjs";

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

test("static-watch progress checkpoints every success and error", async () => {
  const originalFetch = globalThis.fetch;
  const progress = [];
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1
      ? Response.json([{ request_id: "20261012001", start_date: "2026-10-12" }])
      : new Response(null, { status: 400 });
  };
  try {
    await runAlerts({}, [
      { id: "first", label: "First", where: "agency_name='First'" },
      { id: "second", label: "Second", where: "agency_name='Second'" },
    ], {
      capturePreviews: true,
      persist: false,
      skipSubscriptions: true,
      skipForecastingPipelines: true,
      suppressDryRunLogs: true,
      onProgress: async (entry) => { progress.push(entry); },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(
    progress.filter((entry) => entry.phase === "static_watches").map((entry) => entry.evaluated_count),
    [0, 1, 2],
  );
});

for (const phase of ["headers", "body"]) {
  test(`legacy watch permits a slow successful ${phase} read inside its bounded default deadline`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const rows = [{ request_id: "20261012001" }];
    const afterSourceDelay = (value) => new Promise((resolve) => setTimeout(() => resolve(value), 45_000));
    const response = { ok: true, json: () => phase === "body" ? afterSourceDelay(rows) : Promise.resolve(rows) };
    const pending = fetchSodaRowsWithRetry("https://example.test/soda", {
      fetchFn: () => phase === "headers" ? afterSourceDelay(response) : Promise.resolve(response),
    });
    pending.catch(() => {});
    // Let the body reader start before advancing its simulated source delay.
    await Promise.resolve();
    await Promise.resolve();
    t.mock.timers.tick(45_000);
    assert.deepEqual(await pending, rows);
  });
}

test("legacy watch default deadline still aborts an indefinitely stalled request", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let signal;
  const pending = fetchSodaRowsWithRetry("https://example.test/soda", {
    fetchFn: (_url, options) => { signal = options.signal; return new Promise(() => {}); },
  });
  pending.catch(() => {});
  t.mock.timers.tick(59_999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  await assert.rejects(pending, (error) => error.upstream_source === "soda" && signal.aborted);
});
