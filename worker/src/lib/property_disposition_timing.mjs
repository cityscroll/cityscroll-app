/**
 * Property disposition timing — phase_duration_ecdf over City Record history.
 *
 * Intended multi-stage lag: hearing → auction_or_rfp (parcel-joined spines).
 * The Property Disposition section is small (~243 notices) and almost never
 * co-locates hearing + auction on the same BBL, so multi-stage n is typically
 * near zero. A secondary descriptive cohort measures auction-notice publication
 * → scheduled event_date among auction notices that publish a date.
 *
 * Ship bar: shared prediction calibration scorecard. Below bar, public surface
 * is cohort_statistic_only (no per-matter predicted dates).
 */

import {
  classifyDispositionStage,
  groupDispositionSpines,
  STAGE_AUCTION_OR_RFP,
  STAGE_HEARING,
} from "./property_disposition_spine.mjs";
import { evaluatePredictionBacktest } from "./prediction_calibration.mjs";
import { buildPrediction } from "./prediction_contract.mjs";

export const PROPERTY_DISPOSITION_MODEL_NAME = "property_disposition_timing";
export const PROPERTY_DISPOSITION_MODEL_VERSION = "1.0.0";
export const PROPERTY_DISPOSITION_METHOD = "phase_duration_ecdf";
export const PROPERTY_DISPOSITION_OPEN_KIND = "property.disposition_hearing";
export const PROPERTY_DISPOSITION_TARGET_KIND = "property.auction_or_rfp";
export const PROPERTY_DISPOSITION_COHORT_FLOOR = 20;
export const PROPERTY_DISPOSITION_BACKTEST_SPLIT = "2025-01-01";
export const PROPERTY_DISPOSITION_MAX_LAG_DAYS = 730;

const DAY_MS = 86_400_000;

