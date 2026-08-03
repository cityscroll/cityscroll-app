// Dimension: surface-load
// Measures rendered word/link/button load, verbatim duplication, whether a
// resident-serving action appears in the first viewport of principal surfaces,
// and empty-state / apology density (wackness sampling).

import { makeDimensionCard } from "./shared.mjs";

export const DIMENSION_ID = "surface-load";

/** Phrases that apologize for missing facts instead of staying quiet. */
export const EMPTY_STATE_APOLOGY_PHRASES = Object.freeze([
  "not yet shown here",
  "not available yet",
  "needs both",
  "nothing is invented here",
  "no labeled minimum bid",
  "market-basket discount",
  "could not reach",
  "the city does not publish",
]);

/**
 * A card/section whose rendered blocks are majority empty-state/explainer content
 * is flagged. Ratio threshold is product policy for the sampler.
 */
export const EMPTY_STATE_MAJORITY_THRESHOLD = 0.5;

/** More than one apology phrase hit per card is a density smell. */
export const EMPTY_STATE_APOLOGY_REPEAT_THRESHOLD = 1;

const number = (value) => value == null || value === ""
  ? null
  : Number.isFinite(Number(value)) ? Number(value) : null;

/**
 * Count apology-phrase hits in free text (case-insensitive).
 * @param {string} text
 * @returns {{ total: number, by_phrase: Record<string, number>, phrases_hit: string[] }}
 */
export function countApologyPhrases(text) {
  const hay = String(text || "").toLowerCase();
  const by_phrase = {};
  let total = 0;
  for (const phrase of EMPTY_STATE_APOLOGY_PHRASES) {
    let from = 0;
    let n = 0;
    while (from < hay.length) {
      const idx = hay.indexOf(phrase, from);
      if (idx === -1) break;
      n += 1;
      from = idx + phrase.length;
    }
    if (n > 0) {
      by_phrase[phrase] = n;
      total += n;
    }
  }
  return {
    total,
    by_phrase,
    phrases_hit: Object.keys(by_phrase),
  };
}

/**
 * Empty-state density over rendered block texts for one card/surface.
 *
 * A block is empty-state when it matches an apology phrase, carries a known
 * empty-state class marker, or is an explainer-only note without a data fact.
 *
 * @param {{
 *   blocks?: Array<{ text?: string, className?: string, role?: string }>,
 *   text?: string,
 *   empty_blocks?: number,
 *   content_blocks?: number,
 * }} sample
 * @returns {{
 *   empty_blocks: number,
 *   content_blocks: number,
 *   total_blocks: number,
 *   empty_ratio: number,
 *   majority_empty: boolean,
 *   apology: ReturnType<typeof countApologyPhrases>,
 *   apology_repeat_breach: boolean,
 *   flagged: boolean,
 *   reasons: string[],
 * }}
 */
