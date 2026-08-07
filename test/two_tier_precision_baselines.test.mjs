import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const receipt = JSON.parse(readFileSync(
  new URL("../docs/evidence/two-tier-precision-baselines-2026-08-06.json", import.meta.url),
  "utf8",
));

test("dated baseline receipt records deterministic samples and methods", () => {
  assert.equal(receipt.schema, "cityscroll.two_tier_precision_baselines.v1");
  assert.equal(receipt.observed_on, "2026-08-06");
  assert.equal(receipt.baselines.exam_interest_area_categorization.sample_size, 8);
  assert.equal(receipt.baselines.exam_interest_area_categorization.precision, 1);
  assert.equal(receipt.baselines.legacy_agency_string_matching.sample_size, 17);
  assert.equal(receipt.baselines.legacy_agency_string_matching.precision, 1);
  assert.equal(receipt.baselines.staffing_derived_fields.appointment_sample_size, 40);
  assert.equal(receipt.baselines.staffing_derived_fields.annual_schedule_sample_size, 40);
  assert.equal(receipt.baselines.staffing_derived_fields.precision, 1);
  assert.equal(receipt.baselines.title_code_legacy_review.precision, 0.2778);
  for (const baseline of Object.values(receipt.baselines)) {
    assert.ok(baseline.method);
    assert.ok(baseline.source_records);
  }
});
