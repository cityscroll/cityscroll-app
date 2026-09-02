// The functional corpus readiness contract.
//
// CI-10 routed focused card work to a reduced profile whose closure omitted the
// read models the functional site preparation builds from. The failure that
// produced was unreadable twice over: the builder died on a bare ENOENT, and the
// copy step after it cannot fail on an absent input at all, so a checkout that
// got past the builder served a smaller site and the browser check timed out
// waiting for a row that was never going to render. A provisioning gap arrived
// looking like a product regression.
//
// These tests hold the two halves of the repair. The corpus is declared and
// materialised, so a fresh reduced checkout is ready by construction; and when
// it is not ready the gate says so in a structured, honest way rather than
// passing, skipping, or letting the builder speak for it.
//
// The negative cases run against purpose-built temporary repositories through
// the tool's documented root seam. Producing them by de-hydrating this checkout
// would leave whoever ran the suite with a half-provisioned working tree.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOOL = join(ROOT, "tools/verify_functional_corpus.mjs");
const CLOSURE = JSON.parse(readFileSync(join(ROOT, "tools/card-profile/closure.v1.json"), "utf8"));
const CONFIG = JSON.parse(readFileSync(join(ROOT, "tools/card-profile/profile.config.v1.json"), "utf8"));

function run(args, env = {}) {
  const result = spawnSync(process.execPath, [TOOL, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// A minimal repository that is shaped like a reduced checkout: a closure
// manifest declaring a corpus, and the corpus files themselves either present,
// absent, or modified away from what the index records.
function scaffold({ corpusPaths = ["site/data/one.json", "site/data/two.json"], materialise = null, modify = [], closureOverride = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cityscroll-functional-corpus-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "test");

  for (const path of corpusPaths) {
    mkdirSync(join(dir, dirname(path)), { recursive: true });
    writeFileSync(join(dir, path), `${JSON.stringify({ open_as_of: "2026-08-15", path }, null, 2)}\n`);
  }
  mkdirSync(join(dir, "tools/card-profile"), { recursive: true });
  const closure = closureOverride ?? {
    schema: "cityscroll.card-profile.closure.v1",
    config_sha256: "0".repeat(64),
    patterns_sha256: "1".repeat(64),
    functional_corpus: {
      gate_class: "functional-site",
      builder: "tools/build_primary_documents.mjs",
      builder_role: "test double",
      corpus_trees: ["site/data"],
      vintage_anchor: { path: corpusPaths[0], keys: ["open_as_of"] },
      measured_functional_tests: ["test/functional/23_mobile_viewport.py"],
      coverage_note: "test double",
      paths: corpusPaths
    }
  };
  writeFileSync(join(dir, "tools/card-profile/closure.v1.json"), `${JSON.stringify(closure, null, 2)}\n`);
  git("add", "-A");
  git("commit", "-qm", "scaffold");

  // Mark the paths this checkout does not hold exactly the way a sparse
  // checkout does, so the tool sees the real condition rather than a simulation.
  if (materialise) {
    git("config", "core.sparseCheckout", "true");
    const absent = corpusPaths.filter((path) => !materialise.includes(path));
    for (const path of absent) {
      git("update-index", "--skip-worktree", path);
      rmSync(join(dir, path), { force: true });
    }
  }
  for (const path of modify) writeFileSync(join(dir, path), '{"changed": true}\n');
  return dir;
}

const scaffolds = [];
function temporaryRepository(options) {
  const dir = scaffold(options);
  scaffolds.push(dir);
  return { root: dir, env: { CITYSCROLL_FUNCTIONAL_CORPUS_ROOT: dir } };
}

test.after(() => {
  for (const dir of scaffolds) rmSync(dir, { recursive: true, force: true });
});

// --- the declaration itself -------------------------------------------------

test("the closure declares a non-empty functional corpus derived from the profile config", () => {
  const corpus = CLOSURE.functional_corpus;
  assert.ok(corpus, "the closure manifest carries no functional_corpus block");
  assert.ok(corpus.paths.length > 0, "the declared functional corpus is empty");
  assert.equal(corpus.gate_class, CONFIG.functional_corpus.gate_class);
  assert.equal(corpus.builder, CONFIG.functional_corpus.builder);
  // Every declared path lives in a tree the profile otherwise defers. A corpus
  // entry outside those trees would be a path the profile always held, listed
  // here to make the corpus look better covered than it is.
  for (const path of corpus.paths) {
    assert.ok(
      CONFIG.functional_corpus.corpus_trees.some((tree) => path.startsWith(`${tree}/`)),
      `declared corpus path outside the declared corpus trees: ${path}`
    );
  }
});

test("every declared corpus path is materialised by the committed pattern list", () => {
  const patterns = readFileSync(join(ROOT, "tools/card-profile/card-work.sparse"), "utf8")
    .split("\n")
    .filter((line) => line && !line.startsWith("#"));
  const covered = (path) =>
    patterns.some((pattern) =>
      pattern.endsWith("/") ? path.startsWith(pattern.slice(1)) : path === pattern.slice(1)
    );
  const uncovered = CLOSURE.functional_corpus.paths.filter((path) => !covered(path));
  assert.deepEqual(uncovered, [], "a declared corpus path the reduced profile would not materialise");
});

test("the corpus is not in the deferred hydration set, which would defeat the declaration", () => {
  const deferred = new Set(CLOSURE.deferred_hydration_set?.paths ?? []);
  const leaked = CLOSURE.functional_corpus.paths.filter((path) => deferred.has(path));
  assert.deepEqual(leaked, [], "a declared corpus path is also declared deferred");
});

test("the functional harness reads no tracked read model the corpus does not declare", () => {
  const declared = new Set(CLOSURE.functional_corpus.paths);
  const segmented = /"([A-Za-z0-9_.-]+)"\s*\/\s*"([A-Za-z0-9_.-]+)"\s*\/\s*"([A-Za-z0-9_.-]+)"/g;
  const literal = /\b((?:[A-Za-z0-9_-]+\/)+[A-Za-z0-9_.-]+\.json)\b/g;
  const trees = CLOSURE.functional_corpus.corpus_trees;
  const missing = new Set();
  for (const source of CONFIG.functional_corpus.harness_sources) {
    const text = readFileSync(join(ROOT, source), "utf8");
    for (const pattern of [segmented, literal]) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const candidate = pattern === segmented ? `${match[1]}/${match[2]}/${match[3]}` : match[1];
        if (!trees.some((tree) => candidate.startsWith(`${tree}/`))) continue;
        if (!declared.has(candidate)) missing.add(candidate);
      }
    }
  }
  assert.deepEqual([...missing], [], "the harness reads a read model the declared corpus omits");
});

// --- the ready case ---------------------------------------------------------

test("a checkout holding the corpus reports ready, and says so without claiming a test result", () => {
  const { env } = temporaryRepository({});
  const result = run(["--check", "--json"], env);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.outcome, "ready");
  assert.equal(receipt.blocked_reasons.length, 0);
  assert.equal(receipt.corpus.materialised_path_count, receipt.corpus.declared_path_count);
  assert.match(receipt.coverage_statement, /product result/);
  // Ready is a statement about inputs. It must not imply the suite passed.
  assert.doesNotMatch(receipt.coverage_statement, /passed/);
});

