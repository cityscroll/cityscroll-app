/**
 * Exams browse: Interest Area multi-select (OR) + strengthened
 * "Anyone who qualifies" public eligibility.
 *
 * Interest counts basis: under_current_filter (other active filters applied;
 * interest selection itself excluded from the denominator).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { eligibilityFor } from "../tools/build_staffing_exams.mjs";
import {
  examFacetHref,
  serializeExamInterestParam,
} from "../site/exam_detail_facets.mjs";
import { SITE_SOURCE } from "./helpers/site_source.mjs";

const require = createRequire(import.meta.url);
const Staffing = require("../site/staffing.js");
const artifact = JSON.parse(
  readFileSync(new URL("../site/data/staffing_exams.json", import.meta.url), "utf8"),
);

const TODAY = "2026-08-02";
const FIXTURE = Object.freeze([
  {
    exam_number: "1001",
    title: "Public Health Nurse",
    interest_area: "health-care",
    eligibility: "open_competitive",
    application_start: "2026-07-01",
    application_end: "2026-09-01",
  },
  {
    exam_number: "1002",
    title: "Computer Specialist",
    interest_area: "technology-science",
    eligibility: "open_competitive",
    application_start: "2026-07-01",
    application_end: "2026-09-01",
  },
  {
    exam_number: "1003",
    title: "Police Officer",
    interest_area: "public-safety",
    eligibility: "open_competitive",
    application_start: "2026-07-01",
    application_end: "2026-09-01",
  },
  {
    exam_number: "1004",
    title: "Health Services Manager (Prom)",
    interest_area: "health-care",
    eligibility: "promotion",
    application_start: "2026-07-01",
    application_end: "2026-09-01",
  },
  {
    exam_number: "1005",
    title: "Ambiguous Eligibility Role",
    interest_area: "technology-science",
    eligibility: "unknown",
    application_start: "2026-07-01",
    application_end: "2026-09-01",
  },
  {
    exam_number: "1006",
    title: "Multi-tagged Analyst",
    interest_area: "administration-finance",
    interest_areas: ["administration-finance", "technology-science"],
    eligibility: "open_competitive",
    application_start: "2026-07-01",
    application_end: "2026-09-01",
  },
]);

test("1. single interest selection is unchanged", () => {
  const rows = Staffing.filterExams(FIXTURE, {
    interest: "health-care",
    eligibility: "all",
    window: "all",
  }, TODAY);
  assert.deepEqual(rows.map((exam) => exam.exam_number).sort(), ["1001", "1004"]);
  assert.ok(rows.every((exam) => exam.interest_area === "health-care"
    || Staffing.examInterestAreas(exam).includes("health-care")));
});

test("2. two interest areas are selectable at once (normalized + serialized)", () => {
  const a = Staffing.normalizeInterestSelection(["technology-science", "health-care"]);
  const b = Staffing.normalizeInterestSelection("health-care,technology-science");
  assert.deepEqual(a, ["health-care", "technology-science"]);
  assert.deepEqual(b, a);
  assert.equal(Staffing.serializeInterestSelection(a), "health-care,technology-science");
  assert.equal(serializeExamInterestParam(["technology-science", "health-care"]), "health-care,technology-science");
});

test("3. Health + Technology returns the UNION (OR), not intersection", () => {
  const rows = Staffing.filterExams(FIXTURE, {
    interest: "health-care,technology-science",
    eligibility: "all",
    window: "all",
  }, TODAY);
  const ids = rows.map((exam) => exam.exam_number).sort();
  assert.deepEqual(ids, ["1001", "1002", "1004", "1005", "1006"]);
  assert.ok(!ids.includes("1003"), "public-safety alone must stay out of the union");
});

test("4. removing one interest keeps the other", () => {
  const selected = Staffing.normalizeInterestSelection("health-care,technology-science");
  const afterRemove = selected.filter((area) => area !== "health-care");
  assert.deepEqual(afterRemove, ["technology-science"]);
  const rows = Staffing.filterExams(FIXTURE, {
    interests: afterRemove,
    eligibility: "all",
    window: "all",
  }, TODAY);
  assert.deepEqual(rows.map((exam) => exam.exam_number).sort(), ["1002", "1005", "1006"]);
});

test("5. All interests clears specific selections", () => {
  assert.deepEqual(Staffing.normalizeInterestSelection("all"), []);
  assert.deepEqual(Staffing.normalizeInterestSelection(""), []);
  assert.equal(Staffing.serializeInterestSelection([]), "");
  const rows = Staffing.filterExams(FIXTURE, {
    interest: "all",
    eligibility: "all",
    window: "all",
  }, TODAY);
  assert.equal(rows.length, FIXTURE.length);
});

test("6. Anyone who qualifies combines with multiple interests", () => {
  const rows = Staffing.filterExams(FIXTURE, {
    interest: "health-care,technology-science",
    eligibility: "open_competitive",
    window: "all",
  }, TODAY);
  assert.deepEqual(rows.map((exam) => exam.exam_number).sort(), ["1001", "1002", "1006"]);
  assert.ok(rows.every((exam) => Staffing.isPublicEligibility(exam)));
});

test("7. public eligibility EXCLUDES internal / promotional-only exams", () => {
  const publicRows = Staffing.filterExams(FIXTURE, {
    interest: "all",
    eligibility: "open_competitive",
    window: "all",
  }, TODAY);
  assert.ok(publicRows.every((exam) => exam.eligibility === "open_competitive"));
  assert.ok(!publicRows.some((exam) => exam.exam_number === "1004"));
  assert.equal(eligibilityFor({
    open_competitive_promotion: "Promotion",
    exam_title: "Supervisor",
  }), "promotion");
  assert.equal(eligibilityFor({
    open_competitive_promotion: "City employees only",
    exam_title: "Clerk",
  }), "promotion");
  assert.equal(eligibilityFor({
    open_competitive_promotion: "",
    exam_title: "Housing Manager (Prom)",
  }), "promotion");

  // Live corpus: promotional rows never pass the public filter.
  const livePublic = Staffing.filterExams(artifact.exams, {
    interest: "all",
    eligibility: "open_competitive",
    window: "all",
  }, TODAY);
  assert.ok(livePublic.length > 0);
  assert.ok(livePublic.every((exam) => Staffing.isPublicEligibility(exam)));
  assert.ok(!livePublic.some((exam) => exam.eligibility === "promotion"));
  assert.ok(!livePublic.some((exam) => /\(prom\)/i.test(exam.title || "")));
});

test("8. ambiguous eligibility is NOT silently treated as public", () => {
  assert.equal(eligibilityFor({
    open_competitive_promotion: "",
    exam_title: "Untitled Role",
  }), "unknown");
  assert.equal(eligibilityFor({
    open_competitive_promotion: "See notice",
    exam_title: "Special Assignment",
  }), "unknown");
  assert.equal(Staffing.isPublicEligibility({
    eligibility: "unknown",
    title: "Ambiguous Eligibility Role",
  }), false);
  const rows = Staffing.filterExams(FIXTURE, {
    eligibility: "open_competitive",
    window: "all",
  }, TODAY);
  assert.ok(!rows.some((exam) => exam.exam_number === "1005"));
});

test("9. multi-interest survives URL round-trip serialization", () => {
  const href = examFacetHref({
    interests: ["technology-science", "health-care"],
    eligibility: "open_competitive",
    window: "actionable",
  }, "interest", ["health-care", "technology-science"]);
  assert.match(href, /\/browse\/exams\/\?/);
  assert.match(href, /interest=health-care%2Ctechnology-science|interest=health-care,technology-science/);
  // Default open_competitive may be omitted; explicit non-default still serializes.
  const promoHref = examFacetHref({
    interests: ["health-care", "technology-science"],
    eligibility: "promotion",
  }, "eligibility", "promotion");
  assert.match(promoHref, /eligibility=promotion/);
  assert.match(promoHref, /interest=health-care/);
});

test("10. existing single-interest URLs stay backward-compatible", () => {
  const href = examFacetHref({
    interest: "technology-science",
    eligibility: "open_competitive",
  }, "interest", "technology-science");
  assert.match(href, /interest=technology-science/);
  assert.doesNotMatch(href, /interest=.*,/);
  const rows = Staffing.filterExams(artifact.exams, {
    interest: "technology-science",
    eligibility: "open_competitive",
    window: "all",
  }, TODAY);
  assert.ok(rows.every((exam) => Staffing.examInterestAreas(exam).includes("technology-science")));
});

test("11. Follow/share filter state retains multi-interest + eligibility facets", () => {
  const interests = Staffing.normalizeInterestSelection("health-care,technology-science");
  const share = {
    view: "guide",
    interest: Staffing.serializeInterestSelection(interests),
    interests,
    interestArea: interests[0],
    eligibility: "open_competitive",
    window: "actionable",
  };
  assert.deepEqual(share.interests, ["health-care", "technology-science"]);
  assert.equal(share.interest, "health-care,technology-science");
  assert.equal(share.eligibility, "open_competitive");
  // Example shareable URL combining Health + Technology + Anyone who qualifies.
  const example = `/browse/exams/?interest=${encodeURIComponent(share.interest)}&eligibility=open_competitive`;
  assert.equal(
    example,
    "/browse/exams/?interest=health-care%2Ctechnology-science&eligibility=open_competitive",
  );
});

test("12. keyboard/a11y: interest multi-select uses pressed chips + removable strip hooks", () => {
  assert.match(SITE_SOURCE, /id="career-interest-facets"[^>]*role="group"/);
  assert.match(SITE_SOURCE, /id="career-eligibility-facets"[^>]*role="group"/);
  assert.match(SITE_SOURCE, /data-interest-counts-basis="under_current_filter"/);
  assert.match(SITE_SOURCE, /career-interest-multi/);
  assert.match(SITE_SOURCE, /career-primary-facet/);
  // Who can apply + Interest are primary rails (not buried only in More filters).
  const exams = SITE_SOURCE.slice(
    SITE_SOURCE.indexOf('id="tab-exams"'),
    SITE_SOURCE.indexOf('id="tab-alerts"'),
  );
  const more = exams.slice(
    exams.indexOf('id="staffing-more-filters"'),
    exams.indexOf("</details>", exams.indexOf('id="staffing-more-filters"')),
  );
  assert.doesNotMatch(more, /id="career-interest-facets"/);
  assert.doesNotMatch(more, /id="career-eligibility-facets"/);
  assert.match(exams, /id="career-eligibility-facets"[^>]*lens-primary-rail/);
  assert.match(exams, /id="career-interest-facets"[^>]*lens-primary-rail/);
  // Removable selected chips + filterChip aria-pressed grammar.
  assert.match(SITE_SOURCE, /data-remove-filter/);
  assert.match(SITE_SOURCE, /qchip-remove/);
  assert.match(SITE_SOURCE, /aria-pressed/);
  assert.match(SITE_SOURCE, /CAREER_INTEREST_COUNTS_BASIS/);
});
