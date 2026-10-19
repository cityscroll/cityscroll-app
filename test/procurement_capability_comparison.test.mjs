// Cited capability comparison for historical award descriptions (bounded pilot).
// Public examples only — award notice text from published City Record notices.

import assert from "node:assert/strict";
import test from "node:test";

import {
  PROCUREMENT_CAPABILITY_COMPARISON_SCHEMA,
  PROCUREMENT_CAPABILITY_PROFILE_SCHEMA,
  CAPABILITY_ASSESSMENT_STATE,
  CAPABILITY_SOURCE_ROLE,
  CITED_DUTY_VOCABULARY,
  normalizeCapabilityProfile,
  extractCitedDuties,
  citationMatchesRecord,
  compareCapabilities,
  assessmentForDuty,
  hasSupportedAssessment,
} from "../site/procurement_capability_comparison.mjs";

import {
  normalizePreferenceSet,
  explainMatch,
} from "../site/procurement_preference_set.mjs";

import { exactIdentityBasis } from "../site/procurement_related_context.mjs";

// Retained public award examples (published notice fields only).
const FDNY_DRAIN = Object.freeze({
  request_id: "20230807115",
  agency_name: "Fire Department",
  type_of_notice_description: "Award",
  category_description: "Construction/Construction Services",
  short_title: "Building Drain Blockage Removal Services",
  selection_method_description: "M/WBE Noncompetitive Small Purchase",
  pin: "05723W0035001",
  contract_amount: "1000000",
  additional_description_1:
    "<p>The Fire Department of the City of New York seeks the services of a qualified Contractor to remove blockages from building drain lines, plumbing fixtures, vent and leader stack lines, and yard and storm drains; perform maintenance of sanitary systems; provide pump truck, jet vacuum and video camera inspectional services; and clean and disinfect sanitary system back-ups in Fire Department facilities throughout the five (5) boroughs of New York City.</p>",
  vendor_name: "Dirty Gloves Drain Services LLC",
  source_url: "https://cityscroll.org/notices/20230807115/",
});

const DOT_VEGETATION = Object.freeze({
  request_id: "20231220107",
  agency_name: "Transportation",
  type_of_notice_description: "Award",
  category_description: "Services (other than human services)",
  short_title: "GARBAGE REMOVAL and VEGETATION TRIMMING - BRONX, MANHATTAN",
  selection_method_description: "M/WBE Noncompetitive Small Purchase",
  pin: "84124W0031001",
  contract_amount: "634000",
  vendor_name: "Dirty Gloves Drain Services LLC",
  source_url: "https://cityscroll.org/notices/20231220107/",
});

const DCAS_SEWER = Object.freeze({
  request_id: "20251008021",
  agency_name: "Citywide Administrative Services",
  type_of_notice_description: "Award",
  category_description: "Construction Related Services",
  short_title: "Sewer Line Clean Up at Farm Colony Staten Island",
  selection_method_description: "M/WBE Noncompetitive Small Purchase",
  pin: "85626W0014001",
  contract_amount: "100000",
  additional_description_1:
    "<p>General Requirement and Specifications for furnishing all labor, equipment and materials necessary and required for Sewer Line Clean Up at Farm Colony Staten Island. </p>",
  vendor_name: "Dirty Gloves Drain Services LLC",
  source_url: "https://cityscroll.org/notices/20251008021/",
});

const DRAIN_ONLY = Object.freeze({
  name: "Drain maintenance",
  capability_keywords: ["drain cleaning"],
  jet_vac_truck: false,
  landscaping: false,
});

const JET_VAC_AVAILABLE = Object.freeze({
  name: "Drain with jet-vac service",
  capability_keywords: ["drain cleaning"],
  jet_vac_truck: true,
  landscaping: false,
});

const UNSPECIFIED = Object.freeze({
  name: "Unspecified capacity",
  capability_keywords: ["drain cleaning"],
});

// ---- Profile normalization ----

test("normalizeCapabilityProfile freezes stated fields and leaves omitted ones null", () => {
  const profile = normalizeCapabilityProfile(DRAIN_ONLY);
  assert.equal(profile.schema, PROCUREMENT_CAPABILITY_PROFILE_SCHEMA);
  assert.equal(profile.jet_vac_truck, false);
  assert.equal(profile.landscaping, false);
  assert.equal(profile.drain_cleaning, true);
  assert.equal(profile.roof_installation_crew, null);
  assert.deepEqual(profile.capability_keywords, ["drain cleaning"]);
});

test("normalizeCapabilityProfile does not invent capabilities from amount or method", () => {
  const profile = normalizeCapabilityProfile({
    contract_amount: 1000000,
    selection_method_description: "M/WBE Noncompetitive Small Purchase",
    vendor_name: "Someone Else",
  });
  assert.equal(profile.jet_vac_truck, null);
  assert.equal(profile.landscaping, null);
  assert.equal(profile.drain_cleaning, null);
});

