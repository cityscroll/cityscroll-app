// Characterization: Civil Service List aggregates (closed-exam join + PII hard rule).
//   node --test test/civil_service_list_join.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildListAggregateIndex,
  joinExamToListAggregate,
  measureListPresence,
} from "../worker/src/lib/civil_service_list_join.mjs";
import {
  joinListAggregateOntoExam,
  joinOutcomeOntoExam,
  joinOutcomesAndListOntoExam,
  outcomesByExamNumber,
} from "../tools/build_staffing_exams.mjs";

const require = createRequire(import.meta.url);
const Staffing = require("../site/staffing.js");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const aggregates = JSON.parse(
  readFileSync(join(ROOT, "site/data/exam_sources/civil_service_list_aggregates.json"), "utf8"),
);
const receipt = JSON.parse(
  readFileSync(
    join(ROOT, "site/data/exam_sources/verification_receipts/civil_service_list_closed_exams_2026-07-30.json"),
    "utf8",
  ),
);
const contracts = JSON.parse(readFileSync(join(ROOT, "site/data/source_contracts.json"), "utf8"));
const artifact = JSON.parse(readFileSync(join(ROOT, "site/data/staffing_exams.json"), "utf8"));
const html = readFileSync(join(ROOT, "site/index.html"), "utf8");

test("aggregates artifact is exam-level only with no PII field names", () => {
  assert.ok(aggregates.records.length >= 100);
  assert.equal(aggregates.source.dataset_id, "vx8i-nprf");
  for (const row of aggregates.records) {
    assert.ok(row.exam_number || row.exam_no_raw);
    assert.equal(typeof row.list_count, "number");
    assert.ok(row.list_count >= 0);
    for (const key of Object.keys(row)) {
      assert.doesNotMatch(key, /first_name|last_name|ssn|address|phone|email|list_rank/i);
    }
  }
  assert.match(aggregates.source.privacy, /never|not copied|group-by|aggregate/i);
});

test("closed-exam list presence meets usefulness threshold; open exams do not", () => {
  const closed = receipt.join_measurement.rates.closed_exams_list_presence;
  const open = receipt.join_measurement.rates.open_exams_list_presence;
  assert.equal(closed.joined, 494);
  assert.equal(closed.total, 1109);
  assert.ok(closed.rate >= 0.3, `closed rate ${closed.rate}`);
  assert.equal(open.joined, 0);
  assert.ok(open.rate < 0.3);
  assert.match(receipt.join_measurement.verdict, /44\.54%|ship post-list/i);
  assert.equal(receipt.privacy.rule.includes("never ship per-applicant"), true);
});

test("source contract join_measurement matches receipt closed-exam rate", () => {
  const c = contracts.contracts.find((x) => x.id === "active-civil-service-list");
  assert.ok(c);
  assert.equal(c.join_measurement.rates.closed_exams_list_presence.rate, 0.4454);
  assert.match(c.used_for, /post-list aggregate|list_count/i);
});

test("join helpers map zero-padded exam numbers and reject PII-shaped rows", () => {
  const index = buildListAggregateIndex([
    { exam_number: "0111", list_count: 10, established_date: "2022-09-07", title_count: 1 },
  ]);
  assert.equal(joinExamToListAggregate("111", index)?.list_count, 10);
  assert.equal(joinExamToListAggregate("0111", index)?.list_count, 10);
  assert.equal(joinExamToListAggregate("9999", index), null);
  assert.throws(
    () => buildListAggregateIndex([{ exam_number: "1", list_count: 1, first_name: "x" }]),
    /PII field/,
  );
  const m = measureListPresence(["0111", "9999", "111"], index);
  // 0111 and 111 collapse to one distinct key path but measureListPresence counts inputs
  assert.equal(m.joined, 2);
  assert.equal(m.total, 3);
});

test("list aggregate attaches when annual outcomes are missing", () => {
  const index = buildListAggregateIndex([
    { exam_number: "4044", list_count: 50, established_date: "2026-01-21", title_count: 1 },
  ]);
  const outcomeMap = outcomesByExamNumber([]);
  const joined = joinOutcomesAndListOntoExam(
    { exam_number: "4044", title: "Sample" },
    outcomeMap,
    index,
  );
  assert.equal(joined.outcome, null);
  assert.equal(joined.list_aggregate.list_count, 50);
  assert.equal(joined.list_aggregate.established_date, "2026-01-21");
  const view = Staffing.examOutcomeView(joined);
  assert.equal(view.kind, "list_joined");
  assert.equal(view.list_count, 50);

  const withAnnual = joinOutcomesAndListOntoExam(
    { exam_number: "4044", title: "Sample" },
    outcomesByExamNumber([{
      exam_number: "4044",
      applicant_count: 1,
      list_establishment: 1,
      certification_count: 1,
      appointment_count: 1,
      hire_count: 1,
      application_cycle: "2026",
      published_on: "2026-07-01",
    }]),
    index,
  );
  assert.equal(Staffing.examOutcomeView(withAnnual).kind, "joined");
  assert.equal(withAnnual.list_aggregate.list_count, 50);
});

test("staffing artifact and card template support list_joined depth", () => {
  assert.ok(artifact.list_aggregates?.source?.dataset_id === "vx8i-nprf" || artifact.list_aggregates?.source?.id);
  assert.match(html, /data-outcome="list_joined"/);
  assert.match(html, /career_outcomes_list_joined_note/);
  // Privacy: no exam list_aggregate should expose name fields
  for (const exam of artifact.exams) {
    if (!exam.list_aggregate) continue;
    for (const key of Object.keys(exam.list_aggregate)) {
      assert.doesNotMatch(key, /first_name|last_name|person/i);
    }
  }
});

test("joinListAggregateOntoExam alone leaves list counts; full path clears gap on list hit", () => {
  const index = buildListAggregateIndex([{ exam_number: "9000", list_count: 3 }]);
  const exam = joinListAggregateOntoExam({ exam_number: "9000" }, index);
  assert.equal(exam.list_aggregate.list_count, 3);
  const withGap = joinOutcomeOntoExam(exam, outcomesByExamNumber([]));
  assert.equal(withGap.outcome_gap.class, "not_yet_ingested");
  const full = joinOutcomesAndListOntoExam({ exam_number: "9000" }, outcomesByExamNumber([]), index);
  assert.equal(full.list_aggregate.list_count, 3);
  assert.equal(full.outcome_gap, null);
  assert.equal(Staffing.examOutcomeView(full).kind, "list_joined");
});

test("artifact ships non-null list_aggregate examples from closed list-depth exams", () => {
  const withList = artifact.exams.filter(
    (exam) => exam.list_aggregate && Number(exam.list_aggregate.list_count) > 0,
  );
  assert.ok(withList.length >= 10, `expected many list joins, got ${withList.length}`);
  assert.ok(
    Number(artifact.list_aggregates?.summary?.exams_with_list_aggregate || 0) >= 10,
  );
  // Never class-(b) not_published for aggregate outcome gaps.
  for (const exam of artifact.exams) {
    if (exam.outcome_gap) {
      assert.notEqual(exam.outcome_gap.class, "not_published", exam.exam_number);
      assert.equal(exam.outcome_gap.class, "not_yet_ingested", exam.exam_number);
    }
  }
});
