// Cross-category program capability retrieval for historical awards (bounded pilot).
// Public examples only — published City Record award notice fields.

import assert from "node:assert/strict";
import test from "node:test";

import {
  PROCUREMENT_PROGRAM_CAPABILITIES_SCHEMA,
  PROCUREMENT_PROGRAM_GROUP_SCHEMA,
  PROGRAM_RELATION,
  normalizeProgramProfile,
  extractProgramCapabilities,
  hasProgramIdentityEvidence,
  hasReviewedProgramBuyer,
  admitsProgramHistory,
  matchProgramRecords,
  groupProgramHistory,
  relationBetween,
} from "../site/procurement_program_capabilities.mjs";

import { exactIdentityBasis } from "../site/procurement_related_context.mjs";

const SBS_2022 = Object.freeze({
  request_id: "20220719104",
  agency_name: "Small Business Services",
  type_of_notice_description: "Award",
  category_description: "Services (other than human services)",
  short_title: "TO PROVIDE COOLROOFS TRAINING PROGRAM",
  selection_method_description: "Renewal",
  pin: "80121X8003KXLR002",
  contract_amount: "876250",
  additional_description_1:
    "<p>CONTRACT RENEWAL - NYC COOLROOFS TRAINING PROGRAM ADMINISTRATION</p>",
  vendor_name: "The Hope Program Inc.",
  source_url: "https://cityscroll.org/notices/20220719104/",
});

const SBS_2024 = Object.freeze({
  request_id: "20240417107",
  agency_name: "Small Business Services",
  type_of_notice_description: "Award",
  category_description: "Human Services/Client Services",
  short_title: "NYC CoolRoofs Training Program Administration",
  selection_method_description: "Competitive Sealed Proposals/Pre-Qualified List",
  pin: "80123P0010001",
  contract_amount: "2191278",
  additional_description_1:
    "<p>SBS is seeking a qualified vendor(s) or consortium of qualified vendors to deliver the NYC CoolRoofs program. NYC CoolRoofs is a City initiative that supports local jobseekers through a paid and transitional work-based learning experience to cool New York City rooftops with a white, reflective coating that reduces building energy consumption and citywide greenhouse gas emissions. Participants work in teams to complete cool roof installations for individual buildings, and, along with performing the physical labor involved with coating a rooftop, receive skill-building and professional development training and support to advance in a career path in the construction sector. The Program supports the Citymitment to reach carbon neutrality by 2050.</p>",
  vendor_name: "The Hope Program Inc.",
  source_url: "https://cityscroll.org/notices/20240417107/",
});

const SBS_2026 = Object.freeze({
  request_id: "20260708004",
  agency_name: "Small Business Services",
  type_of_notice_description: "Award",
  category_description: "Human Services/Client Services",
  short_title: "NYC CoolRoofs Training Program Administration",
  selection_method_description: "Renewal",
  pin: "80123P0010001R001",
  contract_amount: "1867888",
  additional_description_1:
    "<p>NYC CoolRoofs is a City initiative that supports local jobseekers through a paid and transitional work-based learning experience to cool New York City rooftops with a white, reflective coating that reduces building energy consumption and citywide greenhouse gas emissions. </p>",
  vendor_name: "The Hope Program Inc.",
  source_url: "https://cityscroll.org/notices/20260708004/",
});

/** Same buyer/vendor, no program-identity passage. */
const UNRELATED_HOPE = Object.freeze({
  request_id: "20250103044",
  agency_name: "Small Business Services",
  type_of_notice_description: "Award",
  category_description: "Human Services/Client Services",
  short_title: "Workforce supportive services",
  selection_method_description: "Negotiated Acquisition",
  pin: "80125X9999001",
  contract_amount: "500000",
  additional_description_1:
    "<p>Supportive services for jobseekers including coaching and placement assistance.</p>",
  vendor_name: "The Hope Program Inc.",
  source_url: "https://cityscroll.org/notices/20250103044/",
});

/** Generic roof notice with no CoolRoofs program evidence. */
const GENERIC_ROOF = Object.freeze({
  request_id: "20190101001",
  agency_name: "Citywide Administrative Services",
  type_of_notice_description: "Award",
  category_description: "Construction/Construction Services",
  short_title: "Roof repair services",
  selection_method_description: "Competitive Sealed Bids",
  pin: "85619C0001001",
  contract_amount: "250000",
  additional_description_1:
    "<p>Furnish labor and materials for roof repair on municipal buildings.</p>",
  vendor_name: "Acme Roofing LLC",
  source_url: "https://cityscroll.org/notices/20190101001/",
});

/**
 * Wrong-buyer control: CoolRoofs program-identity passages on a non-reviewed
 * agency. Identity evidence alone must not admit the record.
 */
