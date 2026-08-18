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
const residentReadPolicy = JSON.parse(readFileSync(
  new URL("../architecture/resident-read-policy.json", import.meta.url),
  "utf8",
));
const facts = buildFacts({ generatedAt: "2026-08-16T00:00:00Z", commit: "test-commit" });

test("fresh repository facts reconcile with the C4 model and ADRs", () => {
  // Current-tree consistency uses the live watermark projection. Match
  // against the committed file is reconcile_architecture --check, not Unit.
  assert.deepEqual(facts.observer_coverage.unmapped_surfaces, []);
  const report = reconcileArchitecture({
    facts,
    baselineFacts: buildWatermark(facts),
    model: parseWorkspace(modelText),
  });
  assert.equal(report.status, "healthy");
  assert.deepEqual(report.outcomes.additions, []);
  assert.deepEqual(report.outcomes.removals, []);
  assert.deepEqual(report.outcomes.contradictions, []);
  assert.deepEqual(report.outcomes.unmapped, []);
  assert.deepEqual(report.outcomes.superseded_adrs, []);
});

test("a root narrative assertion of request-time publisher reads is doc invariant drift", () => {
  const report = buildReport({
    facts,
    baselineFacts: buildWatermark(facts),
    architectureNarrative: [
      "# Architecture",
      "",
      "The browser can read public Socrata and geospatial sources directly for selected live or hybrid views.",
      "A materialized read may use a bounded live fallback where the source contract allows it.",
      "Committed site data makes common views predictable; live upstream calls remain for interactive freshness or a documented fallback.",
      "A default lens reads committed data, then may refresh a live source according to its source contract.",
      "Hydration can ask the Worker for a materialized read model or exact external lookup.",
      "Source contracts define whether freshness favors a live request, build-time snapshot, or edge read model.",
      "Live sources are retained for freshness and bounded fallback.",
    ].join("\n"),
    canonicalArchitecture: `### Resident-read invariant\n\n${residentReadPolicy.invariant}\n`,
    residentReadPolicy,
  });

  assert.equal(report.status, "drift");
  const findings = report.outcomes.contradictions.filter((item) =>
    item.target === "ARCHITECTURE.md:resident-read-invariant");
  assert.equal(findings.length, 7);
  assert.ok(findings.every((item) => item.source === "architecture/resident-read-policy.json#invariant"));
  assert.ok(findings.some((item) => item.declared.includes("browser can read public Socrata")));
  assert.ok(findings.some((item) => item.declared.includes("bounded live fallback")));
  assert.ok(report.proposals.some((item) =>
    item.target === "ARCHITECTURE.md:resident-read-invariant"
    && item.files.includes("docs/architecture.md")));
});

test("a narrative summary consistent with the canonical resident-read invariant stays healthy", () => {
  const report = buildReport({
    facts,
    baselineFacts: buildWatermark(facts),
    architectureNarrative: [
      "# Architecture",
      "",
      "Resident views use CityScroll-owned materializations without request-time publisher retrieval.",
      "Scheduled acquisition provides freshness, and official-source links remain navigation only.",
    ].join("\n"),
    canonicalArchitecture: `### Resident-read invariant\n\n${residentReadPolicy.invariant}\n`,
    residentReadPolicy,
  });

  assert.equal(report.status, "healthy");
  assert.deepEqual(report.outcomes.contradictions, []);
});

test("the canonical architecture document must carry the policy's authoritative invariant string", () => {
  const report = buildReport({
    facts,
    baselineFacts: buildWatermark(facts),
    architectureNarrative: "The root narrative links to the canonical resident-read invariant.",
    canonicalArchitecture: "### Resident-read invariant\n\nResident reads are generally materialized.\n",
    residentReadPolicy,
  });

  assert.equal(report.status, "drift");
  const finding = report.outcomes.contradictions.find((item) =>
    item.target === "docs/architecture.md:resident-read-invariant");
  assert.ok(finding);
  assert.equal(finding.required, residentReadPolicy.invariant);
  assert.equal(finding.source, "architecture/resident-read-policy.json#invariant");
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
    const written = JSON.parse(readFileSync(join(outputDir, "reconciliation.json"), "utf8"));
    assert.equal(written.schema, "cityscroll.architecture.reconciliation.v1");
    assert.ok(written.status === "healthy" || written.status === "drift");
    assert.equal(written.facts.baseline, WATERMARK_RELATIVE);
    assert.equal(existsSync(join(outputDir, "watermark.json")), false);
    assert.deepEqual(readFileSync(committed), before);
    assert.notEqual(result.status, null);
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
