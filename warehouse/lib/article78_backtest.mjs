/**
 * A78-05: the litigation backtest, with filing and durable relief scored as
 * two independent heads.
 *
 * A single number over this fixture would be a lie of composition. Detecting
 * that somebody filed is easy -- a challenge leaves a docket entry, and the
 * recorded search either found it or did not. Saying whether the petitioner
 * ended up with relief they kept is hard, and it is the part a resident
 * actually cares about. Blend the two and strong filing detection carries the
 * weak relief calibration on its back, and nobody can see which half moved
 * when a feature changes. So there are two heads here, they are scored over
 * their own units against their own thresholds, and there is no code path
 * that reduces them to one figure: `assertHeadsScoredSeparately` refuses any
 * emitted field name that reads like a combined score, using A78-01's own
 * scanner rather than a second list.
 *
 * The second thing this module exists for is the **censored** class. A
 * determination whose limitations window is still open at the cutoff has not
 * produced a negative -- it has produced a not-yet. Counting those as true
 * negatives is the single easiest way to manufacture a specificity number out
 * of nothing, so censored rows are a class of their own, are never counted in
 * any confusion cell, and carry the reason they were censored.
 *
 * What the two heads ask:
 *
 *  - **filing** -- did the recorded search locate a genuine challenge to this
 *    determination? Scored one row per located case candidate, so a candidate
 *    that turns out to belong to a different determination is a false
 *    positive rather than a silently dropped row. A determination whose
 *    search located nothing contributes one no-detection row.
 *  - **durable relief** -- did the petitioner obtain durable relief that
 *    survived supersession? Scored one row per genuine challenge, plus one row
 *    per eligible determination with no genuine challenge on the record: a
 *    relief diagnostic computed only over determinations that were litigated
 *    conditions on the filing outcome and can say nothing about the ones that
 *    were not.
 *
 * Both heads predict from the same evidence -- A78-04's challenge-watch level
 * at the unit's cutoff -- and differ only in the threshold each applies, which
 * is the whole point: `ARTICLE78_BACKTEST_POLICY.heads[*].predicted_positive_levels`
 * is one object a reader can print, and moving a threshold moves exactly one
 * head's numbers.
 *
 * Everything here is diagnostic-only. The fixture is thirteen hand-picked
 * projects chosen for being interesting (A78-02), so every count below
 * describes that selection and nothing else. Each one leaves this module
 * through A78-02's `diagnosticMetric`, and `backtestLitigation` fetches
 * nothing, reads no clock, and takes its cutoffs as an explicit policy.
 */

import {
  applyDecisionSupersession,
  ARTICLE78_DECISION_FILING_TYPES,
  ARTICLE78_PETITIONER_RELIEF_STATES,
  assertNoCombinedOutcomeScore,
  limitationsWindow,
} from "./article78_litigation.mjs";
import { deriveChallengeWatch } from "./article78_challenge_watch.mjs";
import { admitNegatives } from "./article78_search_coverage.mjs";
import { diagnosticMetric, loadHistoricalFixture } from "./article78_historical_fixture.mjs";

export const ARTICLE78_LITIGATION_BACKTEST_SCHEMA = "cityscroll.article78_litigation_backtest.v1";

export class Article78BacktestError extends Error {
  constructor(message) {
    super(message);
    this.name = "Article78BacktestError";
  }
}

// ---------------------------------------------------------------------------
// A1: two heads, and the classes each one reports.
// ---------------------------------------------------------------------------

/** The two heads. There is no third head, and there is no head that combines them. */
export const ARTICLE78_BACKTEST_HEADS = Object.freeze(["filing", "durable_relief"]);

/**
 * The five classes a scored row can land in. `censored` is deliberately in the
 * same list as the four confusion cells rather than kept beside them: a row is
 * in exactly one of these, and a reader counting the list gets the whole
 * denominator back.
 */
export const ARTICLE78_BACKTEST_OUTCOME_CLASSES = Object.freeze([
  "true_positive",
  "false_positive",
  "false_negative",
  "true_negative",
  "censored",
]);

/** The four cells `censored` is not. Used to assert a censored row never enters one. */
export const ARTICLE78_BACKTEST_CONFUSION_CELLS = Object.freeze([
  "true_positive",
  "false_positive",
  "false_negative",
  "true_negative",
]);

