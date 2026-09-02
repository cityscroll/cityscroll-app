#!/usr/bin/env node

// Functional readiness precondition for the reduced card-work profile.
//
// tools/prepare_functional_site.sh materialises the static-first document routes
// the functional browser family is served from. The builder it runs first reads
// tracked read models, and the reduced profile used to defer some of them. The
// failure that produced was not a readable one: the builder died on a bare
// ENOENT naming one file, and the copy step that follows it cannot fail at all —
// it copies whatever the working tree happens to hold — so a checkout missing a
// read model served a smaller site and the browser check timed out waiting for a
// row that was never going to render. A provisioning gap presented as an empty
// Browse result.
//
// This tool is the precondition that makes that impossible. It asserts the
// declared functional corpus is materialised before the preparation step runs,
// and when it is not it says which paths are missing, which builder wants them,
// what to run, and — the part that matters — that no functional coverage was
// obtained. It never converts a real functional failure into a skip, because it
// runs before the functional command and reports only on inputs.
//
// Usage:
//   node tools/verify_functional_corpus.mjs --check
//   node tools/verify_functional_corpus.mjs --check --receipt-out <path>
//   node tools/verify_functional_corpus.mjs --receipt-out <path> --json
//
// Exit codes:
//   0  ready    every declared corpus path is materialised
//   6  blocked  the active profile does not hold the corpus; nothing was run
//   2  the request itself failed: a malformed or unusable closure manifest

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// A test seam, and only that. The blocked, stale and malformed-manifest paths
// have to be exercised against a checkout that really is missing its corpus,
// and mutating the developer's own working tree to produce one is how a test
// leaves someone with a half-hydrated repository. Pointing the check at a
// purpose-built temporary repository is the honest alternative. It cannot be
// used to make a real run pass by accident: nothing in the preparation script
// or the gate front door sets it, and any receipt produced under it says so.
const ROOT_OVERRIDE = process.env.CITYSCROLL_FUNCTIONAL_CORPUS_ROOT ?? null;
const ROOT = ROOT_OVERRIDE ? resolve(ROOT_OVERRIDE) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLOSURE_PATH = resolve(ROOT, "tools/card-profile/closure.v1.json");

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    ...options
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function activeProfile() {
  let sparse = false;
  try {
    sparse = git(["config", "--get", "core.sparseCheckout"], { stdio: ["ignore", "pipe", "ignore"] }).trim() === "true";
  } catch {
    sparse = false;
  }
  return { profile: sparse ? "card-work" : "full-checkout", sparse_checkout: sparse };
}

// Skip-worktree is how the reduced profile records "the index carries this, the
// working tree does not". A path can also simply be absent, so both are checked:
// an absent declared input is a blocked corpus whichever way it went missing.
function skipWorktreePaths() {
  const excluded = new Set();
  try {
    for (const line of git(["ls-files", "-t"]).split("\n")) {
      if (line.startsWith("S ")) excluded.add(line.slice(2));
    }
  } catch {
    /* a repository without sparse checkout excludes nothing */
  }
  return excluded;
}

// Index blob identity per corpus path. This is what makes the receipt
// reproducible: it is the same value in a reduced and a full checkout, and it
// changes when the corpus content changes, so a stale corpus is visible rather
// than inferred from a timestamp.
function corpusBlobs(paths) {
  const wanted = new Set(paths);
  const blobs = new Map();
  const listing = git(["ls-files", "-s", "-z"]);
  for (const record of listing.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const path = record.slice(tab + 1);
    if (!wanted.has(path)) continue;
    const [, oid] = record.slice(0, tab).split(" ");
    blobs.set(path, oid);
  }
  return blobs;
}

function blobSizes(oids) {
  const unique = [...new Set(oids)].filter(Boolean);
  const sizes = new Map();
  if (unique.length === 0) return sizes;
  const report = git(["cat-file", "--batch-check=%(objectname) %(objectsize)"], {
    input: `${unique.join("\n")}\n`
  });
  for (const line of report.split("\n")) {
    const [oid, size] = line.split(" ");
    if (oid && size && /^\d+$/.test(size)) sizes.set(oid, Number(size));
  }
  return sizes;
}

