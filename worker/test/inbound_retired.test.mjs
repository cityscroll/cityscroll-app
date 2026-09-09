import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/worker.mjs";

test("inbound subscription requests record a receipt without parsing, sending, or changing watches", async () => {
  const receipts = new Map();
  const watches = new Map([["existing", "unchanged"]]);
  const pending = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { assert.fail("inbound mail must not call a model or mail provider"); };
  try {
    await worker.email({
      from: "resident@example.net",
      to: "subscribe@example.org",
      headers: new Headers({ subject: "rezoning notices in Brooklyn" }),
      get raw() { assert.fail("retired inbound mail must not read the body"); },
    }, {
      TOKEN_SECRET: "test-secret",
      RESEND_API_KEY: "test-key",
      SUBS: {
        async get(key) { return watches.get(key); },
        async put() { assert.fail("must not create or change a watch"); },
        async delete() { assert.fail("must not delete a watch"); },
      },
      ALERT_STATE: { async put(key, value) { receipts.set(key, JSON.parse(value)); } },
    }, { waitUntil(promise) { pending.push(promise); } });
    await Promise.all(pending);
    assert.equal(receipts.get("ops:mail:inbound:latest").disposition, "retired");
    assert.deepEqual([...watches], [["existing", "unchanged"]]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
