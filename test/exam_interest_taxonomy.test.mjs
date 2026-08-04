/**
 * Exam interest-area / series taxonomy — data mapping + pure classifier.
 *
 *   node --test test/exam_interest_taxonomy.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  buildInterestTaxonomyIndex,
  classifyInterest,
  compileTitleRules,
  examWindowStatus,
  interestAreaIds,
  publicInterestAreas,
  validateInterestTaxonomy,
} from "../site/exam_interest_taxonomy.mjs";
import {
  classifyInterest as buildClassifyInterest,
  loadInterestTaxonomy,
  STAFFING_EXAMS_SCHEMA_VERSION,
} from "../tools/build_staffing_exams.mjs";

const require = createRequire(import.meta.url);
const taxonomy = JSON.parse(
  readFileSync(new URL("../site/data/exam_sources/interest_area_taxonomy.json", import.meta.url), "utf8"),
);
const artifact = JSON.parse(
  readFileSync(new URL("../site/data/staffing_exams.json", import.meta.url), "utf8"),
);
const Staffing = require("../site/staffing.js");

test("committed interest taxonomy validates and exposes ordered subscribable areas", () => {
  const check = validateInterestTaxonomy(taxonomy);
  assert.equal(check.ok, true, check.errors?.join("; "));
  const ids = interestAreaIds(taxonomy);
  assert.deepEqual(ids, [
    "public-safety",
    "health-care",
    "engineering-construction",
    "technology-science",
    "community-social-services",
    "administration-finance",
    "trades-operations",
    "other",
  ]);
  const publicAreas = publicInterestAreas(taxonomy);
  assert.equal(publicAreas.length, 8);
  assert.ok(publicAreas.every((area) => area.id && area.label));
  assert.equal(publicAreas.find((a) => a.id === "other")?.subscribable, false);
  assert.ok(publicAreas.find((a) => a.id === "public-safety")?.subscribable);
});

test("title rules tag public safety, trades, admin, and social-service field cases", () => {
  const rules = compileTitleRules(taxonomy);
  assert.ok(rules.length >= 7);
  assert.equal(classifyInterest("Police Officer", taxonomy, { compiledRules: rules }), "public-safety");
  assert.equal(classifyInterest("Traffic Enforcement Agent", taxonomy, { compiledRules: rules }), "public-safety");
  assert.equal(classifyInterest("Associate Fingerprint Technician", taxonomy, { compiledRules: rules }), "public-safety");
  assert.equal(classifyInterest({ title: "Automotive Service Worker", exam_number: "6028" }, taxonomy, { compiledRules: rules }), "trades-operations");
  assert.equal(classifyInterest("Electrician's Helper", taxonomy, { compiledRules: rules }), "trades-operations");
  assert.equal(classifyInterest("Call Center Representative", taxonomy, { compiledRules: rules }), "administration-finance");
  assert.equal(classifyInterest("Procurement Analyst", taxonomy, { compiledRules: rules }), "administration-finance");
  assert.equal(classifyInterest("Caseworker", taxonomy, { compiledRules: rules }), "community-social-services");
  assert.equal(classifyInterest("Eligibility Specialist", taxonomy, { compiledRules: rules }), "community-social-services");
  assert.equal(classifyInterest("Occupational Therapist (DOE)", taxonomy, { compiledRules: rules }), "health-care");
  assert.equal(classifyInterest("Civil Engineer", taxonomy, { compiledRules: rules }), "engineering-construction");
  assert.equal(classifyInterest("Computer Specialist", taxonomy, { compiledRules: rules }), "technology-science");
});

test("exam_number and title_code overrides beat title rules", () => {
  const custom = {
    ...taxonomy,
    exam_overrides: { "9999": "technology-science" },
    title_code_overrides: { "12345": "health-care" },
  };
  assert.equal(
    classifyInterest({ exam_number: "9999", title: "Police Officer" }, custom),
    "technology-science",
  );
  assert.equal(
    classifyInterest({ exam_number: "1000", title_code: "12345", title: "Police Officer" }, custom),
    "health-care",
  );
});

test("buildInterestTaxonomyIndex exposes per-area exam lists with open-window state", () => {
  const today = "2026-07-28";
  const exams = [
    {
      exam_number: "7016",
      title: "Caseworker",
      interest_area: "community-social-services",
      application_start: "2026-07-01",
      application_end: "2026-08-25",
      schedule_status: "scheduled",
    },
    {
      exam_number: "7312",
      title: "Police Officer",
      interest_area: "public-safety",
      application_start: "2026-09-01",
      application_end: "2026-09-14",
      schedule_status: "scheduled",
    },
    {
      exam_number: "9998",
      title: "Walk-in Clerk",
      interest_area: "administration-finance",
      application_mode: "walk-in",
      schedule_status: "scheduled",
    },
  ];
  const index = buildInterestTaxonomyIndex(exams, taxonomy, today);
  assert.equal(index.alerts_surface, "separate_gated_card");
  assert.equal(index.mapping_source, "exam_sources/interest_area_taxonomy.json");
  assert.equal(index.by_area["community-social-services"].open_count, 1);
  assert.deepEqual(index.by_area["community-social-services"].open_exam_numbers, ["7016"]);
  assert.equal(index.by_area["public-safety"].upcoming_count, 1);
  assert.deepEqual(index.by_area["public-safety"].upcoming_exam_numbers, ["7312"]);
  assert.equal(index.by_area["administration-finance"].continuous_count, 1);
  assert.ok(index.by_area["administration-finance"].actionable_count >= 1);
  assert.equal(examWindowStatus(exams[0], today), "open");
  assert.equal(examWindowStatus(exams[1], today), "upcoming");
});

test("staffing artifact carries taxonomy index and every exam is tagged", () => {
  assert.equal(artifact.schema_version, STAFFING_EXAMS_SCHEMA_VERSION);
  assert.ok(artifact.interest_taxonomy);
  assert.equal(artifact.interest_taxonomy.alerts_surface, "separate_gated_card");
  assert.ok(Array.isArray(artifact.interest_taxonomy.areas));
  assert.ok(artifact.interest_taxonomy.by_area);
  assert.deepEqual(artifact.interest_areas, interestAreaIds(taxonomy));
  loadInterestTaxonomy(taxonomy);
  for (const exam of artifact.exams) {
    assert.ok(exam.interest_area, exam.exam_number);
    assert.ok(Staffing.isInterestArea(exam.interest_area), exam.exam_number);
    assert.equal(
      exam.interest_area,
      buildClassifyInterest(exam, taxonomy),
      `${exam.exam_number} ${exam.title} should match classifier`,
    );
    const bucket = artifact.interest_taxonomy.by_area[exam.interest_area];
    assert.ok(bucket, exam.interest_area);
    assert.ok(bucket.exam_numbers.includes(exam.exam_number), exam.exam_number);
  }
  // Improved rules should reclaim high-volume titles that previously fell to other.
  const traffic = artifact.exams.filter((e) => /traffic enforcement/i.test(e.title));
  assert.ok(traffic.length >= 1);
  assert.ok(traffic.every((e) => e.interest_area === "public-safety"));
  const auto = artifact.exams.find((e) => e.exam_number === "7013" || /automotive service/i.test(e.title));
  if (auto) assert.equal(auto.interest_area, "trades-operations");
  assert.ok(
    artifact.interest_taxonomy.summary.tagged_non_other
      > artifact.exams.filter((e) => e.interest_area === "other").length,
    "most exams should land in a named series",
  );
});