/**
 * Why a row is censored. Each reason is a statement about what the record
 * could not yet settle at the cutoff, never a statement about what happened.
 */
export const ARTICLE78_BACKTEST_CENSORING_REASONS = Object.freeze([
  "determination_not_final_at_cutoff",
  "open_limitations_window",
  "pending_appeal",
]);

/** Why a determination never entered either head at all. Kept separate from censoring. */
export const ARTICLE78_BACKTEST_EXCLUSION_REASONS = Object.freeze([
  "coverage_grade_not_admissible",
]);

// ---------------------------------------------------------------------------
// The cutoff policy.
// ---------------------------------------------------------------------------

/**
 * How each unit's cutoff is chosen. A backtest with an implicit cutoff is a
 * backtest that has already leaked: the prediction must only see evidence
 * public by a stated instant, and the instant has to be stated somewhere a
 * reader can argue with.
 *
 *  - `determination_final` -- the day the determination became final and
 *    binding. This is the earliest moment a challenge watch could be acted on
 *    and the moment the limitations window opens, so it is the honest default:
 *    it also means no negative in this fixture is determinable yet, which the
 *    censored counts then say out loud.
 *  - `observation_close` -- the last recorded search behind the determination
 *    (A78-01's own `as_of`). A later cutoff sees more evidence and settles more
 *    negatives; it can never settle fewer.
 *  - `explicit` -- every cutoff comes from `cutoffs`, keyed by determination.
 *
 * `cutoffs` may accompany any policy and overrides that policy for the
 * determinations it names, which is what makes "move one unit's cutoff and
 * watch the classes move" a thing a test can do.
 */
export const ARTICLE78_AS_OF_POLICY_IDS = Object.freeze([
  "determination_final",
  "observation_close",
  "explicit",
]);

export const DEFAULT_AS_OF_POLICY = Object.freeze({ policy: "determination_final", cutoffs: Object.freeze({}) });

// ---------------------------------------------------------------------------
// A1/A4: the policy, as one object.
// ---------------------------------------------------------------------------

/**
 * Which relief states count as durable relief obtained.
 *
 * A78-01 records six relief states and this head asks a binary question, so
 * the mapping has to be stated rather than assumed. Four states give the
 * petitioner something that changed the determination and that they kept.
 * `remand_for_further_agency_action` is recorded by A78-01 as real relief and
 * is deliberately **not** scored as durable here: a remand returns the matter
 * to the agency for a determination that has not been made, so what the
 * petitioner ends up keeping is not yet on the record. It is listed with its
 * reason in `relief_states_not_scored_durable` rather than quietly omitted, so
 * a later card can move it by editing this object rather than by finding the
 * conditional that implied it.
 */
export const DURABLE_RELIEF_STATES = Object.freeze([
  "annulment",
  "declaratory_relief",
  "injunctive_relief",
  "relief_by_stipulation",
]);

