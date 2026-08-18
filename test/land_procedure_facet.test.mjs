import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_LAND_PROCEDURE,
  LAND_PROCEDURE_OPTIONS,
  landObservedDates,
  landProcedureLabelKey,
  landProcedureSodaWhere,
  landRowMatchesProcedure,
  normalizeLandProcedure,
  resolveLandProcedure,
} from "../site/land_procedure_facet.mjs";
import { filterLandSnapshot, mergeLandProjects } from "../site/resident_snapshot_queries.mjs";
import {
  buildUlurpStatutoryClockView,
  resolveUlurpNon,
} from "../site/ulurp_statutory_clock.mjs";
import {
  attachUlurpStatutoryPredictions,
  emitUlurpStatutoryPredictions,
} from "../worker/src/lib/ulurp_statutory_predictions.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ELURP_POWERS = "2026X0362";
const ELURP_OCEANIA = "2024Q0356";

const warehouse = JSON.parse(
  readFileSync(join(ROOT, "site/data/zap_projects_warehouse_lookup.json"), "utf8"),
);
const defaults = JSON.parse(
  readFileSync(join(ROOT, "site/data/land_default_ulurp.json"), "utf8"),
);
const districtActivity = JSON.parse(
  readFileSync(join(ROOT, "site/data/district_activity.json"), "utf8"),
);
const projects = mergeLandProjects(warehouse, defaults);

function warehouseRow(projectId) {
  return (warehouse.projects || warehouse.rows || []).find((row) => row.project_id === projectId)
    || projects.find((row) => row.project_id === projectId);
}

test("procedure facet default admits ELURP and keeps ULURP-only as an explicit preset", () => {
  assert.equal(DEFAULT_LAND_PROCEDURE, "review");
  assert.deepEqual(
    LAND_PROCEDURE_OPTIONS.map((option) => option.id),
    ["review", "ulurp", "elurp", "non_ulurp"],
  );
  assert.equal(normalizeLandProcedure(undefined), "review");
  assert.equal(normalizeLandProcedure("ulurp"), "ulurp");
  assert.equal(landProcedureSodaWhere("review"), "ulurp_non IN ('ULURP','ELURP')");
  assert.equal(landProcedureSodaWhere("ulurp"), "ulurp_non='ULURP'");
  assert.equal(landProcedureSodaWhere("elurp"), "ulurp_non='ELURP'");
  assert.equal(landProcedureSodaWhere("non_ulurp"), "ulurp_non='Non-ULURP'");
});

test("ELURP specimens appear when the procedure facet includes ELURP", () => {
  const powers = warehouseRow(ELURP_POWERS);
  const oceania = warehouseRow(ELURP_OCEANIA);
  assert.ok(powers, "warehouse must retain HPD 351 Powers Avenue");
  assert.ok(oceania, "warehouse must retain Oceania Street ELURP");
  assert.equal(resolveLandProcedure(powers), "ELURP");
  assert.equal(landProcedureLabelKey(powers), "land_procedure_elurp");
  assert.equal(landRowMatchesProcedure(powers, "review"), true);
  assert.equal(landRowMatchesProcedure(powers, "elurp"), true);
  assert.equal(landRowMatchesProcedure(powers, "ulurp"), false);

  const admitted = filterLandSnapshot(projects, {
    status: "active",
    procedure: "review",
    limit: 500,
  });
  assert.ok(
    admitted.some((row) => row.project_id === ELURP_POWERS),
    "default review procedure must admit 2026X0362",
  );
  assert.ok(
    admitted.some((row) => row.project_id === ELURP_OCEANIA),
    "default review procedure must admit 2024Q0356",
  );
  assert.equal(
    admitted.find((row) => row.project_id === ELURP_POWERS)?._procedure,
    "ELURP",
  );

  const ulurpOnly = filterLandSnapshot(projects, {
    status: "active",
    procedure: "ulurp",
    limit: 500,
  });
  assert.equal(
    ulurpOnly.some((row) => row.project_id === ELURP_POWERS),
    false,
    "explicit ULURP-only preset must still exclude ELURP",
  );
  assert.ok(
    ulurpOnly.some((row) => resolveLandProcedure(row) === "ULURP"),
    "ULURP-only preset must still return ULURP rows",
  );

  const elurpOnly = filterLandSnapshot(projects, {
    status: "active",
    procedure: "elurp",
    limit: 500,
  });
  assert.ok(elurpOnly.some((row) => row.project_id === ELURP_POWERS));
  assert.ok(elurpOnly.every((row) => resolveLandProcedure(row) === "ELURP"));
});

