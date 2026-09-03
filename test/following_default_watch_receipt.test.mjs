import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFollowingDefaultWatchReceipt,
  consumeFollowingDefaultWatchReceipt,
  setFollowingDefaultWatchReceipt,
  validateFollowingDefaultWatchReceipt,
} from "../site/following_default_watch_receipt.mjs";

const watch = {
  watch_id: "watch:contracts-citywide",
  lens: "money",
  filter: {},
  freq: "weekly",
  label: "Citywide contracts and RFPs",
  followingUrl: "/following/",
};

const FIXTURE_NOW = Date.parse("2026-01-01T00:00:00.000Z");

function storage() {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => {
      values.set(key, String(value));
      return true;
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

test("a built receipt validates as safe projection-only data", () => {
  const receipt = buildFollowingDefaultWatchReceipt({ watch, created: true, now: 0 });
  assert.equal(receipt.ok, true);
  const validation = validateFollowingDefaultWatchReceipt(receipt);
  assert.equal(validation.ok, true);
  assert.equal(receipt.workstream_card, "FS-16");
  assert.equal(receipt.version, 1);
  assert.equal(receipt.watch.lens, "money");
  assert.equal(receipt.watch.freq, "weekly");
});

test("consumed receipt is removed and cannot be replayed", () => {
  const store = storage();
  const receipt = buildFollowingDefaultWatchReceipt({ watch, created: true, now: FIXTURE_NOW });
  setFollowingDefaultWatchReceipt(receipt, store);
  const first = consumeFollowingDefaultWatchReceipt(store, FIXTURE_NOW);
  assert.equal(first.ok, true);
  assert.deepEqual(first.receipt.watch, receipt.watch);
  const second = consumeFollowingDefaultWatchReceipt(store, FIXTURE_NOW);
  assert.equal(second.ok, false);
  assert.equal(second.reason, "missing");
});

test("wrong schema, malformed payloads, and stale age are rejected without persistence", () => {
  const store = storage();
  const malformed = buildFollowingDefaultWatchReceipt({ watch: { ...watch, watch_id: "bad key", lens: "money", filter: [] }, created: true, now: 0 });
  assert.equal(malformed.ok, false);
  setFollowingDefaultWatchReceipt({ ...malformed }, store);
  const missing = consumeFollowingDefaultWatchReceipt(store, FIXTURE_NOW);
  assert.equal(missing.ok, false);

  const stale = buildFollowingDefaultWatchReceipt({ watch, created: true, now: FIXTURE_NOW - 1000 * 60 * 20 });
  store.setItem("cs_default_watch_handoff_v1", JSON.stringify({ ...stale, schema: "cityscroll.bad", issued_at: stale.issued_at }));
  const badSchema = consumeFollowingDefaultWatchReceipt(store, FIXTURE_NOW);
  assert.equal(badSchema.ok, false);
  assert.equal(badSchema.reason, "invalid");

  const staleTime = { ...buildFollowingDefaultWatchReceipt({ watch, created: true, now: FIXTURE_NOW - 1000 * 60 * 20 }) };
  staleTime.issued_at = new Date(FIXTURE_NOW - 1000 * 60 * 10).toISOString();
  setFollowingDefaultWatchReceipt(staleTime, store);
  const tooOld = consumeFollowingDefaultWatchReceipt(store, FIXTURE_NOW);
  assert.equal(tooOld.ok, false);
  assert.equal(tooOld.reason, "stale");
});
