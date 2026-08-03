/**
 * Client-side view helpers for property disposition-timing estimates.
 *
 * Consumes the precomputed model at site/data/property_disposition_timing_model.json
 * (batch-built by tools/build_property_disposition_timing.mjs). No per-request
 * inference — only pattern-attribution copy over stored cohort quantiles.
 */

export const PROPERTY_DISPOSITION_TIMING_MODEL_PATH =
  "data/property_disposition_timing_model.json";

function clean(value) {
  if (value == null) return null;
  const s = String(value).replace(/\s+/g, " ").trim();
  return s || null;
}

/**
 * Pattern-attribution line (weeks). Cohort-only when public_projection is not per-matter.
 */
export function dispositionTimingPatternLine(citywide, options = {}) {
  if (!citywide || !citywide.n) return null;
  const n = citywide.n;
  const year = citywide.since_year || "2013";
  const w1 = citywide.middle_half_low_weeks ?? citywide.p10_weeks;
  const w2 = citywide.middle_half_high_weeks ?? citywide.p90_weeks;
  if (w1 == null || w2 == null) return null;
  const pairKind = citywide.pair_kind || options.pairKind || "auction_notice_to_event";
  if (pairKind === "multi_stage_hearing_to_auction") {
    return `Predicted based on ${n} dispositions since ${year} — auctions typically follow the hearing by ${w1}–${w2} weeks.`;
  }
  return `Predicted based on ${n} Property Disposition auction notices since ${year} — when a sale date is published, it typically falls ${w1}–${w2} weeks after the auction notice.`;
}

/**
 * Attach disposition_timing_estimate when hearing is matched and auction is not.
 * Never invents a per-matter date when the model is cohort_statistic_only.
 */
export function attachDispositionTimingEstimate(phaseView, model) {
  if (!phaseView || !model?.citywide) return phaseView;
  const hearing = (phaseView.phases || []).find((p) => p.id === "hearing");
  const auction = (phaseView.phases || []).find((p) => p.id === "auction_or_rfp");
  if (!hearing?.matched || auction?.matched) return phaseView;
  const citywide = {
    ...model.citywide,
    pair_kind: model.citywide.pair_kind || model.corpus?.primary_pair_kind,
  };
  const pattern_line = dispositionTimingPatternLine(citywide);
  if (!pattern_line) return phaseView;
  return {
    ...phaseView,
    disposition_timing_estimate: {
      kind: "cohort_statistic",
      after_phase: "hearing",
      target_phase: "auction_or_rfp",
      chip: "Estimate",
      register: "estimate",
      public_projection: model.public_projection || "cohort_statistic_only",
      predicted_window: null,
      pattern_line,
      n: citywide.n,
      since_year: citywide.since_year,
      weeks_low: citywide.middle_half_low_weeks ?? citywide.p10_weeks,
      weeks_high: citywide.middle_half_high_weeks ?? citywide.p90_weeks,
      pair_kind: citywide.pair_kind,
      corpus_note: clean(model.corpus?.note),
    },
  };
}
