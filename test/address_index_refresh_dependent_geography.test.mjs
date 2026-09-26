/**
 * Address-index refresh must rebuild every --check drift gate whose builder
 * declares the refreshed geography inputs.
 *
 *   node --test test/address_index_refresh_dependent_geography.test.mjs
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ROOT,
  coveredByPublishedPaths,
  derivedFamiliesDependingOnRefreshedInputs,
  describeDrift,
  earlyCheckBuilders,
  pathDeclaresRefreshedInput,
  publishedPaths,
  readRegistry,
  registryAccountedBuilders,
  registryCoveredBuilders,
  registryDrift,
  requiredDependentCheckBuilders,
  shouldForceAfterPostVerify,
  workflowPublishedPathAllowance,
  workflowRebuildCommands,
  workflowStepInvokesRebuildHelper,
  workflowStepText,
} from "../ops/address-index-refresh/rebuild-dependent-geography.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the dependent-geography registry resolves against this repository", () => {
  assert.equal(ROOT, REPO_ROOT);
  const registry = readRegistry(REPO_ROOT);
  assert.equal(registry.workflow, ".github/workflows/geocoder-address-index.yml");
  assert.ok(existsSync(path.join(REPO_ROOT, registry.workflow)));
  assert.ok(existsSync(path.join(REPO_ROOT, registry.derived_manifest)));
  for (const step of registry.rebuild_sequence) {
    assert.ok(step.id, "every rebuild step needs an id");
    assert.ok(step.command?.length, `rebuild step ${step.id} needs a command`);
    assert.ok(existsSync(path.join(REPO_ROOT, step.command[0])), `missing tool for ${step.id}`);
    assert.ok(step.covers?.length, `rebuild step ${step.id} must say which gates it covers`);
  }
  for (const entry of registry.not_rebuilt) {
    assert.ok(existsSync(path.join(REPO_ROOT, entry.builder)), `missing builder ${entry.builder}`);
    assert.ok(entry.disposition, `${entry.builder} needs a disposition`);
    assert.ok(entry.reason && entry.reason.length > 20, `${entry.builder} needs a stated reason`);
  }
});

test("pathDeclaresRefreshedInput matches manifests and directory prefixes", () => {
  const inputs = ["site/data/parcel-geography/manifest.json", "site/data/parcel-geography"];
  assert.equal(pathDeclaresRefreshedInput("site/data/parcel-geography/manifest.json", inputs), true);
  assert.equal(pathDeclaresRefreshedInput("site/data/parcel-geography/00.json", inputs), true);
  assert.equal(pathDeclaresRefreshedInput("site/data/land_place_membership.json", inputs), false);
});

test("derived families depending on refreshed inputs include Land place refresh", () => {
  const families = derivedFamiliesDependingOnRefreshedInputs(REPO_ROOT);
  const ids = families.map((family) => family.id);
  assert.ok(ids.includes("land-place-refresh"));
  assert.ok(!ids.includes("address-geography-refresh"), "producer families are excluded");
});

test("early-check readers discover the Pages and preflight --check gates", () => {
  const builders = earlyCheckBuilders(REPO_ROOT);
  assert.ok(builders.includes("tools/build_land_place_membership.mjs"));
  assert.ok(builders.includes("tools/land_place_refresh.mjs"));
  assert.ok(builders.includes("tools/build_geocoder_address_index.mjs"));
});

test("every required dependent --check builder is on the refresh chain", () => {
  const drift = registryDrift(REPO_ROOT);
  assert.deepEqual(describeDrift(drift), []);
  assert.ok(drift.required.includes("tools/land_place_refresh.mjs"));
  assert.ok(drift.required.includes("tools/build_land_place_membership.mjs"));
});

test("positive control: a derived family left off the chain is reported", () => {
  const drift = registryDrift(REPO_ROOT, readRegistry(REPO_ROOT), {
    extraFamilies: [{
      id: "synthetic-parcel-dependent",
      generator: "tools/synthetic_parcel_dependent.mjs",
      source_paths: ["site/data/parcel-geography/manifest.json"],
      output_paths: ["site/data/synthetic_parcel_dependent.json"],
    }],
  });
  assert.ok(
    drift.uncovered.includes("tools/synthetic_parcel_dependent.mjs"),
    "a new parcel-dependent --check family must fail the registry until the refresh chain covers it",
  );
  assert.ok(describeDrift(drift).some((line) => line.includes("synthetic_parcel_dependent.mjs")));
});

test("positive control: dropping Land place coverage fails the registry", () => {
  const registry = readRegistry(REPO_ROOT);
  const stripped = {
    ...registry,
    rebuild_sequence: registry.rebuild_sequence
      .filter((step) => step.id !== "land-place-refresh")
      .map((step) => ({ ...step, covers: [...(step.covers || [])] })),
  };
  const drift = registryDrift(REPO_ROOT, stripped);
  assert.ok(drift.uncovered.includes("tools/land_place_refresh.mjs"));
  assert.ok(drift.uncovered.includes("tools/build_land_place_membership.mjs"));
});

test("no builder is accounted for twice", () => {
  const builders = registryAccountedBuilders(readRegistry(REPO_ROOT));
  assert.equal(new Set(builders).size, builders.length);
});

test("rebuild order respects after: dependencies", () => {
  const complete = new Set();
  for (const step of readRegistry(REPO_ROOT).rebuild_sequence) {
    for (const dependency of step.after || []) {
      assert.ok(complete.has(dependency), `${step.id} precedes ${dependency}`);
    }
    complete.add(step.id);
  }
});

test("the workflow dependent-geography step runs the registry helper", () => {
  const registry = readRegistry(REPO_ROOT);
  const stepText = workflowStepText(REPO_ROOT, registry);
  assert.equal(workflowStepInvokesRebuildHelper(stepText), true);
  assert.match(stepText, /rebuild-dependent-geography\.mjs/);
  assert.doesNotMatch(
    stepText,
    /node tools\/address_geography_refresh\.mjs --from-live/,
    "the workflow must not restate the rebuild commands beside the helper",
  );
});

test("the workflow stages every published path the registry declares", () => {
  const missing = workflowPublishedPathAllowance(REPO_ROOT);
  assert.deepEqual(missing, []);
  const paths = publishedPaths(readRegistry(REPO_ROOT));
  assert.ok(coveredByPublishedPaths("site/data/land_place_membership.json", paths));
  assert.ok(coveredByPublishedPaths("site/data/land-place-evidence/00.json", paths));
  assert.ok(coveredByPublishedPaths("site/data/land-place-generations/ACTIVE", paths));
});

test("workflow rebuild commands keep address geography before Land place", () => {
  const commands = workflowRebuildCommands(readRegistry(REPO_ROOT)).map((parts) => parts.join(" "));
  const addressAt = commands.findIndex((line) => line.includes("tools/address_geography_refresh.mjs --from-live"));
  const landAt = commands.findIndex((line) => line.includes("tools/land_place_refresh.mjs") && !line.includes("--check") && !line.includes("--force"));
  assert.ok(addressAt >= 0);
  assert.ok(landAt > addressAt);
  assert.ok(commands.some((line) => line.includes("tools/build_land_place_membership.mjs --check")));
  assert.ok(commands.some((line) => line.includes("tools/land_place_refresh.mjs --force")));
});

test("positive control: membership post-verify failure forces Land place republication", () => {
  const registry = readRegistry(REPO_ROOT);
  const land = registry.rebuild_sequence.find((step) => step.id === "land-place-refresh");
  assert.ok(land?.force_command?.includes("--force"));
  assert.equal(shouldForceAfterPostVerify(land, 1), true);
  assert.equal(shouldForceAfterPostVerify(land, 0), false);
  assert.equal(shouldForceAfterPostVerify({ post_verify: ["tools/x.mjs", "--check"] }, 1), false);
});

test("Land place builders remain covered after the address-geography producer step", () => {
  const covered = registryCoveredBuilders(readRegistry(REPO_ROOT));
  assert.ok(covered.includes("tools/land_place_refresh.mjs"));
  assert.ok(covered.includes("tools/build_land_place_membership.mjs"));
  const required = requiredDependentCheckBuilders(REPO_ROOT).map((entry) => entry.builder);
  for (const builder of required) {
    assert.ok(covered.includes(builder) || readRegistry(REPO_ROOT).not_rebuilt.some((entry) => entry.builder === builder));
  }
});
