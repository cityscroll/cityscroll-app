// Dimension: surface-load
// Measures rendered word/link/button load, verbatim duplication, and whether a
// resident-serving action appears in the first viewport of principal surfaces.

import { makeDimensionCard } from "./shared.mjs";

export const DIMENSION_ID = "surface-load";

const number = (value) => value == null || value === ""
  ? null
  : Number.isFinite(Number(value)) ? Number(value) : null;

export function surfaceLoadBreaches(surface = {}) {
  if (surface.status !== "ok") return [];
  const measured = surface.measured || {};
  const budgets = surface.budgets || {};
  const breaches = [];
  for (const metric of ["words", "links", "buttons"]) {
    const actual = number(measured[metric]);
    const maximum = number(budgets[metric]);
    if (actual != null && maximum != null && actual > maximum) {
      breaches.push({ kind: "budget", metric, actual, maximum });
    }
  }

  const repeat = number(measured.max_verbatim_repeat);
  const repeatMaximum = number(budgets.max_verbatim_repeat);
  if (repeat != null && repeatMaximum != null && repeat > repeatMaximum) {
    breaches.push({
      kind: "verbatim-duplication",
      metric: "max_verbatim_repeat",
      actual: repeat,
      maximum: repeatMaximum,
      examples: Array.isArray(measured.verbatim_duplicates)
        ? measured.verbatim_duplicates.slice(0, 5)
        : [],
    });
  }

  if (surface.action_required !== false) {
    const actionY = number(measured.first_action_y);
    const actionMaximum = number(budgets.max_first_action_y);
    if (actionY == null) {
      breaches.push({
        kind: "action-position",
        metric: "first_action_y",
        actual: null,
        maximum: actionMaximum,
        reason: "no resident-serving action matched",
      });
    } else if (actionMaximum != null && actionY > actionMaximum) {
      breaches.push({
        kind: "action-position",
        metric: "first_action_y",
        actual: actionY,
        maximum: actionMaximum,
        reason: "first resident-serving action begins below the top-page budget",
      });
    }
  }
  return breaches;
}

export function evaluateSurfaceLoad(input = {}) {
  const inventory = input.surface_load || {};
  const surfaces = Array.isArray(inventory.surfaces) ? inventory.surfaces : [];
  const cards = [];
  const metrics = {
    surfaces_expected: Array.isArray(inventory.definitions) ? inventory.definitions.length : surfaces.length,
    surfaces_sampled: surfaces.length,
    surfaces_complete: 0,
    surfaces_incomplete: 0,
    surfaces_over_budget: 0,
    action_position_flags: 0,
    duplication_flags: 0,
  };

  for (const surface of surfaces) {
    const id = slugify(surface.id || surface.surface);
    if (surface.status !== "ok") {
      metrics.surfaces_incomplete += 1;
      continue;
    }
    metrics.surfaces_complete += 1;
    const breaches = surfaceLoadBreaches(surface);
    if (!breaches.length) continue;
    metrics.surfaces_over_budget += 1;
    if (breaches.some((breach) => breach.kind === "action-position")) {
      metrics.action_position_flags += 1;
    }
    if (breaches.some((breach) => breach.kind === "verbatim-duplication")) {
      metrics.duplication_flags += 1;
    }
    const actionFirst = breaches.some((breach) => breach.kind === "action-position");
    const worstRatio = Math.max(1, ...breaches
      .filter((breach) => breach.actual != null && breach.maximum > 0)
      .map((breach) => breach.actual / breach.maximum));
    cards.push(makeDimensionCard({
      dimension: DIMENSION_ID,
      slug: `surface-${id}`,
      title: actionFirst
        ? `Restore an action-first opening on ${surface.label || id}`
        : `Reduce measured interface load on ${surface.label || id}`,
      rank_score: actionFirst ? 96 : worstRatio >= 3 ? 92 : worstRatio >= 1.5 ? 84 : 72,
      evidence: {
        kind: "surface-load-regression",
        surface_id: id,
        label: surface.label || id,
        route: surface.route || null,
        measured_at: inventory.measured_at || null,
        viewport: inventory.viewport || null,
        measured: surface.measured || {},
        budgets: surface.budgets || {},
        breaches,
      },
      verify: `python3 tools/sample_surface_load.py --live --only ${id} --gate`,
      demo_win: actionFirst
        ? `The ${surface.label || id} surface presents a resident-serving action within its opening viewport.`
        : `The ${surface.label || id} surface stays within its measured word, link, button, and repetition budgets.`,
      context: [
        "tools/sample_surface_load.py",
        "ontology/fixtures/dimensions/surface_load.json",
        surface.file || "site/index.html",
      ],
      lesson_class: actionFirst ? "action-first-surface" : "surface-load-budget",
    }));
  }

  return { dimension: DIMENSION_ID, metrics, cards };
}

function slugify(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "unknown";
}
