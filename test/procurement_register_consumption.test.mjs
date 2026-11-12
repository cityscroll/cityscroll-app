// Delivery proof for the register-consumption engine slice: the site modules read the
// procurement legal register and the PPB 3-08 policy registry (through the generated
// projection) instead of their own constants. Three consumers change:
//   1. response floors  (site/solicitation_procurement_method.mjs)
//   2. M/WBE statements  (site/mwbe_goal_surface.mjs, site/mwbe_requirement_state.mjs)
//   3. coverage labels   (site/procurement_coverage_labels.mjs)
//
// Everything is three-valued: a missing, unmapped or ambiguous category, a missing date, a
// rule not in force, or a reading below source_checked never yields a verdict, a rule claim
// or an exemption sentence. None of the register has been reviewed by a legal practitioner;
// the mappings are engine beliefs carried with their review status into the reader facts.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import * as legal from "../ontology/procurement_legal_register.mjs";
import { loadOntologyRegistry } from "../ontology/load.mjs";
import { CATEGORIES } from "../worker/src/lib/filter.mjs";
import { extractSolicitationProcurementMethod } from "../site/solicitation_procurement_method.mjs";
import {
  SOLICITATION_CHIP_KIND,
  buildSolicitationListChips,
  buildSolicitationMwbeView,
} from "../site/mwbe_goal_surface.mjs";
import {
  coverageInputFromBrowseRow,
  coverageInputFromProcurement,
  projectProcurementCoverageSignals,
  renderProcurementRowCoverageHtml,
  resolveProcurementCoveragePolicy,
} from "../site/procurement_coverage_labels.mjs";
import { opportunityWindowDisplayLine } from "../site/procurement_opportunity_window.mjs";
import {
  mwbeRequirementState,
  mwbeStateAnnotation,
  formatMwbeStateAnnotation,
} from "../site/mwbe_requirement_state.mjs";
import {
  resolveLegalCategory,
  participationRequirement,
  mwbeSmallPurchaseCeilingOn,
  responseFloorRule,
} from "../site/procurement_legal_category.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const register = legal.loadProcurementLegalRegister();
const policyRegistry = loadOntologyRegistry().procurement_policy_registry;
const sources = Object.fromEntries(
  Object.keys(register.sources.files).map((f) => [
    f,
    readFileSync(join(REPO_ROOT, register.sources.root, f), "utf8"),
  ]),
);
const latest = new Map();
for (const e of register.entries) {
  if (!latest.has(e.id) || latest.get(e.id).record_version < e.record_version) latest.set(e.id, e);
}

const fixtureFile = readJson(join(REPO_ROOT, "test/fixtures/procurement_register_consumption/fixtures.json"));
const FIXTURES = fixtureFile.fixtures;
const WINDOW = fixtureFile.window_for_floor_line;

// ---------------------------------------------------------------- observables
function coveragePolicyFor(input) {
  const stages = input.stages.includes("award") || input.stages.includes("registered") ? "award" : "solicitation";
  return resolveProcurementCoveragePolicy(input, stages);
}

function noticeAfter(row) {
  const pm = extractSolicitationProcurementMethod(row);
  const view = buildSolicitationMwbeView(row);
  const list = buildSolicitationListChips(row);
  return { pm, view, list, floor_line: opportunityWindowDisplayLine(WINDOW, pm.response_floor) };
}

function recordAfter(row) {
  const input = coverageInputFromBrowseRow(row);
  const labels = projectProcurementCoverageSignals(input).labels.map((l) => l.kind).join(",") || null;
  return { input, label: labels, html: renderProcurementRowCoverageHtml(row), policy: coveragePolicyFor(input) };
}

// ---------------------------------------------------------------- A1/A2/A3: the register
test("A1: the delivered register is version 2026-11-11.2 with 52 records over ten sources, and validates", () => {
  assert.equal(register.version, "2026-11-11.2");
  assert.equal(register.entries.length, 52);
  assert.equal(Object.keys(register.sources.files).length, 10);
  assert.equal(legal.validateLegalRegister(register, { policyRegistry, sources }), true);
});

