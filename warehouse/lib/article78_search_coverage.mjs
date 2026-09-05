/**
 * A78-03: grading court-search coverage, so that only adequately searched
 * negatives count.
 *
 * A denominator is a claim about coverage. "Three of two hundred land-use
 * approvals were challenged" is only true if somebody actually looked for a
 * challenge to the other hundred and ninety-seven, in a system that could
 * have shown one, under identifiers that would have matched it, over a window
 * long enough to contain the filing. Nothing in a court record says whether
 * that happened. Without a grade, an unsearched determination and an
 * unchallenged one produce the same zero, and a prevalence computed over the
 * mixture is unfalsifiable: no observation can move it, because the sample it
 * is drawn over is not defined.
 *
 * The freely accessible source is the published Official Reports, and it is
 * incomplete as a filing denominator by construction. An opinion exists only
 * where a court wrote one. A proceeding that settled, was withdrawn,
 * was discontinued, or was decided from the bench leaves no published opinion
 * at all -- so the absence of an opinion is evidence about publication, never
 * about filing. This module therefore never treats an opinion search on its
 * own as adequate: grade A requires a docket search as well, and that rule is
 * the whole reason the grade ladder has a top rung nothing reaches by
 * accident.
 *
 * What this module does:
 *  - `gradeCoverage` grades one determination's recorded searches A/B/C/U and
 *    returns the identifiers, horizon, systems, variants and missing docket
 *    details that produced the grade, plus the reasons, so the grade can be
 *    argued with rather than merely believed (A1, A2);
 *  - `admitNegatives` admits only grade A and B negatives into internal
 *    challenge evaluation and hands back the C and U determinations it
 *    excluded, counted rather than dropped (A3);
 *  - `eligibleDenominator` derives an eligible determination count from those
 *    recorded grades and reports the excluded remainder (A4).
 *
 * What this module does NOT do:
 *  - it never fetches, scrapes, authenticates or automates anything. A
 *    receipt describes a search somebody already ran and wrote down. Where a
 *    system's terms of use are not documented in
 *    `site/data/source_contracts.json` -- which today is all of them -- a
 *    receipt may name it as a system that was searched, and this code still
 *    does not know how to query it;
 *  - it adds no second coverage schema. The bounded-search detail lives on
 *    A78-01's existing `search_coverage` record
 *    (`warehouse/lib/article78_litigation.mjs`), extended additively;
 *  - it never derives a denominator from an asserted total.
 */
import {
  ARTICLE78_COUNTABLE_COVERAGE_GRADES,
  ARTICLE78_COVERAGE_GRADES,
  ARTICLE78_DOCKET_DETAIL_FIELDS,
  ARTICLE78_IDENTIFIER_VARIANT_KINDS,
  ARTICLE78_SEARCHABLE_SYSTEMS,
  ARTICLE78_SYSTEM_CLASSES,
  limitationsWindow,
  sortSystemsSearched,
  sortVariantsTried,
  validateArticle78Record,
  validateDeterminationContext,
} from "./article78_litigation.mjs";

export const ARTICLE78_SEARCH_COVERAGE_SCHEMA = "cityscroll.article78_search_coverage.v1";
export const ARTICLE78_COVERAGE_ADMISSION_SCHEMA = "cityscroll.article78_search_coverage.admission.v1";
export const ARTICLE78_ELIGIBLE_DENOMINATOR_SCHEMA = "cityscroll.article78_search_coverage.eligible_denominator.v1";

export class Article78SearchCoverageError extends Error {
  constructor(message) {
    super(message);
    this.name = "Article78SearchCoverageError";
  }
}

/**
 * The negative rule, as a constant a consumer can print rather than a
 * sentence a consumer has to remember to write.
 */
export const OFFICIAL_REPORTS_DENOMINATOR_WARNING =
  "published opinions are not a filing denominator: an opinion exists only where a court wrote one, so their absence is evidence about publication and never about filing";

// ---------------------------------------------------------------------------
// The policy. Every threshold this module applies is here, as data.
// ---------------------------------------------------------------------------

/**
 * One object holding every threshold, so that "what counts as adequate" is a
 * thing a reader can read in one place and a reviewer can argue with, rather
 * than a scatter of literals inside the grading code. The predicate NAMES are
 * data here; the predicate implementations are in `COVERAGE_PREDICATES`
 * below, because a threshold is a policy choice and a comparison is not.
 */
