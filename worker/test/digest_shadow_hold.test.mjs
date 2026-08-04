import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DIGEST_SHADOW_HOLD_CONTRACT,
  buildDigestShadowHoldState,
  digestIdForJob,
  isDigestHeld,
  partitionDigestJobsByHold,
  resolveDigestShadowHold,
} from "../src/digest_shadow_hold.mjs";

const DAY = "2026-08-04";

function redlined(ids = ["digest:one"]) {
  return {
    contract: "digest-shadow.v1",
    run_day: DAY,
    ran_at: `${DAY}T10:00:00.000Z`,
    status: "NEEDS_ATTENTION",
    ok: false,
    affected_digest_ids: ids,
    redlines: ids.map((digestId) => ({ code: "render_error", digest_id: digestId })),
  };
}

function ready() {
  return {
    contract: "digest-shadow.v1",
    run_day: DAY,
    ran_at: `${DAY}T12:50:00.000Z`,
    status: "READY",
    ok: true,
    affected_digest_ids: [],
    redlines: [],
  };
}

test("redlined digest ids become scoped holds at the documented cutoff and remain held at delivery", () => {
  const pending = buildDigestShadowHoldState({
    summary: redlined(["digest:one", "digest:two"]),
    now: `${DAY}T12:44:59.000Z`,
  });
  assert.equal(pending.contract, DIGEST_SHADOW_HOLD_CONTRACT);
  assert.equal(pending.source_status, "REDLINES_REPAIR_WINDOW");
  assert.deepEqual(pending.active_digest_ids, []);

  const cutoff = buildDigestShadowHoldState({
    summary: redlined(["digest:one", "digest:two"]),
    now: `${DAY}T12:45:00.000Z`,
  });
  assert.equal(cutoff.delivery_policy, "AFFECTED_DIGESTS_HELD");
  assert.deepEqual(cutoff.active_digest_ids, ["digest:one", "digest:two"]);

  const boundary = buildDigestShadowHoldState({
    summary: redlined(["digest:one", "digest:two"]),
    now: `${DAY}T13:00:00.000Z`,
  });
  assert.equal(isDigestHeld(boundary, "digest:one"), true);
  assert.equal(isDigestHeld(boundary, "digest:unrelated"), false);
});

test("holds expire automatically after the delivery window", () => {
  const state = buildDigestShadowHoldState({
    summary: redlined(),
    now: `${DAY}T14:00:00.000Z`,
  });
  assert.equal(state.source_status, "REDLINES_HOLD_EXPIRED");
  assert.equal(state.delivery_policy, "ALL_DIGESTS_ELIGIBLE");
  assert.deepEqual(state.active_digest_ids, []);
});

test("missing runs and hold-store failures are distinct fail-open states", async () => {
  const missing = buildDigestShadowHoldState({ summary: null, now: `${DAY}T13:00:00.000Z` });
  assert.equal(missing.source_status, "MISSING_RUN");
  assert.equal(missing.delivery_policy, "ALL_DIGESTS_ELIGIBLE");

  const unavailable = await resolveDigestShadowHold({
    prepare() { throw new Error("D1 unavailable"); },
  }, { now: `${DAY}T13:00:00.000Z` });
  assert.equal(unavailable.source_status, "HOLD_STORE_UNAVAILABLE");
  assert.equal(unavailable.delivery_policy, "ALL_DIGESTS_ELIGIBLE");
  assert.match(unavailable.observation, /D1 unavailable/);
});

test("partial repair narrows the hold and a READY rerun releases every digest", () => {
  const partial = buildDigestShadowHoldState({
    summary: redlined(["digest:two"]),
    now: `${DAY}T13:00:00.000Z`,
  });
  assert.deepEqual(partial.active_digest_ids, ["digest:two"]);
  assert.equal(isDigestHeld(partial, "digest:one"), false);

  const released = buildDigestShadowHoldState({
    summary: ready(),
    now: `${DAY}T13:00:00.000Z`,
  });
  assert.equal(released.source_status, "READY");
  assert.equal(released.delivery_policy, "ALL_DIGESTS_ELIGIBLE");
  assert.deepEqual(released.active_digest_ids, []);
});

test("operator overrides release only named affected digests", () => {
  const state = buildDigestShadowHoldState({
    summary: redlined(["digest:one", "digest:two"]),
    overriddenDigestIds: ["digest:one"],
    now: `${DAY}T13:00:00.000Z`,
  });
  assert.deepEqual(state.overridden_digest_ids, ["digest:one"]);
  assert.deepEqual(state.active_digest_ids, ["digest:two"]);
});

test("queue partition leaves unrelated accounts eligible", async () => {
  const single = { type: "sub", key: "sub:single", email: "single" + "@example.com" };
  const rollup = {
    type: "rollup",
    email: "rollup" + "@example.com",
    keys: ["sub:b", "sub:a"],
  };
  const heldId = await digestIdForJob(single);
  const state = buildDigestShadowHoldState({
    summary: redlined([heldId]),
    now: `${DAY}T13:00:00.000Z`,
  });
  const out = await partitionDigestJobsByHold([single, rollup], state);
  assert.deepEqual(out.eligible, [rollup]);
  assert.equal(out.held.length, 1);
  assert.equal(out.held[0].digest_id, heldId);
  assert.equal(await digestIdForJob({ ...rollup, keys: ["sub:a", "sub:b"] }), await digestIdForJob(rollup));
});
