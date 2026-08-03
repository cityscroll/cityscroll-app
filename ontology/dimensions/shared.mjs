// Shared helpers for multi-dimension improvement flywheels.
// Pure card construction — no network, no production writes.

import { createHash } from "node:crypto";

export const MULTI_FLYWHEEL_POLICY_VERSION = "v0";
export const MULTI_CARD_SCHEMA = "cityscroll.multi_flywheel_card.v0";

export const DIMENSION_IDS = Object.freeze([
  "data-integrity",
  "readability",
  "ontology-enrichment",
  "coverage",
  "cross-source-consistency",
  "location-resolution",
  "surface-load",
]);

export function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function stableHash(parts) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

/**
 * @param {object} opts
 * @param {string} opts.dimension — one of DIMENSION_IDS
 * @param {string} opts.slug — stable id fragment (no spaces)
 * @param {string} opts.title
 * @param {number} opts.rank_score
 * @param {object} opts.evidence
 * @param {string} opts.verify — machine-checkable gate command/predicate
 * @param {string} opts.demo_win — what a fixed card unlocks for a reader
 * @param {string[]} [opts.context]
 * @param {string|null} [opts.needs_human]
 * @param {string} [opts.lesson_class] — recurring-class key for engineering-lessons
 */
export function makeDimensionCard({
  dimension,
  slug,
  title,
  rank_score,
  evidence,
  verify,
  demo_win,
  context = [],
  needs_human = null,
  lesson_class = null,
}) {
  if (!DIMENSION_IDS.includes(dimension)) {
    throw new TypeError(`unknown dimension: ${dimension}`);
  }
  const safeSlug = clean(slug).toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  if (!safeSlug) throw new TypeError("card slug is required");
  if (!clean(verify)) throw new TypeError("card verify predicate is required");
  if (!clean(demo_win)) throw new TypeError("card demo_win is required");

  const id = `crol-list/mf-${dimension}-${safeSlug}`;
  return {
    schema: MULTI_CARD_SCHEMA,
    id,
    title: clean(title),
    status: "proposed",
    dimension,
    rank_score: Number(rank_score) || 0,
    rank: null,
    emitted_by: "multi_flywheel",
    policy_version: MULTI_FLYWHEEL_POLICY_VERSION,
    evidence: evidence && typeof evidence === "object" ? evidence : {},
    context: (context || []).filter(Boolean),
    verify: clean(verify),
    demo_win: clean(demo_win),
    needs_human,
    lesson_class: lesson_class ? clean(lesson_class) : null,
    content_hash: stableHash({
      id,
      dimension,
      title: clean(title),
      evidence,
      verify: clean(verify),
    }),
  };
}

/** Stable rank: higher score first, then id. Mutates rank field. */
export function rankCards(cards, { limit = 50 } = {}) {
  const sorted = [...cards].sort(
    (a, b) => (b.rank_score - a.rank_score) || String(a.id).localeCompare(String(b.id)),
  );
  const capped = sorted.slice(0, limit);
  capped.forEach((card, index) => {
    card.rank = index + 1;
  });
  return capped;
}
