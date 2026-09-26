#!/usr/bin/env node
/**
 * Rebuild derived geography artifacts invalidated by the citywide address-index
 * refresh, then prove the rebuild sequence still covers every --check drift gate
 * whose builder declares those refreshed inputs.
 *
 * Usage:
 *   node ops/address-index-refresh/rebuild-dependent-geography.mjs
 *   node ops/address-index-refresh/rebuild-dependent-geography.mjs --check-registry
 *   node ops/address-index-refresh/rebuild-dependent-geography.mjs --list
 *   node ops/address-index-refresh/rebuild-dependent-geography.mjs --published-paths
 *   node ops/address-index-refresh/rebuild-dependent-geography.mjs --workflow-commands
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "../..");
export const REGISTRY_PATH = join(HERE, "dependent-geography.json");

export function readRegistry(root = ROOT) {
  const registry = JSON.parse(
    readFileSync(join(root, "ops/address-index-refresh/dependent-geography.json"), "utf8"),
  );
  if (registry.schema !== "cityscroll.address_index_dependent_geography.v1") {
    throw new Error("unexpected address-index dependent-geography registry schema");
  }
  if (!Array.isArray(registry.rebuild_sequence) || !registry.rebuild_sequence.length) {
    throw new Error("dependent-geography registry has no rebuild sequence");
  }
  if (!Array.isArray(registry.refreshed_input_paths) || !registry.refreshed_input_paths.length) {
    throw new Error("dependent-geography registry declares no refreshed input paths");
  }
  if (!Array.isArray(registry.published_paths) || !registry.published_paths.length) {
    throw new Error("dependent-geography registry declares no published paths");
  }
  for (const entry of registry.published_paths) {
    if (!entry?.path) throw new Error("every published path needs a path");
    if (!entry.reason) throw new Error(`published path ${entry.path} needs a stated reason`);
  }
  if (!Array.isArray(registry.not_rebuilt)) {
    throw new Error("dependent-geography registry needs a not_rebuilt list (may be empty)");
  }
  return registry;
}

export function publishedPaths(registry) {
  return registry.published_paths.map((entry) => entry.path);
}

export function coveredByPublishedPaths(file, paths) {
  return paths.some((root) => file === root || file.startsWith(`${root}/`));
}

export function registryCoveredBuilders(registry) {
  return registry.rebuild_sequence.flatMap((step) => step.covers ?? []);
}

export function registryAccountedBuilders(registry) {
  return [
    ...registryCoveredBuilders(registry),
    ...registry.not_rebuilt.map((entry) => entry.builder),
  ];
}

function normalizePath(value) {
  return String(value || "").replaceAll("\\", "/");
}

export function pathDeclaresRefreshedInput(candidate, refreshedInputPaths) {
  const path = normalizePath(candidate);
  return refreshedInputPaths.some((input) => {
    const needle = normalizePath(input).replace(/\/$/, "");
    return path === needle
      || path.startsWith(`${needle}/`)
      || needle.startsWith(`${path}/`);
  });
}

export function derivedFamiliesDependingOnRefreshedInputs(root = ROOT, registry = readRegistry(root)) {
  const manifest = JSON.parse(readFileSync(join(root, registry.derived_manifest), "utf8"));
  const producers = new Set(registry.producer_generators || []);
  const out = [];
  for (const family of manifest.generated_families || []) {
    if (!family?.generator || producers.has(family.generator)) continue;
    const hits = (family.source_paths || []).filter((source) => (
      pathDeclaresRefreshedInput(source, registry.refreshed_input_paths)
    ));
    if (!hits.length) continue;
    out.push({
      id: family.id,
      generator: family.generator,
      source_paths: hits,
      output_paths: family.output_paths || [],
    });
  }
  return out;
}

/** Extract `tools/*.mjs` tokens that appear on a --check invocation line. */
export function earlyCheckBuildersFromText(text) {
  const builders = new Set();
  for (const line of String(text || "").split("\n")) {
    if (!/--check\b/.test(line)) continue;
    for (const match of line.matchAll(/\b(tools\/[A-Za-z0-9._-]+\.mjs)\b/g)) {
      builders.add(match[1]);
    }
  }
  return [...builders].sort();
}

