import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { validateFieldPerformanceEvidence } from "../site/field_performance_evidence.mjs";
import { validateNoticeContextReadinessEvidence } from "../site/notice_context_readiness.mjs";
import { validateNoticePrimaryReadinessEvidence } from "../site/notice_primary_readiness.mjs";

const browseReadBack = JSON.parse(readFileSync(
  new URL("../docs/evidence/browse-contracts-first-page-read-back/read-back.json", import.meta.url),
  "utf8",
));
const contextReadBack = JSON.parse(readFileSync(
  new URL("../docs/evidence/notice-context-readiness/read-back.json", import.meta.url),
  "utf8",
));
const primaryReadBack = JSON.parse(readFileSync(
  new URL("../docs/evidence/notice-primary-readiness/read-back.json", import.meta.url),
  "utf8",
));

function productionFieldEvidence(overrides = {}) {
  return {
    schema: "cityscroll.browse_contracts_content_ready_readback.v1",
    metric_id: "content_ready_ms",
    surface_id: "browse-contracts",
    component_id: "none",
    provenance: {
      schema: "cityscroll.performance.field_provenance.v1",
      source: "production field",
      measurement_class: "field",
      route: "/browse/contracts/",
      code_revision: "a".repeat(40),
      data_vintage: "crol_rum_observations_v1",
      observation_window: {
        start: "2026-09-07T00:00:00.000Z",
        end: "2026-09-14T00:00:00.000Z",
      },
      sample_count: 30,
    },
    ...overrides,
  };
}

test("field gates reject fixture and lab provenance", () => {
  assert.deepEqual(validateFieldPerformanceEvidence(browseReadBack), { ok: true, errors: [] });
  const insufficientResult = validateFieldPerformanceEvidence(browseReadBack, { requireSufficient: true });
  assert.equal(insufficientResult.ok, false);

  const fixtureResult = validateFieldPerformanceEvidence({
    ...browseReadBack,
    provenance: {
      schema: "cityscroll.performance.field_provenance.v1",
      source: "fixture",
      measurement_class: "fixture",
    },
  });
  assert.equal(fixtureResult.ok, false);
  assert.ok(fixtureResult.errors.some((error) => /production field provenance/.test(error)));
  assert.equal(validateNoticeContextReadinessEvidence({
    ...contextReadBack,
    provenance: { ...contextReadBack.provenance, source: "fixture", measurement_class: "fixture" },
  }).ok, false);
  assert.equal(validateNoticePrimaryReadinessEvidence({
    ...primaryReadBack,
    provenance: { ...primaryReadBack.provenance, source: "lab", measurement_class: "lab" },
  }).ok, false);

  const missingResult = validateFieldPerformanceEvidence({ ...browseReadBack, provenance: undefined });
  assert.equal(missingResult.ok, false);
  assert.equal(validateNoticePrimaryReadinessEvidence(
    { ...primaryReadBack, provenance: undefined },
    { requireFieldProvenance: true },
  ).ok, false);

  const labResult = validateFieldPerformanceEvidence(productionFieldEvidence({
    provenance: { ...productionFieldEvidence().provenance, source: "lab" },
  }));
  assert.equal(labResult.ok, false);
});

test("field gates accept production-field provenance at the retained-row floor", () => {
  const result = validateFieldPerformanceEvidence(productionFieldEvidence());
  assert.deepEqual(result, { ok: true, errors: [] });
});
