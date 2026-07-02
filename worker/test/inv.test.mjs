import { test } from "node:test";
import assert from "node:assert/strict";
import { validInvPayload, MAX_INV_BYTES } from "../src/lib/inv.mjs";

test("validInvPayload: clamps fields, keeps shape", () => {
  const v = validInvPayload({ name: "scaffold contracts", items: [
    { t: "notice", id: "20260625017", title: "Award — prevention services", meta: "ACS · $10.8M", note: "check subs", added: "2026-07-02" },
  ]});
  assert.equal(v.name, "scaffold contracts");
  assert.equal(v.items.length, 1);
  assert.equal(v.items[0].id, "20260625017");
  assert.ok(v.sharedAt);
});

test("validInvPayload: rejects empty, oversized, and junk", () => {
  assert.equal(validInvPayload(null), null);
  assert.equal(validInvPayload({ name: "x", items: [] }), null);
  const big = { name: "x", items: Array.from({length: 150}, (_, i) => ({ t: "notice", id: String(i), title: "t".repeat(300), note: "n".repeat(1000) })) };
  assert.equal(validInvPayload(big), null, "over the byte cap");
  const many = { name: "x", items: Array.from({length: 500}, () => ({ t: "notice", id: "1", title: "t" })) };
  assert.equal(validInvPayload(many), null);
});