test("A2: response-floor rules are source_checked with the cited PPB sections and quotes in the retained text", () => {
  const floors = {
    "app.solicitation_method.response_floor.default_competitive_20_calendar_days": { section: "9 RCNY 3-03(c)(1)", days: 20 },
    "app.solicitation_method.response_floor.section_6_129_27_calendar_days": { section: "9 RCNY 3-03(c)(1)", days: 27 },
    "nyc.ppb.3-02.c.bidding_time_15_days": { section: "9 RCNY 3-02(c)", days: 15 },
    "nyc.ppb.3-02.e.1.i.section_6_129_bid_notice_22_days": { section: "9 RCNY 3-02(e)(1)(i)", days: 22 },
    "app.solicitation_method.response_floor.accelerated_3_business_days": { section: "9 RCNY 3-07(h)(1)(i)", days: 3 },
  };
  for (const [id, want] of Object.entries(floors)) {
    const entry = latest.get(id);
    assert.ok(entry, id);
    assert.equal(entry.review.status, "source_checked", id);
    assert.equal(entry.authority.section, want.section, id);
    assert.ok(
      legal.normalizeLegalText(sources[entry.authority.source_file]).includes(entry.authority.quote),
      `${id} quote not in retained text`,
    );
  }
});

test("A3: a floor is a rule claim only when source_checked and in force on the date; otherwise unverified", () => {
  // A checked rule in force -> rule claim with a citation.
  const inForce = responseFloorRule("competitive_sealed_proposal", "2026-07-01");
  assert.equal(inForce.claim, "rule");
  assert.equal(inForce.section, "9 RCNY 3-03(c)(1)");
  // No date -> unverified, no citation.
  assert.equal(responseFloorRule("competitive_sealed_proposal", null).claim, "unverified");
  // Accelerated before its in-force date -> unverified.
  assert.equal(responseFloorRule("accelerated", "2025-01-01").claim, "unverified");
  assert.equal(responseFloorRule("accelerated", "2026-01-01").claim, "rule");
});

// ---------------------------------------------------------------- A4/A5/A2: per-fixture after state
test("A4/A5: every fixture's delivered state, rule, floor and label match its recorded expectation", (t) => {
  assert.ok(FIXTURES.length >= 24, `need at least 24 fixtures, have ${FIXTURES.length}`);
  for (const fixture of FIXTURES) {
    const exp = fixture.expected;
    if (fixture.kind === "notice") {
      const { pm } = noticeAfter(fixture.input);
      assert.equal(pm.mwbe_requirement.state, exp.state, `${fixture.id} state`);
      if (exp.rule_id) {
        assert.deepEqual(pm.mwbe_requirement.register.requirement.rule_ids, [exp.rule_id], `${fixture.id} rule`);
      }
      if (exp.requirement) {
        assert.equal(pm.mwbe_requirement.register.requirement.value, exp.requirement, `${fixture.id} requirement`);
      }
      if (exp.category_state) {
        assert.equal(pm.mwbe_requirement.register.category.state, exp.category_state, `${fixture.id} category`);
      }
      if (exp.floor === null) {
        assert.equal(pm.response_floor, null, `${fixture.id} floor`);
      } else {
        assert.equal(pm.response_floor.kind, exp.floor.kind, `${fixture.id} floor kind`);
        assert.equal(pm.response_floor.days, exp.floor.days, `${fixture.id} floor days`);
        assert.equal(pm.response_floor.claim, exp.floor.claim, `${fixture.id} floor claim`);
        if (exp.floor.day_unit) assert.equal(pm.response_floor.day_unit, exp.floor.day_unit, `${fixture.id} floor unit`);
      }
    } else if (fixture.kind === "record") {
      const { label, policy } = recordAfter(fixture.input);
      assert.equal(label, exp.label, `${fixture.id} label`);
      if (exp.reason) {
        assert.equal(policy.reason, exp.reason, `${fixture.id} reason`);
        assert.equal(policy.publication_obligation, "unknown", `${fixture.id} never not_required when abstaining`);
        if (exp.missing_facts) assert.deepEqual(policy.missing_facts, exp.missing_facts, `${fixture.id} missing_facts`);
      }
    } else {
      const after = mwbeRequirementState({ section_6_129: null, ...fixture.input });
      assert.equal(after.state, exp.state, `${fixture.id} state`);
      if (exp.rule_id) assert.deepEqual(after.register.requirement.rule_ids, [exp.rule_id], `${fixture.id} rule`);
      if (exp.requirement) assert.equal(after.register.requirement.value, exp.requirement, `${fixture.id} requirement`);
    }
    t.diagnostic(`${fixture.id} :: ${fixture.purpose}`);
  }
});