export const ARTICLE78_BACKTEST_POLICY = Object.freeze({
  policy_id: "cityscroll.article78_litigation_backtest.policy.v1",
  heads: Object.freeze({
    filing: Object.freeze({
      head: "filing",
      question: "did the recorded search locate a genuine challenge to this determination?",
      unit: "one row per located case candidate, plus one row per eligible determination whose recorded search located no candidate",
      // A watch that is established at all says this determination is final,
      // adequately searched, and inside a challenge window -- which on this
      // fixture is enough to expect a filing. The threshold is permissive on
      // purpose, and the head's own false-positive count is what makes that
      // visible rather than flattering.
      predicted_positive_levels: Object.freeze(["baseline", "elevated", "high"]),
    }),
    durable_relief: Object.freeze({
      head: "durable_relief",
      question: "did the petitioner obtain durable relief that survived supersession?",
      unit: "one row per genuine located challenge, plus one row per eligible determination with no genuine challenge on the record",
      // Strictly higher than the filing threshold. Relief is rare, and a
      // threshold that fires on every established watch would report the
      // filing head's recall a second time under a different name.
      predicted_positive_levels: Object.freeze(["elevated", "high"]),
    }),
  }),
  durable_relief_states: DURABLE_RELIEF_STATES,
  relief_states_not_scored_durable: Object.freeze([
    Object.freeze({
      relief_state: "none",
      reason: "the effective decision granted the petitioner nothing",
    }),
    Object.freeze({
      relief_state: "remand_for_further_agency_action",
      reason: "a remand returns the matter to the agency for a determination that has not been made, so what the petitioner keeps is not yet on the record; A78-01 still records it as relief, and this head's refusal to score it as durable is a scoring choice, not a re-reading of the ontology",
    }),
  ]),
  // A case with no effective decision is scored as no durable relief obtained
  // on the record rather than censored: the censored class is about what the
  // cutoff could not settle, and this is a recorded state at the cutoff. It is
  // named here because it is arguable, and because a later card that wants it
  // censored should move it here rather than in a branch.
  undecided_case_outcome: "no_durable_relief_on_the_record",
  censoring_reasons: ARTICLE78_BACKTEST_CENSORING_REASONS,
  exclusion_reasons: ARTICLE78_BACKTEST_EXCLUSION_REASONS,
  eligibility: "A78-03 admitNegatives: a determination whose court-record search grades C or U never enters either head, in either direction",
  as_of_policies: ARTICLE78_AS_OF_POLICY_IDS,
  default_as_of_policy: DEFAULT_AS_OF_POLICY.policy,
  diagnostic_only: true,
  scope: "fixture",
  statement:
    "Filing and durable relief are scored as two independent heads over a hand-picked QA fixture. "
    + "Every count is a fixture diagnostic: it describes this selection of thirteen projects and is "
    + "never a measurement of how often challenges are filed or how often petitioners obtain relief.",
});

// ---------------------------------------------------------------------------
// A2: the documented seed diagnostic, as the oracle.
// ---------------------------------------------------------------------------

/**
 * The counts the historical fixture is documented to produce under the default
 * cutoff policy. This is the receipt the command reproduces and the oracle the
 * test asserts, so it lives here as data rather than being restated in three
 * places that can drift apart.
 *
 * The filing head's single false positive is the deliberate one A78-02 built
 * in: a candidate the recorded search returned for one determination that in
 * fact belongs to another. It is retained rather than cleaned up, because a
 * search-detection diagnostic with no false positive in it is not measuring
 * detection.
 *
 * The filing head has no true negatives at all under this policy, and that is
 * the honest reading rather than a gap: at the moment each determination
 * became final, no "nobody filed" was yet a fact, so both candidate negatives
 * are censored instead.
 */
export const ARTICLE78_BACKTEST_SEED_DIAGNOSTIC = Object.freeze({
  as_of_policy: DEFAULT_AS_OF_POLICY.policy,
  heads: Object.freeze({
    filing: Object.freeze({
      true_positive: 10,
      false_positive: 1,
      false_negative: 0,
      true_negative: 0,
      censored: 2,
    }),
    durable_relief: Object.freeze({
      true_positive: 1,
      false_positive: 3,
      false_negative: 0,
      true_negative: 6,
      censored: 3,
    }),
  }),
  note:
    "Fixture diagnostics over A78-02's thirteen documented projects, never population performance. "
    + "The filing head's one false positive is the fixture's deliberate mis-attributed search result.",
});

// ---------------------------------------------------------------------------
// Cutoff plumbing.
// ---------------------------------------------------------------------------

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** The date part of an ISO date or date-time, for comparison against a window bound. */
function toDay(value, fieldName) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Article78BacktestError(`${fieldName} must be a non-empty ISO date or date-time string`);
  }
  const text = value.trim();
  const day = text.slice(0, 10);
  if (!DATE_ONLY.test(day) || Number.isNaN(new Date(`${day}T00:00:00Z`).getTime())) {
    throw new Article78BacktestError(`${fieldName} must be a parseable ISO date or date-time, got ${JSON.stringify(value)}`);
  }
  return day;
}

