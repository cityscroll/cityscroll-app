import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  ARTICLE78_COVERAGE_GRADES,
  ARTICLE78_DOCKET_DETAIL_FIELDS,
  ARTICLE78_SEARCHABLE_SYSTEMS,
  buildSearchCoverageRecord,
  challengeWatchValue,
  validateArticle78Record,
} from "../warehouse/lib/article78_litigation.mjs";
import { loadHistoricalFixture } from "../warehouse/lib/article78_historical_fixture.mjs";
import {
  admitNegatives,
  ARTICLE78_ELIGIBLE_DENOMINATOR_SCHEMA,
  ARTICLE78_SEARCH_COVERAGE_SCHEMA,
  Article78SearchCoverageError,
  assertBoundedSearchReceipts,
  assertDerivedDenominator,
  COVERAGE_GRADE_POLICY,
  coverageGradeFor,
  eligibleDenominator,
  findBoundedSearchReceiptGaps,
  gradeCoverage,
  mergeSearchedIntervals,
  OFFICIAL_REPORTS_DENOMINATOR_WARNING,
} from "../warehouse/lib/article78_search_coverage.mjs";

const FIXTURE = loadHistoricalFixture();

function determinationByGrade(grade) {
  const row = FIXTURE.clean.determinations.find((determination) => (
    coverageGradeFor({ determination, receipts: FIXTURE.clean.coverage }) === grade
  ));
  assert.ok(row, `the historical fixture must carry at least one grade ${grade} determination`);
  return row;
}

function receiptsFor(determination) {
  return FIXTURE.clean.coverage.filter((receipt) => (
    receipt.determination_key === determination.determination_key
    || (receipt.scope?.determination_filters ?? []).includes(determination.determination_key)
  ));
}

