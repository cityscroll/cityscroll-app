/**
 * Client-side view helpers for rules adoption-lag estimates.
 *
 * Consumes the precomputed model at site/data/rules_adoption_lag_model.json
 * (batch-built by tools/build_rules_adoption_predictions.mjs). No per-request
 * inference — only date arithmetic over stored cohort quantiles.
 */

export const EARLY_SAMPLE = 20;

function clean(value) {
  if (value == null) return null;
  const s = String(value).replace(/\s+/g, " ").trim();
  return s || null;
}

export function isoDay(value) {
  if (value == null || value === "") return null;
  const raw = String(value).trim();
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

export function addDays(day, n) {
  const d = isoDay(day);
  if (!d || !Number.isFinite(n)) return null;
  return new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** Light agency abbr for cohort lookup — mirrors worker agencyAbbr for common cases. */
export function agencyAbbrLight(name) {
  if (!name) return null;
  const n = String(name).toLowerCase().trim();
  const direct = {
    hpd: "HPD", dot: "DOT", dob: "DOB", dcwp: "DCWP", dsny: "DSNY",
    dcp: "DCP", tlc: "TLC", dep: "DEP", dohmh: "DOHMH", fdny: "FDNY",
    nypd: "NYPD", doe: "DOE", dof: "DOF", finance: "DOF",
    buildings: "DOB", transportation: "DOT", sanitation: "DSNY",
    "consumer and worker protection": "DCWP",
    "housing preservation and development": "HPD",
    "environmental protection": "DEP",
    "taxi and limousine commission": "TLC",
  };
  if (direct[n]) return direct[n];
  for (const [k, v] of Object.entries(direct)) {
    if (n.includes(k)) return v;
  }
  return null;
}

/** Agency timing cohorts need realized adoptions, not only censored rows. */
export function agencyCohortIsEligible(cohort, minEvents = EARLY_SAMPLE) {
  if (!cohort || !cohort.quantiles_complete) return false;
  const nEvents = Number(cohort.n_events);
  if (Number.isFinite(nEvents) && nEvents < minEvents) return false;
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

export function selectCohort(model, agency) {
  const abbr = agencyAbbrLight(agency);
  if (abbr && agencyCohortIsEligible(model?.agencies?.[abbr])) {
    return { cohort: model.agencies[abbr], source: "agency" };
  }
  return { cohort: model?.citywide || null, source: "citywide" };
}

export function adoptionLagPatternLine(pattern, opts = {}) {
  if (!pattern || !pattern.n) return null;
  const date = isoDay(opts.commentClose);
  const n = pattern.n;
  const year = pattern.since_year || "2013";
  const median = pattern.median_days;
  const lo = pattern.middle_half_low;
  const hi = pattern.middle_half_high;
  const halfUseful = lo != null && hi != null && lo !== hi;
  const halfPhrase = halfUseful ? ` middle half ${lo}–${hi} days` : "";
  const closed = date ? `Comment period closed ${date}. ` : "";
  if (pattern.projection === "cohort_statistic_only" || median == null) {
    const half = halfUseful ? `${halfPhrase}.` : ".";
    const med = median != null ? ` typically ${median} days to adoption,` : "";
    return `${closed}Predicted based on ${n} similar rule adoptions since ${year} —${med}${half}`
      .replace(/\s+/g, " ")
      .trim();
  }
  const tail = halfUseful
    ? `median ${median} days to adoption,${halfPhrase}.`
    : `median ${median} days to adoption.`;
  return `${closed}Predicted based on ${n} similar rule adoptions since ${year} — ${tail}`;
}

/**
 * Ghost estimate segment after comment_close on the rules phase timeline.
 * Dashed / Estimate chip register — never an event dot.
 */
export function adoptionLagGhostFromModel(rec, model, opts = {}) {
  if (!model || !rec) return null;
  const now = isoDay(opts.now) || new Date().toISOString().slice(0, 10);
  const events = Array.isArray(rec.events) ? rec.events : [];
  const adoption = events.find((e) => e?.event_type === "adoption") || null;
  if (adoption) {
    const ad = isoDay(adoption.valid_at);
    if (adoption.status === "occurred" || (ad && ad <= now)) return null;
  }
  const commentClose = events.find((e) => e?.event_type === "comment_close") || null;
  const commentDay = isoDay(commentClose?.valid_at || rec?.nyc_rules?.comment_by_date);
  if (!commentDay) return null;
  const closed = commentClose?.status === "occurred"
    || commentDay <= now
    || rec?.stage === "comment-closed"
    || rec?.stage === "adopted"
    || rec?.stage === "effective";
  if (!closed) return null;

  const agency = rec.agency || rec.agency_name || rec.city_record?.agency_name || null;
  const { cohort, source } = selectCohort(model, agency);
  if (!cohort || !cohort.n) return null;

  const shipBarPassed = model?.backtest?.ship_bar_passed !== false
    && model?.backtest?.public_projection !== "cohort_statistic_only";
  const allowPerMatter = shipBarPassed
    && cohort.quantiles_complete
    && cohort.p10_days != null
    && cohort.p50_days != null
    && cohort.p90_days != null;

  const pattern = {
    n: cohort.n,
    since_year: (cohort.train_from || model.train_from || "2013").toString().slice(0, 4),
    median_days: cohort.p50_days,
    middle_half_low: cohort.p25_days ?? cohort.p10_days,
    middle_half_high: cohort.p75_days ?? cohort.p90_days,
    probability_adoption_365d: cohort.probability_adoption_365d,
    cohort_label: cohort.cohort,
    cohort_source: source,
    projection: allowPerMatter ? "per_matter" : "cohort_statistic_only",
  };

  const predicted_window = allowPerMatter
    ? {
      p10: addDays(commentDay, cohort.p10_days),
      p50: addDays(commentDay, cohort.p50_days),
      p90: addDays(commentDay, cohort.p90_days),
    }
    : null;

  return {
    kind: "ghost_estimate",
    after_event_type: "comment_close",
    phase_id: "adoption",
    chip: "Estimate",
    register: "estimate",
    comment_close: commentDay,
    pattern_line: adoptionLagPatternLine(pattern, { commentClose: commentDay }),
    pattern,
    predicted_window,
    dashed: true,
    event_dot: false,
  };
}

/**
 * Attach adoption_lag_estimate onto a rules phase view (pure).
 */
export function attachAdoptionLagEstimate(view, rec, model, opts = {}) {
  if (!view) return view;
  const ghost = adoptionLagGhostFromModel(rec || view, model, opts);
  return {
    ...view,
    adoption_lag_estimate: ghost,
  };
}
