import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createRequire } from "node:module";

import {
  attachOasysDeepLink,
  buildOasysExamMap,
  isOasysGenericHub,
  isOasysNoeDeepLink,
  materializeOasysMapArtifact,
  normalizeExamNumber,
  oasysNoeUrl,
  resolveExamApplyUrl,
} from "../tools/lib/oasys_exam_map.mjs";
import {
  assessLinkSpecificity,
  collectSpecificityFindings,
  DEEP_LINK_SYSTEMS,
} from "../tools/audit-action-links.mjs";
import { classifyDestinationUrl } from "../ontology/actionability_sample.mjs";

const require = createRequire(import.meta.url);
const Actions = require("../site/action_registry.js");
const staffing = JSON.parse(
  readFileSync(new URL("../site/data/staffing_exams.json", import.meta.url), "utf8"),
);
const oasysMap = JSON.parse(
  readFileSync(new URL("../site/data/exam_sources/oasys_exam_map.json", import.meta.url), "utf8"),
);
const fixtureBody = JSON.parse(
  readFileSync(
    new URL("../site/data/exam_sources/oasys_active_exams_fixture.json", import.meta.url),
    "utf8",
  ),
);

const FIXTURE_ROWS = [
  {
    examId: 9619,
    title: "Emergency Medical Specialist - EMT",
    examNumber: "6125",
    filingStart: "2026-06-15T00:00:00",
    filingEnd: "2026-08-07T00:00:00",
    filingFee: 30,
    isPromotional: false,
    noeUrl: "https://a856-exams.nyc.gov/OASysWeb/noe/20266125000.pdf",
  },
  {
    examId: 9646,
    title: "Police Officer",
    examNumber: "7312",
    filingStart: "2026-08-03T00:00:00",
    filingEnd: "2026-08-17T00:00:00",
    filingFee: 0,
    isPromotional: false,
    noeUrl: "https://a856-exams.nyc.gov/OASysWeb/noe/20277312000.pdf",
  },
];

test("normalizeExamNumber pads short numeric ids", () => {
  assert.equal(normalizeExamNumber("125"), "0125");
  assert.equal(normalizeExamNumber(6125), "6125");
  assert.equal(normalizeExamNumber("Exam 7312"), "7312");
});

test("OASys examId is not the DCAS exam number — map joins on examNumber", () => {
  const built = buildOasysExamMap(FIXTURE_ROWS);
  assert.equal(built.by_exam_number.get("6125").oasys_exam_id, "9619");
  assert.equal(built.by_exam_number.get("7312").oasys_exam_id, "9646");
  assert.notEqual(built.by_exam_number.get("6125").oasys_exam_id, "6125");
  assert.equal(
    built.by_exam_number.get("6125").noe_page_url,
    "https://a856-exams.nyc.gov/OASysWeb/noe?examId=9619",
  );
});

test("isOasysGenericHub covers examsforjobs and OASys lobby paths", () => {
  assert.equal(isOasysGenericHub("https://www.nyc.gov/examsforjobs"), true);
  assert.equal(isOasysGenericHub("https://a856-exams.nyc.gov/OASysWeb/home"), true);
  assert.equal(isOasysGenericHub("https://a856-exams.nyc.gov/OASysWeb/exams"), true);
  assert.equal(isOasysGenericHub("https://a856-exams.nyc.gov/OASysWeb/"), true);
  assert.equal(
    isOasysGenericHub("https://a856-exams.nyc.gov/OASysWeb/noe?examId=9619"),
    false,
  );
});

test("isOasysNoeDeepLink recognizes per-exam NOE pages", () => {
  assert.equal(
    isOasysNoeDeepLink("https://a856-exams.nyc.gov/OASysWeb/noe?examId=9619"),
    true,
  );
  assert.equal(
    isOasysNoeDeepLink("https://a856-exams.nyc.gov/OASysWeb/noe/20266125000.pdf"),
    true,
  );
  assert.equal(isOasysNoeDeepLink("https://www.nyc.gov/examsforjobs"), false);
});

test("attachOasysDeepLink stamps deep URL; unmapped keeps landing", () => {
  const map = buildOasysExamMap(FIXTURE_ROWS).by_exam_number;
  const deep = attachOasysDeepLink(
    { exam_number: "6125", title: "EMT", sources: [] },
    map,
  );
  assert.equal(deep.application_handoff_mode, "deep");
  assert.equal(deep.oasys_exam_id, "9619");
  assert.equal(
    deep.official_application_url,
    "https://a856-exams.nyc.gov/OASysWeb/noe?examId=9619",
  );

  const unmapped = attachOasysDeepLink(
    { exam_number: "9999", title: "No such exam", sources: [] },
    map,
  );
  assert.equal(unmapped.application_handoff_mode, "landing");
  assert.equal(unmapped.official_application_url, "https://www.nyc.gov/examsforjobs");
  assert.equal(unmapped.oasys_exam_id, undefined);
});