function normalizeAsOfPolicy(asOfPolicy) {
  if (asOfPolicy === undefined || asOfPolicy === null) return DEFAULT_AS_OF_POLICY;
  if (typeof asOfPolicy === "string") return { policy: asOfPolicy, cutoffs: {} };
  if (typeof asOfPolicy !== "object") {
    throw new Article78BacktestError("as_of_policy must be a policy id or an object of the form { policy, cutoffs }");
  }
  const policy = asOfPolicy.policy ?? DEFAULT_AS_OF_POLICY.policy;
  const cutoffs = asOfPolicy.cutoffs ?? {};
  if (!ARTICLE78_AS_OF_POLICY_IDS.includes(policy)) {
    throw new Article78BacktestError(`as_of_policy.policy ${JSON.stringify(policy)} is not one of ${JSON.stringify(ARTICLE78_AS_OF_POLICY_IDS)}`);
  }
  if (cutoffs === null || typeof cutoffs !== "object" || Array.isArray(cutoffs)) {
    throw new Article78BacktestError("as_of_policy.cutoffs must be an object keyed by determination_key");
  }
  return { policy, cutoffs };
}

/**
 * The recorded searches that speak for this determination: the ones naming it
 * directly and the ones filtering on it. Same rule A78-01's `challengeWatchValue`
 * applies, read here so both derivations resolve the same receipt set.
 */
function receiptsFor(determinationKey, coverage) {
  return coverage.filter((row) => row.determination_key === determinationKey
    || (row.scope?.determination_filters ?? []).includes(determinationKey));
}

/**
 * The cutoff this unit's prediction is made at, and where it came from. The
 * source travels with the value so a receipt row says whether a cutoff was
 * derived from the determination, from the observation record, or stated by
 * the caller.
 */
export function resolveBacktestCutoff({ determination, coverage = [], as_of_policy: asOfPolicy } = {}) {
  if (!determination || typeof determination.determination_key !== "string") {
    throw new Article78BacktestError("resolveBacktestCutoff: determination must be an A78-01 determination_context with a determination_key");
  }
  const { policy, cutoffs } = normalizeAsOfPolicy(asOfPolicy);
  const stated = cutoffs[determination.determination_key];
  if (stated !== undefined) {
    return { as_of: toDay(stated, `as_of_policy.cutoffs[${determination.determination_key}]`), source: "stated_by_caller" };
  }
  if (policy === "explicit") {
    throw new Article78BacktestError(
      `resolveBacktestCutoff: as_of_policy "explicit" requires a cutoff for every determination; ${JSON.stringify(determination.determination_key)} has none`,
    );
  }
  if (policy === "observation_close") {
    const searched = receiptsFor(determination.determination_key, coverage).map((row) => row.searched_at).sort();
    if (searched.length === 0) {
      throw new Article78BacktestError(
        `resolveBacktestCutoff: as_of_policy "observation_close" needs a recorded search for ${JSON.stringify(determination.determination_key)}, and there is none`,
      );
    }
    return { as_of: toDay(searched[searched.length - 1], "search_coverage.searched_at"), source: "observation_close" };
  }
  if (typeof determination.final_and_binding_date !== "string") {
    throw new Article78BacktestError(
      `resolveBacktestCutoff: as_of_policy "determination_final" needs final_and_binding_date on ${JSON.stringify(determination.determination_key)}, and there is none`,
    );
  }
  return { as_of: toDay(determination.final_and_binding_date, "determination.final_and_binding_date"), source: "determination_final" };
}

// ---------------------------------------------------------------------------
// Scoring.
// ---------------------------------------------------------------------------

function emptyCounts() {
  return { true_positive: 0, false_positive: 0, false_negative: 0, true_negative: 0, censored: 0 };
}

/** Which confusion cell a predicted/observed pair lands in. */
function confusionCell(predictedPositive, observedPositive) {
  if (predictedPositive) return observedPositive ? "true_positive" : "false_positive";
  return observedPositive ? "false_negative" : "true_negative";
}

/**
 * The censoring question, asked once for a whole determination because both
 * reasons that can fire here are properties of the determination and its
 * limitations window rather than of any one row.
 *
 * A determination that was not final at the cutoff has no open challenge
 * window at all. A determination whose window is still open at the cutoff and
 * that has no challenge on the record has not produced a negative: somebody
 * may still file. A determination with a challenge on the record is settled in
 * that direction whatever the window is doing, which is why an observed event
 * is checked before the window.
 */
