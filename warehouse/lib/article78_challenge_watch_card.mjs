/**
 * A78-06: the internal challenge-watch card, where the separated components
 * stay separated.
 *
 * Everything upstream of this card was built to keep one kind of collapse from
 * happening. A78-01 refuses a combined outcome score and records procedure,
 * merits and remedy as three fields. A78-03 grades how well a determination
 * was actually searched instead of treating a miss as an absence. A78-04
 * derives features that each carry their own evidence and public date. A78-05
 * scores filing and durable relief as two heads that never meet.
 *
 * None of that survives contact with a reader if the display puts the pieces
 * back together. Nine separated components summarized into one impression by
 * whoever opens the page is exactly the outcome the ontology spent five cards
 * refusing, and the summarizing happens silently: it needs no field, no
 * number, and nobody's intent.
 *
 * So this card is a display contract rather than a derivation:
 *
 *  - **Nine rows, and no tenth.** Named opponent or coalition, preserved
 *    issue, limitations clock, service clock, theory fit, procedural exposure,
 *    merits indicators, remedy exposure, and court-search coverage. Each rests
 *    on its own named upstream fact -- `rests_on` is a field, and
 *    `assertChallengeWatchCard` refuses two rows that name the same one -- and
 *    no row reads another row's value.
 *  - **No level, no score, no verdict.** The card does not reproduce A78-04's
 *    watch level. A single level printed above nine rows is read as their
 *    summary whatever it is labelled, which is the collapse this card exists
 *    to prevent; where the watch is not established, the two watch-derived
 *    rows say so individually, with the null reason A78-04 recorded.
 *    `assertChallengeWatchCard` refuses any field name that reads as a
 *    combined figure, reusing A78-01's own scanner.
 *  - **Every row shows the grade it rests on.** A component derived from a
 *    determination nobody could adequately search is not a weaker component;
 *    it is a component nobody can check. The A78-03 grade travels on every
 *    row rather than sitting once at the top where a reader can stop seeing it.
 *  - **Clocks are computed from rules, never inferred.** The limitations and
 *    service deadlines come from `ARTICLE78_DEADLINE_RULES`, which names the
 *    statute, the triggering event and the period; the row shows the trigger,
 *    its date, the rule applied, the computed deadline and whether the clock
 *    is open, expired or unknown at the cutoff. Unknown stays unknown.
 *  - **Internal, and labelled.** `audience: "internal"` and
 *    `no_resident_conclusion: true` are fields the renderer and the tests
 *    enforce. The output is a challenge watch over recorded evidence; the
 *    title and headings are built from A78-04's own label constant, and every
 *    rendered string is scanned by both A78-01's and A78-04's forbidden
 *    registers before it leaves this module.
 *
 * It reads no clock, fetches nothing and writes no route. The same inputs and
 * the same `as_of` always produce the same card, byte for byte once rendered.
 */

import {
  applyDecisionSupersession,
  ARTICLE78_COVERAGE_GRADES,
  ARTICLE78_COUNTABLE_COVERAGE_GRADES,
  ARTICLE78_DECISION_FILING_TYPES,
  ARTICLE78_LIMITATIONS_MONTHS,
  ARTICLE78_PROCEDURAL_SURVIVAL_STATES,
  ARTICLE78_PETITIONER_RELIEF_STATES,
  ARTICLE78_REMEDY_EXPOSURE_STATES,
  ARTICLE78_CLAIM_THEORY_CATEGORIES,
  addMonthsToDate,
  assertNoCombinedOutcomeScore,
  assertNoForbiddenChallengeWatchWording,
  validateDeterminationContext,
} from "./article78_litigation.mjs";
import {
  assertNoChallengeWatchPredictionWording,
  CHALLENGE_WATCH_LABEL,
  LABOR_PARTICIPATION_SUPPRESSION,
  partitionByCutoff,
} from "./article78_challenge_watch.mjs";
import { gradeCoverage } from "./article78_search_coverage.mjs";

export const ARTICLE78_CHALLENGE_WATCH_CARD_SCHEMA = "cityscroll.article78_challenge_watch_card.v1";

export class Article78ChallengeWatchCardError extends Error {
  constructor(message) {
    super(message);
    this.name = "Article78ChallengeWatchCardError";
  }
}

// ---------------------------------------------------------------------------
// The label and the audience boundary.
// ---------------------------------------------------------------------------

/** Internal. There is no other audience this card may be built for. */
export const CHALLENGE_WATCH_CARD_AUDIENCE = "internal";

/**
 * The card's title and page heading, both built from A78-04's label constant
 * so the surface cannot be renamed here without renaming the signal there.
 */
export const CHALLENGE_WATCH_CARD_TITLE = `${CHALLENGE_WATCH_LABEL}, internal, diagnostic only`;

/** The sentence under the heading. Says what the page is, and what it is not. */
export const CHALLENGE_WATCH_CARD_SUBTITLE =
  `Each component below is shown on its own row, with its own evidence and the court-search coverage grade it `
  + `rests on. There is no combined figure here, and nothing on this page is a conclusion about how a court would rule.`;

/** The states a row may report. Clock rows use the last three and nothing else. */
export const CHALLENGE_WATCH_CARD_ROW_STATES = Object.freeze([
  // A record establishes it, as of the cutoff.
  "on_the_record",
  // The record is silent. An absence, phrased as one.
  "not_on_the_record",
  // A78-04's watch is null for this determination, so a watch-derived row
  // does not speak at all. Distinct from an absence in the record.
  "not_established",
  "open",
  "expired",
  "unknown",
]);

/** The two rows whose state is a clock state. */
export const CHALLENGE_WATCH_CARD_CLOCK_ROW_KEYS = Object.freeze(["limitations_clock", "service_clock"]);

/** The clock states, and the only states a clock row may carry. */
export const ARTICLE78_DEADLINE_CLOCK_STATES = Object.freeze(["open", "expired", "unknown"]);

/**
 * Why a clock is unknown. Each one is an absence in the record or a limit of
 * the cutoff, never a statement about what a court would do with the date.
 */
export const ARTICLE78_DEADLINE_CLOCK_UNKNOWN_REASONS = Object.freeze([
  "determination_finality_unknown",
  "determination_not_final",
  "final_and_binding_date_not_recorded",
  "trigger_event_not_on_the_record_at_cutoff",
  "upstream_clock_unknown",
]);

// ---------------------------------------------------------------------------
// A4: the deadline rules, as data.
// ---------------------------------------------------------------------------

/**
 * The two deadline rules this card computes clocks from. Each names the
 * statutory provision it comes from, the event that triggers it, and the
 * period it runs for. Nothing here is a date: a hard-coded deadline is a
 * deadline that silently stops matching the determination it was written for,
 * and a rule with no citation is a number nobody can check.
 *
 * The limitations rule is the one this repository already models --
 * `ARTICLE78_LIMITATIONS_MONTHS` and `limitationsWindow` in
 * `warehouse/lib/article78_litigation.mjs` -- named here rather than
 * reimplemented, including its documented override: a determination context
 * may carry its own `limitations_window_closes_on`, and the clock then reports
 * the stated date and says that it used it.
 *
 * The service rule is added by this card because no upstream module models it.
 * CPLR 306-b's general period is one hundred twenty days after commencement,
 * with a separate branch for a proceeding whose applicable limitations period
 * is four months or less -- which is the Article 78 case under CPLR 217(1).
 * The branch, not the general period, is what governs here, and it runs from
 * the expiry of the limitations period rather than from any filing date.
 */
