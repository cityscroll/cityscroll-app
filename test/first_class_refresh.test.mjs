import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  buildFirstClassFreshnessReport,
  buildScheduledRefreshPlan,
  discoverFirstClassArtifactPaths,
  discoverFirstClassRoutes,
  productionFreshnessFindings,
  runRefreshCommands,
  validateFirstClassRefreshContracts,
} from "../tools/first_class_refresh.mjs";
import { withTempDir } from "../tools/lib/with_temp_dir.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const canonical = () => JSON.parse(readFileSync(new URL("../site/data/source_contracts.json", import.meta.url), "utf8"));

function artifact(id, path, sourceId = "source-a") {
  return {
    id,
    public_artifact_path: path,
    primary_routes: ["/browse/example/"],
    source_contract_id: sourceId,
    acquisition_command: ["node", "tools/acquire.mjs"],
    owning_builder: "tools/build.mjs",
    builder_command: ["node", "tools/build.mjs"],
    dependent_materializers: ["tools/materialize.mjs"],
    normal_refresh_cadence_hours: 24,
    warning_age_hours: 36,
    hard_maximum_age_hours: 72,
    vintage_fields: ["generated_at"],
    population_fields: ["rows"],
    last_known_good_behavior: "Retain and disclose degraded freshness.",
    resident_stale_behavior: "Render stale, not current.",
    resident_unavailable_behavior: "Render unavailable, never empty.",
    production_evidence_field: `first_class.${id}`,
  };
}

test("canonical registry covers every first-class Browse, primary-document, Now, and contract-panel artifact", () => {
  const registry = canonical();
  assert.deepEqual(validateFirstClassRefreshContracts(registry, { root: ROOT }), []);
  const declared = new Set(registry.first_class_artifacts.map((row) => row.public_artifact_path));
  for (const path of discoverFirstClassArtifactPaths(ROOT)) assert.ok(declared.has(path), path);
  const declaredRoutes = new Set(registry.first_class_artifacts.flatMap((row) => row.primary_routes));
  for (const route of discoverFirstClassRoutes()) assert.ok(declaredRoutes.has(route), route);
  for (const path of [
    "site/data/analytics_registered_contracts.json",
    "site/data/analytics_payments.json",
    "site/data/analytics_performance_evidence.json",
    "site/data/people_organizations_read_model.json",
    "site/data/land_default_ulurp.json",
    "site/data/rules_domain_observations.json",
    "site/data/shared_meeting_read_model.json",
    "site/data/staffing_exams.json",
    "site/data/property_resident_snapshot.json",
    "site/data/money_default_open.json",
  ]) assert.ok(declared.has(path), path);
});

test("adding a first-class dataPath without cadence, builder, and maximum-age policy fails completeness", () => {
  const registry = canonical();
  const errors = validateFirstClassRefreshContracts(registry, {
    root: ROOT,
    discoveredPaths: [...discoverFirstClassArtifactPaths(ROOT), "site/data/new_primary_surface.json"],
  });
  assert.match(errors.join("\n"), /new_primary_surface\.json: first-class artifact lacks a refresh contract/);
  const broken = structuredClone(registry);
  delete broken.first_class_artifacts[0].hard_maximum_age_hours;
  delete broken.first_class_artifacts[0].builder_command;
  assert.match(validateFirstClassRefreshContracts(broken, { root: ROOT }).join("\n"), /builder_command|hard_maximum_age_hours/);
  const uncoveredRoute = validateFirstClassRefreshContracts(registry, {
    root: ROOT,
    discoveredRoutes: [...discoverFirstClassRoutes(), "/browse/new-primary/"],
  });
  assert.match(uncoveredRoute.join("\n"), /new-primary.*primary route lacks a refresh contract/);
  const overAge = structuredClone(registry);
  overAge.first_class_artifacts.find((row) => row.id === "contracts-performance-evidence").hard_maximum_age_hours = 2000;
  assert.match(validateFirstClassRefreshContracts(overAge, { root: ROOT }).join("\n"), /exceeds the source contract serving limit/);
});

test("scheduled plan groups by cadence and orders acquisition before owning builders and dependents", () => {
  const plan = buildScheduledRefreshPlan(canonical());
  assert.deepEqual(plan.groups.map((group) => group.cadence_hours), [24, 168, 720]);
  for (const group of plan.groups) {
    assert.deepEqual(group.stages.map((stage) => stage.kind), ["acquisition", "owning-builder", "dependent-materializer"]);
    assert.deepEqual(group.stages.map((stage) => stage.order), [1, 2, 3]);
  }
});

