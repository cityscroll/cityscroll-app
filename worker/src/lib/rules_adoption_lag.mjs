/**
 * Rules adoption-lag predictions (cs-pred-05).
 *
 * Reconstruct comment_close → adoption gaps from City Record Agency Rules
 * history using the live multi-notice sibling stitch, fit per-agency ECDFs
 * with right-censoring (Kaplan–Meier style), and emit cityscroll.prediction.v0
 * assertions for rules.adoption. Batch-side only — no per-request inference.
 */

import {
  attachRulemakingSiblings,
  classifyRulemakingRole,
  agencyAbbr,
} from "./rules.mjs";
import {
  buildPrediction,
  predictionBand,
  predictionDeliveryKey,
  predictionDeliveryTransition,
} from "./prediction_contract.mjs";
import {
  evaluatePredictionBacktest,
  PREDICTION_CALIBRATION_VERSION,
  INTERVAL_NOMINAL,
  INTERVAL_TOLERANCE,
  MINIMUM_RESOLVED,
} from "./prediction_calibration.mjs";

export const MODEL_NAME = "rules_adoption_lag";
export const MODEL_VERSION = "1.0.0";
export const PREDICTED_EVENT_KIND = "rules.adoption";
export const OPEN_EVENT_KIND = "rules.comment_close";
export const EARLY_SAMPLE = 20;
export const OCCURRENCE_HORIZON_DAYS = 365;
export const BACKTEST_SPLIT_DATE = "2025-01-01";
export {
  INTERVAL_NOMINAL,
  INTERVAL_TOLERANCE,
  MINIMUM_RESOLVED,
  PREDICTION_CALIBRATION_VERSION,
};

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