function censoringFor({ determination, window, cutoff, hasChallengeOnRecord }) {
  if (!window || window.opens_on > cutoff) {
    return {
      reason: "determination_not_final_at_cutoff",
      statement: `this determination was not final and binding as of ${cutoff}, so no challenge window had opened and nothing downstream is determinable`,
    };
  }
  if (!hasChallengeOnRecord && window.closes_on >= cutoff) {
    return {
      reason: "open_limitations_window",
      statement: `the limitations window for this determination closes on ${window.closes_on}, which is not before the cutoff ${cutoff}; no challenge is on the record and "nobody filed" is not yet a fact`,
    };
  }
  return null;
}

/** Record one scored row against its head: the count and the row itself always move together. */
function scoreRow(head, row, counts, rows) {
  counts[head][row.outcome_class] += 1;
  rows[head].push(row);
  return row;
}

/**
 * Run both heads over the historical QA fixture and report each one's own
 * confusion counts, censored rows and per-row detail.
 *
 * `fixture` defaults to A78-02's loader. `as_of_policy` is a policy id or
 * `{ policy, cutoffs }`; see `ARTICLE78_AS_OF_POLICY_IDS`. The function reads
 * no clock and fetches nothing: the same fixture and the same policy always
 * produce the same object.
 */
export function backtestLitigation({ fixture = loadHistoricalFixture(), as_of_policy: asOfPolicy } = {}) {
  if (!fixture || !Array.isArray(fixture.projects) || !fixture.clean) {
    throw new Article78BacktestError("backtestLitigation: fixture must be an A78-02 historical fixture with projects and clean rows");
  }
  const policy = normalizeAsOfPolicy(asOfPolicy);

  const entries = fixture.projects.map((project) => ({
    determination: fixture.clean.determinations.find((row) => row.determination_key === project.determination_key),
    receipts: fixture.clean.coverage,
  }));
  for (const [index, entry] of entries.entries()) {
    if (!entry.determination) {
      throw new Article78BacktestError(
        `backtestLitigation: project ${JSON.stringify(fixture.projects[index].project_id)} names a determination the fixture does not carry`,
      );
    }
  }

  // A78-03 decides who is in the denominator at all, in both directions. A
  // determination nobody could adequately search is not a negative and is not
  // a censored not-yet either: it is a determination this backtest cannot
  // speak about, and its size is carried rather than dropped.
  const admission = admitNegatives(entries);
  const admitted = new Set(admission.admitted.map((row) => row.determination_key));

  const decisions = fixture.clean.filings.filter((row) => ARTICLE78_DECISION_FILING_TYPES.includes(row.filing_type));
  const effectiveByCase = new Map(
    applyDecisionSupersession(decisions, fixture.clean.supersessions).map((row) => [row.case_key, row]),
  );
  const caseByKey = new Map(fixture.clean.cases.map((row) => [row.case_key, row]));

  const counts = { filing: emptyCounts(), durable_relief: emptyCounts() };
  const rows = { filing: [], durable_relief: [] };
  const excluded = [];

  for (const project of fixture.projects) {
    const determination = fixture.clean.determinations.find((row) => row.determination_key === project.determination_key);
    const determinationKey = determination.determination_key;
    if (!admitted.has(determinationKey)) {
      const graded = [...admission.excluded.C, ...admission.excluded.U].find((row) => row.determination_key === determinationKey);
      excluded.push({
        project_id: project.project_id,
        determination_key: determinationKey,
        reason: "coverage_grade_not_admissible",
        coverage_grade: graded?.grade ?? null,
        statement: `the court-record search behind this determination grades ${graded?.grade ?? "unknown"}, so it enters neither head in either direction`,
      });
      continue;
    }

    const cutoff = resolveBacktestCutoff({ determination, coverage: fixture.clean.coverage, as_of_policy: policy });
    // The fixture's documented watch inputs go to A78-04 as they are. A78-02
    // validates the positions among them against the environmental-review
    // ontology's own `public_position` spec, in the same command as this
    // section, so re-validating them here would only be a second copy of that
    // rule to keep in step.
    const inputs = project.challenge_watch_inputs ?? null;
    const watch = deriveChallengeWatch({
      determination,
      review: inputs?.review ?? null,
      positions: inputs?.positions ?? [],
      signals: inputs?.signals ?? [],
      coverage: fixture.clean.coverage,
      as_of: cutoff.as_of,
    });
    const window = limitationsWindow(determination);
    const located = [...new Set(receiptsFor(determinationKey, fixture.clean.coverage).flatMap((row) => row.located_case_keys))].sort();
    const genuine = located.filter((caseKey) => caseByKey.get(caseKey)?.determination_key === determinationKey);

    const shared = {
      project_id: project.project_id,
      determination_key: determinationKey,
      as_of: cutoff.as_of,
      as_of_source: cutoff.source,
      coverage_grade: watch.coverage_grade,
      challenge_watch_level: watch.level,
      challenge_watch_null_reason: watch.null_reason ?? null,
    };

    // --- the filing head ---------------------------------------------------
    const filingPredicted = ARTICLE78_BACKTEST_POLICY.heads.filing.predicted_positive_levels.includes(watch.level);
    const filingCensoring = censoringFor({ determination, window, cutoff: cutoff.as_of, hasChallengeOnRecord: located.length > 0 });
    if (located.length === 0) {
      scoreRow("filing", {
        ...shared,
        head: "filing",
        case_key: null,
        predicted_positive: filingPredicted,
        observed_positive: filingCensoring ? null : false,
        outcome_class: filingCensoring ? "censored" : confusionCell(filingPredicted, false),
        censoring_reason: filingCensoring?.reason ?? null,
        reason: filingCensoring?.statement
          ?? "the recorded search covers this determination, closed after its limitations window, and located no challenge",
      }, counts, rows);
    } else {
      for (const caseKey of located) {
        const observedPositive = caseByKey.get(caseKey)?.determination_key === determinationKey;
        scoreRow("filing", {
          ...shared,
          head: "filing",
          case_key: caseKey,
          predicted_positive: filingPredicted,
          observed_positive: filingCensoring ? null : observedPositive,
          outcome_class: filingCensoring ? "censored" : confusionCell(filingPredicted, observedPositive),
          censoring_reason: filingCensoring?.reason ?? null,
          reason: filingCensoring?.statement ?? (observedPositive
            ? "the recorded search located this challenge to this determination"
            : "the recorded search returned this case for this determination, and the case challenges a different determination"),
        }, counts, rows);
      }
    }

    // --- the durable-relief head -------------------------------------------
    const reliefPredicted = ARTICLE78_BACKTEST_POLICY.heads.durable_relief.predicted_positive_levels.includes(watch.level);
    const reliefCensoring = censoringFor({ determination, window, cutoff: cutoff.as_of, hasChallengeOnRecord: genuine.length > 0 });
    if (genuine.length === 0) {
      scoreRow("durable_relief", {
        ...shared,
        head: "durable_relief",
        case_key: null,
        durable_petitioner_relief: null,
        predicted_positive: reliefPredicted,
        observed_positive: reliefCensoring ? null : false,
        outcome_class: reliefCensoring ? "censored" : confusionCell(reliefPredicted, false),
        censoring_reason: reliefCensoring?.reason ?? null,
        reason: reliefCensoring?.statement
          ?? "no challenge to this determination is on the record after a search that closed after the limitations window, so no petitioner obtained relief from it",
      }, counts, rows);
    } else {
      for (const caseKey of genuine) {
        const effective = effectiveByCase.get(caseKey) ?? null;
        const relief = effective?.case_outcome?.durable_petitioner_relief ?? null;
        const unresolved = effective?.unresolved ?? null;
        const censoring = reliefCensoring ?? (unresolved
          ? { reason: "pending_appeal", statement: `the record does not resolve which decision is effective for this case: ${unresolved}` }
          : null);
        const observedPositive = DURABLE_RELIEF_STATES.includes(relief);
        scoreRow("durable_relief", {
          ...shared,
          head: "durable_relief",
          case_key: caseKey,
          durable_petitioner_relief: relief,
          predicted_positive: reliefPredicted,
          observed_positive: censoring ? null : observedPositive,
          outcome_class: censoring ? "censored" : confusionCell(reliefPredicted, observedPositive),
          censoring_reason: censoring?.reason ?? null,
          reason: censoring?.statement ?? reliefReason(relief),
        }, counts, rows);
      }
    }
  }

  const report = {
    schema: ARTICLE78_LITIGATION_BACKTEST_SCHEMA,
    policy_id: ARTICLE78_BACKTEST_POLICY.policy_id,
    scope: "fixture",
    diagnostic_only: true,
    as_of_policy: policy.policy,
    stated_cutoff_count: Object.keys(policy.cutoffs).length,
    project_count: fixture.projects.length,
    eligible_determination_count: admission.counts.admitted,
    excluded_determination_count: excluded.length,
    heads: Object.fromEntries(ARTICLE78_BACKTEST_HEADS.map((head) => [head, {
      head,
      question: ARTICLE78_BACKTEST_POLICY.heads[head].question,
      unit: ARTICLE78_BACKTEST_POLICY.heads[head].unit,
      predicted_positive_levels: ARTICLE78_BACKTEST_POLICY.heads[head].predicted_positive_levels,
      counts: counts[head],
      scored_row_count: ARTICLE78_BACKTEST_CONFUSION_CELLS.reduce((total, cell) => total + counts[head][cell], 0),
      censored: rows[head].filter((row) => row.outcome_class === "censored")
        .map((row) => ({
          project_id: row.project_id,
          determination_key: row.determination_key,
          case_key: row.case_key,
          as_of: row.as_of,
          censoring_reason: row.censoring_reason,
          reason: row.reason,
        })),
      rows: rows[head],
      metrics: ARTICLE78_BACKTEST_OUTCOME_CLASSES.map((cell) => (
        diagnosticMetric(`article78_backtest_${head}_${cell}`, counts[head][cell])
      )),
    }])),
    excluded_determinations: excluded,
    statement: ARTICLE78_BACKTEST_POLICY.statement,
  };
  assertCensoredRowsAreNotNegatives(report);
  assertHeadsScoredSeparately(report);
  return report;
}

