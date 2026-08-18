import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { landProjectPath, landProjectUrl } from "../site/land_project_route.mjs";
import { filterLandSnapshot, mergeLandProjects } from "../site/resident_snapshot_queries.mjs";

const defaults = JSON.parse(readFileSync(new URL("../site/data/land_default_ulurp.json", import.meta.url), "utf8"));
const warehouse = JSON.parse(readFileSync(new URL("../site/data/zap_projects_warehouse_lookup.json", import.meta.url), "utf8"));
const actionSnapshot = JSON.parse(readFileSync(new URL("../site/data/land_upcoming_hearings.json", import.meta.url), "utf8"));
const projects = mergeLandProjects(warehouse, defaults);

/** Frozen intersection case — independent of the rolling upcoming-hearings window. */
const FIXTURE_PROJECT_ID = "FIXLAND01";
const FIXTURE_TODAY = "2026-08-17";
const FIXTURE_HEARING_DATE = "2026-08-26";
const FIXTURE_DAY_AFTER_HEARING = "2026-08-27";
const fixtureProjects = [
  {
    project_id: FIXTURE_PROJECT_ID,
    project_name: "Fixture Public-Review Hearing Join",
    public_status: "In Public Review",
    project_status: "Active",
    phase_id: "cpc",
    ulurp_non: "ULURP",
    borough: "Queens",
  },
];
const fixtureActionRows = [
  {
    schema_version: 1,
    source: "zap-api-milestones",
    project_id: FIXTURE_PROJECT_ID,
    project_name: "Fixture Public-Review Hearing Join",
    public_status: "In Public Review",
    phase_id: "cpc",
    milestone_title: "City Planning Commission Review",
    milestone_source_title: "CPC Public Meeting - Public Hearing",
    event_class: "cpc_public_hearing",
    hearing_date: FIXTURE_HEARING_DATE,
    hearing_at: `${FIXTURE_HEARING_DATE}T04:00:00.000Z`,
  },
];

function isoDay(value) {
  const matched = String(value ?? "").match(/^(\d{4}-\d{2}-\d{2})/);
  return matched ? matched[1] : null;
}

function dayAfter(iso) {
  const day = isoDay(iso);
  if (!day) return null;
  const date = new Date(`${day}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function latestHearingDate(actionRows, projectId) {
  return (Array.isArray(actionRows) ? actionRows : [])
    .filter((row) => String(row?.project_id || "") === projectId)
    .map((row) => isoDay(row?.hearing_date || row?.hearing_at || row?.event_date || row?.deadline_date))
    .filter(Boolean)
    .sort()
    .at(-1) || null;
}

function assertHearingIntersectionShape(fieldCase) {
  assert.ok(fieldCase?.project_id, "intersection row must carry a project id");
  assert.equal(fieldCase.public_status, "In Public Review");
  assert.equal(fieldCase._next_action?.action_kind, "hearing");
  assert.ok(
    isoDay(fieldCase._next_action?.action_date),
    "joined next action must surface a hearing date",
  );
  assert.equal(
    landProjectPath(fieldCase.project_id),
    `/browse/zoning/#land/${fieldCase.project_id}`,
  );
}

test("fixture public-review and upcoming-hearing intersection joins deadlines and stage filters", () => {
  const rows = filterLandSnapshot(fixtureProjects, {
    status: "all",
    stage: "public_review",
    futureAction: "hearing",
    actionRows: fixtureActionRows,
    today: FIXTURE_TODAY,
    limit: 100,
  });
  const fieldCase = rows.find((row) => row.project_id === FIXTURE_PROJECT_ID);
  assert.ok(fieldCase, "frozen fixture must keep a public-review ∩ upcoming-hearing join");
  assertHearingIntersectionShape(fieldCase);
  assert.equal(fieldCase.project_name, "Fixture Public-Review Hearing Join");
  assert.equal(fieldCase.phase_id, "cpc");
  assert.equal(fieldCase._next_action.action_date, FIXTURE_HEARING_DATE);

  const cpcRows = filterLandSnapshot(fixtureProjects, {
    status: "all",
    stage: "cpc",
    futureAction: "hearing",
    actionRows: fixtureActionRows,
    today: FIXTURE_TODAY,
    limit: 100,
  });
  assert.ok(cpcRows.some((row) => row.project_id === fieldCase.project_id));

  const afterHearing = filterLandSnapshot(fixtureProjects, {
    status: "all",
    stage: "cpc",
    futureAction: "hearing",
    actionRows: fixtureActionRows,
    today: FIXTURE_DAY_AFTER_HEARING,
    limit: 100,
  });
  assert.equal(afterHearing.some((row) => row.project_id === fieldCase.project_id), false);
});

test("retained public-review and upcoming-hearing data intersects on a real project", (t) => {
  // Keep a stable injected clock for the live snapshot, but choose the intersecting
  // project dynamically — land_upcoming_hearings.json is a rolling window, so a
  // pinned project id ages out on every refresh.
  const today = FIXTURE_TODAY;
  const rows = filterLandSnapshot(projects, {
    status: "all",
    stage: "public_review",
    futureAction: "hearing",
    actionRows: actionSnapshot.hearings,
    today,
    limit: 100,
  });
  if (!rows.length) {
    t.skip("no public-review ∩ upcoming-hearing intersection in the committed rolling snapshot; fixture covers the join invariant");
    return;
  }

  // Prefer a row whose effective phase_id is already a concrete ULURP stage so
  // stage narrowing is exercised without inventing phase from a future hearing.
  const fieldCase = rows.find((row) => row.phase_id === "cpc")
    || rows.find((row) => ["community_board", "borough_president", "cpc", "city_council"].includes(row.phase_id))
    || rows[0];
  assertHearingIntersectionShape(fieldCase);
  assert.ok(
    String(fieldCase.project_name || "").trim(),
    "live intersection row should retain its publisher project name",
  );
  assert.ok(
    fieldCase._next_action.action_date >= today,
    "joined hearing must be on or after the injected test clock",
  );

  if (["community_board", "borough_president", "cpc", "city_council"].includes(fieldCase.phase_id)) {
    const stageRows = filterLandSnapshot(projects, {
      status: "all",
      stage: fieldCase.phase_id,
      futureAction: "hearing",
      actionRows: actionSnapshot.hearings,
      today,
      limit: 100,
    });
    assert.ok(
      stageRows.some((row) => row.project_id === fieldCase.project_id),
      `phase-narrowed stage=${fieldCase.phase_id} should still include the intersecting project`,
    );
  }

  const lastHearing = latestHearingDate(actionSnapshot.hearings, fieldCase.project_id);
  const afterHearingDay = dayAfter(lastHearing);
  assert.ok(afterHearingDay, "live intersecting project must expose a dated hearing for the temporal floor");
  const afterHearing = filterLandSnapshot(projects, {
    status: "all",
    stage: "public_review",
    futureAction: "hearing",
    actionRows: actionSnapshot.hearings,
    today: afterHearingDay,
    limit: 100,
  });
  assert.equal(
    afterHearing.some((row) => row.project_id === fieldCase.project_id),
    false,
    "project must leave the upcoming-hearing filter once its last retained hearing is past",
  );
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