export function earlyCheckBuilders(root = ROOT, registry = readRegistry(root)) {
  const builders = new Set();
  for (const relative of registry.early_check_sources || []) {
    const absolute = join(root, relative);
    if (!existsSync(absolute)) continue;
    for (const builder of earlyCheckBuildersFromText(readFileSync(absolute, "utf8"))) {
      builders.add(builder);
    }
  }
  return [...builders].sort();
}

export function builderSourceTextMentionsRefreshedInputs(root, builder, refreshedInputPaths) {
  const absolute = join(root, builder);
  if (!existsSync(absolute)) return false;
  const text = readFileSync(absolute, "utf8");
  return refreshedInputPaths.some((input) => {
    const needle = normalizePath(input).replace(/\/$/, "");
    // Match path literals the builder embeds (manifest path or directory root).
    return text.includes(needle) || text.includes(`${needle}/`);
  });
}

/**
 * Builders that both (a) appear as a --check drift gate and (b) mention a
 * refreshed input path. Producer generators are excluded; they own the refresh
 * itself rather than depending on its outputs.
 */
export function requiredDependentCheckBuilders(root = ROOT, registry = readRegistry(root), options = {}) {
  const producers = new Set(registry.producer_generators || []);
  const extraFamilies = options.extraFamilies || [];
  const required = new Map();

  for (const family of [
    ...derivedFamiliesDependingOnRefreshedInputs(root, registry),
    ...extraFamilies,
  ]) {
    if (producers.has(family.generator)) continue;
    required.set(family.generator, {
      builder: family.generator,
      via: `derived-family:${family.id || "synthetic"}`,
      source_paths: family.source_paths || [],
    });
  }

  for (const builder of earlyCheckBuilders(root, registry)) {
    if (producers.has(builder)) continue;
    if (!builderSourceTextMentionsRefreshedInputs(root, builder, registry.refreshed_input_paths)) {
      continue;
    }
    if (required.has(builder)) continue;
    required.set(builder, {
      builder,
      via: "early-check-gate",
      source_paths: registry.refreshed_input_paths.filter((input) => (
        builderSourceTextMentionsRefreshedInputs(root, builder, [input])
      )),
    });
  }

  return [...required.values()].sort((a, b) => a.builder.localeCompare(b.builder));
}

export function registryDrift(root = ROOT, registry = readRegistry(root), options = {}) {
  const required = requiredDependentCheckBuilders(root, registry, options);
  const accounted = registryAccountedBuilders(registry);
  const accountedSet = new Set(accounted);
  const duplicated = accounted.filter((builder, index) => accounted.indexOf(builder) !== index);
  const uncovered = required
    .filter((entry) => !accountedSet.has(entry.builder))
    .map((entry) => entry.builder)
    .sort();

  return {
    required: required.map((entry) => entry.builder),
    uncovered,
    duplicated: [...new Set(duplicated)].sort(),
    requiredDetails: required,
  };
}

export function describeDrift(drift) {
  const lines = [];
  for (const builder of drift.uncovered) {
    lines.push(`dependent --check builder missing from the address-index refresh chain: ${builder}`);
  }
  for (const builder of drift.duplicated) {
    lines.push(`builder accounted for more than once: ${builder}`);
  }
  return lines;
}

/** Commands the workflow dependent-geography step must invoke, in order. */
export function workflowRebuildCommands(registry) {
  const commands = [];
  for (const step of registry.rebuild_sequence) {
    commands.push(["node", ...step.command]);
    if (step.verify?.length) commands.push(["node", ...step.verify]);
    if (step.post_verify?.length) commands.push(["node", ...step.post_verify]);
    if (step.force_command?.length) {
      commands.push(["node", ...step.force_command]);
    }
  }
  return commands;
}

export function workflowStepText(root = ROOT, registry = readRegistry(root)) {
  const workflow = readFileSync(join(root, registry.workflow), "utf8");
  const stepName = registry.workflow_step_name;
  const parts = workflow.split(/^ {6}- name: /m).slice(1);
  for (const part of parts) {
    const firstLine = part.split("\n", 1)[0].trim();
    if (firstLine === stepName) return part;
  }
  throw new Error(`workflow step not found: ${stepName}`);
}

export function workflowStepInvokesRebuildHelper(stepText) {
  return /ops\/address-index-refresh\/rebuild-dependent-geography\.mjs\b/.test(stepText);
}