test("committed OASys map + staffing artifact deep-link golden exams 6125 and 7312", () => {
  assert.ok(oasysMap.records?.length >= 2);
  for (const num of ["6125", "7312"]) {
    const mapRow = oasysMap.records.find((r) => r.exam_number === num);
    assert.ok(mapRow, `map missing ${num}`);
    const exam = staffing.exams.find((e) => e.exam_number === num);
    assert.ok(exam, `staffing missing ${num}`);
    assert.equal(exam.application_handoff_mode, "deep");
    assert.equal(exam.oasys_exam_id, mapRow.oasys_exam_id);
    assert.equal(exam.official_application_url, mapRow.noe_page_url);
    assert.match(exam.official_application_url, /\/noe\?examId=\d+$/);
    assert.notEqual(exam.oasys_exam_id, num);
    assert.equal(
      Actions.examApplyUrl(exam),
      mapRow.noe_page_url,
    );
    assert.equal(Actions.examApplyIsDeep(Actions.examApplyUrl(exam)), true);
  }
});

test("exam action rail uses deep OASys NOE URL and browse label for landing", () => {
  const deepActions = Actions.compileActionRail({
    kind: "exam",
    lifecycle_stage: "open",
    deadline: "2026-08-20",
    exam_number: "6125",
    oasys_exam_id: "9619",
    official_application_url: "https://a856-exams.nyc.gov/OASysWeb/noe?examId=9619",
  }, { today: "2026-08-03" });
  assert.equal(
    deepActions[0].destination,
    "https://a856-exams.nyc.gov/OASysWeb/noe?examId=9619",
  );
  assert.equal(deepActions[0].guide?.mode, "deep");
  assert.equal(deepActions[0].label_key, "career_apply_oasys");

  const landingActions = Actions.compileActionRail({
    kind: "exam",
    lifecycle_stage: "open",
    deadline: "2026-08-20",
    exam_number: "9999",
    official_application_url: "https://www.nyc.gov/examsforjobs",
  }, { today: "2026-08-03" });
  assert.equal(landingActions[0].destination, "https://www.nyc.gov/examsforjobs");
  assert.equal(landingActions[0].guide?.mode, "landing");
  assert.equal(landingActions[0].label_key, "career_apply_oasys_browse");
  assert.equal(landingActions[0].label, "Browse OASys exams");
});

test("resolveExamApplyUrl prefers oasys_noe_url over landing", () => {
  assert.equal(
    resolveExamApplyUrl({
      official_application_url: "https://www.nyc.gov/examsforjobs",
      oasys_noe_url: "https://a856-exams.nyc.gov/OASysWeb/noe?examId=9619",
    }),
    "https://a856-exams.nyc.gov/OASysWeb/noe?examId=9619",
  );
});

test("classifyDestinationUrl: OASys NOE is deep; examsforjobs is landing", () => {
  assert.equal(
    classifyDestinationUrl("https://a856-exams.nyc.gov/OASysWeb/noe?examId=9619"),
    "deep",
  );
  assert.equal(classifyDestinationUrl("https://www.nyc.gov/examsforjobs"), "landing");
  assert.equal(
    classifyDestinationUrl("https://a856-exams.nyc.gov/OASysWeb/home"),
    "landing",
  );
});

test("specificity detector flags generic OASys hub when deep pattern is known", () => {
  const finding = assessLinkSpecificity("https://www.nyc.gov/examsforjobs", {
    system_id: "oasys",
    item_mappable: true,
  });
  assert.equal(finding.specificity, "generic-hub");
  assert.equal(finding.finding?.class, "low-specificity");
  assert.match(finding.finding?.deep_pattern || "", /noe\?examId=/);

  const deep = assessLinkSpecificity(
    "https://a856-exams.nyc.gov/OASysWeb/noe?examId=9619",
    { system_id: "oasys" },
  );
  assert.equal(deep.specificity, "deep");
  assert.equal(deep.finding, null);

  // Unmapped rows may honestly use the hub.
  const unmapped = assessLinkSpecificity("https://www.nyc.gov/examsforjobs", {
    system_id: "oasys",
    item_mappable: false,
  });
  assert.equal(unmapped.finding, null);

  assert.ok(DEEP_LINK_SYSTEMS.some((s) => s.id === "oasys"));
  const productFindings = collectSpecificityFindings([
    {
      id: "exam-6125-before",
      url: "https://www.nyc.gov/examsforjobs",
      system_id: "oasys",
      item_mappable: true,
    },
    {
      id: "exam-6125-after",
      url: "https://a856-exams.nyc.gov/OASysWeb/noe?examId=9619",
      system_id: "oasys",
    },
  ]);
  assert.equal(productFindings.length, 1);
  assert.equal(productFindings[0].sample_id, "exam-6125-before");
});

test("fixture body materializes a stable map including golden cases", () => {
  const artifact = materializeOasysMapArtifact(fixtureBody.payload || fixtureBody, {
    fetched_at: "2026-08-03",
  });
  assert.ok(artifact.records.some((r) => r.exam_number === "6125" && r.oasys_exam_id === "9619"));
  assert.ok(artifact.records.some((r) => r.exam_number === "7312" && r.oasys_exam_id === "9646"));
  assert.equal(oasysNoeUrl(9619), "https://a856-exams.nyc.gov/OASysWeb/noe?examId=9619");
});