test("map-counted ELURP ids are reachable in the list under the same procedure facet", () => {
  assert.ok(districtActivity.records?.land?.[ELURP_POWERS], "map must count 2026X0362");
  assert.ok(districtActivity.records?.land?.[ELURP_OCEANIA], "map must count 2024Q0356");
  const bronx = districtActivity.district_items?.by_level?.borough?.Bronx?.land || [];
  const queens = districtActivity.district_items?.by_level?.borough?.Queens?.land || [];
  assert.ok(bronx.includes(ELURP_POWERS));
  assert.ok(queens.includes(ELURP_OCEANIA));

  const listIds = new Set(filterLandSnapshot(projects, {
    status: "active",
    procedure: "review",
    limit: 500,
  }).map((row) => row.project_id));
  assert.ok(listIds.has(ELURP_POWERS), "map-counted 2026X0362 must be list-reachable");
  assert.ok(listIds.has(ELURP_OCEANIA), "map-counted 2024Q0356 must be list-reachable");
});

test("observed hearing and comment dates are stamped as facts, not projections", () => {
  const rows = filterLandSnapshot([
    {
      project_id: ELURP_POWERS,
      project_name: "351 Powers Avenue (HPD ELURP)",
      project_status: "Active",
      public_status: "In Public Review",
      ulurp_non: "ELURP",
    },
  ], {
    status: "active",
    procedure: "elurp",
    actionRows: [
      {
        project_id: ELURP_POWERS,
        event_class: "public_hearing",
        hearing_date: "2026-03-24",
      },
      {
        project_id: ELURP_POWERS,
        event_class: "deadline",
        milestone_title: "Comment deadline",
        deadline_date: "2026-03-27",
      },
    ],
    today: "2026-08-18",
    limit: 10,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]._observed_dates.hearing_date, "2026-03-24");
  assert.equal(rows[0]._observed_dates.comment_deadline, "2026-03-27");
  assert.deepEqual(
    landObservedDates(rows[0], [
      { event_class: "public_hearing", hearing_date: "2026-03-24" },
      { event_class: "deadline", milestone_title: "Comment deadline", deadline_date: "2026-03-27" },
    ]),
    { hearing_date: "2026-03-24", comment_deadline: "2026-03-27" },
  );
});

test("a now-visible ELURP record gets no ULURP §197-c clock or prediction", () => {
  const row = warehouseRow(ELURP_POWERS);
  assert.equal(resolveLandProcedure(row), "ELURP");
  const admitted = filterLandSnapshot(projects, {
    status: "active",
    procedure: "review",
    limit: 500,
  });
  assert.ok(admitted.some((item) => item.project_id === ELURP_POWERS));

  const record = {
    ...row,
    ulurp_non: null,
    open_data: { ulurp_non: row.ulurp_non },
    certified_referred: "2026-03-16",
    public_status: "In Public Review",
  };
  assert.equal(resolveUlurpNon(record), "ELURP");
  const clock = buildUlurpStatutoryClockView(record, {
    generatedAt: "2026-08-18T12:00:00Z",
  });
  assert.equal(clock.status, "ineligible");
  assert.equal(clock.reason, "wrong_procedure");
  assert.equal(clock.phases.length, 0);
  assert.ok(
    !(clock.phases || []).some((phase) => phase.statute_ref === "NYC Charter §197-c"),
    "visible ELURP must not paint Charter §197-c stages",
  );
  assert.deepEqual(emitUlurpStatutoryPredictions(record, {
    generatedAt: "2026-08-18T12:00:00Z",
  }), []);
  const attached = attachUlurpStatutoryPredictions(record, {
    generatedAt: "2026-08-18T12:00:00Z",
  });
  assert.equal(attached.statutory_clock.status, "ineligible");
  assert.equal(attached.statutory_clock.reason, "wrong_procedure");
  assert.deepEqual(attached.predictions, []);
});

test("open_data.ulurp_non is read when the top-level field is null", () => {
  const row = { project_id: "OPEN1", open_data: { ulurp_non: "ELURP" } };
  assert.equal(resolveLandProcedure(row), "ELURP");
  assert.equal(landRowMatchesProcedure(row, "review"), true);
  assert.equal(landRowMatchesProcedure({ ulurp_non: "Non-ULURP" }, "review"), false);
  assert.equal(landRowMatchesProcedure({ ulurp_non: "Non-ULURP" }, "non_ulurp"), true);
});
