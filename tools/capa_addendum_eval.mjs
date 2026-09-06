/**
 * Shared CAPA addendum fixture evaluation. The seven cases are a cross-card
 * contract: lifecycle actions, petition handoff, honest absence, and
 * source-stated citations.
 */

import { buildAgencyConstellationView } from "../site/agency_constellation_model.mjs";
import { renderAgencyConstellationDocument } from "../site/agency_constellation.mjs";
import { buildPetitionHandoff, measurePetitionCoverage } from "../site/rules_petition.mjs";
import { renderRulemakingDocument } from "../site/rulemaking_document.mjs";
import { buildRulemakingObjects } from "../worker/src/lib/rulemaking.mjs";

export const CAPA_ADDENDUM_MATRIX_SCHEMA = "cityscroll.capa_addendum_shared_fixtures.v1";
export const CAPA_ADDENDUM_FIXTURE_IDS = Object.freeze([
  "proposed_comments_open_hearing",
  "comment_deadline_passed",
  "adopted_future_effective",
  "effective_in_force",
  "sparse_proposal_missing_hearing",
  "agency_no_active_proposal",
  "source_stated_citations",
]);

function actionIds(object) {
  return (object?.interaction?.kinetic_actions || []).map((action) => {
    const label = String(action?.label || "");
    const kind = String(action?.kind || "");
    if (kind === "comment" || /^comment$/i.test(label)) return "comment";
    if (kind === "attend" || /attend hearing/i.test(label)) return "attend_hearing";
    if (kind === "testify") return "testify";
    if (kind === "petition" || /petition/i.test(label)) return "petition";
    if (/watch for adoption/i.test(label)) return "watch_adoption";
    if (/watch for effective/i.test(label)) return "watch_effective";
    if (/watch this rulemaking/i.test(label)) return "watch_rulemaking";
    if (/read final rule/i.test(label)) return "read_final";
    if (/read proposed rule|open proposed rule/i.test(label)) return "read_proposed";
    return action?.id || kind || label;
  }).filter(Boolean);
}

function hasAction(object, id) {
  return actionIds(object).includes(id);
}

function htmlHas(html, pattern) {
  return pattern.test(html || "");
}

function evaluateRulemakingFixture(fixture) {
  const objects = buildRulemakingObjects(fixture.rows, { now: fixture.now });
  const object = objects[0] || null;
  const html = object ? renderRulemakingDocument(object, { now: fixture.now }) : "";
  const petition = object?.petition_handoff || buildPetitionHandoff({
    entry_point: "effective_rule",
    lifecycle_state: object?.lifecycle_state || fixture.expected?.lifecycle_state,
  });
  return { object, html, petition, kind: "rulemaking" };
}

function evaluateAgencyFixture(fixture) {
  const view = buildAgencyConstellationView(fixture.agency, fixture.sources || {});
  const html = view ? renderAgencyConstellationDocument(view) : "";
  const petition = view?.petition_handoff || null;
  return { view, html, petition, kind: "agency" };
}