// ---- A1: FDNY jet-vac service gap without ownership claim ----

test("A1 / M1: FDNY award cites jet vacuum service; drain-only profile sees a service gap, ownership_required stays null", () => {
  const comparison = compareCapabilities({ profile: DRAIN_ONLY, record: FDNY_DRAIN });
  assert.equal(comparison.schema, PROCUREMENT_CAPABILITY_COMPARISON_SCHEMA);
  assert.equal(comparison.notice_id, "20230807115");
  assert.equal(comparison.source_url, "https://cityscroll.org/notices/20230807115/");
  assert.equal(comparison.source_role, CAPABILITY_SOURCE_ROLE);
  assert.equal(comparison.overall_eligibility, null);
  assert.equal(comparison.ownership_required, null);

  const jet = assessmentForDuty(comparison, "jet_vacuum_service");
  assert.ok(jet);
  assert.equal(jet.state, CAPABILITY_ASSESSMENT_STATE.STATED_CAPABILITY_GAP);
  assert.equal(jet.service_gap, "jet vacuum");
  assert.equal(jet.ownership_required, null);
  assert.equal(jet.overall_eligibility, null);
  assert.equal(jet.citation.field, "additional_description_1");
  assert.equal(
    jet.citation.passage,
    "pump truck, jet vacuum and video camera inspectional services",
  );
  assert.equal(jet.citation.notice_id, "20230807115");
  assert.match(jet.wording, /Ownership of equipment is not established/);
});

test("A1: drain blockage duty overlaps a drain-cleaning profile on the same FDNY award", () => {
  const comparison = compareCapabilities({ profile: DRAIN_ONLY, record: FDNY_DRAIN });
  const drain = assessmentForDuty(comparison, "drain_blockage_removal");
  assert.ok(drain);
  assert.equal(drain.state, CAPABILITY_ASSESSMENT_STATE.SUPPORTED_OVERLAP);
  assert.equal(drain.ownership_required, null);
});

// ---- A2: DOT vegetation gap + DCAS document review ----

test("A2 / M2: DOT title cites vegetation trimming; drain-only profile sees that service gap", () => {
  const comparison = compareCapabilities({ profile: DRAIN_ONLY, record: DOT_VEGETATION });
  const veg = assessmentForDuty(comparison, "vegetation_trimming");
  assert.ok(veg);
  assert.equal(veg.state, CAPABILITY_ASSESSMENT_STATE.STATED_CAPABILITY_GAP);
  assert.equal(veg.service_gap, "vegetation trimming");
  assert.equal(veg.citation.field, "short_title");
  assert.equal(veg.citation.passage, "VEGETATION TRIMMING");
  assert.equal(veg.ownership_required, null);
});

test("A2 / M3: DCAS generic labor/equipment/materials passage stays document-review-needed", () => {
  const comparison = compareCapabilities({ profile: DRAIN_ONLY, record: DCAS_SEWER });
  const nonspecific = assessmentForDuty(comparison, "nonspecific_equipment_materials");
  assert.ok(nonspecific);
  assert.equal(nonspecific.state, CAPABILITY_ASSESSMENT_STATE.DOCUMENT_REVIEW_NEEDED);
  assert.equal(nonspecific.citation.field, "additional_description_1");
  assert.match(nonspecific.citation.passage, /all labor, equipment and materials/i);
  // Lower published amount never becomes eligibility.
  assert.equal(comparison.overall_eligibility, null);
  assert.equal(Number(DCAS_SEWER.contract_amount) < Number(FDNY_DRAIN.contract_amount), true);
});

// ---- A3: unspecified fields + mutation rejection + non-eligibility signals ----

test("A3 / M5: unspecified jet_vac_truck yields unspecified assessment, not a gap", () => {
  const comparison = compareCapabilities({ profile: UNSPECIFIED, record: FDNY_DRAIN });
  const jet = assessmentForDuty(comparison, "jet_vacuum_service");
  assert.ok(jet);
  assert.equal(jet.state, CAPABILITY_ASSESSMENT_STATE.UNSPECIFIED);
  assert.equal(jet.service_gap, null);
});

test("A3 / M4: jet-vac-available profile has no jet-vac gap; overall_eligibility stays null", () => {
  const comparison = compareCapabilities({
    profile: JET_VAC_AVAILABLE,
    record: FDNY_DRAIN,
  });
  const jet = assessmentForDuty(comparison, "jet_vacuum_service");
  assert.ok(jet);
  assert.equal(jet.state, CAPABILITY_ASSESSMENT_STATE.SUPPORTED_OVERLAP);
  assert.equal(jet.service_gap, null);
  assert.equal(comparison.overall_eligibility, null);
  assert.equal(comparison.ownership_required, null);
});