// The anchor is declared in the closure, not chosen here, so the day this
// receipt reports and the day the functional harness pins its browser clock to
// are the same fact read from the same file.
function sourceVintage(anchor, missing) {
  if (!anchor?.path) return { path: null, day: null, reason: "the closure declares no vintage anchor" };
  if (missing.has(anchor.path) || !existsSync(resolve(ROOT, anchor.path))) {
    return { path: anchor.path, day: null, reason: "the vintage anchor is not materialised in this checkout" };
  }
  try {
    const payload = JSON.parse(readFileSync(resolve(ROOT, anchor.path), "utf8"));
    for (const key of anchor.keys ?? []) {
      const value = String(payload[key] ?? "").slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { path: anchor.path, day: value, key };
    }
    return { path: anchor.path, day: null, reason: "the vintage anchor declares no dated field" };
  } catch (error) {
    return { path: anchor.path, day: null, reason: `the vintage anchor could not be read: ${error.message}` };
  }
}

function revision() {
  try {
    return git(["rev-parse", "HEAD"]).trim();
  } catch {
    return null;
  }
}

function evaluate() {
  if (!existsSync(CLOSURE_PATH)) {
    return { fatal: `the closure manifest is missing: ${CLOSURE_PATH}` };
  }
  let closure;
  try {
    closure = JSON.parse(readFileSync(CLOSURE_PATH, "utf8"));
  } catch (error) {
    return { fatal: `the closure manifest could not be read: ${error.message}` };
  }
  const corpus = closure.functional_corpus;
  if (!corpus || !Array.isArray(corpus.paths)) {
    return { fatal: "the closure manifest declares no functional corpus; regenerate with: node tools/derive_card_profile.mjs" };
  }
  // An empty declaration is a broken declaration, not a satisfied one. Reading
  // it as "nothing required, therefore ready" is exactly the false green this
  // gate exists to refuse.
  if (corpus.paths.length === 0) {
    return { fatal: "the declared functional corpus is empty, which cannot be right; regenerate with: node tools/derive_card_profile.mjs" };
  }

  const state = activeProfile();
  const excluded = skipWorktreePaths();
  const missing = new Set();
  for (const path of corpus.paths) {
    if (excluded.has(path) || !existsSync(resolve(ROOT, path))) missing.add(path);
  }

  const blobs = corpusBlobs(corpus.paths);
  const sizes = blobSizes([...blobs.values()]);
  const fingerprint = sha256(
    corpus.paths
      .map((path) => `${path} ${blobs.get(path) ?? "absent"}`)
      .join("\n")
  );
  const logicalBytes = corpus.paths.reduce((total, path) => total + (sizes.get(blobs.get(path)) ?? 0), 0);
  const presentBytes = corpus.paths
    .filter((path) => !missing.has(path))
    .reduce((total, path) => total + (sizes.get(blobs.get(path)) ?? 0), 0);

  // A path present in the working tree whose content is not the indexed blob is
  // a stale corpus: the builder would run, and it would build from something
  // other than the declared revision's data. One diff-files call answers this
  // for the whole corpus; hashing each file would read the corpus twice over.
  const stale = [];
  try {
    const changed = new Set(git(["diff-files", "--name-only", "-z", "--", ...corpus.paths]).split("\0").filter(Boolean));
    for (const path of corpus.paths) {
      if (missing.has(path) || !changed.has(path)) continue;
      stale.push({ path, indexed: blobs.get(path) ?? null });
    }
  } catch {
    /* a repository that cannot diff reports no staleness; missing paths still block */
  }

  return { closure, corpus, state, missing: [...missing].sort(), stale, fingerprint, logicalBytes, presentBytes, sizes, blobs };
}

