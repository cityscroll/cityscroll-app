// Delivery proof for the procurement legal register.
// Reads the policy registry and imports ontology/procurement_policy.mjs read-only.
// Nothing here has been reviewed by a legal practitioner; engine output is not legal advice.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LEGAL_EFFECT_KEYS,
  effectFor,
  loadProcurementLegalRegister,
  normalizeLegalText,
  registerAsOf,
  registerKnownAsOf,
  resolveLegalRules,
  validateLegalRegister,
} from "../ontology/procurement_legal_register.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCES_DIR = join(REPO_ROOT, "test/fixtures/procurement_legal_register/sources");

const REGISTRY_PATH = join(REPO_ROOT, "ontology/registry.v0.json");
const POLICY_MODULE_PATH = join(REPO_ROOT, "ontology/procurement_policy.mjs");
const BASELINE_REGISTRY_SHA256 = "9ba29623cce23627a9b45070238c117942c51f81063cc4d0dc7324261e42ec1f";
const BASELINE_POLICY_MODULE_SHA256 = "3bb420ac5845860c6c2c5581dbae58dd628d1435071b80b71cdf1e806d4a242b";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileSha = (path) => sha(readFileSync(path));

const policyRegistry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8")).procurement_policy_registry;
const { resolveProcurementPublicationPolicy, validateProcurementPolicyRegistry } = await import(POLICY_MODULE_PATH);

// Policy table computed BEFORE any register code touches the policy registry.
const POLICY_TABLE = [
  ["ordinary_micropurchase", "goods_and_non_construction_services", 20000, "2024-01-01", "solicitation"],
  ["ordinary_micropurchase", "goods_and_non_construction_services", 20001, "2024-01-01", "solicitation"],
  ["ordinary_micropurchase", "construction", 35000, "2025-10-01", "award"],
  ["ordinary_micropurchase", "construction", 35001, "2025-10-01", "award"],
  ["ordinary_5_plus_10", "goods_and_non_construction_services", 100000, "2026-11-11", "solicitation"],
  ["ordinary_5_plus_10", "goods_and_non_construction_services", 100001, "2026-11-11", "solicitation"],
  ["ordinary_5_plus_10", "construction", 35000, "2026-11-11", "award"],
  ["mwbe_small_purchase", "goods_and_non_construction_services", 1500000, "2023-06-03", "award"],
  ["mwbe_small_purchase", "goods_and_non_construction_services", 1500000, "2023-06-02", "award"],
  ["mwbe_small_purchase", "construction", 1500001, "2026-11-11", "award"],
  ["mwbe_small_purchase", "human_services", 50000, "2026-11-11", "solicitation"],
  ["mwbe_small_purchase", "construction", 250000, "2026-11-11", "solicitation"],
  ["unmapped_publisher_variant", "construction", 10000, "2026-11-11", "award"],
  ["not_a_family", "construction", 10000, "2026-11-11", "award"],
].map(([method_family, procurement_category, amount, occurred_on, stage]) => ({
  record: { method_family, procurement_category, amount, occurred_on, coverage_state: "not_checked" },
  stage,
}));
const policySnapshot = () => POLICY_TABLE.map(({ record, stage }) => (
  resolveProcurementPublicationPolicy(record, stage, policyRegistry)
));
const POLICY_BEFORE = structuredClone(policySnapshot());
const POLICY_REGISTRY_BEFORE = JSON.stringify(policyRegistry);

const register = loadProcurementLegalRegister();
const sourceManifest = JSON.parse(readFileSync(join(SOURCES_DIR, "manifest.json"), "utf8"));
const sources = Object.fromEntries(
  readdirSync(SOURCES_DIR).filter((f) => f.endsWith(".md")).map((f) => [f, readFileSync(join(SOURCES_DIR, f), "utf8")]),
);
const ctx = { register, policyRegistry };
const byId = (id) => register.entries.find((e) => e.id === id);
const Q = (n) => register.entries.find((e) => e.id.startsWith(`nyc.admin_code.6-129.q.${n}.`)).id;
const NOW = "2026-11-11";

function rejects(mutate, pattern, { mutateSources } = {}) {
  const copy = structuredClone(register);
  mutate(copy);
  const srcs = mutateSources ? mutateSources({ ...sources }) : sources;
  assert.throws(() => validateLegalRegister(copy, { policyRegistry, sources: srcs }), pattern);
}

