#!/usr/bin/env node

// The provisioning profile selector.
//
// CI-09 built and measured a reduced working copy. This is the policy that
// decides who gets one. Every provisioning request names a work surface; the
// router turns that request into exactly one of two profiles, records which
// rule fired and why, and reports it as a receipt-shaped decision.
//
// Two properties matter more than the reduction itself:
//
//   It never selects the reduced profile by omission. The rule list is ordered
//   and terminal: an unknown surface or an unclassified gate class is an error,
//   and the last rule is the full-checkout control. A routing gap therefore
//   produces the control, never a smaller checkout.
//
//   The reduced profile is bound to what it was derived from. manifest_digest
//   covers the routing manifest, the profile config, the generated pattern list
//   and closure, the dependency lock and the toolchain pin. A checkout that
//   records one digest and computes another is stale, and stale routes to the
//   control.
//
// Usage:
//   node tools/card_profile_router.mjs --check
//   node tools/card_profile_router.mjs --identity [--json]
//   node tools/card_profile_router.mjs --table
//   node tools/card_profile_router.mjs --decide --surface <id>
//       [--gate <id>]... [--path <tracked-path>]... [--require-complete-history]
//       [--recorded-digest <sha256>] [--require <profile>] [--json]
//
// Exit codes are declared in tools/card-profile/profiles.v1.json.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  committedPatterns as readCommittedPatterns,
  loadClosure,
  materialisedByPatterns
} from "./card_profile_closure.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = resolve(ROOT, "tools/card-profile/profiles.v1.json");
const CONFIG_PATH = resolve(ROOT, "tools/card-profile/profile.config.v1.json");
const OBSERVATION_DIR = resolve(ROOT, "docs/evidence/working-copy-reduction/raw/closure");

const EXIT_OK = 0;
const EXIT_FAIL_CLOSED = 2;
const EXIT_REQUIREMENT_UNMET = 5;

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

export function loadManifest() {
  return readJson(MANIFEST_PATH);
}

// --- profile identity --------------------------------------------------------

// An identity input is hashed as a Git blob from the working tree when the path
// is materialised and from the index otherwise. Both routes agree for identical
// content, so a reduced checkout that defers one of these paths still computes
// the digest the full control computes. A path present in neither is a hard
// failure: an identity computed over a missing input would silently describe a
// different profile.
function resolveInput(input) {
  const absolute = resolve(ROOT, input.path);
  if (existsSync(absolute)) {
    return { ...input, source: "worktree", blob: git(["hash-object", "--", input.path]).trim() };
  }
  const indexed = git(["ls-files", "-s", "--", input.path]).trim();
  if (indexed) {
    return { ...input, source: "index", blob: indexed.split(/\s+/)[1] };
  }
  const error = new Error(`profile identity input is neither materialised nor tracked: ${input.path}`);
  error.failClosed = true;
  throw error;
}

export function computeIdentity(manifest = loadManifest(), revision = git(["rev-parse", "HEAD"]).trim()) {
  const inputs = manifest.identity.manifest_digest_inputs.map((input) =>
    (({ id, path, source, blob }) => ({ id, path, source, blob }))(resolveInput(input))
  );
  const manifestDigest = sha256(
    JSON.stringify({ manifest_version: manifest.manifest_version, inputs: inputs.map(({ id, blob }) => ({ id, blob })) })
  );
  return {
    schema: "cityscroll.card-profile.identity.v1",
    manifest_version: manifest.manifest_version,
    manifest_digest: manifestDigest,
    revision,
    provision_identity: sha256(`${manifestDigest}\n${revision}\n`),
    inputs
  };
}

// --- closure verification ----------------------------------------------------

function committedPatterns() {
  return readCommittedPatterns(ROOT);
}

