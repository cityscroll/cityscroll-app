// Contract test: index.html's NL_SUGGESTIONS_FALLBACK idx lists must equal the worker's
// FALLBACK_INDICES (see docs/drift-inventory.md #12) — the exact case the inventory pass flagged
// as "no cross-check test exists, unlike the external-award registry or LENSES schema pairs".
// The `people` lens is a documented, deliberate one-way exception (the worker has no people
// candidate pool at all — compileSub() can't replay payroll-title counting yet) and is excluded
// from the comparison rather than silently ignored.
//
//   node --test test/contract/suggestion_fallback.test.mjs   (from the crol-list/ dir)

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractConst } from "./site_extract.mjs";
import { FALLBACK_INDICES as WORKER_FALLBACK, SUGGESTION_POOL } from "../../worker/src/lib/suggestions.mjs";

const SITE_FALLBACK = new Function(extractConst("NL_SUGGESTIONS_FALLBACK") + "\nreturn NL_SUGGESTIONS_FALLBACK;")();

test("people lens is the only key present client-side but absent from the worker pool (documented gap)", () => {
  assert.ok("people" in SITE_FALLBACK, "expected the documented people-only client fallback to still exist");
  assert.ok(!("people" in WORKER_FALLBACK), "worker gained a people fallback — update this test's documented exception");
});

for (const lens of Object.keys(WORKER_FALLBACK)) {
  test(`NL_SUGGESTIONS_FALLBACK.${lens} matches worker's FALLBACK_INDICES.${lens}`, () => {
    assert.deepEqual(SITE_FALLBACK[lens], WORKER_FALLBACK[lens]);
  });
}

test("every fallback idx names a candidate that actually exists in the worker's SUGGESTION_POOL", () => {
  for (const [lens, indices] of Object.entries(WORKER_FALLBACK)) {
    for (const idx of indices) {
      assert.ok(
        SUGGESTION_POOL.some((c) => c.lens === lens && c.idx === idx),
        `${lens} idx ${idx} has no matching SUGGESTION_POOL candidate`,
      );
    }
  }
});
