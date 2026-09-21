import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";

const readback = JSON.parse(readFileSync(
  new URL("../docs/evidence/passport-retained-families/fixture-readback.json", import.meta.url),
));
const retained = JSON.parse(readFileSync(
  new URL("../site/data/passport_sources/retained_contract_families.json", import.meta.url),
));
const mergeReceipt = JSON.parse(readFileSync(
  new URL("../warehouse/receipts/proof/passport_retained_families_latest.json", import.meta.url),
));
const rowsByCtrId = new Map(retained.rows.map((row) => [String(row.ctr_id), row]));
const row = (ctrId) => rowsByCtrId.get(String(ctrId));
const assertionById = new Map(readback.assertions.map((assertion) => [assertion.id, assertion]));

function tameerRevisionRows() {
  const base = row(assertionById.get("A2").claim.base_ctr_id);
  return retained.rows
    .filter((candidate) => candidate.contract_id === base.contract_id && candidate.ctr_id !== base.ctr_id)
    .sort((left, right) => left.epin_norm.localeCompare(right.epin_norm));
}

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

test("A1 Firematic and TAMEER money claims match the retained source rows", () => {
  const claim = assertionById.get("A1").claim;
  const firematicBase = row(claim.firematic.ctr_ids[0]);
  const firematicAction = row(claim.firematic.ctr_ids[1]);
  assert.deepEqual(claim.firematic, {
    ctr_ids: [firematicBase.ctr_id, firematicAction.ctr_id],
    original_amount: firematicBase.award_amount,
    current_amount: firematicBase.current_amount,
    action_amount: firematicAction.current_amount,
  });

  const tameerBase = row(claim.tameer.base_ctr_id);
  const tameerAction = row(claim.tameer.action_ctr_id);
  const revisions = tameerRevisionRows();
  assert.deepEqual(claim.tameer, {
    base_ctr_id: tameerBase.ctr_id,
    revision_ctr_ids: revisions.map((revision) => revision.ctr_id),
    original_amount: tameerBase.award_amount,
    current_amount: tameerBase.current_amount,
    action_ctr_id: tameerAction.ctr_id,
    action_amount: tameerAction.current_amount,
  });
});

test("A2 TAMEER revision identity and publisher titles match retained source rows", () => {
  const claim = assertionById.get("A2").claim;
  const revisions = tameerRevisionRows();
  const base = retained.rows.find((candidate) => (
    candidate.contract_id === revisions[0].contract_id
    && candidate.contract_type === "General Contract (CT1)"
  ));
  assert.deepEqual(claim.revision_ctr_ids, revisions.map((revision) => revision.ctr_id));
  assert.deepEqual(claim.publisher_titles, Object.fromEntries(
    ["4980664", "5371783", "5372858"].map((ctrId) => [ctrId, row(ctrId).title]),
  ));
  assert.equal(claim.base_ctr_id, base.ctr_id);
});

test("A3 AHA and BHRAGS amounts match the retained source rows", () => {
  const claim = assertionById.get("A3").claim;
  const aha = row(claim.aha.ctr_id);
  const bhrags = row(claim.bhrags.ctr_id);
  assert.deepEqual(claim.aha, {
    ctr_id: aha.ctr_id,
    contract_id: aha.contract_id,
    served_contract_id: aha.contract_id.replaceAll("-", ""),
    program: aha.program,
    procurement_method: aha.procurement_method,
    current_amount: aha.current_amount,
  });
  assert.equal(claim.bhrags.ctr_id, bhrags.ctr_id);
  assert.equal(claim.bhrags.paid_amount, bhrags.paid_amount);
  assert.equal(claim.bhrags.encumbered_amount, bhrags.encumbered_amount);
});

test("A4 exclusion and offline stage counts match the retained-family receipt", () => {
  const claim = assertionById.get("A4").claim;
  const stages = mergeReceipt.stages;
  assert.equal(claim.residual_exclusions, stages.excluded);
  assert.equal(claim.residual_exclusions, mergeReceipt.excluded.length);
  assert.deepEqual(
    [claim.raw_rows, claim.parsed_rows, claim.selected_rows, claim.served_rows],
    [retained.rows.length, stages.retained_supplied, stages.retained_supplied, stages.retained_supplied],
  );
});
