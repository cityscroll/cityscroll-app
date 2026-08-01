// MAPE intelligence flywheel — pure analyze/plan over committed inventories.
// Monitor inputs are read by tools/intelligence_flywheel.mjs; this module never
// dispatches agents or mutates production state. Emitted cards are P3+ work.

import { createHash } from "node:crypto";

export const INTELLIGENCE_RECEIPT_SCHEMA = "cityscroll.intelligence_receipt.v0";
export const FLYWHEEL_POLICY_VERSION = "v0";

const CARD_CLASSES = Object.freeze([
  "coverage",
  "contradiction",
  "gap_a",
  "er_quality",
  "actionability",
  "registry",
]);

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function stableHash(parts) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

/**
 * Build a deterministic intelligence receipt from measured/fixture inputs.
 * @param {object} input
 * @param {object} input.source_coverage — entity_resolution/source_coverage.json
 * @param {object} [input.gap_taxonomy] — site/data/gap_taxonomy.json
 * @param {object} [input.er_metrics] — precision/recall/… from run_metrics
 * @param {object} [input.shadow_monitor] — shadow receipt rates
 * @param {object} [input.cross_spine] — { contradictions, checked }
 * @param {object} [input.actionability] — { sample_size, actionable, rate }
 * @param {object} [input.registry_sync] — checkOntologyRegistrySync result
 * @param {string} [input.mode] — fixture|live
 * @param {string} [input.generated_at]
 * @param {object} [input.previous_receipt]
 */