/** The one sentence a scored relief row prints, per recorded relief state. */
function reliefReason(relief) {
  if (relief === null) {
    return "no decision is recorded for this case, so the petitioner has obtained no durable relief on the record";
  }
  if (DURABLE_RELIEF_STATES.includes(relief)) {
    return `the effective decision after supersession granted ${relief}, which this head scores as durable relief`;
  }
  const documented = ARTICLE78_BACKTEST_POLICY.relief_states_not_scored_durable.find((row) => row.relief_state === relief);
  if (documented) return `the effective decision after supersession recorded ${relief}: ${documented.reason}`;
  if (!ARTICLE78_PETITIONER_RELIEF_STATES.includes(relief)) {
    throw new Article78BacktestError(`backtestLitigation: ${JSON.stringify(relief)} is not one of A78-01's relief states`);
  }
  return `the effective decision after supersession recorded ${relief}, which this head does not score as durable relief`;
}

// ---------------------------------------------------------------------------
// A3/A4: the boundaries, asserted over the report rather than trusted.
// ---------------------------------------------------------------------------

/**
 * A4, as a callable check: a censored row is never counted in a confusion
 * cell, and the four cells plus the censored count always add back up to the
 * rows the head actually produced. A head whose numbers do not add up is a
 * head that dropped a row, and a dropped row is how a not-yet becomes a
 * negative.
 */