const WRONG_BUYER_COOLROOFS = Object.freeze({
  request_id: "20239999001",
  agency_name: "Department of Transportation",
  type_of_notice_description: "Award",
  category_description: "Human Services/Client Services",
  short_title: "NYC CoolRoofs Training Program Administration",
  selection_method_description: "Competitive Sealed Proposals/Pre-Qualified List",
  pin: "84123P0099001",
  contract_amount: "1000000",
  additional_description_1:
    "<p>NYC CoolRoofs is a City initiative that supports local jobseekers through a paid and transitional work-based learning experience to cool New York City rooftops with a white, reflective coating.</p>",
  vendor_name: "The Hope Program Inc.",
  source_url: "https://cityscroll.org/notices/20239999001/",
});

const TRAINING_PROFILE = Object.freeze({
  name: "Workforce training nonprofit",
  capability_keywords: ["job training", "employer placement"],
  job_training: true,
  employer_placement: true,
  roof_installation_crew: false,
});

const CORPUS = [SBS_2022, SBS_2024, SBS_2026, UNRELATED_HOPE, GENERIC_ROOF];

test("normalizeProgramProfile freezes stated training fields", () => {
  const profile = normalizeProgramProfile(TRAINING_PROFILE);
  assert.equal(profile.job_training, true);
  assert.equal(profile.employer_placement, true);
  assert.equal(profile.roof_installation_crew, false);
});

// A1: training profile retrieves three awards across both categories with citations
test("A1 / C1: training profile retrieves three awards across both categories with citations", () => {
  const result = matchProgramRecords({ profile: TRAINING_PROFILE, records: CORPUS });
  assert.equal(result.schema, PROCUREMENT_PROGRAM_CAPABILITIES_SCHEMA);
  const ids = result.matches.map((m) => m.notice_id).sort();
  assert.deepEqual(ids, ["20220719104", "20240417107", "20260708004"]);
  const categories = new Set(result.matches.map((m) => m.category_description));
  assert.equal(categories.size, 2);
  for (const match of result.matches) {
    assert.ok(match.source_url);
    assert.ok(match.capabilities.length >= 1);
    for (const cap of match.capabilities) {
      assert.equal(cap.citation.notice_id, match.notice_id);
      assert.ok(cap.citation.url);
      assert.ok(cap.citation.field);
      assert.ok(cap.citation.passage);
    }
  }
  assert.equal(result.overall_eligibility, null);
  assert.equal(result.future_opening_predicted, false);
});

// A2: exact link only 2024/2026; 2022 program-related; negatives refused
test("A2 / C2-C3: only 2024/2026 keep exact_predecessor_link; 2022 is program_related; negatives refused", () => {
  assert.equal(exactIdentityBasis(SBS_2024, SBS_2026), "exact_predecessor_link");
  assert.equal(exactIdentityBasis(SBS_2022, SBS_2024), null);
  assert.equal(exactIdentityBasis(SBS_2022, SBS_2026), null);

  const group = groupProgramHistory({ records: CORPUS });
  assert.equal(group.schema, PROCUREMENT_PROGRAM_GROUP_SCHEMA);
  const memberIds = group.members.map((m) => m.notice_id).sort();
  assert.deepEqual(memberIds, ["20220719104", "20240417107", "20260708004"]);
  assert.equal(
    relationBetween(group, "20240417107", "20260708004"),
    PROGRAM_RELATION.EXACT_PREDECESSOR_LINK,
  );
  assert.equal(
    relationBetween(group, "20220719104", "20240417107"),
    PROGRAM_RELATION.PROGRAM_RELATED,
  );
  assert.equal(
    relationBetween(group, "20220719104", "20260708004"),
    PROGRAM_RELATION.PROGRAM_RELATED,
  );
  assert.equal(hasProgramIdentityEvidence(UNRELATED_HOPE), false);
  assert.equal(hasProgramIdentityEvidence(GENERIC_ROOF), false);
  assert.equal(admitsProgramHistory(UNRELATED_HOPE), false);
  assert.equal(admitsProgramHistory(GENERIC_ROOF), false);
  assert.equal(group.program_admission_requires_buyer, true);
});

// A3: 2024 coating/consortium stay on 2024; sparse 2022; no invented placement duty; no future opening
test("A3 / C4-C6: 2024 coating and consortium stay on 2024; sparse 2022; no invented placement or future opening", () => {
  const caps2024 = extractProgramCapabilities(SBS_2024);
  const ids2024 = caps2024.map((c) => c.capability_id);
  assert.ok(ids2024.includes("reflective_coating"));
  assert.ok(ids2024.includes("consortium_delivery"));
  for (const cap of caps2024) {
    assert.equal(cap.citation.notice_id, "20240417107");
  }

  const caps2022 = extractProgramCapabilities(SBS_2022);
  assert.ok(caps2022.length >= 1);
  assert.ok(!caps2022.some((c) => c.capability_id === "consortium_delivery"));
  assert.ok(!caps2022.some((c) => c.capability_id === "reflective_coating"));

  const group = groupProgramHistory({ records: [SBS_2022, SBS_2024, SBS_2026] });
  for (const member of group.members) {
    assert.equal(member.employer_placement_required, false);
  }
  assert.equal(group.future_opening_predicted, false);
  assert.equal(group.program_admission_from_awardee_alone, false);
});

