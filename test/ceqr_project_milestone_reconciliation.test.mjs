import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  CEQR_MILESTONES_DATASET_ID,
  CEQR_NORMALIZATION_VERSION,
  CEQR_PROJECTS_DATASET_ID,
  normalizeCeqrKey,
  reconcileCeqrProjectMilestones,
} from "../warehouse/lib/ceqr_project_milestone_reconciliation.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/ceqr_project_milestone_reconciliation/gold.v1.json", import.meta.url)));
const committedReceipt = JSON.parse(readFileSync(new URL("../warehouse/receipts/proof/ceqr_project_milestone_reconciliation_latest.json", import.meta.url)));
const sources = {
  projects: { dataset_id: CEQR_PROJECTS_DATASET_ID, rows_updated_at: "2026-08-28T14:05:04.000Z" },
  milestones: { dataset_id: CEQR_MILESTONES_DATASET_ID, rows_updated_at: "2026-08-28T14:05:23.000Z" },
};
const build = () => reconcileCeqrProjectMilestones({ ...fixture, zapRows: fixture.zap_rows, projectRows: fixture.project_rows, milestoneRows: fixture.milestone_rows, materializedAt: fixture.materialized_at, sources });

describe("CEQR exact-key reconciliation", () => {
  it("normalizes only CEQR grammar and rejects resemblance", () => {
    assert.equal(normalizeCeqrKey(" 26dcp139x "), "26DCP139X");
    assert.equal(normalizeCeqrKey("26 DCP 139 X"), "26DCP139X");
    for (const value of ["EAS", "2 Ploughmans Bush", "Bronx", "Department of City Planning", "26DCP139X project description"]) assert.equal(normalizeCeqrKey(value), null);
  });

  it("joins the exact source row and retains project-level provenance", () => {
    const receipt = build();
    assert.equal(receipt.reconciliation.exact_project_matches, 1);
    assert.equal(receipt.joined_projects.length, 1);
    const joined = receipt.joined_projects[0];
    assert.equal(joined.zap_project_id, "EXACT");
    assert.equal(joined.ceqr_key, "26DCP139X");
    assert.equal(joined.join.method, "normalized_ceqr_key_equality");
    assert.equal(joined.join.normalization_version, CEQR_NORMALIZATION_VERSION);
    assert.equal(joined.project.source_record_id, "project-exact");
    assert.equal(joined.project.source_dataset_id, "gezn-7mgk");
    assert.equal(joined.milestones.source_dataset_id, "8fj8-3sgg");
    assert.equal(joined.materialized_at, fixture.materialized_at);
  });

  it("keeps duplicate and revision state inspectable while excluding ambiguous joins", () => {
    const receipt = build();
    assert.deepEqual(receipt.zap_eligibility.ambiguous_keys[0], { key: "25DCP049M", zap_project_ids: ["DUP_A", "DUP_B"] });
    assert.deepEqual(receipt.reconciliation.revision_conflicted_keys, ["24DCP100K"]);
    assert.equal(receipt.retained_source_inspection.projects.revision_keys, 1);
    assert.equal(receipt.retained_source_inspection.milestones.exact_duplicate_keys, 1);
    assert.equal(receipt.retained_source_inspection.milestones.revision_keys, 1);
    assert.equal(receipt.joined_projects.some((row) => row.ceqr_key === "24DCP100K"), false);
  });

  it("measures milestone increment and makes a bounded GO without resident ingestion", () => {
    const receipt = build();
    assert.equal(receipt.reconciliation.projects_with_incremental_milestones, 1);
    assert.equal(receipt.joined_projects[0].milestones.rows.length, 3);
    assert.equal(receipt.joined_projects[0].milestones.rows[1].exact_duplicate, true);
    assert.equal(receipt.gate.result, "GO");
    assert.equal(receipt.gate.resident_ingestion_committed, false);
    assert.equal(receipt.gate.current_zap_behavior_changed, false);
  });

  it("does not infer CEQR from EAS, title, description, address, borough, applicant, or geography", () => {
    const receipt = build();
    assert.equal(receipt.joined_projects.some((row) => row.zap_project_id === "EAS_ONLY"), false);
    for (const key of ["23DCP991K", "23DCP992K", "23DCP993K", "23DCP994K", "23DCP995K", "23DCP996K"]) {
      assert.equal(receipt.joined_projects.some((row) => row.ceqr_key === key), false, key);
    }
    assert.equal(receipt.zap_eligibility.eas_action_rows_without_ceqr, 1);
    assert.equal(receipt.zap_eligibility.specimens.eas_never_supplies_key, true);
    assert.equal(receipt.normalization.rejected_join_inputs.includes("EAS action text"), true);
    assert.equal(receipt.reconciliation.unresolved_keys.includes("25DCP049M"), false);
  });
});

describe("committed bounded CEQR observation", () => {
  it("pins dataset schema, ids, vintages, exact counts, and the GO rationale", () => {
    assert.equal(committedReceipt.sources.projects.dataset_id, "gezn-7mgk");
    assert.equal(committedReceipt.sources.milestones.dataset_id, "8fj8-3sgg");
    assert.equal(committedReceipt.sources.projects.rows_updated_at, "2026-08-28T14:05:04.000Z");
    assert.equal(committedReceipt.sources.milestones.rows_updated_at, "2026-08-28T14:05:23.000Z");
    assert.deepEqual(committedReceipt.source_schema.projects, ["ceqr", "project_name", "project_description", "borough", "lead_agency", "url"]);
    assert.deepEqual(committedReceipt.source_schema.milestones, ["ceqr", "project_name", "milestone_name", "milestone_date"]);
    assert.equal(committedReceipt.source_inventory.projects.retained_rows, 15380);
    assert.equal(committedReceipt.source_inventory.projects.duplicate_keys, 14);
    assert.equal(committedReceipt.source_inventory.projects.revision_keys, 14);
    assert.equal(committedReceipt.source_inventory.milestones.retained_rows, 34820);
    assert.equal(committedReceipt.reconciliation.exact_project_matches, 195);
    assert.equal(committedReceipt.reconciliation.joined_milestone_rows, 497);
    assert.equal(committedReceipt.reconciliation.projects_with_incremental_milestones, 180);
    assert.equal(committedReceipt.gate.result, "GO");
    assert.match(committedReceipt.gate.rationale, /195 exact project joins.*180 add milestone history/);
    assert.equal(committedReceipt.gate.resident_ingestion_committed, false);
  });

  it("retains the exact 26DCP139X join and keeps the EAS specimen unjoined", () => {
    const joined = committedReceipt.joined_projects.find((row) => row.ceqr_key === "26DCP139X");
    assert.equal(joined.zap_project_id, "2026X0354");
    assert.equal(joined.project.source_record_id, "row-rxs4~ejga-sk5r");
    assert.equal(joined.milestones.rows[0].source_record_id, "row-2qpe~vxi6~btfn");
    assert.equal(joined.milestones.rows[0].milestone_name, "Type II Memo");
    const eas = committedReceipt.zap_eligibility.specimens.project_2026K0123;
    assert.equal(eas.ulurp_numbers, null);
    assert.match(eas.actions, /EAS/);
    assert.equal(eas.retained_ceqr_key, "78DCP250K");
    assert.equal(eas.exact_ceqr_project_join, false);
    assert.equal(eas.inferred_from_eas, false);
  });
});