// Drift, not re-derivation. The deriver records the digest of the config it ran
// against, and the closure names exactly which paths the pattern list has to
// materialise and which it must not; checking both here catches a closure that
// no longer describes its inputs without paying for a full rebuild on every
// routing decision.
//
// The pattern-list half used to be a stored digest. That could not survive the
// storage split: a digest of a file that grows with the repository is rewritten
// by every change, which is the conflict this family exists to stop generating.
// What the router actually needs from the pattern list is not that its bytes are
// the ones some earlier run produced, but that it still means what the closure
// says it means, so that is what is checked — and unlike a digest, this also
// fails a hand-edit that leaves the byte count intact.
export function verifyClosure(closure = loadClosure(ROOT)) {
  const problems = [];
  if (closure.config_sha256 !== sha256(readFileSync(CONFIG_PATH))) {
    problems.push("the closure manifest was generated from a different profile config");
  }
  const patterns = committedPatterns();
  const uncovered = (closure.required_paths ?? []).filter((path) => !materialisedByPatterns(patterns, path));
  if (uncovered.length > 0) {
    problems.push(
      `the committed pattern list does not materialise ${uncovered.length} path(s) the closure requires, ` +
        `starting with ${uncovered.slice(0, 3).join(", ")}`
    );
  }
  const leaked = (closure.deferred_hydration_set?.paths ?? []).filter((path) =>
    materialisedByPatterns(patterns, path)
  );
  if (leaked.length > 0) {
    problems.push(
      `the committed pattern list materialises ${leaked.length} path(s) the closure defers, ` +
        `starting with ${leaked.slice(0, 3).join(", ")}`
    );
  }
  return { ok: problems.length === 0, problems };
}

function observationFor(config, gateId) {
  const gate = config.gate_classes.find((entry) => entry.id === gateId);
  if (!gate) return { ok: false, problem: `gate class is not declared: ${gateId}` };
  const path = resolve(OBSERVATION_DIR, gate.observation);
  if (!existsSync(path)) return { ok: false, problem: `gate class has no observation receipt: ${gateId}` };
  const receipt = readJson(path);
  if (!Array.isArray(receipt.paths) || receipt.paths.length === 0) {
    return { ok: false, problem: `observation receipt for ${gateId} records no paths` };
  }
  return { ok: true, path_count: receipt.paths.length };
}

// --- the decision ------------------------------------------------------------

function fired(manifest, ruleId, extra = {}) {
  const rule = manifest.routing_rules.find((entry) => entry.id === ruleId);
  return { rule: rule.id, rule_order: rule.order, outcome: rule.outcome, rule_reason: rule.reason, ...extra };
}

/**
 * Route one provisioning request. Pure with respect to the request: the same
 * request against the same checkout always yields the same decision object.
 */
export function decide(request) {
  const manifest = request.manifest ?? loadManifest();
  const config = request.config ?? readJson(CONFIG_PATH);
  const closure = request.closure ?? loadClosure(ROOT);
  const gates = request.gates ?? [];
  const paths = request.paths ?? [];

  const base = {
    schema: "cityscroll.card-profile.decision.v1",
    manifest_version: manifest.manifest_version,
    request: {
      surface: request.surface ?? null,
      gate_classes: [...gates].sort(),
      paths: [...paths].sort(),
      requires_complete_history: Boolean(request.requiresCompleteHistory)
    }
  };

  const surface = manifest.surfaces.find((entry) => entry.id === request.surface);
  if (!surface) {
    return {
      ...base,
      ...fired(manifest, "unknown-surface"),
      profile: null,
      reason: `work surface "${request.surface ?? ""}" is not declared in the routing manifest`,
      declared_surfaces: manifest.surfaces.map((entry) => entry.id)
    };
  }
  base.request.surface_title = surface.title;

  const supported = new Set(closure.supported_gate_classes);
  const blocked = new Map(closure.full_checkout_only.map((entry) => [entry.id, entry.reason]));
  for (const gate of [...gates].sort()) {
    if (!supported.has(gate) && !blocked.has(gate)) {
      return {
        ...base,
        ...fired(manifest, "unknown-gate-class"),
        profile: null,
        reason: `gate class "${gate}" is declared neither profile-supported nor full-checkout-only`
      };
    }
  }

  if (surface.full_only) {
    return { ...base, ...fired(manifest, "full-only-surface"), profile: "full", reason: surface.reason };
  }

  if (request.requiresCompleteHistory) {
    return {
      ...base,
      ...fired(manifest, "complete-history-required"),
      profile: "full",
      reason: "the caller declared that this work needs complete commit history"
    };
  }

  for (const gate of [...gates].sort()) {
    if (!supported.has(gate)) {
      return {
        ...base,
        ...fired(manifest, "full-only-gate-class"),
        profile: "full",
        reason: `gate class "${gate}" is full-checkout-only: ${blocked.get(gate)}`,
        fallback_gate_class: gate
      };
    }
  }

  if (paths.length > 0) {
    const patterns = committedPatterns();
    const deferred = new Set(closure.deferred_hydration_set.paths);
    const outside = [...paths].sort().filter((path) => deferred.has(path) || !materialisedByPatterns(patterns, path));
    if (outside.length > 0) {
      return {
        ...base,
        ...fired(manifest, "path-outside-closure"),
        profile: "full",
        reason: `${outside.length} requested path(s) are not materialised by the reduced profile`,
        paths_outside_closure: outside,
        hydrate_command: `tools/provision_card_profile.sh hydrate ${outside.join(" ")}`
      };
    }
  }

  const identity = computeIdentity(manifest);
  if (request.recordedDigest && request.recordedDigest !== identity.manifest_digest) {
    return {
      ...base,
      ...fired(manifest, "stale-profile"),
      profile: "full",
      reason: "the recorded profile manifest digest does not match this revision's inputs",
      recorded_manifest_digest: request.recordedDigest,
      computed_manifest_digest: identity.manifest_digest
    };
  }

  const closureState = verifyClosure(closure);
  const observationProblems = [];
  for (const gate of [...gates].sort()) {
    const observation = observationFor(config, gate);
    if (!observation.ok) observationProblems.push(observation.problem);
  }
  if (!closureState.ok || observationProblems.length > 0) {
    return {
      ...base,
      ...fired(manifest, "closure-unverified"),
      profile: "full",
      reason: "the reduced profile's closure did not verify",
      closure_problems: [...closureState.problems, ...observationProblems]
    };
  }

  return {
    ...base,
    ...fired(manifest, "focused-card-work-verified"),
    profile: "focused-reduced",
    reason: surface.reason,
    identity: { manifest_digest: identity.manifest_digest, provision_identity: identity.provision_identity },
    closure_verified: {
      required_paths: closure.required_paths.length,
      deferred_paths: closure.deferred_hydration_set.paths.length,
      supported_gate_classes: closure.supported_gate_classes.length,
      full_checkout_only_classes: closure.full_checkout_only.length
    }
  };
}

