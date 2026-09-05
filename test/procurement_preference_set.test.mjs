// procurement-pursuit-decision, Card "PPD-05": a reusable vendor preference
// set, and a deterministic explanation of why one record does or does not
// qualify against it. See site/procurement_preference_set.mjs for the full
// contract and the negative rules this card enforces.

import assert from "node:assert/strict";
import test from "node:test";

import {
  PROCUREMENT_PREFERENCE_SET_SCHEMA,
  PROCUREMENT_PREFERENCE_MATCH_SCHEMA,
  PREFERENCE_PROVENANCE_LABEL,
  isUserSuppliedProvenanceLabel,
  reasonsCarryPreferenceProvenance,
  normalizePreferenceSet,
  explainMatch,
  orderExplanations,
} from "../site/procurement_preference_set.mjs";

function fullPreferencesInput() {
  return {
    agencies: ["Department of Parks and Recreation"],
    categories: ["Construction/Construction Services"],
    capabilityKeywords: ["playground"],
    minAmount: 100000,
    maxAmount: 900000,
    methods: ["Competitive Sealed Bidding"],
    certificationStatus: ["MBE"],
    certificationInterest: true,
    closingHorizon: { notBefore: "2026-07-01", notAfter: "2026-09-01" },
    exclusions: { agencies: ["Department of Transportation"], keywords: ["asbestos"] },
  };
}

function qualifyingRecord(overrides = {}) {
  return {
    agency_name: "Department of Parks and Recreation",
    category_description: "Construction/Construction Services",
    short_title: "Playground reconstruction citywide phase two",
    additional_description_1: "Rebuild playground equipment and surfacing.",
    contract_amount: 500000,
    selection_method_description: "Competitive Sealed Bidding",
    due_date: "2026-08-05",
    mwbe_goal_present: true,
    ...overrides,
  };
}

// ---- A1: state preferences once, reuse across records ----

test("A1: a full preference set normalizes every stated field and carries no errors", () => {
  const prefs = normalizePreferenceSet(fullPreferencesInput());
  assert.equal(prefs.schema, PROCUREMENT_PREFERENCE_SET_SCHEMA);
  assert.deepEqual(prefs.agencies, ["Department of Parks and Recreation"]);
  assert.deepEqual(prefs.categories, ["Construction/Construction Services"]);
  assert.deepEqual(prefs.capability_keywords, ["playground"]);
  assert.equal(prefs.min_amount, 100000);
  assert.equal(prefs.max_amount, 900000);
  assert.deepEqual(prefs.methods, ["Competitive Sealed Bidding"]);
  assert.deepEqual(prefs.certification_status, ["MBE"]);
  assert.equal(prefs.certification_interest, true);
  assert.deepEqual(prefs.closing_horizon, { not_before: "2026-07-01", not_after: "2026-09-01" });
  assert.deepEqual(prefs.exclusions.agencies, ["Department of Transportation"]);
  assert.deepEqual(prefs.exclusions.keywords, ["asbestos"]);
  assert.deepEqual(prefs.errors, []);
});

test("A1: the same normalized preference set is reused unmodified against two different records", () => {
  const prefs = normalizePreferenceSet(fullPreferencesInput());
  const first = explainMatch({ record: qualifyingRecord(), preferences: prefs });
  const second = explainMatch({
    record: qualifyingRecord({ contract_amount: 250000, due_date: "2026-07-15" }),
    preferences: prefs,
  });
  assert.equal(first.eligible, true);
  assert.equal(second.eligible, true);
  // Same object, unmutated, reused twice.
  assert.deepEqual(prefs, normalizePreferenceSet(fullPreferencesInput()));
});

test("A1: trims and deduplicates repeated/whitespace-padded stated values", () => {
  const prefs = normalizePreferenceSet({
    agencies: [" Parks ", "Parks", "Parks"],
    methods: ["Competitive Sealed Bidding", " Competitive Sealed Bidding "],
  });
  assert.deepEqual(prefs.agencies, ["Parks"]);
  assert.deepEqual(prefs.methods, ["Competitive Sealed Bidding"]);
});

// ---- A2: a match states which preferences it satisfied, in readable terms ----

test("A2: explainMatch produces readable wording naming the satisfied preference and the observed fact", () => {
  const result = explainMatch({ record: qualifyingRecord(), preferences: fullPreferencesInput() });
  assert.equal(result.schema, PROCUREMENT_PREFERENCE_MATCH_SCHEMA);
  assert.equal(result.eligible, true);
  const agencyReason = result.reasons.find((r) => r.field === "agencies");
  assert.ok(agencyReason);
  assert.equal(agencyReason.satisfied, true);
  assert.match(agencyReason.wording, /Department of Parks and Recreation/);
  assert.match(agencyReason.wording, /matches one of your stated agencies/);
  const amountReason = result.reasons.find((r) => r.field === "amount");
  assert.match(amountReason.wording, /\$500,000/);
});

test("A2: an unsatisfied stated preference is reported as such, not silently omitted", () => {
  const result = explainMatch({
    record: qualifyingRecord({ agency_name: "Department of Transportation" }),
    preferences: fullPreferencesInput(),
  });
  const agencyReason = result.reasons.find((r) => r.field === "agencies");
  assert.equal(agencyReason.satisfied, false);
  assert.match(agencyReason.wording, /is not one of your stated agencies/);
});

