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
//   tools/card-profile/card-work.sparse        sparse-checkout patterns
//   tools/card-profile/closure.v1.json         the closure contract
//   tools/card-profile/closure.d/*.txt         the derived path inventories
//
// The split exists so a change that merely adds a tracked file cannot conflict
// with another change that does the same. Everything whose value moves with the
// repository rather than with the profile policy — path counts, byte totals, the
// revision, the digest of the pattern list — is not committed at all; it is
// reported on demand by `--measure`. What is committed is either policy (the
// contract manifest, which should conflict when two changes really disagree) or
// a sorted one-path-per-line inventory, which two changes extend on different
// lines. `.gitattributes` marks the inventories and the pattern list
// `merge=union`, and every reader sorts and deduplicates, so a union merge is
// always a valid input and the next regeneration restores the canonical form.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  INVENTORIES,
  closurePath,
  committedPatterns,
  inventoryPath,
  loadClosure,
  materialisedByPatterns,
  sparsePath
} from "./card_profile_closure.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = resolve(ROOT, "tools/card-profile/profile.config.v1.json");
const SPARSE_PATH = sparsePath(ROOT);
const CLOSURE_PATH = closurePath(ROOT);
const OBSERVATION_DIR = resolve(ROOT, "docs/evidence/ci-09-working-copy-reduction/raw/closure");

const STATIC_SCAN_EXTENSIONS = new Set([".mjs", ".js", ".cjs", ".ts"]);