export const COVERAGE_GRADE_POLICY = Object.freeze({
  policy_id: "cityscroll.article78_search_coverage.grade_policy.v1",

  /** Which systems exist, and what each one can and cannot show. */
  systems: Object.freeze(ARTICLE78_SEARCHABLE_SYSTEMS.reduce((acc, system) => {
    acc[system] = Object.freeze({ class: ARTICLE78_SYSTEM_CLASSES[system] });
    return acc;
  }, {})),

  /**
   * How strong each identifier variant is. An index number names one
   * proceeding; a determination identifier plus an exact party name is the
   * same strength assembled from two halves; a name on its own is not,
   * because agencies, developers and community groups recur across unrelated
   * proceedings and abbreviations collide.
   */
  identifier_strength: Object.freeze({
    index_number: "unique",
    determination_identifier: "determination_identity",
    party_name: "exact_party",
    party_name_abbreviation: "weak",
    party_name_alternate_spelling: "weak",
    caption_fragment: "weak",
  }),

  /** Which combinations of strengths are adequate to match a proceeding. */
  adequate_identifier_combinations: Object.freeze([
    Object.freeze(["unique"]),
    Object.freeze(["determination_identity", "exact_party"]),
  ]),

  horizon: Object.freeze({
    /**
     * Grade A requires the whole limitations window plus this documented
     * margin after it closes. Four weeks absorbs docketing lag: a petition
     * filed on the last day of the window does not appear in a docket index
     * the same day, and a search that stops at the close would miss it and
     * still look complete.
     */
    documented_margin_days: 28,
    /**
     * Grade B's shorter horizon: the limitations window itself, with no
     * margin. A search that does not even span the window is truncated and
     * cannot rise above C, whatever else it did well.
     */
    shortened_margin_days: 0,
  }),

  systems_thresholds: Object.freeze({
    /** How many distinct systems "multiple systems searched" means. */
    multiple_systems_minimum: 2,
  }),

  /** Docket fields, so "some docket details" is measured against a list. */
  docket_detail_fields: ARTICLE78_DOCKET_DETAIL_FIELDS,

  /**
   * A receipt carrying one of these grades records a search that was run and
   * found to be unusable. It stays on file -- the inadequacy is a fact worth
   * keeping -- but it supports nothing, so a determination whose only
   * receipts are unusable grades out at U exactly like one nobody searched.
   */
  unusable_receipt_grades: Object.freeze(["U"]),

  /**
   * The ladder, in order. The first rule whose `all_of` predicates all hold,
   * and one of whose `any_of` branches holds if it has any, wins. `U` is last
   * and has no predicates: it is what is left when nothing usable was
   * recorded.
   */
  grade_rules: Object.freeze([
    Object.freeze({
      grade: "A",
      summary: "a docket search and an opinion search, under adequate identifiers, over the limitations window plus the documented margin",
      all_of: Object.freeze(["has_recorded_search", "has_docket_system", "has_opinion_system", "has_adequate_identifiers", "has_documented_margin_horizon"]),
    }),
    Object.freeze({
      grade: "B",
      summary: "multiple systems searched with some docket detail visible, or adequate identifiers over a shorter horizon",
      all_of: Object.freeze(["has_recorded_search"]),
      any_of: Object.freeze([
        Object.freeze(["has_multiple_systems", "has_some_docket_details"]),
        Object.freeze(["has_adequate_identifiers", "has_shortened_horizon"]),
      ]),
    }),
    Object.freeze({
      grade: "C",
      summary: "a search is on file, but it is a single system, or its identifiers are name-only, or its horizon is truncated",
      all_of: Object.freeze(["has_recorded_search"]),
    }),
    Object.freeze({
      grade: "U",
      summary: "no usable search of this determination is on file",
      all_of: Object.freeze([]),
    }),
  ]),

  /** Grades whose negatives may enter internal challenge evaluation. */
  admissible_grades: ARTICLE78_COUNTABLE_COVERAGE_GRADES,
});

// ---------------------------------------------------------------------------
// Small date helpers. No clock is read anywhere in this module.
// ---------------------------------------------------------------------------

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86400000;

