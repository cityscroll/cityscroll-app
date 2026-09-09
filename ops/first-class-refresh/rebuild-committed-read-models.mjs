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
// Running the builder is only half of publishing it. Both halves of the refresh
// commit a fixed list of pathspecs, so a read model rebuilt outside that list is
// regenerated and then silently discarded, and the gate that re-derives it in
// check mode fails on the refresh's own pull request. The registry declares that
// list as published_paths, the commit scripts read it from here rather than
// restating it, and this script fails the run when the rebuild dirtied anything
// the list does not cover.
//
// Usage:
//   node ops/first-class-refresh/rebuild-committed-read-models.mjs
//   node ops/first-class-refresh/rebuild-committed-read-models.mjs --list
//   node ops/first-class-refresh/rebuild-committed-read-models.mjs --check-registry
//   node ops/first-class-refresh/rebuild-committed-read-models.mjs --published-paths

import { appendFileSync, readFileSync, readdirSync, statSync } from "node:fs";
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
  if (!Array.isArray(registry.published_paths) || !registry.published_paths.length) {
    throw new Error("committed read-model registry declares no published paths");
  }
  for (const entry of registry.published_paths) {
    if (!entry?.path) throw new Error("every published path needs a path");
    if (!entry.reason) throw new Error(`published path ${entry.path} needs a stated reason`);
  }
  return registry;
}

// The pathspecs both halves of the refresh stage when they commit. The commit
// scripts read these rather than keeping their own copy.
export function publishedPaths(registry) {
  return registry.published_paths.map((entry) => entry.path);
}

export function coveredByPublishedPaths(file, paths) {
  return paths.some((root) => file === root || file.startsWith(`${root}/`));
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
  const gates = new Set([...workflowGateBuilders(root), ...(registry.additional_gate_builders || [])]);
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

// What the working tree currently reports as changed, including untracked files
// so a builder that starts writing a brand-new output is caught too. Ignored
// build outputs stay out of it, and a checkout that is not a git working tree
// returns null so the guard below stands down rather than failing the refresh.
export function dirtyPaths(root = ROOT) {
  const result = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) return null;
  const fields = result.stdout.split("\0");
  const files = [];
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (!record) continue;
    files.push(record.slice(3));
    // A rename or copy records its source as the following field.
    if (record[0] === "R" || record[0] === "C") index += 1;
  }
  return files;
}

// The refresh commits a declared list of pathspecs. A read model rebuilt
// outside that list is regenerated and then dropped, which is how a refresh
// opens a pull request that fails the very gate its rebuild was meant to
// satisfy. Comparing the tree before and after the sequence keeps the guard
// about what this run wrote, not about whatever the checkout was already
// carrying.
export function unpublishedRebuildOutputs(before, after, paths) {
  if (!before || !after) return [];
  const already = new Set(before);
  return after
    .filter((file) => !already.has(file))
    .filter((file) => !coveredByPublishedPaths(file, paths))
    .sort();
}

function assertExecutables(registry, root) {
  const completed = new Set();
  for (const step of registry.rebuild_sequence) {
    const [tool] = step.command;
    if (!statSync(join(root, tool)).isFile()) throw new Error(`rebuild step ${step.id} names a missing tool: ${tool}`);
    if (!["node", "python3"].includes(step.runtime || "node")) throw new Error(`unsupported runtime for ${step.id}`);
    for (const dependency of step.after || []) {
      if (!completed.has(dependency)) throw new Error(`${step.id} must run after ${dependency}`);
    }
    if (completed.has(step.id)) throw new Error(`duplicate rebuild step: ${step.id}`);
    completed.add(step.id);
  }
}

function runSequence(registry, root, env) {
  assertExecutables(registry, root);
  const before = dirtyPaths(root);
  const gaps = `\n### Read-model rebuild boundaries\n\n${registry.not_rebuilt.map((entry) => `- ${entry.builder} (${entry.disposition}): ${entry.reason}`).join("\n")}\n`;
  console.log(gaps);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, gaps);
  for (const step of registry.rebuild_sequence) {
    const [tool, ...args] = step.command;
    console.log(`rebuilding ${step.id}: ${tool} ${args.join(" ")}`.trimEnd());
    // Serial by design. These builders are the repository's heavy ones and the
    // derived JSON boundary measures itself against a declared cold-build time
    // budget; running them side by side would make that measurement meaningless.
    const executable = step.runtime === "python3" ? "python3" : process.execPath;
    const result = spawnSync(executable, [join(root, tool), ...args], { cwd: root, stdio: "inherit", env });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      console.error(`rebuild step ${step.id} failed (${tool})`);
      process.exit(result.status ?? 1);
    }
  }
  const stranded = unpublishedRebuildOutputs(before, dirtyPaths(root), publishedPaths(registry));
  if (stranded.length) {
    console.error("the rebuild wrote files outside the paths the refresh commits:");
    for (const file of stranded) console.error(`  ${file}`);
    console.error(
      "Add the path to published_paths in ops/first-class-refresh/committed-read-models.json, " +
        "or make the builder write inside a path already listed there. Left as it is, the refresh " +
        "would publish the input and discard the read model derived from it.",
    );
    process.exit(1);
  }
  console.log(`rebuilt ${registry.rebuild_sequence.length} committed read-model steps`);
}

export function verificationCommands(registry, root = ROOT) {
  return registry.verification.map((entry) => entry.family === "worker"
    ? { family: entry.family, cwd: join(root, "worker"), args: ["--test"] }
    : { family: entry.family, cwd: root, args: ["--test", ...readdirSync(join(root, entry.directory)).filter((file) => file.endsWith(entry.pattern)).sort().map((file) => `${entry.directory}/${file}`)] });
}

function verifyFreshnessTests(registry, root, env) {
  const failed = [];
  for (const { family, cwd, args } of verificationCommands(registry, root)) {
    console.log(`Verifying ${family} freshness gates before publication`);
    const result = spawnSync(process.execPath, args, { cwd, stdio: "inherit", env: { ...env, CS10_SKIP_LIVE_CANARY: "true" } });
    if (result.error) throw result.error;
    if (result.status !== 0) failed.push(family);
  }
  if (failed.length) throw new Error(`${failed.join(", ")} gates failed; refreshed data must not be published`);
}

function main(argv) {
  const registry = readRegistry(ROOT);
  if (argv.includes("--published-paths")) {
    for (const declared of publishedPaths(registry)) console.log(declared);
    return;
  }
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
  // One production day for builders, browser captures and the test readers,
  // including runs that cross midnight. Check-only registry reads never use it.
  const env = { ...process.env, CROL_BUILD_DAY: process.env.CROL_BUILD_DAY || new Date().toISOString().slice(0, 10) };
  if (!argv.includes("--verify-only")) runSequence(registry, ROOT, env);
  if (!argv.includes("--rebuild-only")) verifyFreshnessTests(registry, ROOT, env);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2));
}
