import assert from "node:assert/strict";
import test from "node:test";

import { withWorkerAcquisitionReceipt } from "../src/lib/worker_acquisition_runtime.mjs";

test("a successful refresh preserves its last-good result when receipt storage fails", async () => {
  const errors = [];
  const result = await withWorkerAcquisitionReceipt(
    {
      ALERT_STATE: {
        async put() { throw new Error("receipt KV unavailable"); },
      },
    },
    "citywide-payroll",
    "scheduled:test",
    async () => ({ status: "success", generated_at: "2026-10-26T13:00:00.000Z" }),
    { logger: { error: (...args) => errors.push(args) } },
  );

  assert.equal(result.status, "success");
  assert.equal(errors.length, 1);
  assert.match(errors[0].join(" "), /source acquisition success receipt failed/);
  assert.match(errors[0].join(" "), /receipt KV unavailable/);
});

test("a failed refresh reports a failed-receipt write without hiding the source error", async () => {
  const errors = [];
  await assert.rejects(
    withWorkerAcquisitionReceipt(
      {
        ALERT_STATE: {
          async put() { throw new Error("receipt KV unavailable"); },
        },
      },
      "nyc-council-legistar",
      "scheduled:test",
      async () => { throw new Error("publisher unavailable"); },
      { logger: { error: (...args) => errors.push(args) } },
    ),
    /publisher unavailable/,
  );

  assert.equal(errors.length, 1);
  assert.match(errors[0].join(" "), /source acquisition failure receipt failed/);
  assert.match(errors[0].join(" "), /receipt KV unavailable/);
});
