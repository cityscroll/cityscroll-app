#!/usr/bin/env node

// Contract runner and fail-closed gate front door for the card-work profile.
//
// Modes
//   --status                       Report the active profile as JSON.
//   --check                        Verify the generated profile outputs are
//                                  current, the manifest is self-consistent,
//                                  and — inside a reduced profile — that every
//                                  declared path is materialised.
//   --gate <id> [-- command...]    Refuse to run a gate the active profile does
//                                  not support, then run it under the sentinel
//                                  and fail if the sentinel recorded a
//                                  missing-path violation, whatever the gate's
//                                  own exit status was.
//   --record <id> -- command...    Run a gate with the read recorder and write
//                                  its observation receipt.
//
// The --gate mode is the part that makes a reduced checkout safe to trust. A
// gate can pass while silently skipping work whose input was not materialised;
// checking the sentinel's violation log independently of the gate's exit status
// is what stops that from reading as a pass.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { loadClosure } from "./card_profile_closure.mjs";
import { decide } from "./card_profile_router.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = resolve(ROOT, "tools/card-profile/profile.config.v1.json");
const SENTINEL = resolve(ROOT, "tools/card_profile_sentinel.cjs");
const OBSERVATION_DIR = resolve(ROOT, "docs/evidence/working-copy-reduction/raw/closure");

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options
  });
}