function requireDateOnly(value, fieldName) {
  if (typeof value !== "string" || !DATE_ONLY.test(value)) {
    throw new Article78SearchCoverageError(`${fieldName} must be an ISO date (YYYY-MM-DD), got ${JSON.stringify(value)}`);
  }
  return value;
}

/** Whole days from `from` to `to`; negative when `to` precedes `from`. */
function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY);
}

function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * Merge searched date windows into the maximal contiguous intervals they
 * actually cover. Two searches that stop and restart with a gap between them
 * do not cover the gap, and taking the outer bounds of the set would claim
 * they did.
 */
export function mergeSearchedIntervals(windows = []) {
  const sorted = windows
    .map((window) => ({ from: requireDateOnly(window.from, "date_window.from"), to: requireDateOnly(window.to, "date_window.to") }))
    .sort((a, b) => (a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from)));
  const merged = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    // Abutting windows (one ends the day before the next begins) are
    // contiguous; a gap of one full day is not.
    if (last && interval.from <= addDays(last.to, 1)) {
      if (interval.to > last.to) last.to = interval.to;
      continue;
    }
    merged.push({ ...interval });
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Reading the receipts.
// ---------------------------------------------------------------------------

/** Does this receipt claim to be about this determination? */
function receiptTargets(receipt, determinationKey) {
  return receipt.determination_key === determinationKey
    || (receipt.scope?.determination_filters ?? []).includes(determinationKey);
}

function systemIdentity(entry) {
  return entry.system === "other" ? `other:${entry.label}` : entry.system;
}

/**
 * The identifiers a receipt was actually run under. Two sources feed it: the
 * `variants_tried` the receipt records explicitly, and the scope filters
 * A78-01 has always carried -- a receipt written before `variants_tried`
 * existed still gets classified from its own recorded scope rather than
 * silently reading as identifier-free.
 */
function identifiersOf(receipt) {
  const identifiers = new Map();
  const add = (kind) => {
    const strength = COVERAGE_GRADE_POLICY.identifier_strength[kind];
    if (strength) identifiers.set(kind, { kind, strength });
  };
  for (const variant of receipt.variants_tried ?? []) add(variant.kind);
  if ((receipt.scope?.determination_filters ?? []).length > 0) add("determination_identifier");
  if ((receipt.scope?.party_filters ?? []).length > 0) add("party_name");
  return [...identifiers.values()].sort((a, b) => a.kind.localeCompare(b.kind));
}

/**
 * Everything the grade rules read, gathered once from the receipts that both
 * target this determination and are not themselves recorded as unusable.
 */
function readSignals(determination, receipts) {
  const determinationKey = determination.determination_key;
  const considered = receipts
    .filter((receipt) => receiptTargets(receipt, determinationKey))
    .sort((a, b) => a.coverage_key.localeCompare(b.coverage_key));
  const usable = considered.filter((receipt) => !COVERAGE_GRADE_POLICY.unusable_receipt_grades.includes(receipt.coverage_grade));

  const systems = new Map();
  const variants = new Map();
  for (const receipt of usable) {
    for (const entry of receipt.systems_searched ?? []) {
      systems.set(systemIdentity(entry), {
        system: entry.system,
        label: entry.label ?? null,
        class: COVERAGE_GRADE_POLICY.systems[entry.system]?.class ?? "unclassified",
      });
    }
    for (const variant of receipt.variants_tried ?? []) variants.set(`${variant.kind}:${variant.value}`, { ...variant });
  }

  // A docket detail is unavailable for this determination only when no usable
  // receipt could see it. Reporting the union instead would say a detail was
  // invisible when in fact a second search showed it.
  const docketDetailsUnavailable = ARTICLE78_DOCKET_DETAIL_FIELDS.filter((field) => (
    usable.length > 0 && usable.every((receipt) => (receipt.docket_details_unavailable ?? []).includes(field))
  ));

  const identifiers = new Map();
  for (const receipt of usable) {
    for (const identifier of identifiersOf(receipt)) identifiers.set(identifier.kind, identifier);
  }

  const window = limitationsWindow(determination);
  const intervals = mergeSearchedIntervals(usable.map((receipt) => receipt.scope.date_window));
  const spanning = window
    ? intervals.find((interval) => interval.from <= window.opens_on && interval.to >= window.closes_on) ?? null
    : null;

  return {
    determination_key: determinationKey,
    considered,
    usable,
    systems: [...systems.values()].sort((a, b) => systemIdentity(a).localeCompare(systemIdentity(b))),
    variants: sortVariantsTried([...variants.values()]),
    docket_details_unavailable: docketDetailsUnavailable,
    identifiers: [...identifiers.values()].sort((a, b) => a.kind.localeCompare(b.kind)),
    horizon: {
      limitations_window: window,
      searched_intervals: intervals,
      spans_limitations_window: Boolean(spanning),
      margin_days_after_close: spanning ? daysBetween(window.closes_on, spanning.to) : null,
      documented_margin_days: COVERAGE_GRADE_POLICY.horizon.documented_margin_days,
      shortened_margin_days: COVERAGE_GRADE_POLICY.horizon.shortened_margin_days,
    },
  };
}