test("A5 (F1): a human-services notice keeps its goal and gains the 6-129(q)(7) statement; floor drops to the method's non-6-129 floor", () => {
  const n01 = FIXTURES.find((f) => f.id === "N01").input;
  const { pm, list } = noticeAfter(n01);
  // Published goal evidence unchanged.
  assert.equal(pm.section_6_129.goal_percent, 30);
  const req = pm.mwbe_requirement;
  assert.equal(req.state, "goal_published_requirement_not_applicable");
  const rule = req.register.requirement.rules[0];
  assert.equal(rule.rule_id, "nyc.admin_code.6-129.q.7.human_services_contracts");
  assert.equal(rule.section, "6-129(q)(7)");
  assert.equal(rule.review_status, "source_checked");
  const entry = latest.get(rule.rule_id);
  assert.ok(legal.normalizeLegalText(sources[entry.authority.source_file]).includes(entry.authority.quote));
  assert.equal(
    formatMwbeStateAnnotation(mwbeStateAnnotation(req)),
    "This notice lists an M/WBE participation goal. City law does not require participation goals for human services contracts (Admin Code § 6-129(q)(7)). Check the solicitation for what applies.",
  );
  assert.ok(list.some((c) => c.kind === SOLICITATION_CHIP_KIND.SECTION_6_129_GOAL), "published goal chip still shown");
  // The 27-day §6-129 floor is not selected once the requirement is ruled out.
  assert.equal(pm.response_floor.days, 20);
  assert.equal(pm.response_floor.rule_section, "9 RCNY 3-03(c)(1)");
});

test("F2: an uncategorised $25,000 record abstains where the legal category matters; keeps its label where every category agrees", () => {
  const r24 = recordAfter(FIXTURES.find((f) => f.id === "R24").input);
  assert.equal(r24.label, null);
  assert.equal(r24.html, "");
  assert.equal(r24.policy.publication_obligation, "unknown");
  assert.equal(r24.policy.reason, "category_missing_candidates_disagree");
  assert.deepEqual(r24.policy.missing_facts, ["procurement_category"]);
  for (const id of ["R09", "R23", "R27"]) {
    const r = recordAfter(FIXTURES.find((f) => f.id === id).input);
    assert.ok(r.label, `${id} keeps its label`);
    assert.equal(r.policy.category_basis, "all_legal_categories_agree", id);
  }
  // A present but unmapped label never borrows the full candidate set.
  assert.equal(recordAfter(FIXTURES.find((f) => f.id === "R25").input).label, null);
});

// ---------------------------------------------------------------- A9: failure controls
test("A9: an unmapped label never yields a verdict", () => {
  for (const label of ["Human Services", "goods", "HUMAN SERVICES/CLIENT SERVICES", "Services", "Construction"]) {
    assert.equal(resolveLegalCategory({ category_description: label }).state, "unmapped", label);
    const state = mwbeRequirementState({ section_6_129: null, row: { category_description: label, start_date: "2026-03-02" } });
    assert.equal(state.register.requirement.value, "unknown", label);
    assert.equal(state.state, "needs_checking", label);
    const policy = resolveProcurementCoveragePolicy(
      { method_family: "ordinary_micropurchase", category_description: label, amount: 1000, occurred_on: "2024-03-01" },
      "solicitation",
    );
    assert.equal(policy.publication_obligation, "unknown", label);
  }
});

test("A9: a candidate set that disagrees, and a missing date, yield unknown", () => {
  const mixed = participationRequirement({ candidates: ["human_services", "construction"], occurred_on: "2026-03-02" });
  assert.equal(mixed.value, "unknown");
  assert.equal(mixed.reason, "candidates_disagree");
  assert.equal(participationRequirement({ candidates: ["human_services"] }).value, "unknown");
  assert.equal(mwbeSmallPurchaseCeilingOn(null), null);
  assert.equal(responseFloorRule("competitive_sealed_proposal", null).claim, "unverified");
  const n12 = noticeAfter(FIXTURES.find((f) => f.id === "N12").input);
  assert.equal(n12.pm.mwbe_requirement.register.requirement.reason, "occurred_on_missing");
  assert.equal(n12.pm.response_floor.claim, "unverified");
  assert.doesNotMatch(n12.floor_line, /rule floor/);
});