test("A3 / M6: removing the jet vacuum passage rejects a supported jet-vac claim", () => {
  const mutated = {
    ...FDNY_DRAIN,
    additional_description_1:
      "<p>The Fire Department seeks a contractor to remove blockages from building drain lines and perform maintenance of sanitary systems.</p>",
  };
  const comparison = compareCapabilities({
    profile: JET_VAC_AVAILABLE,
    record: mutated,
  });
  assert.equal(hasSupportedAssessment(comparison, "jet_vacuum_service"), false);
  assert.equal(assessmentForDuty(comparison, "jet_vacuum_service"), null);
  // Drain overlap can still appear when its passage remains.
  assert.ok(assessmentForDuty(comparison, "drain_blockage_removal"));
});

test("A3: amount, M/WBE method, and awardee never establish eligibility", () => {
  const comparison = compareCapabilities({ profile: DRAIN_ONLY, record: FDNY_DRAIN });
  assert.equal(comparison.overall_eligibility, null);
  for (const assessment of comparison.assessments) {
    assert.equal(assessment.overall_eligibility, null);
    assert.equal(assessment.ownership_required, null);
  }
  // Preference-set eligibility remains a separate seam and is unaffected.
  const prefs = normalizePreferenceSet({
    capabilityKeywords: ["drain cleaning"],
  });
  const prefMatch = explainMatch({ preferences: prefs, record: FDNY_DRAIN });
  assert.equal(typeof prefMatch.eligible, "boolean");
});

test("A3: citationMatchesRecord fails when the passage is altered", () => {
  const duties = extractCitedDuties(FDNY_DRAIN);
  const jet = duties.find((d) => d.duty_id === "jet_vacuum_service");
  assert.ok(jet);
  assert.equal(citationMatchesRecord(jet.citation, FDNY_DRAIN), true);
  assert.equal(
    citationMatchesRecord(jet.citation, {
      ...FDNY_DRAIN,
      additional_description_1: "<p>No equipment named.</p>",
    }),
    false,
  );
});

// ---- A4: controls — shuffled input, omitted description, vocabulary stability ----

test("A4: shuffled profile key order yields identical comparison", () => {
  const a = compareCapabilities({
    profile: { landscaping: false, jet_vac_truck: false, capability_keywords: ["drain cleaning"] },
    record: FDNY_DRAIN,
  });
  const b = compareCapabilities({
    profile: { capability_keywords: ["drain cleaning"], jet_vac_truck: false, landscaping: false },
    record: FDNY_DRAIN,
  });
  assert.deepEqual(
    a.assessments.map((x) => ({ duty_id: x.duty_id, state: x.state, service_gap: x.service_gap })),
    b.assessments.map((x) => ({ duty_id: x.duty_id, state: x.state, service_gap: x.service_gap })),
  );
});

test("A4: omitted description extracts no jet-vac or nonspecific duties", () => {
  const bare = {
    request_id: "20230807115",
    short_title: "Building Drain Blockage Removal Services",
    source_url: "https://cityscroll.org/notices/20230807115/",
  };
  const duties = extractCitedDuties(bare);
  assert.equal(duties.some((d) => d.duty_id === "jet_vacuum_service"), false);
  assert.equal(duties.some((d) => d.duty_id === "nonspecific_equipment_materials"), false);
});

test("A4: changing landscaping capability flips only the vegetation assessment", () => {
  const without = compareCapabilities({
    profile: { ...DRAIN_ONLY, landscaping: false },
    record: DOT_VEGETATION,
  });
  const withLandscaping = compareCapabilities({
    profile: { ...DRAIN_ONLY, landscaping: true },
    record: DOT_VEGETATION,
  });
  assert.equal(
    assessmentForDuty(without, "vegetation_trimming").state,
    CAPABILITY_ASSESSMENT_STATE.STATED_CAPABILITY_GAP,
  );
  assert.equal(
    assessmentForDuty(withLandscaping, "vegetation_trimming").state,
    CAPABILITY_ASSESSMENT_STATE.SUPPORTED_OVERLAP,
  );
});

test("A4: cited duty vocabulary is reviewed and frozen", () => {
  assert.ok(CITED_DUTY_VOCABULARY.length >= 3);
  for (const entry of CITED_DUTY_VOCABULARY) {
    assert.ok(entry.duty_id);
    assert.ok(entry.field);
    assert.ok(entry.passage);
    assert.ok(["service", "nonspecific"].includes(entry.kind));
  }
});

// ---- Existing seams unchanged ----

test("existing preference-set suite seam still explains keyword matches", () => {
  const prefs = normalizePreferenceSet({ capabilityKeywords: ["playground"] });
  const result = explainMatch({
    preferences: prefs,
    record: {
      short_title: "Playground reconstruction",
      additional_description_1: "Rebuild playground equipment.",
      agency_name: "Parks",
      category_description: "Construction/Construction Services",
    },
  });
  assert.equal(result.eligible, true);
});

test("existing related-context exactIdentityBasis still classifies PIN renewals", () => {
  const basis = exactIdentityBasis(
    { pin: "80123P0010001" },
    { pin: "80123P0010001R001" },
  );
  assert.equal(basis, "exact_predecessor_link");
});
