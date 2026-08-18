import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { landProjectPath, landProjectUrl } from "../site/land_project_route.mjs";
import { filterLandSnapshot, mergeLandProjects } from "../site/resident_snapshot_queries.mjs";

const defaults = JSON.parse(readFileSync(new URL("../site/data/land_default_ulurp.json", import.meta.url), "utf8"));
const warehouse = JSON.parse(readFileSync(new URL("../site/data/zap_projects_warehouse_lookup.json", import.meta.url), "utf8"));
const actionSnapshot = JSON.parse(readFileSync(new URL("../site/data/land_upcoming_hearings.json", import.meta.url), "utf8"));
const projects = mergeLandProjects(warehouse, defaults);

test("retained public-review and upcoming-hearing data intersects on a real project", () => {
  const rows = filterLandSnapshot(projects, {
    status: "all",
    stage: "public_review",
    futureAction: "hearing",
    actionRows: actionSnapshot.hearings,
    today: "2026-08-17",
    limit: 100,
  });
  const fieldCase = rows.find((row) => row.project_id === "2024Q0292");
  assert.ok(fieldCase, "108-05 68th Road Rezoning is retained in both project and future-action data");
  assert.equal(fieldCase.project_name, "108-05 68th Road Rezoning");
  assert.equal(fieldCase.public_status, "In Public Review");
  assert.equal(fieldCase.phase_id, "cpc");
  assert.equal(fieldCase._next_action.action_kind, "hearing");
  assert.equal(fieldCase._next_action.action_date, "2026-08-26");
  assert.equal(landProjectPath(fieldCase.project_id), "/browse/zoning/#land/2024Q0292");

  const cpcRows = filterLandSnapshot(projects, {
    status: "all",
    stage: "cpc",
    futureAction: "hearing",
    actionRows: actionSnapshot.hearings,
    today: "2026-08-17",
    limit: 100,
  });
  assert.ok(cpcRows.some((row) => row.project_id === fieldCase.project_id));

  const afterHearing = filterLandSnapshot(projects, {
    status: "all",
    stage: "cpc",
    futureAction: "hearing",
    actionRows: actionSnapshot.hearings,
    today: "2026-08-27",
    limit: 100,
  });
  assert.equal(afterHearing.some((row) => row.project_id === fieldCase.project_id), false);
});

test("legacy exact-status URLs still select their source status", () => {
  const rows = filterLandSnapshot(projects, {
    status: "public:In Public Review",
    stage: "any",
    actionRows: actionSnapshot.hearings,
    today: "2026-08-17",
    limit: 300,
  });
  assert.ok(rows.length > 0);
  assert.ok(rows.every((row) => row.public_status === "In Public Review"));
});

test("every retained Zoning project has one canonical document permalink", () => {
  assert.ok(projects.length > 0);
  for (const project of projects) {
    assert.match(landProjectPath(project.project_id), /^\/browse\/zoning\/#land\/[A-Za-z0-9_-]+$/);
    assert.equal(
      landProjectUrl(project.project_id),
      `https://cityscroll.org${landProjectPath(project.project_id)}`,
    );
  }
});