// ---- A3: deterministic, byte-identical reasons regardless of input key order ----

test("A3: explainMatch is byte-identical across shuffled preference-object key order and repeated calls", () => {
  const a = fullPreferencesInput();
  // Same data, different insertion order.
  const b = {
    exclusions: a.exclusions,
    closingHorizon: a.closingHorizon,
    certificationInterest: a.certificationInterest,
    certificationStatus: a.certificationStatus,
    methods: a.methods,
    maxAmount: a.maxAmount,
    minAmount: a.minAmount,
    capabilityKeywords: a.capabilityKeywords,
    categories: a.categories,
    agencies: a.agencies,
  };
  const record = qualifyingRecord();
  const resultA = explainMatch({ record, preferences: a });
  const resultB = explainMatch({ record, preferences: b });
  assert.equal(JSON.stringify(resultA), JSON.stringify(resultB));

  const repeat1 = explainMatch({ record, preferences: a });
  const repeat2 = explainMatch({ record, preferences: a });
  assert.equal(JSON.stringify(repeat1), JSON.stringify(repeat2));
});

test("A3: normalizePreferenceSet output is identical regardless of stated array order", () => {
  const one = normalizePreferenceSet({ agencies: ["Parks", "Transportation"] });
  const two = normalizePreferenceSet({ agencies: ["Transportation", "Parks"] });
  assert.deepEqual(one, two);
});

// ---- A4: preference-derived values are labelled user-supplied, never a published fact ----

test("A4: every produced reason carries the preference-set's own provenance token", () => {
  const result = explainMatch({ record: qualifyingRecord(), preferences: fullPreferencesInput() });
  assert.ok(result.reasons.length > 0);
  for (const r of result.reasons) {
    assert.equal(r.provenance, PREFERENCE_PROVENANCE_LABEL);
    assert.equal(r.provenance, "user-supplied");
  }
  assert.ok(reasonsCarryPreferenceProvenance(result.reasons));
});

test("A4: isUserSuppliedProvenanceLabel rejects the published-fact grammar's own token", () => {
  // procurement_pursuit_snapshot.mjs's PURSUIT_FIELD_STATUS.USER_PROVIDED is
  // spelled with an underscore -- a different token in a different system's
  // vocabulary, never interchangeable with this module's own label.
  assert.equal(isUserSuppliedProvenanceLabel("user_provided"), false);
  assert.equal(isUserSuppliedProvenanceLabel("observed"), false);
  assert.equal(isUserSuppliedProvenanceLabel("user-supplied"), true);
});

test("A4 negative fixture: a renderer that reuses the published-fact label fails the exported vocabulary check", () => {
  const result = explainMatch({ record: qualifyingRecord(), preferences: fullPreferencesInput() });
  // Simulate a bad renderer relabeling one preference-derived reason with the
  // OTHER system's published-fact-adjacent token instead of this module's own.
  const mislabeled = result.reasons.map((r, index) => (
    index === 0 ? { ...r, provenance: "user_provided" } : r
  ));
  assert.equal(reasonsCarryPreferenceProvenance(mislabeled), false);
  assert.equal(reasonsCarryPreferenceProvenance(result.reasons), true, "the real output must still pass");
});

// ---- A5: an unset preference field never narrows or excludes ----

test("A5: no stated preferences at all yields eligible with zero reasons, for any record", () => {
  const result = explainMatch({ record: qualifyingRecord(), preferences: {} });
  assert.equal(result.eligible, true);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.excluded_by, null);
});

test("A5 property-style: every random subset of unset fields still yields eligible for a qualifying record", () => {
  const full = fullPreferencesInput();
  const fields = Object.keys(full);
  const record = qualifyingRecord();
  // Deterministic pseudo-random subsets (no external RNG dependency): each
  // bitmask over the stated fields is its own subset.
  const subsetCount = 2 ** fields.length;
  for (let mask = 0; mask < subsetCount; mask += 1) {
    const subset = {};
    fields.forEach((field, index) => {
      if (mask & (1 << index)) subset[field] = full[field];
    });
    const result = explainMatch({ record, preferences: subset });
    assert.equal(
      result.eligible,
      true,
      `subset ${JSON.stringify(Object.keys(subset))} unexpectedly excluded a fully-qualifying record`,
    );
  }
});

test("A5: an unobserved record fact never becomes a false exclusion", () => {
  // The record has no category_description/procurement_category at all --
  // an unobserved fact, not evidence the category does not match.
  const result = explainMatch({
    record: { agency_name: "Department of Parks and Recreation" },
    preferences: { categories: ["Construction"] },
  });
  assert.equal(result.eligible, true);
  assert.equal(result.reasons.find((r) => r.field === "categories"), undefined);
});

// ---- A6: eligibility filtering stays separate from ordering ----