test("the ready receipt identifies the profile, revision, corpus fingerprint, bytes and vintage", () => {
  const { env } = temporaryRepository({});
  const receipt = JSON.parse(run(["--check", "--json"], env).stdout);
  assert.equal(receipt.schema, "cityscroll.functional-corpus-readiness.v1");
  assert.match(receipt.revision, /^[0-9a-f]{40}$/);
  assert.match(receipt.corpus.fingerprint, /^[0-9a-f]{64}$/);
  assert.ok(receipt.corpus.logical_bytes > 0);
  assert.equal(receipt.source_vintage.day, "2026-08-15");
  assert.equal(receipt.profile.synthetic_root, true, "a seam receipt must declare itself synthetic");
  assert.ok(typeof receipt.check_duration_ms === "number");
});

test("the receipt is reproducible: two runs over an unchanged checkout agree on every deterministic field", () => {
  const { env } = temporaryRepository({});
  const first = JSON.parse(run(["--check", "--json"], env).stdout);
  const second = JSON.parse(run(["--check", "--json"], env).stdout);
  for (const receipt of [first, second]) delete receipt.check_duration_ms;
  assert.deepEqual(first, second);
});

// --- the blocked cases ------------------------------------------------------

test("a missing corpus blocks, names the missing input, the builder and the remediation", () => {
  const { env } = temporaryRepository({ materialise: ["site/data/one.json"] });
  const result = run(["--check", "--json"], env);
  assert.equal(result.status, 6, "a blocked corpus must not exit zero");
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.outcome, "blocked");
  assert.equal(receipt.functional_coverage, "none");
  assert.match(receipt.coverage_statement, /No functional test was run/);
  const reason = receipt.blocked_reasons.find((entry) => entry.kind === "missing-corpus");
  assert.ok(reason, "a blocked receipt must name why");
  assert.deepEqual(reason.paths, ["site/data/two.json"]);
  assert.equal(receipt.corpus.builder, "tools/build_primary_documents.mjs");
  assert.match(receipt.remediation.hydrate, /site\/data\/two\.json/);
  assert.ok(receipt.remediation.full_control.includes("hydrate --full"));
});