// These generated inventories list tracked paths verbatim. Every public
// cross-boundary identity is spelled plainly, so no path in this closure needs
// an escape to be written down, and none is applied.
function renderInventory(value) {
  return JSON.stringify(value, null, 2);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

// Paths the index carries but this working tree does not hold. Reading one
// would be a profile violation, so the scan skips them and says so rather than
// tripping the sentinel it exists to serve.
function notMaterialisedPaths() {
  const excluded = new Set();
  try {
    const listing = execFileSync("git", ["ls-files", "-t"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    for (const line of listing.split("\n")) if (line.startsWith("S ")) excluded.add(line.slice(2));
  } catch {
    /* a repository without sparse checkout has nothing to exclude */
  }
  return excluded;
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
function staticClosure(tracked, seeds, config, notMaterialised) {
  const trackedSet = new Set(tracked);
  let skipped = 0;
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
    if (notMaterialised.has(file)) {
      skipped += 1;
      continue;
    }
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
    scanned_count: scanned.size,
    skipped_not_materialised: skipped
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

// Logical size of every tracked path, taken from the index blob rather than the
// working tree. A statSync walk silently scores a deferred path as zero, so a
// figure derived in a reduced checkout would report the bytes the profile defers
// as costing nothing and the corpus it hydrates as free. Blob sizes are the same
// number in either profile, which is what makes the measurement reproducible
// from a clean checkout and keeps hydrated bytes visible.
function blobSizes() {
  const sizes = new Map();
  const listing = execFileSync("git", ["ls-files", "-s", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024
  });
  const oids = new Map();
  for (const record of listing.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [, oid] = record.slice(0, tab).split(" ");
    oids.set(record.slice(tab + 1), oid);
  }
  if (oids.size === 0) return sizes;
  const unique = [...new Set(oids.values())];
  const report = execFileSync("git", ["cat-file", "--batch-check=%(objectname) %(objectsize)"], {
    cwd: ROOT,
    encoding: "utf8",
    input: `${unique.join("\n")}\n`,
    maxBuffer: 256 * 1024 * 1024
  });
  const byOid = new Map();
  for (const line of report.split("\n")) {
    const [oid, size] = line.split(" ");
    if (oid && size && /^\d+$/.test(size)) byOid.set(oid, Number(size));
  }
  for (const [path, oid] of oids) sizes.set(path, byOid.get(oid) ?? 0);
  return sizes;
}

function bytesOf(paths, sizes) {
  let total = 0;
  for (const path of paths) total += sizes.get(path) ?? 0;
  return total;
}

// --- derived: the functional read-model corpus ------------------------------
//
// tools/prepare_functional_site.sh materialises the static-first document routes
// the functional browser family is served from, and the builder it runs first
// reads tracked read models. A reduced checkout defers some of them, so the
// preparation step fails on an absent input with nothing to say about why. The
// corpus names that dependency so it can be materialised at provision time and
// asserted before the step runs.
//
// It has two halves. The sentinel records what Node reads, so the builder's
// inputs are observed. The functional harness is Python: it pins its fixtures
// and its browser clock against tracked read models it opens directly, and no
// Node recording can see those, so they are scanned out of the declared harness
// sources rather than carried as a hand-written list. A harness that starts
// reading another read model is then picked up by regenerating the profile,
// rather than by a test failing in someone's reduced checkout.
const HARNESS_SEGMENTED = /"([A-Za-z0-9_.-]+)"\s*\/\s*"([A-Za-z0-9_.-]+)"\s*\/\s*"([A-Za-z0-9_.-]+)"/g;
const HARNESS_LITERAL = /\b((?:[A-Za-z0-9_-]+\/)+[A-Za-z0-9_.-]+\.json)\b/g;

function harnessClosure(declaration, trackedSet) {
  const found = new Set();
  for (const source of declaration.harness_sources ?? []) {
    let text;
    try {
      text = readFileSync(resolve(ROOT, source), "utf8");
    } catch {
      continue;
    }
    for (const pattern of [HARNESS_SEGMENTED, HARNESS_LITERAL]) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const candidate = pattern === HARNESS_SEGMENTED ? `${match[1]}/${match[2]}/${match[3]}` : match[1];
        if (trackedSet.has(candidate)) found.add(candidate);
      }
    }
  }
  return found;
}

function functionalCorpus(config, observed, sizes, trackedSet) {
  const declaration = config.functional_corpus;
  if (!declaration?.gate_class || !Array.isArray(declaration.corpus_trees)) {
    throw new Error("profile.config.v1.json declares no usable functional_corpus block");
  }
  const entry = observed.get(declaration.gate_class);
  const harness = harnessClosure(declaration, trackedSet);
  const paths = [
    ...new Set([...(entry?.paths ?? []), ...harness].filter((path) => underAny(path, declaration.corpus_trees)))
  ].sort();
  return {
    description: declaration.description,
    gate_class: declaration.gate_class,
    builder: declaration.builder,
    builder_role: declaration.builder_role,
    corpus_trees: declaration.corpus_trees,
    vintage_anchor: declaration.vintage_anchor,
    measured_functional_tests: declaration.measured_functional_tests,
    coverage_note: declaration.coverage_note,
    recorded: entry?.recorded ?? false,
    remediation:
      "node tools/verify_functional_corpus.mjs --check names the paths this checkout is missing and the exact tools/provision_card_profile.sh hydrate command that materialises them.",
    path_count: paths.length,
    logical_bytes: bytesOf(paths, sizes),
    paths
  };
}

function build() {
  const config = readJson(CONFIG_PATH);
  const tracked = trackedFiles();
  const trackedSet = new Set(tracked);

  const notMaterialised = notMaterialisedPaths();
  const sizes = blobSizes();
  const observed = observedClosure(config, tracked);
  const observedAll = new Set();
  for (const [, entry] of observed) for (const path of entry.paths) observedAll.add(path);
  const staticScan = staticClosure(tracked, observedAll, config, notMaterialised);
  const declared = declaredClosure(config, tracked);

  const profileSet = new Set(declared);
  for (const path of observedAll) profileSet.add(path);

  // The functional read-model corpus is part of the profile, not an optional
  // extra. It is derived before the static split so a corpus path can never be
  // routed into the deferred hydration set, which is what would leave a fresh
  // reduced checkout unable to prepare the functional site.
  const corpus = functionalCorpus(config, observed, sizes, trackedSet);
  for (const path of corpus.paths) profileSet.add(path);

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
  for (const path of corpus.paths) requiredPaths.add(path);

  const excludedTracked = tracked.filter((file) => !profileSet.has(file));
  const siteData = tracked.filter((file) => file.startsWith("site/data/"));
  const siteDataIncluded = siteData.filter((file) => profileSet.has(file));

  // The committed contract. It carries policy and declarations only: nothing
  // here moves because an unrelated tracked file was added, resized or renamed,
  // so two changes that both regenerate the profile do not rewrite the same
  // lines. The derived path inventories are written beside it as sorted
  // one-path-per-line files, and every measurement is left uncommitted.
  const closure = {
    schema: "cityscroll.card-profile.closure.v1",
    profile: config.profile,
    generated_by: "node tools/derive_card_profile.mjs",
    config_sha256: sha256(readFileSync(CONFIG_PATH)),
    inventories: {
      description:
        "Derived path inventories, one sorted repository path per line, stored beside this contract so concurrent changes extend different lines instead of rewriting a shared aggregate. Read them through tools/card_profile_closure.mjs, which sorts and deduplicates, never positionally.",
      directory: "tools/card-profile/closure.d",
      files: Object.fromEntries(Object.entries(INVENTORIES).map(([field, file]) => [field, file]))
    },
    measurement: {
      description:
        "Path counts, byte totals and the revision the profile was derived at are reporting figures that move whenever any tracked file does. They are derived on demand rather than committed, because committing them makes every change rewrite the same lines.",
      command: "node tools/derive_card_profile.mjs --measure"
    },
    sources: {
      observed: {
        description:
          "Repository paths recorded by tools/card_profile_sentinel.cjs while each supported gate class ran on a full checkout.",
        gate_classes: config.gate_classes.map((gate) => ({
          id: gate.id,
          recorded: observed.get(gate.id)?.recorded ?? false
        }))
      },
      static: {
        description:
          "Repository paths named by an import specifier or a path-shaped string literal in worker/, site/, tools/ and test/ sources.",
        seed_trees: config.static_seed_trees,
        scan_hops: config.static_scan_hops,
        worker_to_site_data_targets_note:
          "The site/data paths a Worker source reaches across the package boundary for. This is the CI-08 risk the profile has to hold; the list itself is the worker_to_site_data_targets inventory."
      },
      declared: {
        description: "Structural trees a card-work checkout holds regardless of gate reads, minus the byte-heavy excluded trees.",
        include_trees: config.include_trees,
        exclude_trees: config.exclude_trees
      }
    },
    deferred_hydration_set: {
      description:
        "Tracked paths a scanned source references but no supported gate class was observed to read. They stay out of the working tree; a supported gate that reaches for one fails closed through tools/card_profile_sentinel.cjs, and tools/provision_card_profile.sh hydrate materialises it."
    },
    supported_gate_classes: config.gate_classes.filter((gate) => gate.profile_supported).map((gate) => gate.id),
    full_checkout_only: config.full_checkout_only,
    missing_path_behaviour:
      "A tracked path the profile does not materialise is marked skip-worktree in the index. tools/card_profile_sentinel.cjs turns a missing-file error on such a path into CardProfileMissingPath and records it, so a profile gap fails closed instead of passing by omission.",
    functional_corpus: {
      description: corpus.description,
      gate_class: corpus.gate_class,
      builder: corpus.builder,
      builder_role: corpus.builder_role,
      corpus_trees: corpus.corpus_trees,
      vintage_anchor: corpus.vintage_anchor,
      measured_functional_tests: corpus.measured_functional_tests,
      coverage_note: corpus.coverage_note,
      recorded: corpus.recorded,
      remediation: corpus.remediation
    }
  };

  const inventories = {
    required_paths: [...requiredPaths].sort(),
    deferred_paths: [...hydrationSet].sort(),
    site_data_paths: siteDataIncluded,
    functional_corpus_paths: corpus.paths,
    worker_to_site_data_targets: [
      ...new Set(staticScan.crossBoundary.filter((edge) => edge.to.startsWith("site/data/")).map((edge) => edge.to))
    ].sort()
  };

  // Reporting only, and deliberately not committed: every figure here moves
  // whenever any tracked file does.
  const measured = {
    note: "A snapshot of what the profile costs at the revision named here. Derived on demand, never committed.",
    revision: headRevision(),
    computed_in_reduced_checkout: notMaterialised.size > 0,
    sources: {
      observed: {
        gate_classes: config.gate_classes.map((gate) => ({
          id: gate.id,
          recorded: observed.get(gate.id)?.recorded ?? false,
          path_count: observed.get(gate.id)?.paths.length ?? 0
        })),
        path_count: observedAll.size
      },
      static: {
        scanned_source_count: staticScan.scanned_count,
        sources_skipped_not_materialised: staticScan.skipped_not_materialised,
        path_count: staticScan.paths.length,
        worker_to_site_reference_count: staticScan.crossBoundary.length,
        worker_to_site_data_reference_count: staticScan.crossBoundary.filter((edge) =>
          edge.to.startsWith("site/data/")
        ).length
      },
      declared: { path_count: declared.length }
    },
    profile_paths: { count: profileSet.size, logical_bytes: bytesOf(profileSet, sizes) },
    deferred_paths: { count: hydrationSet.size, logical_bytes: bytesOf(hydrationSet, sizes) },
    excluded_paths: { count: excludedTracked.length, logical_bytes: bytesOf(excludedTracked, sizes) },
    site_data: {
      tracked_count: siteData.length,
      tracked_logical_bytes: bytesOf(siteData, sizes),
      profile_count: siteDataIncluded.length,
      profile_logical_bytes: bytesOf(siteDataIncluded, sizes)
    },
    functional_corpus: { path_count: corpus.paths.length, logical_bytes: bytesOf(corpus.paths, sizes) },
    tracked_total: { count: tracked.length, logical_bytes: bytesOf(tracked, sizes) },
    pattern_count: patterns.length,
    patterns_sha256: sha256(`${patterns.join("\n")}\n`)
  };

  const sparse = [
    "# Generated by node tools/derive_card_profile.mjs. Do not hand-edit.",
    "# Git sparse-checkout patterns for the reduced card-work profile.",
    "# One pattern per line, sorted. Merged with the union driver, so a",
    "# concurrent addition is kept rather than resolved by hand.",
    ...patterns,
    ""
  ].join("\n");

  return { sparse, closure: `${renderInventory(closure)}\n`, inventories, measured, patterns, profileSet, requiredPaths };
}

function writeInventory(field, paths) {
  const file = INVENTORIES[field];
  const path = inventoryPath(field, ROOT);
  mkdirSync(dirname(path), { recursive: true });
  const body = [
    `# ${file} — generated by node tools/derive_card_profile.mjs. Do not hand-edit.`,
    "# One repository path per line, sorted. Merged with the union driver, so a",
    "# concurrent addition is kept rather than resolved by hand; readers sort and",
    "# deduplicate, and the next regeneration restores this canonical order.",
    ...paths,
    ""
  ].join("\n");
  writeFileSync(path, body);
}

function write(built) {
  writeFileSync(SPARSE_PATH, built.sparse);
  writeFileSync(CLOSURE_PATH, built.closure);
  for (const field of Object.keys(INVENTORIES)) writeInventory(field, built.inventories[field]);
  console.log(
    `wrote ${built.patterns.length} sparse patterns covering ${built.profileSet.size} tracked paths ` +
      `and ${Object.keys(INVENTORIES).length} path inventories`
  );
  return 0;
}

// Coverage, not byte-identity, and set-based rather than order-based. The
// committed pattern list has to materialise everything the closure requires and
// nothing it defers; how the lines happen to be ordered after a union merge is
// not part of that contract.
function check(built) {
  const problems = [];
  if (!existsSync(SPARSE_PATH) || !existsSync(CLOSURE_PATH)) {
    console.error("card profile outputs are missing; run: node tools/derive_card_profile.mjs");
    return 1;
  }
  const missingInventories = Object.keys(INVENTORIES).filter((field) => !existsSync(inventoryPath(field, ROOT)));
  if (missingInventories.length > 0) {
    console.error(`card profile inventories are missing: ${missingInventories.join(", ")}`);
    console.error("regenerate with: node tools/derive_card_profile.mjs");
    return 1;
  }

  const patterns = committedPatterns(ROOT);
  const committed = loadClosure(ROOT);

  if (committed.config_sha256 !== sha256(readFileSync(CONFIG_PATH))) {
    problems.push("the committed manifest was generated from a different profile config");
  }

  const matches = (path) => materialisedByPatterns(patterns, path);

  const uncovered = [...built.requiredPaths].filter((path) => !matches(path));
  if (uncovered.length > 0) {
    problems.push(
      `${uncovered.length} required path(s) are not covered by the committed patterns, ` +
        `starting with ${uncovered.slice(0, 3).join(", ")}`
    );
  }

  // The committed inventory is checked as well as the freshly derived set. A
  // union merge can carry forward a path a later change removed from the
  // profile, and this is where that shows up as something to regenerate rather
  // than as a reduced checkout that quietly lacks a file.
  const staleRequired = committed.required_paths.filter((path) => !matches(path));
  if (staleRequired.length > 0) {
    problems.push(
      `${staleRequired.length} committed required path(s) are not covered by the committed patterns, ` +
        `starting with ${staleRequired.slice(0, 3).join(", ")}`
    );
  }

  const leaked = committed.deferred_hydration_set.paths.filter((path) => matches(path));
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
  // A source the active profile does not materialise cannot be scanned, so its
  // references are not part of what this run can require. The count is printed
  // so a reduced-profile run is never mistaken for a full-checkout one.
  const skipped = built.measured.sources.static.sources_skipped_not_materialised;
  const scope = skipped > 0 ? ` (${skipped} source(s) not materialised here were not scanned)` : "";
  console.log(
    `card profile patterns cover all ${built.requiredPaths.size} required paths and no deferred path${scope}`
  );
  return 0;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--measure")) {
    console.log(renderInventory(build().measured));
    return 0;
  }
  const built = build();
  return argv.includes("--check") ? check(built) : write(built);
}

process.exit(main());