// --- modes -------------------------------------------------------------------

function check() {
  const problems = [];
  const manifest = loadManifest();
  const config = readJson(CONFIG_PATH);
  const closure = loadClosure(ROOT);

  for (const [name, profile] of Object.entries(manifest.profiles)) {
    for (const surfaceId of profile.eligible_surfaces) {
      if (!manifest.surfaces.some((entry) => entry.id === surfaceId)) {
        problems.push(`profile "${name}" declares an undeclared eligible surface: ${surfaceId}`);
      }
    }
  }
  for (const surface of manifest.surfaces) {
    if (!manifest.profiles[surface.profile]) {
      problems.push(`surface "${surface.id}" routes to an undeclared profile: ${surface.profile}`);
    }
    if (!manifest.profiles[surface.profile].eligible_surfaces.includes(surface.id)) {
      problems.push(`surface "${surface.id}" routes to profile "${surface.profile}", which does not list it as eligible`);
    }
    if (!surface.reason || surface.reason.length < 40) {
      problems.push(`surface "${surface.id}" has no substantive reason`);
    }
    if (surface.full_only && surface.profile !== "full") {
      problems.push(`surface "${surface.id}" is full_only but routes to ${surface.profile}`);
    }
  }

  // Only focused card work may reach the reduced profile, and it must be the
  // declared default for it. Both halves of the card's contract are mechanical.
  const reducedEligible = manifest.profiles["focused-reduced"].eligible_surfaces;
  if (reducedEligible.length !== 1 || reducedEligible[0] !== "focused-card-work") {
    problems.push("the reduced profile must be eligible for focused card work and nothing else");
  }
  if (manifest.default_profile.focused_card_work !== "focused-reduced") {
    problems.push("the reduced profile is not declared the default for focused card work");
  }
  if (manifest.default_profile.every_other_surface !== "full") {
    problems.push("the full-checkout control is not declared the default for every other surface");
  }
  for (const required of ["ci", "deployment", "release-surface", "architecture", "repository-governance", "evidence", "complete-history"]) {
    const surface = manifest.surfaces.find((entry) => entry.id === required);
    if (!surface || !surface.full_only) problems.push(`required full-checkout surface is not declared full_only: ${required}`);
  }

  const orders = manifest.routing_rules.map((rule) => rule.order);
  if (orders.join(",") !== orders.map((_, index) => index + 1).join(",")) {
    problems.push("routing rules are not a contiguous ordered list starting at 1");
  }
  const terminal = manifest.routing_rules[manifest.routing_rules.length - 1];
  if (terminal.id !== "default-full" || terminal.outcome !== "full") {
    problems.push("the terminal routing rule must be the full-checkout control");
  }
  for (const rule of manifest.routing_rules) {
    if (!["full", "focused-reduced", "error"].includes(rule.outcome)) {
      problems.push(`routing rule "${rule.id}" has an unknown outcome: ${rule.outcome}`);
    }
  }

  for (const input of manifest.identity.manifest_digest_inputs) {
    try {
      resolveInput(input);
    } catch (error) {
      problems.push(error.message);
    }
  }

  const closureState = verifyClosure(closure);
  problems.push(...closureState.problems);
  for (const gate of closure.supported_gate_classes) {
    const observation = observationFor(config, gate);
    if (!observation.ok) problems.push(observation.problem);
  }

  if (problems.length > 0) {
    console.error("card profile routing check failed:");
    for (const problem of problems) console.error(`  - ${problem}`);
    return EXIT_FAIL_CLOSED;
  }
  const identity = computeIdentity(manifest);
  console.log(
    `card profile routing check passed (${manifest.surfaces.length} surfaces, ` +
      `${manifest.surfaces.filter((entry) => entry.full_only).length} full-checkout-only, ` +
      `${manifest.routing_rules.length} ordered rules, manifest digest ${identity.manifest_digest.slice(0, 12)})`
  );
  return EXIT_OK;
}