export function buildIntelligenceReceipt(input = {}) {
  const mode = input.mode === "live" ? "live" : "fixture";
  const sourceCoverage = input.source_coverage || {};
  const measurement = sourceCoverage.measurement || {};
  const after = measurement.after || {};
  const coverageRate = Number(after.rate);
  const coverageCovered = Number(after.covered);
  const coverageTotal = Number(after.total);

  const gaps = Array.isArray(input.gap_taxonomy?.gaps) ? input.gap_taxonomy.gaps : [];
  const classAOpen = gaps.filter((g) => g.class === "not_yet_ingested").length;
  const classBOpen = gaps.filter((g) => g.class === "not_published").length;

  const er = input.er_metrics || {};
  const shadow = input.shadow_monitor || {};
  const cross = input.cross_spine || {};
  const actionability = input.actionability || {};
  const registrySync = input.registry_sync || {};

  const metrics = {
    source_coverage_rate: Number.isFinite(coverageRate) ? coverageRate : null,
    source_coverage_covered: Number.isFinite(coverageCovered) ? coverageCovered : null,
    source_coverage_total: Number.isFinite(coverageTotal) ? coverageTotal : null,
    gap_class_a_open: classAOpen,
    gap_class_b_open: classBOpen,
    gap_total: gaps.length,
    er_precision: numberOrNull(er.precision),
    er_recall: numberOrNull(er.recall),
    er_false_split: numberOrNull(er.false_split),
    er_false_merge: numberOrNull(er.false_merge),
    er_unresolved_rate: numberOrNull(er.unresolved_rate),
    er_candidate_recall: numberOrNull(er.candidate_recall),
    shadow_contradiction_rate: numberOrNull(shadow.contradiction_rate ?? shadow.metrics?.contradiction_rate),
    shadow_orphan_rate: numberOrNull(shadow.orphan_rate ?? shadow.metrics?.orphan_rate),
    cross_spine_checked: numberOrNull(cross.checked),
    cross_spine_contradictions: numberOrNull(cross.contradictions),
    actionability_rate_sample: numberOrNull(actionability.rate),
    actionability_sample_size: numberOrNull(actionability.sample_size),
    registry_sync_ok: typeof registrySync.ok === "boolean" ? registrySync.ok : null,
  };

  const previous = input.previous_receipt?.metrics || null;
  const deltas = previous ? metricDeltas(previous, metrics) : {};

  const receipt = {
    schema: INTELLIGENCE_RECEIPT_SCHEMA,
    generated_at: input.generated_at || new Date(0).toISOString(),
    window: {
      policy_version: FLYWHEEL_POLICY_VERSION,
      mode,
    },
    metrics,
    deltas_vs_previous: deltas,
    cards_emitted: [],
    provenance: {
      source_coverage_basis: measurement.basis || null,
      registry_sync_summary: registrySync.summary || null,
      content_hash: null,
      inputs: {
        source_coverage: Boolean(input.source_coverage),
        gap_taxonomy: Boolean(input.gap_taxonomy),
        er_metrics: Boolean(input.er_metrics),
        shadow_monitor: Boolean(input.shadow_monitor),
        cross_spine: Boolean(input.cross_spine),
        actionability: Boolean(input.actionability),
        registry_sync: Boolean(input.registry_sync),
      },
    },
  };

  receipt.provenance.content_hash = stableHash({
    schema: receipt.schema,
    window: receipt.window,
    metrics: receipt.metrics,
    deltas: receipt.deltas_vs_previous,
  });

  return receipt;
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function metricDeltas(previous, current) {
  const out = {};
  for (const [key, value] of Object.entries(current)) {
    if (typeof value !== "number" || typeof previous[key] !== "number") continue;
    out[key] = Number((value - previous[key]).toFixed(6));
  }
  return out;
}

/**
 * Analyze metrics + inventories and plan ranked enrichment cards (P3+).
 * Does not hand-card roadmap work — only metric-driven gaps.
 */
export function planEnrichmentCards({
  receipt,
  source_coverage,
  gap_taxonomy,
  registry_sync,
  cross_spine,
} = {}) {
  const cards = [];
  const sources = Array.isArray(source_coverage?.sources) ? source_coverage.sources : [];
  const coverageRate = receipt?.metrics?.source_coverage_rate;

  // M→A: dual-write coverage holes
  for (const source of sources) {
    const after = source.dual_write?.after;
    if (after !== "gap" && !source.known_gap) continue;
    if (after !== "gap" && source.known_gap && after === "complete") continue;
    const isGap = after === "gap" || (source.known_gap && after !== "complete");
    if (!isGap && after !== "gap") continue;
    if (after !== "gap") continue;

    cards.push(makeCard({
      class: "coverage",
      id_slug: `coverage-${source.id}`,
      title: `Dual-write or retain observations for ${source.id}`,
      rank_score: coveragePriority(source, coverageRate),
      evidence: {
        source_id: source.id,
        source_system: source.source_system,
        known_gap: source.known_gap || null,
        source_coverage_rate: coverageRate,
      },
      verify: `node tools/check_er_source_coverage.mjs --matrix entity_resolution/source_coverage.json # ${source.id} after=complete`,
      needs_human: null,
      context: [
        "entity_resolution/source_coverage.json",
        source.importer || null,
      ].filter(Boolean),
    }));
  }

  // Class-(a) publication gaps still open in depot
  const gaps = Array.isArray(gap_taxonomy?.gaps) ? gap_taxonomy.gaps : [];
  for (const gap of gaps) {
    if (gap.class !== "not_yet_ingested") continue;
    cards.push(makeCard({
      class: "gap_a",
      id_slug: `gap-a-${gap.id}`,
      title: `Close class-(a) gap: ${gap.id}`,
      rank_score: 40 + (typeof gap.rank === "number" ? Math.max(0, 20 - gap.rank) : 0),
      evidence: {
        gap_id: gap.id,
        surface: gap.surface || null,
        public_source: gap.public_source?.name || null,
      },
      verify: `node --test test/gap_taxonomy.test.mjs # and field-case coverage for ${gap.id}`,
      needs_human: null,
      context: [
        "site/data/gap_taxonomy.json",
        gap.i18n_key || null,
      ].filter(Boolean),
    }));
  }

  // Registry drift
  if (registry_sync && registry_sync.ok === false) {
    cards.push(makeCard({
      class: "registry",
      id_slug: "registry-sync-drift",
      title: "Repair ontology registry drift against live allowlists",
      rank_score: 100,
      evidence: {
        summary: registry_sync.summary || "registry sync failed",
        failures: (registry_sync.failures || []).map((f) => f.label),
      },
      verify: "node --test test/ontology_registry.test.mjs",
      needs_human: null,
      context: ["ontology/registry.v0.json", "ontology/sync.mjs"],
    }));
  }

  // Cross-spine contradictions
  const contradictions = Number(cross_spine?.contradictions ?? receipt?.metrics?.cross_spine_contradictions);
  if (Number.isFinite(contradictions) && contradictions > 0) {
    cards.push(makeCard({
      class: "contradiction",
      id_slug: "cross-spine-contradictions",
      title: "Resolve cross-spine agreement failures on fixture subjects",
      rank_score: 90,
      evidence: {
        contradictions,
        checked: cross_spine?.checked ?? receipt?.metrics?.cross_spine_checked,
      },
      verify: "node tools/cross_spine_validate.mjs --fixtures ontology/fixtures/cross_spine --check",
      needs_human: null,
      context: ["ontology/cross_spine.mjs", "ontology/fixtures/cross_spine"],
    }));
  }

  // ER quality: false splits when metrics present
  const falseSplit = receipt?.metrics?.er_false_split;
  if (Number.isFinite(falseSplit) && falseSplit > 0) {
    cards.push(makeCard({
      class: "er_quality",
      id_slug: "er-false-splits",
      title: "Reduce ER false splits on gold_v0 hard cases",
      rank_score: 70 + Math.min(20, falseSplit * 2),
      evidence: {
        er_false_split: falseSplit,
        er_recall: receipt.metrics.er_recall,
        er_precision: receipt.metrics.er_precision,
      },
      verify: "node entity_resolution/eval/run_metrics.mjs --gold entity_resolution/eval/gold_v0.jsonl --blocker token_v0",
      needs_human: "gold_label",
      context: ["entity_resolution/eval/gold_v0.jsonl", "entity_resolution/matchers"],
    }));
  }

  // Actionability sample weak
  const actionRate = receipt?.metrics?.actionability_rate_sample;
  if (Number.isFinite(actionRate) && actionRate < 0.5) {
    cards.push(makeCard({
      class: "actionability",
      id_slug: "actionability-low",
      title: "Raise notice actionability (non-unavailable official handoffs)",
      rank_score: 55,
      evidence: {
        actionability_rate_sample: actionRate,
        sample_size: receipt.metrics.actionability_sample_size,
      },
      verify: "node --test test/action-rail.test.mjs test/notice_action_rail.test.mjs",
      needs_human: null,
      context: ["site/action_registry.js"],
    }));
  }

  // Rank: higher score first; stable id tie-break
  cards.sort((a, b) => b.rank_score - a.rank_score || a.id.localeCompare(b.id));
  // Assign rank positions
  cards.forEach((card, index) => {
    card.rank = index + 1;
  });

  // Cap mechanical emission so the flywheel stays actionable
  return cards.slice(0, 25);
}

function coveragePriority(source, coverageRate) {
  // Prefer identity-rich streams; slightly boost when overall rate is low.
  const base = 80;
  const rateBoost = Number.isFinite(coverageRate) && coverageRate < 0.5 ? 10 : 0;
  const identityBoost = Array.isArray(source.identity_entities)
    ? Math.min(10, source.identity_entities.length)
    : 0;
  // Spending and votes are high-value holes called out in the design.
  const name = clean(source.id);
  const namedBoost = /spending|votes|legistar-events|doing-business/.test(name) ? 5 : 0;
  return base + rateBoost + identityBoost + namedBoost;
}

function makeCard({
  class: cardClass,
  id_slug,
  title,
  rank_score,
  evidence,
  verify,
  needs_human,
  context,
}) {
  if (!CARD_CLASSES.includes(cardClass)) {
    throw new TypeError(`unknown card class: ${cardClass}`);
  }
  const id = `crol-list/flywheel-${id_slug}`;
  return {
    id,
    title,
    status: "proposed",
    class: cardClass,
    rank_score,
    rank: null,
    emitted_by: "intelligence_flywheel",
    policy_version: FLYWHEEL_POLICY_VERSION,
    evidence,
    context,
    verify,
    needs_human,
    note: "Flywheel-emitted enrichment card (P3+). Not a hand-authored roadmap tranche.",
  };
}

/**
 * Attach planned cards onto a receipt (mutates a shallow copy).
 */
export function attachCards(receipt, cards) {
  const next = {
    ...receipt,
    cards_emitted: cards.map((c) => ({
      id: c.id,
      class: c.class,
      rank: c.rank,
      title: c.title,
    })),
  };
  next.provenance = {
    ...receipt.provenance,
    content_hash: stableHash({
      schema: next.schema,
      window: next.window,
      metrics: next.metrics,
      deltas: next.deltas_vs_previous,
      cards: next.cards_emitted,
    }),
  };
  return next;
}

export function renderCardMarkdown(card) {
  const lines = [
    "---",
    `id: ${card.id}`,
    `title: ${JSON.stringify(card.title)}`,
    `status: ${card.status}`,
    `class: ${card.class}`,
    `rank: ${card.rank}`,
    "context:",
    ...(card.context || []).map((c) => `  - ${c}`),
    `verify: ${JSON.stringify(card.verify)}`,
    `needs_human: ${card.needs_human == null ? "null" : JSON.stringify(card.needs_human)}`,
    `emitted_by: ${card.emitted_by}`,
    `policy_version: ${card.policy_version}`,
    "---",
    "",
    card.note || "",
    "",
    "### Evidence",
    "```json",
    JSON.stringify(card.evidence || {}, null, 2),
    "```",
    "",
  ];
  return lines.join("\n");
}
