/**
 * NOE differentiators: interface preference, body parse, corpus boilerplate vs
 * distinctive, exemplar cards (police / caseworker / automotive), filters.
 *
 *   node --test test/noe_differentiators.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { SITE_SOURCE } from "./helpers/site_source.mjs";
import {
  parseNoeDifferentiators,
  classifyCorpusBoilerplate,
  applyNoeDifferentiatorRecord,
  examMatchesDifferentiatorFilters,
  salaryBandFor,
  feeLevelFor,
  examFormatFromOasysParts,
} from "../worker/src/lib/noe_differentiators.mjs";

const require = createRequire(import.meta.url);
const Staffing = require("../site/staffing.js");

const densify = JSON.parse(
  readFileSync(new URL("../site/data/exam_sources/noe_differentiators.json", import.meta.url)),
);
const artifact = JSON.parse(
  readFileSync(new URL("../site/data/staffing_exams.json", import.meta.url)),
);
const receipt = JSON.parse(
  readFileSync(
    new URL("../site/data/exam_sources/verification_receipts/noe_differentiators_latest.json", import.meta.url),
  ),
);

function fixtureText(examId) {
  return readFileSync(
    new URL(`../site/data/exam_sources/fixtures/noe_text/examId_${examId}.txt`, import.meta.url),
    "utf8",
  );
}

test("interface choice is documented: Open Data has no NOE body; OASys JSON + HTML densify", () => {
  assert.equal(densify.source.id, "dcas-noe-differentiators");
  assert.match(densify.source.interface_choice, /GetActiveExams/i);
  assert.match(densify.source.interface_choice, /NOE HTML/i);
  assert.ok(Array.isArray(densify.source.open_data_checked));
  assert.ok(
    densify.source.open_data_checked.every((row) => row.noe_body === false),
    "Open Data rows must declare no NOE body",
  );
  assert.equal(densify.densify_policy.no_live_fetch_at_render, true);
  assert.equal(densify.densify_policy.precompute_first, true);
  assert.ok(densify.records.length >= 3);
  assert.ok(densify.corpus?.boilerplate_fields || densify.corpus?.distinctive_fields);
});

test("OASys examParts map EEE and MC without inventing formats", () => {
  assert.equal(examFormatFromOasysParts([{ partTypeCode: "EEE" }]).exam_format, "education_experience");
  assert.equal(examFormatFromOasysParts([{ partTypeCode: "MC" }]).exam_format, "multiple_choice");
  assert.equal(
    examFormatFromOasysParts([{ partTypeCode: "EEE" }, { partTypeCode: "MC" }]).exam_format,
    "mixed",
  );
  assert.equal(examFormatFromOasysParts([]).exam_format, null);
});

test("parser extracts differentiators from live-shaped NOE text fixtures", () => {
  const auto = parseNoeDifferentiators(fixtureText("9628"), {
    examParts: [{ partTypeCode: "EEE" }],
    oasys_exam_id: "9628",
    source_url: "https://a856-exams.nyc.gov/OASysWeb/noe?examId=9628",
  });
  assert.equal(auto.fee, 61);
  assert.equal(auto.salary_min, 42387);
  assert.equal(auto.exam_format, "education_experience");
  assert.equal(auto.no_experience_required, false);
  assert.match(auto.qualifications, /automotive|experience/i);
  assert.ok(auto.provenance.fee);
  assert.ok(auto.provenance.qualifications);

  const caseworker = parseNoeDifferentiators(fixtureText("9629"), {
    examParts: [{ partTypeCode: "EEE" }],
    oasys_exam_id: "9629",
  });
  assert.equal(caseworker.fee, 68);
  assert.equal(caseworker.salary_min, 48206);
  assert.equal(caseworker.exam_format, "education_experience");
  assert.equal(caseworker.no_experience_required, true);
  assert.match(caseworker.qualifications, /baccalaureate|bachelor/i);
  assert.equal(caseworker.residency_required, false);

  const police = parseNoeDifferentiators(fixtureText("9646"), {
    examParts: [{ partTypeCode: "MC" }],
    oasys_exam_id: "9646",
  });
  assert.equal(police.fee, 0);
  assert.equal(police.salary_min, 55942);
  assert.equal(police.salary_max, 109352);
  assert.equal(police.exam_format, "multiple_choice");
  assert.equal(police.residency_required, true);
  assert.match(police.test_method, /multiple/i);
});

test("corpus frequency classifies shared fee-waiver boilerplate vs distinctive format", () => {
  const corpus = classifyCorpusBoilerplate(densify.records);
  assert.ok(corpus.field_stats.exam_format);
  // Across active exams, EEE is common but MC (police) must still lead as distinctive when minority.
  const policeLeads = corpus.per_record_leads["7312"] || [];
  assert.ok(
    policeLeads.some((lead) => lead.key === "exam_format" && lead.value === "multiple_choice")
      || densify.records.find((r) => r.exam_number === "7312")?.exam_format === "multiple_choice",
    "police must remain format-distinct",
  );
});

test("staffing artifact stamps exemplar differentiators (precompute-first)", () => {
  assert.ok(Number(artifact.schema_version) >= 5);
  const by = Object.fromEntries(artifact.exams.map((e) => [e.exam_number, e]));

  const auto = by["7013"];
  const caseworker = by["7016"];
  const police = by["7312"];
  assert.ok(auto && caseworker && police);

  assert.equal(auto.fee, 61);
  assert.equal(auto.salary_min, 42387);
  assert.equal(auto.exam_format, "education_experience");
  assert.equal(auto.no_experience_required, false);
  assert.equal(auto.salary_band, "under_45k");
  assert.equal(auto.fee_level, "mid");
  assert.match(String(auto.qualifications || ""), /automotive|experience|trade/i);

  assert.equal(caseworker.fee, 68);
  assert.equal(caseworker.salary_min, 48206);
  assert.equal(caseworker.exam_format, "education_experience");
  assert.equal(caseworker.no_experience_required, true);
  assert.equal(caseworker.salary_band, "45k_60k");
  assert.equal(caseworker.fee_level, "mid");
  assert.match(String(caseworker.qualifications || ""), /bachelor|baccalaureate/i);

  assert.equal(police.fee, 0);
  assert.equal(police.salary_min, 55942);
  assert.equal(police.salary_max, 109352);
  assert.equal(police.exam_format, "multiple_choice");
  assert.equal(police.fee_level, "none");
  assert.equal(police.salary_band, "45k_60k");
  assert.equal(police.residency_required, true);

  // Three cards must differ on format/fee/quals — not identical apply-by stubs.
  assert.notEqual(auto.exam_format, police.exam_format);
  assert.notEqual(auto.fee, police.fee);
  assert.notEqual(auto.no_experience_required, caseworker.no_experience_required);
  assert.notEqual(
    String(auto.qualifications || "").slice(0, 40),
    String(caseworker.qualifications || "").slice(0, 40),
  );
});

test("filters: salary band, fee level, format, no-experience", () => {
  const today = "2026-08-03";
  const all = artifact.exams;

  const mc = Staffing.filterExams(all, {
    query: "", interest: "all", eligibility: "all", window: "all", format: "multiple_choice",
  }, today);
  assert.ok(mc.some((e) => e.exam_number === "7312"));
  assert.ok(mc.every((e) => e.exam_format === "multiple_choice"));

  const noFee = Staffing.filterExams(all, {
    query: "", interest: "all", eligibility: "all", window: "all", fee_level: "none",
  }, today);
  assert.ok(noFee.some((e) => e.exam_number === "7312"));
  assert.ok(noFee.every((e) => e.fee === 0 || e.fee_level === "none"));

  const under45 = Staffing.filterExams(all, {
    query: "", interest: "all", eligibility: "all", window: "all", salary_band: "under_45k",
  }, today);
  assert.ok(under45.some((e) => e.exam_number === "7013"));
  assert.ok(under45.every((e) => salaryBandFor(e.salary_min) === "under_45k" || e.salary_band === "under_45k"));

  const noExp = Staffing.filterExams(all, {
    query: "", interest: "all", eligibility: "all", window: "all", no_experience: "yes",
  }, today);
  assert.ok(noExp.some((e) => e.exam_number === "7016"));
  assert.ok(noExp.every((e) => e.no_experience_required === true));

  const expReq = Staffing.filterExams(all, {
    query: "", interest: "all", eligibility: "all", window: "all", no_experience: "no",
  }, today);
  assert.ok(expReq.some((e) => e.exam_number === "7013"));
  assert.ok(expReq.every((e) => e.no_experience_required === false));

  assert.equal(feeLevelFor(0), "none");
  assert.equal(feeLevelFor(61), "mid");
  assert.equal(examMatchesDifferentiatorFilters(byExam("7016"), { format: "education_experience" }), true);
  assert.equal(examMatchesDifferentiatorFilters(byExam("7016"), { format: "multiple_choice" }), false);
});

function byExam(n) {
  return artifact.exams.find((e) => e.exam_number === n);
}

test("applyNoeDifferentiatorRecord is fill-only for fee/salary", () => {
  const prior = { exam_number: "7016", fee: 68, salary_min: 48206, sources: ["dcas-open-competitive"] };
  const densifyRow = densify.records.find((r) => r.exam_number === "7016");
  const merged = applyNoeDifferentiatorRecord(prior, densifyRow);
  assert.equal(merged.fee, 68);
  assert.equal(merged.salary_min, 48206);
  assert.equal(merged.exam_format, "education_experience");
  assert.equal(merged.no_experience_required, true);
  assert.ok(merged.sources.includes("dcas-noe-differentiators"));
});

test("UI: differentiator filters and card lead surface exist", () => {
  assert.match(SITE_SOURCE, /id="career-format"/);
  assert.match(SITE_SOURCE, /id="career-salary-band"/);
  assert.match(SITE_SOURCE, /id="career-fee-level"/);
  assert.match(SITE_SOURCE, /id="career-no-experience"/);
  assert.match(SITE_SOURCE, /function careerDiffLeadsHTML/);
  assert.match(SITE_SOURCE, /career-diff-leads/);
  assert.match(SITE_SOURCE, /career-diff-chip/);
  // Collapsed cards show salary + differentiators, not only fee + apply.
  const start = SITE_SOURCE.indexOf("function careerCardHTML(exam)");
  const end = SITE_SOURCE.indexOf("function careerFilters()", start);
  const card = SITE_SOURCE.slice(start, end);
  assert.match(card, /careerDiffLeadsHTML/);
  assert.match(card, /career_starting_salary/);
});

test("receipt captures three exemplar classes", () => {
  assert.ok(receipt.exemplars["7013"]);
  assert.ok(receipt.exemplars["7016"]);
  assert.ok(receipt.exemplars["7312"]);
  assert.equal(receipt.exemplars["7312"].exam_format, "multiple_choice");
  assert.equal(receipt.exemplars["7016"].no_experience_required, true);
  assert.equal(receipt.exemplars["7013"].fee, 61);
});