export function assertCensoredRowsAreNotNegatives(report, context = "article78 litigation backtest") {
  for (const head of ARTICLE78_BACKTEST_HEADS) {
    const section = report?.heads?.[head];
    if (!section) throw new Article78BacktestError(`${context}: report is missing the ${head} head`);
    // The rule itself, checked first so that a report which moved a censored
    // row into a cell is refused by the sentence that names the rule rather
    // than by a bookkeeping check that happens to notice the same edit.
    const scoredCensored = section.rows.filter((row) => row.censoring_reason !== null && ARTICLE78_BACKTEST_CONFUSION_CELLS.includes(row.outcome_class));
    if (scoredCensored.length > 0) {
      throw new Article78BacktestError(
        `${context}: ${head} counted ${scoredCensored.length} censored row(s) in a confusion cell; a censored row is a not-yet and is never a true negative. Offending row(s) ${JSON.stringify(scoredCensored.map((row) => ({ case_key: row.case_key, determination_key: row.determination_key, outcome_class: row.outcome_class, censoring_reason: row.censoring_reason })))}`,
      );
    }
    const unexplained = section.rows.filter((row) => row.outcome_class === "censored" && row.censoring_reason === null);
    if (unexplained.length > 0) {
      throw new Article78BacktestError(
        `${context}: ${head} censored ${unexplained.length} row(s) without saying why; a censored row carries the reason the cutoff could not settle it. Offending row(s) ${JSON.stringify(unexplained.map((row) => row.case_key ?? row.determination_key))}`,
      );
    }
    for (const row of section.rows) {
      if (row.outcome_class === "censored" && row.observed_positive !== null) {
        throw new Article78BacktestError(`${context}: ${head} censored row ${JSON.stringify(row.case_key ?? row.determination_key)} carries an observed outcome; a censored row has none`);
      }
      if (row.outcome_class === "censored" && !ARTICLE78_BACKTEST_CENSORING_REASONS.includes(row.censoring_reason)) {
        throw new Article78BacktestError(`${context}: ${head} censoring reason ${JSON.stringify(row.censoring_reason)} is not one of ${JSON.stringify(ARTICLE78_BACKTEST_CENSORING_REASONS)}`);
      }
    }
    const total = ARTICLE78_BACKTEST_OUTCOME_CLASSES.reduce((sum, cell) => sum + section.counts[cell], 0);
    if (total !== section.rows.length) {
      throw new Article78BacktestError(
        `${context}: ${head} classes total ${total} but the head produced ${section.rows.length} row(s); every row lands in exactly one class`,
      );
    }
  }
  return { ok: true, heads: ARTICLE78_BACKTEST_HEADS.length };
}