export function emptyStateDensity(sample = {}) {
  const blocks = Array.isArray(sample.blocks) ? sample.blocks : null;
  let empty_blocks = number(sample.empty_blocks);
  let content_blocks = number(sample.content_blocks);
  let fullText = String(sample.text || "");

  if (blocks) {
    empty_blocks = 0;
    content_blocks = 0;
    const texts = [];
    for (const block of blocks) {
      const text = String(block?.text || "").trim();
      if (!text) continue;
      texts.push(text);
      const cls = String(block?.className || block?.class || "").toLowerCase();
      const role = String(block?.role || "").toLowerCase();
      const apology = countApologyPhrases(text);
      const isEmptyClass = /\blc-norecord\b|\bempty\b|\bskel\b|\bnote\b/.test(cls)
        && (apology.total > 0 || role === "empty" || role === "explainer");
      const isApology = apology.total > 0;
      if (isEmptyClass || isApology || role === "empty" || role === "explainer") {
        empty_blocks += 1;
      } else {
        content_blocks += 1;
      }
    }
    fullText = texts.join("\n");
  }

  empty_blocks = empty_blocks == null ? 0 : empty_blocks;
  content_blocks = content_blocks == null ? 0 : content_blocks;
  const total_blocks = empty_blocks + content_blocks;
  const empty_ratio = total_blocks === 0 ? 0 : empty_blocks / total_blocks;
  const apology = countApologyPhrases(fullText);
  const majority_empty = total_blocks > 0 && empty_ratio > EMPTY_STATE_MAJORITY_THRESHOLD;
  const apology_repeat_breach = apology.total > EMPTY_STATE_APOLOGY_REPEAT_THRESHOLD;
  const reasons = [];
  if (majority_empty) {
    reasons.push(
      `majority empty-state blocks (${empty_blocks}/${total_blocks} = ${empty_ratio.toFixed(2)})`,
    );
  }
  if (apology_repeat_breach) {
    reasons.push(
      `apology phrases appear ${apology.total} times (threshold ${EMPTY_STATE_APOLOGY_REPEAT_THRESHOLD})`,
    );
  }
  return {
    empty_blocks,
    content_blocks,
    total_blocks,
    empty_ratio: Number(empty_ratio.toFixed(4)),
    majority_empty,
    apology,
    apology_repeat_breach,
    flagged: majority_empty || apology_repeat_breach,
    reasons,
  };
}

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

  // Empty-state / apology density (wackness): majority empty blocks or repeated apology copy.
  const density = emptyStateDensity({
    blocks: measured.empty_state_blocks,
    text: measured.visible_text || measured.text,
    empty_blocks: measured.empty_blocks,
    content_blocks: measured.content_blocks,
  });
  if (density.flagged) {
    breaches.push({
      kind: "empty-state-density",
      metric: density.majority_empty ? "empty_ratio" : "apology_phrase_hits",
      actual: density.majority_empty ? density.empty_ratio : density.apology.total,
      maximum: density.majority_empty
        ? EMPTY_STATE_MAJORITY_THRESHOLD
        : EMPTY_STATE_APOLOGY_REPEAT_THRESHOLD,
      empty_blocks: density.empty_blocks,
      content_blocks: density.content_blocks,
      apology_phrases: density.apology.phrases_hit,
      reasons: density.reasons,
    });
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
    empty_state_flags: 0,
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
    if (breaches.some((breach) => breach.kind === "empty-state-density")) {
      metrics.empty_state_flags += 1;
    }
    const actionFirst = breaches.some((breach) => breach.kind === "action-position");
    const emptyHeavy = breaches.some((breach) => breach.kind === "empty-state-density");
    const worstRatio = Math.max(1, ...breaches
      .filter((breach) => breach.actual != null && breach.maximum > 0)
      .map((breach) => breach.actual / breach.maximum));
    cards.push(makeDimensionCard({
      dimension: DIMENSION_ID,
      slug: `surface-${id}`,
      title: actionFirst
        ? `Restore an action-first opening on ${surface.label || id}`
        : emptyHeavy
          ? `Remove empty-state apology density on ${surface.label || id}`
          : `Reduce measured interface load on ${surface.label || id}`,
      rank_score: actionFirst ? 96 : emptyHeavy ? 94 : worstRatio >= 3 ? 92 : worstRatio >= 1.5 ? 84 : 72,
      evidence: {
        kind: emptyHeavy ? "empty-state-density" : "surface-load-regression",
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
        : emptyHeavy
          ? `The ${surface.label || id} surface renders data-bearing blocks only; empty subsections stay absent.`
          : `The ${surface.label || id} surface stays within its measured word, link, button, and repetition budgets.`,
      context: [
        "tools/sample_surface_load.py",
        "ontology/fixtures/dimensions/surface_load.json",
        surface.file || "site/index.html",
      ],
      lesson_class: actionFirst
        ? "action-first-surface"
        : emptyHeavy
          ? "empty-state-density"
          : "surface-load-budget",
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
