// Characterization: award → prime → M/WBE-goal join payload.
// Honest-absent subcontract goals; never fabricates utilization targets.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AWARD_PRIME_GOAL_SCHEMA,
  SUBCONTRACT_GOAL_GAP,
  attachAwardPrimeGoal,
  buildAwardPrimeGoal,
  buildSubcontractGoalSlot,
  collectIndustryChips,
  isAwardPrimeGoalEligible,
  makeIndustryChip,
  resolveAgency,
  resolveDollars,
  resolvePrimeVendor,
} from "../src/lib/award_prime_goal.mjs";
import { assembleLifecycle } from "../src/lib/checkbook_lifecycle.mjs";
import { vendorStem } from "../src/lib/compile.mjs";

const AWARD_NOTICE = {
  request_id: "20231222103",
  agency_name: "Design and Construction",
  type_of_notice_description: "Award",
  section_name: "Procurement",
  short_title: "Construction Management Services",
  pin: "07123E0076001",
  vendor_name: "HNTB CORPORATION",
  contract_amount: "4020000",
  category_description: "Construction/Construction Services",
  start_date: "2023-12-22",
};

test("isAwardPrimeGoalEligible accepts procurement awards and rejects wrong universes", () => {
  assert.equal(isAwardPrimeGoalEligible(AWARD_NOTICE), true);
  assert.equal(
    isAwardPrimeGoalEligible({
      section_name: "Public Hearings and Meetings",
      type_of_notice_description: "Public Hearing",
    }),
    false,
  );
  assert.equal(
    isAwardPrimeGoalEligible({
      section_name: "Property Disposition",
      type_of_notice_description: "Notice",
    }),
    false,
  );
  assert.equal(
    isAwardPrimeGoalEligible({ type_of_notice_description: "Intent to Award" }),
    true,
  );
});

test("resolvePrimeVendor uses vendorStem identity and stable subject_ref", () => {
  const prime = resolvePrimeVendor(AWARD_NOTICE, null);
  assert.equal(prime.display_name, "HNTB CORPORATION");
  assert.equal(prime.stem, vendorStem("HNTB CORPORATION"));
  assert.equal(prime.stem, "HNTB");
  assert.ok(prime.subject_ref.startsWith("vendor:name:"));
  assert.deepEqual(prime.sources, ["city-record"]);
});

test("resolvePrimeVendor prefers notice vendor and notes Checkbook when stems match", () => {
  const lifecycle = {
    timeline: [
      {
        stage: "registered",
        status: "matched",
        detail: {
          vendor: "HNTB Corp",
          mwbe: "Non-M/WBE",
          contract_id: "CT107120248803393",
        },
      },
    ],
  };
  const prime = resolvePrimeVendor(AWARD_NOTICE, lifecycle);
  assert.equal(prime.display_name, "HNTB CORPORATION");
  assert.equal(prime.stem, "HNTB");
  assert.equal(prime.mwbe_category, "Non-M/WBE");
  assert.equal(prime.mwbe_category_source, "checkbook-contracts");
  assert.ok(prime.sources.includes("city-record"));
  assert.ok(prime.sources.includes("checkbook-contracts"));
});

test("resolveAgency uses canonicalAgency identity", () => {
  const agency = resolveAgency(AWARD_NOTICE, null);
  assert.equal(agency.display_name, "Design and Construction");
  assert.ok(agency.canonical_id);
  assert.ok(agency.canonical_name);
  assert.ok(agency.subject_ref?.startsWith("agency:"));
  assert.equal(agency.source, "city-record");
});

test("resolveDollars prefers City Record award amount", () => {
  const dollars = resolveDollars(AWARD_NOTICE, {
    timeline: [
      {
        stage: "registered",
        status: "matched",
        detail: { current_amount: 999, original_amount: 888 },
      },
    ],
  });
  assert.equal(dollars.amount, 4020000);
  assert.equal(dollars.source, "city-record");
  assert.equal(dollars.basis, "contract_amount");
});

test("collectIndustryChips uses published category only — no title invent", () => {
  const chips = collectIndustryChips(AWARD_NOTICE);
  assert.equal(chips.length, 1);
  assert.equal(chips[0].label, "Construction/Construction Services");
  assert.equal(chips[0].source, "city-record");
  assert.equal(chips[0].field, "category_description");

  const fromTitleOnly = collectIndustryChips({
    short_title: "Asphalt milling and M/WBE goals in Queens",
  });
  assert.deepEqual(fromTitleOnly, []);

  const withPassport = collectIndustryChips(AWARD_NOTICE, {
    passport: { industry: "Architecture/Engineering", main_commodity: "CM Services" },
  });
  assert.equal(withPassport.length, 3);
  assert.ok(withPassport.some((c) => c.field === "industry"));
  assert.ok(withPassport.some((c) => c.field === "main_commodity"));
});

