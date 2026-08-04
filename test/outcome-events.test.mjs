import test from "node:test";
import assert from "node:assert/strict";
import { OUTCOME_ENUM, outcomeEvent } from "../worker/src/lib/action_registry.mjs";
import { normalizeUsageEvent } from "../worker/src/lib/analytics.mjs";

test("voluntary outcome enum is small and fixed", () => {
  assert.deepEqual(OUTCOME_ENUM, ["submitted", "attended", "bid", "won", "not_useful"]);
});

test("outcome events contain no person, query, notice, process, or URL", () => {
  for (const outcome of OUTCOME_ENUM) {
    const event = outcomeEvent(outcome);
    assert.deepEqual(Object.keys(event).sort(), ["detail", "event", "surface"]);
    assert.ok(normalizeUsageEvent(event));
    assert.doesNotMatch(JSON.stringify(event), /person|email|query|notice|process|https?:/i);
  }
});

test("unknown outcomes are rejected", () => {
  assert.throws(() => outcomeEvent("clicked"), /unknown outcome/);
});

test("aggregate prompt completion and abandonment events have no joinable identity", () => {
  for (const event of [
    { event: "outcome_prompted", detail: "official-handoff", surface: "home" },
    { event: "outcome_prompted", detail: "passed-action", surface: "home" },
    { event: "outcome_dismissed", detail: "official-handoff", surface: "home" },
    { event: "outcome_dismissed", detail: "passed-action", surface: "home" },
  ]) {
    const normalized = normalizeUsageEvent(event);
    assert.ok(normalized);
    assert.doesNotMatch(JSON.stringify(normalized), /person|email|query|notice|process|https?:/i);
  }
});