// ---------------------------------------------------------------------------
// The predicates the policy names.
// ---------------------------------------------------------------------------

/**
 * Each predicate answers one question and says, in both directions, why. The
 * sentences live here rather than in the policy because they explain a
 * comparison; the numbers being compared against live in the policy.
 */
const COVERAGE_PREDICATES = Object.freeze({
  has_recorded_search: {
    test: (signals) => signals.usable.length > 0,
    met: (signals) => `${signals.usable.length} usable recorded search${signals.usable.length === 1 ? " names" : "es name"} this determination`,
    unmet: (signals) => (signals.considered.length === 0
      ? "no recorded search names this determination"
      : `${signals.considered.length} recorded search${signals.considered.length === 1 ? " names" : "es name"} this determination, and every one of them is itself recorded as unusable`),
  },
  has_docket_system: {
    test: (signals) => signals.systems.some((entry) => entry.class === "docket"),
    met: () => "a docket system was searched",
    unmet: () => "no docket system was searched, so a proceeding that produced no published opinion could not have been seen",
  },
  has_opinion_system: {
    test: (signals) => signals.systems.some((entry) => entry.class === "opinion"),
    met: () => "an opinion source was searched alongside the docket",
    unmet: () => "no opinion source was searched",
  },
  has_multiple_systems: {
    test: (signals) => signals.systems.length >= COVERAGE_GRADE_POLICY.systems_thresholds.multiple_systems_minimum,
    met: (signals) => `${signals.systems.length} distinct systems were searched`,
    unmet: (signals) => `${signals.systems.length} system(s) searched, below the ${COVERAGE_GRADE_POLICY.systems_thresholds.multiple_systems_minimum} that "multiple systems" means`,
  },
  has_some_docket_details: {
    test: (signals) => signals.systems.some((entry) => entry.class === "docket")
      && signals.docket_details_unavailable.length < ARTICLE78_DOCKET_DETAIL_FIELDS.length,
    met: (signals) => `docket detail was visible: ${ARTICLE78_DOCKET_DETAIL_FIELDS.length - signals.docket_details_unavailable.length} of ${ARTICLE78_DOCKET_DETAIL_FIELDS.length} docket fields were exposed`,
    unmet: (signals) => (signals.systems.some((entry) => entry.class === "docket")
      ? "every docket field was unavailable from the systems searched"
      : "no docket system was searched, so no docket detail was available"),
  },
  has_adequate_identifiers: {
    test: (signals) => hasAdequateIdentifiers(signals.identifiers),
    met: (signals) => `identifiers were adequate to match a proceeding: ${signals.identifiers.map((identifier) => identifier.kind).join(", ")}`,
    unmet: (signals) => (signals.identifiers.length === 0
      ? "no identifier was recorded for the search"
      : `identifiers ${signals.identifiers.map((identifier) => identifier.kind).join(", ")} are name-only; matching needs an index number, or a determination identifier together with an exact party name`),
  },
  has_documented_margin_horizon: {
    test: (signals) => signals.horizon.spans_limitations_window
      && signals.horizon.margin_days_after_close >= COVERAGE_GRADE_POLICY.horizon.documented_margin_days,
    met: (signals) => `the searched horizon spans the limitations window and ${signals.horizon.margin_days_after_close} day(s) past its close, at or above the documented ${COVERAGE_GRADE_POLICY.horizon.documented_margin_days}-day margin`,
    unmet: (signals) => horizonShortfall(signals, COVERAGE_GRADE_POLICY.horizon.documented_margin_days),
  },
  has_shortened_horizon: {
    test: (signals) => signals.horizon.spans_limitations_window
      && signals.horizon.margin_days_after_close >= COVERAGE_GRADE_POLICY.horizon.shortened_margin_days,
    met: (signals) => `the searched horizon spans the whole limitations window (${signals.horizon.margin_days_after_close} day(s) past its close)`,
    unmet: (signals) => horizonShortfall(signals, COVERAGE_GRADE_POLICY.horizon.shortened_margin_days),
  },
});