test("refresh execution completes acquisitions before rebuilding affected artifacts", () => {
  const calls = [];
  const registry = {
    first_class_artifacts: [
      artifact("one", "site/data/one.json"),
      { ...artifact("two", "site/data/two.json"), acquisition_command: ["node", "tools/acquire-two.mjs"] },
    ],
  };
  const receipt = runRefreshCommands(registry, {
    root: "/fixture",
    now: "2026-09-04T12:00:00.000Z",
    all: true,
    stdio: "pipe",
    spawn(command, args) { calls.push([command, args[0]]); return { status: 0 }; },
  });
  assert.equal(receipt.status, "succeeded");
  assert.deepEqual(calls.map((call) => call[1]), [
    "/fixture/tools/acquire.mjs",
    "/fixture/tools/acquire-two.mjs",
    "/fixture/tools/build.mjs",
  ]);
  assert.deepEqual(receipt.commands.map((row) => row.kind), ["acquisition", "acquisition", "owning-builder"]);
});

test("failed acquisition preserves last-known-good output and does not block unrelated builders", () => {
  const calls = [];
  const registry = {
    first_class_artifacts: [
      artifact("failed", "site/data/failed.json", "failed-source"),
      {
        ...artifact("healthy", "site/data/healthy.json", "healthy-source"),
        acquisition_command: ["node", "tools/acquire-healthy.mjs"],
        owning_builder: "tools/build-healthy.mjs",
        builder_command: ["node", "tools/build-healthy.mjs"],
      },
    ],
  };
  const receipt = runRefreshCommands(registry, {
    root: "/fixture",
    now: "2026-09-04T12:00:00.000Z",
    all: true,
    stdio: "pipe",
    spawn(command, args) {
      calls.push([command, args[0]]);
      return { status: args[0].endsWith("/acquire.mjs") ? 1 : 0 };
    },
  });
  assert.equal(receipt.status, "partial");
  assert.deepEqual(calls.map((call) => call[1]), [
    "/fixture/tools/acquire.mjs",
    "/fixture/tools/acquire-healthy.mjs",
    "/fixture/tools/build-healthy.mjs",
  ]);
  assert.equal(receipt.commands.find((row) => row.command[1] === "tools/build.mjs")?.status, "skipped");
});

test("fresh, genuinely empty, degraded LKG, stale, and unavailable remain distinct", async () => {
  await withTempDir("first-class", async (root) => {
    const definitions = [
      artifact("fresh", "site/data/fresh.json", "fresh-source"),
      artifact("empty", "site/data/empty.json", "empty-source"),
      artifact("degraded", "site/data/degraded.json", "degraded-source"),
      { ...artifact("stale", "site/data/stale.json", "stale-source"), vintage_fields: ["source_as_of", "generated_at"] },
      artifact("unavailable", "site/data/unavailable.json", "unavailable-source"),
    ];
    const write = (path, value) => {
      const target = join(root, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify(value));
    };
    write(definitions[0].public_artifact_path, { generated_at: "2026-09-04T11:00:00.000Z", rows: [{}] });
    write(definitions[1].public_artifact_path, { generated_at: "2026-09-04T11:00:00.000Z", rows: [] });
    write(definitions[2].public_artifact_path, { generated_at: "2026-09-03T00:00:00.000Z", rows: [{}] });
    write(definitions[3].public_artifact_path, {
      source_as_of: "2026-08-01T00:00:00.000Z",
      generated_at: "2026-09-04T11:00:00.000Z",
      rows: [],
    });
    const report = buildFirstClassFreshnessReport({ first_class_artifacts: definitions }, {
      root,
      now: "2026-09-04T12:00:00.000Z",
      deploymentIdentity: "release-1",
      observations: { observations: [
        { source_id: "fresh-source", health: { status: "Healthy" } },
        { source_id: "empty-source", health: { status: "Healthy" } },
        { source_id: "degraded-source", health: { status: "Source-unavailable" } },
      ] },
    });
    assert.deepEqual(Object.fromEntries(report.surfaces.map((row) => [row.id, row.freshness_state])), {
      degraded: "degraded",
      empty: "fresh_empty",
      fresh: "fresh",
      stale: "stale",
      unavailable: "unavailable",
    });
    assert.equal(report.surfaces.find((row) => row.id === "empty").complete_for_empty_claim, true);
    assert.equal(report.surfaces.find((row) => row.id === "unavailable").population_state, "unknown");
    assert.deepEqual(productionFreshnessFindings(report).map((row) => row.split(":")[0]), [
      "site/data/stale.json",
      "site/data/unavailable.json",
    ]);
    assert.equal(report.deployment_identity, "release-1");
    assert.ok(report.surfaces.every((row) => row.public_artifact_path && row.source_vintage !== undefined && row.owning_builder));
  });
});