// ---------------------------------------------------------------- A12: category inventory
test("A12: every category_description label in the baseline data is mapped or listed as unmapped with its count", (t) => {
  const inventory = fixtureFile.category_inventory;
  const counts = {};
  const walk = (node) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (key === "category_description" && typeof value === "string") counts[value] = (counts[value] || 0) + 1;
        else walk(value);
      }
    }
  };
  for (const file of inventory.files) walk(readJson(join(REPO_ROOT, file)));
  assert.deepEqual(counts, inventory.counts, "recount equals the recorded inventory");
  let mapped = 0;
  for (const [label, count] of Object.entries(counts)) {
    const category = resolveLegalCategory({ category_description: label });
    if (category.state === "resolved") mapped += 1;
    else assert.ok(inventory.unmapped.includes(label), `${label} (${count}) is neither mapped nor listed as unmapped`);
    t.diagnostic(`${category.state === "resolved" ? "mapped  " : "UNMAPPED"} ${count} ${JSON.stringify(label)}`);
  }
  for (const label of CATEGORIES) assert.equal(resolveLegalCategory({ category_description: label }).state, "resolved", label);
  assert.equal(mapped, 6);
});

// ---------------------------------------------------------------- A7: population
test("A7: over the materialized read model the delivered module keeps exactly the 1,320 labels where every legal category agrees", (t) => {
  // The population statistics (20,601 objects; 4,334 baseline 'Targeted small-purchase' labels
  // splitting into 1,320 kept and 3,014 withdrawn) are the recorded before/after migration delta
  // in fixtures.json. The baseline modules no longer exist in the tree, so this suite proves the
  // after-determined half directly: the delivered module labels exactly 1,320 objects over the
  // population, all 'targeted_small_purchase' (every legal category agrees), and a large set of
  // uncategorised small purchases now abstain because the goods/services and construction bands
  // diverge at their amount.
  const dir = join(REPO_ROOT, "site/data/shared_procurement_read_model");
  let objects = 0;
  const labelCounts = {};
  let abstainDisagree = 0;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const shard = readJson(join(dir, file));
    const byRef = new Map(shard.observations.map((o) => [o.source_observation_ref, o]));
    for (const row of shard.rows) {
      objects += 1;
      const observations = (row.source_observation_refs || []).map((ref) => byRef.get(ref)).filter(Boolean);
      const input = coverageInputFromProcurement(row, observations);
      const labels = projectProcurementCoverageSignals(input).labels.map((l) => l.kind);
      if (labels.length) {
        for (const kind of labels) labelCounts[kind] = (labelCounts[kind] || 0) + 1;
      } else {
        const reason = resolveProcurementCoveragePolicy(
          input,
          input.stages.includes("solicitation") ? "solicitation" : "award",
        ).reason;
        if (reason === "category_missing_candidates_disagree") abstainDisagree += 1;
      }
    }
  }
  const kept = fixtureFile.population.tally["targeted_small_purchase -> targeted_small_purchase"];
  t.diagnostic(`objects ${objects}; labels ${JSON.stringify(labelCounts)}; abstain(disagree) ${abstainDisagree}; recorded withdrawn ${fixtureFile.population.withdrawn_by_reason.category_missing_candidates_disagree}`);
  assert.equal(objects, fixtureFile.population.objects);
  assert.deepEqual(labelCounts, { targeted_small_purchase: kept }, "the only labels over the population are the kept targeted small purchases");
  // The recorded withdrawn count (previously-labeled records that now abstain) is a subset of the
  // records that abstain because candidates disagree; no label is ever added.
  assert.ok(
    abstainDisagree >= fixtureFile.population.withdrawn_by_reason.category_missing_candidates_disagree,
    `abstain-disagree (${abstainDisagree}) covers the recorded withdrawn set`,
  );
});