test("(i) the seed validates against the baseline policy registry and retained sources", () => {
  validateProcurementPolicyRegistry(policyRegistry);
  assert.equal(validateLegalRegister(register, { policyRegistry, sources }), true);
  assert.equal(register.entries.length, 38);
  const counts = {};
  for (const e of register.entries) counts[e.review.status] = (counts[e.review.status] || 0) + 1;
  assert.deepEqual(counts, { source_checked: 23, unreviewed: 15 });
  assert.equal(register.entries.filter((e) => e.review.status === "practitioner_reviewed").length, 0);
});

test("(ii) every source_checked quote occurs literally in its retained source and hashes match", () => {
  for (const [file, meta] of Object.entries(sourceManifest.files)) {
    assert.equal(fileSha(join(SOURCES_DIR, file)), meta.sha256, file);
    assert.equal(register.sources.files[file].sha256, meta.sha256, file);
  }
  const checked = register.entries.filter((e) => e.review.status === "source_checked");
  assert.equal(checked.length, 23);
  for (const e of checked) {
    const a = e.authority;
    const text = sources[a.source_file];
    assert.equal(sha(Buffer.from(text, "utf8")), a.source_sha256, e.id);
    for (const field of ["quote", "context_quote"]) {
      if (a[field] == null) continue;
      assert.equal(sha(Buffer.from(a[field], "utf8")), a[`${field}_sha256`], `${e.id} ${field}`);
      assert.ok(normalizeLegalText(text).includes(normalizeLegalText(a[field])), `${e.id} ${field}`);
    }
  }
});

test("(iii) M/WBE participation: human services, not-for-profit, ordinary construction, missing facts", () => {
  const hs = effectFor({ procurement_category: "human_services" }, "mwbe_participation_requirement", { asOf: NOW, ...ctx });
  assert.equal(hs.value, "not_applicable");
  assert.ok(hs.rule_ids.includes(Q(7)));
  assert.equal(hs.review_status, "source_checked");

  for (const procurement_category of ["goods", "standard_services", "professional_services", "construction", "human_services", undefined]) {
    const facts = { awardee_legal_form: "not_for_profit", ...(procurement_category ? { procurement_category } : {}) };
    const npo = effectFor(facts, "mwbe_participation_requirement", { asOf: NOW, ...ctx });
    assert.equal(npo.value, "not_applicable", String(procurement_category));
    assert.ok(npo.rule_ids.includes(Q(8)));
  }

  const ordinary = effectFor({
    procurement_category: "construction", awardee_legal_form: "for_profit",
    procurement_basis: "competitive", funding_constraint: "none",
  }, "mwbe_participation_requirement", { asOf: NOW, ...ctx });
  assert.notEqual(ordinary.value, "not_applicable");
  assert.deepEqual(ordinary.rule_ids, []);
  assert.deepEqual(ordinary.unknown_rule_ids.sort(), [Q(3), Q(9)].sort());
  assert.ok(ordinary.missing_facts.every((m) => m.startsWith("unmodelled:")), "only unmodelled conditions remain open");

  const missing = effectFor({ procurement_basis: "competitive", funding_constraint: "none" }, "mwbe_participation_requirement", { asOf: NOW, ...ctx });
  assert.equal(missing.value, "unknown");
  assert.ok(missing.missing_facts.includes("procurement_category"));
  assert.ok(missing.missing_facts.includes("awardee_legal_form"));
  assert.ok(missing.unknown_rule_ids.includes(Q(7)) && missing.unknown_rule_ids.includes(Q(8)));

  assert.equal(effectFor({ procurement_basis: "emergency" }, "mwbe_participation_requirement", { asOf: NOW, ...ctx }).rule_ids[0], Q(5));
  assert.equal(effectFor({ procurement_basis: "sole_source" }, "mwbe_participation_requirement", { asOf: NOW, ...ctx }).rule_ids[0], Q(6));
  const outreach = effectFor({ procurement_basis: "emergency" }, "agency_mwbe_outreach_duty", { asOf: NOW, ...ctx });
  assert.equal(outreach.value, "applies");
  const hsClass = effectFor({ procurement_category: "human_services" }, "section_6_129_industry_classification", { asOf: NOW, ...ctx });
  assert.equal(hsClass.value, "none");
});

