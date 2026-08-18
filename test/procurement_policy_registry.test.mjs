import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PROCUREMENT_POLICY_SCHEMA,
  resolveProcurementPublicationPolicy,
  validateProcurementPolicyRegistry,
} from "../ontology/procurement_policy.mjs";
import { loadOntologyRegistry } from "../ontology/load.mjs";

const registry = loadOntologyRegistry().procurement_policy_registry;

const ordinaryFivePlusTen = {
  method_family: "ordinary_5_plus_10",
  procurement_category: "goods_and_non_construction_services",
  amount: 75_000,
  occurred_on: "2024-01-15",
};

const mwbeSmallPurchase = {
  method_family: "mwbe_small_purchase",
  procurement_category: "goods_and_non_construction_services",
  amount: 75_000,
  occurred_on: "2024-01-15",
};

test("registry versions PPB 3-08 policy for every bounded method family and stage", () => {
  assert.equal(registry.schema, PROCUREMENT_POLICY_SCHEMA);
  assert.equal(validateProcurementPolicyRegistry(registry), true);
  assert.deepEqual(
    registry.method_families.map(({ id }) => id).sort(),
    [
      "mwbe_small_purchase",
      "ordinary_5_plus_10",
      "ordinary_micropurchase",
      "unmapped_publisher_variant",
    ],
  );

  for (const family of registry.method_families) {
    assert.deepEqual(family.stages.map(({ id }) => id).sort(), ["award", "solicitation"]);
    for (const stage of family.stages) {
      assert.ok(["required", "not_required", "unknown"].includes(stage.publication_obligation));
      assert.ok(registry.access_scopes.includes(stage.access_scope));
      assert.equal(stage.legal_citation.rule, "PPB Rule § 3-08");
      assert.match(stage.legal_citation.section, /^3-08/);
      assert.match(stage.legal_citation.url, /^https:\/\/codelibrary\.amlegal\.com\//);
      assert.match(stage.legal_citation.rule_version, /^effective-/);
      assert.match(stage.effective_from, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(stage.effective_to === null || /^\d{4}-\d{2}-\d{2}$/.test(stage.effective_to));
    }
  }
});

test("ordinary 5+10 and M/WBE fixtures have different stage obligations", () => {
  const ordinary = ["solicitation", "award"].map((stage) =>
    resolveProcurementPublicationPolicy(ordinaryFivePlusTen, stage, registry));
  const mwbe = ["solicitation", "award"].map((stage) =>
    resolveProcurementPublicationPolicy(mwbeSmallPurchase, stage, registry));

  assert.deepEqual(ordinary.map(({ publication_obligation }) => publication_obligation), [
    "not_required",
    "not_required",
  ]);
  assert.deepEqual(mwbe.map(({ publication_obligation }) => publication_obligation), [
    "not_required",
    "required",
  ]);
  assert.equal(ordinary[0].access_scope, "selected_vendors");
  assert.equal(mwbe[1].access_scope, "public_city_record");
  assert.deepEqual(mwbe[1].deadline, {
    days: 15,
    begins_at: "contract_registration",
  });
});

test("source absence alone never produces a not-required legal obligation", () => {
  const absenceOnly = resolveProcurementPublicationPolicy(
    {
      publisher_method: "Small Purchase",
      coverage_state: "source_checked_no_record",
      procurement_category: "goods_and_non_construction_services",
      amount: 75_000,
      occurred_on: "2024-01-15",
    },
    "award",
    registry,
  );
  assert.equal(absenceOnly.publication_obligation, "unknown");
  assert.equal(absenceOnly.policy_match, "unmatched");
  assert.equal(absenceOnly.coverage_state, "source_checked_no_record");

  const amountMismatch = resolveProcurementPublicationPolicy(
    { ...ordinaryFivePlusTen, amount: 1_000_000, coverage_state: "source_checked_no_record" },
    "award",
    registry,
  );
  assert.equal(amountMismatch.publication_obligation, "unknown");
  assert.equal(amountMismatch.policy_match, "unmatched");

  const timeMismatch = resolveProcurementPublicationPolicy(
    { ...ordinaryFivePlusTen, occurred_on: "2023-06-02", coverage_state: "source_checked_no_record" },
    "award",
    registry,
  );
  assert.equal(timeMismatch.publication_obligation, "unknown");
  assert.equal(timeMismatch.policy_match, "unmatched");
});

test("unmapped publisher variants stay unknown at every stage", () => {
  for (const stage of ["solicitation", "award"]) {
    const result = resolveProcurementPublicationPolicy(
      {
        method_family: "unmapped_publisher_variant",
        publisher_method: "SMALL PURCHASE - OTHER",
        procurement_category: "goods_and_non_construction_services",
        amount: 75_000,
        occurred_on: "2024-01-15",
      },
      stage,
      registry,
    );
    assert.equal(result.publication_obligation, "unknown");
    assert.equal(result.access_scope, "unknown");
  }
});

test("M/WBE award policy is bounded by category, amount, and effective date", () => {
  const atCeiling = resolveProcurementPublicationPolicy(
    { ...mwbeSmallPurchase, amount: 1_500_000 },
    "award",
    registry,
  );
  assert.equal(atCeiling.publication_obligation, "required");

  for (const mismatch of [
    { ...mwbeSmallPurchase, amount: 1_500_000.01 },
    { ...mwbeSmallPurchase, procurement_category: "human_services" },
    { ...mwbeSmallPurchase, occurred_on: "2023-06-02" },
  ]) {
    const result = resolveProcurementPublicationPolicy(mismatch, "award", registry);
    assert.equal(result.publication_obligation, "unknown");
    assert.equal(result.policy_match, "unmatched");
  }
});
