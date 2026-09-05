// LM-12: fixed cost budgets and typed failure classification for the Land Map.
//
// These tests pin the taxonomy itself -- separately from the Map shell that consumes it in
// test/land_map_performance_and_failure.test.mjs -- so the classification rules and the retry
// bound are provable without a DOM: a permanent failure (a real HTTP status, or a response
// that fails validation) is never retried, a transient one (no response at all, or one that
// arrives too late) is retried up to a fixed bound, and a request that never settles is bounded
// to the fixed time budget regardless of what the underlying fetch implementation does with an
// abort signal.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  LAND_MAP_BUDGETS,
  LAND_MAP_FAILURE_KINDS,
  LAND_MAP_PERFORMANCE_SCHEMA,
  LandMapFailure,
  fetchLandMapArtifact,
  fetchWithBudget,
  landMapFailureKindOf,
} from "../site/land_map_performance_budget.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const noWait = () => Promise.resolve();

test("the schema and every fixed budget are named and positive", () => {
  assert.equal(LAND_MAP_PERFORMANCE_SCHEMA, "cityscroll.land_map_performance_budget.v1");
  for (const [name, value] of Object.entries(LAND_MAP_BUDGETS)) {
    assert.ok(Number.isFinite(value) && value > 0, `${name} is not a positive fixed number`);
  }
  assert.deepEqual(Object.keys(LAND_MAP_FAILURE_KINDS).sort(), [
    "DEPENDENCY", "INVALID_DATA", "PROJECTION", "TILE", "TIMEOUT", "UNKNOWN",
  ]);
});

/* ===== permanent failures: never retried ===== */

test("a real HTTP status is classified 'projection' and is never retried", async () => {
  let calls = 0;
  const fetchImpl = () => { calls += 1; return Promise.resolve({ ok: false, status: 404 }); };
  await assert.rejects(
    fetchLandMapArtifact("x.json", { fetchImpl, wait: noWait }),
    (error) => {
      assert.ok(error instanceof LandMapFailure);
      assert.equal(error.landMapFailureKind, LAND_MAP_FAILURE_KINDS.PROJECTION);
      assert.equal(error.transient, false);
      return true;
    },
  );
  assert.equal(calls, 1, "a 404 must not be retried");
});

test("a response failing validation is classified 'invalid-data' and is never retried", async () => {
  let calls = 0;
  const fetchImpl = () => {
    calls += 1;
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ schema: "wrong" }) });
  };
  await assert.rejects(
    fetchLandMapArtifact("x.json", { fetchImpl, wait: noWait, validate: (payload) => Boolean(payload?.points) }),
    (error) => {
      assert.equal(error.landMapFailureKind, LAND_MAP_FAILURE_KINDS.INVALID_DATA);
      assert.equal(error.transient, false);
      return true;
    },
  );
  assert.equal(calls, 1, "a schema violation must not be retried");
});

test("a response body that cannot be parsed is classified 'invalid-data'", async () => {
  const fetchImpl = () => Promise.resolve({
    ok: true, status: 200, json: () => Promise.reject(new SyntaxError("Unexpected token")),
  });
  await assert.rejects(
    fetchLandMapArtifact("x.json", { fetchImpl, wait: noWait }),
    (error) => {
      assert.equal(error.landMapFailureKind, LAND_MAP_FAILURE_KINDS.INVALID_DATA);
      return true;
    },
  );
});

/* ===== transient failures: bounded retry ===== */

test("a network-level rejection is classified 'dependency', retried up to the fixed bound, then thrown", async () => {
  let calls = 0;
  const fetchImpl = () => { calls += 1; return Promise.reject(new TypeError("Failed to fetch")); };
  await assert.rejects(
    fetchLandMapArtifact("x.json", { fetchImpl, wait: noWait, retries: 2 }),
    (error) => {
      assert.equal(error.landMapFailureKind, LAND_MAP_FAILURE_KINDS.DEPENDENCY);
      assert.equal(error.transient, true);
      return true;
    },
  );
  assert.equal(calls, 3, "one initial attempt plus exactly `retries` retries");
});

test("a transient failure that recovers on a later attempt succeeds", async () => {
  let calls = 0;
  const points = { schema: "cityscroll.land_project_map_points.v1", points: {} };
  const fetchImpl = () => {
    calls += 1;
    if (calls < 3) return Promise.reject(new TypeError("Failed to fetch"));
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(points) });
  };
  const { payload, attempts } = await fetchLandMapArtifact("x.json", { fetchImpl, wait: noWait, retries: 2 });
  assert.deepEqual(payload, points);
  assert.equal(attempts, 2, "recovered on the second retry");
  assert.equal(calls, 3);
});

test("a request that never settles is bounded to the fixed time budget and classified 'timeout'", async () => {
  const hang = () => new Promise(() => {}); // never resolves or rejects
  const now = Date.now();
  await assert.rejects(
    fetchWithBudget(hang, "x.json", { timeoutMs: 30 }),
    (error) => {
      assert.equal(error.landMapFailureKind, LAND_MAP_FAILURE_KINDS.TIMEOUT);
      assert.equal(error.transient, true);
      return true;
    },
  );
  const nowMs = Date.now();
  assert.ok(nowMs - now < 500, "the hang protection must not itself wait out anything close to the real budget");
});

test("a timeout is retried up to the fixed bound like any other transient failure", async () => {
  let calls = 0;
  const hang = () => { calls += 1; return new Promise(() => {}); };
  await assert.rejects(
    fetchLandMapArtifact("x.json", { fetchImpl: hang, wait: noWait, timeoutMs: 10, retries: 1 }),
    (error) => {
      assert.equal(error.landMapFailureKind, LAND_MAP_FAILURE_KINDS.TIMEOUT);
      return true;
    },
  );
  assert.equal(calls, 2, "one initial attempt plus one retry");
});

/* ===== an error this module did not throw is still named honestly ===== */

test("landMapFailureKindOf names an unrelated error 'unknown' rather than guessing", () => {
  assert.equal(landMapFailureKindOf(new TypeError("boom")), LAND_MAP_FAILURE_KINDS.UNKNOWN);
  assert.equal(landMapFailureKindOf(null), LAND_MAP_FAILURE_KINDS.UNKNOWN);
  const failure = new LandMapFailure(LAND_MAP_FAILURE_KINDS.PROJECTION, "x");
  assert.equal(landMapFailureKindOf(failure), LAND_MAP_FAILURE_KINDS.PROJECTION);
});

/* ===== projection-size and List-snapshot bounds: fixed before measurement ===== */

test("the committed projection stays within its fixed byte budget", () => {
  const bytes = Buffer.byteLength(read("site/data/land_project_map_points.json"));
  assert.ok(bytes > 0);
  assert.ok(
    bytes <= LAND_MAP_BUDGETS.map_projection_bytes_max,
    `land_project_map_points.json is ${bytes} bytes, over the ${LAND_MAP_BUDGETS.map_projection_bytes_max}-byte budget`,
  );
});

test("the committed default Land List snapshot stays within its fixed byte budget", () => {
  const bytes = Buffer.byteLength(read("site/data/land_default_ulurp.json"));
  assert.ok(bytes > 0);
  assert.ok(
    bytes <= LAND_MAP_BUDGETS.list_snapshot_bytes_max,
    `land_default_ulurp.json is ${bytes} bytes, over the ${LAND_MAP_BUDGETS.list_snapshot_bytes_max}-byte budget`,
  );
});