test("(iv) point in time: the M/WBE small-purchase ceiling and unknown before in_force_as_of", () => {
  const early = effectFor({}, "mwbe_small_purchase_max_usd", { asOf: "2023-06-02", ...ctx });
  const now = effectFor({}, "mwbe_small_purchase_max_usd", { asOf: NOW, ...ctx });
  assert.equal(early.value, 1000000);
  assert.equal(early.review_status, "unreviewed");
  assert.equal(now.value, 1500000);
  assert.equal(now.review_status, "source_checked");
  assert.notEqual(early.value, now.value);
  assert.equal(effectFor({}, "mwbe_small_purchase_max_usd", { asOf: "2021-01-01", ...ctx }).value, "unknown");
  assert.equal(effectFor({}, "mwbe_small_purchase_max_usd", { asOf: "2021-01-01", ...ctx }).reason, "no_rule_in_force");

  const before = effectFor({ procurement_category: "human_services" }, "mwbe_participation_requirement", { asOf: "2020-01-01", ...ctx });
  assert.equal(before.value, "unknown");
  assert.ok(before.missing_facts.some((m) => m.startsWith("effective_from_before:")));
  const asOfView = registerAsOf(register, "2020-01-01");
  assert.ok(asOfView.indeterminate.some((e) => e.id === Q(7)));
  assert.ok(!asOfView.in_force.some((e) => e.id === Q(7)));
  // facts.occurred_on is the default as-of date.
  assert.equal(effectFor({ occurred_on: "2023-06-02" }, "mwbe_small_purchase_max_usd", ctx).value, 1000000);
});