test("a blocked run says plainly that no coverage was obtained and does not report a product verdict", () => {
  const { env } = temporaryRepository({ materialise: [] });
  const result = run(["--check"], env);
  assert.equal(result.status, 6);
  assert.match(result.stderr, /BLOCKED/);
  assert.match(result.stderr, /no coverage was obtained/);
  // The one thing a blocked run must never be mistaken for.
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /\bpass(ed|es)?\b/i);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /\bskip(ped|ping)?\b/i);
});

test("a stale corpus blocks rather than building from data the revision does not describe", () => {
  const { env } = temporaryRepository({ modify: ["site/data/two.json"] });
  const result = run(["--check", "--json"], env);
  assert.equal(result.status, 6);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.outcome, "blocked");
  const reason = receipt.blocked_reasons.find((entry) => entry.kind === "stale-corpus");
  assert.ok(reason, "a modified corpus path must be reported as stale");
  assert.deepEqual(reason.paths, ["site/data/two.json"]);
});

test("an empty corpus declaration fails closed instead of reading as nothing-required", () => {
  const { env } = temporaryRepository({
    closureOverride: {
      schema: "cityscroll.card-profile.closure.v1",
      functional_corpus: { gate_class: "functional-site", builder: "x", corpus_trees: ["site/data"], paths: [] }
    }
  });
  const result = run(["--check"], env);
  assert.equal(result.status, 2, "an empty declaration is a broken declaration, not a satisfied one");
  assert.match(result.stderr, /empty/);
});

test("a closure manifest with no corpus block fails closed", () => {
  const { env } = temporaryRepository({
    closureOverride: { schema: "cityscroll.card-profile.closure.v1" }
  });
  const result = run(["--check"], env);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /declares no functional corpus/);
});

// --- the boundary the repair must not cross ---------------------------------

test("the readiness gate reports on inputs only, so it can never absorb a functional failure", () => {
  // The gate runs before the functional command and never wraps it. The
  // structural proof is that the preparation script invokes the check as its own
  // statement, with no functional command in scope and nothing that could
  // swallow a later exit status.
  const script = readFileSync(join(ROOT, "tools/prepare_functional_site.sh"), "utf8");
  assert.match(script, /set -euo pipefail/, "the preparation step must abort on a failing precondition");
  const checkLine = script.indexOf("verify_functional_corpus.mjs --check");
  const builderLine = script.indexOf("build_primary_documents.mjs");
  assert.ok(checkLine > 0 && builderLine > checkLine, "readiness must be asserted before the builder runs");
  assert.doesNotMatch(script, /\|\|\s*true/, "no || true workaround");
  assert.doesNotMatch(script, /\bskip\b/i, "the preparation step must not skip anything");
});

