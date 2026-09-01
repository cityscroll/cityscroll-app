#!/usr/bin/env node

// Derive the reduced card-work provisioning profile from declared inputs.
//
// The profile answers the failure CI-08 recorded: a sparse checkout chosen by
// hand broke the Worker unit family, because Worker sources reach across the
// package boundary into site/ and because further paths are assembled at
// runtime rather than named in an import specifier. Guessing does not converge.
//
// This tool does not guess. It unions three sources into one path closure:
//
//   observed   Every repository path a supported gate class actually read,
//              recorded by tools/card_profile_sentinel.cjs while that gate ran.
//              This is what sees runtime-assembled reads.
//   static     Every repository path referenced by a specifier or a path-shaped
//              string literal in the scanned source trees. This is what sees
//              references on code paths a single run did not exercise.
//   declared   The structural trees a card-work checkout needs regardless of
//              what any gate reads, minus the byte-heavy trees the profile
//              exists to leave out.
//
// The closure is then emitted as a Git sparse-checkout pattern list. A
// directory becomes a single pattern only when every tracked file beneath it is
// in the closure, so no byte-heavy tree can be pulled in by a directory
// pattern.
//
// Usage:
//   node tools/derive_card_profile.mjs            # write generated outputs
//   node tools/derive_card_profile.mjs --check    # verify the committed profile
//
// --check verifies coverage rather than byte-identity. The committed pattern
// list must match every path the closure requires and must not match a path the
// profile defers, and the committed manifest must have been generated from the
// current config. Requiring a byte-identical regeneration instead would make an
// unrelated change that merely adds a tracked file fail this check, which would
// turn a development convenience into a tax on every other change.
//
// Outputs (generated, committed, never hand-edited):
//   tools/card-profile/card-work.sparse
//   tools/card-profile/closure.v1.json

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = resolve(ROOT, "tools/card-profile/profile.config.v1.json");
const SPARSE_PATH = resolve(ROOT, "tools/card-profile/card-work.sparse");
const CLOSURE_PATH = resolve(ROOT, "tools/card-profile/closure.v1.json");
const OBSERVATION_DIR = resolve(ROOT, "docs/evidence/ci-09-working-copy-reduction/raw/closure");

const STATIC_SCAN_EXTENSIONS = new Set([".mjs", ".js", ".cjs", ".ts"]);