function expectedFindings(fixture, result) {
  const findings = [];
  const expected = fixture.expected || {};
  if (result.kind === "rulemaking") {
    const object = result.object;
    if (!object) {
      findings.push(`${fixture.id}: missing rulemaking object`);
      return findings;
    }
    if (expected.lifecycle_state && object.lifecycle_state !== expected.lifecycle_state) {
      findings.push(`${fixture.id}: lifecycle ${object.lifecycle_state} != ${expected.lifecycle_state}`);
    }
    for (const id of expected.actions || []) {
      if (!hasAction(object, id)) findings.push(`${fixture.id}: missing action ${id}`);
    }
    for (const id of expected.forbidden_actions || []) {
      if (hasAction(object, id)) findings.push(`${fixture.id}: stale action ${id}`);
    }
    for (const pattern of expected.html_matches || []) {
      if (!htmlHas(result.html, new RegExp(pattern))) findings.push(`${fixture.id}: missing copy /${pattern}/`);
    }
    for (const pattern of expected.html_forbids || []) {
      if (htmlHas(result.html, new RegExp(pattern))) findings.push(`${fixture.id}: forbidden copy /${pattern}/`);
    }
    if (expected.petition_action_target && object.petition_handoff?.action_target !== expected.petition_action_target) {
      findings.push(`${fixture.id}: petition target ${object.petition_handoff?.action_target} != ${expected.petition_action_target}`);
    }
    if (expected.petition_procedure_basis && object.petition_handoff?.procedure_basis !== expected.petition_procedure_basis) {
      findings.push(`${fixture.id}: procedure basis ${object.petition_handoff?.procedure_basis} != ${expected.petition_procedure_basis}`);
    }
    if (expected.citations_basis === "source_stated") {
      const effects = object.legal_effects || [];
      if (!effects.length) findings.push(`${fixture.id}: missing source-stated citations`);
      if (effects.some((effect) => effect.basis && effect.basis !== "source_stated")) {
        findings.push(`${fixture.id}: citation basis is not source_stated`);
      }
      if (htmlHas(result.html, /legal diff|computed diff|CityScroll determined the legal effect/i)) {
        findings.push(`${fixture.id}: pretended to provide a legal diff`);
      }
    }
    if (expected.no_invented_hearing && hasAction(object, "attend_hearing")) {
      findings.push(`${fixture.id}: invented hearing action`);
    }
  } else {
    const view = result.view;
    if (!view) {
      findings.push(`${fixture.id}: missing agency view`);
      return findings;
    }
    if (expected.petition_action_target && view.petition_handoff?.action_target !== expected.petition_action_target) {
      findings.push(`${fixture.id}: petition target ${view.petition_handoff?.action_target} != ${expected.petition_action_target}`);
    }
    if (expected.petition_procedure_basis && view.petition_handoff?.procedure_basis !== expected.petition_procedure_basis) {
      findings.push(`${fixture.id}: procedure basis ${view.petition_handoff?.procedure_basis} != ${expected.petition_procedure_basis}`);
    }
    for (const pattern of expected.html_matches || []) {
      if (!htmlHas(result.html, new RegExp(pattern))) findings.push(`${fixture.id}: missing copy /${pattern}/`);
    }
    for (const pattern of expected.html_forbids || []) {
      if (htmlHas(result.html, new RegExp(pattern))) findings.push(`${fixture.id}: forbidden copy /${pattern}/`);
    }
  }
  const html = result.html || "";
  if (/<form\b|type="submit"|cityscroll_submits["']?\s*:\s*true/i.test(html)) {
    findings.push(`${fixture.id}: auto-submission affordance`);
  }
  if (result.petition?.submission?.cityscroll_submits || result.petition?.submission?.tracks_submission) {
    findings.push(`${fixture.id}: submission tracking claimed`);
  }
  return findings;
}

export function evaluateCapaAddendumFixtures(manifest) {
  const fixtures = Array.isArray(manifest?.fixtures) ? manifest.fixtures : [];
  const results = [];
  const findings = [];
  const ids = fixtures.map((fixture) => fixture.id);
  for (const id of CAPA_ADDENDUM_FIXTURE_IDS) {
    if (!ids.includes(id)) findings.push(`missing shared fixture ${id}`);
  }
  const realNycRules = fixtures.filter((fixture) => fixture.real_nyc_rules === true);
  if (!realNycRules.length) findings.push("missing real NYC Rules end-to-end fixture");
  for (const fixture of fixtures) {
    const result = fixture.kind === "agency"
      ? evaluateAgencyFixture(fixture)
      : evaluateRulemakingFixture(fixture);
    const fixtureFindings = expectedFindings(fixture, result);
    findings.push(...fixtureFindings);
    results.push({
      id: fixture.id,
      kind: result.kind,
      pass: fixtureFindings.length === 0,
      lifecycle_state: result.object?.lifecycle_state || null,
      action_ids: result.object ? actionIds(result.object) : [],
      petition_action_target: result.petition?.action_target || null,
      petition_procedure_basis: result.petition?.procedure_basis || null,
      handoff: result.petition,
      html: result.html,
      findings: fixtureFindings,
    });
  }
  const coverage = measurePetitionCoverage(results.map((row) => ({ handoff: row.handoff })));
  return Object.freeze({
    schema: CAPA_ADDENDUM_MATRIX_SCHEMA,
    pass: findings.length === 0,
    findings: Object.freeze(findings),
    fixtures: Object.freeze(results.map((row) => Object.freeze({
      id: row.id,
      kind: row.kind,
      pass: row.pass,
      lifecycle_state: row.lifecycle_state,
      action_ids: Object.freeze(row.action_ids),
      petition_action_target: row.petition_action_target,
      petition_procedure_basis: row.petition_procedure_basis,
      findings: Object.freeze(row.findings),
    }))),
    coverage,
  });
}