/**
 * The negative rule, as a callable check: the two heads are reported side by
 * side and never blended. Field names go through A78-01's own combined-score
 * scanner rather than a second list here, so a field renamed into
 * `overall_litigation_score` fails in the same place a combined case outcome
 * would.
 */
export function assertHeadsScoredSeparately(report, context = "article78 litigation backtest") {
  const heads = Object.keys(report?.heads ?? {}).sort();
  if (JSON.stringify(heads) !== JSON.stringify([...ARTICLE78_BACKTEST_HEADS].sort())) {
    throw new Article78BacktestError(`${context}: expected exactly the heads ${JSON.stringify(ARTICLE78_BACKTEST_HEADS)}, got ${JSON.stringify(heads)}`);
  }
  const names = [
    ...Object.keys(report),
    ...heads.flatMap((head) => Object.keys(report.heads[head])),
    ...heads.flatMap((head) => Object.keys(report.heads[head].counts)),
  ];
  assertNoCombinedOutcomeScore([...new Set(names)], `${context} field names`);
  return { ok: true, heads: heads.length };
}

/**
 * A2, as a callable check: the report reproduces the documented seed
 * diagnostic exactly, or throws naming every count that differs.
 *
 * There is no tolerance here on purpose. The seed exists so that a change to
 * the challenge-watch features produces a comparable number; a scorer that
 * rounded its way to a pass would be measuring nothing.
 */
export function assertSeedDiagnostic(report, seed = ARTICLE78_BACKTEST_SEED_DIAGNOSTIC, context = "article78 litigation backtest seed diagnostic") {
  if (report?.as_of_policy !== seed.as_of_policy) {
    throw new Article78BacktestError(
      `${context}: the seed diagnostic is documented under the ${JSON.stringify(seed.as_of_policy)} cutoff policy, and this report used ${JSON.stringify(report?.as_of_policy)}`,
    );
  }
  const differences = [];
  for (const head of ARTICLE78_BACKTEST_HEADS) {
    for (const cell of ARTICLE78_BACKTEST_OUTCOME_CLASSES) {
      const expected = seed.heads[head][cell];
      const observed = report.heads?.[head]?.counts?.[cell];
      if (observed !== expected) differences.push({ head, class: cell, expected, observed: observed ?? null });
    }
  }
  if (differences.length > 0) {
    throw new Article78BacktestError(
      `${context}: the fixture did not reproduce the documented seed diagnostic. Differences ${JSON.stringify(differences)}`,
    );
  }
  return { ok: true, checked_counts: ARTICLE78_BACKTEST_HEADS.length * ARTICLE78_BACKTEST_OUTCOME_CLASSES.length };
}
