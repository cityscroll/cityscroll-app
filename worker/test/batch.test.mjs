import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNames, MAX_NAMES } from "../src/lib/batch.mjs";
import { handleBatch } from "../src/batch.mjs";
import { overActorLimit } from "../src/lib/meter.mjs";

test("parseNames: trims, dedupes case-insensitively, caps count and length", () => {
  const names = parseNames(["  Acme   Corp ", "acme corp", "AB", "", "Sinergia Inc", "x".repeat(200)]);
  assert.deepEqual(names.slice(0, 2), ["Acme Corp", "Sinergia Inc"]);
  assert.ok(names.every(n => n.length <= 80));
  assert.equal(parseNames(Array.from({length: 50}, (_, i) => "Vendor Number " + i)).length, MAX_NAMES);
});

test("parseNames: non-arrays yield empty", () => {
  assert.deepEqual(parseNames("Acme"), []);
  assert.deepEqual(parseNames(null), []);
});

test("handleBatch rate-limits by IP without putting the IP in KV keys", async () => {
  const store = new Map();
  const NL_METER = {
    async get(key) { return store.get(key) ?? null; },
    async put(key, value) { store.set(key, String(value)); },
  };
  const ip = "203.0.113.23";
  for (let i = 0; i < 30; i++) {
    assert.equal(await overActorLimit(NL_METER, "batch", ip, 30), false);
  }

  const response = await handleBatch(
    new Request("https://w/batch", {
      method: "POST",
      headers: { "content-type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify({ names: ["Acme Corp"] }),
    }),
    { NL_METER },
  );

  assert.equal(response.status, 429);
  const keys = [...store.keys()];
  assert.equal(keys.length, 1);
  assert.match(keys[0], /^rl:batch:a:[0-9a-f]{64}:\d{4}-\d{2}-\d{2}$/);
  assert.ok(!keys[0].includes(ip));
});