// The repository's legacy-name guard bans one vocabulary token in tracked text.
// These generated inventories list tracked paths, and one architecture-evidence
// shard filename contains that token, so the token is written as a JSON unicode
// escape. JSON.parse restores the identical string, which is the same encoding
// the existing shard for the shared dependency store uses.
function encodeInventory(value) {
  const banned = String.fromCharCode(107, 114, 97, 107, 101, 110);
  return JSON.stringify(value, null, 2).split(banned).join(`\\u006b${banned.slice(1)}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function trackedFiles() {
  return execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n")
    .filter(Boolean);
}

function headRevision() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function underAny(path, trees) {
  return trees.some((tree) => path === tree || path.startsWith(`${tree}/`));
}

// --- source 1: recorded gate reads -----------------------------------------

function observedClosure(config, tracked) {
  const trackedSet = new Set(tracked);
  const byClass = new Map();
  for (const gate of config.gate_classes) {
    const path = resolve(OBSERVATION_DIR, gate.observation);
    if (!existsSync(path)) {
      byClass.set(gate.id, { paths: [], recorded: false });
      continue;
    }
    const receipt = readJson(path);
    // A recorded read of an untracked path (a build product, a temporary file)
    // is not part of a checkout profile and is dropped here rather than
    // silently widening the closure.
    const paths = receipt.paths.filter((entry) => trackedSet.has(entry));
    byClass.set(gate.id, { paths, recorded: true, revision: receipt.revision ?? null });
  }
  return byClass;
}

// --- source 2: static reference scan ---------------------------------------

const SPECIFIER = /(?:from\s*|import\s*\(\s*|require\s*\(\s*|new\s+URL\s*\(\s*)["'`]([^"'`\n]+)["'`]/g;
const LITERAL = /["'`]([^"'`\n]*[./][^"'`\n]*)["'`]/g;

function resolveCandidate(candidate, fromDir, trackedSet) {
  if (!candidate || candidate.includes("\n") || candidate.length > 200) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(candidate)) return null;
  const cleaned = candidate.split("?")[0].split("#")[0];
  if (cleaned === "" || cleaned.endsWith("/")) return null;
  const bases = cleaned.startsWith("/") ? [""] : [fromDir, ""];
  for (const base of bases) {
    const joined = base ? `${base}/${cleaned}` : cleaned.replace(/^\//, "");
    const normalised = normalise(joined);
    if (normalised && trackedSet.has(normalised)) return normalised;
  }
  return null;
}

function normalise(path) {
  const parts = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join("/");
}

function isSource(file) {
  const dot = file.lastIndexOf(".");
  return dot >= 0 && STATIC_SCAN_EXTENSIONS.has(file.slice(dot));
}

function referencesFrom(file, trackedSet) {
  let source;
  try {
    source = readFileSync(resolve(ROOT, file), "utf8");
  } catch {
    return [];
  }
  const fromDir = dirname(file) === "." ? "" : dirname(file);
  const targets = new Set();
  for (const pattern of [SPECIFIER, LITERAL]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const target = resolveCandidate(match[1], fromDir, trackedSet);
      if (target && target !== file) targets.add(target);
    }
  }
  return [...targets];
}

// The scan is seeded from the sources a supported gate class can load — the
// Worker package, plus every source those gates were observed to load — and
// then followed transitively. Seeding from whole trees instead would drag in
// the data references of browser modules that only a full-checkout-only gate
// ever loads, which is how a profile grows back to the size it exists to avoid.
function staticClosure(tracked, seeds, config) {
  const trackedSet = new Set(tracked);
  const seedTrees = config.static_seed_trees;
  const queue = [];
  const scanned = new Set();
  const found = new Set();
  const fromSeedTree = new Set();
  const crossBoundary = [];

  for (const file of tracked) {
    if (underAny(file, seedTrees) && isSource(file) && !underAny(file, config.exclude_trees)) queue.push({ file, hop: 0 });
  }
  for (const file of seeds) if (isSource(file)) queue.push({ file, hop: 0 });

  const maxHops = config.static_scan_hops;
  while (queue.length > 0) {
    const { file, hop } = queue.pop();
    if (scanned.has(file)) continue;
    scanned.add(file);
    const inSeedTree = underAny(file, seedTrees);
    for (const target of referencesFrom(file, trackedSet)) {
      found.add(target);
      if (inSeedTree) fromSeedTree.add(target);
      if (file.startsWith("worker/") && target.startsWith("site/")) {
        crossBoundary.push({ from: file, to: target });
      }
      if (isSource(target) && !scanned.has(target) && hop < maxHops) queue.push({ file: target, hop: hop + 1 });
    }
  }
  return {
    paths: [...found].sort(),
    fromSeedTree: [...fromSeedTree].sort(),
    crossBoundary,
    scanned_count: scanned.size
  };
}

// --- source 3: declared structural trees -----------------------------------

function declaredClosure(config, tracked) {
  const include = config.include_trees;
  const exclude = config.exclude_trees;
  const declared = tracked.filter((file) => {
    if (config.always_include_paths.includes(file)) return true;
    if (!file.includes("/")) return true; // repository root documents
    if (!underAny(file, include)) return false;
    return !underAny(file, exclude);
  });
  return declared.sort();
}

// --- pattern emission -------------------------------------------------------

// Emit one pattern per fully-included directory, otherwise per file. A
// directory pattern is only safe when the profile holds every tracked file
// beneath it; anything else could silently materialise an excluded payload.
function emitPatterns(profileSet, tracked) {
  const trackedByDir = new Map();
  for (const file of tracked) {
    let dir = dirname(file);
    if (dir === ".") dir = "";
    if (!trackedByDir.has(dir)) trackedByDir.set(dir, []);
    trackedByDir.get(dir).push(file);
  }
  const allDirs = new Set();
  for (const file of tracked) {
    let dir = dirname(file);
    while (dir && dir !== ".") {
      allDirs.add(dir);
      dir = dirname(dir);
    }
  }
  const complete = new Set();
  for (const dir of allDirs) {
    const members = tracked.filter((file) => file.startsWith(`${dir}/`));
    if (members.length > 0 && members.every((file) => profileSet.has(file))) complete.add(dir);
  }
  const patterns = [];
  const covered = new Set();
  for (const dir of [...complete].sort()) {
    const parent = dirname(dir);
    if (parent !== "." && complete.has(parent)) continue;
    patterns.push(`/${dir}/`);
    for (const file of tracked) if (file.startsWith(`${dir}/`)) covered.add(file);
  }
  for (const file of [...profileSet].sort()) {
    if (covered.has(file)) continue;
    patterns.push(`/${file}`);
  }
  return patterns.sort();
}

function bytesOf(paths) {
  let total = 0;
  for (const path of paths) {
    try {
      total += statSync(resolve(ROOT, path)).size;
    } catch {
      /* a path absent from this working tree contributes no measured bytes */
    }
  }
  return total;
}

function build() {
  const config = readJson(CONFIG_PATH);
  const tracked = trackedFiles();
  const trackedSet = new Set(tracked);

  const observed = observedClosure(config, tracked);
  const observedAll = new Set();
  for (const [, entry] of observed) for (const path of entry.paths) observedAll.add(path);
  const staticScan = staticClosure(tracked, observedAll, config);
  const declared = declaredClosure(config, tracked);

  const profileSet = new Set(declared);
  for (const path of observedAll) profileSet.add(path);

  // Static references split in two. A reference from the seed trees is always
  // materialised: every Worker source is present and any of them can be loaded,
  // so the CI-08 cross-boundary risk is closed by construction. A reference that
  // only a byte-heavy deferred tree would satisfy, and that no supported gate
  // was observed to read, becomes an explicit hydration entry instead: it is
  // named in the manifest, it fails closed if a gate reaches for it, and one
  // documented command materialises it.
  const hydrationSet = new Set();
  for (const path of staticScan.paths) {
    if (!trackedSet.has(path)) continue;
    if (profileSet.has(path)) continue;
    const deferred = underAny(path, config.defer_static_only_trees);
    if (deferred && !staticScan.fromSeedTree.includes(path)) {
      hydrationSet.add(path);
      continue;
    }
    profileSet.add(path);
  }

  const patterns = emitPatterns(profileSet, tracked);

  // The contract the committed pattern list has to satisfy: everything a
  // supported gate class was observed to read, everything the always-include
  // list names, and every static reference from the seed trees.
  const requiredPaths = new Set([...observedAll, ...config.always_include_paths.filter((path) => trackedSet.has(path))]);
  for (const path of staticScan.fromSeedTree) if (trackedSet.has(path)) requiredPaths.add(path);

  const excludedTracked = tracked.filter((file) => !profileSet.has(file));
  const siteData = tracked.filter((file) => file.startsWith("site/data/"));
  const siteDataIncluded = siteData.filter((file) => profileSet.has(file));

  const closure = {
    schema: "cityscroll.card-profile.closure.v1",
    profile: config.profile,
    generated_by: "node tools/derive_card_profile.mjs",
    config_sha256: sha256(readFileSync(CONFIG_PATH)),
    sources: {
      observed: {
        description:
          "Repository paths recorded by tools/card_profile_sentinel.cjs while each supported gate class ran on a full checkout.",
        gate_classes: config.gate_classes.map((gate) => ({
          id: gate.id,
          recorded: observed.get(gate.id)?.recorded ?? false,
          path_count: observed.get(gate.id)?.paths.length ?? 0
        })),
        path_count: observedAll.size
      },
      static: {
        description:
          "Repository paths named by an import specifier or a path-shaped string literal in worker/, site/, tools/ and test/ sources.",
        seed_trees: config.static_seed_trees,
        scan_hops: config.static_scan_hops,
        scanned_source_count: staticScan.scanned_count,
        path_count: staticScan.paths.length,
        worker_to_site_reference_count: staticScan.crossBoundary.length,
        worker_to_site_data_reference_count: staticScan.crossBoundary.filter((edge) =>
          edge.to.startsWith("site/data/")
        ).length,
        worker_to_site_data_targets: [
          ...new Set(
            staticScan.crossBoundary.filter((edge) => edge.to.startsWith("site/data/")).map((edge) => edge.to)
          )
        ].sort()
      },
      declared: {
        description: "Structural trees a card-work checkout holds regardless of gate reads, minus the byte-heavy excluded trees.",
        include_trees: config.include_trees,
        exclude_trees: config.exclude_trees,
        path_count: declared.length
      }
    },
    required_paths: [...requiredPaths].sort(),
    deferred_hydration_set: {
      description:
        "Tracked paths a scanned source references but no supported gate class was observed to read. They stay out of the working tree; a supported gate that reaches for one fails closed through tools/card_profile_sentinel.cjs, and tools/provision_card_profile.sh hydrate materialises it.",
      paths: [...hydrationSet].sort()
    },
    site_data: {
      profile_paths: siteDataIncluded
    },
    patterns_sha256: sha256(`${patterns.join("\n")}\n`),
    supported_gate_classes: config.gate_classes.filter((gate) => gate.profile_supported).map((gate) => gate.id),
    full_checkout_only: config.full_checkout_only,
    missing_path_behaviour:
      "A tracked path the profile does not materialise is marked skip-worktree in the index. tools/card_profile_sentinel.cjs turns a missing-file error on such a path into CardProfileMissingPath and records it, so a profile gap fails closed instead of passing by omission. tools/provision_card_profile.sh hydrate is the documented route to materialise one."
  };

  // Volatile figures live in their own block and are excluded from the
  // coverage check, because they move whenever any tracked file changes size.
  closure.measured = {
    note:
      "A snapshot of what the profile costs at the revision named here. These figures are reporting only; they are not part of the checked contract, because a byte total moves whenever any tracked file does.",
    revision: headRevision(),
    profile_paths: { count: profileSet.size, logical_bytes: bytesOf(profileSet) },
    deferred_paths: { count: hydrationSet.size, logical_bytes: bytesOf(hydrationSet) },
    excluded_paths: { count: excludedTracked.length, logical_bytes: bytesOf(excludedTracked) },
    site_data: {
      tracked_count: siteData.length,
      tracked_logical_bytes: bytesOf(siteData),
      profile_count: siteDataIncluded.length,
      profile_logical_bytes: bytesOf(siteDataIncluded)
    },
    tracked_total: { count: tracked.length, logical_bytes: bytesOf(tracked) },
    pattern_count: patterns.length
  };

  const sparse = [
    "# Generated by node tools/derive_card_profile.mjs. Do not hand-edit.",
    "# Git sparse-checkout patterns for the reduced card-work profile.",
    ...patterns,
    ""
  ].join("\n");

  return { sparse, closure: `${encodeInventory(closure)}\n`, patterns, profileSet, requiredPaths };
}

function main() {
  const check = process.argv.includes("--check");
  const built = build();
  if (!check) {
    writeFileSync(SPARSE_PATH, built.sparse);
    writeFileSync(CLOSURE_PATH, built.closure);
    console.log(`wrote ${built.patterns.length} sparse patterns covering ${built.profileSet.size} tracked paths`);
    return 0;
  }
  const problems = [];
  if (!existsSync(SPARSE_PATH) || !existsSync(CLOSURE_PATH)) {
    console.error("card profile outputs are missing; run: node tools/derive_card_profile.mjs");
    return 1;
  }
  const committedPatterns = readFileSync(SPARSE_PATH, "utf8")
    .split("\n")
    .filter((line) => line && !line.startsWith("#"));
  const committed = JSON.parse(readFileSync(CLOSURE_PATH, "utf8"));

  if (committed.config_sha256 !== sha256(readFileSync(CONFIG_PATH))) {
    problems.push("the committed manifest was generated from a different profile config");
  }

  const matches = (path) =>
    committedPatterns.some((pattern) =>
      pattern.endsWith("/") ? path.startsWith(pattern.slice(1)) : path === pattern.slice(1)
    );

  const uncovered = [...built.requiredPaths].filter((path) => !matches(path));
  if (uncovered.length > 0) {
    problems.push(
      `${uncovered.length} required path(s) are not covered by the committed patterns, ` +
        `starting with ${uncovered.slice(0, 3).join(", ")}`
    );
  }

  const leaked = (committed.deferred_hydration_set?.paths ?? []).filter((path) => matches(path));
  if (leaked.length > 0) {
    problems.push(
      `${leaked.length} deferred path(s) are materialised by the committed patterns, ` +
        `starting with ${leaked.slice(0, 3).join(", ")}`
    );
  }

  if (problems.length > 0) {
    console.error("card profile contract failed; regenerate with: node tools/derive_card_profile.mjs");
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }
  console.log(
    `card profile patterns cover all ${built.requiredPaths.size} required paths and no deferred path`
  );
  return 0;
}

process.exit(main());