function horizonShortfall(signals, requiredMargin) {
  if (!signals.horizon.limitations_window) {
    return "the determination is not recorded as final and binding, so there is no limitations window for a searched horizon to span";
  }
  if (!signals.horizon.spans_limitations_window) {
    return "the searched horizon does not contiguously span the limitations window, so a petition filed inside the window could have gone unseen";
  }
  return `the searched horizon runs only ${signals.horizon.margin_days_after_close} day(s) past the close of the limitations window, below the required ${requiredMargin}-day margin`;
}

/** Do these identifier strengths satisfy any combination the policy allows? */
function hasAdequateIdentifiers(identifiers) {
  const strengths = new Set(identifiers.map((identifier) => identifier.strength));
  return COVERAGE_GRADE_POLICY.adequate_identifier_combinations
    .some((combination) => combination.every((strength) => strengths.has(strength)));
}

function evaluatePredicate(name, signals) {
  const predicate = COVERAGE_PREDICATES[name];
  if (!predicate) throw new Article78SearchCoverageError(`grade policy names unknown predicate ${JSON.stringify(name)}`);
  const ok = predicate.test(signals);
  return { name, ok, why: ok ? predicate.met(signals) : predicate.unmet(signals) };
}

// ---------------------------------------------------------------------------
// A1: the grade.
// ---------------------------------------------------------------------------

/**
 * Grade the recorded court-record searches for one determination.
 *
 * Deterministic by construction: it reads no clock, sorts every list it
 * returns, and depends on nothing but the determination context and the
 * receipts handed to it. The same receipts always produce the same grade.
 *
 * The returned `reasons` are the point of the function as much as the grade
 * is. A grade with no reasons is another unfalsifiable claim, one level up:
 * every rule that was tried appears, with the predicates that carried or sank
 * it, so a reader can see that A was missed for want of an opinion search
 * rather than guess.
 */
