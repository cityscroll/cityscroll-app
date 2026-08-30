/**
 * Per-action land procedure resolution.
 *
 *   node --test test/land_action_procedure_resolution.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  LAND_ACTION_PROCEDURE_SCHEMA,
  landActionHasProfileSummary,
  landActionProcedurePanelHTML,
  landMultipleReviewTracksHTML,
  resolveLandActionProcedures,
  stampLandActionProcedureResolution,
} from "../site/land_action_procedure_resolution.mjs";
import { LAND_PROCEDURE_PROFILE_REGISTRY_VERSION } from "../site/land_procedure_profiles.mjs";
import { buildLandPhaseView } from "../site/land_phase_spine.mjs";
import { landActionKinds, landProcedureKinds } from "../site/mandate_land_use_bridge.mjs";
import { filterLandSnapshot, mergeLandProjects } from "../site/resident_snapshot_queries.mjs";
import { landRowMatchesFamily } from "../site/land_status_facets.mjs";
import { rowToSodaShape } from "../warehouse/lib/zap_lookup.mjs";
import { shapeZapLookupRow } from "../worker/src/lib/zap_projects_lookup_kv.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const gold = JSON.parse(
  readFileSync(join(ROOT, "test/fixtures/land_action_procedure_resolution/gold.v1.json"), "utf8"),
);
const warehouse = JSON.parse(
  readFileSync(join(ROOT, "site/data/zap_projects_warehouse_lookup.json"), "utf8"),
);
const landDefault = JSON.parse(
  readFileSync(join(ROOT, "site/data/land_default_ulurp.json"), "utf8"),
);

function warehouseRow(projectId) {
  return (warehouse.rows || warehouse.projects || []).find((row) => row.project_id === projectId);
}

function defaultRow(projectId) {
  return (landDefault.projects || []).find((row) => row.project_id === projectId);
}

test("A1 mixed 2024M0244 keeps one row per action and does not flatten to ULURP", () => {
  const row = warehouseRow("2024M0244");
  assert.ok(row);
  assert.equal(row.actions, "ZS; ZM; ZR; LD; LD");
  assert.equal(row.ulurp_numbers, "C260015ZSM; C260013ZMM; N260014ZRM; 260201LDM; 260202LDM");
  assert.equal(row.ulurp_non, "ULURP");

  const resolved = resolveLandActionProcedures(row);
  const expected = gold.specimens["mixed-2024M0244"].expect;
  assert.equal(resolved.schema, LAND_ACTION_PROCEDURE_SCHEMA);
  assert.equal(resolved.procedure_resolution, expected.procedure_resolution);
  assert.equal(resolved.land_actions.length, expected.action_count);
  assert.deepEqual(resolved.land_actions.map((action) => action.action_type), expected.action_types);
  assert.deepEqual(resolved.land_actions.map((action) => action.application_id), expected.application_ids);
  assert.equal(resolved.raw.actions, row.actions);
  assert.equal(resolved.raw.ulurp_numbers, row.ulurp_numbers);
  assert.equal(resolved.raw.ulurp_non, row.ulurp_non);

  assert.equal(resolved.land_actions[0].procedure_id, "ulurp_197c");
  assert.equal(resolved.land_actions[0].status, "resolved");
  assert.equal(resolved.land_actions[0].profile_version, LAND_PROCEDURE_PROFILE_REGISTRY_VERSION);
  assert.equal(resolved.land_actions[1].procedure_id, "ulurp_197c");
  assert.equal(resolved.land_actions[2].procedure_id, "non_ulurp");
  assert.equal(resolved.land_actions[2].status, "resolved");
  assert.equal(resolved.land_actions[2].profile_version, null);
  assert.equal(resolved.land_actions[3].status, "unresolved");
  assert.equal(resolved.land_actions[4].status, "unresolved");
  assert.equal(resolved.land_actions[3].procedure_id, null);
  assert.notEqual(resolved.land_actions[3].unresolved_reason, null);
  assert.ok(resolved.land_actions.every((action) => action.href == null));
  assert.equal(landActionHasProfileSummary(resolved.land_actions[0]), true);
  assert.equal(landActionHasProfileSummary(resolved.land_actions[2]), false);
  assert.equal(landActionHasProfileSummary(resolved.land_actions[3]), false);
  assert.match(landMultipleReviewTracksHTML(row, { t: (key) => key, escape: String }), /land_multiple_review_tracks/);
});

test("A1 uniform 2025K0305 is one MM track with the matching application id", () => {
  const row = defaultRow("2025K0305") || warehouseRow("2025K0305");
  const resolved = resolveLandActionProcedures(row);
  const expected = gold.specimens["uniform-2025K0305"].expect;
  assert.equal(resolved.procedure_resolution, expected.procedure_resolution);
  assert.equal(resolved.land_actions.length, expected.action_count);
  assert.equal(resolved.land_actions[0].action_type, "MM");
  assert.equal(resolved.land_actions[0].application_id, "250308MMK");
  assert.equal(resolved.land_actions[0].procedure_id, "ulurp_197c");
  assert.equal(resolved.land_actions[0].status, "resolved");
  assert.ok(resolved.land_actions[0].source_fields.includes("ulurp_numbers"));
  assert.ok(resolved.land_actions[0].source_fields.includes("ulurp_non"));
  assert.equal(landMultipleReviewTracksHTML(row, { t: (key) => key, escape: String }), "");
});

test("A1/A2 2026K0123 stays unknown and does not inherit project ULURP", () => {
  const row = warehouseRow("2026K0123");
  assert.equal(row.ulurp_non, "ULURP");
  assert.equal(row.ulurp_numbers, null);
  const resolved = resolveLandActionProcedures(row);
  assert.equal(resolved.procedure_resolution, "unknown");
  assert.equal(resolved.land_actions.length, 4);
  assert.deepEqual(resolved.land_actions.map((action) => action.action_type), ["UK", "ZM", "ZR", "EAS"]);
  assert.equal(resolved.land_actions.every((action) => action.status === "unresolved"), true);
  assert.equal(resolved.land_actions.every((action) => action.procedure_id == null), true);
  assert.equal(resolved.land_actions[0].unresolved_reason, "unsupported_action_token");
  assert.equal(resolved.land_actions[1].unresolved_reason, "missing_application_id");
  assert.equal(resolved.land_actions[2].unresolved_reason, "missing_application_id");
  assert.equal(resolved.land_actions[3].unresolved_reason, "unsupported_action_token");
  assert.equal(resolved.land_actions[3].application_id, row.ceqr_number);
});

test("A2 unresolved actions never inherit a sibling procedure", () => {
  const resolved = resolveLandActionProcedures({
    project_id: "2024M0244",
    actions: "ZS; ZM; ZR; LD; LD",
    ulurp_numbers: "C260015ZSM; C260013ZMM; N260014ZRM; 260201LDM; 260202LDM",
    ulurp_non: "ULURP",
  });
  const zs = resolved.land_actions[0].procedure_id;
  const ld = resolved.land_actions[3];
  assert.equal(zs, "ulurp_197c");
  assert.equal(ld.procedure_id, null);
  assert.equal(ld.status, "unresolved");
  assert.notEqual(ld.procedure_id, zs);
  assert.notEqual(resolved.land_actions[2].procedure_id, zs);
});

test("A3 negative fixtures refuse title, milestone, applicant, address, and count heuristics", () => {
  for (const entry of gold.negatives) {
    const resolved = resolveLandActionProcedures({
      ...entry.row,
      current_milestone: entry.row.current_milestone || "City Council Review",
      project_name: entry.row.project_name || "ULURP mapping",
      primary_applicant: entry.row.primary_applicant || "City Planning",
    });
    assert.equal(resolved.procedure_resolution, entry.expect.procedure_resolution, entry.id);
    if (entry.expect.action_count != null) {
      assert.equal(resolved.land_actions.length, entry.expect.action_count, entry.id);
    }
    if (entry.expect.resolved_count != null) {
      assert.equal(
        resolved.land_actions.filter((action) => action.status === "resolved").length,
        entry.expect.resolved_count,
        entry.id,
      );
    }
    if (entry.expect.unresolved_reason) {
      assert.ok(
        resolved.land_actions.every((action) => action.unresolved_reason === entry.expect.unresolved_reason),
        entry.id,
      );
    }
    if (Object.hasOwn(entry.expect, "application_id")) {
      assert.ok(resolved.land_actions.every((action) => action.application_id == null), entry.id);
    }
  }
});

test("A3 two C-prefix actions are uniform without using action count", () => {
  const resolved = resolveLandActionProcedures({
    project_id: "TWO-C",
    actions: "ZM; ZR",
    ulurp_numbers: "C260013ZMM; C260014ZRM",
    current_milestone: "Community Board Review",
    project_name: "Two actions",
  });
  assert.equal(resolved.procedure_resolution, "uniform");
  assert.equal(resolved.land_actions.length, 2);
  assert.ok(resolved.land_actions.every((action) => action.procedure_id === "ulurp_197c"));
});

test("A4 stamping is additive and keeps scalar compatibility fields", () => {
  const original = warehouseRow("2025K0305");
  const shaped = rowToSodaShape({ ...original }, { asOf: "2026-08-30T00:00:00.000Z" });
  assert.equal(shaped.project_id, "2025K0305");
  assert.equal(shaped.actions, original.actions);
  assert.equal(shaped.ulurp_numbers, original.ulurp_numbers);
  assert.equal(shaped.ulurp_non, original.ulurp_non);
  assert.equal(shaped.procedure_resolution, "uniform");
  assert.equal(shaped.land_actions.length, 1);

  const workerShaped = shapeZapLookupRow({ ...original }, { asOf: "2026-08-30T00:00:00.000Z" });
  assert.equal(workerShaped.ulurp_non, original.ulurp_non);
  assert.equal(workerShaped.procedure_resolution, "uniform");

  const stamped = stampLandActionProcedureResolution({ ...original });
  assert.equal(stamped.actions, original.actions);
  assert.equal(landProcedureKinds(stamped)[0], "ulurp");
  assert.ok(landActionKinds(stamped).includes("mapping"));
});

test("A4 action filters, mandate procedure kinds, and phase-spine inputs stay intact", () => {
  const projects = mergeLandProjects(warehouse, landDefault);
  const rezoning = filterLandSnapshot(projects, { family: "rezoning", procedure: "review" });
  assert.ok(rezoning.some((row) => row.project_id === "2026K0123"));
  assert.equal(landRowMatchesFamily(warehouseRow("2026K0123"), "rezoning"), true);

  const mixed = warehouseRow("2024M0244");
  assert.deepEqual(landProcedureKinds(mixed), ["ulurp"]);
  const view = buildLandPhaseView({
    schema_version: 1,
    project_id: "2024M0244",
    events: [{
      id: "obs-1",
      kind: "zap_milestone",
      title: "City Planning Commission Review",
      time: { value: "2026-07-01", certainty: "actual" },
      source: { id: "zap", url: "https://zap.planning.nyc.gov/projects/2024M0244" },
    }],
  }, { open_data: mixed });
  assert.equal(view.project_id, "2024M0244");
  assert.equal(view.procedure_resolution, "mixed");
  assert.equal(view.land_actions.length, 5);
  assert.equal(view.procedure_profile.status, "unresolved");
  assert.equal(view.procedure_profile.reason, "mixed_action_set");
  assert.equal(view.event_count, 1);
  assert.equal(Object.hasOwn(view.procedure_profile, "observed_event_id"), false);
});

test("detail panel lists exact rows and withholds profile summary on unknown tracks", () => {
  const html = landActionProcedurePanelHTML(warehouseRow("2024M0244"), {
    t: (key) => key,
    escape: (value) => String(value ?? ""),
  });
  assert.match(html, /data-procedure-resolution="mixed"/);
  assert.match(html, /data-application-id="C260015ZSM"/);
  assert.match(html, /data-application-id="N260014ZRM"/);
  assert.match(html, /data-profile-version="/);
  assert.match(html, /data-status="unresolved"/);
  assert.doesNotMatch(html, /\/actions\//);
});
