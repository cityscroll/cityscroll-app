/**
 * Shared join-gate policy for flywheel / frontier usefulness decisions.
 *
 * Prevents two measured false-negative modes:
 *   1. Gating with naive exact-id equality when the product already documents a
 *      stronger join (prefix, published crosswalk, strip-suffix, …).
 *   2. Computing usefulness against an unrelated whole-universe denominator
 *      instead of the joinable candidate rows for that edge.
 *
 * Callers still own measurement; this module only chooses which rate is the
 * gate headline and which strategies must be attempted.
 */

export const USEFULNESS_THRESHOLD = 0.3;
export const PRECISION_THRESHOLD = 0.95;

/** Product-documented identifier strategies that must be measured, not skipped. */
export const PRODUCT_IDENTIFIER_STRATEGIES = Object.freeze([
  "exact",
  "pin_strip_suffix",
  "pin_prefix_of_epin",
  "epin_prefix_of_pin",
  "exact_ulurp_token",
]);

/**
 * @typedef {object} RateRow
 * @property {number} joined
 * @property {number} total
 * @property {number} [rate]
 * @property {string} [role]  "gate" | "contrast" | "catalog_coverage"
 * @property {string} [label]
 */

/**
 * Pick the usefulness rate that should gate materialization.
 *
 * Prefer an explicit gate-role rate, else the best rate among product join
 * strategies, and never let a pure catalog-coverage contrast silence a
 * joinable-candidate rate that already clears the floor.
 *
 * @param {Record<string, RateRow>} rates
 * @param {{ usefulnessThreshold?: number }} [opts]
 */
export function selectUsefulnessGate(rates = {}, opts = {}) {
  const threshold = Number(opts.usefulnessThreshold ?? USEFULNESS_THRESHOLD);
  const entries = Object.entries(rates || {}).map(([id, row]) => {
    const joined = Number(row?.joined) || 0;
    const total = Number(row?.total) || 0;
    const rate = Number.isFinite(row?.rate)
      ? Number(row.rate)
      : (total > 0 ? joined / total : 0);
    return {
      id,
      joined,
      total,
      rate,
      role: row?.role || inferRateRole(id, row),
      label: row?.label || id,
      strategies: row?.strategies || row?.strategy || null,
    };
  });

  const gateCandidates = entries.filter((e) => e.role === "gate" && e.total > 0);
  const productCandidates = entries.filter(
    (e) => e.role !== "catalog_coverage" && e.total > 0,
  );
  const pool = gateCandidates.length ? gateCandidates : productCandidates;
  if (!pool.length) {
    return {
      ok: false,
      selected: null,
      threshold,
      reason: "no_joinable_denominator",
      entries,
    };
  }
  pool.sort((a, b) => b.rate - a.rate || b.joined - a.joined || a.id.localeCompare(b.id));
  const selected = pool[0];
  const contrast = entries.filter((e) => e.role === "catalog_coverage" || e.role === "contrast");
  return {
    ok: selected.rate >= threshold,
    selected,
    contrast,
    threshold,
    reason: selected.rate >= threshold
      ? "clears_usefulness_on_joinable_denominator"
      : "below_usefulness_on_joinable_denominator",
    entries,
  };
}

/**
 * Require that a measurement report includes every product strategy that
 * already ships for the same identifier family, or an explicit skip reason.
 *
 * @param {string[]} measuredStrategies
 * @param {string[]} requiredStrategies
 */
export function missingProductStrategies(
  measuredStrategies = [],
  requiredStrategies = PRODUCT_IDENTIFIER_STRATEGIES,
) {
  const have = new Set((measuredStrategies || []).map(String));
  return (requiredStrategies || []).filter((s) => !have.has(s));
}

/**
 * Combined usefulness + precision gate used by frontier materializers.
 *
 * @param {{ usefulness: number|null|undefined, precision: number|null|undefined, usefulnessThreshold?: number, precisionThreshold?: number }} input
 */