function buildReceipt(result, elapsedMs) {
  const { corpus, state, missing, stale, fingerprint, logicalBytes, presentBytes } = result;
  const blocked = missing.length > 0 || stale.length > 0;
  const reasons = [];
  if (missing.length > 0) {
    reasons.push({
      kind: "missing-corpus",
      detail: `${missing.length} declared functional corpus path(s) are not materialised in the active ${state.profile} profile.`,
      paths: missing
    });
  }
  if (stale.length > 0) {
    reasons.push({
      kind: "stale-corpus",
      detail: `${stale.length} declared functional corpus path(s) differ from the blob the index records for this revision.`,
      paths: stale.map((entry) => entry.path)
    });
  }

  return {
    schema: "cityscroll.functional-corpus-readiness.v1",
    outcome: blocked ? "blocked" : "ready",
    // Stated separately from the outcome and in plain words, because the whole
    // point of this receipt is that a reader cannot mistake "we did not run it"
    // for "it passed".
    functional_coverage: blocked ? "none" : "the functional suite may run",
    coverage_statement: blocked
      ? "No functional test was run and no functional coverage was obtained. This is a provisioning result, not a product result: nothing here says anything about whether the application behaves correctly."
      : "The declared corpus is present at the recorded revision. Whatever the functional suite reports next is a product result and is not qualified by this receipt.",
    profile: {
      active: state.profile,
      sparse_checkout: state.sparse_checkout,
      // Named after the closure fields they are copied from. "manifest_digest"
      // is deliberately not reused here: it means something else in
      // cityscroll.card-profile.identity.v1, and one name for two digests is
      // how a reader ends up comparing values that were never comparable.
      closure_config_sha256: result.closure.config_sha256 ?? null,
      closure_patterns_sha256: result.closure.patterns_sha256 ?? null,
      // Present and true only under the test seam. A receipt that carries it is
      // describing a synthetic repository and is not evidence about this one.
      synthetic_root: ROOT_OVERRIDE ? true : false
    },
    revision: revision(),
    corpus: {
      gate_class: corpus.gate_class,
      builder: corpus.builder,
      builder_role: corpus.builder_role,
      declared_path_count: corpus.paths.length,
      materialised_path_count: corpus.paths.length - missing.length,
      fingerprint,
      logical_bytes: logicalBytes,
      materialised_logical_bytes: presentBytes,
      paths: corpus.paths
    },
    source_vintage: sourceVintage(corpus.vintage_anchor, new Set(missing)),
    measured_functional_tests: corpus.measured_functional_tests ?? [],
    coverage_note: corpus.coverage_note ?? null,
    blocked_reasons: reasons,
    remediation: blocked
      ? {
          hydrate: `tools/provision_card_profile.sh hydrate ${[...missing, ...stale.map((entry) => entry.path)].join(" ")}`,
          regenerate: "node tools/derive_card_profile.mjs",
          full_control: "tools/provision_card_profile.sh hydrate --full"
        }
      : null,
    check_duration_ms: elapsedMs
  };
}

function main() {
  const argv = process.argv.slice(2);
  const started = process.hrtime.bigint();
  const result = evaluate();
  if (result.fatal) {
    console.error(`functional corpus check failed: ${result.fatal}`);
    return 2;
  }
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  const receipt = buildReceipt(result, Math.round(elapsed));

  const receiptFlag = argv.indexOf("--receipt-out");
  if (receiptFlag >= 0) {
    const target = resolve(process.cwd(), argv[receiptFlag + 1]);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(receipt, null, 2)}\n`);
  }
  if (argv.includes("--json")) {
    console.log(JSON.stringify(receipt, null, 2));
  } else if (receipt.outcome === "ready") {
    console.log(
      `functional corpus ready: ${receipt.corpus.declared_path_count} declared path(s), ` +
        `${(receipt.corpus.logical_bytes / 1048576).toFixed(2)} MiB, fingerprint ${receipt.corpus.fingerprint.slice(0, 12)}, ` +
        `vintage ${receipt.source_vintage.day ?? "unknown"} (${receipt.profile.active} profile)`
    );
  } else {
    console.error("functional corpus BLOCKED - the functional suite was not run and no coverage was obtained.");
    for (const reason of receipt.blocked_reasons) {
      console.error(`  ${reason.kind}: ${reason.detail}`);
      for (const path of reason.paths.slice(0, 10)) console.error(`    ${path}`);
      if (reason.paths.length > 10) console.error(`    ... and ${reason.paths.length - 10} more`);
    }
    console.error(`  builder that needs them: ${receipt.corpus.builder}`);
    console.error(`  remediation: ${receipt.remediation.hydrate}`);
    console.error(`  or take the full-checkout control: ${receipt.remediation.full_control}`);
  }
  return receipt.outcome === "ready" ? 0 : 6;
}

process.exit(main());
