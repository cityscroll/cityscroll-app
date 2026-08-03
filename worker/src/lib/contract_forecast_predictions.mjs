/**
 * Retrofit Checkbook contract-renewal forecasts (fc:*) into cityscroll.prediction.v0.
 *
 * Product fields (contract_id, expiration_date, warning_date, source, …) stay on the
 * legacy record so GET /forecast, vendor profiles, and matchForecasts keep working.
 * Provenance (prediction_id, model_*, basis, status, …) is stamped in place.
 *
 * Digest delivery stays single-fire on warning_date with the historical sent key
 * `sent:fc:<contract_id>:<sub_key>` — that fire is the product "approaching" band.
 */

import { buildPrediction, validatePrediction, predictionBand } from "./prediction_contract.mjs";

export const CONTRACT_RENEWAL_MODEL_NAME = "contract_renewal_term";
export const CONTRACT_RENEWAL_MODEL_VERSION = "1.0.0";
export const CONTRACT_RENEWAL_PREDICTED_EVENT_KIND = "procurement.notice_published";
export const CONTRACT_RENEWAL_COHORT = "checkbook.contract_term · renewal";
/** Historical product delivery: warning_date is 180 days before expiration. */
export const CONTRACT_RENEWAL_WARNING_LEAD_DAYS = 180;

/**
 * Stable digest de-dup identity (the part after `sent:`).
 * MUST remain `fc:<contract_id>:<sub_key>` for already-delivered forecasts.
 */
export function forecastSentIdentity(contractId, subKey) {
  const id = String(contractId ?? "").trim();
  const key = String(subKey ?? "").trim();
  if (!id || !key) throw new TypeError("forecastSentIdentity requires contract_id and sub_key");
  return `fc:${id}:${key}`;
}

/** Full ALERT_STATE key used by matchForecasts. */
export function forecastSentKvKey(contractId, subKey) {
  return `sent:${forecastSentIdentity(contractId, subKey)}`;
}

function isoDay(value) {
  const day = String(value || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const parsed = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) return null;
  return day;
}

function pointWindow(day) {
  return { p10: day, p50: day, p90: day };
}

function evidenceIds(row = {}) {
  const ids = [];
  const contractId = String(row.contract_id || "").trim();
  if (contractId) ids.push(`checkbook:contract:${contractId}`);
  const pin = String(row.pin || "").trim();
  if (pin) ids.push(`checkbook:pin:${pin}`);
  const registration = isoDay(row.registration_date);
  if (registration && contractId) {
    ids.push(`checkbook:registration:${contractId}:${registration}`);
  }
  if (!ids.length) ids.push("checkbook:contract:unknown");
  return ids;
}

function subjectRefFor(row = {}) {
  const contractId = String(row.contract_id || "").trim();
  if (!contractId) throw new TypeError("contract forecast requires contract_id");
  return `contract:${contractId}`;
}

/**
 * Build a validated cityscroll.prediction.v0 assertion from a Checkbook forecast row.
 * predicted_window is the term-arithmetic expiration (point window p10=p50=p90).
 */
export function buildContractRenewalPrediction(row = {}, opts = {}) {
  const expiration = isoDay(row.expiration_date || row.predicted_date);
  if (!expiration) throw new TypeError("contract forecast requires expiration_date");
  const registration = isoDay(row.registration_date) || expiration;
  const generatedAt = opts.generatedAt
    || (typeof row.generated_at === "string" && row.generated_at.includes("T")
      ? row.generated_at
      : `${registration}T00:00:00Z`);
  const status = ["open", "resolved_hit", "resolved_miss", "expired", "withdrawn"].includes(row.status)
    ? row.status
    : "open";
  const resolvedBy = status === "resolved_hit" || status === "resolved_miss"
    ? (row.resolved_by_event_id || null)
    : null;
  if ((status === "resolved_hit" || status === "resolved_miss") && !resolvedBy) {
    throw new TypeError(`${status} contract forecast requires resolved_by_event_id`);
  }

  return buildPrediction({
    subject_ref: subjectRefFor(row),
    predicted_event_kind: CONTRACT_RENEWAL_PREDICTED_EVENT_KIND,
    claim: "timing",
    predicted_window: pointWindow(expiration),
    probability: 1,
    basis: {
      method: "term_arithmetic",
      n: 1,
      train_from: registration,
      train_to: registration,
      cohort: CONTRACT_RENEWAL_COHORT,
      evidence_event_ids: evidenceIds(row),
      statute_ref: null,
    },
    model_name: CONTRACT_RENEWAL_MODEL_NAME,
    model_version: CONTRACT_RENEWAL_MODEL_VERSION,
    generated_at: generatedAt,
    supersedes_prediction_id: null,
    status,
    resolved_by_event_id: resolvedBy,
  });
}

