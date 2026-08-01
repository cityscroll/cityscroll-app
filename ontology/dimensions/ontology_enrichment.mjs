// Dimension: ontology-enrichment
// Wraps the existing MAPE planEnrichmentCards path (cross-spine gaps,
// registry drift, dual-write coverage holes, class-(a) gaps, ER quality).

import {
  buildIntelligenceReceipt,
  planEnrichmentCards,
} from "../flywheel.mjs";
import { makeDimensionCard } from "./shared.mjs";

export const DIMENSION_ID = "ontology-enrichment";

/**
 * @param {object} input — same inventories as the intelligence flywheel
 */
export function evaluateOntologyEnrichment(input = {}) {
  const receipt = input.receipt || buildIntelligenceReceipt({
    mode: input.mode || "fixture",
    generated_at: input.generated_at || "1970-01-01T00:00:00.000Z",
    source_coverage: input.source_coverage,
    gap_taxonomy: input.gap_taxonomy,
    er_metrics: input.er_metrics,
    shadow_monitor: input.shadow_monitor,
    cross_spine: input.cross_spine,
    actionability: input.actionability,
    registry_sync: input.registry_sync,
  });

  const planned = planEnrichmentCards({
    receipt,
    source_coverage: input.source_coverage,
    gap_taxonomy: input.gap_taxonomy,
    registry_sync: input.registry_sync,
    cross_spine: input.cross_spine,
  });

  const cards = planned.map((card) => makeDimensionCard({
    dimension: DIMENSION_ID,
    slug: card.id.replace(/^crol-list\/flywheel-/, "").replace(/[^a-zA-Z0-9._-]+/g, "-"),
    title: card.title,
    rank_score: card.rank_score,
    evidence: {
      ...card.evidence,
      legacy_class: card.class,
      legacy_id: card.id,
    },
    verify: card.verify,
    demo_win: demoWinForLegacyClass(card.class, card),
    context: card.context,
    needs_human: card.needs_human,
    lesson_class: `ontology-${card.class}`,
  }));

  return {
    dimension: DIMENSION_ID,
    metrics: {
      legacy_cards: planned.length,
      receipt_hash: receipt?.provenance?.content_hash || null,
      source_coverage_rate: receipt?.metrics?.source_coverage_rate ?? null,
      gap_class_a_open: receipt?.metrics?.gap_class_a_open ?? null,
      registry_sync_ok: receipt?.metrics?.registry_sync_ok ?? null,
    },
    cards,
    receipt,
  };
}

function demoWinForLegacyClass(cardClass, card) {
  switch (cardClass) {
    case "coverage":
      return `Source observations for ${card.evidence?.source_id || "the stream"} are retained immutably and raise source_coverage.`;
    case "gap_a":
      return `Class-(a) gap ${card.evidence?.gap_id || "slot"} shows joined public data instead of “not yet shown here”.`;
    case "registry":
      return "Live product allowlists and the ontology registry agree with no missing catalog entries.";
    case "contradiction":
      return "Cross-spine fixture subjects agree on identity keys and join confidence.";
    case "er_quality":
      return "Gold false-split count is zero on the hard ER cases.";
    case "actionability":
      return "Notices expose a usable official handoff instead of an unavailable placeholder.";
    default:
      return "Ontology enrichment metric improves and the card’s verify gate passes.";
  }
}