test("the reduced profile does not silently widen: the corpus stays inside the declared corpus trees", () => {
  const trees = CLOSURE.functional_corpus.corpus_trees;
  const excluded = new Set(CONFIG.exclude_trees);
  for (const tree of trees) {
    assert.ok(excluded.has(tree), `corpus tree ${tree} is not one of the profile's excluded trees`);
  }
  // The corpus is a bounded subset of its trees, not the trees themselves.
  const treeTracked = execFileSync("git", ["ls-files", "--", ...trees], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n")
    .filter(Boolean);
  assert.ok(
    CLOSURE.functional_corpus.paths.length < treeTracked.length,
    "the declared corpus is the whole tree, which is the full checkout by another name"
  );
});

test("the functional-site gate class is declared, supported, and carries a recorded observation", () => {
  const gate = CONFIG.gate_classes.find((entry) => entry.id === "functional-site");
  assert.ok(gate, "the functional-site gate class is not declared");
  assert.equal(gate.profile_supported, true);
  assert.ok(CLOSURE.supported_gate_classes.includes("functional-site"));
  const observation = JSON.parse(
    readFileSync(join(ROOT, "docs/evidence/ci-09-working-copy-reduction/raw/closure", gate.observation), "utf8")
  );
  assert.equal(observation.gate_class, "functional-site");
  assert.equal(observation.exit_status, 0, "an observation recorded from a failed run does not describe the closure");
  assert.ok(observation.paths.length > 0);
  // The recorder now reports the profile it ran in rather than asserting one.
  assert.ok(observation.recorded_profile, "the observation does not say which profile recorded it");
  assert.match(observation.method, new RegExp(observation.recorded_profile));
});

// --- what the repair must not absorb ----------------------------------------

test("a blocked corpus stops the run before the builder, so nothing builds from a partial corpus", () => {
  const { root, env } = temporaryRepository({ materialise: [] });
  const marker = join(root, "builder-ran");
  const script = [
    "set -euo pipefail",
    `node ${JSON.stringify(TOOL)} --check`,
    `touch ${JSON.stringify(marker)}`
  ].join("\n");
  const result = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(result.status, 6, "the preparation contract must surface the blocked exit code");
  assert.equal(existsSync(marker), false, "the step after the precondition ran anyway");
});

test("a failing builder stays a failing builder: readiness passing does not rescue the exit status", () => {
  const { root, env } = temporaryRepository({});
  const marker = join(root, "after-builder");
  const script = [
    "set -euo pipefail",
    `node ${JSON.stringify(TOOL)} --check`,
    "exit 17", // stands in for the builder failing on its own terms
    `touch ${JSON.stringify(marker)}`
  ].join("\n");
  const result = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(result.status, 17, "a builder failure must not be rewritten as ready, blocked, or zero");
  assert.equal(existsSync(marker), false);
  assert.match(result.stdout, /functional corpus ready/, "readiness reported on inputs and then got out of the way");
});

test("an unrelated functional failure is not turned into a dependency result", () => {
  const { env } = temporaryRepository({});
  const script = [
    "set -euo pipefail",
    `node ${JSON.stringify(TOOL)} --check`,
    "echo 'AssertionError: touch targets below 44px' >&2",
    "exit 1"
  ].join("\n");
  const result = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(result.status, 1, "the functional failure's own exit status must survive");
  assert.match(result.stderr, /touch targets below 44px/, "the functional failure's own message must survive");
  assert.doesNotMatch(result.stderr, /BLOCKED/, "a product failure must not be relabelled as a dependency block");
});

// --- the full-checkout control ----------------------------------------------

test("the full-checkout control reports its own profile and is ready without hydration", () => {
  // No sparse checkout is configured, which is what the full control is.
  const { env } = temporaryRepository({});
  const receipt = JSON.parse(run(["--check", "--json"], env).stdout);
  assert.equal(receipt.profile.active, "full-checkout");
  assert.equal(receipt.profile.sparse_checkout, false);
  assert.equal(receipt.outcome, "ready");
  assert.equal(receipt.remediation, null, "the full control needs no remediation");
});

test("the reduced profile is recognised as itself and reports the same corpus contract", () => {
  const { env } = temporaryRepository({ materialise: ["site/data/one.json", "site/data/two.json"] });
  const receipt = JSON.parse(run(["--check", "--json"], env).stdout);
  assert.equal(receipt.profile.active, "card-work");
  assert.equal(receipt.profile.sparse_checkout, true);
  assert.equal(receipt.outcome, "ready", "a reduced checkout holding its declared corpus is ready");
});
