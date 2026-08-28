import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildActionPath, continuationScopeForSubject, validateActionPath } from "../site/action_path_v0.mjs";
import actionRegistry from "../site/action_registry.js";
import { loadOntologyRegistry } from "../ontology/index.mjs";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/action_path_v0.json", import.meta.url), "utf8"));

test("action-only path retains the exact validated action and has no continuation", () => {
  const action = fixtures.action_only.action;
  const path = buildActionPath(fixtures.action_only);
  assert.equal(path.action, action);
  assert.equal(path.continuation, null);
  assert.equal(path.continuation_cta, false);
  assert.equal(path.ambiguity, "none");
  assert.equal(path.availability.state, "available");
  assert.equal(validateActionPath(path), path);
});

test("one exact continuation is available without turning it into a watch mutation", () => {
  const path = buildActionPath(fixtures.single_continuation);
  assert.equal(path.continuation_cta, true);
  assert.equal(path.continuation.kind, "subject");
  assert.equal(path.continuation.subject_ref, "matter:79200");
  assert.deepEqual(path.continuation.candidates.map((candidate) => candidate.subject_ref), ["matter:79200"]);
  assert.equal(path.process_ref, "matter:79200");
  assert.equal(path.provenance, path.evidence);
});

test("multiple exact continuation candidates remain a choice and never select one", () => {
  const path = buildActionPath(fixtures.multiple_candidates);
  assert.equal(path.ambiguity, "multiple");
  assert.equal(path.continuation_state, "ambiguous");
  assert.equal(path.continuation_cta, false);
  assert.equal(path.continuation.kind, null);
  assert.equal(path.continuation.subject_ref, null);
  assert.deepEqual(
    path.continuation.candidates.map((candidate) => candidate.subject_ref),
    ["matter:79201", "matter:79203", "matter:79202", "matter:79204", "matter:79205"],
  );
});

test("unsupported or lossy continuation yields no continuation CTA", () => {
  const path = buildActionPath(fixtures.unsupported_lossy);
  assert.equal(path.continuation, null);
  assert.equal(path.continuation_cta, false);
  assert.equal(path.continuation_state, "unknown");
  assert.equal(path.ambiguity, "unknown");
  assert.equal(Object.hasOwn(path, "scope"), false);
});

test("replayability is an explicit capability for scope continuations", () => {
  const candidate = {
    kind: "scope",
    replayable: true,
    scope: {
      schema: "cityscroll.scope",
      version: 0,
      facets: { domains: ["meetings"] },
    },
  };
  assert.deepEqual(continuationScopeForSubject("matter:79200", candidate).facets.domains, ["meetings"]);
  assert.equal(continuationScopeForSubject("matter:79200", { ...candidate, replayable: false }), null);
});

test("invalid evidence is rejected rather than turned into a behavioral record", () => {
  assert.throws(() => buildActionPath(fixtures.invalid_evidence), /provenance-bearing|source ref/);
  assert.throws(() => buildActionPath({
    ...fixtures.action_only,
    actor_id: "resident-1",
  }), /not allowed/);
});

test("unavailable action remains a valid action path with unavailable availability", () => {
  const path = buildActionPath(fixtures.unavailable_action);
  assert.equal(path.action.delivery, "unavailable");
  assert.equal(path.availability.state, "unavailable");
  assert.equal(path.continuation, null);
  assert.equal(actionRegistry.ACTION_TYPES.includes(path.action.type), true);
  validateActionPath(path);
});

test("DOT City-Owned Bicycle Racks keeps one rulemaking subject across T1/T2/T3", () => {
  const snapshotInputs = Object.values(fixtures.dot_bicycle_racks);
  const snapshots = snapshotInputs.map(buildActionPath);
  const subjectRefs = snapshots.map((path) => path.process_ref);
  const continuationRefs = snapshots.map((path) => path.continuation.subject_ref);
  assert.deepEqual(subjectRefs, [
    "rulemaking:dot:bicycle-owned-racks",
    "rulemaking:dot:bicycle-owned-racks",
    "rulemaking:dot:bicycle-owned-racks",
  ]);
  assert.deepEqual(continuationRefs, subjectRefs);
  assert.deepEqual(snapshots.map((path) => path.target_ref), [
    "notice:20260317026",
    "notice:20260706041",
    "notice:20260706041",
  ]);
  assert.deepEqual(snapshotInputs.map((fixture) => [
    fixture.snapshot.rulemaking_state,
    fixture.snapshot.next_event,
  ]), [
    ["hearing", "public_hearing"],
    ["adopted", "adoption"],
    ["effective", "effective"],
  ]);
  const serialized = JSON.stringify(snapshots);
  assert.doesNotMatch(serialized, /all DOT rules|all DOT hearings|caused|because you commented/i);
});

test("Action Path is registered as a kinetic capability, not a semantic graph noun", () => {
  const registry = loadOntologyRegistry();
  const capability = registry.kinetic_action_types.capabilities.find((entry) => entry.id === "action_path_v0");
  assert.equal(capability?.status, "registered");
  assert.equal(capability?.backing?.includes("site/action_path_v0.mjs"), true);
  assert.equal(registry.object_types.some((entry) => entry.id === "action_path"), false);
});