// Receipts list tracked paths verbatim. Every public cross-boundary identity is
// spelled plainly, so no path in a receipt needs an escape to be written down.
function renderReceipt(value) {
  return JSON.stringify(value, null, 2);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sparseEnabled() {
  try {
    return git(["config", "--get", "core.sparseCheckout"], { stdio: ["ignore", "pipe", "ignore"] }).trim() === "true";
  } catch {
    return false;
  }
}

function skipWorktreePaths() {
  const excluded = new Set();
  for (const line of git(["ls-files", "-t"]).split("\n")) {
    if (line.startsWith("S ")) excluded.add(line.slice(2));
  }
  return excluded;
}

function status() {
  const shallow = existsSync(resolve(git(["rev-parse", "--git-dir"]).trim().startsWith("/")
    ? git(["rev-parse", "--git-dir"]).trim()
    : resolve(ROOT, git(["rev-parse", "--git-dir"]).trim()), "shallow"));
  let promisor = false;
  try {
    promisor = git(["config", "--get", "remote.origin.promisor"], { stdio: ["ignore", "pipe", "ignore"] }).trim() === "true";
  } catch {
    promisor = false;
  }
  const sparse = sparseEnabled();
  const excluded = sparse ? skipWorktreePaths() : new Set();
  return {
    schema: "cityscroll.card-profile.status.v1",
    profile: sparse ? "card-work" : "full-checkout",
    sparse_checkout: sparse,
    shallow_repository: shallow,
    partial_clone_promisor_remote: promisor,
    tracked_paths_not_materialised: excluded.size,
    full_history_available: !shallow,
    full_history_fallback: shallow ? "git fetch --unshallow origin" : "already complete",
    hydrate_command: "tools/provision_card_profile.sh hydrate <path>",
    full_checkout_command: "tools/provision_card_profile.sh hydrate --full"
  };
}

function derivationCurrent() {
  const result = spawnSync(process.execPath, [resolve(ROOT, "tools/derive_card_profile.mjs"), "--check"], {
    cwd: ROOT,
    encoding: "utf8"
  });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

function check() {
  const problems = [];
  const config = readJson(CONFIG_PATH);
  const closure = loadClosure(ROOT);
  const state = status();

  const derived = derivationCurrent();
  if (!derived.ok) problems.push(`the committed profile does not satisfy its contract:\n${derived.output}`);

  const supported = new Set(closure.supported_gate_classes);
  for (const gate of config.gate_classes) {
    if (gate.profile_supported && !supported.has(gate.id)) {
      problems.push(`gate class declared supported but absent from the closure manifest: ${gate.id}`);
    }
    const observation = resolve(OBSERVATION_DIR, gate.observation);
    if (!existsSync(observation)) {
      problems.push(`gate class has no recorded observation receipt: ${gate.id} (${gate.observation})`);
      continue;
    }
    const receipt = readJson(observation);
    if (receipt.gate_class !== gate.id) {
      problems.push(`observation receipt names a different gate class: ${gate.observation}`);
    }
    if (!Array.isArray(receipt.paths) || receipt.paths.length === 0) {
      problems.push(`observation receipt records no paths: ${gate.observation}`);
    }
  }

  if (closure.full_checkout_only.length === 0) {
    problems.push("the manifest names no full-checkout-only gate class, which cannot be right for this repository");
  }

  if (state.sparse_checkout) {
    const excluded = skipWorktreePaths();
    const missing = [];
    for (const path of closure.site_data.profile_paths) {
      if (excluded.has(path) || !existsSync(resolve(ROOT, path))) missing.push(path);
    }
    if (missing.length > 0) {
      problems.push(`reduced profile is missing declared site/data closure paths: ${missing.slice(0, 5).join(", ")}`);
    }
  }

  if (problems.length > 0) {
    console.error("card profile check failed:");
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }
  console.log(
    `card profile check passed (${closure.required_paths.length} required paths, ` +
      `${closure.deferred_hydration_set.paths.length} deferred paths, ` +
      `${closure.supported_gate_classes.length} supported gate classes, ` +
      `${closure.full_checkout_only.length} full-checkout-only classes)`
  );
  return 0;
}

function splitCommand(argv, flag) {
  const index = argv.indexOf(flag);
  const id = argv[index + 1];
  const separator = argv.indexOf("--", index + 1);
  const command = separator >= 0 ? argv.slice(separator + 1) : [];
  return { id, command };
}

function withSentinel(env, extra) {
  const nodeOptions = [env.NODE_OPTIONS ?? "", `--require ${SENTINEL}`].filter(Boolean).join(" ");
  return { ...env, ...extra, NODE_OPTIONS: nodeOptions };
}

function runGate(argv) {
  const { id, command } = splitCommand(argv, "--gate");
  const state = status();
  // A test seam that can only make the front door stricter: it forces the
  // reduced-profile refusal path on a full checkout so the contract can be
  // exercised without provisioning one.
  const reduced = state.sparse_checkout || process.env.CITYSCROLL_CARD_PROFILE_ASSUME_REDUCED === "1";

  // One router, not two. The front door asks tools/card_profile_router.mjs the
  // same question the provisioner asks it, so a gate class can never be
  // runnable here and unroutable there.
  const decision = decide({ surface: "focused-card-work", gates: [id] });
  if (decision.outcome === "error") {
    console.error(`${decision.reason} (rule ${decision.rule})`);
    return 2;
  }
  if (reduced && decision.profile !== "focused-reduced") {
    console.error(`gate class "${id}" requires the full-checkout control.`);
    console.error(`  reason: ${decision.reason}`);
    console.error(`  routing rule: ${decision.rule} (order ${decision.rule_order})`);
    console.error("  provision it with: tools/provision_card_profile.sh provision --profile full --dest <dir>");
    console.error("  or hydrate this checkout with: tools/provision_card_profile.sh hydrate --full");
    return 3;
  }
  if (command.length === 0) {
    console.log(`gate class "${id}" is runnable in the active ${state.profile} profile`);
    return 0;
  }

  const log = resolve(tmpdir(), `cityscroll-card-profile-violations-${process.pid}.jsonl`);
  rmSync(log, { force: true });
  writeFileSync(log, "");
  const result = spawnSync(command[0], command.slice(1), {
    cwd: ROOT,
    stdio: "inherit",
    env: withSentinel(process.env, { CITYSCROLL_CARD_PROFILE_VIOLATION_LOG: log })
  });
  const violations = readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  rmSync(log, { force: true });

  if (violations.length > 0) {
    const unique = [...new Set(violations.map((entry) => entry.path))].sort();
    console.error(`\ncard profile violation: gate "${id}" read ${unique.length} tracked path(s) the profile does not hold.`);
    for (const path of unique) console.error(`  ${path}`);
    console.error("  Hydrate them and re-run, or record them into the profile closure:");
    console.error(`    tools/provision_card_profile.sh hydrate ${unique.join(" ")}`);
    return 4;
  }
  return result.status ?? 1;
}

function recordGate(argv) {
  const { id, command } = splitCommand(argv, "--record");
  const config = readJson(CONFIG_PATH);
  const gate = config.gate_classes.find((entry) => entry.id === id);
  if (!gate) {
    console.error(`unknown gate class: ${id}`);
    return 2;
  }
  if (command.length === 0) {
    console.error("--record requires a command after --");
    return 2;
  }
  const log = resolve(tmpdir(), `cityscroll-card-profile-reads-${process.pid}.jsonl`);
  rmSync(log, { force: true });
  writeFileSync(log, "");
  const result = spawnSync(command[0], command.slice(1), {
    cwd: ROOT,
    stdio: "inherit",
    env: withSentinel(process.env, {
      CITYSCROLL_CARD_PROFILE_RECORD: "1",
      CITYSCROLL_CARD_PROFILE_READ_LOG: log
    })
  });
  const tracked = new Set(git(["ls-files"]).split("\n").filter(Boolean));
  const paths = [
    ...new Set(
      readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line).path)
        .filter((path) => tracked.has(path))
    )
  ].sort();
  rmSync(log, { force: true });

  mkdirSync(OBSERVATION_DIR, { recursive: true });
  // The recording profile is reported, not assumed. A receipt that claims a full
  // checkout it was not taken on would make the closure it feeds look better
  // evidenced than it is, which is the one thing an observation receipt exists
  // to prevent.
  const recordedIn = status();
  const receipt = {
    schema: "cityscroll.card-profile.observation.v1",
    gate_class: id,
    title: gate.title,
    command: gate.command,
    revision: git(["rev-parse", "HEAD"]).trim(),
    exit_status: result.status ?? 1,
    recorded_profile: recordedIn.profile,
    method:
      `Recorded by tools/card_profile_sentinel.cjs on a ${recordedIn.profile} checkout. Every repository-relative path the process read through fs or loaded as a module, filtered to tracked paths and de-duplicated.` +
      (recordedIn.sparse_checkout
        ? " Taken in a reduced checkout, so it is complete only for a command that ran to completion there: the gate exit status below is what makes that claim checkable."
        : ""),
    path_count: paths.length,
    paths
  };
  const target = resolve(OBSERVATION_DIR, gate.observation);
  writeFileSync(target, `${renderReceipt(receipt)}\n`);
  console.log(`recorded ${paths.length} tracked paths for gate class "${id}" (gate exit ${receipt.exit_status})`);
  return result.status === 0 ? 0 : 1;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--status")) {
    console.log(JSON.stringify(status(), null, 2));
    return 0;
  }
  if (argv.includes("--record")) return recordGate(argv);
  if (argv.includes("--gate")) return runGate(argv);
  if (argv.includes("--check") || argv.length === 0) return check();
  console.error("usage: verify_card_profile.mjs [--status | --check | --gate <id> [-- cmd...] | --record <id> -- cmd...]");
  return 2;
}

process.exit(main());
