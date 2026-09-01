// The routing contract for CI-10: which working-copy profile a unit of work is
// provisioned with, and what has to be true before the reduced one is handed
// out. The properties under test are the ones that make a smaller checkout safe
// to make the default — that it is never selected by omission, that it is bound
// to the inputs it was derived from, and that everything it cannot serve takes
// the full-checkout control explicitly rather than quietly.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildReceipt } from "../tools/card_profile_receipt.mjs";
import { computeIdentity, decide, loadManifest } from "../tools/card_profile_router.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = loadManifest();
const closure = JSON.parse(readFileSync(resolve(ROOT, "tools/card-profile/closure.v1.json"), "utf8"));

const run = (args, env = {}) =>
  spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", env: { ...process.env, ...env } });

test("the routing manifest is self-consistent", () => {
  const result = run(["tools/card_profile_router.mjs", "--check"]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test("focused card work is routed to the reduced profile by default", () => {
  const decision = decide({ surface: "focused-card-work" });
  assert.equal(decision.profile, "focused-reduced");
  assert.equal(decision.rule, "focused-card-work-verified");
  assert.equal(manifest.default_profile.focused_card_work, "focused-reduced");
  assert.ok(decision.identity.manifest_digest);
  assert.ok(decision.closure_verified.required_paths > 0);
});

test("every other declared surface selects the full control, with a recorded reason", () => {
  const required = [
    "ci",
    "unit",
    "accessibility",
    "artifact",
    "deployment",
    "release-surface",
    "architecture",
    "repository-control-plane",
    "evidence",
    "complete-history"
  ];
  for (const surface of required) {
    assert.ok(
      manifest.surfaces.some((entry) => entry.id === surface),
      `the manifest does not declare the surface: ${surface}`
    );
    const decision = decide({ surface });
    assert.equal(decision.profile, "full", `${surface} was not routed to the full control`);
    assert.equal(decision.rule, "full-only-surface");
    assert.ok(decision.reason.length > 40, `${surface} was routed to the control without a substantive reason`);
  }
  // The set is closed: nothing outside focused card work may reach the reduced
  // profile, whatever else the manifest grows.
  for (const surface of manifest.surfaces) {
    if (surface.id === "focused-card-work") continue;
    assert.equal(decide({ surface: surface.id }).profile, "full");
  }
});

test("an unclassified request fails closed rather than defaulting to the reduced profile", () => {
  const surface = decide({ surface: "a-surface-nobody-declared" });
  assert.equal(surface.outcome, "error");
  assert.equal(surface.profile, null);

  const gate = decide({ surface: "focused-card-work", gates: ["a-gate-class-nobody-declared"] });
  assert.equal(gate.outcome, "error");
  assert.equal(gate.profile, null);

  for (const args of [
    ["--decide", "--surface", "a-surface-nobody-declared"],
    ["--decide", "--surface", "focused-card-work", "--gate", "a-gate-class-nobody-declared"]
  ]) {
    assert.equal(run(["tools/card_profile_router.mjs", ...args]).status, 2);
  }
});

test("a full-checkout-only gate class takes the explicit full fallback, carrying its reason", () => {
  for (const entry of closure.full_checkout_only) {
    const decision = decide({ surface: "focused-card-work", gates: [entry.id] });
    assert.equal(decision.profile, "full", `${entry.id} did not fall back to the control`);
    assert.equal(decision.rule, "full-only-gate-class");
    assert.equal(decision.fallback_gate_class, entry.id);
    assert.ok(decision.reason.includes(entry.reason), `${entry.id} fell back without its recorded reason`);
  }
});

test("a supported gate class keeps focused card work on the reduced profile", () => {
  for (const gate of closure.supported_gate_classes) {
    assert.equal(decide({ surface: "focused-card-work", gates: [gate] }).profile, "focused-reduced");
  }
});

test("work naming a path the profile defers takes the control, not a missing input", () => {
  const deferred = closure.deferred_hydration_set.paths[0];
  const decision = decide({ surface: "focused-card-work", paths: [deferred] });
  assert.equal(decision.profile, "full");
  assert.equal(decision.rule, "path-outside-closure");
  assert.deepEqual(decision.paths_outside_closure, [deferred]);
  assert.match(decision.hydrate_command, /provision_card_profile\.sh hydrate /);

  // A path the profile does hold is not a reason to leave the reduced profile.
  assert.equal(
    decide({ surface: "focused-card-work", paths: [closure.site_data.profile_paths[0]] }).profile,
    "focused-reduced"
  );
});

test("declared need for complete history is recorded and routed to the control", () => {
  const decision = decide({ surface: "focused-card-work", requiresCompleteHistory: true });
  assert.equal(decision.profile, "full");
  assert.equal(decision.rule, "complete-history-required");
});

test("a profile that has drifted from its revision's inputs is stale, and stale takes the control", () => {
  const decision = decide({ surface: "focused-card-work", recordedDigest: "0".repeat(64) });
  assert.equal(decision.profile, "full");
  assert.equal(decision.rule, "stale-profile");
  assert.equal(decision.recorded_manifest_digest, "0".repeat(64));
  assert.notEqual(decision.computed_manifest_digest, decision.recorded_manifest_digest);

  // The digest a checkout actually carries is not stale against itself.
  const identity = computeIdentity();
  assert.equal(
    decide({ surface: "focused-card-work", recordedDigest: identity.manifest_digest }).profile,
    "focused-reduced"
  );
});

test("an unverified closure takes the control rather than being trusted", () => {
  const drifted = { ...closure, patterns_sha256: "0".repeat(64) };
  const decision = decide({ surface: "focused-card-work", closure: drifted });
  assert.equal(decision.profile, "full");
  assert.equal(decision.rule, "closure-unverified");
  assert.ok(decision.closure_problems.length > 0);
});

test("the rule list is ordered and terminates in the control, so a routing gap cannot reduce", () => {
  const rules = manifest.routing_rules;
  assert.deepEqual(rules.map((rule) => rule.order), rules.map((_, index) => index + 1));
  assert.equal(rules.at(-1).id, "default-full");
  assert.equal(rules.at(-1).outcome, "full");
  assert.equal(rules.filter((rule) => rule.outcome === "focused-reduced").length, 1);
  assert.deepEqual(manifest.profiles["focused-reduced"].eligible_surfaces, ["focused-card-work"]);
});

test("profile identity binds the revision, the closure, the lockfile and the toolchain pin", () => {
  const inputs = manifest.identity.manifest_digest_inputs.map((input) => input.path);
  for (const required of [
    "tools/card-profile/profiles.v1.json",
    "tools/card-profile/profile.config.v1.json",
    "tools/card-profile/card-work.sparse",
    "tools/card-profile/closure.v1.json",
    "worker/pnpm-lock.yaml",
    "worker/package.json"
  ]) {
    assert.ok(inputs.includes(required), `profile identity does not bind ${required}`);
  }

  const identity = computeIdentity();
  assert.equal(identity.manifest_digest, computeIdentity().manifest_digest);
  assert.match(identity.provision_identity, /^[0-9a-f]{64}$/);
  assert.equal(identity.revision.length, 40);

  // Dropping an input changes the digest, which is what makes it a binding.
  const narrowed = {
    ...manifest,
    identity: { ...manifest.identity, manifest_digest_inputs: manifest.identity.manifest_digest_inputs.slice(0, 2) }
  };
  assert.notEqual(computeIdentity(narrowed).manifest_digest, identity.manifest_digest);
  // The revision moves provision identity without moving the manifest digest,
  // so an unrelated commit does not make every checkout stale.
  const other = computeIdentity(manifest, "f".repeat(40));
  assert.equal(other.manifest_digest, identity.manifest_digest);
  assert.notEqual(other.provision_identity, identity.provision_identity);
});

test("the same request always produces the same decision", () => {
  const request = { surface: "focused-card-work", gates: ["worker-unit", "card-reconciliation"], paths: [] };
  assert.equal(JSON.stringify(decide(request)), JSON.stringify(decide(request)));
  // Argument order is not part of the request.
  assert.equal(
    JSON.stringify(decide({ ...request, gates: ["card-reconciliation", "worker-unit"] })),
    JSON.stringify(decide(request))
  );
});

test("the provisioning receipt reproduces deterministically and reports every declared field", () => {
  const first = buildReceipt();
  const second = buildReceipt();
  assert.equal(first.receipt.deterministic_digest, second.receipt.deterministic_digest);
  assert.equal(JSON.stringify(first.receipt.deterministic), JSON.stringify(second.receipt.deterministic));

  const block = first.receipt.deterministic;
  for (const field of [
    "profile",
    "manifest_digest",
    "provision_identity",
    "revision",
    "identity_inputs",
    "object_mode",
    "closure",
    "hydration",
    "integrity",
    "byte_accounting",
    "fallback_reason"
  ]) {
    assert.ok(field in block, `the receipt does not report ${field}`);
  }
  // The integrity check is recorded, not asserted, so a checkout with a damaged
  // object store produces a receipt that says so rather than one that omits it.
  assert.equal(typeof block.integrity.fsck_connectivity_only_exit, "number");
  assert.ok(block.integrity.commits_reachable_from_head > 0);
  assert.equal(typeof block.integrity.working_tree_clean, "boolean");
});

test("a receipt that would leak a host detail fails closed instead of being redacted", () => {
  assert.throws(
    () => buildReceipt({ fallbackReason: "fell back after reading /Users/someone/scratch/checkout" }),
    /not host-neutral/
  );
});

test("byte accounting is refused unless its categories partition the total", () => {
  const footprint = {
    categories: { git_metadata: { logical_bytes: 10, allocated_bytes: 10 } },
    total: { logical_bytes: 99, allocated_bytes: 99 },
    tracked_file_count: 1,
    hardlink_dedup: { entries: 0, logical_bytes: 0 }
  };
  assert.throws(() => buildReceipt({ footprint }), /does not partition/);
});

test("the documented decision table is generated from the manifest, so it cannot drift", () => {
  const generated = run(["tools/card_profile_router.mjs", "--table"]).stdout.trim();
  const documented = readFileSync(resolve(ROOT, "docs/card-work-profile.md"), "utf8");
  const start = documented.indexOf("<!-- generated: card-profile-decision-table -->");
  const end = documented.indexOf("<!-- /generated: card-profile-decision-table -->");
  assert.ok(start >= 0 && end > start, "the decision table markers are missing from the guide");
  const embedded = documented.slice(start + "<!-- generated: card-profile-decision-table -->".length, end).trim();
  assert.equal(
    embedded,
    generated,
    "the documented decision table is stale; regenerate it with node tools/card_profile_router.mjs --table"
  );
});

test("the gate front door and the provisioner reach the same decision", () => {
  // One router, not two. A gate class the router sends to the control must be
  // refused by the front door in a reduced checkout, and one it keeps on the
  // reduced profile must be permitted.
  for (const entry of closure.full_checkout_only) {
    const result = run(["tools/verify_card_profile.mjs", "--gate", entry.id], {
      CITYSCROLL_CARD_PROFILE_ASSUME_REDUCED: "1"
    });
    assert.equal(result.status, 3, `${entry.id} was not refused: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /requires the full-checkout control/);
  }
  for (const gate of closure.supported_gate_classes) {
    const result = run(["tools/verify_card_profile.mjs", "--gate", gate], {
      CITYSCROLL_CARD_PROFILE_ASSUME_REDUCED: "1"
    });
    assert.equal(result.status, 0, `${gate} was refused: ${result.stdout}${result.stderr}`);
  }
});