test("A6: the eligibility result never carries a score, weight, or rank field", () => {
  const result = explainMatch({ record: qualifyingRecord(), preferences: fullPreferencesInput() });
  const json = JSON.stringify(result);
  assert.doesNotMatch(json, /"score"/i);
  assert.doesNotMatch(json, /"weight"/i);
  assert.doesNotMatch(json, /"rank"/i);
  for (const r of result.reasons) {
    assert.ok(!("score" in r) && !("weight" in r) && !("rank" in r));
  }
});

test("A6: orderExplanations only reorders for presentation, computing no score", () => {
  const result = explainMatch({ record: qualifyingRecord(), preferences: fullPreferencesInput() });
  const eligibleReasons = result.reasons.filter((r) => r.satisfied);
  const ordered = orderExplanations(eligibleReasons.slice().reverse());
  assert.deepEqual(ordered.map((r) => r.field), eligibleReasons.map((r) => r.field));
  for (const r of ordered) assert.ok(!("score" in r) && !("rank" in r) && !("weight" in r));
});

// ---- Negative rule: exclusions actually exclude, and are reported distinctly ----

test("negative rule: a stated exclusion overrides an otherwise-qualifying match", () => {
  const result = explainMatch({
    record: qualifyingRecord({ short_title: "Playground reconstruction with asbestos abatement" }),
    preferences: fullPreferencesInput(),
  });
  assert.equal(result.eligible, false);
  assert.ok(result.excluded_by);
  assert.equal(result.excluded_by.field, "exclusions.keywords");
  assert.match(result.excluded_by.wording, /asbestos/);
});

test("negative rule: an excluded agency sets excluded_by even when every other field is satisfied", () => {
  const prefs = normalizePreferenceSet({ exclusions: { agencies: ["Department of Parks and Recreation"] } });
  const result = explainMatch({ record: qualifyingRecord(), preferences: prefs });
  assert.equal(result.eligible, false);
  assert.equal(result.excluded_by.field, "exclusions.agencies");
});

test("negative rule: explainMatch never emits a bid/no-bid strategic recommendation", () => {
  const result = explainMatch({ record: qualifyingRecord(), preferences: fullPreferencesInput() });
  const json = JSON.stringify(result);
  assert.doesNotMatch(json, /should bid/i);
  assert.doesNotMatch(json, /no-bid/i);
  assert.doesNotMatch(json, /recommend/i);
  assert.ok(!("recommendation" in result) && !("bid_decision" in result));
});

// ---- Validation errors are named per field, and never silently drop a stated value ----

test("normalizePreferenceSet: an inverted amount range is preserved with a named error, not dropped", () => {
  const prefs = normalizePreferenceSet({ minAmount: 900000, maxAmount: 100000 });
  assert.equal(prefs.min_amount, 900000);
  assert.equal(prefs.max_amount, 100000);
  assert.ok(prefs.errors.some((e) => e.field === "minAmount" && /exceeds/.test(e.message)));
});

test("normalizePreferenceSet: a malformed closing-horizon date is preserved verbatim with a named error", () => {
  const prefs = normalizePreferenceSet({ closingHorizon: { notBefore: "not-a-date" } });
  assert.equal(prefs.closing_horizon.not_before, "not-a-date");
  assert.ok(prefs.errors.some((e) => e.field === "closingHorizon.notBefore"));
  // An unparseable date must never be usable to exclude a record.
  const result = explainMatch({ record: qualifyingRecord(), preferences: prefs });
  assert.equal(result.reasons.find((r) => r.field === "closing_horizon"), undefined);
});

test("normalizePreferenceSet: a non-boolean certificationInterest is flagged, not coerced", () => {
  const prefs = normalizePreferenceSet({ certificationInterest: "yes" });
  assert.equal(prefs.certification_interest, null);
  assert.ok(prefs.errors.some((e) => e.field === "certificationInterest"));
});

// ---- Capability keywords reuse the exact-token keyword matcher ----

test("capability keywords: exact-token match, not infix", () => {
  const matchResult = explainMatch({
    record: qualifyingRecord({ short_title: "Rat abatement services", additional_description_1: "" }),
    preferences: { capabilityKeywords: ["rat"] },
  });
  assert.equal(matchResult.reasons[0].satisfied, true);

  const noInfixResult = explainMatch({
    record: qualifyingRecord({ short_title: "Strategic integration services", additional_description_1: "" }),
    preferences: { capabilityKeywords: ["rat"] },
  });
  assert.equal(noInfixResult.reasons[0].satisfied, false);
});

// ---- Closing horizon window ----

test("closing horizon: a due date within the stated window is satisfied", () => {
  const result = explainMatch({
    record: qualifyingRecord({ due_date: "2026-08-01" }),
    preferences: { closingHorizon: { notBefore: "2026-07-01", notAfter: "2026-09-01" } },
  });
  assert.equal(result.reasons[0].satisfied, true);
});

test("closing horizon: a due date outside the stated window is not satisfied", () => {
  const result = explainMatch({
    record: qualifyingRecord({ due_date: "2026-12-01" }),
    preferences: { closingHorizon: { notBefore: "2026-07-01", notAfter: "2026-09-01" } },
  });
  assert.equal(result.reasons[0].satisfied, false);
  assert.equal(result.eligible, false);
});