// A4 isolated controls: buyer-aware admission, wrong-buyer, passage-removal,
// identity mutation, per-record duties, exact lineage unchanged.

test("A4 isolated: buyer-aware admission requires reviewed buyer and identity", () => {
  assert.equal(hasReviewedProgramBuyer(SBS_2024), true);
  assert.equal(hasProgramIdentityEvidence(SBS_2024), true);
  assert.equal(admitsProgramHistory(SBS_2024), true);
  assert.equal(admitsProgramHistory(SBS_2022), true);
  assert.equal(admitsProgramHistory(SBS_2026), true);

  const buyerOnly = {
    ...UNRELATED_HOPE,
    vendor_name: "The Hope Program Inc.",
    agency_name: "Small Business Services",
  };
  assert.equal(hasReviewedProgramBuyer(buyerOnly), true);
  assert.equal(hasProgramIdentityEvidence(buyerOnly), false);
  assert.equal(admitsProgramHistory(buyerOnly), false);
});

test("A4 isolated: wrong-buyer with CoolRoofs passages fails program admission", () => {
  assert.equal(hasProgramIdentityEvidence(WRONG_BUYER_COOLROOFS), true);
  assert.equal(hasReviewedProgramBuyer(WRONG_BUYER_COOLROOFS), false);
  assert.equal(admitsProgramHistory(WRONG_BUYER_COOLROOFS), false);

  const group = groupProgramHistory({
    records: [SBS_2022, SBS_2024, SBS_2026, WRONG_BUYER_COOLROOFS],
  });
  assert.deepEqual(
    group.members.map((m) => m.notice_id).sort(),
    ["20220719104", "20240417107", "20260708004"],
  );
  assert.equal(
    group.members.some((m) => m.notice_id === "20239999001"),
    false,
  );
});

test("A4 isolated: passage removal drops capability matches only for that record", () => {
  const passageRemoved = {
    ...SBS_2024,
    additional_description_1: "<p>Unrelated administrative services.</p>",
  };
  // Title still carries program identity; description passages are gone.
  assert.equal(hasProgramIdentityEvidence(passageRemoved), true);
  assert.equal(admitsProgramHistory(passageRemoved), true);
  const caps = extractProgramCapabilities(passageRemoved);
  assert.ok(!caps.some((c) => c.capability_id === "reflective_coating"));
  assert.ok(!caps.some((c) => c.capability_id === "consortium_delivery"));
  assert.ok(!caps.some((c) => c.capability_id === "jobseeker_training"));

  const result = matchProgramRecords({
    profile: TRAINING_PROFILE,
    records: [passageRemoved, SBS_2022, SBS_2026],
  });
  // Title-based program identity can still match; description duties do not.
  const hit = result.matches.find((m) => m.notice_id === "20240417107");
  assert.ok(hit);
  assert.ok(
    hit.capabilities.every(
      (c) =>
        c.capability_id === "coolroofs_training_program_title" ||
        c.capability_id === "coolroofs_training_program",
    ),
  );
  assert.deepEqual(
    result.matches.map((m) => m.notice_id).sort(),
    ["20220719104", "20240417107", "20260708004"],
  );
});

test("A4 isolated: identity mutation refuses admission; exact lineage unchanged", () => {
  const identityMutated = {
    ...SBS_2024,
    additional_description_1: "<p>Unrelated administrative services.</p>",
    short_title: "Administrative services",
  };
  assert.equal(hasProgramIdentityEvidence(identityMutated), false);
  assert.equal(hasReviewedProgramBuyer(identityMutated), true);
  assert.equal(admitsProgramHistory(identityMutated), false);

  const result = matchProgramRecords({
    profile: TRAINING_PROFILE,
    records: [identityMutated, SBS_2022, SBS_2026],
  });
  assert.deepEqual(
    result.matches.map((m) => m.notice_id).sort(),
    ["20220719104", "20260708004"],
  );

  const group = groupProgramHistory({
    records: [identityMutated, SBS_2022, SBS_2026],
  });
  assert.deepEqual(
    group.members.map((m) => m.notice_id).sort(),
    ["20220719104", "20260708004"],
  );

  // Exact lineage seam still works on unmodified originals.
  assert.equal(exactIdentityBasis(SBS_2024, SBS_2026), "exact_predecessor_link");
});

test("A4 isolated: per-record duties stay on their supporting award", () => {
  const caps2024 = extractProgramCapabilities(SBS_2024);
  const caps2022 = extractProgramCapabilities(SBS_2022);
  assert.ok(caps2024.some((c) => c.capability_id === "consortium_delivery"));
  assert.ok(caps2024.some((c) => c.capability_id === "reflective_coating"));
  assert.ok(!caps2022.some((c) => c.capability_id === "consortium_delivery"));
  assert.ok(!caps2022.some((c) => c.capability_id === "reflective_coating"));
  for (const cap of caps2024) {
    assert.equal(cap.citation.notice_id, "20240417107");
  }
});
