#!/usr/bin/env node

// Emit the provisioning receipt for a card-work checkout.
//
// A profile is only a contract if a caller can prove which one it received. The
// receipt is that proof: profile identity, revision, Git object mode, closure,
// explicitly hydrated paths, integrity checks, byte accounting, provisioning
// timing and any fallback reason, in one file.
//
// It is split into two blocks on purpose.
//
//   deterministic   Everything that is a property of the checkout rather than
//                   of the run: identity, object mode, closure, hydration,
//                   reachable history, cleanliness. Two runs against the same
//                   checkout produce byte-identical content here, and
//                   deterministic_digest covers exactly this block.
//
//   measurement     Everything a second run may legitimately move: pack counts
//                   after lazy fetches, wall-clock timings, charged bytes.
//                   Reported, never folded into the digest.
//
// Nothing host-specific is written. A field carrying an absolute path, a user
// name or a host name is a hard failure rather than a redaction, because a
// receipt that leaks one is not publishable and silently trimming it would hide
// that the generator produced it.
//
// Usage:
//   node tools/card_profile_receipt.mjs [--out <path>]
//       [--decision <decision.json>] [--footprint <footprint.json>]
//       [--timing <timing.json>] [--fallback-reason <text>] [--check <path>]

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { computeIdentity, loadManifest, verifyClosure } from "./card_profile_router.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLOSURE_PATH = resolve(ROOT, "tools/card-profile/closure.v1.json");
const SPARSE_PATH = resolve(ROOT, "tools/card-profile/card-work.sparse");

const git = (args, options = {}) =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });

function gitOptional(args) {
  try {
    return git(args, { stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

const readJson = (path) => JSON.parse(readFileSync(resolve(path), "utf8"));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function skipWorktreePaths() {
  const excluded = new Set();
  for (const line of git(["ls-files", "-t"]).split("\n")) {
    if (line.startsWith("S ")) excluded.add(line.slice(2));
  }
  return excluded;
}

function objectMode() {
  const gitDir = git(["rev-parse", "--absolute-git-dir"]).trim();
  return {
    sparse_checkout: gitOptional(["config", "--get", "core.sparseCheckout"]) === "true",
    shallow_repository: existsSync(resolve(gitDir, "shallow")),
    promisor_remote: gitOptional(["config", "--get", "remote.origin.promisor"]) === "true",
    partial_clone_filter: gitOptional(["config", "--get", "remote.origin.partialclonefilter"]),
    full_history_available: !existsSync(resolve(gitDir, "shallow")),
    full_history_fallback: existsSync(resolve(gitDir, "shallow")) ? "git fetch --unshallow origin" : "already complete"
  };
}

// A hydrated path is one the working tree holds that the committed pattern list
// does not name: someone ran the hydrate command. Recording it is what stops a
// receipt from describing the committed profile when the checkout has quietly
// grown past it.
function hydration(sparseActive) {
  if (!sparseActive) {
    return { applicable: false, note: "the full-checkout control materialises every tracked path", paths: [] };
  }
  const patterns = readFileSync(SPARSE_PATH, "utf8")
    .split("\n")
    .filter((line) => line && !line.startsWith("#"));
  const matches = (path) =>
    patterns.some((pattern) => (pattern.endsWith("/") ? path.startsWith(pattern.slice(1)) : path === pattern.slice(1)));
  const excluded = skipWorktreePaths();
  const paths = git(["ls-files"])
    .split("\n")
    .filter(Boolean)
    .filter((path) => !excluded.has(path) && !matches(path))
    .sort();
  return { applicable: true, note: "tracked paths materialised beyond the committed pattern list", paths };
}

function integrity() {
  const fsck = spawnSync("git", ["fsck", "--connectivity-only"], { cwd: ROOT, encoding: "utf8" });
  return {
    fsck_connectivity_only_exit: fsck.status,
    fsck_method:
      "--connectivity-only verifies the object graph without demanding blobs a partial clone deliberately did not fetch, so it is the meaningful integrity check in both profiles",
    commits_reachable_from_head: Number(git(["rev-list", "--count", "HEAD"]).trim()),
    working_tree_clean: git(["status", "--porcelain"]).trim() === "",
    tracked_paths_not_materialised: skipWorktreePaths().size
  };
}

// Byte accounting is only accepted when the categories partition the total.
// Reporting a footprint whose parts do not sum to its whole would be exactly
// the omission the card forbids.
function byteAccounting(footprint) {
  if (!footprint) return null;
  const categories = Object.fromEntries(
    Object.entries(footprint.categories)
      .map(([name, value]) => [name, { logical_bytes: value.logical_bytes, allocated_bytes: value.allocated_bytes }])
      .sort(([a], [b]) => a.localeCompare(b))
  );
  const summed = Object.values(categories).reduce(
    (accumulator, value) => ({
      logical_bytes: accumulator.logical_bytes + value.logical_bytes,
      allocated_bytes: accumulator.allocated_bytes + value.allocated_bytes
    }),
    { logical_bytes: 0, allocated_bytes: 0 }
  );
  const partitions =
    summed.logical_bytes === footprint.total.logical_bytes &&
    summed.allocated_bytes === footprint.total.allocated_bytes;
  if (!partitions) {
    throw Object.assign(new Error("byte accounting does not partition: category sums do not equal the reported total"), {
      failClosed: true
    });
  }
  return {
    method: "tools/measure_working_copy_footprint.py, CI-08's ordered exhaustive path partition with first rule wins",
    categories_partition_total: true,
    tracked_file_count: footprint.tracked_file_count,
    categories,
    total: { logical_bytes: footprint.total.logical_bytes, allocated_bytes: footprint.total.allocated_bytes },
    hardlink_dedup: footprint.hardlink_dedup,
    shared_dependency_store_note:
      "The shared dependency store is measured separately and is never folded into a checkout total; see docs/evidence/ci-09-working-copy-reduction/raw/footprint-shared-store.json"
  };
}

// Host-neutrality is checked over the serialised receipt rather than field by
// field, so a value nested anywhere cannot slip through.
function assertHostNeutral(serialised) {
  const user = userInfo().username;
  const host = hostname();
  const banned = [
    ["an absolute home path", /\/Users\/|\/home\//],
    ["an absolute temporary path", /\/var\/folders\/|\/private\/tmp|(^|[^\w])\/tmp\//],
    ["the current user name", new RegExp(`\\b${user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`)],
    ["the current host name", new RegExp(`\\b${host.split(".")[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`)]
  ];
  const found = banned.filter(([, pattern]) => pattern.test(serialised)).map(([label]) => label);
  if (found.length > 0) {
    throw Object.assign(new Error(`receipt is not host-neutral: it contains ${found.join(", ")}`), { failClosed: true });
  }
}

export function buildReceipt({ decision = null, footprint = null, timing = null, fallbackReason = null } = {}) {
  const manifest = loadManifest();
  const closure = readJson(CLOSURE_PATH);
  const identity = computeIdentity(manifest);
  const mode = objectMode();
  const profileName = mode.sparse_checkout ? "focused-reduced" : "full";
  const profile = manifest.profiles[profileName];
  const closureState = verifyClosure(closure);

  const deterministic = {
    profile: profileName,
    profile_title: profile.title,
    provisioned_profile_name: profile.provisioned_profile_name,
    manifest_version: identity.manifest_version,
    manifest_digest: identity.manifest_digest,
    provision_identity: identity.provision_identity,
    revision: identity.revision,
    identity_inputs: identity.inputs,
    object_mode: mode,
    closure: {
      verified: closureState.ok,
      problems: closureState.problems,
      config_sha256: closure.config_sha256,
      patterns_sha256: closure.patterns_sha256,
      required_paths: closure.required_paths.length,
      deferred_paths: closure.deferred_hydration_set.paths.length,
      site_data_paths_in_profile: closure.site_data.profile_paths.length,
      supported_gate_classes: closure.supported_gate_classes,
      full_checkout_only_gate_classes: closure.full_checkout_only.map((entry) => entry.id)
    },
    hydration: hydration(mode.sparse_checkout),
    integrity: integrity(),
    routing_decision: decision
      ? {
          rule: decision.rule,
          rule_order: decision.rule_order,
          surface: decision.request.surface,
          gate_classes: decision.request.gate_classes,
          profile: decision.profile,
          reason: decision.reason
        }
      : null,
    fallback_reason: fallbackReason,
    byte_accounting: byteAccounting(footprint)
  };

  const receipt = {
    schema: "cityscroll.card-profile.provision-receipt.v1",
    note:
      "deterministic_digest covers the deterministic block only. The measurement block holds figures a second run may legitimately move and is excluded by design.",
    deterministic,
    deterministic_digest: sha256(JSON.stringify(deterministic)),
    measurement: {
      note: "Reported, not part of the digest.",
      provisioning_timing: timing,
      packs: Number((gitOptional(["count-objects", "-v"]) ?? "").match(/^packs: (\d+)$/m)?.[1] ?? -1),
      pack_size_kib: Number((gitOptional(["count-objects", "-v"]) ?? "").match(/^size-pack: (\d+)$/m)?.[1] ?? -1),
      loose_objects: Number((gitOptional(["count-objects", "-v"]) ?? "").match(/^count: (\d+)$/m)?.[1] ?? -1)
    }
  };

  const serialised = `${JSON.stringify(receipt, null, 2)}\n`;
  assertHostNeutral(serialised);
  return { receipt, serialised };
}

function argValue(argv, flag) {
  const index = argv.lastIndexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function main() {
  const argv = process.argv.slice(2);
  const compareTo = argValue(argv, "--check");
  let built;
  try {
    built = buildReceipt({
      decision: argValue(argv, "--decision") ? readJson(argValue(argv, "--decision")) : null,
      footprint: argValue(argv, "--footprint") ? readJson(argValue(argv, "--footprint")) : null,
      timing: argValue(argv, "--timing") ? readJson(argValue(argv, "--timing")) : null,
      fallbackReason: argValue(argv, "--fallback-reason") ?? null
    });
  } catch (error) {
    if (!error.failClosed) throw error;
    console.error(`card profile receipt failed closed: ${error.message}`);
    return 2;
  }

  if (compareTo) {
    const committed = readJson(compareTo);
    if (committed.deterministic_digest !== built.receipt.deterministic_digest) {
      console.error("card profile receipt check failed: the deterministic block no longer reproduces.");
      console.error(`  committed: ${committed.deterministic_digest}`);
      console.error(`  computed:  ${built.receipt.deterministic_digest}`);
      return 1;
    }
    console.log(`card profile receipt reproduces (${built.receipt.deterministic_digest.slice(0, 12)})`);
    return 0;
  }

  const out = argValue(argv, "--out");
  if (out) {
    writeFileSync(resolve(out), built.serialised);
    console.log(`wrote ${built.receipt.deterministic.profile} receipt (${built.receipt.deterministic_digest.slice(0, 12)})`);
  } else {
    process.stdout.write(built.serialised);
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
