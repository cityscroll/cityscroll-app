// Forecast accuracy scoring: compare fc:* renewal forecasts in ALERT_STATE
// against actual Solicitation notices in the D1 mirror.
//
// A "hit" is a prediction whose ±WINDOW_DAYS window around its predicted date
// contains a Solicitation notice from the same agency (stem match) or sharing a
// PIN prefix. We don't claim causal proof — the label is "matched", not "caused".
//
// After the prediction-contract retrofit, rows may carry cityscroll.prediction.v0
// fields. Collection and hit_rate still use the product fuzzy Solicitation join
// (legacy contract accuracy). When a row converts to a full assertion, resolution
// also runs through resolvePredictions for status lifecycle (open → hit/miss) on
// exact (subject_ref, event_kind) joins when callers supply realized events.
//
// Exported surface:
//   scoreForecastAccuracy(env, db) → { scored, hits, hit_rate, window_days, note }
//
// The handler (GET /forecast/accuracy) caches the result in KV for ~6 hours to
// avoid hammering D1 on every request; the KV key is "forecast_accuracy_cache".

import { resolvePredictions } from "./prediction_contract.mjs";
import {
  forecastPredictedDate,
  forecastRecordToPrediction,
} from "./contract_forecast_predictions.mjs";

export const WINDOW_DAYS = 30; // ±30 days around predicted date
const EARLY_SAMPLE = 20;       // below this we add the small-sample note

// Given a YYYY-MM-DD date and ±window, returns [loISO, hiISO].
export function predictionWindow(predictedDate, windowDays = WINDOW_DAYS) {
  const ms = windowDays * 86400_000;
  const base = new Date(predictedDate + "T00:00:00Z").getTime();
  if (!isFinite(base)) return [null, null];
  const lo = new Date(base - ms).toISOString().slice(0, 10);
  const hi = new Date(base + ms).toISOString().slice(0, 10);
  return [lo, hi];
}

// Normalise an agency name to a short stem for fuzzy matching:
// upper-case, strip punctuation, take the first two words.
// "NYC Department of Design and Construction" → "NYC DEPARTMENT"
// Keeps it coarse so minor name variations across datasets still match.
export function agencyStem(name) {
  if (!name) return "";
  return String(name)
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 2)
    .join(" ");
}

// PIN prefix: first 4 chars (enough to match agency + fiscal year, not individual lot).
export function pinPrefix(pin) {
  return pin ? String(pin).slice(0, 4) : "";
}

// Check whether a single prediction has a matching Solicitation notice in D1.
// prediction: { predicted_date, expiration_date, predicted_window, agency_name?, pin?, vendor_name? }
// db: D1 database binding.
// Returns true if a Solicitation was published inside the ±WINDOW window.
export async function checkPredictionHit(prediction, db) {
  const rawDate = forecastPredictedDate(prediction);

  if (!rawDate) return false;
  const [lo, hi] = predictionWindow(rawDate, WINDOW_DAYS);
  if (!lo) return false;

  // Agency stem match — a Solicitation from the same agency within the window
  const agency = prediction.agency_name || prediction.agency || "";
  const stem = agencyStem(agency);

  if (stem.length >= 3) {
    const stemPat = stem.split(" ")[0]; // first word keeps it broad
    const r = await db
      .prepare(
        `SELECT request_id FROM notices
         WHERE type_of_notice = 'Solicitation'
           AND start_date >= ? AND start_date <= ?
           AND upper(agency) LIKE ?
         LIMIT 1`,
      )
      .bind(lo, hi, "%" + stemPat + "%")
      .first();
    if (r) return true;
  }

  // PIN prefix match as a secondary signal
  const pin = prediction.pin || "";
  if (pin.length >= 4) {
    const prefix = pinPrefix(pin);
    const r = await db
      .prepare(
        `SELECT request_id FROM notices
         WHERE type_of_notice = 'Solicitation'
           AND start_date >= ? AND start_date <= ?
           AND pin IS NOT NULL AND pin LIKE ?
         LIMIT 1`,
      )
      .bind(lo, hi, prefix + "%")
      .first();
    if (r) return true;
  }

  return false;
}

// Collect all fc:* renewal forecasts from ALERT_STATE.
// Returns an array of raw prediction objects.
export async function collectPredictions(kv) {
  const predictions = [];
  try {
    const fcList = await kv.list({ prefix: "fc:" });
    for (const key of fcList.keys || []) {
      // Skip sentinel keys that aren't forecast arrays (e.g. "fc:sent:…")
      if (!key.name.match(/^fc:[A-Z]/)) continue;
      try {
        const raw = await kv.get(key.name);
        if (!raw) continue;
        const list = JSON.parse(raw);
        if (Array.isArray(list)) predictions.push(...list);
      } catch { /* skip malformed entry */ }
    }
  } catch { /* KV unavailable → empty */ }
  return predictions;
}

// Filter to predictions whose window has already closed (predicted_date + WINDOW_DAYS < today).
// We only score predictions we can already observe — future windows aren't scoreable yet.
export function pastWindowPredictions(predictions, todayISO) {
  return predictions.filter((p) => {
    const rawDate = forecastPredictedDate(p);
    if (!rawDate) return false;
    const [, hi] = predictionWindow(rawDate, WINDOW_DAYS);
    return hi != null && hi < todayISO;
  });
}

/**
 * Convert retrofitted (or legacy) fc rows through the prediction contract and
 * resolve open assertions against realized civic events via resolvePredictions.
 * Product hit_rate scoring continues to use the fuzzy Solicitation path above;
 * this path is the generic contract resolver for status lifecycle.
 */
export function resolveForecastPredictions(forecastRows = [], realizedEvents = [], opts = {}) {
  const assertions = [];
  for (const row of (Array.isArray(forecastRows) ? forecastRows : [])) {
    try {
      assertions.push(forecastRecordToPrediction(row, opts));
    } catch {
      // Skip rows that cannot form a valid assertion (incomplete legacy).
    }
  }
  return resolvePredictions(assertions, realizedEvents, {
    graceDays: opts.graceDays ?? WINDOW_DAYS,
    now: opts.now,
    horizonDaysByDomain: opts.horizonDaysByDomain,
  });
}

// Main scoring function.
// env: Worker env with ALERT_STATE (KV) bound.
// db: D1 database binding.
// todayISO: "YYYY-MM-DD" (default: today).
// Returns { scored, hits, hit_rate, window_days, note }.
export async function scoreForecastAccuracy(env, db, todayISO) {
  const today = todayISO || new Date().toISOString().slice(0, 10);
  const allPredictions = await collectPredictions(env.ALERT_STATE);
  const scoreable = pastWindowPredictions(allPredictions, today);

  let hits = 0;
  for (const p of scoreable) {
    if (await checkPredictionHit(p, db)) hits++;
  }

  const scored = scoreable.length;
  const hit_rate = scored > 0 ? Math.round((hits / scored) * 1000) / 1000 : null;

  const note = scored < EARLY_SAMPLE
    ? `early — n=${scored} too small to be meaningful`
    : null;

  return { scored, hits, hit_rate, window_days: WINDOW_DAYS, note };
}
