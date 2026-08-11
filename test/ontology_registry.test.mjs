// Characterization: ontology registry catalogs every live allowlist id.
//
//   node --test test/ontology_registry.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadOntologyRegistry,
  checkOntologyRegistrySync,
  collectLiveInventory,
  ONTOLOGY_REGISTRY_SCHEMA,
  idsWithStatus,
  GROUNDING_STATES,
  summarizeGrounding,
  validateRegistryGrounding,
} from "../ontology/index.mjs";
import {
  PUBLIC_GRAPH_EDGE_TYPES,
  PUBLIC_GRAPH_NODE_TYPES,
} from "../entity_resolution/publication/relationship_graph.mjs";
import { EVENT_KIND_REGISTRY } from "../worker/src/lib/civic_time.mjs";
import { ACTION_TYPES as LOG_ACTIONS, OBJECT_TYPES as LOG_OBJECTS } from "../worker/src/lib/action_log.mjs";
import { ASSERTION_FACT_DEFINITIONS } from "../entity_resolution/review/assertion_evidence.mjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const actionRegistry = require("../site/action_registry.js");

test("registry loads with expected schema", () => {
  const registry = loadOntologyRegistry();
  assert.equal(registry.schema, ONTOLOGY_REGISTRY_SCHEMA);
  assert.ok(registry.version);
  assert.ok(Array.isArray(registry.object_types));
  assert.ok(Array.isArray(registry.link_types));
  assert.ok(Array.isArray(registry.event_kinds));
});

test("every live allowlist id is cataloged (registered or unregistered)", () => {
  const sync = checkOntologyRegistrySync();
  assert.equal(sync.ok, true, sync.summary);
  assert.equal(sync.failures.length, 0);
});

test("public graph nodes and edges are registered (not merely unregistered)", () => {
  const registry = loadOntologyRegistry();
  const objects = new Map(registry.object_types.map((e) => [e.id, e]));
  const links = new Map(registry.link_types.map((e) => [e.id, e]));
  for (const id of PUBLIC_GRAPH_NODE_TYPES) {
    assert.equal(objects.get(id)?.status, "registered", `node ${id}`);
  }
  for (const id of PUBLIC_GRAPH_EDGE_TYPES) {
    assert.equal(links.get(id)?.status, "registered", `edge ${id}`);
  }
});

test("every civic-time event kind is registered", () => {
  const registry = loadOntologyRegistry();
  const kinds = new Map(registry.event_kinds.map((e) => [e.id, e]));
  for (const id of Object.keys(EVENT_KIND_REGISTRY)) {
    assert.equal(kinds.get(id)?.status, "registered", id);
  }
  assert.equal(Object.keys(EVENT_KIND_REGISTRY).length, registry.event_kinds.length);
});

test("assertion labels and facts are cataloged", () => {
  const registry = loadOntologyRegistry();
  const classes = new Map(registry.assertion_classifications.map((e) => [e.id, e]));
  assert.equal(classes.get("source_assertion")?.status, "registered");
  assert.equal(classes.get("cityscroll_interpretation")?.status, "registered");
  const facts = new Map(registry.assertion_facts.map((e) => [e.id, e]));
  for (const def of ASSERTION_FACT_DEFINITIONS) {
    assert.equal(facts.get(def.fact)?.status, "registered", def.fact);
  }
});

test("kinetic reader actions, deliveries, outcomes, and product method log are cataloged", () => {
  const registry = loadOntologyRegistry();
  const kinetic = registry.kinetic_action_types;
  const readers = new Map(kinetic.reader_actions.map((e) => [e.id, e]));
  for (const id of actionRegistry.ACTION_TYPES) {
    assert.equal(readers.get(id)?.status, "registered", id);
  }
  const deliveries = new Map(kinetic.action_deliveries.map((e) => [e.id, e]));
  for (const id of actionRegistry.ACTION_DELIVERIES) {
    assert.equal(deliveries.get(id)?.status, "registered", id);
  }
  const methods = new Map(kinetic.product_method_log.map((e) => [e.id, e]));
  for (const id of LOG_ACTIONS) {
    assert.equal(methods.get(id)?.status, "registered", id);
  }
  const objects = new Map(registry.object_types.map((e) => [e.id, e]));
  for (const id of LOG_OBJECTS) {
    assert.ok(objects.has(id), `action_log object ${id}`);
  }
  const outcomes = new Map(kinetic.outcomes.map((e) => [e.id, e]));
  for (const id of actionRegistry.OUTCOME_ENUM) {
    assert.equal(outcomes.get(id)?.status, "registered", id);
  }
});

test("unregistered object types declare a reason", () => {
  const registry = loadOntologyRegistry();
  for (const entry of registry.object_types) {
    if (entry.status === "unregistered") {
      assert.ok(entry.reason && entry.reason.length > 10, entry.id);
    }
  }
  assert.ok(idsWithStatus(registry.object_types, "unregistered").includes("vote"));
  // payment is registered after Checkbook Spending retention (2026-08-11 kill sample).
  assert.ok(idsWithStatus(registry.object_types, "registered").includes("payment"));
  // official is registered (public graph person-level vote nodes).
  assert.ok(idsWithStatus(registry.object_types, "registered").includes("official"));
});

test("live inventory is non-empty and stable-shaped", () => {
  const live = collectLiveInventory();
  assert.ok(live.public_graph_nodes.length >= 5);
  assert.ok(live.event_kinds.length >= 15);
  assert.ok(live.reader_actions.length >= 10);
  assert.ok(live.product_method_log.includes("review_decision"));
});

test("every object and link carries Civic Graph grounding (built|partial|gap)", () => {
  const registry = loadOntologyRegistry();
  assert.equal(validateRegistryGrounding(registry), true);
  for (const entry of registry.object_types) {
    assert.ok(GROUNDING_STATES.includes(entry.grounding), entry.id);
    if (entry.status === "unregistered") {
      assert.notEqual(entry.grounding, "built", entry.id);
    }
  }
  for (const entry of registry.link_types) {
    assert.ok(GROUNDING_STATES.includes(entry.grounding), entry.id);
  }
  for (const entry of registry.event_kinds) {
    assert.ok(GROUNDING_STATES.includes(entry.grounding), entry.id);
  }
  const summary = summarizeGrounding(registry);
  assert.ok(summary.objects.built + summary.objects.partial + summary.objects.gap === registry.object_types.length);
  assert.ok(summary.object_gap_ids.includes("payment"));
  assert.ok(summary.link_gap_ids.includes("paid_under") || summary.link_gap_ids.includes("registered_as"));
  assert.equal(registry.civic_graph?.name, "Civic Graph");
  assert.ok(Array.isArray(registry.civic_graph?.remaining_stack));
  assert.ok(registry.civic_graph.remaining_stack.length >= 3);
});

test("design-matrix product joins are cataloged even when unregistered", () => {
  const registry = loadOntologyRegistry();
  const links = new Map(registry.link_types.map((e) => [e.id, e]));
  for (const id of [
    "passport_contract_for",
    "passport_rfx_for",
    "notice_for_meeting",
    "comment_deadline_of",
    "milestone_of",
    "subsidy_stage_of",
  ]) {
    assert.ok(links.has(id), id);
    assert.equal(links.get(id).status, "unregistered");
  }
});