// The decision table is generated from the manifest rather than written twice,
// so the documented policy cannot drift from the enforced one.
function table() {
  const manifest = loadManifest();
  const lines = [
    "| Work surface | Provisioned profile | Why |",
    "| --- | --- | --- |",
    ...manifest.surfaces.map(
      (surface) => `| \`${surface.id}\` | \`${surface.profile}\` | ${surface.reason.replace(/\|/g, "\\|")} |`
    ),
    "",
    "| Order | Rule | When | Outcome |",
    "| ---: | --- | --- | --- |",
    ...manifest.routing_rules.map(
      (rule) => `| ${rule.order} | \`${rule.id}\` | ${rule.when.replace(/\|/g, "\\|")} | \`${rule.outcome}\` |`
    )
  ];
  console.log(lines.join("\n"));
  return EXIT_OK;
}

function argValues(argv, flag) {
  const values = [];
  argv.forEach((value, index) => {
    if (value === flag && argv[index + 1] !== undefined) values.push(argv[index + 1]);
  });
  return values;
}

function argValue(argv, flag) {
  const values = argValues(argv, flag);
  return values.length > 0 ? values[values.length - 1] : undefined;
}

function runDecide(argv) {
  let decision;
  try {
    decision = decide({
      surface: argValue(argv, "--surface"),
      gates: argValues(argv, "--gate"),
      paths: argValues(argv, "--path"),
      requiresCompleteHistory: argv.includes("--require-complete-history"),
      recordedDigest: argValue(argv, "--recorded-digest")
    });
  } catch (error) {
    if (!error.failClosed) throw error;
    console.error(`card profile routing failed closed: ${error.message}`);
    return EXIT_FAIL_CLOSED;
  }

  if (argv.includes("--json")) {
    console.log(JSON.stringify(decision, null, 2));
  } else if (decision.profile) {
    console.log(`profile: ${decision.profile}`);
    console.log(`rule: ${decision.rule} (order ${decision.rule_order})`);
    console.log(`reason: ${decision.reason}`);
  }

  if (decision.outcome === "error") {
    console.error(`card profile routing failed closed: ${decision.reason}`);
    return EXIT_FAIL_CLOSED;
  }
  const required = argValue(argv, "--require");
  if (required && required !== decision.profile) {
    console.error(`required profile "${required}" but the router selected "${decision.profile}": ${decision.reason}`);
    return EXIT_REQUIREMENT_UNMET;
  }
  return EXIT_OK;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--identity")) {
    const identity = computeIdentity();
    console.log(argv.includes("--json") ? JSON.stringify(identity, null, 2) : identity.manifest_digest);
    return EXIT_OK;
  }
  if (argv.includes("--table")) return table();
  if (argv.includes("--decide")) return runDecide(argv);
  if (argv.includes("--check") || argv.length === 0) return check();
  console.error("usage: card_profile_router.mjs [--check | --identity [--json] | --table | --decide --surface <id> ...]");
  return EXIT_FAIL_CLOSED;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