/** Every determination in the fixture, paired with the whole receipt pool. */
function allEntries() {
  return FIXTURE.clean.determinations.map((determination) => ({ determination, receipts: FIXTURE.clean.coverage }));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

describe("A78-03 court-search coverage grading (A1, A2, A3, A4, negative rule)", () => {
  it("A1: every determination carries a grade, with the identifiers and horizon that produced it", () => {
    const graded = allEntries().map((entry) => gradeCoverage(entry));
    assert.equal(graded.length, FIXTURE.clean.determinations.length);
    for (const row of graded) {
      assert.equal(row.schema, ARTICLE78_SEARCH_COVERAGE_SCHEMA);
      assert.ok(ARTICLE78_COVERAGE_GRADES.includes(row.grade), `grade ${row.grade} must be one of A/B/C/U`);
      assert.equal(typeof row.receipts_considered, "number");
      assert.ok(Array.isArray(row.identifiers_used));
      assert.ok(Array.isArray(row.systems_searched));
      assert.ok(Array.isArray(row.variants_tried));
      assert.ok(Array.isArray(row.docket_details_unavailable));
      assert.ok("limitations_window" in row.horizon);
      assert.ok("spans_limitations_window" in row.horizon);
      assert.ok(row.reasons.length > 0, `grade ${row.grade} must say what produced it`);
      assert.ok(row.reasons.some((reason) => reason.startsWith(`${row.grade}:`)), "the reasons must name the grade that was awarded");
    }
  });

  it("A1: the fixture exercises the whole ladder -- at least one A, B, C and U", () => {
    const grades = allEntries().map((entry) => gradeCoverage(entry).grade);
    for (const grade of ARTICLE78_COVERAGE_GRADES) {
      assert.ok(grades.includes(grade), `the historical fixture must exercise grade ${grade}`);
    }
  });

  it("A1: grading is deterministic -- the same receipts produce the same grade, in any order", () => {
    const determination = determinationByGrade("A");
    const receipts = FIXTURE.clean.coverage;
    const first = gradeCoverage({ determination, receipts });
    const again = gradeCoverage({ determination, receipts });
    const reversed = gradeCoverage({ determination, receipts: [...receipts].reverse() });
    assert.deepEqual(again, first);
    assert.deepEqual(reversed, first);
  });

  it("A1: every threshold the grader applies lives in one exported, frozen policy object", () => {
    assert.ok(Object.isFrozen(COVERAGE_GRADE_POLICY));
    assert.equal(typeof COVERAGE_GRADE_POLICY.horizon.documented_margin_days, "number");
    assert.equal(typeof COVERAGE_GRADE_POLICY.systems_thresholds.multiple_systems_minimum, "number");
    assert.deepEqual(COVERAGE_GRADE_POLICY.grade_rules.map((rule) => rule.grade), ["A", "B", "C", "U"]);
    // The grading source may name a threshold, but must not restate one: every
    // numeric comparison goes through the policy object above.
    const source = readFileSync(new URL("../warehouse/lib/article78_search_coverage.mjs", import.meta.url), "utf8");
    const body = source.slice(source.indexOf("const COVERAGE_PREDICATES"));
    assert.equal(body.match(/>=\s*\d/g), null, "a predicate must compare against the policy, not against a literal");
  });

  it("A1: grade A needs a docket search as well as an opinion search", () => {
    const determination = determinationByGrade("A");
    const receipts = clone(receiptsFor(determination));
    assert.equal(gradeCoverage({ determination, receipts }).grade, "A");

    // Published opinions alone: the same window, the same identifiers, and the
    // top grade is out of reach, because a proceeding that never produced a
    // written opinion could not have shown up.
    const opinionOnly = receipts.map((receipt) => ({
      ...receipt,
      systems_searched: [{ system: "official_reports" }],
      docket_details_unavailable: [...ARTICLE78_DOCKET_DETAIL_FIELDS],
    }));
    const downgraded = gradeCoverage({ determination, receipts: opinionOnly });
    assert.notEqual(downgraded.grade, "A");
    assert.ok(downgraded.reasons.some((reason) => reason.includes("no docket system was searched")));
  });

  it("A1: a truncated horizon cannot reach grade A, however good the identifiers", () => {
    const determination = determinationByGrade("A");
    const receipts = clone(receiptsFor(determination));
    // Rebuilt rather than edited in place: narrowing the scope changes the
    // query hash, and A78-01 refuses a receipt whose key does not follow from
    // its own bounds.
    const narrowed = receipts.map((receipt) => buildSearchCoverageRecord({
      determinationKey: receipt.determination_key,
      source: receipt.source,
      scope: { ...receipt.scope, date_window: { from: receipt.scope.date_window.from, to: receipt.scope.date_window.from } },
      searchedAt: receipt.searched_at,
      resultCount: 0,
      coverageGrade: receipt.coverage_grade,
      coverageNote: receipt.coverage_note,
      systemsSearched: receipt.systems_searched,
      variantsTried: receipt.variants_tried,
      docketDetailsUnavailable: receipt.docket_details_unavailable,
      observedAt: receipt.observed_at,
      sourceId: receipt.source_id,
      sourceRecordId: receipt.source_record_id,
    }));
    const graded = gradeCoverage({ determination, receipts: narrowed });
    assert.notEqual(graded.grade, "A");
    assert.ok(graded.reasons.some((reason) => reason.includes("does not contiguously span the limitations window")));
  });

  it("A1: separate searches with a gap between them do not cover the gap", () => {
    assert.deepEqual(
      mergeSearchedIntervals([{ from: "2024-01-01", to: "2024-01-31" }, { from: "2024-02-01", to: "2024-02-29" }]),
      [{ from: "2024-01-01", to: "2024-02-29" }],
    );
    assert.deepEqual(
      mergeSearchedIntervals([{ from: "2024-01-01", to: "2024-01-31" }, { from: "2024-03-01", to: "2024-03-31" }]),
      [{ from: "2024-01-01", to: "2024-01-31" }, { from: "2024-03-01", to: "2024-03-31" }],
    );
  });

  it("A2: every fixture receipt records its systems, its variants and the docket details it could not see", () => {
    assertBoundedSearchReceipts(FIXTURE.clean.coverage, "historical fixture coverage");
    for (const receipt of FIXTURE.clean.coverage) {
      assert.ok(receipt.systems_searched.length > 0, `${receipt.coverage_key} must name at least one searched system`);
      for (const entry of receipt.systems_searched) {
        assert.ok(ARTICLE78_SEARCHABLE_SYSTEMS.includes(entry.system));
      }
      for (const field of receipt.docket_details_unavailable) {
        assert.ok(ARTICLE78_DOCKET_DETAIL_FIELDS.includes(field));
      }
    }
  });

  it("A2: a receipt that records none of that is reported, and cannot support a grade above C", () => {
    const determination = determinationByGrade("A");
    const bare = clone(receiptsFor(determination)).map((receipt) => {
      const { systems_searched, variants_tried, docket_details_unavailable, ...rest } = receipt;
      return rest;
    });
    assert.deepEqual(findBoundedSearchReceiptGaps(bare[0], "bare").length, 3);
    assert.throws(() => assertBoundedSearchReceipts(bare), Article78SearchCoverageError);
    const graded = gradeCoverage({ determination, receipts: bare });
    assert.equal(graded.grade, "C");
    assert.ok(graded.reasons.some((reason) => reason.includes("no docket system was searched")));
  });

  it("A2: the extension is additive -- a receipt written without it still validates", () => {
    const receipt = clone(FIXTURE.clean.coverage[0]);
    delete receipt.systems_searched;
    delete receipt.variants_tried;
    delete receipt.docket_details_unavailable;
    assert.deepEqual(validateArticle78Record("search_coverage", receipt), []);
  });

  it("A2: the system vocabulary is closed, and an unnamed 'other' system is refused", () => {
    const receipt = clone(FIXTURE.clean.coverage[0]);
    receipt.systems_searched = [{ system: "some_private_docket_service" }];
    assert.ok(validateArticle78Record("search_coverage", receipt).some((finding) => finding.includes("is not one of")));

    receipt.systems_searched = [{ system: "other" }];
    assert.ok(validateArticle78Record("search_coverage", receipt).some((finding) => finding.includes("without a label")));

    receipt.systems_searched = [{ system: "other", label: "a county clerk's paper index, consulted in person" }];
    assert.deepEqual(validateArticle78Record("search_coverage", receipt), []);
  });

  it("A3: only grade A and B negatives are admitted; C and U are excluded and counted", () => {
    const admission = admitNegatives(allEntries());
    assert.deepEqual(admission.admissible_grades, ["A", "B"]);
    for (const row of admission.admitted) assert.ok(["A", "B"].includes(row.grade));
    for (const row of admission.excluded.C) assert.equal(row.grade, "C");
    for (const row of admission.excluded.U) assert.equal(row.grade, "U");

    // The list and the counts are checked separately, because a count that is
    // not the length of the list it claims to describe is exactly the kind of
    // asserted number this card exists to remove.
    assert.equal(admission.counts.admitted, admission.admitted.length);
    assert.equal(admission.counts.excluded_C, admission.excluded.C.length);
    assert.equal(admission.counts.excluded_U, admission.excluded.U.length);
    assert.equal(
      admission.counts.considered,
      admission.counts.admitted + admission.counts.excluded_C + admission.counts.excluded_U,
    );
    assert.ok(admission.counts.excluded_C > 0 && admission.counts.excluded_U > 0);

    const admittedKeys = new Set(admission.admitted.map((row) => row.determination_key));
    for (const row of [...admission.excluded.C, ...admission.excluded.U]) {
      assert.ok(!admittedKeys.has(row.determination_key), "an excluded determination must not also be admitted");
    }
  });

  it("A4: the denominator is derived from recorded grades, and the remainder is reported", () => {
    const denominator = eligibleDenominator(allEntries());
    assert.equal(denominator.schema, ARTICLE78_ELIGIBLE_DENOMINATOR_SCHEMA);
    assert.equal(denominator.derived_from, "recorded_coverage_grades");
    assert.equal(denominator.examined_determination_count, FIXTURE.clean.determinations.length);
    assert.equal(
      denominator.eligible_determination_count,
      denominator.by_grade.A + denominator.by_grade.B,
    );
    assert.equal(denominator.excluded_remainder.count, denominator.by_grade.C + denominator.by_grade.U);
    assert.equal(denominator.note, OFFICIAL_REPORTS_DENOMINATOR_WARNING);
    assertDerivedDenominator(denominator);
  });

  it("A4: changing one receipt's grade changes the denominator and the remainder consistently", () => {
    const before = eligibleDenominator(allEntries());
    const admitted = admitNegatives(allEntries()).admitted[0];
    assert.ok(admitted, "the fixture must admit at least one determination to demote");

    // Mark the only receipt behind one admitted determination unusable. That
    // determination now has no usable search on file, so it drops to U.
    const demoted = FIXTURE.clean.coverage.map((receipt) => (
      admitted.coverage_keys.includes(receipt.coverage_key) ? { ...receipt, coverage_grade: "U" } : receipt
    ));
    const entries = FIXTURE.clean.determinations.map((determination) => ({ determination, receipts: demoted }));
    const after = eligibleDenominator(entries);

    assert.equal(after.examined_determination_count, before.examined_determination_count);
    assert.equal(after.eligible_determination_count, before.eligible_determination_count - 1);
    assert.equal(after.excluded_remainder.count, before.excluded_remainder.count + 1);
    assert.equal(after.excluded_remainder.by_grade.U, before.excluded_remainder.by_grade.U + 1);
    assert.ok(after.excluded_remainder.determination_keys.U.includes(admitted.determination_key));
    assert.ok(!after.eligible_determination_keys.includes(admitted.determination_key));
    assertDerivedDenominator(after);
  });

  it("A4: a denominator can never be asserted as a total", () => {
    assert.throws(() => eligibleDenominator(200), (error) => (
      error instanceof Article78SearchCoverageError && /never an asserted total/.test(error.message)
    ));
    assert.throws(
      () => assertDerivedDenominator({ ...eligibleDenominator(allEntries()), examined_determination_count: 200 }),
      /asserted total wearing a derivation's clothes/,
    );
  });

  it("negative rule: a C or U determination yields null, and the basis names the grade", () => {
    for (const grade of ["C", "U"]) {
      const determination = determinationByGrade(grade);
      const result = challengeWatchValue({
        determination,
        cases: FIXTURE.clean.cases,
        coverage: FIXTURE.clean.coverage,
        coverageGrade: coverageGradeFor({ determination, receipts: FIXTURE.clean.coverage }),
      });
      assert.equal(result.value, null, `a grade ${grade} determination must never produce a number`);
      assert.equal(result.basis.coverage_grade, grade);
    }
  });

  it("negative rule: an adequately searched determination still names the grade behind its number", () => {
    const determination = determinationByGrade("A");
    const result = challengeWatchValue({
      determination,
      cases: FIXTURE.clean.cases,
      coverage: FIXTURE.clean.coverage,
      coverageGrade: "A",
    });
    assert.equal(result.basis.coverage_grade, "A");
    assert.notEqual(result.value, null);
  });

  it("negative rule: an injected C grade overrides a receipt that grades itself countable", () => {
    const determination = determinationByGrade("A");
    const result = challengeWatchValue({
      determination,
      cases: FIXTURE.clean.cases,
      coverage: FIXTURE.clean.coverage,
      coverageGrade: "C",
    });
    assert.equal(result.value, null);
    assert.equal(result.basis.coverage_grade, "C");
  });

  it("negative rule: nothing in this module fetches anything", () => {
    const source = readFileSync(new URL("../warehouse/lib/article78_search_coverage.mjs", import.meta.url), "utf8");
    for (const forbidden of ["fetch(", "node:http", "node:https", "XMLHttpRequest", "child_process", "puppeteer"]) {
      assert.ok(!source.includes(forbidden), `the coverage grader must never ${forbidden}`);
    }
    // Naming a system is a record of what somebody searched, never a
    // capability: no endpoint, host or query template is on file for any of
    // them, and none of them has a documented source contract.
    const contracts = JSON.parse(readFileSync(new URL("../site/data/source_contracts.json", import.meta.url), "utf8"));
    const contractIds = new Set(contracts.contracts.map((contract) => contract.id));
    for (const system of ARTICLE78_SEARCHABLE_SYSTEMS) {
      assert.ok(!contractIds.has(system), `${system} has no documented source contract, so no code may know how to query it`);
    }
  });

  it("gradeCoverage refuses input it cannot grade honestly", () => {
    const determination = determinationByGrade("A");
    assert.throws(() => gradeCoverage({ determination, receipts: "everything" }), Article78SearchCoverageError);
    assert.throws(() => gradeCoverage({ determination: { determination_key: "nope" }, receipts: [] }), Article78SearchCoverageError);
    const broken = clone(receiptsFor(determination));
    broken[0].coverage_grade = "Z";
    assert.throws(() => gradeCoverage({ determination, receipts: broken }), Article78SearchCoverageError);
  });
});
