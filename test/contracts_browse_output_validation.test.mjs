import assert from "node:assert/strict";
import test from "node:test";
import { validateContractsBrowseOutput } from "../capabilities/contracts.mjs";

function page(availability = "complete", limit = 25) {
  const contract = {
    object_type: "procurement",
    procurement_id: "procurement:contract:SYNTHETIC",
    canonical_id: "procurement:contract:SYNTHETIC",
    provenance: {
      identity: { exact: true },
      source_observations: [{ source_system: "synthetic", source_id: "one" }],
    },
    coverage: { state: "observed" },
    freshness: { as_of: "2026-11-03T10:00:00Z" },
    amount: { valid: false, value: null },
  };
  const results = availability === "unavailable" ? null : availability === "empty" ? [] : [contract];
  return {
    capability_reference: "contracts.browse@1",
    availability,
    results,
    total_matches: results?.length ?? 0,
    pagination: { limit, returned: results?.length ?? 0, truncated: false, next_cursor: null },
    coverage: { state: "observed" },
    freshness: { as_of: "2026-11-03T10:00:00Z" },
    error: availability === "unavailable" ? "unavailable" : null,
  };
}

test("typed pagination limits retain valid boundary values", () => {
  for (const limit of [1, 25, 100]) {
    const output = page("complete", limit);
    assert.equal(validateContractsBrowseOutput(output, { limit }), output);
  }
});

test("a missing returned page limit is rejected", () => {
  const output = page();
  delete output.pagination.limit;
  assert.throws(() => validateContractsBrowseOutput(output, {}), TypeError);
});

test("a fractional returned page limit is rejected", () => {
  const output = page();
  output.pagination.limit = 1.5;
  assert.throws(() => validateContractsBrowseOutput(output, {}), TypeError);
});

test("a string returned page limit is rejected without coercion", () => {
  const output = page();
  output.pagination.limit = "25";
  assert.throws(() => validateContractsBrowseOutput(output, {}), TypeError);
});

test("forbidden data is rejected in every availability state", () => {
  for (const availability of ["complete", "empty", "unavailable"]) {
    for (const field of ["raw_snapshot", "review_status"]) {
      const output = page(availability);
      output.diagnostics = { entries: [{ [field]: "synthetic forbidden value" }] };
      assert.throws(() => validateContractsBrowseOutput(output, {}), /private field/);
    }
  }
});

test("unavailable responses retain benign diagnostics and null results", () => {
  const output = page("unavailable");
  output.diagnostics = { trace_id: "synthetic trace" };
  assert.equal(validateContractsBrowseOutput(output, {}), output);
  assert.equal(output.results, null);
  assert.equal(output.diagnostics.trace_id, "synthetic trace");
});

test("existing row-count and duplicate-identity checks remain active", () => {
  const wrongCount = page();
  wrongCount.pagination.returned = 2;
  assert.throws(() => validateContractsBrowseOutput(wrongCount, {}), TypeError);
  const duplicate = page();
  duplicate.results.push(structuredClone(duplicate.results[0]));
  duplicate.total_matches = 2;
  duplicate.pagination.returned = 2;
  assert.throws(() => validateContractsBrowseOutput(duplicate, {}), TypeError);
});

test("validation keeps valid provider data unchanged", () => {
  const output = page();
  output.diagnostics = { state: "synthetic evidence" };
  const before = structuredClone(output);
  function freeze(value) {
    if (value && typeof value === "object") {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    return value;
  }
  freeze(output);
  assert.equal(validateContractsBrowseOutput(output, {}), output);
  assert.deepEqual(output, before);
});
