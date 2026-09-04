import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  SEQRA_ONTOLOGY_ENTITY_TYPES,
  SEQRA_ONTOLOGY_RELATIONS,
  buildEntityJsonSchema,
  validateSeqraEntity,
} from "../warehouse/lib/seqra_ontology_spec.mjs";
import { validateOntologyGraph } from "../warehouse/lib/seqra_ontology_graph.mjs";
import { SAMPLE_MULTI_BBL_PROJECT_GRAPH, SAMPLE_MULTI_BBL_PROJECT_KEYS } from "../warehouse/fixtures/seqra-ontology/multi_action_multi_bbl_project.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("SEQRA/CEQR ontology: entity schema shapes", () => {
  it("declares exactly the fifteen commissioned core entities", () => {
    assert.deepEqual(
      [...SEQRA_ONTOLOGY_ENTITY_TYPES].sort(),
      [
        "alternative", "case_filing", "claim_theory", "environmental_review", "government_action",
        "judicial_case", "land_use_determination", "mitigation_commitment", "organization", "project",
        "public_position", "review_document", "review_event", "search_coverage", "technical_topic_assessment",
      ].sort(),
    );
  });

  it("every entity spec builds a well-formed JSON Schema document", () => {
    for (const entityType of SEQRA_ONTOLOGY_ENTITY_TYPES) {
      const schema = buildEntityJsonSchema(entityType);
      assert.equal(schema.type, "object");
      assert.equal(schema.additionalProperties, false);
      assert.ok(Array.isArray(schema.required) && schema.required.length > 0, `${entityType}: required list must be non-empty`);
      for (const field of schema.required) {
        assert.ok(field in schema.properties, `${entityType}: required field ${field} must be a declared property`);
      }
    }
  });

  it("the committed warehouse/schemas/seqra_ontology_*.v1.schema.json files are not stale", () => {
    execFileSync(process.execPath, ["tools/build_seqra_ontology_schemas.mjs", "--check"], { cwd: ROOT, stdio: "pipe" });
  });

  it("rejects a project missing a required field", () => {
    const findings = validateSeqraEntity("project", { title: "x" }, "test-project");
    assert.ok(findings.some((f) => f.includes("missing required field project_key")));
  });

  it("rejects an unsupported (additionalProperties) field", () => {
    const findings = validateSeqraEntity("organization", {
      organization_key: "organization:x:y",
      name: "x",
      organization_type: "other",
      observed_at: "2026-01-01T00:00:00.000Z",
      source_id: "s",
      source_record_id: "r",
      unexpected_field: "nope",
    });
    assert.ok(findings.some((f) => f.includes("unsupported field unexpected_field")));
  });

  it("rejects an out-of-enum value", () => {
    const findings = validateSeqraEntity("environmental_review", {
      review_key: "environmental_review:ceqr:26DCP001X",
      action_key: "action:dcp:zap:n_1",
      jurisdiction_level: "CA",
      environmental_regime: "CEQR",
      review_label_as_published: "CEQR",
      judicial_review_regime: "UNKNOWN",
      lead_agency: "DCP",
      ceqr_number: "26DCP001X",
      source_review_id: null,
      observed_at: "2026-01-01T00:00:00.000Z",
      source_id: "s",
      source_record_id: "r",
    });
    assert.ok(findings.some((f) => f.includes("jurisdiction_level")));
  });

  it("accepts a well-formed entity of every type with zero findings", () => {
    const valid = {
      project: {
        project_key: "project:zap:1", title: "t", source_system: "zap", source_project_id: "1", bbl_list: ["1000010001"],
        borough: "Manhattan", observed_at: "2026-01-01T00:00:00.000Z", source_id: "s", source_record_id: "r",
      },
      organization: {
        organization_key: "organization:x:y", name: "x", organization_type: "other",
        observed_at: "2026-01-01T00:00:00.000Z", source_id: "s", source_record_id: "r",
      },
    };
    for (const [entityType, obj] of Object.entries(valid)) {
      assert.deepEqual(validateSeqraEntity(entityType, obj), []);
    }
  });
});