test("(v) 3-08 pointers resolve, numbers come from the registry, and policy results are unchanged", () => {
  assert.equal(fileSha(REGISTRY_PATH), BASELINE_REGISTRY_SHA256);
  assert.equal(fileSha(POLICY_MODULE_PATH), BASELINE_POLICY_MODULE_SHA256);
  const ppb308 = register.entries.filter((e) => /^9 RCNY 3-08\(/.test(e.authority.section));
  assert.equal(ppb308.filter((e) => e.review.status === "source_checked").length, 5);
  assert.equal(ppb308.length, 8); // plus three unreviewed engine paraphrases of 3-08, also pointer-backed
  for (const e of ppb308) {
    assert.ok(e.realized_by, e.id);
    for (const value of Object.values(e.effect)) assert.ok(typeof value !== "number", `${e.id} carries no literal number`);
  }
  const at = { asOf: NOW, ...ctx };
  assert.equal(effectFor({}, "small_purchase_limit_usd", at).value, 100000);
  assert.equal(effectFor({}, "micropurchase_max_usd_goods_and_services", at).value, 20000);
  assert.equal(effectFor({}, "micropurchase_max_usd_construction", at).value, 35000);
  assert.equal(effectFor({ method_family: "mwbe_small_purchase" }, "award_notice_deadline_days_after_registration", at).value, 15);
  assert.equal(effectFor({ method_family: "ordinary_5_plus_10" }, "public_solicitation_notice", at).value, "not_required");
  assert.equal(effectFor({ procurement_category: "human_services" }, "mwbe_small_purchase_method_available", at).value, "no");

  // The register's micropurchase number is the policy resolver's boundary.
  const micro = (amount) => resolveProcurementPublicationPolicy({ method_family: "ordinary_micropurchase",
    procurement_category: "goods_and_non_construction_services", amount, occurred_on: NOW }, "solicitation", policyRegistry).policy_match;
  const limit = effectFor({}, "micropurchase_max_usd_goods_and_services", at).value;
  assert.equal(micro(limit), "matched");
  assert.equal(micro(limit + 1), "unmatched");

  // Exercise the whole register, then compare the policy table.
  for (const key of Object.keys(LEGAL_EFFECT_KEYS)) effectFor({ procurement_category: "construction" }, key, at);
  validateLegalRegister(register, { policyRegistry, sources });
  assert.equal(JSON.stringify(policyRegistry), POLICY_REGISTRY_BEFORE);
  assert.ok(POLICY_TABLE.length >= 12);
  assert.deepEqual(policySnapshot(), POLICY_BEFORE);
  assert.equal(POLICY_BEFORE.map((r) => r.policy_match).join(","), "matched,unmatched,matched,unmatched,matched,unmatched,unmatched,matched,unmatched,unmatched,unmatched,matched,unmapped,unmatched");
  assert.equal(fileSha(REGISTRY_PATH), BASELINE_REGISTRY_SHA256);
});

test("(vi) failure controls are rejected with specific messages", () => {
  const first = register.entries[0];
  rejects((r) => r.entries.push(structuredClone(first)), /duplicate entry id\+record_version/);
  rejects((r) => { r.entries.find((e) => e.id.endsWith("from_2022_10_06")).effective_to = null; }, /overlapping in-force intervals/);
  rejects((r) => {
    const twin = structuredClone(r.entries.find((e) => e.id.endsWith("from_2023_12_08")));
    twin.id = "nyc.charter.311.i.1.mwbe_small_purchase_ceiling.twin";
    twin.supersedes = null;
    delete twin.corresponds_to;
    r.entries.push(twin);
  }, /overlapping in-force intervals/);
  rejects((r) => { r.entries.find((e) => e.id === Q(7)).authority.quote = null; }, /source_checked requires authority\.quote/);
  rejects((r) => {
    const a = r.entries.find((e) => e.id === Q(7)).authority;
    a.quote = "(7) contracts for all services;";
    a.quote_sha256 = sha(Buffer.from(a.quote, "utf8"));
  }, /does not occur in source file/);
  rejects((r) => { r.entries.find((e) => e.id === Q(7)).authority.quote_sha256 = "0".repeat(64); }, /quote_sha256 does not match/);
  rejects(() => {}, /hash does not match the register catalog/, {
    mutateSources: (s) => ({ ...s, "admin-code-6-129.md": `${s["admin-code-6-129.md"]} ` }),
  });
  rejects((r) => { r.entries.find((e) => e.id === Q(7)).review = { status: "practitioner_reviewed", by: null, on: null }; },
    /practitioner_reviewed requires a named reviewer/);
  rejects((r) => { r.entries.find((e) => e.id === Q(7)).applies_when.procurement_category = ["human_service"]; },
    /unknown vocabulary value "human_service"/);
  rejects((r) => { r.entries.find((e) => e.id === Q(7)).effect.mwbe_participation_requirement = "waived"; },
    /unknown vocabulary value "waived"/);
  rejects((r) => { r.entries.find((e) => e.id === "nyc.ppb.3-08.c.1.ii.micropurchase_limits").realized_by.family = "ordinary_micro"; },
    /family ordinary_micro does not resolve/);
  rejects((r) => { r.entries.find((e) => e.id === "nyc.ppb.3-08.c.1.ii.micropurchase_limits").effect.micropurchase_max_usd_construction = 35000; },
    /duplicates a number owned by the policy registry/);
  rejects((r) => { delete r.entries.find((e) => e.id === "nyc.ppb.3-08.a.small_purchase_limit").realized_by; },
    /3-08 entries must carry realized_by/);
  rejects((r) => { r.known_divergences = r.known_divergences.filter((d) => d.id !== "kd.mwbe_small_purchase_ceiling_dates"); },
    /without a known_divergences item/);
  rejects((r) => { const e = r.entries.find((x) => x.id === Q(7)); e.effective_from_basis = ""; }, /requires effective_from_basis/);
  assert.throws(() => effectFor({ procurement_category: "services" }, "mwbe_participation_requirement", { asOf: NOW, ...ctx }), /unknown vocabulary value/);
  assert.throws(() => effectFor({ vendor_size: "small" }, "mwbe_participation_requirement", { asOf: NOW, ...ctx }), /unknown fact vendor_size/);
});

test("(vii) every consumer path exists in the engine tree", () => {
  const consumers = new Set(register.entries.flatMap((e) => e.consumers));
  assert.equal(consumers.size, 18);
  for (const path of consumers) assert.ok(existsSync(join(REPO_ROOT, path)), path);
});

test("(viii) registerKnownAsOf returns what was believed on a recorded date", () => {
  const corrected = structuredClone(register);
  const v1 = corrected.entries.find((e) => e.id.endsWith("from_2023_12_08"));
  const v2 = { ...structuredClone(v1), record_version: 2, recorded_at: "2026-11-12", effective_from: "2023-12-19",
    notes: "Hypothetical corrected reading for the test only." };
  corrected.entries.push(v2);
  assert.equal(validateLegalRegister(corrected, { policyRegistry, sources }), true);
  const then = registerKnownAsOf(corrected, NOW).entries.find((e) => e.id === v1.id);
  const later = registerKnownAsOf(corrected, "2026-11-12").entries.find((e) => e.id === v1.id);
  assert.equal(then.record_version, 1);
  assert.equal(later.record_version, 2);
  assert.equal(effectFor({}, "mwbe_small_purchase_max_usd", { asOf: "2023-12-10", register: registerKnownAsOf(corrected, NOW), policyRegistry }).value, 1500000);
  assert.equal(effectFor({}, "mwbe_small_purchase_max_usd", { asOf: "2023-12-10", register: corrected, policyRegistry }).value, "unknown");
  assert.equal(registerKnownAsOf(corrected, "2026-11-10").entries.length, 0);
});

test("resolveLegalRules without a date answers unknown for every rule", () => {
  const { as_of, results } = resolveLegalRules({ procurement_category: "human_services" }, ctx);
  assert.equal(as_of, null);
  assert.ok(results.every((r) => r.status === "unknown" && r.missing_facts.includes("occurred_on")));
});