test("makeIndustryChip normalizes keys", () => {
  const chip = makeIndustryChip("Construction/Construction Services", {
    source: "city-record",
    field: "category_description",
  });
  assert.equal(chip.key, "construction_construction_services");
});

test("buildSubcontractGoalSlot is honest-absent by default — never fabricates goal %", () => {
  const slot = buildSubcontractGoalSlot({
    contract_includes_sub_vendors: "Yes",
  });
  assert.equal(slot.status, "not_published");
  assert.equal(slot.class, "not_published");
  assert.equal(slot.goals, null);
  assert.equal(slot.goal_percent, null);
  assert.equal(slot.remaining_percent, null);
  assert.equal(slot.contract_includes_sub_vendors, "Yes");
  assert.equal(slot.would_appear_in, SUBCONTRACT_GOAL_GAP.would_appear_in);
  assert.match(slot.evidence, /Comptroller/i);
});

test("buildSubcontractGoalSlot accepts real goals only when provided", () => {
  const slot = buildSubcontractGoalSlot({
    goals: [
      { kind: "mbe", percent: 15, source: "fixture" },
      { kind: "wbe", percent: 10, source: "fixture" },
    ],
  });
  assert.equal(slot.status, "present");
  assert.equal(slot.goal_percent, 25);
  assert.equal(slot.goals.length, 2);
});

test("buildAwardPrimeGoal stamps full join with open_candidate window and honest goal gap", () => {
  const payload = buildAwardPrimeGoal(AWARD_NOTICE, null);
  assert.equal(payload.schema, AWARD_PRIME_GOAL_SCHEMA);
  assert.equal(payload.request_id, "20231222103");
  assert.equal(payload.eligible, true);
  assert.equal(payload.prime.display_name, "HNTB CORPORATION");
  assert.equal(payload.prime.stem, "HNTB");
  assert.equal(payload.agency.display_name, "Design and Construction");
  assert.equal(payload.dollars.amount, 4020000);
  assert.equal(payload.industry_chips.length, 1);
  assert.equal(payload.subcontract_goal.status, "not_published");
  assert.equal(payload.subcontract_goal.goal_percent, null);
  assert.equal(payload.possible_subcontract_window.status, "open_candidate");
  assert.equal(payload.possible_subcontract_window.goal_data, "honest_absent");
  assert.equal(payload.possible_subcontract_window.has_prime, true);
  assert.equal(payload.possible_subcontract_window.has_dollars, true);
});

test("attachAwardPrimeGoal rides assembleLifecycle for award notices", () => {
  const lifecycle = assembleLifecycle(AWARD_NOTICE, [], [], [], {
    pinStrategy: "none",
    lookupStatus: { pending: "skip", registered: "skip", spending: "skip" },
  });
  assert.ok(lifecycle.award_prime_goal, "side-car present on pure assemble");
  assert.equal(lifecycle.award_prime_goal.prime.stem, "HNTB");
  assert.equal(lifecycle.award_prime_goal.subcontract_goal.status, "not_published");

  const registered = [
    {
      id: "CT107120248803393",
      vendor: "HNTB CORPORATION",
      agency: "Design and Construction",
      pin: "07123E0076001",
      status: "registered",
      current: 4020000,
      original: 4020000,
      spent: 0,
      mwbe: "Non-M/WBE",
      subs: "Yes",
      registered: "2024-01-15",
    },
  ];
  const withReg = assembleLifecycle(AWARD_NOTICE, [], registered, [], {
    pinStrategy: "exact",
    lookupStatus: { pending: "ok", registered: "ok", spending: "ok" },
  });
  assert.equal(withReg.award_prime_goal.prime.mwbe_category, "Non-M/WBE");
  assert.equal(
    withReg.award_prime_goal.subcontract_goal.contract_includes_sub_vendors,
    "Yes",
  );
  assert.equal(withReg.award_prime_goal.contract_id, "CT107120248803393");
});

test("attachAwardPrimeGoal is idempotent and does not invent goals on empty notice", () => {
  const base = { timeline: [], pin: null, ok: true };
  const once = attachAwardPrimeGoal(base, {
    request_id: "x",
    type_of_notice_description: "Award",
    section_name: "Procurement",
  });
  const twice = attachAwardPrimeGoal(once, {
    request_id: "x",
    type_of_notice_description: "Award",
    section_name: "Procurement",
  });
  assert.equal(twice.award_prime_goal.subcontract_goal.goal_percent, null);
  assert.equal(twice.award_prime_goal.possible_subcontract_window.status, "unknown");
  assert.equal(twice.award_prime_goal.possible_subcontract_window.basis, "prime_vendor_not_resolved");
});