describe("SEQRA/CEQR ontology: required relations", () => {
  it("declares exactly the thirteen commissioned relation edges, each naming known entity types", () => {
    assert.equal(SEQRA_ONTOLOGY_RELATIONS.length, 13);
    for (const { from, relation, to } of SEQRA_ONTOLOGY_RELATIONS) {
      assert.ok(SEQRA_ONTOLOGY_ENTITY_TYPES.includes(from), `relation ${relation} 'from' must be a known entity type, got ${from}`);
      assert.ok(SEQRA_ONTOLOGY_ENTITY_TYPES.includes(to), `relation ${relation} 'to' must be a known entity type, got ${to}`);
    }
    const requiredRelationNames = [
      "requires_action", "reviews_action", "has_document", "has_event", "has_topic_assessment",
      "has_mitigation", "considers_alternative", "takes_position", "concerns_review", "relies_on_review",
      "challenges_determination", "supersedes_document", "decision_supersedes",
    ];
    assert.deepEqual(SEQRA_ONTOLOGY_RELATIONS.map((r) => r.relation).sort(), requiredRelationNames.sort());
  });
});

describe("SEQRA/CEQR ontology: relation-integrity validation", () => {
  it("a well-formed multi-action, multi-review, multi-BBL project graph has zero findings", () => {
    const findings = validateOntologyGraph(SAMPLE_MULTI_BBL_PROJECT_GRAPH);
    assert.deepEqual(findings, []);
  });

  it("the fixture keeps a distinct government_action per BBL-bearing action, not collapsed into one review", () => {
    assert.equal(SAMPLE_MULTI_BBL_PROJECT_GRAPH.government_action.length, 2);
    assert.equal(SAMPLE_MULTI_BBL_PROJECT_GRAPH.environmental_review.length, 2);
    assert.equal(SAMPLE_MULTI_BBL_PROJECT_GRAPH.project[0].bbl_list.length, 2);
    const regimes = SAMPLE_MULTI_BBL_PROJECT_GRAPH.environmental_review.map((r) => r.environmental_regime).sort();
    assert.deepEqual(regimes, ["CEQR", "SEQRA"]);
    // CEQR and state-led SEQRA stay separately identifiable even under one project.
    assert.notEqual(SAMPLE_MULTI_BBL_PROJECT_KEYS.REVIEW_CEQR, SAMPLE_MULTI_BBL_PROJECT_KEYS.REVIEW_SEQRA);
  });

  it("flags a dangling foreign key instead of silently accepting it", () => {
    const broken = {
      ...SAMPLE_MULTI_BBL_PROJECT_GRAPH,
      government_action: SAMPLE_MULTI_BBL_PROJECT_GRAPH.government_action.map((action, index) =>
        index === 0 ? { ...action, project_key: "project:zap:does-not-exist" } : action),
    };
    const findings = validateOntologyGraph(broken);
    assert.ok(findings.some((f) => f.includes("does not resolve to a known project")));
  });

  it("flags a duplicate primary key within one entity type", () => {
    const broken = {
      organization: [
        { organization_key: "organization:x:y", name: "a", organization_type: "other", observed_at: "2026-01-01T00:00:00.000Z", source_id: "s", source_record_id: "r1" },
        { organization_key: "organization:x:y", name: "b", organization_type: "other", observed_at: "2026-01-01T00:00:00.000Z", source_id: "s", source_record_id: "r2" },
      ],
    };
    const findings = validateOntologyGraph(broken);
    assert.ok(findings.some((f) => f.includes("duplicate organization_key")));
  });
});

describe("SEQRA/CEQR ontology: California/CEQA rejection stays green alongside the ontology", () => {
  it("the SEQRA-01 scope classifier still rejects every California/CEQA fixture", async () => {
    const { summarizeScopeClassification } = await import("../warehouse/lib/seqra_scope_classifier.mjs");
    const { SEQRA_JURISDICTION_FIXTURE_BATCH } = await import("../warehouse/fixtures/seqra-inventory/jurisdiction_fixture_batch.mjs");
    const summary = summarizeScopeClassification(SEQRA_JURISDICTION_FIXTURE_BATCH);
    assert.equal(summary.california_or_ceqa_admitted_count, 0);
  });
});
