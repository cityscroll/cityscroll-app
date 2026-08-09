import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildCrossSpineShadowCensus } from "../tools/build_cross_spine_shadow_census.mjs";

const json = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

test("production shadow census reproduces the committed bridge baseline", () => {
  const sources = {
    obligations: json("../site/data/agency_obligations_lookup.json"),
    intelligence: json("../site/data/entity_intelligence_lookup.json"),
    meetings: json("../site/data/meetings_domain_observations.json"),
    rules: json("../site/data/rules_domain_observations.json"),
    processConformance: json("../site/data/process_conformance_lookup.json"),
    land: json("../site/data/zap_projects_warehouse_lookup.json"),
    gate: json("../site/data/cross_spine_edge_gate.json"),
  };
  const receipt = buildCrossSpineShadowCensus(sources);
  assert.deepEqual(Object.fromEntries(Object.entries(receipt.relations).map(([key, value]) => [key, value.totals])), {
    mandate_meeting: { public_inferred: 3, evidence_only: 48 },
    mandate_land_use: { public_inferred: 0, evidence_only: 9 },
    mandate_contract: { public_inferred: 1, evidence_only: 0 },
    mandate_rule: { public_inferred: 0, evidence_only: 0 },
  });
  for (const relation of Object.values(receipt.relations)) {
    assert.ok(relation.denominators.pre_route_pairs >= relation.totals.public_inferred + relation.totals.evidence_only);
  }
});

test("census output is redacted to ids, counts, source names, and enum reasons", () => {
  const receipt = buildCrossSpineShadowCensus();
  const text = JSON.stringify(receipt);
  assert.doesNotMatch(text, /duty_text|source_excerpt|notice body|contact|subject_scope|candidate/i);
  assert.equal(receipt.relations.mandate_meeting.by_reason.matter_body_subject, 48);
  assert.equal(receipt.relations.mandate_meeting.by_reason.temporal, 44);
  assert.equal(receipt.relations.mandate_meeting.totals.public_inferred, 3);
  assert.equal(receipt.relations.mandate_land_use.by_reason.project_identity, 9);
});
