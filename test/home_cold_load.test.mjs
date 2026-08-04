import assert from "node:assert/strict";
import test from "node:test";

import {
  highLoadNote,
  homeColdLoadDecision,
} from "../tools/home_cold_load.mjs";

test("home.cold runs when mocked loadavg is below the per-core threshold", () => {
  const decision = homeColdLoadDecision({ loadAverage: 7.99, cpuCount: 8 });
  assert.equal(decision.skip, false);
});

test("home.cold skips when mocked loadavg reaches the per-core threshold", () => {
  const decision = homeColdLoadDecision({ loadAverage: 8, cpuCount: 8 });
  assert.equal(decision.skip, true);
  assert.equal(
    highLoadNote(decision),
    "preflight: SKIP home.cold performance fixture — high machine load (1m loadavg 8.00 across 8 cores); CI's Performance budgets (20-sample p95) job is the measurement.",
  );
});