export const ARTICLE78_DEADLINE_RULES = Object.freeze({
  limitations: Object.freeze({
    clock: "limitations",
    rule_id: "cplr_217_1_four_month_limitations_period",
    statute: "CPLR 217(1)",
    citation: "New York Civil Practice Law and Rules § 217(1)",
    summary: "a proceeding against a body or officer must be commenced within four months after the determination to be reviewed becomes final and binding upon the petitioner",
    trigger_event: "determination_final_and_binding",
    trigger_event_wording: "the determination became final and binding upon the petitioner",
    trigger_source: "determination_context.final_and_binding_date",
    trigger_is_recorded_event: true,
    period: Object.freeze({ months: ARTICLE78_LIMITATIONS_MONTHS }),
    period_wording: "four months after the triggering event",
    stated_deadline_field: "limitations_window_closes_on",
    note:
      "The four-month period is the general rule and not the only one: some land-use and municipal provisions "
      + "carry their own shorter periods. A determination context may therefore state its own closing date in "
      + "limitations_window_closes_on, and this clock reports that stated date and says it used it.",
  }),
  service: Object.freeze({
    clock: "service",
    rule_id: "cplr_306_b_service_after_short_limitations_period",
    statute: "CPLR 306-b",
    citation: "New York Civil Practice Law and Rules § 306-b",
    summary: "where the applicable statute of limitations is four months or less, service must be made not later than fifteen days after the date on which that period expires",
    trigger_event: "limitations_period_expires",
    trigger_event_wording: "the applicable limitations period expired",
    trigger_source: "the limitations clock's computed deadline",
    trigger_is_recorded_event: false,
    period: Object.freeze({ days: 15 }),
    period_wording: "fifteen days after the triggering event",
    stated_deadline_field: null,
    note:
      "CPLR 306-b's general period is one hundred twenty days after commencement. The fifteen-day branch applied "
      + "here is the one that governs a proceeding whose applicable limitations period is four months or less, "
      + "which is the Article 78 case under CPLR 217(1). It runs from the expiry of that period, so where a "
      + "determination states its own shorter limitations date the service deadline moves with it.",
  }),
});

// ---------------------------------------------------------------------------
// The nine rows.
// ---------------------------------------------------------------------------

/**
 * The card's rows, in the order they are rendered. `rests_on` names the single
 * upstream fact the row reads and is unique across the card:
 * `assertChallengeWatchCard` refuses two rows that name the same source,
 * because two rows over one fact is one row reported twice.
 *
 * `never_says` is carried on the row and rendered beside it. It is the
 * conclusion the row is regularly mistaken for, written down where a reader
 * meets the row rather than in a document they will not open.
 */
export const CHALLENGE_WATCH_CARD_ROWS = Object.freeze([
  Object.freeze({
    key: "named_opponent_or_coalition",
    label: "Named opponent or coalition",
    question: "which organization is on the public record in opposition, by name?",
    rests_on: "A78-04 named-participation features (organized opposition and labor participation)",
    never_says: "that a named organization intends to bring a proceeding, or why it participated.",
  }),
  Object.freeze({
    key: "preserved_issue",
    label: "Preserved issue",
    question: "which specific issue was named and reaffirmed on the public record?",
    rests_on: "A78-04 preserved-issue feature",
    never_says: "that a preserved issue is a claim, or that a court would find it meritorious.",
  }),
  Object.freeze({
    key: "limitations_clock",
    label: "Limitations clock",
    question: "under the limitations rule, when does the window to commence a proceeding close?",
    rests_on: "the CPLR 217(1) deadline rule over the determination's recorded finality",
    never_says: "that a proceeding was or was not timely; timeliness is decided by a court on a record this card does not have.",
  }),
  Object.freeze({
    key: "service_clock",
    label: "Service clock",
    question: "under the service rule, by when must service follow the expiry of the limitations period?",
    rests_on: "the CPLR 306-b deadline rule over the limitations clock's deadline",
    never_says: "that service was or was not made, or that any extension was or was not granted.",
  }),
  Object.freeze({
    key: "theory_fit",
    label: "Theory fit",
    question: "which claim theories are recorded against this determination, and in which category?",
    rests_on: "A78-01 claim_theory records for cases naming this determination",
    never_says: "that a recorded theory fits the preserved issue, or that it would succeed.",
  }),
  Object.freeze({
    key: "procedural_exposure",
    label: "Procedural exposure",
    question: "what did the effective decision record about the threshold objections?",
    rests_on: "A78-01 procedural_survival on the effective decision after supersession",
    never_says: "anything about the merits; a petition that survived a threshold objection has been ruled on for that objection and nothing else.",
  }),
  Object.freeze({
    key: "merits_indicators",
    label: "Merits indicators",
    question: "what relief did the petitioner obtain from the effective decision, and did it survive supersession?",
    rests_on: "A78-01 durable_petitioner_relief on the effective decision after supersession",
    never_says: "what the project is exposed to as a result; relief and remedy exposure come apart constantly and are separate rows.",
  }),
  Object.freeze({
    key: "remedy_exposure",
    label: "Remedy exposure",
    question: "what was the approved action exposed to by the effective decision?",
    rests_on: "A78-01 remedy_exposure on the effective decision after supersession",
    never_says: "how long any exposure lasted, or what the agency did next.",
  }),
  Object.freeze({
    key: "court_search_coverage",
    label: "Court-search coverage",
    question: "how well was the court record behind this determination actually searched?",
    rests_on: "A78-03 gradeCoverage over the determination's bounded search receipts",
    never_says: "that a search which located nothing is proof that nothing was filed.",
  }),
]);

export const CHALLENGE_WATCH_CARD_ROW_KEYS = Object.freeze(CHALLENGE_WATCH_CARD_ROWS.map((row) => row.key));

/**
 * The note every row carries when the determination's court-record search is
 * not admissible. It is repeated on each row deliberately: a caveat printed
 * once at the top of a page stops being read by the third row.
 */
export function inadmissibleCoverageNote(grade) {
  return `the court-record search behind this determination grades ${grade}; only ${ARTICLE78_COUNTABLE_COVERAGE_GRADES.join("/")} `
    + "are good enough to support a count, so nothing in this row can be read as a complete picture of the court record";
}

// ---------------------------------------------------------------------------
// Dates.
// ---------------------------------------------------------------------------

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function requireDay(value, fieldName) {
  if (typeof value !== "string" || !DATE_ONLY.test(value.trim())) {
    throw new Article78ChallengeWatchCardError(`${fieldName} must be an ISO date (YYYY-MM-DD), got ${JSON.stringify(value)}`);
  }
  return value.trim();
}

/**
 * Add whole days to an ISO date. The companion to A78-01's `addMonthsToDate`:
 * the service rule is expressed in days, and a day count added by hand in a
 * renderer is a day count nobody can test.
 */
