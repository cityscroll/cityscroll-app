/**
 * Characterization: franchise/concession materialization view.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildFranchiseConcessionView } from "../src/franchise_concession.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = JSON.parse(
  readFileSync(join(ROOT, "test/fixtures/franchise_concession/field_cases.json"), "utf8"),
);

test("buildFranchiseConcessionView stamps franchise_spines from SODA rows", async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => fixture.notices,
  });
  const view = await buildFranchiseConcessionView(fetchImpl, new Date("2026-08-02T12:00:00Z"));
  assert.equal(view.schema_version, 1);
  assert.ok(Array.isArray(view.notices));
  assert.ok(view.notices.length >= 1);
  // Council zoning-franchises filtered by eligibility.
  assert.ok(!view.notices.some((n) => n.request_id === "council-zoning-franchises"));
  assert.ok(Array.isArray(view.franchise_spines));
  assert.ok(view.franchise_spines.length >= 1);
  assert.equal(
    view.franchise_metrics.metric,
    "franchise_concession_spine_completeness_rate",
  );
  const stamped = view.notices.find((n) => n.request_id === "20251007003");
  assert.ok(stamped);
  assert.equal(stamped.franchise_stage, "public_hearing");
  assert.match(stamped.franchise_subject_ref, /^franchise:party:onechronos/);
});