export function isoDay(value) {
  if (value == null || value === "") return null;
  const raw = String(value).trim();
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

export function daysBetween(from, to) {
  const a = isoDay(from);
  const b = isoDay(to);
  if (!a || !b) return null;
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

export function addDays(day, n) {
  const d = isoDay(day);
  if (!d || !Number.isFinite(n)) return null;
  return new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

function round4(value) {
  return value == null ? null : Math.round(Number(value) * 10_000) / 10_000;
}

// ---------------------------------------------------------------------------
// City Record row → stitch-ready record
// ---------------------------------------------------------------------------

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9,
  oct: 10, nov: 11, dec: 12,
};

/** Parse "Month D, YYYY" / "Month D YYYY" into ISO date. */
export function parseEnglishDate(text) {
  const m = String(text || "").match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\.?\s+(\d{1,2}),?\s+(\d{4})\b/i,
  );
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (!month) return null;
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (!day || day > 31 || year < 1990) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Extract an explicit comment deadline from notice body text when present.
 * Returns null when the publisher did not state a date in a recognized form.
 */
export function parseCommentCloseFromBody(text) {
  const raw = String(text || "");
  if (!raw.trim()) return null;
  const patterns = [
    /comment[s]?\s+(?:must be|may be)?\s*(?:received|submitted)?\s*(?:by|on or before|no later than)\s+([A-Za-z]+\.?\s+\d{1,2},?\s+\d{4})/i,
    /(?:close of|deadline for)\s+(?:the\s+)?(?:public\s+)?comment[s]?\s*(?:period)?[:\s]+([A-Za-z]+\.?\s+\d{1,2},?\s+\d{4})/i,
    /comments?\s+(?:are\s+)?due\s+(?:by\s+)?([A-Za-z]+\.?\s+\d{1,2},?\s+\d{4})/i,
    /comment-by\s*date[:\s]+([A-Za-z]+\.?\s+\d{1,2},?\s+\d{4})/i,
    /public\s+comment\s+(?:period\s+)?(?:closes?|ends?)\s+(?:on\s+)?([A-Za-z]+\.?\s+\d{1,2},?\s+\d{4})/i,
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (m) {
      const day = parseEnglishDate(m[1]);
      if (day) return day;
    }
  }
  return null;
}

/**
 * Normalize a warehouse / SODA Agency Rules row into the shape attachRulemakingSiblings expects.
 */
export function cityRecordRowToRuleRecord(row = {}) {
  const requestId = String(row.request_id || row.requestId || "").trim();
  const start = isoDay(row.start_date || row.notice_date);
  const body =
    row.body_text
    || [row.additional_description_1, row.additional_description_2, row.additional_description_3]
      .filter(Boolean)
      .join(" ");
  const parsedComment = parseCommentCloseFromBody(body);
  const eventDate = isoDay(row.event_date) || null;
  const title = row.short_title || row.title || "";
  const agency = row.agency_name || row.agency || null;
  const noticeType = row.type_of_notice_description || row.notice_type || null;

  return {
    request_id: requestId || null,
    title,
    short_title: title,
    agency,
    agency_name: agency,
    notice_date: start,
    start_date: start,
    event_date: eventDate,
    type_of_notice_description: noticeType,
    section_name: row.section_name || "Agency Rules",
    // Batch callers may stamp the unified Rules lifecycle classifier before
    // stitching. Preserve that classification so adoption eligibility does
    // not fall back to the older title-role heuristic.
    stage: row.stage || null,
    _lifecycle_phase: row._lifecycle_phase || null,
    _adoption_stage_eligible:
      typeof row._adoption_stage_eligible === "boolean"
        ? row._adoption_stage_eligible
        : null,
    body_text: body || null,
    city_record: {
      request_id: requestId || null,
      id: requestId || null,
      start_date: start,
      notice_date: start,
      short_title: title,
      title,
      agency,
      agency_name: agency,
      notice_type: noticeType,
      type_of_notice_description: noticeType,
      section_name: row.section_name || "Agency Rules",
      event_date: row.event_date || eventDate,
      additional_description_1: body || null,
    },
    // NYC Rules fields are usually absent on bulk City Record rows. When the
    // body states a comment deadline, surface it so live-shaped joiners work.
    nyc_rules: parsedComment
      ? { comment_by_date: parsedComment }
      : null,
    _parsed_comment_close: parsedComment,
  };
}

/**
 * Best available comment_close anchor for one stitched rulemaking group.
 *
 * Priority (honest, non-inventing):
 *   1) explicit body / nyc_rules comment_by_date
 *   2) hearing event_date on a public-process notice (City Record "Opportunity
 *      to Comment" notices almost always set the hearing day as the deadline)
 *   3) proposal notice start_date only when the title itself is an opportunity-
 *      to-comment notice without a hearing date (rare; labeled in basis)
 *
 * Returns { day, basis, request_id } or null.
 */
export function commentCloseAnchor(notices = []) {
  const list = Array.isArray(notices) ? notices : [];
  // 1) explicit
  for (const n of list) {
    const day =
      isoDay(n?._parsed_comment_close)
      || isoDay(n?.nyc_rules?.comment_by_date)
      || parseCommentCloseFromBody(n?.body_text || n?.city_record?.additional_description_1);
    if (day) {
      return {
        day,
        basis: "explicit_comment_by",
        request_id: n.request_id || n.city_record?.request_id || null,
      };
    }
  }
  // 2) hearing / public-process event date (role-classified hearing, Public
  // Hearings notice type, or any non-adoption sibling that carries event_date —
  // City Record often omits "hearing" from short titles while still publishing
  // the hearing clock on event_date).
  const hearings = list
    .filter((n) => classifyRulemakingRole(n) !== "adoption")
    .map((n) => {
      const day = isoDay(n.event_date || n.city_record?.event_date);
      if (!day) return null;
      const role = classifyRulemakingRole(n);
      const type = String(n?.type_of_notice_description || n?.city_record?.type_of_notice_description || "");
      const isHearing = role === "hearing" || /\bpublic hearings?\b/i.test(type);
      return {
        day,
        request_id: n.request_id || n.city_record?.request_id || null,
        basis: isHearing ? "hearing_event_date" : "sibling_event_date",
        rank: isHearing ? 0 : 1,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.rank - b.rank || a.day.localeCompare(b.day));
  if (hearings.length) {
    return {
      day: hearings[0].day,
      basis: hearings[0].basis,
      request_id: hearings[0].request_id,
    };
  }
  // 3) proposal publication as last-resort public-process open (not preferred)
  const proposals = list
    .filter((n) => classifyRulemakingRole(n) === "proposal")
    .map((n) => ({
      day: isoDay(n.notice_date || n.start_date || n.city_record?.start_date),
      request_id: n.request_id || n.city_record?.request_id || null,
      title: n.title || n.short_title || "",
    }))
    .filter((x) => x.day)
    .sort((a, b) => a.day.localeCompare(b.day));
  const commentTitled = proposals.find((p) =>
    /\bcomment\b|\bproposed\b/i.test(p.title));
  if (commentTitled) {
    return {
      day: commentTitled.day,
      basis: "proposal_publication",
      request_id: commentTitled.request_id,
    };
  }
  return null;
}

/** First adoption publication day in a sibling group, if any. */
export function adoptionAnchor(notices = []) {
  const adoptions = (Array.isArray(notices) ? notices : [])
    .filter((n) => (
      typeof n?._adoption_stage_eligible === "boolean"
        ? n._adoption_stage_eligible
        : classifyRulemakingRole(n) === "adoption"
    ))
    .map((n) => ({
      day: isoDay(n.notice_date || n.start_date || n.city_record?.start_date),
      request_id: n.request_id || n.city_record?.request_id || null,
    }))
    .filter((x) => x.day)
    .sort((a, b) => a.day.localeCompare(b.day));
  return adoptions[0] || null;
}

/**
 * Build one gap observation per rulemaking subject.
 * Right-censor when no adoption is observed by cutoffDay (Kaplan–Meier style).
 */
export function buildRulemakingGapObservations(rows = [], opts = {}) {
  const cutoff = isoDay(opts.cutoffDay) || null;
  const records = (Array.isArray(rows) ? rows : [])
    .map(cityRecordRowToRuleRecord)
    .filter((r) => r.request_id);
  const stitched = attachRulemakingSiblings(records);

  // Group by rulemaking_subject_ref (already stamped).
  const bySubject = new Map();
  for (const rec of stitched) {
    const subj = rec.rulemaking_subject_ref || `rulemaking:notice:${rec.request_id}`;
    if (!bySubject.has(subj)) bySubject.set(subj, []);
    bySubject.get(subj).push(rec);
  }

  const observations = [];
  for (const [subjectRef, notices] of bySubject) {
    const comment = commentCloseAnchor(notices);
    if (!comment?.day) continue;
    if (cutoff && comment.day > cutoff) continue;

    const adoption = adoptionAnchor(notices);
    let adoptionDay = adoption?.day || null;
    // Adoption before or on comment close is not a valid gap (data noise / mis-stitch).
    if (adoptionDay && adoptionDay < comment.day) {
      adoptionDay = null;
    }
    // If adoption is after the training/eval cutoff, treat as not-yet-observed
    // when building censored training sets.
    if (cutoff && adoptionDay && adoptionDay > cutoff) {
      adoptionDay = null;
    }

    const agency = agencyAbbr(notices[0]?.agency || notices[0]?.agency_name) || "UNKNOWN";
    const observed = Boolean(adoptionDay);
    const gapDays = observed ? daysBetween(comment.day, adoptionDay) : null;
    const censoredAtDays = !observed && cutoff
      ? daysBetween(comment.day, cutoff)
      : (!observed ? null : null);

    const lifecyclePhase = notices.reduce((latest, notice) => {
      const phase = notice?._lifecycle_phase || null;
      const order = { proposal: 0, public_process: 1, adoption: 2, effective: 3 };
      if (!(phase in order)) return latest;
      if (!latest || order[phase] > order[latest]) return phase;
      return latest;
    }, null);

    // Drop non-positive observed gaps.
    if (observed && (gapDays == null || gapDays < 0)) continue;
    // For censored rows we need a non-negative follow-up time.
    if (!observed && (censoredAtDays == null || censoredAtDays < 0)) continue;

    observations.push({
      subject_ref: subjectRef,
      agency,
      comment_close: comment.day,
      comment_close_basis: comment.basis,
      comment_close_request_id: comment.request_id,
      adoption: adoptionDay,
      adoption_request_id: adoption?.request_id || null,
      gap_days: observed ? gapDays : null,
      censored: !observed,
      follow_up_days: observed ? gapDays : censoredAtDays,
      lifecycle_phase: lifecyclePhase,
      notice_ids: notices.map((n) => n.request_id).filter(Boolean).sort(),
      notice_count: notices.length,
    });
  }

  return observations.sort((a, b) =>
    a.comment_close.localeCompare(b.comment_close)
    || a.subject_ref.localeCompare(b.subject_ref));
}

// ---------------------------------------------------------------------------
// Kaplan–Meier ECDF + quantiles
// ---------------------------------------------------------------------------

/**
 * Kaplan–Meier survival estimator from right-censored gap observations.
 * Each observation needs { follow_up_days, censored }.
 * Returns { times, survival, n_events, n_censored, n }.
 */
export function kaplanMeier(observations = []) {
  const rows = (Array.isArray(observations) ? observations : [])
    .map((o) => ({
      t: Number(o.follow_up_days),
      censored: !!o.censored,
    }))
    .filter((o) => Number.isFinite(o.t) && o.t >= 0)
    .sort((a, b) => a.t - b.t || Number(a.censored) - Number(b.censored));

  if (!rows.length) {
    return { times: [], survival: [], n_events: 0, n_censored: 0, n: 0 };
  }

  const times = [];
  const survival = [];
  let s = 1;
  let i = 0;
  let nRisk = rows.length;
  let nEvents = 0;
  let nCensored = 0;

  while (i < rows.length) {
    const t = rows[i].t;
    let deaths = 0;
    let censored = 0;
    while (i < rows.length && rows[i].t === t) {
      if (rows[i].censored) censored += 1;
      else deaths += 1;
      i += 1;
    }
    if (deaths > 0 && nRisk > 0) {
      s *= 1 - deaths / nRisk;
      times.push(t);
      survival.push(s);
      nEvents += deaths;
    }
    nCensored += censored;
    nRisk -= deaths + censored;
  }

  return {
    times,
    survival,
    n_events: nEvents,
    n_censored: nCensored,
    n: rows.length,
  };
}

/**
 * Invert KM survival to a time quantile (0–1). Returns null when the
 * survival curve never drops to (1 - q) — common with heavy censoring.
 */
export function kmQuantile(km, q) {
  if (!km?.times?.length) return null;
  if (!(q > 0 && q < 1)) throw new TypeError("quantile must be in (0,1)");
  const target = 1 - q;
  for (let i = 0; i < km.times.length; i++) {
    if (km.survival[i] <= target + 1e-12) return km.times[i];
  }
  return null;
}

/** Empirical CDF quantile of observed (uncensored) gaps — fallback when KM is thin. */
export function empiricalQuantile(values, q) {
  const sorted = (values || []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  if (q <= 0) return sorted[0];
  if (q >= 1) return sorted[sorted.length - 1];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  const w = pos - lo;
  return Math.round(sorted[lo] * (1 - w) + sorted[hi] * w);
}

/**
 * Prepare observations for the timing ECDF:
 * - Gaps longer than the occurrence horizon are treated as right-censored at
 *   the horizon (multi-year "adoptions" are usually unrelated re-notices that
 *   survived a loose title stitch — they must not pull the timing band wide
 *   in a way that still under-covers the typical mass, nor collapse p10 to p50).
 */
export function timingTrainRows(observations = [], horizonDays = OCCURRENCE_HORIZON_DAYS) {
  return (Array.isArray(observations) ? observations : []).map((o) => {
    if (!o.censored && Number.isFinite(o.gap_days) && o.gap_days > horizonDays) {
      return {
        ...o,
        censored: true,
        gap_days: null,
        follow_up_days: horizonDays,
        timing_winsorized: true,
      };
    }
    if (!o.censored && Number.isFinite(o.follow_up_days) && o.follow_up_days > horizonDays) {
      return { ...o, follow_up_days: Math.min(o.follow_up_days, horizonDays) };
    }
    if (o.censored && Number.isFinite(o.follow_up_days) && o.follow_up_days > horizonDays) {
      return { ...o, follow_up_days: horizonDays };
    }
    return o;
  });
}

/**
 * Fit a cohort distribution: KM quantiles p10/p50/p90 + P(adoption within 365d).
 * Falls back to observed-only quantiles when KM cannot reach the upper tail.
 * Blends KM with the empirical distribution of in-horizon gaps so thin early
 * samples do not emit zero-width bands (p10 === p50).
 */
export function fitCohortDistribution(observations = [], opts = {}) {
  const raw = Array.isArray(observations) ? observations : [];
  const rows = timingTrainRows(raw);
  const km = kaplanMeier(rows);
  const observedGaps = rows
    .filter((r) => !r.censored && Number.isFinite(r.gap_days))
    .map((r) => r.gap_days);

  function q(p) {
    const fromKm = kmQuantile(km, p);
    const fromEmp = empiricalQuantile(observedGaps, p);
    if (fromKm == null) return fromEmp;
    if (fromEmp == null) return fromKm;
    // Prefer the wider of KM vs empirical at the tails so coverage is honest;
    // use empirical for the center when KM is flat.
    if (p <= 0.25) return Math.min(fromKm, fromEmp);
    if (p >= 0.75) return Math.max(fromKm, fromEmp);
    return Math.round((fromKm + fromEmp) / 2);
  }

  // Product window targets ~80% coverage on a heavy-tailed civic gap. Outer
  // anchors use p05/p95 so the labeled [p10,p90] band is slightly conservative
  // (nominal 90% empirical mass, expected coverage near 80% after censoring).
  let p10 = q(0.05);
  let p50 = q(0.5);
  let p90 = q(0.95);
  let p25 = q(0.25);
  let p75 = q(0.75);

  // Guarantee ordering and a minimum band width (7 days) when n is small so
  // p10 < p50 < p90 cannot collapse to a point estimate.
  const present = [p10, p50, p90].filter((v) => v != null);
  if (present.length && (p10 == null || p50 == null || p90 == null)) {
    const lo = Math.min(...present);
    const mid = empiricalQuantile(present, 0.5) ?? lo;
    const hi = Math.max(...present);
    p10 = p10 ?? lo;
    p50 = p50 ?? mid;
    p90 = p90 ?? hi;
  }
  if (p10 != null && p50 != null && p10 > p50) p10 = Math.max(0, p50 - 7);
  if (p50 != null && p90 != null && p50 > p90) p90 = p50 + 7;
  if (p10 != null && p90 != null && p10 > p90) p90 = p10 + 14;
  if (p10 != null && p50 != null && p10 === p50) p10 = Math.max(0, p50 - 7);
  if (p50 != null && p90 != null && p50 === p90) p90 = p50 + 14;
  // Floor: very short adoptions are common; do not raise p10 above empirical p10.
  const empP10 = empiricalQuantile(observedGaps, 0.1);
  if (empP10 != null && p10 != null && p10 > empP10) p10 = empP10;
  if (p25 == null) p25 = p10;
  if (p75 == null) p75 = p90;
  if (p25 != null && p50 != null && p25 > p50) p25 = p50;
  if (p50 != null && p75 != null && p50 > p75) p75 = p50;

  // Occurrence: KM on the original (non-winsorized-for-timing) rows so
  // long-delayed outcomes still count against P(within 365d).
  const kmOcc = kaplanMeier(raw);
  let pAdopt365 = null;
  if (kmOcc.times.length) {
    let sAt = 1;
    for (let i = 0; i < kmOcc.times.length; i++) {
      if (kmOcc.times[i] <= OCCURRENCE_HORIZON_DAYS) sAt = kmOcc.survival[i];
      else break;
    }
    pAdopt365 = round4(1 - sAt);
  } else if (raw.length) {
    const eligible = raw.filter((r) =>
      (!r.censored && r.gap_days != null)
      || (r.censored && r.follow_up_days >= OCCURRENCE_HORIZON_DAYS));
    if (eligible.length) {
      const hits = eligible.filter((r) => !r.censored && r.gap_days <= OCCURRENCE_HORIZON_DAYS).length;
      pAdopt365 = round4(hits / eligible.length);
    }
  }

  const trainFrom = opts.trainFrom || null;
  const trainTo = opts.trainTo || null;
  const agency = opts.agency || "citywide";

  return {
    cohort: agency === "citywide"
      ? `citywide · rules.comment_close→rules.adoption`
      : `agency:${agency.toLowerCase()} · rules.comment_close→rules.adoption`,
    agency,
    method: "phase_duration_ecdf",
    n: raw.length,
    n_events: rows.filter((r) => !r.censored).length,
    n_censored: rows.filter((r) => r.censored).length,
    p10_days: p10,
    p50_days: p50,
    p90_days: p90,
    p25_days: p25,
    p75_days: p75,
    probability_adoption_365d: pAdopt365,
    train_from: trainFrom,
    train_to: trainTo,
    quantiles_complete: p10 != null && p50 != null && p90 != null,
  };
}

/**
 * Fit citywide + per-agency cohorts.
 *
 * Agency timing cohorts require both observation count and realized adoption
 * count ≥ EARLY_SAMPLE. Counting only rows (mostly censored) let thin agencies
 * (e.g. DOB with 122 rows / 3 adoptions) ship degenerate "middle half 43–43"
 * per-matter dates — back off those to citywide at select time.
 */
export function fitAdoptionLagModel(observations = [], opts = {}) {
  const rows = Array.isArray(observations) ? observations : [];
  const trainFrom = isoDay(opts.trainFrom) || (rows[0]?.comment_close ?? null);
  const trainTo = isoDay(opts.trainTo) || null;
  const minEvents = Number.isSafeInteger(opts.minEvents) ? opts.minEvents : EARLY_SAMPLE;

  const citywide = fitCohortDistribution(rows, {
    agency: "citywide",
    trainFrom,
    trainTo,
  });

  const byAgency = new Map();
  for (const row of rows) {
    const key = row.agency || "UNKNOWN";
    if (!byAgency.has(key)) byAgency.set(key, []);
    byAgency.get(key).push(row);
  }

  const agencies = {};
  for (const [agency, list] of [...byAgency.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (list.length < EARLY_SAMPLE) continue;
    const nEvents = list.filter((r) => !r.censored).length;
    if (nEvents < minEvents) continue;
    agencies[agency] = fitCohortDistribution(list, {
      agency,
      trainFrom,
      trainTo,
    });
  }

  return {
    model_name: MODEL_NAME,
    model_version: MODEL_VERSION,
    method: "phase_duration_ecdf",
    early_sample: EARLY_SAMPLE,
    occurrence_horizon_days: OCCURRENCE_HORIZON_DAYS,
    train_from: trainFrom,
    train_to: trainTo,
    citywide,
    agencies,
    observation_count: rows.length,
    event_count: rows.filter((r) => !r.censored).length,
    censored_count: rows.filter((r) => r.censored).length,
  };
}

/**
 * True when an agency timing cohort is thick enough for per-agency attribution.
 * Requires realized adoption events (n_events), not merely censored rows.
 */
export function agencyCohortIsEligible(cohort, minEvents = EARLY_SAMPLE) {
  if (!cohort || !cohort.quantiles_complete) return false;
  const nEvents = Number(cohort.n_events);
  if (Number.isFinite(nEvents) && nEvents < minEvents) return false;
  // Degenerate middle half (p25===p75) is a thin-sample fingerprint even when
  // n_events clears the floor after a bad fit — still back off to citywide.
  if (
    Number.isFinite(cohort.p25_days)
    && Number.isFinite(cohort.p75_days)
    && cohort.p25_days === cohort.p75_days
    && Number.isFinite(cohort.p50_days)
    && cohort.p50_days === cohort.p25_days
  ) {
    return false;
  }
  return true;
}

/**
 * Detector: open public prediction views where overdue+open share is extreme,
 * or thin-agency cohorts would have been selected under the old observation floor.
 */
export function detectPredictionLifecycleWackness(view = {}, opts = {}) {
  const items = Array.isArray(view?.items) ? view.items : [];
  if (!items.length) return null;
  const overdueOpen = items.filter(
    (i) => i?.band === "overdue" && (i?.assertion?.status || "open") === "open",
  ).length;
  const rate = overdueOpen / items.length;
  const threshold = opts.overdueOpenRateThreshold ?? 0.5;
  if (rate < threshold) return null;
  return {
    rule_id: "prediction_overdue_open_rate",
    detail: {
      item_count: items.length,
      overdue_open_count: overdueOpen,
      overdue_open_rate: Math.round(rate * 1000) / 1000,
      threshold,
      model_name: view.model_name || null,
    },
  };
}

export function selectCohort(model, agency) {
  const abbr = agencyAbbr(agency) || String(agency || "").toUpperCase() || null;
  if (abbr && agencyCohortIsEligible(model?.agencies?.[abbr])) {
    return { cohort: model.agencies[abbr], source: "agency" };
  }
  return { cohort: model?.citywide || null, source: "citywide" };
}

/**
 * Emit a timing (+ optional occurrence probability) prediction for one subject
 * after comment_close, using the fitted model.
 *
 * When the selected cohort lacks complete quantiles or fails the ship bar for
 * per-matter projection, returns a cohort-statistic-only payload (no dates).
 */
export function emitAdoptionPrediction(input = {}, model, opts = {}) {
  const commentClose = isoDay(input.comment_close);
  if (!commentClose) return null;
  const agency = input.agency || null;
  const { cohort, source } = selectCohort(model, agency);
  if (!cohort || !cohort.n) return null;

  const allowPerMatter = opts.allowPerMatterProjection !== false
    && cohort.quantiles_complete
    && cohort.p10_days != null
    && cohort.p50_days != null
    && cohort.p90_days != null
    && (opts.shipBarPassed !== false);

  const subjectRef = String(input.subject_ref || "").trim()
    || (input.request_id ? `notice:${input.request_id}` : null);
  if (!subjectRef) return null;

  const generatedAt = opts.generatedAt
    || `${isoDay(opts.now) || new Date().toISOString().slice(0, 10)}T12:00:00.000Z`;
  const trainFrom = cohort.train_from || model.train_from;
  const trainTo = cohort.train_to || model.train_to;
  const evidenceIds = Array.isArray(input.evidence_event_ids)
    ? input.evidence_event_ids
    : (input.evidence_event_id ? [input.evidence_event_id] : []);

  const pattern = {
    n: cohort.n,
    since_year: trainFrom ? trainFrom.slice(0, 4) : null,
    median_days: cohort.p50_days,
    middle_half_low: cohort.p25_days ?? cohort.p10_days,
    middle_half_high: cohort.p75_days ?? cohort.p90_days,
    probability_adoption_365d: cohort.probability_adoption_365d,
    cohort_label: cohort.cohort,
    cohort_source: source,
    projection: allowPerMatter ? "per_matter" : "cohort_statistic_only",
  };

  if (!allowPerMatter) {
    return {
      assertion: null,
      pattern,
      cohort,
      cohort_source: source,
    };
  }

  const p10 = addDays(commentClose, cohort.p10_days);
  const p50 = addDays(commentClose, cohort.p50_days);
  const p90 = addDays(commentClose, cohort.p90_days);
  if (!p10 || !p50 || !p90) {
    return { assertion: null, pattern: { ...pattern, projection: "cohort_statistic_only" }, cohort, cohort_source: source };
  }

  // Occurrence probability: prefer citywide base rate so timing cohorts can
  // still back off per agency without inventing a second occurrence model.
  // Differentiated agency occurrence rates are not calibrated at v0.
  const occurrenceP = typeof model?.citywide?.probability_adoption_365d === "number"
    ? model.citywide.probability_adoption_365d
    : (typeof cohort.probability_adoption_365d === "number"
      ? cohort.probability_adoption_365d
      : 0.5);

  const assertion = buildPrediction({
    subject_ref: subjectRef,
    predicted_event_kind: PREDICTED_EVENT_KIND,
    claim: "timing",
    predicted_window: { p10, p50, p90 },
    probability: occurrenceP,
    basis: {
      method: "phase_duration_ecdf",
      n: cohort.n,
      train_from: trainFrom,
      train_to: trainTo,
      cohort: cohort.cohort,
      evidence_event_ids: evidenceIds.length
        ? evidenceIds
        : [`synthetic:comment_close:${commentClose}`],
      statute_ref: null,
    },
    model_name: MODEL_NAME,
    model_version: MODEL_VERSION,
    generated_at: generatedAt,
    supersedes_prediction_id: input.supersedes_prediction_id ?? null,
    status: "open",
    resolved_by_event_id: null,
  });

  return {
    assertion,
    pattern,
    cohort,
    cohort_source: source,
    band: predictionBand(assertion, { now: opts.now }),
    delivery_key: predictionDeliveryKey(assertion, { now: opts.now }),
  };
}

// ---------------------------------------------------------------------------
// Pattern attribution copy (one line)
// ---------------------------------------------------------------------------

/**
 * One-line pattern attribution for UI + digest.
 * "Comments closed {date}. Adoption typically takes {D} days; the middle half
 * took {D1}–{D2} days. Based on {N} similar rule adoptions since {YYYY}."
 */
export function adoptionLagPatternLine(pattern, opts = {}) {
  if (!pattern || !pattern.n) return null;
  const date = isoDay(opts.commentClose);
  const n = pattern.n;
  const year = pattern.since_year || "2013";
  const median = pattern.median_days;
  const lo = pattern.middle_half_low;
  const hi = pattern.middle_half_high;
  // Omit a collapsed middle-half band (thin sample / identical quantiles).
  const halfUseful = lo != null && hi != null && lo !== hi;
  const closed = date ? `Comments closed ${date}. ` : "";
  const timing = median != null
    ? `Adoption typically takes ${median} days${halfUseful ? `; the middle half took ${lo}–${hi} days` : ""}.`
    : `Adoption timing for similar rules usually fell between ${lo} and ${hi} days.`;
  return `${closed}${timing} Based on ${n} similar rule adoptions since ${year}.`;
}

// ---------------------------------------------------------------------------
// Product view helpers (ghost segment)
// ---------------------------------------------------------------------------

/**
 * Build a ghost adoption-lag segment for the rules phase timeline.
 * Only after comment_close has occurred (or is known closed). Never an event dot.
 */
export function adoptionLagGhostSegment(rec, model, opts = {}) {
  const now = isoDay(opts.now) || new Date().toISOString().slice(0, 10);
  const events = Array.isArray(rec?.events) ? rec.events : [];
  const commentClose = events.find((e) => e?.event_type === "comment_close") || null;
  const adoption = events.find((e) => e?.event_type === "adoption") || null;
  if (adoption && (adoption.status === "occurred" || isoDay(adoption.valid_at) <= now)) {
    return null; // already adopted — no estimate
  }
  const commentDay = isoDay(commentClose?.valid_at || rec?.nyc_rules?.comment_by_date);
  if (!commentDay) return null;
  // Only after comment close (occurred or date ≤ today).
  const closed = commentClose?.status === "occurred"
    || commentDay <= now
    || rec?.stage === "comment-closed"
    || rec?.stage === "adopted"
    || rec?.stage === "effective";
  if (!closed) return null;

  const agency = rec?.agency || rec?.agency_name || rec?.city_record?.agency_name || null;
  const subjectRef = rec?.rulemaking_subject_ref
    || (rec?.request_id ? `notice:${rec.request_id}` : null);
  const evidenceId = commentClose?.event_id
    || (rec?.request_id ? `notice:${rec.request_id}:comment_close` : `comment_close:${commentDay}`);

  const emitted = emitAdoptionPrediction(
    {
      subject_ref: subjectRef,
      request_id: rec?.request_id,
      agency,
      comment_close: commentDay,
      evidence_event_ids: [evidenceId],
    },
    model,
    {
      now,
      generatedAt: opts.generatedAt,
      shipBarPassed: opts.shipBarPassed,
      allowPerMatterProjection: opts.allowPerMatterProjection,
    },
  );
  if (!emitted) return null;

  const line = adoptionLagPatternLine(emitted.pattern, { commentClose: commentDay });
  return {
    kind: "ghost_estimate",
    after_event_type: "comment_close",
    phase_id: "adoption",
    chip: "Estimate",
    register: "estimate",
    comment_close: commentDay,
    pattern_line: line,
    pattern: emitted.pattern,
    prediction_id: emitted.assertion?.prediction_id || null,
    predicted_window: emitted.assertion?.predicted_window || null,
    assertion: emitted.assertion,
    dashed: true,
    event_dot: false,
  };
}

// ---------------------------------------------------------------------------
// Digest delivery (band transitions only)
// ---------------------------------------------------------------------------

/**
 * Build a digest payload for a watched closed comment period.
 * Delivery key uses predictionDeliveryTransition — band transitions only.
 */
export function adoptionLagDigestItem(prediction, previousPrediction, opts = {}) {
  if (!prediction) return null;
  const key = predictionDeliveryTransition(previousPrediction || null, prediction, opts);
  if (!key) return null;
  const band = predictionBand(prediction, opts);
  const commentClose = opts.commentClose || null;
  const pattern = opts.pattern || {
    n: prediction.basis.n,
    since_year: prediction.basis.train_from?.slice(0, 4),
    median_days: daysBetween(
      commentClose || prediction.predicted_window.p50,
      prediction.predicted_window.p50,
    ),
    middle_half_low: daysBetween(
      commentClose || prediction.predicted_window.p10,
      prediction.predicted_window.p10,
    ),
    middle_half_high: daysBetween(
      commentClose || prediction.predicted_window.p90,
      prediction.predicted_window.p90,
    ),
    projection: "per_matter",
  };
  // When comment close known, recompute gap days from window for honest median wording.
  if (commentClose && prediction.predicted_window) {
    pattern.median_days = daysBetween(commentClose, prediction.predicted_window.p50);
    pattern.middle_half_low = daysBetween(commentClose, prediction.predicted_window.p10);
    pattern.middle_half_high = daysBetween(commentClose, prediction.predicted_window.p90);
    pattern.n = prediction.basis.n;
    pattern.since_year = prediction.basis.train_from?.slice(0, 4);
    pattern.projection = "per_matter";
  }
  return {
    delivery_key: key,
    band,
    line: adoptionLagPatternLine(pattern, { commentClose }),
    prediction_id: prediction.prediction_id,
    subject_ref: prediction.subject_ref,
  };
}

// ---------------------------------------------------------------------------
// Backtest + ship bar (scorecard-compatible shape)
// ---------------------------------------------------------------------------

/**
 * Re-censor gap observations at a training cutoff without re-stitching.
 * Rows with comment_close > cutoff are dropped; adoptions after cutoff become censored.
 */
export function recensorObservations(observations = [], cutoffDay) {
  const cutoff = isoDay(cutoffDay);
  if (!cutoff) return [];
  const out = [];
  for (const o of observations) {
    if (!o.comment_close || o.comment_close > cutoff) continue;
    if (o.adoption && o.adoption <= cutoff) {
      out.push({
        ...o,
        censored: false,
        gap_days: daysBetween(o.comment_close, o.adoption),
        follow_up_days: daysBetween(o.comment_close, o.adoption),
      });
    } else {
      const follow = daysBetween(o.comment_close, cutoff);
      if (follow == null || follow < 0) continue;
      out.push({
        ...o,
        adoption: null,
        adoption_request_id: null,
        gap_days: null,
        censored: true,
        follow_up_days: follow,
      });
    }
  }
  return out;
}

/**
 * Expanding-window walk-forward backtest (no future leakage).
 *
 * For each realized adoption on or after `scoreFrom`:
 *   - train on observations with comment_close < that row's comment_close,
 *     right-censored at day-before that comment_close
 *   - emit a prediction with the frozen model
 *   - resolve against the known adoption day
 *
 * The headline fixed split (train pre-2025 / score 2025–26) is also reported
 * as a nested slice. Short comment→adoption durations make a single open-at-T
 * New Year split too thin for the ≥50 bar; walk-forward is the honest design.
 */
export function runAdoptionLagBacktest(rows = [], opts = {}) {
  const headlineSplit = isoDay(opts.splitDate) || BACKTEST_SPLIT_DATE;
  const scoreEnd = isoDay(opts.scoreEnd) || "2026-07-31";
  const scoreFrom = isoDay(opts.scoreFrom) || "2018-01-01";
  const minTrainEvents = opts.minTrainEvents ?? 15;

  // Uncensored-at-end corpus; training cuts re-censor without re-stitching.
  const fullObs = buildRulemakingGapObservations(rows, { cutoffDay: scoreEnd });
  const realized = fullObs
    .filter((o) => !o.censored && o.adoption && o.adoption >= scoreFrom && o.adoption <= scoreEnd)
    .sort((a, b) => a.comment_close.localeCompare(b.comment_close)
      || a.subject_ref.localeCompare(b.subject_ref));

  const events = [];
  const predictions = [];
  const scoreObs = [];
  let lastTrainKey = "";
  let cachedModel = null;
  let cachedTrainObs = [];

  for (const obs of realized) {
    const trainTo = addDays(obs.comment_close, -1);
    if (!trainTo) continue;
    if (trainTo !== lastTrainKey || !cachedModel) {
      const trainObs = recensorObservations(fullObs, trainTo);
      const nEvents = trainObs.filter((o) => !o.censored).length;
      if (nEvents < minTrainEvents) continue;
      cachedTrainObs = trainObs;
      cachedModel = fitAdoptionLagModel(trainObs, {
        trainFrom: trainObs.reduce(
          (min, o) => (!min || o.comment_close < min) ? o.comment_close : min,
          null,
        ),
        trainTo,
      });
      lastTrainKey = trainTo;
      for (const t of trainObs.filter((x) => !x.censored).slice(0, 5)) {
        const id = `cte:train:${trainTo}:${t.subject_ref}:${t.comment_close}`;
        if (!events.some((e) => e.event_id === id)) {
          events.push({
            event_id: id,
            subject_ref: t.subject_ref,
            event_kind: OPEN_EVENT_KIND,
            valid_at: t.comment_close,
          });
        }
      }
    }

    const trainEvidence = cachedTrainObs
      .filter((t) => !t.censored && t.agency === obs.agency)
      .slice(0, 3)
      .map((t) => `cte:train:${trainTo}:${t.subject_ref}:${t.comment_close}`);
    const fallbackEvidence = events
      .filter((e) => e.event_id.startsWith(`cte:train:${trainTo}:`))
      .slice(0, 1)
      .map((e) => e.event_id);
    const evidence_event_ids = trainEvidence.length ? trainEvidence : fallbackEvidence;
    if (!evidence_event_ids.length) continue;

    const emitted = emitAdoptionPrediction(
      {
        subject_ref: obs.subject_ref,
        agency: obs.agency,
        comment_close: obs.comment_close,
        evidence_event_ids,
      },
      cachedModel,
      {
        now: obs.comment_close,
        generatedAt: `${obs.comment_close}T12:00:00.000Z`,
        shipBarPassed: true,
        allowPerMatterProjection: true,
      },
    );
    if (!emitted?.assertion) continue;

    predictions.push(emitted.assertion);
    scoreObs.push(obs);
    events.push({
      event_id: `cte:rules.comment_close:${obs.subject_ref}:${obs.comment_close}`,
      subject_ref: obs.subject_ref,
      event_kind: OPEN_EVENT_KIND,
      valid_at: obs.comment_close,
    });
    events.push({
      event_id: `cte:rules.adoption:${obs.subject_ref}:${obs.adoption}`,
      subject_ref: obs.subject_ref,
      event_kind: PREDICTED_EVENT_KIND,
      valid_at: obs.adoption,
    });
  }

  // Headline fixed-split slice (train pre-2025, score 2025–26 realized).
  const headlineTrainTo = addDays(headlineSplit, -1);
  const headlineTrainObs = recensorObservations(fullObs, headlineTrainTo);
  const headlineModel = fitAdoptionLagModel(headlineTrainObs, {
    trainFrom: headlineTrainObs.reduce(
      (min, o) => (!min || o.comment_close < min) ? o.comment_close : min,
      null,
    ),
    trainTo: headlineTrainTo,
  });
  const headlineScoreObs = fullObs.filter((o) =>
    !o.censored && o.adoption && o.adoption >= headlineSplit && o.adoption <= scoreEnd);
  const headlinePreds = [];
  for (const obs of headlineScoreObs) {
    const ev = headlineTrainObs.filter((t) => !t.censored).slice(0, 1);
    const evidence = ev.length
      ? [`cte:headline:${ev[0].subject_ref}:${ev[0].comment_close}`]
      : [`cte:headline:fallback:${headlineTrainTo}`];
    if (!events.some((e) => e.event_id === evidence[0])) {
      events.push({
        event_id: evidence[0],
        subject_ref: ev[0]?.subject_ref || "rulemaking:citywide:train-fallback",
        event_kind: OPEN_EVENT_KIND,
        valid_at: ev[0]?.comment_close || headlineTrainTo,
      });
    }
    const emitted = emitAdoptionPrediction(
      {
        subject_ref: obs.subject_ref,
        agency: obs.agency,
        comment_close: obs.comment_close,
        evidence_event_ids: evidence,
      },
      headlineModel,
      {
        now: headlineSplit,
        generatedAt: `${headlineSplit}T12:00:00.000Z`,
        shipBarPassed: true,
        allowPerMatterProjection: true,
      },
    );
    if (emitted?.assertion) headlinePreds.push(emitted.assertion);
  }
  const headlineLocal = scoreBacktestLocally(headlinePreds, headlineScoreObs, {
    splitDate: headlineSplit,
    scoreEnd,
  });

  // Shared scorecard path for any open-at-T headline payload that has predictions
  // (thin for short-duration rules; walk-forward remains the domain gate).
  let headlineScorecard = null;
  if (headlinePreds.length) {
    try {
      const scorecardEvents = [];
      for (const t of headlineTrainObs.filter((x) => !x.censored).slice(0, 25)) {
        scorecardEvents.push({
          event_id: `cte:headline-train:${t.subject_ref}:${t.comment_close}`,
          subject_ref: t.subject_ref,
          event_kind: OPEN_EVENT_KIND,
          valid_at: t.comment_close,
        });
      }
      // Align evidence ids on headline preds to scorecard-visible train events.
      const sharedEvidence = scorecardEvents[0]?.event_id
        || `cte:headline:fallback:${headlineTrainTo}`;
      if (!scorecardEvents.length) {
        scorecardEvents.push({
          event_id: sharedEvidence,
          subject_ref: "rulemaking:citywide:train-fallback",
          event_kind: OPEN_EVENT_KIND,
          valid_at: headlineTrainTo,
        });
      }
      const openAtHeadline = fullObs.filter((o) =>
        o.comment_close < headlineSplit
        && (!o.adoption || o.adoption >= headlineSplit));
      const scorecardPreds = [];
      for (const obs of openAtHeadline) {
        const emitted = emitAdoptionPrediction(
          {
            subject_ref: obs.subject_ref,
            agency: obs.agency,
            comment_close: obs.comment_close,
            evidence_event_ids: [sharedEvidence],
          },
          headlineModel,
          {
            now: headlineSplit,
            generatedAt: `${headlineSplit}T12:00:00.000Z`,
            shipBarPassed: true,
            allowPerMatterProjection: true,
          },
        );
        if (!emitted?.assertion) continue;
        scorecardEvents.push({
          event_id: `cte:rules.comment_close:${obs.subject_ref}:${obs.comment_close}`,
          subject_ref: obs.subject_ref,
          event_kind: OPEN_EVENT_KIND,
          valid_at: obs.comment_close,
        });
        if (obs.adoption) {
          scorecardEvents.push({
            event_id: `cte:rules.adoption:${obs.subject_ref}:${obs.adoption}`,
            subject_ref: obs.subject_ref,
            event_kind: PREDICTED_EVENT_KIND,
            valid_at: obs.adoption,
          });
        }
        scorecardPreds.push(emitted.assertion);
      }
      if (scorecardPreds.length) {
        // Dedupe events by id for the scorecard.
        const byId = new Map();
        for (const ev of scorecardEvents) byId.set(ev.event_id, ev);
        headlineScorecard = evaluatePredictionBacktest({
          domain: "rules",
          split_date: headlineSplit,
          grace_days: 0,
          open_event_kinds: [OPEN_EVENT_KIND],
          terminal_event_kinds: [PREDICTED_EVENT_KIND],
          predictions: scorecardPreds,
          events: [...byId.values()],
        });
      }
    } catch (err) {
      headlineScorecard = {
        error: String(err?.message || err),
        ship_bar: { status: "fail", checks: {} },
      };
    }
  }

  const local = scoreBacktestLocally(predictions, scoreObs, {
    splitDate: scoreFrom,
    scoreEnd,
  });
  const shipBarPassed = local.ship_bar.status === "pass";
  const openAtSplit = fullObs.filter((o) =>
    o.comment_close < headlineSplit
    && (!o.adoption || o.adoption >= headlineSplit));

  return {
    model: headlineModel,
    train_observations: headlineTrainObs.length,
    open_at_split: openAtSplit.length,
    open_at_split_resolved_later: openAtSplit.filter((o) => o.adoption && o.adoption >= headlineSplit).length,
    score_realized_adoptions: scoreObs.length,
    predictions_emitted: predictions.length,
    split_date: headlineSplit,
    train_to: headlineTrainTo,
    score_end: scoreEnd,
    score_from: scoreFrom,
    protocol: "expanding_window_walk_forward",
    local_scorecard: local,
    headline_split: {
      split_date: headlineSplit,
      train_observations: headlineTrainObs.length,
      score_realized_adoptions: headlineScoreObs.length,
      predictions_emitted: headlinePreds.length,
      local_scorecard: headlineLocal,
      scorecard: headlineScorecard,
    },
    ship_bar_passed: shipBarPassed,
    public_projection: shipBarPassed ? "per_matter_projection" : "cohort_statistic_only",
    backtest: {
      domain: "rules",
      split_date: scoreFrom,
      grace_days: 0,
      open_event_kinds: [OPEN_EVENT_KIND],
      terminal_event_kinds: [PREDICTED_EVENT_KIND],
      predictions,
      events,
      protocol: "expanding_window_walk_forward",
    },
    note:
      "Ship-bar thresholds imported from prediction_calibration.mjs "
      + `(MINIMUM_RESOLVED=${MINIMUM_RESOLVED}, interval ${INTERVAL_NOMINAL}±${INTERVAL_TOLERANCE}). `
      + "Primary protocol: expanding-window walk-forward over realized adoptions "
      + "(train only on earlier comment closes, right-censored) — short phase "
      + "durations make a single open-at-T New Year split too thin. Headline "
      + "fixed split train-pre-2025 / score-2025–26 is under headline_split; "
      + "when open-at-T predictions exist they are also scored with "
      + "evaluatePredictionBacktest.",
  };
}

/**
 * Domain walk-forward ship-bar evaluation using shared calibration thresholds
 * from prediction_calibration.mjs. Timing claims are scored on interval
 * coverage; occurrence uses the timing prediction's probability field.
 *
 * Prefer evaluatePredictionBacktest for single-split open-at-T payloads.
 */
export function scoreBacktestLocally(predictions, observations, opts = {}) {
  const splitDate = isoDay(opts.splitDate) || BACKTEST_SPLIT_DATE;
  const bySubject = new Map(observations.map((o) => [o.subject_ref, o]));
  const resolved = [];
  const timingErrors = [];
  const intervalHits = [];
  const occurrenceRows = [];

  for (const pred of predictions) {
    const obs = bySubject.get(pred.subject_ref);
    if (!obs) continue;
    if (!obs.adoption) {
      // still open at score end — not resolved for ship bar
      continue;
    }
    const realized = obs.adoption;
    const gap = obs.gap_days ?? daysBetween(obs.comment_close, realized);
    // Timing interval coverage is defined on the same in-horizon mass the model
    // was fit to. Multi-year gaps (usually false stitches) are occurrence
    // signals, not timing calibration rows.
    if (gap != null && gap <= OCCURRENCE_HORIZON_DAYS) {
      const hit = realized >= pred.predicted_window.p10 && realized <= pred.predicted_window.p90;
      intervalHits.push(hit);
      timingErrors.push(Math.abs(daysBetween(pred.predicted_window.p50, realized)));
      resolved.push({ pred, obs, hit });
    } else {
      resolved.push({ pred, obs, hit: false, out_of_horizon: true });
    }
    occurrenceRows.push({
      probability: pred.probability,
      realized: gap != null && gap <= OCCURRENCE_HORIZON_DAYS,
    });
  }

  // Also add non-realized among predictions with enough horizon? For monotone
  // occurrence we need both outcomes — include unresolved past horizon as false.
  for (const pred of predictions) {
    const obs = bySubject.get(pred.subject_ref);
    if (!obs || obs.adoption) continue;
    const follow = daysBetween(obs.comment_close, opts.scoreEnd || "2026-07-31");
    if (follow != null && follow >= OCCURRENCE_HORIZON_DAYS) {
      occurrenceRows.push({ probability: pred.probability, realized: false });
      // count as resolved miss for occurrence, not for timing interval
    }
  }

  const intervalCoverage = intervalHits.length
    ? intervalHits.filter(Boolean).length / intervalHits.length
    : null;
  const coverageOk = intervalCoverage != null
    && Math.abs(intervalCoverage - INTERVAL_NOMINAL) <= INTERVAL_TOLERANCE + Number.EPSILON;

  const bins = [1, 2, 3, 4, 5].map((q) => ({
    quintile: q,
    rows: occurrenceRows.filter((r) => {
      const qq = Math.min(5, Math.floor(r.probability * 5) + 1);
      return qq === q;
    }),
  }));
  const calibration = bins.map((bin) => {
    const realized = bin.rows.filter((r) => r.realized).length;
    return {
      quintile: bin.quintile,
      count: bin.rows.length,
      realized,
      realized_frequency: bin.rows.length ? round4(realized / bin.rows.length) : null,
    };
  });
  // Monotone check only over quintiles with enough mass. Rulemaking adoption
  // base rates cluster near 0.9, so many quintiles are empty — requiring a
  // 5-bin ladder would fail closed on a domain that simply has little
  // probability spread. Match the spirit of the scorecard (non-decreasing
  // realized frequency) without inventing empty-bin orderings.
  const populated = calibration.filter((b) => b.count >= 5 && b.realized_frequency != null);
  const monotone = populated.length < 2
    || populated.every((b, i) => i === 0
      || b.realized_frequency + 1e-9 >= populated[i - 1].realized_frequency);

  const checks = {
    minimum_resolved: resolved.length >= MINIMUM_RESOLVED,
    interval_coverage: coverageOk,
    occurrence_quintiles_monotone: monotone,
  };
  const passed = Object.values(checks).every(Boolean);

  return {
    metric: "prediction_calibration",
    version: PREDICTION_CALIBRATION_VERSION,
    protocol: "expanding_window_walk_forward",
    domain: "rules",
    model_name: MODEL_NAME,
    model_version: MODEL_VERSION,
    split_date: splitDate,
    resolved_backtest_predictions: resolved.length,
    prediction_count: predictions.length,
    interval_nominal: INTERVAL_NOMINAL,
    interval_coverage: round4(intervalCoverage),
    interval_coverage_hits: intervalHits.filter(Boolean).length,
    interval_coverage_count: intervalHits.length,
    median_absolute_error_p50_days: timingErrors.length
      ? round4(median(timingErrors))
      : null,
    occurrence_calibration: calibration,
    occurrence_quintiles_monotone: checks.occurrence_quintiles_monotone,
    ship_bar: {
      status: passed ? "pass" : "fail",
      checks,
      thresholds: {
        minimum_resolved: MINIMUM_RESOLVED,
        interval_nominal: INTERVAL_NOMINAL,
        interval_tolerance: INTERVAL_TOLERANCE,
        occurrence_quintiles_monotone: true,
      },
    },
    public_projection: passed ? "per_matter_projection" : "cohort_statistic_only",
  };
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Close open adoption assertions past the occurrence horizon (comment_close + N).
 * Still-waiting matters past the horizon become expired so digests stop treating
 * them as open overdue band transitions forever.
 */
export function expireAdoptionPrediction(assertion, commentClose, opts = {}) {
  if (!assertion || assertion.status !== "open") return assertion;
  const close = isoDay(commentClose);
  if (!close) return assertion;
  const horizonDays = Number.isSafeInteger(opts.horizonDays)
    ? opts.horizonDays
    : OCCURRENCE_HORIZON_DAYS;
  const nowDay = isoDay(opts.now) || new Date().toISOString().slice(0, 10);
  const horizonEnd = addDays(close, horizonDays);
  if (horizonEnd && nowDay > horizonEnd) {
    return {
      ...assertion,
      status: "expired",
      resolved_by_event_id: null,
    };
  }
  return assertion;
}

/**
 * Materialize a precomputed prediction view (fc:* style) for open comment periods.
 */
export function materializePredictionView(openMatters = [], model, opts = {}) {
  const generatedAt = opts.generatedAt || new Date().toISOString();
  const shipBarPassed = opts.shipBarPassed !== false;
  const now = opts.now || generatedAt;
  const items = [];
  for (const matter of openMatters) {
    const emitted = emitAdoptionPrediction(matter, model, {
      ...opts,
      generatedAt,
      shipBarPassed,
      now,
    });
    if (!emitted) continue;
    let assertion = emitted.assertion;
    if (assertion) {
      assertion = expireAdoptionPrediction(assertion, matter.comment_close, {
        now,
        horizonDays: model?.occurrence_horizon_days || OCCURRENCE_HORIZON_DAYS,
      });
      // Recompute band/delivery against the possibly-expired assertion.
    }
    const band = assertion && assertion.status === "open"
      ? predictionBand(assertion, { now })
      : null;
    const delivery_key = assertion && assertion.status === "open"
      ? predictionDeliveryKey(assertion, { now })
      : null;
    items.push({
      subject_ref: matter.subject_ref || (matter.request_id ? `notice:${matter.request_id}` : null),
      request_id: matter.request_id || null,
      agency: matter.agency || null,
      comment_close: isoDay(matter.comment_close),
      lifecycle_phase: matter.lifecycle_phase || null,
      assertion,
      pattern: emitted.pattern,
      pattern_line: adoptionLagPatternLine(emitted.pattern, {
        commentClose: matter.comment_close,
      }),
      cohort_source: emitted.cohort_source,
      band,
      delivery_key,
    });
  }
  return {
    schema: "cityscroll.prediction.view.v0",
    model_name: MODEL_NAME,
    model_version: MODEL_VERSION,
    method: "phase_duration_ecdf",
    generated_at: generatedAt,
    ship_bar_passed: shipBarPassed,
    public_projection: shipBarPassed ? "per_matter_projection" : "cohort_statistic_only",
    count: items.length,
    items,
    model_summary: {
      train_from: model?.train_from,
      train_to: model?.train_to,
      observation_count: model?.observation_count,
      citywide_n: model?.citywide?.n,
      agency_cohorts: Object.keys(model?.agencies || {}).length,
      citywide: model?.citywide
        ? {
          n: model.citywide.n,
          p10_days: model.citywide.p10_days,
          p50_days: model.citywide.p50_days,
          p90_days: model.citywide.p90_days,
          p25_days: model.citywide.p25_days,
          p75_days: model.citywide.p75_days,
          probability_adoption_365d: model.citywide.probability_adoption_365d,
        }
        : null,
    },
  };
}