test("rules-semantic-lane freshness is measured from the daily rules snapshot vintage, not the bounded research corpus date", async () => {
  const registry = canonical();
  const rulesSemanticLane = registry.first_class_artifacts.find((row) => row.id === "rules-semantic-lane");
  assert.deepEqual(rulesSemanticLane.vintage_fields, ["rules_snapshot_observed_at"]);

  await withTempDir("rules-semantic-lane", async (root) => {
    const write = (value) => {
      const target = join(root, rulesSemanticLane.public_artifact_path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify(value));
    };
    const now = "2026-09-04T12:00:00.000Z";
    const definitions = [rulesSemanticLane];

    write({ rules_snapshot_observed_at: "2026-09-04T06:00:00.000Z", corpus_observed_on: "2026-08-04", candidate_count: 2, candidates: [{}, {}] });
    const fresh = buildFirstClassFreshnessReport({ first_class_artifacts: definitions }, { root, now });
    assert.equal(fresh.surfaces[0].freshness_state, "fresh");

    write({ rules_snapshot_observed_at: "2026-08-04T06:00:00.000Z", corpus_observed_on: "2026-08-04", candidate_count: 2, candidates: [{}, {}] });
    const stale = buildFirstClassFreshnessReport({ first_class_artifacts: definitions }, { root, now });
    assert.equal(stale.surfaces[0].freshness_state, "stale");
  });
});

test("staffing-exams freshness is measured from the acquisition's own retrieval vintage, not the eligible-list establishment date", async () => {
  const registry = canonical();
  const staffingExams = registry.first_class_artifacts.find((row) => row.id === "staffing-exams");
  assert.deepEqual(staffingExams.vintage_fields, ["sources_retrieved_as_of"]);

  await withTempDir("staffing-exams", async (root) => {
    const write = (value) => {
      const target = join(root, staffingExams.public_artifact_path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify(value));
    };
    const now = "2026-09-05T12:00:00.000Z";
    const definitions = [staffingExams];
    // DCAS last established an eligible list on 2026-08-26 in every case below: the
    // upstream publication clock is held fixed so only the retrieval vintage varies.
    const upstream = {
      data_current_as_of: "2026-08-26",
      list_current_as_of: "2026-08-26",
      open_window_as_of: "2026-09-05",
      exams: [{}, {}],
    };

    write({ ...upstream, sources_retrieved_as_of: "2026-09-05" });
    const fresh = buildFirstClassFreshnessReport({ first_class_artifacts: definitions }, { root, now });
    assert.equal(fresh.surfaces[0].freshness_state, "fresh");
    assert.equal(fresh.surfaces[0].source_vintage, "2026-09-05T00:00:00.000Z");

    write({ ...upstream, sources_retrieved_as_of: "2026-07-20" });
    const stale = buildFirstClassFreshnessReport({ first_class_artifacts: definitions }, { root, now });
    assert.equal(stale.surfaces[0].freshness_state, "stale");
  });
});

test("production build emits and retains the first-class freshness proof", () => {
  const build = readFileSync(new URL("../tools/build_cloudflare_pages.mjs", import.meta.url), "utf8");
  assert.match(build, /first_class_refresh\.mjs/);
  assert.match(build, /--run-due/);
  assert.match(build, /--check-production/);
  assert.match(build, /mergeResidentSnapshotRefreshEvidence/);
  const workflow = readFileSync(new URL("../.github/workflows/deploy-cloudflare-pages.yml", import.meta.url), "utf8");
  assert.match(workflow, /first-class-refresh-plan\.json/);
  assert.match(workflow, /first-class-refresh-receipt\.json/);
  assert.match(workflow, /first_class_freshness_report\.json/);
  assert.match(workflow, /first_class_live_smoke\.mjs/);
});
