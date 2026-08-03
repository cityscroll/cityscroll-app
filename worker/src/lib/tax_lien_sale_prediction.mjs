// Prediction-contract emission for one BBL in a reconstructed tax-lien cycle.

import { buildPrediction } from "./prediction_contract.mjs";

function basis(model, bbl, method) {
  const borough = model.holdout.by_bbl[bbl]?.borough_code;
  const cohort = model.training.boroughs[borough]?.notice_90 || model.training.citywide.notice_90;
  return {
    method,
    n: cohort.denominator,
    train_from: model.training.train_from,
    train_to: model.training.train_to,
    cohort: `borough:${borough || "citywide"} · tax-lien 90-day→sale`,
    evidence_event_ids: model.training.cycle_ids.map((cycle) => `tax-lien-cycle:${cycle}`),
    statute_ref: null,
  };
}

export function emitTaxLienSalePrediction(model, bbl, options = {}) {
  const row = model?.holdout?.by_bbl?.[bbl];
  if (!row) throw new TypeError(`BBL ${bbl} is not on the holdout 90-day list`);
  const cohort = model.training.boroughs[row.borough_code]?.notice_90
    || model.training.citywide.notice_90;
  const saleDate = model.holdout.sale_date;
  if (!saleDate) throw new TypeError(`cycle ${model.holdout.cycle_id} has no announced sale date`);
  return buildPrediction({
    subject_ref: `property-bbl:${bbl}`,
    predicted_event_kind: "property.tax_lien_sold",
    claim: "occurrence",
    predicted_window: { p10: saleDate, p50: saleDate, p90: saleDate },
    probability: cohort.probability_reach_sale,
    basis: basis(model, bbl, "base_rate"),
    model_name: "tax_lien_sale_progression",
    model_version: model.model_version,
    generated_at: options.generated_at || model.generated_at,
    supersedes_prediction_id: null,
    status: options.status || "open",
    resolved_by_event_id: null,
  });
}

export function emitTaxLienSaleDatePrediction(model, bbl, options = {}) {
  const row = model?.holdout?.by_bbl?.[bbl];
  if (!row) throw new TypeError(`BBL ${bbl} is not on the holdout 90-day list`);
  const saleDate = model.holdout.sale_date;
  if (!saleDate) throw new TypeError(`cycle ${model.holdout.cycle_id} has no announced sale date`);
  return buildPrediction({
    subject_ref: `property-bbl:${bbl}`,
    predicted_event_kind: "property.tax_lien_sale_deadline",
    claim: "timing",
    predicted_window: { p10: saleDate, p50: saleDate, p90: saleDate },
    probability: 1,
    basis: basis(model, bbl, "statutory_clock"),
    model_name: "tax_lien_sale_progression",
    model_version: model.model_version,
    generated_at: options.generated_at || model.generated_at,
    supersedes_prediction_id: null,
    status: options.status || "open",
    resolved_by_event_id: null,
  });
}
