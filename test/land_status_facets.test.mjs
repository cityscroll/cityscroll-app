import { test } from "node:test";
import assert from "node:assert/strict";
import {
  landFacetOptionCounts,
  landFutureActionsByProject,
  landRowMatchesStage,
  landStageForRow,
  landStatusFacetOptions,
  landStatusFacetWhere,
} from "../site/land_status_facets.mjs";

test("land status facets are derived from non-empty ZAP status fields", () => {
  const options = landStatusFacetOptions([
    { project_status: "Active", public_status: "In Public Review" },
    { project_status: "Active", public_status: "In Public Review" },
    { project_status: "Complete", public_status: "Completed" },
    { project_status: "", public_status: null },
  ]);
  assert.deepEqual(options, [
    { id: "public:Completed", label: "Completed", field: "public_status", count: 1 },
    { id: "project:Active", label: "Active", field: "project_status", count: 2 },
    { id: "public:In Public Review", label: "In Public Review", field: "public_status", count: 2 },
    { id: "project:Complete", label: "Complete", field: "project_status", count: 1 },
  ].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id)));
});

test("land status facet preserves the exact source field in its query", () => {
  assert.equal(landStatusFacetWhere("project:Active"), "project_status='Active'");
  assert.equal(landStatusFacetWhere("public:In Public Review"), "public_status='In Public Review'");
  assert.equal(landStatusFacetWhere("public:O'Reilly"), "public_status='O''Reilly'");
  assert.equal(landStatusFacetWhere("active"), null);
});

test("normalized ZAP stages distinguish the public-review institutions", () => {
  const row = (current_milestone, extra = {}) => ({
    project_status: "Active",
    public_status: "In Public Review",
    current_milestone,
    ...extra,
  });
  assert.equal(landStageForRow(row("EAS - Community Board Referral")), "community_board");
  assert.equal(landStageForRow(row("EAS - Borough President Referral")), "borough_president");
  assert.equal(landStageForRow(row("CPC Public Hearing")), "cpc");
  assert.equal(landStageForRow(row("Project Readiness", { phase_id: "cpc" })), "cpc");
  assert.equal(landStageForRow(row("City Council Review")), "city_council");
  assert.equal(landStageForRow(row("Project Readiness", { public_status: "Filed" })), "pre_certification");
  assert.equal(landStageForRow(row("City Council Review", { public_status: "Completed" })), "completed");
  assert.equal(landRowMatchesStage(row("CPC Public Hearing"), "public_review"), true);
  assert.equal(landRowMatchesStage(row("Project Readiness", { public_status: "Filed" }), "public_review"), false);
});

test("future actionability uses the event date and transitions at a controllable clock", () => {
  const actions = [
    { project_id: "CB", event_class: "cpc_public_hearing", hearing_date: "2026-09-10" },
    { project_id: "CPC", event_class: "cpc_pre_hearing_review_session", hearing_date: "2026-09-12" },
  ];
  assert.equal(landFutureActionsByProject(actions, { today: "2026-09-10" }).get("CB").length, 1);
  assert.equal(landFutureActionsByProject(actions, { today: "2026-09-11" }).has("CB"), false);
  assert.equal(landFutureActionsByProject(actions, { today: "2026-09-11" }).get("CPC")[0].action_kind, "meeting_vote");
});

test("stage and future-action option counts expose empty intersections", () => {
  const projects = [
    { project_id: "CB", project_status: "Active", public_status: "In Public Review", current_milestone: "Community Board Review" },
    { project_id: "CPC", project_status: "Active", public_status: "In Public Review", current_milestone: "CPC Public Hearing" },
    { project_id: "DONE", project_status: "Complete", public_status: "Completed", current_milestone: "Project Completed" },
  ];
  const actions = [
    { project_id: "CB", event_class: "cpc_public_hearing", hearing_date: "2026-09-10" },
  ];
  const counts = landFacetOptionCounts(projects, actions, {
    today: "2026-08-17",
    stage: "public_review",
    futureAction: "hearing",
  });
  assert.equal(counts.stage.community_board, 1);
  assert.equal(counts.stage.cpc, 0);
  assert.equal(counts.stage.completed, 0);
  assert.equal(counts.future_action.hearing, 1);
  assert.equal(counts.future_action.none, 1);
});