export function materializeDecision(input = {}) {
  const usefulnessThreshold = Number(input.usefulnessThreshold ?? USEFULNESS_THRESHOLD);
  const precisionThreshold = Number(input.precisionThreshold ?? PRECISION_THRESHOLD);
  const usefulness = Number(input.usefulness);
  const precision = Number(input.precision);
  const usefulnessOk = Number.isFinite(usefulness) && usefulness >= usefulnessThreshold;
  const precisionOk = Number.isFinite(precision) && precision >= precisionThreshold;
  return {
    materialize: usefulnessOk && precisionOk,
    usefulnessOk,
    precisionOk,
    usefulness: Number.isFinite(usefulness) ? usefulness : null,
    precision: Number.isFinite(precision) ? precision : null,
    usefulnessThreshold,
    precisionThreshold,
  };
}

function inferRateRole(id, row) {
  const text = `${id} ${row?.label || ""} ${row?.universe || ""}`.toLowerCase();
  if (
    /catalog|whole.?universe|zap.?ulurp.?numbered|all.?projects|citywide.?universe/.test(text)
  ) {
    return "catalog_coverage";
  }
  if (/contrast|fixed_sorted|legacy/.test(text)) return "contrast";
  if (
    /recommendation_rows|joinable|identifier_bearing|id.bearing|candidate|pin.bearing|prefix/.test(
      text,
    )
  ) {
    return "gate";
  }
  return "gate";
}

/**
 * ULURP recommendation re-gate: recommendation-row hit rate is the usefulness
 * denominator; ZAP-universe coverage is contrast-only catalog coverage.
 */
export function evaluateUlurpRecommendationGate(rates = {}) {
  const normalized = {
    recommendation_rows_hit_zap: {
      ...(rates.recommendation_rows_hit_zap || {}),
      role: "gate",
      label: "recommendation rows that hit a ZAP project",
    },
    pdf_rows_hit_zap: {
      ...(rates.pdf_rows_hit_zap || {}),
      role: "gate",
      label: "PDF rows that hit a ZAP project",
    },
    zap_ulurp_numbered_either: {
      ...(rates.zap_ulurp_numbered_either || {}),
      role: "catalog_coverage",
      label: "ZAP ulurp-numbered universe (catalog coverage, not join quality)",
    },
    zap_ulurp_numbered_recommendations: {
      ...(rates.zap_ulurp_numbered_recommendations || {}),
      role: "catalog_coverage",
    },
    zap_ulurp_numbered_pdfs: {
      ...(rates.zap_ulurp_numbered_pdfs || {}),
      role: "catalog_coverage",
    },
  };
  const decision = selectUsefulnessGate(normalized);
  // Exact ULURP token intersection is strict; precision is 1.0 by construction.
  const mat = materializeDecision({
    usefulness: decision.selected?.rate,
    precision: 1.0,
  });
  return {
    ...decision,
    precision: 1.0,
    precision_ok: true,
    materialize: decision.ok && mat.materialize,
    wrong_universe_note:
      "Property Disposition City Record notices are not ZAP ULURP projects and must not be used as a success metric.",
    verdict: decision.ok
      ? `Ship sparse Borough President recommendation panel: usefulness ${(decision.selected.rate * 100).toFixed(1)}% on ${decision.selected.id} (threshold ${(decision.threshold * 100).toFixed(0)}%). ZAP-universe catalog coverage remains contrast-only.`
      : `Stop: joinable-candidate usefulness below threshold on recommendation rows.`,
  };
}

/**
 * RC-1 plan→PASSPort gate helper: identifier-bearing denominator + product
 * prefix strategies.
 */
export function evaluateRc1PlanPassportGate(path = {}) {
  const usefulness = Number(path.rate);
  const precision = Number(path.precision);
  const measured = Object.keys(path.method_counts || {});
  // Map method_counts keys onto product strategy names.
  const strategyAliases = {
    deterministic_identifier: "exact",
    pin_prefix_of_epin: "pin_prefix_of_epin",
    epin_prefix_of_pin: "epin_prefix_of_pin",
    pin_strip_suffix: "pin_strip_suffix",
  };
  const measuredStrategies = measured.map((m) => strategyAliases[m] || m);
  const required = ["exact", "pin_prefix_of_epin", "epin_prefix_of_pin"];
  const missing = missingProductStrategies(
    [...measuredStrategies, ...(path.strategies_attempted || required)],
    required,
  );
  const mat = materializeDecision({ usefulness, precision });
  return {
    ...mat,
    sample_method: path.sample_method || null,
    method_counts: path.method_counts || {},
    missing_product_strategies: missing,
    ok: mat.materialize && missing.length === 0,
  };
}