export function gradeCoverage({ determination, receipts = [] } = {}) {
  const contextFindings = validateDeterminationContext(determination);
  if (contextFindings.length > 0) {
    throw new Article78SearchCoverageError(`gradeCoverage: ${contextFindings.join("; ")}`);
  }
  if (!Array.isArray(receipts)) {
    throw new Article78SearchCoverageError("gradeCoverage: receipts must be an array of A78-01 search_coverage records");
  }
  receipts.forEach((receipt, index) => {
    const findings = validateArticle78Record("search_coverage", receipt, `receipts[${index}]`);
    if (findings.length > 0) throw new Article78SearchCoverageError(`gradeCoverage: ${findings.join("; ")}`);
  });

  const signals = readSignals(determination, receipts);
  const reasons = [];
  let grade = null;

  for (const rule of COVERAGE_GRADE_POLICY.grade_rules) {
    if (grade !== null) break;
    const required = rule.all_of.map((name) => evaluatePredicate(name, signals));
    const branches = (rule.any_of ?? []).map((branch) => branch.map((name) => evaluatePredicate(name, signals)));
    const requiredOk = required.every((entry) => entry.ok);
    const branchOk = branches.length === 0 || branches.some((branch) => branch.every((entry) => entry.ok));
    const evaluated = [...required, ...branches.flat()];

    if (requiredOk && branchOk) {
      grade = rule.grade;
      for (const entry of evaluated.filter((row) => row.ok)) reasons.push(`${rule.grade}: met -- ${entry.why}`);
      if (evaluated.length === 0) reasons.push(`${rule.grade}: ${rule.summary}`);
      continue;
    }
    for (const entry of evaluated.filter((row) => !row.ok)) reasons.push(`${rule.grade}: not met -- ${entry.why}`);
  }

  return {
    schema: ARTICLE78_SEARCH_COVERAGE_SCHEMA,
    policy_id: COVERAGE_GRADE_POLICY.policy_id,
    determination_key: signals.determination_key,
    grade,
    receipts_considered: signals.considered.length,
    coverage_keys: signals.considered.map((receipt) => receipt.coverage_key),
    unusable_coverage_keys: signals.considered
      .filter((receipt) => COVERAGE_GRADE_POLICY.unusable_receipt_grades.includes(receipt.coverage_grade))
      .map((receipt) => receipt.coverage_key),
    identifiers_used: signals.identifiers,
    horizon: signals.horizon,
    systems_searched: signals.systems,
    variants_tried: signals.variants,
    docket_details_unavailable: signals.docket_details_unavailable,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// A2: what a bounded-search receipt has to record.
// ---------------------------------------------------------------------------

/**
 * Findings for one receipt that does not carry the bounded-search detail
 * A78-03 grades on. A78-01's validator accepts a receipt without these
 * fields, because the extension is additive and older receipts must keep
 * validating; this is where a receipt is held to the newer standard, and a
 * receipt that fails it can still be stored -- it simply cannot support a
 * grade above C.
 */
export function findBoundedSearchReceiptGaps(receipt, label = "search_coverage") {
  const findings = [];
  if (!Array.isArray(receipt?.systems_searched) || receipt.systems_searched.length === 0) {
    findings.push(`${label}: records no systems_searched, so there is no way to tell what this search could have seen`);
  }
  if (!Array.isArray(receipt?.variants_tried)) {
    findings.push(`${label}: records no variants_tried, so there is no way to tell what the search would have matched on`);
  }
  if (!Array.isArray(receipt?.docket_details_unavailable)) {
    findings.push(`${label}: records no docket_details_unavailable, so "found nothing" cannot be told apart from "could not see the docket"`);
  }
  return findings;
}

/** Throw unless every receipt records its systems, variants and missing docket details. */
export function assertBoundedSearchReceipts(receipts = [], context = "bounded search receipts") {
  const findings = receipts.flatMap((receipt, index) => findBoundedSearchReceiptGaps(receipt, `${context}[${index}] ${receipt?.coverage_key ?? "(no coverage_key)"}`));
  if (findings.length > 0) throw new Article78SearchCoverageError(`${context}: ${findings.join("; ")}`);
  return { ok: true, checked_count: receipts.length };
}

// ---------------------------------------------------------------------------
// A3: admission.
// ---------------------------------------------------------------------------

function gradeEntries(determinations, context) {
  if (!Array.isArray(determinations)) {
    throw new Article78SearchCoverageError(
      `${context}: expects an array of { determination, receipts } entries. An eligible population is derived from recorded coverage, one determination at a time; it is never an asserted total.`,
    );
  }
  return determinations
    .map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Article78SearchCoverageError(`${context}[${index}]: expects { determination, receipts }`);
      }
      return gradeCoverage({ determination: entry.determination, receipts: entry.receipts ?? [] });
    })
    .sort((a, b) => a.determination_key.localeCompare(b.determination_key));
}

/**
 * Partition determinations by coverage grade, admitting only the adequately
 * searched ones into internal challenge evaluation.
 *
 * A grade C or U determination is not dropped, and it is not counted as a
 * negative either. It comes back under `excluded`, by grade, with the reasons
 * that put it there -- because the size of the excluded remainder is itself
 * the measurement this card exists to make possible. A prevalence over
 * ninety admitted determinations with a hundred and ten excluded is a very
 * different claim from the same prevalence over two hundred, and the only way
 * to tell them apart is to carry the remainder.
 */