/**
 * Stamp prediction-contract provenance onto a legacy fc:* row without removing
 * consumer fields. Returns a new object.
 */
export function enrichForecastWithPrediction(row = {}, opts = {}) {
  if (!row || typeof row !== "object") return row;
  const expiration = isoDay(row.expiration_date || row.predicted_date);
  if (!expiration || !String(row.contract_id || "").trim()) {
    // Incomplete row — leave untouched so pipeline fail-soft stays as-is.
    return { ...row };
  }
  const assertion = buildContractRenewalPrediction(row, opts);
  return {
    ...row,
    prediction_id: assertion.prediction_id,
    model_name: assertion.model_name,
    model_version: assertion.model_version,
    basis: assertion.basis,
    status: assertion.status,
    subject_ref: assertion.subject_ref,
    predicted_event_kind: assertion.predicted_event_kind,
    claim: assertion.claim,
    predicted_window: assertion.predicted_window,
    probability: assertion.probability,
    generated_at: assertion.generated_at,
    supersedes_prediction_id: assertion.supersedes_prediction_id,
    resolved_by_event_id: assertion.resolved_by_event_id,
    schema_version: assertion.schema_version,
  };
}

/**
 * Convert a stored fc:* row (legacy or retrofitted) into a validated prediction
 * assertion for scoring / store adapters.
 */
export function forecastRecordToPrediction(row = {}, opts = {}) {
  if (row?.prediction_id && row?.basis?.method === "term_arithmetic" && row?.predicted_window) {
    try {
      return validatePrediction({
        schema_version: row.schema_version ?? 1,
        prediction_id: row.prediction_id,
        subject_ref: row.subject_ref || subjectRefFor(row),
        predicted_event_kind: row.predicted_event_kind || CONTRACT_RENEWAL_PREDICTED_EVENT_KIND,
        claim: row.claim || "timing",
        predicted_window: row.predicted_window,
        probability: typeof row.probability === "number" ? row.probability : 1,
        basis: row.basis,
        model_name: row.model_name || CONTRACT_RENEWAL_MODEL_NAME,
        model_version: row.model_version || CONTRACT_RENEWAL_MODEL_VERSION,
        generated_at: row.generated_at || `${isoDay(row.registration_date) || isoDay(row.expiration_date)}T00:00:00Z`,
        supersedes_prediction_id: row.supersedes_prediction_id ?? null,
        status: row.status || "open",
        resolved_by_event_id: row.resolved_by_event_id ?? null,
      });
    } catch {
      // Fall through to rebuild from product dates.
    }
  }
  return buildContractRenewalPrediction(row, opts);
}

/** Predicted date used by the accuracy loop (expiration / p50). */
export function forecastPredictedDate(row = {}) {
  return isoDay(row.predicted_date)
    || isoDay(row.predicted_window?.p50)
    || isoDay(row.expiration_date)
    || isoDay(row.warning_date);
}

/**
 * Whether matchForecasts should fire today.
 * Product rule remains warning_date === today (approaching-band single fire).
 */
export function forecastIsDeliverableOn(row, today) {
  const day = isoDay(today);
  if (!day) return false;
  return isoDay(row?.warning_date) === day;
}

/**
 * Ontology band label for a retrofitted open forecast (informational).
 * warning_date fire corresponds to the historical approaching delivery.
 */
export function forecastProductBand(row, opts = {}) {
  try {
    const assertion = forecastRecordToPrediction(row, opts);
    return predictionBand(assertion, opts);
  } catch {
    return null;
  }
}

export const CADENCE_MODEL_NAME = "award_cadence";
export const CADENCE_MODEL_VERSION = "1.0.0";

/**
 * Provenance block for client-side next-award cadence values.
 * Pure data — renderers must not change copy when this is present.
 */
export function cadenceProvenance(est = {}) {
  const n = Number.isSafeInteger(est.count) ? est.count : 0;
  const nextDay = est.nextDate instanceof Date && Number.isFinite(est.nextDate.getTime())
    ? est.nextDate.toISOString().slice(0, 10)
    : isoDay(est.nextDate);
  return {
    method: "cadence",
    model_name: CADENCE_MODEL_NAME,
    model_version: CADENCE_MODEL_VERSION,
    n,
    next_date: nextDay,
    predicted_event_kind: CONTRACT_RENEWAL_PREDICTED_EVENT_KIND,
  };
}
