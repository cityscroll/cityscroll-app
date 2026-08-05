import assert from "node:assert/strict";
import test from "node:test";

import { evaluateNowReadingRatchet, nowReadingCopy } from "../tools/now_reading_level.mjs";

test("Now reading census includes visible Now copy and excludes hover-only provenance", () => {
  const copy = nowReadingCopy({
    now_title: "Now",
    now_date_responses_due: "Responses due",
    now_date_source_field: "Source field: {field}",
    unrelated: "Not part of the surface",
  });
  assert.deepEqual(copy.map((row) => row.key), ["now_title", "now_date_responses_due"]);
});

test("Now reading-level ratchet fails only when grade rises above its baseline", () => {
  const baseline = { metrics: { grade_level: { baseline: 7.98 } } };
  assert.equal(evaluateNowReadingRatchet(7.98, baseline).pass, true);
  assert.equal(evaluateNowReadingRatchet(8.01, baseline).pass, false);
});
