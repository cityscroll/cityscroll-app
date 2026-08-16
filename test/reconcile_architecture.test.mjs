import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildFacts } from "../tools/build_architecture_facts.mjs";
import {
  apparentSupersededAdrs,
  buildReport,
  parseAdr,
  parseWorkspace,
  reconcileArchitecture,
} from "../tools/reconcile_architecture.mjs";

const modelText = readFileSync(new URL("../architecture/workspace.dsl", import.meta.url), "utf8");
const facts = buildFacts({ generatedAt: "2026-08-16T00:00:00Z", commit: "test-commit" });

test("fresh repository facts reconcile with the C4 model and ADRs", () => {
  const report = buildReport({ facts });
  assert.equal(report.status, "healthy");
  assert.deepEqual(report.outcomes.additions, []);
  assert.deepEqual(report.outcomes.removals, []);
  assert.deepEqual(report.outcomes.contradictions, []);
  assert.deepEqual(report.outcomes.superseded_adrs, []);
  assert.deepEqual(report.facts, {
    source: "generated_in_memory",
    regenerated_commit: "test-commit",
  });
});

test("parses stable C4 declarations and relationships", () => {
  const model = parseWorkspace(modelText);
  assert.ok(model.elements.some((element) => element.id === "worker_api" && element.type === "container"));
  assert.ok(model.elements.some((element) => element.id === "r2_source_vault"));
  assert.ok(model.relationships.some((relationship) => relationship.source === "worker_api" && relationship.target === "r2_source_vault"));
});

test("keeps an absent source binding as null", () => {
  const report = reconcileArchitecture({
    facts,
    baselineFacts: facts,
    model: parseWorkspace(modelText),
  });
  assert.deepEqual(report.source_nulls.find((item) => item.path.endsWith("production.r2_buckets")), {
    path: "bindings.environments.production.r2_buckets",
    value: null,
  });
  assert.equal(report.outcomes.contradictions.length, 0);
});

test("flags an active binding missing from the C4 model without inventing rationale", () => {
  const model = parseWorkspace(modelText.replace(/\n\s*kv_subs = container[^\n]+/, ""));
  const report = reconcileArchitecture({ facts, baselineFacts: facts, model });
  const finding = report.outcomes.additions.find((item) => item.target === "kv_subs (SUBS)");
  assert.ok(finding);
  assert.equal(finding.rationale, null);
  assert.equal(finding.rationale_status, "rationale required");
  assert.equal(report.proposals.find((item) => item.target === finding.target).rationale, null);
});

test("flags a model state contradiction separately from additions and removals", () => {
  const activeFacts = structuredClone(facts);
  activeFacts.bindings.environments.production.r2_buckets = [{ binding: "SOURCE_VAULT", bucket_name: "source-vault" }];
  const report = reconcileArchitecture({ facts: activeFacts, baselineFacts: activeFacts, model: parseWorkspace(modelText) });
  assert.ok(report.outcomes.contradictions.some((item) => item.target === "r2_source_vault (SOURCE_VAULT)"));
  assert.equal(report.outcomes.additions.length, 0);
  assert.equal(report.outcomes.removals.length, 0);
});

test("detects ADR status and supersession references", () => {
  const oldAdr = parseAdr("docs/adr/old-choice.md", "| Status | Accepted |\n| Supersedes | — |\n");
  const currentAdr = parseAdr("docs/adr/current-choice.md", "| Status | Accepted |\n| Supersedes | old-choice |\n");
  const deprecatedAdr = parseAdr("docs/adr/deprecated.md", "| Status | Superseded |\n| Supersedes | — |\n");
  const results = apparentSupersededAdrs([oldAdr, currentAdr, deprecatedAdr]);
  assert.ok(results.some((item) => item.path === oldAdr.path && item.superseded_by === currentAdr.path));
  assert.ok(results.some((item) => item.path === deprecatedAdr.path && item.status === "Superseded"));
});