export function workflowPublishedPathAllowance(root = ROOT, registry = readRegistry(root)) {
  const workflow = readFileSync(join(root, registry.workflow), "utf8");
  const missing = [];
  for (const path of publishedPaths(registry)) {
    // YAML allow-lists use either exact files or glob prefixes.
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(`${escaped}(?:/\\*\\*|/\\*|\\s|$)`),
      new RegExp(`${escaped}\\.json`),
    ];
    if (!patterns.some((re) => re.test(workflow))) missing.push(path);
  }
  return missing;
}

function assertExecutables(registry, root) {
  const completed = new Set();
  for (const step of registry.rebuild_sequence) {
    const [tool] = step.command;
    if (!statSync(join(root, tool)).isFile()) {
      throw new Error(`rebuild step ${step.id} names a missing tool: ${tool}`);
    }
    for (const dependency of step.after || []) {
      if (!completed.has(dependency)) {
        throw new Error(`${step.id} must run after ${dependency}`);
      }
    }
    if (completed.has(step.id)) throw new Error(`duplicate rebuild step: ${step.id}`);
    completed.add(step.id);
  }
}

/**
 * Decide whether a failed post-verify should force-republish.
 * Exported for the positive-control unit test.
 */
export function shouldForceAfterPostVerify(step, postVerifyStatus) {
  return Boolean(step?.force_command?.length) && Number(postVerifyStatus) !== 0;
}

function runSequence(registry, root) {
  assertExecutables(registry, root);
  for (const step of registry.rebuild_sequence) {
    const run = (argv, label, { allowFailure = false } = {}) => {
      const [tool, ...args] = argv;
      console.log(`${label} ${step.id}: node ${tool} ${args.join(" ")}`.trimEnd());
      const result = spawnSync(process.execPath, [join(root, tool), ...args], {
        cwd: root,
        stdio: "inherit",
      });
      if (result.error) throw result.error;
      if (result.status !== 0 && !allowFailure) {
        console.error(`${label} step ${step.id} failed (${tool})`);
        process.exit(result.status ?? 1);
      }
      return result.status ?? 1;
    };
    run(step.command, "rebuilding");
    if (step.verify?.length) run(step.verify, "verifying");
    if (step.post_verify?.length) {
      const status = run(step.post_verify, "post-verifying", { allowFailure: true });
      if (shouldForceAfterPostVerify(step, status)) {
        console.log(
          `post-verify drifted for ${step.id}; forcing republication so active mirrors match --check`,
        );
        run(step.force_command, "force-rebuilding");
        if (step.verify?.length) run(step.verify, "verifying");
        run(step.post_verify, "post-verifying");
      } else if (status !== 0) {
        console.error(`post-verifying step ${step.id} failed (${step.post_verify[0]})`);
        process.exit(status);
      }
    }
  }
  console.log(`rebuilt ${registry.rebuild_sequence.length} dependent geography steps`);
}

function main(argv) {
  const registry = readRegistry(ROOT);
  if (argv.includes("--published-paths")) {
    for (const declared of publishedPaths(registry)) console.log(declared);
    return;
  }
  if (argv.includes("--list")) {
    for (const step of registry.rebuild_sequence) {
      console.log(`rebuild  ${step.command.join(" ")}`);
      if (step.verify?.length) console.log(`verify   ${step.verify.join(" ")}`);
    }
    for (const entry of registry.not_rebuilt) {
      console.log(`skip     ${entry.builder} (${entry.disposition})`);
    }
    return;
  }
  if (argv.includes("--workflow-commands")) {
    for (const command of workflowRebuildCommands(registry)) {
      console.log(command.join(" "));
    }
    return;
  }

  const drift = registryDrift(ROOT, registry);
  const lines = describeDrift(drift);
  if (lines.length) {
    for (const line of lines) console.error(line);
    console.error(
      "Update ops/address-index-refresh/dependent-geography.json so the refresh chain covers every --check artifact that declares the refreshed inputs.",
    );
    process.exit(1);
  }
  if (argv.includes("--check-registry")) {
    console.log("address-index dependent-geography registry covers required --check builders");
    return;
  }

  runSequence(registry, ROOT);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main(process.argv.slice(2));
}
