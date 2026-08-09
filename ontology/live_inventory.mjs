// Collect live type inventories from product allowlists for registry drift checks.
// Read-only imports; does not write production state.

import {
  PUBLIC_GRAPH_EDGE_TYPES,
  PUBLIC_GRAPH_NODE_TYPES,
} from "../entity_resolution/publication/relationship_graph.mjs";
import {
  ASSERTION_FACT_DEFINITIONS,
} from "../entity_resolution/review/assertion_evidence.mjs";
import {
  PUBLIC_DOSSIER_FACT_DEFINITIONS,
} from "../entity_resolution/publication/dossier.mjs";
import { ENTITY_TYPE_FAMILIES } from "../entity_resolution/officials/index.mjs";
import { EVENT_KIND_REGISTRY } from "../worker/src/lib/civic_time.mjs";
import { ACTION_TYPES as ACTION_LOG_TYPES, OBJECT_TYPES as ACTION_LOG_OBJECTS } from "../worker/src/lib/action_log.mjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const actionRegistry = require("../site/action_registry.js");

/** Classifications emitted by assertion/dossier/graph serializers. */
export const ASSERTION_CLASSIFICATIONS = Object.freeze([
  "source_assertion",
  "cityscroll_interpretation",
]);

/** ER taxonomy type families (ADR + matchers). */
export const ER_TYPE_FAMILIES = ENTITY_TYPE_FAMILIES;

/** entity_link / taxonomy decision enum. */
export const ER_DECISIONS = Object.freeze([
  "auto_link",
  "separate",
  "review",
  "never_auto",
]);

/** process_spine join.confidence allowlist. */
export const PROCESS_SPINE_CONFIDENCE = Object.freeze([
  "confirmed",
  "review",
  "unmatched",
]);

export function collectLiveInventory() {
  const readerActions = [...(actionRegistry.ACTION_TYPES || [])];
  const deliveries = [...(actionRegistry.ACTION_DELIVERIES || [])];
  const outcomes = [...(actionRegistry.OUTCOME_ENUM || [])];
  const assertionFacts = [
    ...new Set([
      ...ASSERTION_FACT_DEFINITIONS.map((d) => d.fact),
      ...PUBLIC_DOSSIER_FACT_DEFINITIONS.map((d) => d.fact),
    ]),
  ].sort();

  return {
    public_graph_nodes: [...PUBLIC_GRAPH_NODE_TYPES].sort(),
    public_graph_edges: [...PUBLIC_GRAPH_EDGE_TYPES].sort(),
    event_kinds: Object.keys(EVENT_KIND_REGISTRY).sort(),
    assertion_classifications: [...ASSERTION_CLASSIFICATIONS].sort(),
    assertion_facts: assertionFacts,
    reader_actions: readerActions.slice().sort(),
    action_deliveries: deliveries.slice().sort(),
    product_method_log: [...ACTION_LOG_TYPES].sort(),
    action_log_objects: [...ACTION_LOG_OBJECTS].sort(),
    outcomes: outcomes.slice().sort(),
    er_type_families: [...ER_TYPE_FAMILIES].sort(),
    er_decisions: [...ER_DECISIONS].sort(),
    process_spine_confidence: [...PROCESS_SPINE_CONFIDENCE].sort(),
  };
}
