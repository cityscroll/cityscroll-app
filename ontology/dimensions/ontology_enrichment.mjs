// Dimension: ontology-enrichment
// Wraps the existing MAPE planEnrichmentCards path (cross-spine gaps,
// registry drift, dual-write coverage holes, class-(a) gaps, ER quality).

import {
  buildIntelligenceReceipt,
  planEnrichmentCards,
} from "../flywheel.mjs";
import { makeDimensionCard } from "./shared.mjs";
import {
  civicGraphCapabilityCards,
  civicGraphCapabilityMetrics,
} from "./civic_graph_capability.mjs";

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
  cards.push(...noticeLandJoinScorecardCards(input));
  cards.push(...civicGraphCapabilityCards(input));

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
      notice_land_join_resolution_rate:
        noticeLandJoinRate(input.notice_land_join_scorecard),
      notice_land_malformed_unresolved:
        noticeLandMalformed(input.notice_land_join_scorecard),
      ...civicGraphCapabilityMetrics(input),
    },
    cards,
    receipt,
  };
}

function noticeLandJoinRate(scorecard) {
  const after = scorecard?.after || scorecard;
  const rate = Number(after?.join_resolution_rate);
  return Number.isFinite(rate) ? rate : (scorecard?.join_resolution_rate ?? null);
}

function noticeLandMalformed(scorecard) {
  const after = scorecard?.after || scorecard;
  const n = Number(after?.unmatched_malformed_only);
  return Number.isFinite(n) ? n : (scorecard?.unmatched_malformed_only ?? null);
}

function noticeLandJoinScorecardCards(input) {
  const cards = [];
  const score = input.notice_land_join_scorecard || {};
  const after = score.after || score;
  const malformed = Number(after.unmatched_malformed_only);
  const eligible = Number(after.eligible_with_plausible_token ?? after.eligible);
  const rate = Number(after.join_resolution_rate);
  // Malformed extracted ids (Zoom/phone false ULURPs) are an extractor bug class —
  // must not sit in the unresolved join pile.
  if (Number.isFinite(malformed) && malformed > 0) {
    cards.push(makeDimensionCard({
      dimension: DIMENSION_ID,
      slug: "notice-land-malformed-ulurp",
      title: "Reject malformed ULURP tokens on notice→portal joins",
      rank_score: 90,
      evidence: {
        kind: "notice-land-join-malformed",
        unmatched_malformed_only: malformed,
        join_resolution_rate: Number.isFinite(rate) ? rate : null,
        examples: score.malformed_examples_before || score.malformed_examples || [],
        owner_exemplar: score.owner_exemplar || null,
      },
      verify: "node --test test/notice_land_spine.test.mjs # owner exemplar 302621MEET",
      demo_win: "Dining Out Zoom notices no longer mount a fake ULURP land-spine gap; only plausible application numbers join.",
      context: [
        "site/ulurp_tokens.mjs",
        "site/notice_land_spine.mjs",
        "docs/evidence/notice-land-join-resolution.json",
      ],
      lesson_class: "ontology-notice-land-malformed-ulurp",
    }));
  }
  // Low join rate among plausible keys is a coverage signal (portal miss), not extractor noise.
  if (Number.isFinite(eligible) && eligible >= 5 && Number.isFinite(rate) && rate < 0.15) {
    cards.push(makeDimensionCard({
      dimension: DIMENSION_ID,
      slug: "notice-land-join-resolution",
      title: "Raise notice→Zoning Application Portal join resolution",
      rank_score: 78,
      evidence: {
        kind: "notice-land-join-rate",
        eligible,
        join_resolution_rate: rate,
        unmatched_plausible: after.unmatched_plausible_or_ambiguous
          ?? after.unmatched_plausible
          ?? null,
      },
      verify: "node --test test/notice_land_spine.test.mjs # measureNoticeLandJoinResolution",
      demo_win: "Most land notices with real ULURP numbers show a matched portal project timeline.",
      context: [
        "site/notice_land_spine.mjs",
        "docs/evidence/notice-land-join-resolution.json",
      ],
      lesson_class: "ontology-notice-land-join-rate",
    }));
  }
  return cards;
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
