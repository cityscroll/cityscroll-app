// Digest selection funnel.
//
// The daily digest narrows a source query down to the items a subscriber is sent.
// When the run produces nothing, "0 items" on its own does not say WHERE the
// narrowing happened: an empty source read, a window that excluded everything, a
// delivery-authorization boundary, the per-watch seen watermark, content dedupe,
// or an empty durable owed set are all different incidents with different repairs.
//
// These counts are observability, never a gate. Nothing here decides whether a
// digest is built or sent; the stages only record how many candidates survived
// each step so a receipt can name the collapsing stage with numbers.

/** Ordered narrowing stages. Each entry counts the rows still alive after that step. */
export const FUNNEL_STAGES = Object.freeze([
  "source_candidates",
  "delivery_authorized",
  "lens_evaluated",
  "watermark_fresh",
  "content_deduped",
  "owed_drained",
  "items",
]);

/** Human-facing reason for each stage, used in receipts and redlines. */
export const FUNNEL_STAGE_REASONS = Object.freeze({
  source_candidates: "the source query returned no candidate rows",
  delivery_authorized: "the delivery-authorization boundary excluded every candidate",
  lens_evaluated: "lens stage evaluation excluded every candidate",
  watermark_fresh: "the per-watch seen watermark already contained every candidate",
  content_deduped: "content dedupe collapsed every candidate",
  owed_drained: "the durable owed set contributed nothing and nothing was fresh",
  items: "the rendered digest carried no items",
});

function count(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** A funnel with every stage present, so a receipt never has to guess a missing count. */
export function emptyFunnel() {
  return Object.fromEntries(FUNNEL_STAGES.map((stage) => [stage, 0]));
}

export function normalizeFunnel(funnel) {
  const out = emptyFunnel();
  for (const stage of FUNNEL_STAGES) out[stage] = count(funnel?.[stage]);
  return out;
}

/** Sum funnels across sections/digests into one run-level view. */
export function mergeFunnels(funnels = []) {
  const out = emptyFunnel();
  for (const funnel of funnels) {
    const normalized = normalizeFunnel(funnel);
    for (const stage of FUNNEL_STAGES) out[stage] += normalized[stage];
  }
  return out;
}

/**
 * The first stage where a non-empty candidate set became empty.
 *
 * Returns null when nothing collapsed — either items survived, or the source read
 * was empty to begin with (an empty source is a source incident, not a selection
 * collapse, and is reported as `source_candidates`).
 */
export function collapseStage(funnel) {
  const normalized = normalizeFunnel(funnel);
  if (normalized.items > 0) return null;
  if (normalized.source_candidates === 0) return "source_candidates";
  let previous = normalized.source_candidates;
  for (const stage of FUNNEL_STAGES.slice(1)) {
    const current = normalized[stage];
    if (previous > 0 && current === 0) return stage;
    previous = current;
  }
  return null;
}

/** Structured evidence for a receipt: the stage, its reason, and the surrounding counts. */
export function describeCollapse(funnel) {
  const normalized = normalizeFunnel(funnel);
  const stage = collapseStage(normalized);
  if (!stage) return null;
  const index = FUNNEL_STAGES.indexOf(stage);
  const priorStage = index > 0 ? FUNNEL_STAGES[index - 1] : null;
  return {
    stage,
    reason: FUNNEL_STAGE_REASONS[stage],
    entering_count: priorStage ? normalized[priorStage] : normalized.source_candidates,
    surviving_count: normalized[stage],
    funnel: normalized,
  };
}
