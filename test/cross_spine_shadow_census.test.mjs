import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildMandateMeetingsView } from "../site/mandate_meetings_bridge.mjs";
import { buildCrossSpineShadowCensus } from "../tools/build_cross_spine_shadow_census.mjs";

const json = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

function productionSources() {
  return {
    obligations: json("../site/data/agency_obligations_lookup.json"),
    intelligence: json("../site/data/entity_intelligence_lookup.json"),
    meetings: json("../site/data/meetings_domain_observations.json"),
    rules: json("../site/data/rules_domain_observations.json"),
    processConformance: json("../site/data/process_conformance_lookup.json"),
    land: json("../site/data/zap_projects_warehouse_lookup.json"),
    procurementAwards: json("../site/data/ocp_awards_warehouse_lookup.json"),
    gate: json("../site/data/cross_spine_edge_gate.json"),
  };
}

function meetingPopulation(sources) {
  const views = Object.keys(sources.obligations.by_agency).map((id) => buildMandateMeetingsView(id, {
    obligationsLookup: sources.obligations, meetingsDomain: sources.meetings, crossSpineGate: sources.gate,
  }));
  const reasons = views.flatMap((view) => view.shadow_edges.flatMap((edge) => Array.isArray(edge.reason) ? edge.reason : [edge.reason]));
  return {
    totals: { public_inferred: views.reduce((n, view) => n + view.edges.length, 0), evidence_only: views.reduce((n, view) => n + view.shadow_edges.length, 0) },
    subject: reasons.filter((reason) => reason === "matter_body_subject").length,
    temporal: reasons.filter((reason) => reason === "temporal").length,
  };
}

test("production shadow census reproduces the committed bridge baseline", () => {
  const sources = productionSources();
  const receipt = buildCrossSpineShadowCensus(sources);
  assert.deepEqual(receipt, json("../site/data/cross_spine_shadow_census.json"));
  assert.deepEqual(Object.fromEntries(Object.entries(receipt.relations).map(([key, value]) => [key, value.totals])), {
    mandate_meeting: meetingPopulation(sources).totals,
    // PC-04: LPC's 9 landmark-designation obligation/action pairs resolve on
    // the closed action-family identity basis; Housing Preservation and
    // Development's 4 non-land-use "disposition" false positives correctly
    // remain evidence-only for lacking both project identity and phase.
    mandate_land_use: { public_inferred: 9, evidence_only: 4 },
    mandate_contract: { public_inferred: 3, evidence_only: 0 },
    // Sanitation CWZ mandate_rule public edge after rule-attachment densify.
    mandate_rule: { public_inferred: 1, evidence_only: 0 },
  });
  for (const relation of Object.values(receipt.relations)) {
    assert.ok(relation.denominators.pre_route_pairs >= relation.totals.public_inferred + relation.totals.evidence_only);
  }
});

test("census output is redacted to ids, counts, source names, and enum reasons", () => {
  const sources = productionSources();
  const population = meetingPopulation(sources);
  const receipt = buildCrossSpineShadowCensus(sources);
  const text = JSON.stringify(receipt);
  assert.doesNotMatch(text, /duty_text|source_excerpt|notice body|contact|subject_scope|candidate/i);
  assert.equal(receipt.relations.mandate_meeting.by_reason.matter_body_subject, population.subject);
  assert.equal(receipt.relations.mandate_meeting.by_reason.temporal, population.temporal);
  assert.equal(receipt.relations.mandate_meeting.totals.public_inferred, population.totals.public_inferred);
  assert.equal(receipt.relations.mandate_land_use.by_reason.project_identity, 4);
  assert.equal(receipt.relations.mandate_land_use.by_reason.mandate_phase_compatible, 4);
});


test("historical meeting census retains the reviewed population and redaction reasons", () => {
  const { sources } = json("./fixtures/first-class-refresh/historical-shadow-meetings.json");
  const receipt = buildCrossSpineShadowCensus(sources);
  assert.deepEqual(receipt.relations.mandate_meeting.totals, { public_inferred: 3, evidence_only: 60 });
  assert.equal(receipt.relations.mandate_meeting.by_reason.matter_body_subject, 60);
  assert.equal(receipt.relations.mandate_meeting.by_reason.temporal, 52);
  assert.doesNotMatch(JSON.stringify(receipt), /duty_text|source_excerpt|notice body|contact|subject_scope|candidate/i);
  assert.deepEqual(meetingPopulation(sources), { totals: { public_inferred: 3, evidence_only: 60 }, subject: 60, temporal: 52 });
});

test("a new evidence-only meeting changes the census population without becoming a public link", () => {
  const { sources } = json("./fixtures/first-class-refresh/historical-shadow-meetings.json");
  // Controlled source growth, not a claim about another publisher record.
  const row = sources.meetings.rows.find((row) => row.request_id === "20260827001");
  assert.ok(row);
  sources.meetings.rows.push({ ...row, request_id: "fixture-added-meeting", meeting_id: "meeting:city_record:fixture-added-meeting" });
  const receipt = buildCrossSpineShadowCensus(sources);
  assert.deepEqual(receipt.relations.mandate_meeting.totals, { public_inferred: 3, evidence_only: 61 });
  assert.deepEqual(receipt.relations.mandate_meeting.totals, meetingPopulation(sources).totals);
  assert.equal(receipt.relations.mandate_meeting.by_reason.matter_body_subject, 61);
  assert.equal(receipt.relations.mandate_meeting.by_reason.temporal, 52);
  assert.doesNotMatch(JSON.stringify(receipt), /duty_text|source_excerpt|notice body|contact|subject_scope|candidate/i);
});