function day(value) {
  const raw = String(value || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const parsed = Date.parse(`${raw}T00:00:00Z`);
  return Number.isFinite(parsed) ? raw : null;
}

function addDays(value, days) {
  return new Date(Date.parse(`${value}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function gapDays(from, to) {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS,
  );
}

function daysToWeeks(days) {
  if (days == null || !Number.isFinite(days)) return null;
  return Math.max(1, Math.round(days / 7));
}

/** Nearest-rank empirical quantile (inverse ECDF). */
export function empiricalQuantile(values = [], probability) {
  if (!values.length) return null;
  if (!(probability >= 0 && probability <= 1)) {
    throw new TypeError("probability must be in [0,1]");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(probability * sorted.length));
  return sorted[Math.min(sorted.length - 1, rank - 1)];
}

function agencyKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Parcel-joined multi-stage pairs: hearing event date → first later auction.
 * Prefer event.time.value on each matched stage.
 */
export function buildMultiStageHearingAuctionPairs(spines = []) {
  const pairs = [];
  for (const spine of spines || []) {
    const hearingStage = (spine.stages || []).find(
      (s) => s.kind === STAGE_HEARING && s.matched,
    );
    const auctionStage = (spine.stages || []).find(
      (s) => s.kind === STAGE_AUCTION_OR_RFP && s.matched,
    );
    if (!hearingStage || !auctionStage) continue;
    const hearingDates = (hearingStage.events || [])
      .map((e) => day(e.time?.value))
      .filter(Boolean)
      .sort();
    const auctionDates = (auctionStage.events || [])
      .map((e) => day(e.time?.value))
      .filter(Boolean)
      .sort();
    if (!hearingDates.length || !auctionDates.length) continue;
    const hearingDate = hearingDates[0];
    const auctionDate = auctionDates.find((d) => d > hearingDate) || null;
    if (!auctionDate) continue;
    const lag = gapDays(hearingDate, auctionDate);
    if (lag < 0 || lag > PROPERTY_DISPOSITION_MAX_LAG_DAYS) continue;
    const subject = spine.subject_ref || "disposition:unknown";
    pairs.push({
      kind: "multi_stage_hearing_to_auction",
      subject_ref: subject,
      agency: spine.join?.agency || null,
      hearing_date: hearingDate,
      auction_date: auctionDate,
      lag_days: lag,
      evidence_event_id: `cte:property-auction:${subject}:${auctionDate}`,
      open_event_id: `cte:property-hearing:${subject}:${hearingDate}`,
    });
  }
  return pairs.sort(
    (a, b) => a.auction_date.localeCompare(b.auction_date)
      || a.subject_ref.localeCompare(b.subject_ref),
  );
}

/**
 * Within-notice auction scheduling lag: publication start_date → event_date.
 * Descriptive cohort when multi-stage joins are empty. Not a hearing→auction chain.
 */
export function buildAuctionSchedulePairs(notices = []) {
  const pairs = [];
  for (const row of notices || []) {
    const stage = row.disposition_stage || classifyDispositionStage(row);
    if (stage !== STAGE_AUCTION_OR_RFP) continue;
    const published = day(row.start_date);
    const scheduled = day(row.event_date);
    if (!published || !scheduled) continue;
    const lag = gapDays(published, scheduled);
    if (lag < 0 || lag > 365) continue;
    const id = String(row.request_id || "").trim();
    if (!id) continue;
    pairs.push({
      kind: "auction_notice_to_event",
      subject_ref: `notice:${id}`,
      agency: row.agency_name || null,
      hearing_date: published, // anchor = notice publication
      auction_date: scheduled,
      lag_days: lag,
      evidence_event_id: `cte:property-auction-event:${id}:${scheduled}`,
      open_event_id: `cte:property-auction-pub:${id}:${published}`,
      request_id: id,
    });
  }
  return pairs.sort(
    (a, b) => a.auction_date.localeCompare(b.auction_date)
      || a.subject_ref.localeCompare(b.subject_ref),
  );
}

function cohortSummary(key, members, floor) {
  const lags = members.map((p) => p.lag_days);
  const trainFrom = members.map((p) => p.hearing_date).sort()[0] || null;
  const trainTo = members.map((p) => p.auction_date).sort().at(-1) || null;
  return {
    key,
    label: key === "citywide" ? "citywide" : key,
    n: members.length,
    eligible: key === "citywide" || members.length >= floor,
    p10_days: empiricalQuantile(lags, 0.1),
    p25_days: empiricalQuantile(lags, 0.25),
    p50_days: empiricalQuantile(lags, 0.5),
    p75_days: empiricalQuantile(lags, 0.75),
    p90_days: empiricalQuantile(lags, 0.9),
    p10_weeks: daysToWeeks(empiricalQuantile(lags, 0.1)),
    p50_weeks: daysToWeeks(empiricalQuantile(lags, 0.5)),
    p90_weeks: daysToWeeks(empiricalQuantile(lags, 0.9)),
    middle_half_low_weeks: daysToWeeks(empiricalQuantile(lags, 0.25)),
    middle_half_high_weeks: daysToWeeks(empiricalQuantile(lags, 0.75)),
    train_from: trainFrom,
    train_to: trainTo,
  };
}

export function buildDispositionLagModel(pairs = [], options = {}) {
  const floor = options.cohortFloor ?? PROPERTY_DISPOSITION_COHORT_FLOOR;
  const byAgency = new Map();
  for (const pair of pairs) {
    const key = agencyKey(pair.agency) || "_unknown";
    if (!byAgency.has(key)) byAgency.set(key, []);
    byAgency.get(key).push(pair);
  }
  const members = { citywide: [...pairs] };
  for (const [key, rows] of byAgency) {
    if (key !== "_unknown") members[`agency:${key}`] = rows;
  }
  const cohorts = Object.fromEntries(
    Object.entries(members).map(([key, rows]) => [key, cohortSummary(key, rows, floor)]),
  );
  return { floor, pairs: [...pairs], members, cohorts };
}

export function selectDispositionCohort(agency, model) {
  const key = `agency:${agencyKey(agency)}`;
  if (model.cohorts[key]?.eligible) return key;
  return "citywide";
}

function predictionFor(pair, model, cohortKey, generatedAt, basisWindow = null) {
  const cohort = model.cohorts[cohortKey];
  if (!cohort || cohort.p10_days == null) return null;
  const anchor = day(pair.hearing_date);
  if (!anchor) return null;
  return buildPrediction({
    subject_ref: pair.subject_ref,
    predicted_event_kind: PROPERTY_DISPOSITION_TARGET_KIND,
    claim: "timing",
    predicted_window: {
      p10: addDays(anchor, cohort.p10_days),
      p50: addDays(anchor, cohort.p50_days),
      p90: addDays(anchor, cohort.p90_days),
    },
    probability: 0.8,
    basis: {
      method: PROPERTY_DISPOSITION_METHOD,
      n: cohort.n,
      train_from: basisWindow?.train_from || cohort.train_from,
      train_to: basisWindow?.train_to || cohort.train_to,
      cohort: `property:${cohortKey} · hearing→auction_or_rfp`,
      evidence_event_ids: (model.members[cohortKey] || []).map((p) => p.evidence_event_id),
      statute_ref: null,
    },
    model_name: PROPERTY_DISPOSITION_MODEL_NAME,
    model_version: PROPERTY_DISPOSITION_MODEL_VERSION,
    generated_at: generatedAt,
    supersedes_prediction_id: null,
    status: "open",
    resolved_by_event_id: null,
  });
}

function emptyScorecard(note) {
  return {
    metric: "prediction_calibration",
    domain: "property",
    model_name: PROPERTY_DISPOSITION_MODEL_NAME,
    model_version: PROPERTY_DISPOSITION_MODEL_VERSION,
    split_date: PROPERTY_DISPOSITION_BACKTEST_SPLIT,
    resolved_backtest_predictions: 0,
    interval_coverage: null,
    occurrence_quintiles_monotone: null,
    ship_bar: {
      status: "fail",
      checks: {
        minimum_resolved: false,
        interval_coverage: false,
        occurrence_quintiles_monotone: true,
      },
      thresholds: {
        minimum_resolved: 50,
        interval_nominal: 0.8,
        interval_tolerance: 0.1,
        occurrence_quintiles_monotone: true,
      },
    },
    public_projection: "cohort_statistic_only",
    note,
  };
}

/**
 * Strict out-of-time backtest on multi-stage hearing→auction pairs.
 * With n≈0–few pairs the ship bar fails by design → cohort_statistic_only.
 */
export function buildDispositionTimingBacktest(multiStagePairs = []) {
  const splitDate = PROPERTY_DISPOSITION_BACKTEST_SPLIT;
  const training = multiStagePairs.filter((p) => p.auction_date < splitDate);
  const scoring = multiStagePairs.filter(
    (p) => p.hearing_date < splitDate && p.auction_date >= splitDate,
  );
  if (!training.length || !scoring.length) {
    return {
      backtest: null,
      scorecard: emptyScorecard(
        "Property Disposition multi-stage hearing→auction pairs are too few "
        + "for a resolved backtest (parcel joins across stages are rare in this section).",
      ),
      training_pairs: training.length,
      scoring_pairs: scoring.length,
    };
  }
  const model = buildDispositionLagModel(training);
  const events = [
    ...training.flatMap((p) => [
      {
        event_id: p.open_event_id,
        subject_ref: p.subject_ref,
        event_kind: PROPERTY_DISPOSITION_OPEN_KIND,
        valid_at: p.hearing_date,
      },
      {
        event_id: p.evidence_event_id,
        subject_ref: p.subject_ref,
        event_kind: PROPERTY_DISPOSITION_TARGET_KIND,
        valid_at: p.auction_date,
      },
    ]),
    ...scoring.flatMap((p) => [
      {
        event_id: p.open_event_id,
        subject_ref: p.subject_ref,
        event_kind: PROPERTY_DISPOSITION_OPEN_KIND,
        valid_at: p.hearing_date,
      },
      {
        event_id: p.evidence_event_id,
        subject_ref: p.subject_ref,
        event_kind: PROPERTY_DISPOSITION_TARGET_KIND,
        valid_at: p.auction_date,
      },
    ]),
  ];
  // Dedupe event_ids
  const byId = new Map();
  for (const ev of events) {
    if (!byId.has(ev.event_id)) byId.set(ev.event_id, ev);
  }
  const generatedAt = `${splitDate}T00:00:00Z`;
  const basisWindow = {
    train_from: model.cohorts.citywide.train_from,
    train_to: model.cohorts.citywide.train_to,
  };
  const predictions = scoring
    .map((p) => {
      const cohortKey = selectDispositionCohort(p.agency, model);
      return predictionFor(p, model, cohortKey, generatedAt, basisWindow);
    })
    .filter(Boolean);
  if (!predictions.length) {
    return {
      backtest: null,
      scorecard: emptyScorecard("No open multi-stage subjects at the split date."),
      training_pairs: training.length,
      scoring_pairs: scoring.length,
    };
  }
  const backtest = {
    domain: "property",
    split_date: splitDate,
    grace_days: 0,
    open_event_kinds: [PROPERTY_DISPOSITION_OPEN_KIND],
    terminal_event_kinds: [PROPERTY_DISPOSITION_TARGET_KIND],
    predictions,
    events: [...byId.values()],
  };
  return {
    backtest,
    scorecard: evaluatePredictionBacktest(backtest),
    training_pairs: training.length,
    scoring_pairs: scoring.length,
  };
}

/**
 * Build the full model report from a Property Disposition notice history.
 * @param {object[]} notices - City Record rows (optionally with property_location)
 */
export function buildPropertyDispositionTimingReport(notices = [], options = {}) {
  const generatedAt = options.generatedAt || new Date().toISOString();
  const spines = groupDispositionSpines(notices);
  const multiStage = buildMultiStageHearingAuctionPairs(spines);
  const schedule = buildAuctionSchedulePairs(notices);
  // Prefer multi-stage for the statistical model; fall back to schedule cohort for copy.
  const primaryPairs = multiStage.length ? multiStage : schedule;
  const primaryKind = multiStage.length
    ? "multi_stage_hearing_to_auction"
    : "auction_notice_to_event";
  const model = buildDispositionLagModel(primaryPairs);
  const backtestResult = buildDispositionTimingBacktest(multiStage);
  const citywide = model.cohorts.citywide;
  const sinceYear = (citywide?.train_from || "2013").toString().slice(0, 4);
  const publicProjection = backtestResult.scorecard?.public_projection
    || "cohort_statistic_only";

  return {
    schema_version: 1,
    model_name: PROPERTY_DISPOSITION_MODEL_NAME,
    model_version: PROPERTY_DISPOSITION_MODEL_VERSION,
    method: PROPERTY_DISPOSITION_METHOD,
    open_event_kind: PROPERTY_DISPOSITION_OPEN_KIND,
    target_event_kind: PROPERTY_DISPOSITION_TARGET_KIND,
    generated_at: generatedAt,
    corpus: {
      notice_count: notices.length,
      spine_count: spines.length,
      multi_stage_hearing_auction_pairs: multiStage.length,
      auction_schedule_pairs: schedule.length,
      primary_pair_kind: primaryKind,
      primary_pair_count: primaryPairs.length,
      since_year: sinceYear,
      note: multiStage.length
        ? "Primary cohort is parcel-joined hearing→auction lags."
        : "No parcel-joined hearing→auction pairs in this corpus; "
          + "citywide cohort uses auction-notice publication→scheduled-event lags. "
          + "Per-matter dates are withheld (ship bar).",
    },
    cohort_floor: model.floor,
    cohorts: model.cohorts,
    citywide: citywide
      ? {
          n: citywide.n,
          since_year: sinceYear,
          p10_days: citywide.p10_days,
          p25_days: citywide.p25_days,
          p50_days: citywide.p50_days,
          p75_days: citywide.p75_days,
          p90_days: citywide.p90_days,
          p10_weeks: citywide.p10_weeks,
          p50_weeks: citywide.p50_weeks,
          p90_weeks: citywide.p90_weeks,
          middle_half_low_weeks: citywide.middle_half_low_weeks,
          middle_half_high_weeks: citywide.middle_half_high_weeks,
          train_from: citywide.train_from,
          train_to: citywide.train_to,
          pair_kind: primaryKind,
        }
      : null,
    backtest: {
      training_pairs: backtestResult.training_pairs,
      scoring_pairs: backtestResult.scoring_pairs,
      scorecard: backtestResult.scorecard,
    },
    public_projection: publicProjection,
    // Never emit per-matter predictions when the ship bar fails.
    predictions: publicProjection === "per_matter_projection" ? [] : [],
  };
}

/**
 * Pattern-attribution line for the disposition timeline (cohort only by default).
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
    return `An auction typically follows the hearing by ${w1}–${w2} weeks (${n} past dispositions since ${year}).`;
  }
  return `A published sale date typically falls ${w1}–${w2} weeks after the auction notice (${n} past Property Disposition notices since ${year}).`;
}

/**
 * Attach a pure disposition_timing_estimate onto a property phase view when the
 * next unmatched stage is auction_or_rfp (hearing already matched, no sale date yet).
 */
export function attachDispositionTimingEstimate(phaseView, model, options = {}) {
  if (!phaseView || !model?.citywide) return phaseView;
  if (model.public_projection === "per_matter_projection" && options.allowPerMatter) {
    // Reserved for a later corpus refresh that clears the ship bar.
  }
  const hearing = (phaseView.phases || []).find((p) => p.id === "hearing");
  const auction = (phaseView.phases || []).find((p) => p.id === "auction_or_rfp");
  if (!hearing?.matched) return phaseView;
  if (auction?.matched) return phaseView; // date already published — urgency rail owns scheduled dates
  const pattern_line = dispositionTimingPatternLine(model.citywide, {
    pairKind: model.corpus?.primary_pair_kind,
  });
  if (!pattern_line) return phaseView;
  return {
    ...phaseView,
    disposition_timing_estimate: {
      kind: "cohort_statistic",
      after_phase: "hearing",
      target_phase: "auction_or_rfp",
      target_event_kind: PROPERTY_DISPOSITION_TARGET_KIND,
      method: PROPERTY_DISPOSITION_METHOD,
      chip: "Estimate",
      register: "estimate",
      public_projection: model.public_projection || "cohort_statistic_only",
      predicted_window: null, // ship bar failed — no per-matter dates
      pattern_line,
      n: model.citywide.n,
      since_year: model.citywide.since_year,
      weeks_low: model.citywide.middle_half_low_weeks ?? model.citywide.p10_weeks,
      weeks_high: model.citywide.middle_half_high_weeks ?? model.citywide.p90_weeks,
      pair_kind: model.corpus?.primary_pair_kind || model.citywide.pair_kind,
      corpus_note: model.corpus?.note || null,
    },
  };
}
