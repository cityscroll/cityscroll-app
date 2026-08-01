import test from "node:test";
import assert from "node:assert/strict";
import { compileActionRail, validateAction } from "../../worker/src/lib/action_registry.mjs";

const cases = [
  {kind: "solicitation", lifecycle_stage: "open", deadline: "2026-09-30", official_application_url: "https://passport.cityofnewyork.us/page.aspx/en/rfp/request_browse_public"},
  {kind: "rule", lifecycle_stage: "comment-open", deadline: "2026-09-01", comment_url: "https://rules.cityofnewyork.us/rule/example/"},
  {kind: "hearing", deadline: "2026-09-02", participation_url: "https://www.nyc.gov/events/example"},
  {kind: "zoning", lifecycle_stage: "active", project_url: "https://zap.planning.nyc.gov/projects/2026M0366"},
  {kind: "exam", lifecycle_stage: "open", deadline: "2026-09-03", official_application_url: "https://www.nyc.gov/examsforjobs", official_notice_url: "https://www.nyc.gov/site/dcas/employment/exam-schedules-open-competitive-exams.page"},
];

test("every official handoff in each supported rail is HTTPS and names its destination", () => {
  for (const matter of cases) {
    const actions = compileActionRail(matter, {today: "2026-08-01"});
    for (const action of actions) {
      validateAction(action);
      if (action.delivery !== "official_handoff") continue;
      assert.match(action.destination, /^https:\/\//, `${matter.kind}:${action.type}`);
      assert.ok(action.destination_label, `${matter.kind}:${action.type}`);
    }
  }
});

test("HTTP, javascript, and malformed handoffs degrade to unavailable actions", () => {
  for (const destination of ["http://example.org/apply", "javascript:alert(1)", "not a url"]) {
    const [action] = compileActionRail({kind: "exam", lifecycle_stage: "open", official_application_url: destination}, {today: "2026-08-01"});
    assert.equal(action.delivery, "unavailable");
    assert.equal(action.destination, undefined);
    assert.equal(action.destination_label, undefined);
  }
});
