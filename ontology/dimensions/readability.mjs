// Dimension: readability / usability
// For every view that renders joined data, score density, hierarchy, and
// data-dump smell. Unusable views emit a redesign card.

import { makeDimensionCard } from "./shared.mjs";

export const DIMENSION_ID = "readability";

/** Thresholds for fixture/live view scores (0–1, higher is better). */
export const READABILITY_THRESHOLDS = Object.freeze({
  min_hierarchy: 0.45,
  max_density: 0.78,
  max_dump_smell: 0.55,
  min_overall: 0.5,
});

/**
 * Score a single view manifest.
 * @param {object} view
 * @returns {{ overall, hierarchy, density, dump_smell, unusable, reasons }}
 */
export function scoreView(view = {}) {
  const hierarchy = clamp01(view.hierarchy_score ?? view.hierarchy);
  const density = clamp01(view.density_score ?? view.density);
  // dump_smell: higher means worse (more dump-like)
  const dumpSmell = clamp01(view.dump_smell ?? view.data_dump_smell ?? 0);
  const explicitUnusable = view.unusable === true;

  const reasons = [];
  if (hierarchy < READABILITY_THRESHOLDS.min_hierarchy) {
    reasons.push(`weak hierarchy (${hierarchy.toFixed(2)} < ${READABILITY_THRESHOLDS.min_hierarchy})`);
  }
  if (density > READABILITY_THRESHOLDS.max_density) {
    reasons.push(`over-dense (${density.toFixed(2)} > ${READABILITY_THRESHOLDS.max_density})`);
  }
  if (dumpSmell > READABILITY_THRESHOLDS.max_dump_smell) {
    reasons.push(`data-dump smell (${dumpSmell.toFixed(2)} > ${READABILITY_THRESHOLDS.max_dump_smell})`);
  }

  // overall: reward hierarchy, punish density excess and dump smell
  const densityPenalty = Math.max(0, density - 0.5) * 1.2;
  const overall = clamp01(hierarchy * 0.55 + (1 - dumpSmell) * 0.3 + (1 - densityPenalty) * 0.15);

  if (overall < READABILITY_THRESHOLDS.min_overall) {
    reasons.push(`overall ${overall.toFixed(2)} below ${READABILITY_THRESHOLDS.min_overall}`);
  }

  const unusable = explicitUnusable || reasons.length > 0;
  return {
    overall,
    hierarchy,
    density,
    dump_smell: dumpSmell,
    unusable,
    reasons,
  };
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * @param {object} input
 * @param {Array<object>} input.views — view manifests with scores or raw signals
 */
export function evaluateReadability(input = {}) {
  const views = Array.isArray(input.views) ? input.views : [];
  const cards = [];
  const metrics = {
    views_checked: views.length,
    unusable: 0,
    ok: 0,
    mean_overall: null,
  };

  let sum = 0;
  let counted = 0;

  for (const view of views) {
    const viewId = String(view.id || view.surface || "").trim();
    if (!viewId) continue;
    const score = scoreView(view);
    sum += score.overall;
    counted += 1;

    if (!score.unusable) {
      metrics.ok += 1;
      continue;
    }
    metrics.unusable += 1;

    const severity = score.overall < 0.3 ? 92 : score.overall < 0.45 ? 80 : 68;
    cards.push(makeDimensionCard({
      dimension: DIMENSION_ID,
      slug: `view-${viewId}`,
      title: `Redesign unusable joined view: ${viewId}`,
      rank_score: severity,
      evidence: {
        view_id: viewId,
        surface: view.surface || viewId,
        scores: {
          overall: score.overall,
          hierarchy: score.hierarchy,
          density: score.density,
          dump_smell: score.dump_smell,
        },
        reasons: score.reasons,
        joined_fields: view.joined_fields || null,
      },
      verify: view.verify
        || `node --test test/multi_flywheel_dimensions.test.mjs # readability:${viewId} overall>=${READABILITY_THRESHOLDS.min_overall}`,
      demo_win: view.demo_win
        || `The ${viewId} view shows joined data with clear hierarchy and no raw data-dump layout.`,
      context: [
        view.surface || viewId,
        view.file || null,
        "ontology/fixtures/dimensions/readability_views.json",
      ].filter(Boolean),
      lesson_class: "unusable-joined-view",
    }));
  }

  metrics.mean_overall = counted ? Number((sum / counted).toFixed(4)) : null;

  return {
    dimension: DIMENSION_ID,
    metrics,
    cards,
  };
}
