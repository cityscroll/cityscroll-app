import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compileActionRail, validateAction } from "../worker/src/lib/action_registry.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/wave4/action-fixtures.json", import.meta.url)));

test("open solicitations compile a narrow bid, deadline, and watch rail", () => {
  const actions = compileActionRail(fixture.matter, {today: "2026-08-01"});
  assert.deepEqual(actions.map(action => action.type), ["official_application", "calendar", "watch"]);
  assert.equal(actions[0].destination, fixture.matter.official_application_url);
  assert.equal(actions[0].deadline, fixture.matter.deadline);
});

test("closed solicitations replace the bid handoff with an honest unavailable state", () => {
  const actions = compileActionRail({...fixture.matter, lifecycle_stage: "closed"}, {today: "2026-08-01"});
  assert.equal(actions[0].delivery, "unavailable");
  assert.equal(actions[0].label_key, "next_action_bid_closed");
  assert.equal(actions[0].destination, undefined);
  assert.deepEqual(actions.map(action => action.type), ["official_application", "document", "watch"]);
});

test("open rule comments and upcoming hearings use their joined deadlines and handoffs", () => {
  const rule = compileActionRail({
    kind: "rule", lifecycle_stage: "comment-open", deadline: "2026-08-12",
    comment_url: "https://rules.cityofnewyork.us/rule/example/",
  }, {today: "2026-08-01"});
  assert.deepEqual(rule.map(action => action.type), ["comment", "calendar", "watch"]);
  assert.equal(rule[0].destination_label, "rules.cityofnewyork.us");

  const hearing = compileActionRail({
    kind: "hearing", deadline: "2026-08-10T14:30:00.000",
    participation_url: "https://www.nyc.gov/site/mocs/opportunities/franchises-concessions.page",
  }, {today: "2026-08-01"});
  assert.deepEqual(hearing.map(action => action.type), ["attend", "calendar", "watch"]);
});

test("missing hearing participation stays visible without inventing a destination", () => {
  const actions = compileActionRail({kind: "hearing", deadline: "2026-08-10"}, {today: "2026-08-01"});
  assert.equal(actions[0].delivery, "unavailable");
  assert.equal(actions[0].label_key, "next_action_participation_missing");
  assert.equal(actions[0].destination, undefined);
});

test("exam action windows reuse the official OASys handoff", () => {
  const actions = compileActionRail({
    kind: "exam", lifecycle_stage: "open", deadline: "2026-08-20",
    official_application_url: "https://www.nyc.gov/examsforjobs",
    official_notice_url: "https://www.nyc.gov/site/dcas/employment/exam-schedules-open-competitive-exams.page",
  }, {today: "2026-08-01"});
  assert.equal(actions[0].type, "official_application");
  assert.equal(actions[0].destination, "https://www.nyc.gov/examsforjobs");
});

test("all compiled rails stay at three actions or fewer and validate", () => {
  const actions = compileActionRail(fixture.matter, {today: "2026-08-01"});
  assert.ok(actions.length <= 3);
  actions.forEach(validateAction);
});
