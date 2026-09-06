import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeLandActionEvidence,
  resolveLandActionProcedures,
} from "../site/land_action_procedure_resolution.mjs";

// A ULURP project with one `C`-numbered ULURP application and one `N`-numbered
// related action filed with it. The publisher used to describe a project's
// actions only as a prefix-less string; it now also sends a per-action array
// carrying the prefixed application numbers. The same project must resolve the
// same way whichever shape arrives, or a project's authority summary would
// depend on the publisher's delivery format rather than on its actions.
const PROJECT = Object.freeze({
  project_id: "2024K0196",
  actions: "ZM; ZR",
  ulurp_numbers: "260135ZMK; 260136ZRK",
  ulurp_non: "ULURP",
  current_milestone: "EAS - Review Session - Pre-Hearing Review / Post Referral",
});

const PER_ACTION_ARRAY = Object.freeze([
  { action: "ZR", ulurp_number: "N260136ZRK", status: "Referred", approved: false },
  { action: "ZM", ulurp_number: "C260135ZMK", status: "Certified", approved: true },
]);

function resolveWith(outcomeActions) {
  return resolveLandActionProcedures(
    mergeLandActionEvidence({ project: PROJECT, outcomes: { actions: outcomeActions } }),
  );
}

test("a ULURP project resolves the same whether the publisher sends per-action arrays or not", () => {
  const shapes = {
    absent: resolveWith(undefined),
    null: resolveWith(null),
    empty: resolveWith([]),
    populated: resolveWith(PER_ACTION_ARRAY),
  };
  for (const [name, resolution] of Object.entries(shapes)) {
    assert.equal(resolution.procedure_resolution, "uniform", `${name} shape`);
    const ids = new Set(resolution.land_actions.map((action) => action.procedure_id));
    assert.deepEqual([...ids], ["ulurp_197c"], `${name} shape resolves one governing procedure`);
  }
});

test("an N-numbered companion never selects a second procedure for a declared ULURP project", () => {
  const resolution = resolveWith(PER_ACTION_ARRAY);
  const companion = resolution.land_actions.find((action) => action.action_type === "ZR");
  assert.ok(companion, "the related action is still reported");
  assert.equal(companion.status, "resolved");
  assert.equal(
    companion.procedure_id,
    "ulurp_197c",
    "the companion is reviewed in the project's ULURP process, not a procedure of its own",
  );
});

test("a declared non-ULURP project still resolves as non-ULURP", () => {
  const resolution = resolveLandActionProcedures(mergeLandActionEvidence({
    project: { ...PROJECT, project_id: "2024K9999", ulurp_non: "Non-ULURP", actions: "ZR", ulurp_numbers: "260136ZRK" },
    outcomes: { actions: [{ action: "ZR", ulurp_number: "N260136ZRK", status: "Referred", approved: false }] },
  }));
  assert.equal(resolution.procedure_resolution, "uniform");
  assert.deepEqual(
    [...new Set(resolution.land_actions.map((action) => action.procedure_id))],
    ["non_ulurp"],
  );
});
