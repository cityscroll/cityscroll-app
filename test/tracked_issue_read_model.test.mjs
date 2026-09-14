import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEmmonsShelterMonitorPack,
  validateTrackedIssueRegistry,
  TRACKED_ISSUE_REGISTRY_SCHEMA,
} from "../site/emmons_shelter_monitor_pack.mjs";

test("the versioned monitor-pack registry projects bounded resident sections", () => {
  const pack = buildEmmonsShelterMonitorPack();
  const registry = pack.registry;

  assert.equal(registry.schema, TRACKED_ISSUE_REGISTRY_SCHEMA);
  assert.equal(registry.version, 1);
  assert.equal(registry.namespace, "monitor-pack");
  assert.equal(registry.issue_slug, "emmons-shelter");
  assert.deepEqual(registry.exact_anchors.map((anchor) => anchor.key), [
    "procurement_id", "procurement_ref", "pin", "vendor", "board_ref", "address", "bbl",
  ]);
  assert.equal(registry.aliases.length, 5);
  assert.ok(registry.aliases.every((alias) => alias.target_subject_ref === "monitor-pack:emmons-shelter" && alias.source_observation_ref));
  assert.ok(registry.location_evidence.method && registry.location_evidence.source_observation_ref);
  assert.equal(registry.watch_children.length, 3);
  assert.equal(registry.source_links.length, 3);
  assert.deepEqual(registry.sections, {
    knows: "What CityScroll knows",
    timeline: "Timeline",
    watch: "What to watch",
    not_yet_covered: "Not yet covered",
  });
  assert.equal(validateTrackedIssueRegistry(registry), true);
});

test("timeline events retain source observations and canonical routes", () => {
  const pack = buildEmmonsShelterMonitorPack();
  assert.ok(pack.events.length >= 7);
  for (const event of pack.events) {
    assert.ok(event.source_observation_ref);
    assert.match(event.canonical_href, /^\//);
  }
  assert.match(pack.events.find((event) => event.type === "reported_claim").excerpt, /reported claim/i);
});

test("unsupported or unattributed event claims fail registry validation", () => {
  const registry = buildEmmonsShelterMonitorPack().registry;
  const missingObservation = structuredClone(registry);
  delete missingObservation.timeline[0].source_observation_ref;
  assert.throws(() => validateTrackedIssueRegistry(missingObservation), /source observation/);

  const unsupportedAction = structuredClone(registry);
  unsupportedAction.timeline[0].action_type = "formal_board_action_from_title";
  assert.throws(() => validateTrackedIssueRegistry(unsupportedAction), /unsupported Emmons action type/);
});

test("action classes stay explicit and are never inferred from titles", () => {
  const pack = buildEmmonsShelterMonitorPack({
    events: [
      "formal_board_action", "individual_official_action", "public_comment", "litigation_event", "reported_claim",
    ].map((action_type, index) => ({
      type: action_type === "litigation_event" ? "litigation_event" : "reported_claim",
      action_type,
      label: `same title ${index}`,
      source_observation_ref: `fixture:${index}`,
      canonical_href: "/following/packs/emmons-shelter/",
    })),
  });
  assert.deepEqual(pack.events.map((event) => event.action_type), [
    "formal_board_action", "individual_official_action", "public_comment", "litigation_event", "reported_claim",
  ]);
});
