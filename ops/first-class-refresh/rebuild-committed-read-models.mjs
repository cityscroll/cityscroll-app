#!/usr/bin/env node
// Rebuild the committed read models that continuous integration re-derives in
// check mode, so a dataset refresh publishes its inputs and its read models in
// the same change.
//
// The scheduled refresh runs each dataset's owning builder and stops there. The
// keyword search index, the agency constellation documents, and the generated
// source-contract projections are all built from those datasets and are
// committed to the repository, so a refresh that does not rebuild them opens a
// pull request that fails its own freshness gates.
//
// committed-read-models.json binds the two lists together: every check-mode gate
// in the static-standards unit family appears there exactly once, either as
// something this script rebuilds or as something it deliberately does not, with
// the reason. The companion test fails when the workflow grows a gate this
// registry has not accounted for.
//
// Usage:
//   node ops/first-class-refresh/rebuild-committed-read-models.mjs
//   node ops/first-class-refresh/rebuild-committed-read-models.mjs --list
//   node ops/first-class-refresh/rebuild-committed-read-models.mjs --check-registry

import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "../..");
export const REGISTRY_PATH = join(HERE, "committed-read-models.json");

export function readRegistry(root = ROOT) {
  const registry = JSON.parse(readFileSync(join(root, "ops/first-class-refresh/committed-read-models.json"), "utf8"));
  if (registry.schema !== "cityscroll.committed_read_model_rebuild.v1") {
    throw new Error("unexpected committed read-model registry schema");
  }
  if (!Array.isArray(registry.rebuild_sequence) || !registry.rebuild_sequence.length) {
    throw new Error("committed read-model registry has no rebuild sequence");
  }
  if (!Array.isArray(registry.not_rebuilt)) {
    throw new Error("committed read-model registry has no not_rebuilt list");
  }
  return registry;
}

// Every builder path the registry accounts for, whichever side of the split it
// falls on. The test compares this set with the workflow's gate set.
export function registryBuilders(registry) {
  const covered = registry.rebuild_sequence.flatMap((step) => step.covers ?? []);
  const declined = registry.not_rebuilt.map((entry) => entry.builder);
  return [...covered, ...declined];
}

// Read the check-mode gates out of the workflow definition rather than
// restating them, so the comparison is against the file CI actually runs.
export function workflowGateBuilders(root = ROOT, { workflow, family } = {}) {
  const registry = readRegistry(root);
  const workflowPath = workflow ?? registry.gate_workflow;
  const gateFamily = family ?? registry.gate_family;
  const text = readFileSync(join(root, workflowPath), "utf8");
  const builders = new Set();
  // Steps start at a fixed indent in this workflow; splitting on that keeps each
  // step's family condition attached to its own commands.
  for (const step of text.split(/^ {6}- /m).slice(1)) {
    if (!step.includes(`matrix.family == '${gateFamily}'`)) continue;
    for (const line of step.split("\n")) {
      const match = /\bnode\s+(tools\/[A-Za-z0-9._-]+\.mjs)\b[^\n]*--check\b/.exec(line);
      if (match) builders.add(match[1]);
    }
  }
  return [...builders].sort();
}

// A drift report both the self-check and the test render.
export function registryDrift(root = ROOT) {
  const registry = readRegistry(root);
  const gates = new Set(workflowGateBuilders(root));
  const accounted = registryBuilders(registry);
  const accountedSet = new Set(accounted);
  const duplicated = accounted.filter((builder, index) => accounted.indexOf(builder) !== index);
  return {
    unaccountedGates: [...gates].filter((builder) => !accountedSet.has(builder)).sort(),
    absentGates: [...accountedSet].filter((builder) => !gates.has(builder)).sort(),
    duplicated: [...new Set(duplicated)].sort(),
  };
}

export function describeDrift(drift) {
  const lines = [];
  for (const builder of drift.unaccountedGates) {
    lines.push(`gate not accounted for by the refresh: ${builder}`);
  }
  for (const builder of drift.absentGates) {
    lines.push(`registry names a builder that is no longer a gate: ${builder}`);
  }
  for (const builder of drift.duplicated) {
    lines.push(`builder accounted for more than once: ${builder}`);
  }
  return lines;
}

function assertExecutables(registry, root) {
  for (const step of registry.rebuild_sequence) {
    const [tool] = step.command;
    if (!statSync(join(root, tool)).isFile()) throw new Error(`rebuild step ${step.id} names a missing tool: ${tool}`);
  }
}

function runSequence(registry, root) {
  assertExecutables(registry, root);
  for (const step of registry.rebuild_sequence) {
    const [tool, ...args] = step.command;
    console.log(`rebuilding ${step.id}: ${tool} ${args.join(" ")}`.trimEnd());
    // Serial by design. These builders are the repository's heavy ones and the
    // derived JSON boundary measures itself against a declared cold-build time
    // budget; running them side by side would make that measurement meaningless.
    const result = spawnSync(process.execPath, [join(root, tool), ...args], { cwd: root, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      console.error(`rebuild step ${step.id} failed (${tool})`);
      process.exit(result.status ?? 1);
    }
  }
  console.log(`rebuilt ${registry.rebuild_sequence.length} committed read-model steps`);
}

function main(argv) {
  const registry = readRegistry(ROOT);
  if (argv.includes("--list")) {
    for (const step of registry.rebuild_sequence) console.log(`rebuild  ${step.command.join(" ")}`);
    for (const entry of registry.not_rebuilt) console.log(`skip     ${entry.builder} (${entry.disposition})`);
    return;
  }
  const drift = describeDrift(registryDrift(ROOT));
  if (drift.length) {
    for (const line of drift) console.error(line);
    console.error("Update ops/first-class-refresh/committed-read-models.json so the refresh and the gates agree.");
    process.exit(1);
  }
  if (argv.includes("--check-registry")) {
    console.log(`committed read-model registry matches the ${registry.gate_family} gates`);
    return;
  }
  runSequence(registry, ROOT);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2));
}
