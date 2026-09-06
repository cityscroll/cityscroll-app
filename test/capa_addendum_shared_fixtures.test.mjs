import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { reconcileDerivedArchitectureEvidence } from "../tools/architecture_evidence_shards.mjs";
import {
  CAPA_ADDENDUM_FIXTURE_IDS,
  evaluateCapaAddendumFixtures,
} from "../tools/capa_addendum_eval.mjs";
import coverageReceipt from "../docs/evidence/rules-petition-handoff/coverage.json" with { type: "json" };

const manifest = JSON.parse(readFileSync(new URL("./fixtures/capa_addendum/shared_fixtures.v1.json", import.meta.url), "utf8"));

test("the CAPA addendum shared fixture matrix covers the seven required cases", () => {
  assert.deepEqual(manifest.fixtures.map((fixture) => fixture.id), [...CAPA_ADDENDUM_FIXTURE_IDS]);
  assert.ok(manifest.fixtures.some((fixture) => fixture.real_nyc_rules === true && fixture.id === "effective_in_force"));
  assert.ok(manifest.fixtures.some((fixture) => fixture.id === "agency_no_active_proposal"));
});

test("the shared matrix proves handoff, source, and absence behavior without auto-submission", () => {
  const result = evaluateCapaAddendumFixtures(manifest);
  assert.equal(result.pass, true, result.findings.join("\n"));
  assert.equal(result.auto_submission?.cityscroll_submits ?? result.coverage.auto_submission.cityscroll_submits, 0);
  assert.equal(result.coverage.auto_submission.tracks_submission, 0);
  const byId = Object.fromEntries(result.fixtures.map((row) => [row.id, row]));
  assert.equal(byId.proposed_comments_open_hearing.petition_action_target, "no_supported_workflow");
  assert.equal(byId.comment_deadline_passed.petition_action_target, "no_supported_workflow");
  assert.equal(byId.adopted_future_effective.petition_action_target, "no_supported_workflow");
  // Rule surfaces for an institution with no indexed petition procedure keep
  // the official handoff as general guidance; only the institution that
  // publishes its own procedure reaches an exact target.
  assert.equal(byId.effective_in_force.petition_action_target, "action_only_guidance");
  assert.equal(byId.source_stated_citations.petition_action_target, "action_only_guidance");
  assert.equal(byId.agency_no_active_proposal.petition_action_target, "exact_petition_target");
  assert.equal(byId.agency_no_active_proposal.petition_procedure_basis, "institution_procedure");
  assert.deepEqual(result.coverage.action_targets, coverageReceipt.action_targets);
  assert.deepEqual(result.coverage.response_expectation, coverageReceipt.response_expectation);
  assert.deepEqual(result.coverage.contacts, coverageReceipt.contacts);
  assert.deepEqual(result.coverage.petition_contract, coverageReceipt.petition_contract);
  assert.equal(result.coverage.workflow_by_procedure_mode.rulemaking_petition.missing_workflow_is_not_unavailable, true);
  assert.deepEqual(result.coverage.workflow_by_procedure_mode.rulemaking_petition.form_vintages, ["2025-06"]);
  assert.deepEqual(result.coverage.workflow_by_procedure_mode.rulemaking_petition.guidance_vintages, ["2026-02"]);
});

test("architecture-evidence projections include the petition-handoff card", () => {
  const result = reconcileDerivedArchitectureEvidence();
  assert.equal(result.status, "PASS", result.findings.join("; "));
  assert.equal(
    result.evidence.projections["site/rules_petition.mjs"].represented_card_ids.includes(
      "cityscroll-rules-decrol/rd-m5",
    ),
    true,
  );
});
