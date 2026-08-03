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
    actionability: input.actionability,
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
  cards.push(...temporalScorecardCards(input));

  return {
    dimension: DIMENSION_ID,
    metrics: {
      legacy_cards: planned.length,
      receipt_hash: receipt?.provenance?.content_hash || null,
      source_coverage_rate: receipt?.metrics?.source_coverage_rate ?? null,
      gap_class_a_open: receipt?.metrics?.gap_class_a_open ?? null,
      registry_sync_ok: receipt?.metrics?.registry_sync_ok ?? null,
      temporal_completeness_rate: input.temporal_scorecard?.temporal_completeness_rate ?? null,
      procurement_lifecycle_coherence_rate:
        input.lifecycle_coherence_scorecard?.procurement_lifecycle_coherence_rate ?? null,
      award_solicitation_recovery_rate:
        input.lifecycle_coherence_scorecard?.award_solicitation_recovery_rate ?? null,
    },
    cards,
    receipt,
  };
}

function temporalScorecardCards(input) {
  const cards = [];
  const temporal = input.temporal_scorecard || {};
  const temporalRate = Number(temporal.temporal_completeness_rate);
  if (Number(temporal.event_count) > 0 && temporalRate < 1) {
    cards.push(makeDimensionCard({
      dimension: DIMENSION_ID,
      slug: "temporal-completeness",
      title: "Complete missing civic-event clocks",
      rank_score: 87,
      evidence: {
        kind: "temporal-scorecard-regression",
        event_count: temporal.event_count,
        temporal_completeness_rate: temporalRate,
        gap_count: temporal.gap_count ?? null,
        gaps: temporal.gaps || [],
      },
      verify: "node -e \"const s=require('./worker/test/fixtures/civic-time/expected_temporal_completeness.json'); process.exit(s.temporal_completeness_rate === 1 ? 0 : 1)\"",
      demo_win: "Every measured civic event carries the applicable event, publication, observation, and processing clocks.",
      context: ["worker/src/lib/civic_time.mjs", "worker/test/fixtures/civic-time/expected_temporal_completeness.json"],
      lesson_class: "ontology-temporal-completeness",
    }));
  }

  const lifecycle = input.lifecycle_coherence_scorecard || {};
  const coherenceRate = Number(lifecycle.procurement_lifecycle_coherence_rate);
  const recoveryRate = Number(lifecycle.award_solicitation_recovery_rate);
  if (Number(lifecycle.eligible) > 0 && (coherenceRate < 1 || recoveryRate < 1)) {
    cards.push(makeDimensionCard({
      dimension: DIMENSION_ID,
      slug: "procurement-lifecycle-coherence",
      title: "Close measured procurement lifecycle coherence gaps",
      rank_score: 89,
      evidence: {
        kind: "lifecycle-coherence-scorecard-regression",
        eligible: lifecycle.eligible,
        coherent: lifecycle.coherent,
        procurement_lifecycle_coherence_rate: coherenceRate,
        award_solicitation_recovery_rate: recoveryRate,
        issue_counts: lifecycle.issue_counts || {},
      },
      verify: "node -e \"const s=require('./worker/test/fixtures/lifecycle-coherence/expected_coherence.json'); process.exit(s.procurement_lifecycle_coherence_rate === 1 && s.award_solicitation_recovery_rate === 1 ? 0 : 1)\"",
      demo_win: "Procurement timelines remain ordered, reconcile amounts, and recover a sourced solicitation for every eligible award.",
      context: ["worker/src/lib/lifecycle_coherence.mjs", "worker/test/fixtures/lifecycle-coherence/expected_coherence.json"],
      lesson_class: "ontology-lifecycle-coherence",
    }));
  }
  return cards;
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
      return "Primary kinetic handoffs deep-link to the specific official item instead of a search page, landing, or unavailable placeholder.";
    default:
      return "Ontology enrichment metric improves and the card’s verify gate passes.";
  }
}
