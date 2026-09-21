import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";

const readback = JSON.parse(readFileSync(
  new URL("../docs/evidence/passport-retained-families/fixture-readback.json", import.meta.url),
));

test("retained-family read-back exposes one direct assertion for each letter", () => {
  assert.equal(readback.schema, "cityscroll.passport_retained_families_fixture_readback.v1");
  assert.deepEqual(readback.assertions.map((entry) => entry.id), ["A1", "A2", "A3", "A4"]);
  for (const assertion of readback.assertions) {
    assert.equal(typeof assertion.name, "string");
    assert.ok(assertion.name.length > 0);
    assert.ok(assertion.claim);
    assert.ok(assertion.artifact);
  }
});

test("retained-family read-back keeps the named served facts readable", () => {
  const [a1, a2, a3, a4] = readback.assertions;
  assert.deepEqual(a1.claim.firematic, {
    ctr_ids: ["4561064", "4618449"],
    original_amount: 158997.84,
    current_amount: 208687.62,
    action_amount: 49689.78,
  });
  assert.deepEqual(a1.claim.tameer.revision_ctr_ids, [
    "4980664", "4982079", "4983925", "5224471", "5240965", "5243993",
    "5247650", "5340426", "5359354", "5371783", "5372858",
  ]);
  assert.equal(a2.artifact.emitted_shard.action_count, 12);
  assert.equal(a2.artifact.emitted_shard.base_action.action_role, "base");
  assert.equal(a3.claim.aha.current_amount, 46673.32);
  assert.equal(a3.claim.bhrags.paid_amount, 7385672.19);
  assert.equal(a3.claim.bhrags.encumbered_amount, 7385672.52);
  assert.equal(a4.claim.residual_exclusions, 0);
  assert.equal(a4.claim.pages_readback, "deployment-gated");
  for (const path of [
    readback.materialization.retained_rows,
    readback.materialization.selected_spine,
    readback.materialization.served_model,
    ...a4.artifact.served_artifacts,
  ]) {
    assert.equal(existsSync(new URL(`../${path}`, import.meta.url)), true, path);
  }
});