export function admitNegatives(determinations) {
  const graded = gradeEntries(determinations, "admitNegatives");
  const admitted = graded.filter((row) => COVERAGE_GRADE_POLICY.admissible_grades.includes(row.grade));
  const excluded = { C: graded.filter((row) => row.grade === "C"), U: graded.filter((row) => row.grade === "U") };
  return {
    schema: ARTICLE78_COVERAGE_ADMISSION_SCHEMA,
    policy_id: COVERAGE_GRADE_POLICY.policy_id,
    admissible_grades: [...COVERAGE_GRADE_POLICY.admissible_grades],
    admitted,
    excluded,
    counts: {
      considered: graded.length,
      admitted: admitted.length,
      excluded_C: excluded.C.length,
      excluded_U: excluded.U.length,
    },
    note: OFFICIAL_REPORTS_DENOMINATOR_WARNING,
  };
}

// ---------------------------------------------------------------------------
// A4: the eligible denominator.
// ---------------------------------------------------------------------------

/**
 * The eligible determination count, derived from recorded coverage grades and
 * from nothing else.
 *
 * There is deliberately no way to pass a total in. A denominator asserted
 * from outside -- "there were two hundred approvals that year" -- is the
 * failure this card exists to prevent, because it silently readmits every
 * determination nobody searched. The eligible count is the number of
 * determinations whose coverage grades out admissible, the remainder is
 * everything else with its grade attached, and the two always add back up to
 * the number of determinations that were actually examined.
 */
export function eligibleDenominator(determinations) {
  const admission = admitNegatives(determinations);
  const byGrade = Object.fromEntries(ARTICLE78_COVERAGE_GRADES.map((grade) => [grade, 0]));
  for (const row of [...admission.admitted, ...admission.excluded.C, ...admission.excluded.U]) {
    byGrade[row.grade] += 1;
  }
  const remainder = [...admission.excluded.C, ...admission.excluded.U];
  return {
    schema: ARTICLE78_ELIGIBLE_DENOMINATOR_SCHEMA,
    policy_id: COVERAGE_GRADE_POLICY.policy_id,
    derived_from: "recorded_coverage_grades",
    examined_determination_count: admission.counts.considered,
    eligible_determination_count: admission.counts.admitted,
    eligible_determination_keys: admission.admitted.map((row) => row.determination_key),
    by_grade: byGrade,
    excluded_remainder: {
      count: remainder.length,
      by_grade: { C: admission.counts.excluded_C, U: admission.counts.excluded_U },
      determination_keys: {
        C: admission.excluded.C.map((row) => row.determination_key),
        U: admission.excluded.U.map((row) => row.determination_key),
      },
    },
    note: OFFICIAL_REPORTS_DENOMINATOR_WARNING,
  };
}

/**
 * The callable form of A4's rule, for a caller that has a denominator in hand
 * and wants to prove it was derived rather than asserted: the eligible count
 * plus the excluded remainder must equal the number of determinations that
 * were examined, and no larger population may be claimed.
 */
export function assertDerivedDenominator(denominator, context = "eligible denominator") {
  if (!denominator || denominator.schema !== ARTICLE78_ELIGIBLE_DENOMINATOR_SCHEMA) {
    throw new Article78SearchCoverageError(`${context}: not an eligible-denominator receipt`);
  }
  const total = denominator.eligible_determination_count + denominator.excluded_remainder.count;
  if (total !== denominator.examined_determination_count) {
    throw new Article78SearchCoverageError(
      `${context}: eligible ${denominator.eligible_determination_count} plus excluded ${denominator.excluded_remainder.count} is ${total}, which is not the ${denominator.examined_determination_count} determination(s) examined; a denominator that does not add up is an asserted total wearing a derivation's clothes`,
    );
  }
  return { ok: true, examined: denominator.examined_determination_count };
}

// ---------------------------------------------------------------------------
// The A78-01 seam.
// ---------------------------------------------------------------------------

/**
 * The `coverageGrade` argument A78-01's `challengeWatchValue` takes, derived
 * here. Keeping the derivation on this side of the seam is what stops A78-01
 * from importing A78-03 and the two modules from becoming one; the grade
 * travels as a value, and A78-01 refuses to produce a number under a grade
 * outside its countable set.
 */
export function coverageGradeFor({ determination, receipts = [] } = {}) {
  return gradeCoverage({ determination, receipts }).grade;
}

/** Every identifier variant kind the policy knows how to weigh. */
export const GRADED_IDENTIFIER_VARIANT_KINDS = Object.freeze([...ARTICLE78_IDENTIFIER_VARIANT_KINDS]);
