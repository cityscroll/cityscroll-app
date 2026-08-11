import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { measureRc2DependentFields } from "../tools/measure_rc2_dependent_fields.mjs";
import {
  parseNYCIDAProjects,
  assembleSubsidyLifecycle,
} from "../worker/src/lib/subsidy_lifecycle.mjs";
import { buildSubsidyProjectPanelView, subsidyProjectPanelHTML } from "../site/subsidy_project_panel.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOOKUP = JSON.parse(
  readFileSync(path.join(ROOT, "site/data/subsidy_project_lookup.json"), "utf8"),
);
const RECEIPT = JSON.parse(
  readFileSync(
    path.join(
      ROOT,
      "site/data/nycedc_sources/verification_receipts/rc2_dependent_field_coverage_2026-08-11.json",
    ),
    "utf8",
  ),
);

test("RC-2 dependent field coverage receipt matches the accepted lookup", () => {
  const measured = measureRc2DependentFields(LOOKUP);
  assert.equal(measured.schema, "cityscroll.rc2_dependent_field_coverage.v1");
  assert.equal(measured.parent_receipt.bridge_status, "accepted");
  assert.equal(measured.parent_receipt.join_rate, 0.4167);
  assert.equal(measured.fields.company.rate, 1);
  assert.equal(measured.fields.address.rate, 1);
  assert.equal(measured.stages.board_decision.date_rate, 1);
  assert.equal(measured.stages.board_decision.outcome_rate, 1);
  assert.equal(measured.stages.closing.date_rate, 0);
  assert.equal(measured.verdict.company_place_ready, true);
  assert.equal(measured.verdict.board_decision_ready, true);
  assert.equal(measured.verdict.later_stages_honest_absent, true);
  assert.deepEqual(measured, RECEIPT);
});

test("measure tool --check is deterministic against the committed receipt", () => {
  const result = spawnSync(
    process.execPath,
    ["tools/measure_rc2_dependent_fields.mjs", "--check"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /ok /);
});

test("receipt-backed project_cost flows into lifecycle money without inventing siblings", () => {
  const projects = parseNYCIDAProjects([{
    request_id: "20260313009",
    project_id: "11675",
    project_name: "Brooklyn Friends School",
    company_name: "Brooklyn Friends School",
    project_address: "383 Pearl Street, Brooklyn, NY",
    requested_benefit_amount: 34000000,
    estimated_public_cost: null,
    project_cost: 34000000,
    board_decision_date: "2026-03-24",
    board_decision_outcome: "approved",
    board_decision_url: "https://edc.nyc/sites/default/files/2026-06/BNYC-March-24-2026-board-meeting-minutes_0.pdf",
  }]);
  assert.equal(projects[0].total_project_cost, 34000000);
  assert.equal(projects[0].requested_benefit.status, "matched");
  assert.equal(projects[0].estimated_cost.status, "unknown");

  const [lifecycle] = assembleSubsidyLifecycle([{
    request_id: "20260313009",
    agency_name: "Build NYC Resource Corporation",
    type_of_notice_description: "Public Hearing",
    start_date: "2026-03-13",
    additional_description_1: "Brooklyn Friends School public hearing",
  }], projects);

  assert.equal(lifecycle.join.matched, true);
  assert.equal(lifecycle.money.total_project_cost, 34000000);
  assert.equal(lifecycle.money.requested_benefit.status, "matched");
  assert.equal(lifecycle.money.estimated_cost.status, "unknown");
  assert.equal(lifecycle.company.value, "Brooklyn Friends School");
});

test("project panel renders source-stated project cost and omits null money slots", () => {
  const identity = [{
    receipt_backed: true,
    join_confidence: 1,
    project_name: "Example School",
    company: "Example School",
    address: "1 Example Street, Brooklyn, NY",
    project_cost: 12_500_000,
    requested_benefit: null,
    estimated_public_cost: null,
    lifecycle_dates: [{ stage: "board_decision", date: "2026-03-24", outcome: "approved" }],
    official_documents_url: "https://edc.nyc/sites/default/files/example.pdf",
  }];
  const view = buildSubsidyProjectPanelView({ project_identity: identity });
  assert.equal(view.projects[0].project_cost, 12_500_000);
  const html = subsidyProjectPanelHTML({ project_identity: identity });
  assert.match(html, /Total project cost/);
  assert.match(html, /\$12,500,000/);
  assert.doesNotMatch(html, /Requested benefit|Estimated public cost/);
  assert.doesNotMatch(html, /not available|unknown|city does not publish/i);
});
