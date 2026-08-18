import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildFacts } from "../tools/build_architecture_facts.mjs";
import {
  WATERMARK_RELATIVE,
  buildWatermark,
} from "../tools/architecture_watermark.mjs";
import {
  apparentSupersededAdrs,
  buildReport,
  parseAdr,
  parseWorkspace,
  reconcileArchitecture,
} from "../tools/reconcile_architecture.mjs";

const modelText = readFileSync(new URL("../architecture/workspace.dsl", import.meta.url), "utf8");
const facts = buildFacts({ generatedAt: "2026-08-16T00:00:00Z", commit: "test-commit" });

test("fresh repository facts reconcile with the C4 model, ADRs, and committed watermark", () => {
  assert.deepEqual(facts.observer_coverage.unmapped_surfaces, []);
  const report = buildReport({ facts });
  assert.equal(report.status, "healthy");
  assert.deepEqual(report.outcomes.additions, []);
  assert.deepEqual(report.outcomes.removals, []);
  assert.deepEqual(report.outcomes.contradictions, []);
  assert.deepEqual(report.outcomes.unmapped, []);
  assert.deepEqual(report.outcomes.superseded_adrs, []);
  assert.deepEqual(report.facts, {
    source: "generated_in_memory",
    regenerated_commit: "test-commit",
    baseline: WATERMARK_RELATIVE,
  });
});

test("an unmapped architecture-affecting search surface is drift, not healthy", () => {
  // Detector regression: an injected unmapped production-search canary is
  // drift even when topology is unchanged (facts compared to themselves).
  const searchFacts = structuredClone(facts);
  searchFacts.observer_coverage = {
    source: { path: "architecture/observer-canaries.json" },
    observed_paths: [...facts.source_paths],
    known_canaries: [
      { id: "production-search", path: "worker/src/search.mjs" },
      { id: "worker-bindings", path: "worker/wrangler.toml" },
    ],
    unmapped_surfaces: [
      { id: "production-search", path: "worker/src/search.mjs" },
    ],
  };

  const report = reconcileArchitecture({
    facts: searchFacts,
    baselineFacts: searchFacts,
    model: parseWorkspace(modelText),
  });

  assert.notEqual(report.status, "healthy");
  assert.equal(report.status, "drift");
  assert.ok(Array.isArray(report.outcomes.unmapped));
  const finding = report.outcomes.unmapped.find((item) =>
    item.target.includes("production-search") || item.target.includes("worker/src/search.mjs"));
  assert.ok(finding, "expected an unmapped/unknown_surface outcome for production-search");
  assert.equal(finding.type, "unknown_surface");
  assert.equal(finding.rationale, null);
  assert.equal(finding.rationale_status, "rationale required");
  assert.equal(finding.source, "observer_coverage.unmapped_surfaces");
  assert.ok(report.proposals.some((item) => item.type === "unknown_surface" && item.target === finding.target));
  assert.deepEqual(report.outcomes.additions, []);
  assert.deepEqual(report.outcomes.removals, []);
  assert.deepEqual(report.outcomes.contradictions, []);
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

test("a changed canary fingerprint versus the committed watermark is drift", () => {
  const watermark = buildWatermark(facts);
  const drifted = structuredClone(watermark);
  assert.ok(drifted.canaries["production-search"]);
  drifted.canaries["production-search"].fingerprint = "0".repeat(64);
  const report = reconcileArchitecture({
    facts,
    baselineFacts: drifted,
    model: parseWorkspace(modelText),
  });
  assert.equal(report.status, "drift");
  const finding = report.outcomes.contradictions.find((item) =>
    item.target === "facts:canaries.production-search.fingerprint");
  assert.ok(finding, "expected a fingerprint contradiction for production-search");
  assert.equal(finding.type, "contradiction");
  assert.equal(finding.before, "0".repeat(64));
  assert.equal(finding.after, watermark.canaries["production-search"].fingerprint);
  assert.equal(finding.rationale, null);
  assert.equal(finding.rationale_status, "rationale required");
  assert.equal(report.schema, "cityscroll.architecture.reconciliation.v1");
  assert.deepEqual(report.outcomes.unmapped, []);
});

test("current facts that diverge from the committed watermark are drift", () => {
  const mutated = structuredClone(facts);
  mutated.search.production.collection_families = [
    ...mutated.search.production.collection_families,
    { lens: "invented", family: "invented" },
  ];
  const report = buildReport({ facts: mutated });
  assert.equal(report.status, "drift");
  assert.ok(report.outcomes.contradictions.some((item) =>
    item.target === "facts:canaries.production-search.fingerprint"
    || item.target === "facts:canaries.production-search.count"));
});

test("a matching compact watermark keeps the healthy path green", () => {
  const report = reconcileArchitecture({
    facts,
    baselineFacts: buildWatermark(facts),
    model: parseWorkspace(modelText),
  });
  assert.equal(report.status, "healthy");
  assert.deepEqual(report.outcomes.additions, []);
  assert.deepEqual(report.outcomes.removals, []);
  assert.deepEqual(report.outcomes.contradictions, []);
});

test("a missing committed watermark is drift, not a self-compare healthy", () => {
  const emptyRoot = mkdtempSync(join(tmpdir(), "la9-watermark-"));
  try {
    const report = reconcileArchitecture({
      facts,
      model: parseWorkspace(modelText),
      root: emptyRoot,
    });
    assert.equal(report.status, "drift");
    const finding = report.outcomes.contradictions.find((item) => item.target === WATERMARK_RELATIVE);
    assert.ok(finding);
    assert.equal(finding.before, null);
  } finally {
    rmSync(emptyRoot, { recursive: true, force: true });
  }
});

test("--check does not advance the committed watermark", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const committed = join(root, WATERMARK_RELATIVE);
  const before = readFileSync(committed);
  const outputDir = mkdtempSync(join(tmpdir(), "la9-reconcile-"));
  try {
    const result = spawnSync(process.execPath, [
      "tools/reconcile_architecture.mjs",
      "--check",
      "--output-dir",
      outputDir,
    ], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const written = JSON.parse(readFileSync(join(outputDir, "reconciliation.json"), "utf8"));
    assert.equal(written.schema, "cityscroll.architecture.reconciliation.v1");
    assert.equal(written.status, "healthy");
    assert.equal(written.facts.baseline, WATERMARK_RELATIVE);
    assert.equal(existsSync(join(outputDir, "watermark.json")), false);
    assert.deepEqual(readFileSync(committed), before);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test("detects ADR status and supersession references", () => {
  const oldAdr = parseAdr("docs/adr/old-choice.md", "| Status | Accepted |\n| Supersedes | — |\n");
  const currentAdr = parseAdr("docs/adr/current-choice.md", "| Status | Accepted |\n| Supersedes | old-choice |\n");
  const deprecatedAdr = parseAdr("docs/adr/deprecated.md", "| Status | Superseded |\n| Supersedes | — |\n");
  const results = apparentSupersededAdrs([oldAdr, currentAdr, deprecatedAdr]);
  assert.ok(results.some((item) => item.path === oldAdr.path && item.superseded_by === currentAdr.path));
  assert.ok(results.some((item) => item.path === deprecatedAdr.path && item.status === "Superseded"));
});
