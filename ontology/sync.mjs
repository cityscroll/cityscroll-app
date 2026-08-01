// Drift check: every live allowlist id must appear in the ontology registry
// with status registered|unregistered.

import { loadOntologyRegistry, requireCataloged } from "./load.mjs";
import { collectLiveInventory } from "./live_inventory.mjs";

export function checkOntologyRegistrySync(registry = loadOntologyRegistry()) {
  const live = collectLiveInventory();
  const kinetic = registry.kinetic_action_types;

  const checks = [
    requireCataloged(live.public_graph_nodes, registry.object_types, "public_graph_nodes→object_types"),
    requireCataloged(live.public_graph_edges, registry.link_types, "public_graph_edges→link_types"),
    requireCataloged(live.event_kinds, registry.event_kinds, "event_kinds"),
    requireCataloged(
      live.assertion_classifications,
      registry.assertion_classifications,
      "assertion_classifications",
    ),
    requireCataloged(live.assertion_facts, registry.assertion_facts, "assertion_facts"),
    requireCataloged(live.reader_actions, kinetic.reader_actions, "reader_actions"),
    requireCataloged(live.action_deliveries, kinetic.action_deliveries, "action_deliveries"),
    requireCataloged(live.product_method_log, kinetic.product_method_log, "product_method_log"),
    requireCataloged(live.action_log_objects, registry.object_types, "action_log_objects→object_types"),
    requireCataloged(live.outcomes, kinetic.outcomes, "outcomes"),
    requireCataloged(live.er_type_families, registry.er_type_families, "er_type_families"),
    requireCataloged(live.er_decisions, registry.er_decisions, "er_decisions"),
    requireCataloged(
      live.process_spine_confidence,
      registry.process_spine_join_confidence,
      "process_spine_join_confidence",
    ),
  ];

  const failures = checks.filter((c) => !c.ok);
  return {
    ok: failures.length === 0,
    live,
    checks,
    failures,
    summary: failures.length
      ? failures.map((f) => `${f.label}: missing=${f.missing.join(",") || "—"} invalid=${f.invalid_status.join(",") || "—"}`).join("; ")
      : "all live allowlists cataloged in ontology/registry.v0.json",
  };
}