export function addDaysToDate(date, days) {
  const iso = requireDay(date, "date");
  if (!Number.isInteger(days)) {
    throw new Article78ChallengeWatchCardError(`days must be an integer, got ${JSON.stringify(days)}`);
  }
  const [year, month, day] = iso.split("-").map((part) => Number(part));
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

/** The day an instant or date falls on, for comparison against a cutoff. */
function dayOf(value) {
  return typeof value === "string" && value.length >= 10 ? value.slice(0, 10) : null;
}

// ---------------------------------------------------------------------------
// A4: the clocks.
// ---------------------------------------------------------------------------

/**
 * Compute one deadline clock from one rule.
 *
 * Returns the whole computation rather than a date: the trigger event, the
 * date it happened on, the rule applied, the deadline that rule produces and
 * the state at `as_of`. A row that showed only the answer would be a row
 * nobody could argue with, and an unknown that showed only a blank would be
 * read as an absence of risk rather than an absence of a record.
 *
 * `trigger_date` of `null` produces `unknown` with the reason it was not
 * available. A recorded trigger dated after the cutoff also produces
 * `unknown`: as of that cutoff the record does not yet establish that the
 * clock started, and A78-04 excludes the evidence that would say otherwise.
 */
export function computeDeadlineClock({
  rule,
  trigger_date: triggerDate = null,
  as_of: asOf,
  stated_deadline: statedDeadline = null,
  unknown_reason: unknownReason = null,
} = {}) {
  if (!rule || typeof rule.rule_id !== "string") {
    throw new Article78ChallengeWatchCardError("computeDeadlineClock: rule must be one of ARTICLE78_DEADLINE_RULES");
  }
  const cutoff = requireDay(asOf, "as_of");
  const base = {
    clock: rule.clock,
    rule_id: rule.rule_id,
    statute: rule.statute,
    citation: rule.citation,
    rule_summary: rule.summary,
    rule_note: rule.note,
    trigger_event: rule.trigger_event,
    trigger_event_wording: rule.trigger_event_wording,
    trigger_source: rule.trigger_source,
    period: rule.period,
    period_wording: rule.period_wording,
    as_of: cutoff,
  };

  if (triggerDate === null || triggerDate === undefined) {
    const reason = unknownReason ?? "upstream_clock_unknown";
    if (!ARTICLE78_DEADLINE_CLOCK_UNKNOWN_REASONS.includes(reason)) {
      throw new Article78ChallengeWatchCardError(`computeDeadlineClock: unknown_reason ${JSON.stringify(reason)} is not one of ${JSON.stringify(ARTICLE78_DEADLINE_CLOCK_UNKNOWN_REASONS)}`);
    }
    return {
      ...base,
      trigger_date: null,
      deadline: null,
      deadline_source: null,
      state: "unknown",
      unknown_reason: reason,
      statement: `${rule.statute}: the triggering event (${rule.trigger_event_wording}) is not established as of ${cutoff}, so this clock is unknown and stays unknown`,
    };
  }

  const trigger = requireDay(triggerDate, "trigger_date");
  if (rule.trigger_is_recorded_event && trigger > cutoff) {
    return {
      ...base,
      trigger_date: trigger,
      deadline: null,
      deadline_source: null,
      state: "unknown",
      unknown_reason: "trigger_event_not_on_the_record_at_cutoff",
      statement: `${rule.statute}: the triggering event is dated ${trigger}, after the cutoff ${cutoff}, so as of that cutoff this clock has no established start`,
    };
  }

  const computed = rule.period.months !== undefined
    ? addMonthsToDate(trigger, rule.period.months)
    : addDaysToDate(trigger, rule.period.days);
  const useStated = typeof statedDeadline === "string" && DATE_ONLY.test(statedDeadline);
  const deadline = useStated ? statedDeadline : computed;
  const state = cutoff <= deadline ? "open" : "expired";
  return {
    ...base,
    trigger_date: trigger,
    deadline,
    deadline_source: useStated
      ? `stated on the determination context in ${rule.stated_deadline_field}`
      : "computed from the rule",
    computed_deadline: computed,
    state,
    unknown_reason: null,
    statement: state === "open"
      ? `${rule.statute}: ${rule.trigger_event_wording} on ${trigger}; ${rule.period_wording} is ${deadline}, which is on or after the cutoff ${cutoff}`
      : `${rule.statute}: ${rule.trigger_event_wording} on ${trigger}; ${rule.period_wording} is ${deadline}, which is before the cutoff ${cutoff}`,
  };
}

/** The limitations clock for one determination context, as of a cutoff. */
export function limitationsClockFor(determination, asOf) {
  const rule = ARTICLE78_DEADLINE_RULES.limitations;
  if (determination.finality === "unknown") {
    return computeDeadlineClock({ rule, trigger_date: null, as_of: asOf, unknown_reason: "determination_finality_unknown" });
  }
  if (determination.finality !== "final") {
    return computeDeadlineClock({ rule, trigger_date: null, as_of: asOf, unknown_reason: "determination_not_final" });
  }
  if (typeof determination.final_and_binding_date !== "string") {
    return computeDeadlineClock({ rule, trigger_date: null, as_of: asOf, unknown_reason: "final_and_binding_date_not_recorded" });
  }
  return computeDeadlineClock({
    rule,
    trigger_date: determination.final_and_binding_date,
    as_of: asOf,
    stated_deadline: determination.limitations_window_closes_on ?? null,
  });
}

/** The service clock, which runs from the limitations clock's deadline. */
export function serviceClockFor(limitationsClock, asOf) {
  return computeDeadlineClock({
    rule: ARTICLE78_DEADLINE_RULES.service,
    trigger_date: limitationsClock.deadline,
    as_of: asOf,
    unknown_reason: "upstream_clock_unknown",
  });
}

// ---------------------------------------------------------------------------
// Evidence.
// ---------------------------------------------------------------------------

/**
 * One evidence reference. `kind` says which record class the reference came
 * from, so a row citing two classes (a public position and a case caption)
 * stays legible as two kinds of evidence rather than one undifferentiated
 * list.
 */
function evidenceRef(record, { kind, dateField, detail }) {
  return {
    kind,
    source_id: record?.source_id ?? null,
    source_record_id: record?.source_record_id ?? null,
    public_date: dayOf(record?.[dateField]) ?? null,
    detail,
  };
}

function sortEvidence(refs) {
  const sortKey = (ref) => `${ref.public_date ?? ""}|${ref.kind}|${ref.source_record_id ?? ""}|${ref.detail}`;
  return [...refs].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
}

/**
 * Split one channel of A78-01 records at the cutoff, reusing A78-04's own
 * partition rather than a second implementation of the same rule. A78-01
 * records carry `observed_at` -- the instant the record entered the store --
 * which is the public date available for them.
 */
function splitAtCutoff(rows, asOf) {
  return partitionByCutoff(rows, { asOf, dateField: "observed_at" });
}

function excludedEvidenceEntries(channel, split, asOf) {
  const entries = [];
  if (split.excludedPublishedAfterCutoff.length > 0) {
    entries.push({
      channel,
      reason: "published_after_cutoff",
      count: split.excludedPublishedAfterCutoff.length,
      statement: `${split.excludedPublishedAfterCutoff.length} ${channel} record(s) were observed after the cutoff ${asOf} and are excluded from this row`,
    });
  }
  if (split.excludedNoPublicDate.length > 0) {
    entries.push({
      channel,
      reason: "no_public_date",
      count: split.excludedNoPublicDate.length,
      statement: `${split.excludedNoPublicDate.length} ${channel} record(s) carry no observation date and are excluded; an undated record cannot say what was knowable on a given day`,
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// The card.
// ---------------------------------------------------------------------------

function requireWatch(watch, determination, asOf) {
  if (!watch || typeof watch !== "object") {
    throw new Article78ChallengeWatchCardError("buildChallengeWatchCard: watch must be an A78-04 challenge-watch signal");
  }
  if (watch.label !== CHALLENGE_WATCH_LABEL) {
    throw new Article78ChallengeWatchCardError(
      `buildChallengeWatchCard: the watch must carry the ${JSON.stringify(CHALLENGE_WATCH_LABEL)} label, got ${JSON.stringify(watch.label)}`,
    );
  }
  if (watch.determination_key !== determination.determination_key) {
    throw new Article78ChallengeWatchCardError(
      `buildChallengeWatchCard: the watch is for ${JSON.stringify(watch.determination_key)}, not ${JSON.stringify(determination.determination_key)}`,
    );
  }
  if (dayOf(watch.as_of) !== asOf) {
    throw new Article78ChallengeWatchCardError(
      `buildChallengeWatchCard: the watch was derived as of ${JSON.stringify(watch.as_of)} and the card is as of ${JSON.stringify(asOf)}; `
      + "a card whose clocks and features disagree about the cutoff is a card that cannot be read",
    );
  }
  if (!ARTICLE78_COVERAGE_GRADES.includes(watch.coverage_grade)) {
    throw new Article78ChallengeWatchCardError(
      `buildChallengeWatchCard: the watch carries coverage grade ${JSON.stringify(watch.coverage_grade)}, which is not one of ${JSON.stringify(ARTICLE78_COVERAGE_GRADES)}`,
    );
  }
  return watch;
}

/**
 * Build one determination's challenge-watch card.
 *
 * `determination` is an A78-01 `determination_context`; `watch` is the A78-04
 * signal derived for it at the same `as_of` (the card refuses a mismatch);
 * `coverage`, `cases`, `filings`, `claims` and `supersessions` are the A78-01
 * records for the project. Every record channel is filtered at the cutoff and
 * the exclusions are reported on the rows that would have read them.
 *
 * Deterministic: no clock, no network, no ordering that depends on input
 * order. The card carries no level, no score and no verdict, and the nine rows
 * are the whole of it.
 */
export function buildChallengeWatchCard({
  determination,
  watch,
  project_id: projectId = null,
  project_name: projectName = null,
  coverage = [],
  cases = [],
  filings = [],
  claims = [],
  supersessions = [],
  as_of: asOf,
} = {}) {
  const findings = validateDeterminationContext(determination);
  if (findings.length > 0) {
    throw new Article78ChallengeWatchCardError(`buildChallengeWatchCard: ${findings.join("; ")}`);
  }
  const cutoff = requireDay(asOf, "as_of");
  requireWatch(watch, determination, cutoff);
  for (const [name, rows] of Object.entries({ coverage, cases, filings, claims, supersessions })) {
    if (!Array.isArray(rows)) throw new Article78ChallengeWatchCardError(`buildChallengeWatchCard: ${name} must be an array`);
  }

  const determinationKey = determination.determination_key;
  const coverageGrade = watch.coverage_grade;
  const coverageAdmissible = ARTICLE78_COUNTABLE_COVERAGE_GRADES.includes(coverageGrade);
  const admissibilityNote = coverageAdmissible ? null : inadmissibleCoverageNote(coverageGrade);
  const watchEstablished = watch.level !== "null";
  const watchNullStatement = watchEstablished ? null : watch.statement;

  // --- the record channels, each filtered at the cutoff --------------------
  const caseSplit = splitAtCutoff(cases.filter((row) => row.determination_key === determinationKey), cutoff);
  const caseKeys = new Set(caseSplit.included.map((row) => row.case_key));
  const decisionSplit = splitAtCutoff(
    filings.filter((row) => caseKeys.has(row.case_key) && ARTICLE78_DECISION_FILING_TYPES.includes(row.filing_type)),
    cutoff,
  );
  const decisionKeys = new Set(decisionSplit.included.map((row) => row.filing_key));
  // An edge whose endpoints are not both admitted at the cutoff cannot be
  // applied: A78-01 refuses an edge naming a decision it has not been given,
  // and dropping the edge silently would make a superseded decision read as
  // the effective one.
  const edgeSplit = splitAtCutoff(supersessions.filter((row) => caseKeys.has(row.case_key)), cutoff);
  const applicableEdges = edgeSplit.included.filter((row) => decisionKeys.has(row.superseding_decision_key) && decisionKeys.has(row.superseded_decision_key));
  const unappliedEdgeCount = edgeSplit.included.length - applicableEdges.length;
  const claimSplit = splitAtCutoff(claims.filter((row) => caseKeys.has(row.case_key)), cutoff);

  const effectiveByCase = new Map(
    applyDecisionSupersession(decisionSplit.included, applicableEdges).map((row) => [row.case_key, row]),
  );
  const decisionByKey = new Map(decisionSplit.included.map((row) => [row.filing_key, row]));
  const orderedCaseKeys = [...caseKeys].sort();

  const decisionExclusions = [
    ...excludedEvidenceEntries("decision filing", decisionSplit, cutoff),
    ...(unappliedEdgeCount > 0
      ? [{
        channel: "supersession edge",
        reason: "endpoint_excluded_at_cutoff",
        count: unappliedEdgeCount,
        statement: `${unappliedEdgeCount} supersession edge(s) name a decision that the cutoff excludes and are not applied`,
      }]
      : []),
  ];

  const rows = [];
  const rowContext = { coverageGrade, coverageAdmissible, admissibilityNote };

  // --- 1. named opponent or coalition --------------------------------------
  rows.push(namedOpponentRow({ watch, watchEstablished, watchNullStatement, caseSplit, cutoff, ...rowContext }));

  // --- 2. preserved issue ---------------------------------------------------
  rows.push(preservedIssueRow({ watch, watchEstablished, watchNullStatement, cutoff, ...rowContext }));

  // --- 3 and 4. the two clocks ---------------------------------------------
  const limitationsClock = limitationsClockFor(determination, cutoff);
  const serviceClock = serviceClockFor(limitationsClock, cutoff);
  // Both clocks stand on one record: the finality observation A78-01 carries
  // on the determination context. The service clock cites it too, because its
  // trigger is the limitations deadline computed from that same record.
  const finalityEvidence = determination.final_and_binding_date === null ? [] : [{
    kind: "determination_context",
    source_id: null,
    source_record_id: determinationKey,
    public_date: determination.final_and_binding_date,
    detail: `finality recorded as ${determination.finality}, final and binding on ${determination.final_and_binding_date}`,
  }];
  rows.push(clockRow("limitations_clock", limitationsClock, { ...rowContext, evidence: finalityEvidence }));
  rows.push(clockRow("service_clock", serviceClock, {
    ...rowContext,
    evidence: finalityEvidence.map((ref) => ({ ...ref, detail: `${ref.detail}; the limitations deadline computed from it is this clock's trigger` })),
  }));

  // --- 5. theory fit --------------------------------------------------------
  rows.push(theoryFitRow({ claimSplit, cutoff, ...rowContext }));

  // --- 6, 7, 8. the three separately recorded outcome fields ---------------
  rows.push(outcomeRow("procedural_exposure", {
    field: "procedural_survival",
    vocabulary: ARTICLE78_PROCEDURAL_SURVIVAL_STATES,
    absentStatement: (day) => `no decision recording a threshold ruling is on the record for this determination as of ${day}`,
    orderedCaseKeys, effectiveByCase, decisionByKey, exclusions: decisionExclusions, cutoff, ...rowContext,
  }));
  rows.push(outcomeRow("merits_indicators", {
    field: "durable_petitioner_relief",
    vocabulary: ARTICLE78_PETITIONER_RELIEF_STATES,
    absentStatement: (day) => `no decision recording what the petitioner obtained is on the record for this determination as of ${day}`,
    withSupersession: true,
    orderedCaseKeys, effectiveByCase, decisionByKey, exclusions: decisionExclusions, cutoff, ...rowContext,
  }));
  rows.push(outcomeRow("remedy_exposure", {
    field: "remedy_exposure",
    vocabulary: ARTICLE78_REMEDY_EXPOSURE_STATES,
    absentStatement: (day) => `no decision recording what the approved action was exposed to is on the record for this determination as of ${day}`,
    orderedCaseKeys, effectiveByCase, decisionByKey, exclusions: decisionExclusions, cutoff, ...rowContext,
  }));

  // --- 9. court-search coverage --------------------------------------------
  rows.push(coverageRow({ determination, coverage, watch, cutoff, ...rowContext }));

  const card = {
    schema: ARTICLE78_CHALLENGE_WATCH_CARD_SCHEMA,
    audience: CHALLENGE_WATCH_CARD_AUDIENCE,
    no_resident_conclusion: true,
    label: CHALLENGE_WATCH_LABEL,
    title: CHALLENGE_WATCH_CARD_TITLE,
    subtitle: CHALLENGE_WATCH_CARD_SUBTITLE,
    project_id: projectId,
    project_name: projectName,
    determination_key: determinationKey,
    as_of: cutoff,
    coverage_grade: coverageGrade,
    coverage_grade_admissible: coverageAdmissible,
    coverage_admissibility_note: admissibilityNote,
    watch_null_reason: watch.null_reason ?? null,
    deadline_rule_ids: Object.values(ARTICLE78_DEADLINE_RULES).map((rule) => rule.rule_id).sort(),
    rows,
    statement:
      `A ${CHALLENGE_WATCH_LABEL} over evidence recorded as of ${cutoff}, shown as ${CHALLENGE_WATCH_CARD_ROW_KEYS.length} separate components. `
      + "It is internal and diagnostic only: no component is a conclusion about how a court would rule, no component summarizes another, "
      + "and this card carries no combined figure of any kind.",
  };
  return assertChallengeWatchCard(card);
}

/** Assemble one row from its definition plus the values the builder computed. */
function makeRow(key, {
  state,
  value = null,
  detail = [],
  evidence = [],
  excluded_evidence: excluded = [],
  clock = null,
  suppression = null,
  statement,
  coverageGrade,
  coverageAdmissible,
  admissibilityNote,
}) {
  const definition = CHALLENGE_WATCH_CARD_ROWS.find((row) => row.key === key);
  if (!definition) throw new Article78ChallengeWatchCardError(`makeRow: unknown row ${JSON.stringify(key)}`);
  return {
    key: definition.key,
    label: definition.label,
    question: definition.question,
    rests_on: definition.rests_on,
    never_says: definition.never_says,
    state,
    value,
    detail,
    clock,
    evidence: sortEvidence(evidence),
    excluded_evidence: excluded,
    suppression,
    coverage_grade: coverageGrade,
    coverage_grade_admissible: coverageAdmissible,
    coverage_admissibility_note: admissibilityNote,
    statement,
  };
}

function namedOpponentRow({ watch, watchEstablished, watchNullStatement, caseSplit, cutoff, ...context }) {
  const features = watch.features ?? {};
  const opposition = features.organized_opposition ?? null;
  const labor = features.labor_organization_participation ?? null;
  // A labor organization on the record in opposition is present in both
  // features by construction -- it is a named participant and a labor
  // participant -- so the two are merged on identity here rather than printed
  // twice, which would read as two organizations.
  const namedByKey = new Map();
  const evidenceByKey = new Map();
  const addEvidence = (ref) => {
    const key = `${ref.kind}|${ref.source_record_id ?? ""}|${ref.detail}`;
    if (!evidenceByKey.has(key)) evidenceByKey.set(key, ref);
  };
  for (const feature of [opposition, labor]) {
    if (!feature?.present) continue;
    for (const key of feature.value ?? []) {
      const entry = namedByKey.get(key) ?? { kind: "public_position", name: key, features: [] };
      if (!entry.features.includes(feature.key)) entry.features.push(feature.key);
      namedByKey.set(key, entry);
    }
    for (const ref of feature.evidence ?? []) {
      addEvidence({
        kind: "public_position",
        source_id: ref.source_id ?? null,
        source_record_id: ref.source_record_id ?? null,
        public_date: dayOf(ref.public_date),
        detail: ref.detail,
      });
    }
  }
  const named = [...namedByKey.values()];
  for (const row of caseSplit.included) {
    if (typeof row.caption !== "string" || row.caption.trim() === "") continue;
    named.push({ kind: "case_caption", name: row.caption, features: [] });
    addEvidence(evidenceRef(row, { kind: "case_caption", dateField: "filed_date", detail: `case ${row.case_key} captioned ${row.caption}` }));
  }
  const evidence = [...evidenceByKey.values()];

  const excluded = excludedEvidenceEntries("judicial case", caseSplit, cutoff);
  const detail = [];
  if (!watchEstablished) detail.push(watchNullStatement);
  if (labor?.present) detail.push(labor.suppression_rule ?? labor.suppression);
  detail.push(...excluded.map((entry) => entry.statement));

  const state = named.length > 0 ? "on_the_record" : (watchEstablished ? "not_on_the_record" : "not_established");
  const statement = named.length > 0
    ? `named on the public record: ${named.map((entry) => entry.name).join("; ")}`
    : (watchEstablished
      ? `no organization is named on the public record in opposition to this determination as of ${cutoff}`
      : watchNullStatement);
  return makeRow("named_opponent_or_coalition", {
    state,
    value: named,
    detail,
    evidence,
    excluded_evidence: excluded,
    suppression: labor?.present ? LABOR_PARTICIPATION_SUPPRESSION : null,
    statement,
    ...context,
  });
}

function preservedIssueRow({ watch, watchEstablished, watchNullStatement, cutoff, ...context }) {
  const feature = watch.features?.preserved_issue ?? null;
  const issues = feature?.present ? (feature.value ?? []) : [];
  const evidence = (feature?.evidence ?? []).map((ref) => ({
    kind: "public_position",
    source_id: ref.source_id ?? null,
    source_record_id: ref.source_record_id ?? null,
    public_date: dayOf(ref.public_date),
    detail: ref.detail,
  }));
  const detail = [];
  if (!watchEstablished) detail.push(watchNullStatement);
  if (feature?.rival_explanation) detail.push(feature.rival_explanation);
  const state = issues.length > 0 ? "on_the_record" : (watchEstablished ? "not_on_the_record" : "not_established");
  const statement = issues.length > 0
    ? `named and reaffirmed on the record: ${issues.join("; ")}`
    : (watchEstablished
      ? `no issue is recorded as named and reaffirmed on the public record as of ${cutoff}`
      : watchNullStatement);
  return makeRow("preserved_issue", { state, value: issues, detail, evidence, statement, ...context });
}

function clockRow(key, clock, { evidence = [], ...context }) {
  const detail = [
    `rule: ${clock.rule_summary}`,
    `triggering event: ${clock.trigger_event_wording} (${clock.trigger_source})`,
    `period: ${clock.period_wording}`,
    clock.rule_note,
  ];
  return makeRow(key, {
    state: clock.state,
    value: {
      trigger_event: clock.trigger_event,
      trigger_date: clock.trigger_date,
      rule_id: clock.rule_id,
      statute: clock.statute,
      deadline: clock.deadline,
      deadline_source: clock.deadline_source,
      unknown_reason: clock.unknown_reason,
    },
    detail,
    clock,
    evidence,
    statement: clock.statement,
    ...context,
  });
}

function theoryFitRow({ claimSplit, cutoff, ...context }) {
  const recorded = [...claimSplit.included].sort((a, b) => (a.claim_key < b.claim_key ? -1 : 1)).map((row) => ({
    claim_key: row.claim_key,
    case_key: row.case_key,
    theory_category: row.theory_category,
    description: row.description,
    raised_in_filing_key: row.raised_in_filing_key ?? null,
  }));
  const evidence = claimSplit.included.map((row) => evidenceRef(row, {
    kind: "claim_theory",
    dateField: "observed_at",
    detail: `${row.theory_category} theory recorded on ${row.case_key}`,
  }));
  const excluded = excludedEvidenceEntries("claim theory", claimSplit, cutoff);
  const detail = [
    `the recorded categories come from A78-01's closed vocabulary: ${ARTICLE78_CLAIM_THEORY_CATEGORIES.join(", ")}`,
    "a recorded theory is what a petitioner argued, on the date the record shows it; whether it answers the preserved issue above is not derived here and is not a field on this card",
    ...excluded.map((entry) => entry.statement),
  ];
  return makeRow("theory_fit", {
    state: recorded.length > 0 ? "on_the_record" : "not_on_the_record",
    value: recorded,
    detail,
    evidence,
    excluded_evidence: excluded,
    statement: recorded.length > 0
      ? `${recorded.length} claim theory record(s) on this determination: ${recorded.map((row) => `${row.theory_category} (${row.case_key})`).join("; ")}`
      : `no claim theory naming this determination is on the record as of ${cutoff}`,
    ...context,
  });
}

function outcomeRow(key, {
  field,
  vocabulary,
  absentStatement,
  withSupersession = false,
  orderedCaseKeys,
  effectiveByCase,
  decisionByKey,
  exclusions,
  cutoff,
  ...context
}) {
  const value = [];
  const evidence = [];
  for (const caseKey of orderedCaseKeys) {
    const effective = effectiveByCase.get(caseKey) ?? null;
    const entry = {
      case_key: caseKey,
      [field]: effective?.case_outcome?.[field] ?? null,
      effective_decision_key: effective?.effective_decision_key ?? null,
      effective_decision_date: effective?.effective_decision_date ?? null,
      unresolved: effective?.unresolved ?? null,
    };
    if (withSupersession) {
      entry.superseded_decision_keys = effective?.superseded_decision_keys ?? [];
      entry.supersession_chain = effective?.supersession_chain ?? [];
    }
    value.push(entry);
    const decision = effective?.effective_decision_key ? decisionByKey.get(effective.effective_decision_key) : null;
    if (decision) {
      evidence.push(evidenceRef(decision, {
        kind: "decision_filing",
        dateField: "observed_at",
        detail: `${field} recorded as ${decision.decision?.[field] ?? "not recorded"} on ${decision.filing_key}`,
      }));
    }
  }
  const recorded = value.filter((entry) => entry[field] !== null);
  const detail = [
    `the recorded states come from A78-01's closed vocabulary: ${vocabulary.join(", ")}`,
    ...(withSupersession
      ? ["durability is a property of the effective decision after supersession, not of whichever decision was recorded first"]
      : []),
    ...value.filter((entry) => entry.unresolved).map((entry) => `${entry.case_key}: ${entry.unresolved}`),
    ...exclusions.map((entry) => entry.statement),
  ];
  return makeRow(key, {
    state: recorded.length > 0 ? "on_the_record" : "not_on_the_record",
    value,
    detail,
    evidence,
    excluded_evidence: exclusions,
    statement: recorded.length > 0
      ? recorded.map((entry) => `${entry.case_key}: ${entry[field]}`).join("; ")
      : absentStatement(cutoff),
    ...context,
  });
}

function coverageRow({ determination, coverage, watch, cutoff, ...context }) {
  const graded = gradeCoverage({ determination, receipts: coverage });
  const gradeFromReceipts = graded.grade ?? "U";
  const receipts = coverage.filter((row) => graded.coverage_keys.includes(row.coverage_key));
  const evidence = receipts.map((row) => evidenceRef(row, {
    kind: "search_coverage",
    dateField: "searched_at",
    detail: `${row.coverage_key} recorded grade ${row.coverage_grade}`,
  }));
  const locatedCandidates = [...new Set(receipts.flatMap((row) => row.located_case_keys ?? []))];
  const detail = [
    `the recorded searches list ${locatedCandidates.length} located case candidate(s); a candidate is what a search returned, not a finding that the case is about this determination`,
    `systems searched: ${graded.systems_searched.map((entry) => (entry.system === "other" ? `other:${entry.label}` : entry.system)).join(", ") || "none recorded"}`,
    `identifier variants tried: ${graded.identifiers_used.map((entry) => entry.kind).join(", ") || "none recorded"}`,
    `docket fields the sources could not show: ${graded.docket_details_unavailable.join(", ") || "none recorded"}`,
    `the searched window ${graded.horizon.spans_limitations_window ? "spans" : "does not span"} the whole limitations window`
      + (graded.horizon.margin_days_after_close === null || graded.horizon.margin_days_after_close === undefined
        ? ""
        : `; it closes ${graded.horizon.margin_days_after_close} day(s) after the window`),
    ...graded.reasons,
  ];
  if (gradeFromReceipts !== watch.coverage_grade) {
    detail.push(
      `the watch on this card rests on grade ${watch.coverage_grade}, which was supplied to the derivation rather than graded from these receipts; `
      + `grading the receipts here produces ${gradeFromReceipts}`,
    );
  }
  return makeRow("court_search_coverage", {
    state: graded.receipts_considered > 0 ? "on_the_record" : "not_on_the_record",
    value: {
      grade: watch.coverage_grade,
      grade_from_receipts: gradeFromReceipts,
      receipts_considered: graded.receipts_considered,
      coverage_keys: graded.coverage_keys,
      unusable_coverage_keys: graded.unusable_coverage_keys,
      spans_limitations_window: graded.horizon.spans_limitations_window,
      margin_days_after_close: graded.horizon.margin_days_after_close ?? null,
      docket_details_unavailable: graded.docket_details_unavailable,
      located_case_candidate_count: locatedCandidates.length,
    },
    detail,
    evidence,
    statement: graded.receipts_considered > 0
      ? `${graded.receipts_considered} recorded search(es) behind this determination, graded ${watch.coverage_grade} as of ${cutoff}`
      : `no court-record search for this determination is on file as of ${cutoff}`,
    ...context,
  });
}

// ---------------------------------------------------------------------------
// A1/A2/A3: the card's own rules, as a callable check.
// ---------------------------------------------------------------------------

/**
 * Field names this card may never carry, over and above A78-01's combined
 * outcome-score scanner. `level` is on the list for the reason the module
 * header gives: A78-04's level is a real and useful signal, and a level
 * printed above nine separated components is read as their summary whatever
 * the surrounding words say.
 */
export const FORBIDDEN_CARD_FIELD_TERMS = Object.freeze([
  "level",
  "verdict",
  "likelihood",
  "probability",
  "odds",
  "prediction",
  "forecast",
  "confidence",
  "rank",
  "ranking",
  "total",
  "aggregate",
]);

function normalizeFieldTerm(name) {
  const collapsed = String(name)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `_${collapsed}_`;
}

/** Every object key and every string anywhere in the card. */
function collectKeysAndStrings(value, keys = new Set(), strings = []) {
  if (typeof value === "string") {
    strings.push(value);
    return { keys, strings };
  }
  if (Array.isArray(value)) {
    for (const item of value) collectKeysAndStrings(item, keys, strings);
    return { keys, strings };
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      keys.add(key);
      collectKeysAndStrings(item, keys, strings);
    }
  }
  return { keys, strings };
}

/**
 * The card's contract, checked over the object rather than trusted of the
 * builder. Every rule this card exists for is here: nine rows in order, each
 * resting on its own named source, each carrying its own evidence and the
 * coverage grade it stands on, clocks reporting their inputs, and no field
 * anywhere that reads as a summary of the rest.
 */
export function assertChallengeWatchCard(card, context = "challenge watch card") {
  if (!card || typeof card !== "object") throw new Article78ChallengeWatchCardError(`${context}: malformed card`);
  if (card.schema !== ARTICLE78_CHALLENGE_WATCH_CARD_SCHEMA) {
    throw new Article78ChallengeWatchCardError(`${context}: schema must be ${JSON.stringify(ARTICLE78_CHALLENGE_WATCH_CARD_SCHEMA)}`);
  }
  if (card.audience !== CHALLENGE_WATCH_CARD_AUDIENCE) {
    throw new Article78ChallengeWatchCardError(`${context}: audience must be ${JSON.stringify(CHALLENGE_WATCH_CARD_AUDIENCE)}, got ${JSON.stringify(card.audience)}`);
  }
  if (card.no_resident_conclusion !== true) {
    throw new Article78ChallengeWatchCardError(`${context}: no_resident_conclusion must be true; this card publishes no resident-facing legal conclusion`);
  }
  if (card.label !== CHALLENGE_WATCH_LABEL) {
    throw new Article78ChallengeWatchCardError(`${context}: the card must be labelled ${JSON.stringify(CHALLENGE_WATCH_LABEL)}, got ${JSON.stringify(card.label)}`);
  }
  if (!card.title.includes(CHALLENGE_WATCH_LABEL)) {
    throw new Article78ChallengeWatchCardError(`${context}: the title must carry the ${JSON.stringify(CHALLENGE_WATCH_LABEL)} label`);
  }
  if (!DATE_ONLY.test(String(card.as_of))) {
    throw new Article78ChallengeWatchCardError(`${context}: as_of must be an ISO date, got ${JSON.stringify(card.as_of)}`);
  }

  const rows = card.rows;
  if (!Array.isArray(rows) || rows.length !== CHALLENGE_WATCH_CARD_ROW_KEYS.length) {
    throw new Article78ChallengeWatchCardError(
      `${context}: the card has exactly ${CHALLENGE_WATCH_CARD_ROW_KEYS.length} rows and no tenth; got ${Array.isArray(rows) ? rows.length : "no rows"}`,
    );
  }
  if (rows.map((row) => row.key).join("|") !== CHALLENGE_WATCH_CARD_ROW_KEYS.join("|")) {
    throw new Article78ChallengeWatchCardError(
      `${context}: rows must appear once each in the documented order ${JSON.stringify(CHALLENGE_WATCH_CARD_ROW_KEYS)}, got ${JSON.stringify(rows.map((row) => row.key))}`,
    );
  }

  const sources = new Set();
  for (const row of rows) {
    const definition = CHALLENGE_WATCH_CARD_ROWS.find((entry) => entry.key === row.key);
    for (const field of ["label", "question", "rests_on", "never_says", "statement"]) {
      if (typeof row[field] !== "string" || row[field].trim() === "") {
        throw new Article78ChallengeWatchCardError(`${context}: row ${JSON.stringify(row.key)} carries no ${field}`);
      }
    }
    if (row.rests_on !== definition.rests_on) {
      throw new Article78ChallengeWatchCardError(`${context}: row ${JSON.stringify(row.key)} must rest on its documented source`);
    }
    if (sources.has(row.rests_on)) {
      throw new Article78ChallengeWatchCardError(
        `${context}: two rows rest on ${JSON.stringify(row.rests_on)}; two rows over one fact is one fact reported twice, and one of them would be summarizing the other`,
      );
    }
    sources.add(row.rests_on);
    if (!CHALLENGE_WATCH_CARD_ROW_STATES.includes(row.state)) {
      throw new Article78ChallengeWatchCardError(`${context}: row ${JSON.stringify(row.key)} state ${JSON.stringify(row.state)} is not one of ${JSON.stringify(CHALLENGE_WATCH_CARD_ROW_STATES)}`);
    }
    const isClock = CHALLENGE_WATCH_CARD_CLOCK_ROW_KEYS.includes(row.key);
    if (isClock !== ARTICLE78_DEADLINE_CLOCK_STATES.includes(row.state)) {
      throw new Article78ChallengeWatchCardError(
        `${context}: row ${JSON.stringify(row.key)} carries state ${JSON.stringify(row.state)}; only the clock rows report clock states, and they report nothing else`,
      );
    }
    if (!Array.isArray(row.evidence)) {
      throw new Article78ChallengeWatchCardError(`${context}: row ${JSON.stringify(row.key)} must carry its own evidence references`);
    }
    if (row.state === "on_the_record" && row.evidence.length === 0) {
      throw new Article78ChallengeWatchCardError(
        `${context}: row ${JSON.stringify(row.key)} reports a record and cites none; a component with no evidence reference is a claim nobody can check`,
      );
    }
    // A3: every component displays the grade it rests on, on its own row.
    if (row.coverage_grade !== card.coverage_grade || !ARTICLE78_COVERAGE_GRADES.includes(row.coverage_grade)) {
      throw new Article78ChallengeWatchCardError(
        `${context}: row ${JSON.stringify(row.key)} must display the court-search coverage grade it rests on (${JSON.stringify(card.coverage_grade)}), got ${JSON.stringify(row.coverage_grade)}`,
      );
    }
    if (row.coverage_grade_admissible === false && typeof row.coverage_admissibility_note !== "string") {
      throw new Article78ChallengeWatchCardError(`${context}: row ${JSON.stringify(row.key)} rests on an inadmissible grade and must say so on the row`);
    }
    if (isClock) {
      // A4: the clock's inputs travel with its answer.
      const clock = row.clock;
      if (!clock || !Object.values(ARTICLE78_DEADLINE_RULES).some((rule) => rule.rule_id === clock.rule_id)) {
        throw new Article78ChallengeWatchCardError(`${context}: row ${JSON.stringify(row.key)} must carry a clock computed from a documented deadline rule`);
      }
      for (const field of ["trigger_event", "trigger_event_wording", "period_wording", "statute", "citation"]) {
        if (typeof clock[field] !== "string" || clock[field].trim() === "") {
          throw new Article78ChallengeWatchCardError(`${context}: row ${JSON.stringify(row.key)} clock carries no ${field}`);
        }
      }
      if (clock.state !== row.state) {
        throw new Article78ChallengeWatchCardError(`${context}: row ${JSON.stringify(row.key)} state and clock state disagree`);
      }
      if ((clock.state === "unknown") !== (clock.deadline === null)) {
        throw new Article78ChallengeWatchCardError(
          `${context}: row ${JSON.stringify(row.key)} must report a deadline exactly when the clock is not unknown; unknown stays unknown`,
        );
      }
      if (clock.state === "unknown" && !ARTICLE78_DEADLINE_CLOCK_UNKNOWN_REASONS.includes(clock.unknown_reason)) {
        throw new Article78ChallengeWatchCardError(`${context}: row ${JSON.stringify(row.key)} unknown clock must name a documented reason`);
      }
      if (clock.state !== "unknown" && clock.as_of !== card.as_of) {
        throw new Article78ChallengeWatchCardError(`${context}: row ${JSON.stringify(row.key)} clock was computed as of a different cutoff than the card`);
      }
    } else if (row.clock !== null) {
      throw new Article78ChallengeWatchCardError(`${context}: row ${JSON.stringify(row.key)} is not a clock row and must not carry one`);
    }
  }

  const { keys, strings } = collectKeysAndStrings(card);
  assertNoCombinedOutcomeScore([...keys], context);
  const offenders = [];
  for (const key of keys) {
    const normalized = normalizeFieldTerm(key);
    for (const term of FORBIDDEN_CARD_FIELD_TERMS) {
      if (normalized.includes(`_${term}_`)) offenders.push({ field: key, term });
    }
  }
  if (offenders.length > 0) {
    throw new Article78ChallengeWatchCardError(
      `${context}: this card carries no overall score, verdict or likelihood; nine components are reported separately and are never reduced to one. Offending field(s) ${JSON.stringify(offenders)}`,
    );
  }
  assertNoChallengeWatchPredictionWording(strings, context);
  assertNoForbiddenChallengeWatchWording(strings, context);
  return card;
}

// ---------------------------------------------------------------------------
// The renderer.
// ---------------------------------------------------------------------------

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function humanize(value) {
  return String(value).replace(/_/g, " ");
}

const STYLE = `
    :root { color-scheme: light; }
    body { margin: 0; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1c1c1c; background: #f4f4f2; }
    main { max-width: 56rem; margin: 0 auto; padding: 1.5rem 1.25rem 4rem; }
    .internal-banner { background: #3a2f00; color: #fff6d8; padding: 0.65rem 1rem; border-radius: 6px; font-weight: 600; }
    .internal-banner span { display: block; font-weight: 400; font-size: 0.85rem; opacity: 0.92; }
    h1 { font-size: 1.3rem; margin: 1.25rem 0 0.35rem; }
    .subtitle { font-size: 0.9rem; color: #444; margin: 0 0 0.75rem; }
    .subject { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.78rem; color: #555; word-break: break-all; }
    .cutoff { font-size: 0.85rem; color: #444; }
    .watch-row { margin-top: 1.5rem; padding: 0.85rem 1rem; background: #ffffff; border: 1px solid #dcdcd6; border-left: 5px solid #4a4a44; border-radius: 5px; }
    .watch-row h2 { font-size: 1rem; margin: 0 0 0.2rem; }
    .row-question { font-size: 0.85rem; color: #555; margin: 0 0 0.6rem; }
    .chips { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-bottom: 0.6rem; }
    .chip { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; padding: 0.15rem 0.45rem; border-radius: 3px; background: #ececE6; color: #333; }
    .chip.state-on_the_record { background: #1f5c3a; color: #ffffff; }
    .chip.state-not_on_the_record { background: #efe4bd; color: #4a3d10; border: 1px dashed #8a7a3a; }
    .chip.state-not_established { background: #e8e4f2; color: #33265c; border: 1px dashed #5a4a9a; }
    .chip.state-open { background: #27408b; color: #ffffff; }
    .chip.state-expired { background: #5c5c56; color: #ffffff; }
    .chip.state-unknown { background: #efe4bd; color: #4a3d10; border: 1px dashed #8a7a3a; }
    .chip.grade { background: #23384f; color: #ffffff; }
    .chip.grade-inadmissible { background: #7a2f2f; color: #ffffff; }
    .row-statement { margin: 0 0 0.5rem; font-weight: 500; }
    .row-meta { font-size: 0.82rem; color: #444; margin: 0.15rem 0; }
    .row-meta .field { font-weight: 600; }
    ul.detail, ul.evidence { margin: 0.35rem 0 0.35rem 1.1rem; padding: 0; font-size: 0.84rem; color: #3a3a34; }
    ul.evidence { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.76rem; }
    table.clock { border-collapse: collapse; margin: 0.4rem 0; font-size: 0.84rem; }
    table.clock th { text-align: left; padding: 0.15rem 0.75rem 0.15rem 0; color: #555; font-weight: 600; vertical-align: top; white-space: nowrap; }
    table.clock td { padding: 0.15rem 0; }
    .never-says { margin-top: 0.5rem; padding: 0.35rem 0.5rem; background: #f4f2ea; border-left: 3px solid #8a7a3a; font-size: 0.82rem; color: #4a4238; }
    .excluded { margin-top: 0.4rem; font-size: 0.82rem; color: #6a3a3a; }
    footer { margin-top: 2.5rem; font-size: 0.8rem; color: #555; border-top: 1px solid #d5d5d0; padding-top: 0.75rem; }
`;

function renderList(className, items) {
  const kept = items.filter((item) => typeof item === "string" && item.trim() !== "");
  if (kept.length === 0) return [];
  return [
    `        <ul class="${className}">`,
    ...kept.map((item) => `          <li>${escapeHtml(item)}</li>`),
    "        </ul>",
  ];
}

function renderClockTable(clock) {
  const rows = [
    ["Rule applied", `${clock.statute} (${clock.citation}) - ${clock.rule_id}`],
    ["Triggering event", clock.trigger_event_wording],
    ["Trigger date", clock.trigger_date ?? "not established as of the cutoff"],
    ["Period", clock.period_wording],
    ["Computed deadline", clock.deadline ?? "unknown; the trigger is not established, so no deadline is computed"],
    ["Deadline source", clock.deadline_source ?? "not computed"],
    ["State at the cutoff", clock.state === "unknown" ? `unknown (${humanize(clock.unknown_reason)})` : clock.state],
  ];
  return [
    '        <table class="clock">',
    ...rows.flatMap(([field, value]) => [
      "          <tr>",
      `            <th>${escapeHtml(field)}</th>`,
      `            <td>${escapeHtml(value)}</td>`,
      "          </tr>",
    ]),
    "        </table>",
  ];
}

function renderRow(row) {
  const gradeChipClass = row.coverage_grade_admissible ? "chip grade" : "chip grade grade-inadmissible";
  return [
    `      <section class="watch-row" data-row-key="${escapeHtml(row.key)}" data-row-state="${escapeHtml(row.state)}" data-coverage-grade="${escapeHtml(row.coverage_grade)}">`,
    `        <h2>${escapeHtml(row.label)}</h2>`,
    `        <p class="row-question">${escapeHtml(row.question)}</p>`,
    '        <div class="chips">',
    `          <span class="chip state-${escapeHtml(row.state)}">${escapeHtml(humanize(row.state))}</span>`,
    `          <span class="${gradeChipClass}">court-search coverage ${escapeHtml(row.coverage_grade)}</span>`,
    "        </div>",
    `        <p class="row-statement">${escapeHtml(row.statement)}</p>`,
    ...(row.clock ? renderClockTable(row.clock) : []),
    `        <p class="row-meta"><span class="field">Rests on:</span> ${escapeHtml(row.rests_on)}</p>`,
    ...(row.coverage_grade_admissible ? [] : [`        <p class="row-meta"><span class="field">Coverage:</span> ${escapeHtml(row.coverage_admissibility_note)}</p>`]),
    ...(row.suppression ? [`        <p class="row-meta"><span class="field">Suppression:</span> ${escapeHtml(row.suppression)}</p>`] : []),
    ...renderList("detail", row.detail),
    ...(row.evidence.length > 0
      ? renderList("evidence", row.evidence.map((ref) => `${ref.kind} ${ref.source_record_id ?? "no record id"} (public ${ref.public_date ?? "date not recorded"}): ${ref.detail}`))
      : ['        <p class="row-meta">No evidence reference is attached to this row.</p>']),
    ...(row.excluded_evidence.length > 0
      ? [`        <p class="excluded">${escapeHtml(row.excluded_evidence.map((entry) => entry.statement).join("; "))}</p>`]
      : []),
    `        <p class="never-says">This row never says: ${escapeHtml(row.never_says)}</p>`,
    "      </section>",
  ];
}

/**
 * Render one card as a standalone internal page.
 *
 * The output carries no anchor at all. That is the simplest form of the
 * audience boundary this card is under: a page with no link cannot link into
 * a resident route, and `assertRenderedCard` checks it rather than trusting
 * that nobody adds one.
 */
export function renderChallengeWatchCard(card) {
  assertChallengeWatchCard(card, "renderChallengeWatchCard");
  const html = [
    "<!doctype html>",
    '<html lang="en">',
    "  <head>",
    '    <meta charset="utf-8">',
    '    <meta name="viewport" content="width=device-width, initial-scale=1">',
    '    <meta name="robots" content="noindex, nofollow">',
    `    <title>${escapeHtml(card.title)} - ${escapeHtml(card.project_id ?? card.determination_key)}</title>`,
    `    <style>${STYLE}    </style>`,
    "  </head>",
    `  <body data-audience="${escapeHtml(card.audience)}" data-no-resident-conclusion="true" data-schema="${escapeHtml(card.schema)}">`,
    "    <main>",
    `      <div class="internal-banner">${escapeHtml(card.title)}`,
    "        <span>An internal review page. It is not served by the site, has no route, is linked from no resident page, and states no legal conclusion.</span>",
    "      </div>",
    `      <h1>${escapeHtml(card.project_name ?? card.project_id ?? "Environmental review determination")}</h1>`,
    `      <p class="subtitle">${escapeHtml(card.subtitle)}</p>`,
    `      <p class="subject">${escapeHtml(card.determination_key)}</p>`,
    `      <p class="cutoff">Evidence recorded as of ${escapeHtml(card.as_of)}. Court-search coverage grade ${escapeHtml(card.coverage_grade)}`
      + `${card.coverage_grade_admissible ? "" : ` - ${escapeHtml(card.coverage_admissibility_note)}`}.</p>`,
    ...card.rows.flatMap(renderRow),
    "      <footer>",
    `        <p>${escapeHtml(card.statement)}</p>`,
    `        <p>Deadline rules applied: ${escapeHtml(card.deadline_rule_ids.join(", "))}. Generated into warehouse/reports/challenge-watch-cards/ by the environmental-review litigation backtest command; edit the builder, never the output.</p>`,
    "      </footer>",
    "    </main>",
    "  </body>",
    "</html>",
    "",
  ].join("\n");
  return assertRenderedCard({
    schema: ARTICLE78_CHALLENGE_WATCH_CARD_SCHEMA,
    determination_key: card.determination_key,
    project_id: card.project_id,
    file_name: challengeWatchCardFileName(card),
    html,
    row_keys: card.rows.map((row) => row.key),
  });
}

/** The card's file name: the project it is about, or its determination key. */
export function challengeWatchCardFileName(card) {
  const stem = card.project_id ?? card.determination_key;
  return `${String(stem).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase()}.html`;
}

/** Route markers a rendered card must never carry. */
const RESIDENT_ROUTE_MARKERS = Object.freeze(["<a ", "href=", "site/", "/browse/", "/now/", "cityscroll.nyc"]);

/**
 * The rendered page's own boundary check: internal audience declared, every
 * row present, and no link or resident route anywhere in the markup.
 */
export function assertRenderedCard(rendered, context = "rendered challenge watch card") {
  const { html } = rendered;
  if (typeof html !== "string" || html.trim() === "") throw new Article78ChallengeWatchCardError(`${context}: empty render`);
  if (!html.includes(`data-audience="${CHALLENGE_WATCH_CARD_AUDIENCE}"`)) {
    throw new Article78ChallengeWatchCardError(`${context}: the page must declare its internal audience`);
  }
  if (!html.includes('data-no-resident-conclusion="true"')) {
    throw new Article78ChallengeWatchCardError(`${context}: the page must declare that it publishes no resident-facing conclusion`);
  }
  if (!html.includes(CHALLENGE_WATCH_CARD_TITLE)) {
    throw new Article78ChallengeWatchCardError(`${context}: the page header must read ${JSON.stringify(CHALLENGE_WATCH_CARD_TITLE)}`);
  }
  for (const key of CHALLENGE_WATCH_CARD_ROW_KEYS) {
    if (!html.includes(`data-row-key="${key}"`)) {
      throw new Article78ChallengeWatchCardError(`${context}: row ${JSON.stringify(key)} is not rendered`);
    }
  }
  const found = RESIDENT_ROUTE_MARKERS.filter((marker) => html.includes(marker));
  if (found.length > 0) {
    throw new Article78ChallengeWatchCardError(
      `${context}: an internal card carries no link and names no resident route; found ${JSON.stringify(found)}`,
    );
  }
  assertNoChallengeWatchPredictionWording([html], context);
  assertNoForbiddenChallengeWatchWording([html], context);
  return rendered;
}

// ---------------------------------------------------------------------------
// The cutoff a rendered card is built at.
// ---------------------------------------------------------------------------

/**
 * The close of the recorded observation window across a set of records: the
 * latest date anything about this determination was observed.
 *
 * A card needs a cutoff and must not read a clock, so the cutoff has to come
 * from the records themselves. This is the honest one for a review page: it is
 * the last day the record has anything to say, so nothing recorded is hidden
 * behind it and nothing after it is invented. A caller wanting an earlier
 * cutoff -- to see what the card looked like before a decision landed -- passes
 * one instead; A78-05's `resolveBacktestCutoff` owns the cutoff policies the
 * backtest scores at, and this is not a fourth one.
 *
 * Returns null when nothing in the set carries a usable date.
 */
export function latestRecordedObservation(recordGroups = [], dateFields = ["observed_at", "searched_at", "available_to_public_at"]) {
  const days = [];
  for (const rows of recordGroups) {
    for (const row of rows ?? []) {
      for (const field of dateFields) {
        const day = dayOf(row?.[field]);
        if (day !== null && DATE_ONLY.test(day)) days.push(day);
      }
    }
  }
  days.sort();
  return days.length > 0 ? days[days.length - 1] : null;
}
