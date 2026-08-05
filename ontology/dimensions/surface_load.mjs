// Dimension: surface-load
// Measures rendered word/link/button load, verbatim duplication, whether a
// resident-serving action appears in the first viewport of principal surfaces,
// empty-state / apology density (wackness sampling), and Property list
// chip-format + default-view temporal honesty when those samples are present.

import { makeDimensionCard } from "./shared.mjs";
import {
  findCurrencyLeakedDateChips,
  findPastDeadlinesInDefaultView,
  findRepeatedIdenticalButtonActions,
  findTenseParityViolations,
} from "../../site/property_list_sanity.mjs";

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
 * Detect semantic facts repeated inside one rendered card. Renderers expose
 * stable `data-card-fact` keys so wording differences do not hide duplication.
 */
export function findDuplicateCardFacts(cards = []) {
  const findings = [];
  for (const [index, card] of (Array.isArray(cards) ? cards : []).entries()) {
    const card_id = String(card?.card_id || card?.id || `card-${index + 1}`);
    const grouped = new Map();
    for (const fact of (Array.isArray(card?.facts) ? card.facts : [])) {
      const key = String(fact?.key || "").trim().toLowerCase();
      if (!key) continue;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(String(fact?.text || "").trim());
    }
    for (const [key, texts] of grouped) {
      if (texts.length > 1) findings.push({ card_id, key, count: texts.length, texts });
    }
  }
  return { ok: findings.length === 0, findings };
}

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

  const duplicateFacts = findDuplicateCardFacts(measured.card_facts);
  if (!duplicateFacts.ok) {
    breaches.push({
      kind: "duplicate-card-fact",
      metric: "duplicate_card_facts",
      actual: duplicateFacts.findings.length,
      maximum: 0,
      findings: duplicateFacts.findings.slice(0, 8),
      reason: "one card presents the same semantic fact in more than one position",
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

  // Chip-format lint: currency symbol before a month name on close-date chips
  // ("closes $September …") — price-fact $ prefix leaked into the date template.
  const chipTexts = measured.chip_texts
    || measured.close_chips
    || measured.date_chips
    || null;
  const chipScanText = chipTexts
    || measured.visible_text
    || measured.text
    || "";
  if (chipScanText) {
    const chipLint = findCurrencyLeakedDateChips(chipTexts || chipScanText);
    if (!chipLint.ok) {
      breaches.push({
        kind: "chip-format-currency-before-month",
        metric: "currency_leaked_date_chips",
        actual: chipLint.findings.length,
        maximum: 0,
        findings: chipLint.findings.slice(0, 8),
        reason: "date chip renders a currency symbol before a month name",
      });
    }
  }

  // Default-view temporal sanity: open head of a default lens list must not
  // lead with past-dated deadlines/closes (Property #property default).
  const topCards = measured.default_view_top_cards
    || measured.top_cards
    || measured.list_top_cards
    || null;
  if (Array.isArray(topCards) && topCards.length) {
    const today = measured.today
      || surface.today
      || null;
    const temporal = findPastDeadlinesInDefaultView(topCards, {
      today,
      topN: measured.default_view_top_n || 10,
    });
    if (!temporal.ok) {
      breaches.push({
        kind: "default-view-past-deadline",
        metric: "past_closes_in_open_head",
        actual: temporal.findings.length,
        maximum: 0,
        findings: temporal.findings.slice(0, 8),
        reason: "default lens view open head carries past-dated close/deadline dates",
      });
    }
  }

  const tense = findTenseParityViolations(
    measured.visible_text || measured.text || "",
    {
      today: measured.today
        || measured.measured_at?.slice(0, 10)
        || surface.today
        || null,
    },
  );
  if (!tense.ok) {
    breaches.push({
      kind: "tense-parity-active-past",
      metric: "active_verb_past_date",
      actual: tense.findings.length,
      maximum: 0,
      findings: tense.findings.slice(0, 8),
      reason: "active-voice close/open/end verb appears with a date in the past",
    });
  }

  const repeatedCta = findRepeatedIdenticalButtonActions(
    (Array.isArray(measured.action_links) ? measured.action_links : []).map((button) => ({
      section: surface.id || "default",
      label: button.label || button.text || "",
      href: button.href || button.url || "",
      source: surface.id || "",
    })),
    {
      maxRepeats: 3,
    },
  );
  if (!repeatedCta.ok) {
    breaches.push({
      kind: "repeated-identical-cta",
      metric: "identical_button_actions",
      actual: repeatedCta.findings.length,
      maximum: 0,
      findings: repeatedCta.findings.slice(0, 8),
      reason: "one surface includes the same action more than three times",
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
    duplicate_fact_flags: 0,
    empty_state_flags: 0,
    chip_format_flags: 0,
    temporal_sanity_flags: 0,
    tense_parity_flags: 0,
    repeated_cta_flags: 0,
  };

  for (const surface of surfaces) {
    const id = slugify(surface.id || surface.surface);
    if (surface.status !== "ok") {
      metrics.surfaces_incomplete += 1;
      continue;
    }
    metrics.surfaces_complete += 1;
    if (inventory.measured_at && typeof surface.measured === "object" && surface.measured) {
      surface.measured.today = surface.measured.today || inventory.measured_at.slice(0, 10);
    }
    const breaches = surfaceLoadBreaches(surface);
    if (!breaches.length) continue;
    metrics.surfaces_over_budget += 1;
    if (breaches.some((breach) => breach.kind === "action-position")) {
      metrics.action_position_flags += 1;
    }
    if (breaches.some((breach) => breach.kind === "verbatim-duplication" || breach.kind === "duplicate-card-fact")) {
      metrics.duplication_flags += 1;
    }
    if (breaches.some((breach) => breach.kind === "duplicate-card-fact")) metrics.duplicate_fact_flags += 1;
    if (breaches.some((breach) => breach.kind === "empty-state-density")) {
      metrics.empty_state_flags += 1;
    }
    if (breaches.some((breach) => breach.kind === "chip-format-currency-before-month")) {
      metrics.chip_format_flags += 1;
    }
    if (breaches.some((breach) => breach.kind === "default-view-past-deadline")) {
      metrics.temporal_sanity_flags += 1;
    }
    if (breaches.some((breach) => breach.kind === "tense-parity-active-past")) {
      metrics.tense_parity_flags += 1;
    }
    if (breaches.some((breach) => breach.kind === "repeated-identical-cta")) {
      metrics.repeated_cta_flags += 1;
    }
    const actionFirst = breaches.some((breach) => breach.kind === "action-position");
    const emptyHeavy = breaches.some((breach) => breach.kind === "empty-state-density");
    const chipFormat = breaches.some((breach) => breach.kind === "chip-format-currency-before-month");
    const temporalBad = breaches.some((breach) => breach.kind === "default-view-past-deadline");
    const tenseBad = breaches.some((breach) => breach.kind === "tense-parity-active-past");
    const ctaBad = breaches.some((breach) => breach.kind === "repeated-identical-cta");
    const duplicateFact = breaches.some((breach) => breach.kind === "duplicate-card-fact");
    const worstRatio = Math.max(1, ...breaches
      .filter((breach) => breach.actual != null && breach.maximum > 0)
      .map((breach) => breach.actual / breach.maximum));
    cards.push(makeDimensionCard({
      dimension: DIMENSION_ID,
      slug: `surface-${id}`,
      title: actionFirst
        ? `Restore an action-first opening on ${surface.label || id}`
        : duplicateFact
          ? `Remove repeated card facts on ${surface.label || id}`
          : temporalBad
            ? `Keep past-dated closes out of the default open head on ${surface.label || id}`
            : tenseBad
              ? `Use past-tense status for closed dated entries on ${surface.label || id}`
              : ctaBad
                ? `Collapse repeated CTAs on ${surface.label || id}`
                : chipFormat
                  ? `Fix currency-leaked date chips on ${surface.label || id}`
                  : emptyHeavy
                    ? `Remove empty-state apology density on ${surface.label || id}`
                    : `Reduce measured interface load on ${surface.label || id}`,
      rank_score: actionFirst ? 96
        : duplicateFact ? 95
        : temporalBad ? 95
        : tenseBad ? 94
        : ctaBad ? 93
        : chipFormat ? 94
        : emptyHeavy ? 94
        : worstRatio >= 3 ? 92 : worstRatio >= 1.5 ? 84 : 72,
      evidence: {
        kind: temporalBad
          ? "default-view-past-deadline"
          : tenseBad
            ? "tense-parity-active-copy"
            : ctaBad
              ? "repeated-identical-cta"
              : duplicateFact
                ? "duplicate-card-fact"
                : chipFormat
                  ? "chip-format-date-currency"
                  : emptyHeavy
                    ? "empty-state-density"
                    : "surface-load-regression",
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
        : duplicateFact
          ? `Each card on ${surface.label || id} presents each semantic fact once, in its strongest position.`
        : temporalBad
          ? `The ${surface.label || id} default open head shows only upcoming/current closes; past sales sit under a closed archive section.`
          : tenseBad
            ? `The ${surface.label || id} surface should use past tense for entries dated in the past.`
            : ctaBad
              ? `The ${surface.label || id} surface should use one shared CTA instead of repeated identical buttons.`
              : chipFormat
                ? `Date chips on ${surface.label || id} render as dates (no currency symbol before month names); price chips keep $ only on amounts.`
                : emptyHeavy
                  ? `The ${surface.label || id} surface renders data-bearing blocks only; empty subsections stay absent.`
                  : `The ${surface.label || id} surface stays within its measured word, link, button, and repetition budgets.`,
      context: [
        "tools/sample_surface_load.py",
        "ontology/fixtures/dimensions/surface_load.json",
        "site/property_list_sanity.mjs",
        surface.file || "site/index.html",
      ],
      lesson_class: actionFirst
        ? "action-first-surface"
        : duplicateFact
          ? "duplicate-card-fact"
        : temporalBad
          ? "default-view-temporal-sanity"
          : tenseBad
            ? "tense-parity-active-copy"
            : ctaBad
              ? "repeated-identical-cta"
              : chipFormat
                ? "chip-format-date-currency"
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
