/**
 * A78-04: cutoff-aware challenge-watch signals that never stand on an
 * environmental impact statement alone.
 *
 * The most available signal about an environmental review -- that it produced
 * an environmental impact statement -- is also the least discriminating. Large
 * projects routinely produce one and are never challenged; the document
 * records the size of the action, not a dispute about it. A watch signal that
 * fires on document class alone therefore separates nothing: it reproduces the
 * list of conspicuous projects somebody could already have written down.
 *
 * So the derivation here is built around one rule, expressed as data in
 * `CHALLENGE_WATCH_POLICY` rather than as scattered conditionals: a signal may
 * only reach its top level when it rests on a **specific preserved issue** or a
 * **named participant**, and document class can never carry a level past
 * `baseline` on its own however many further conspicuousness features come
 * with it.
 *
 * Three further disciplines make the signal something that can be argued with:
 *
 *  - *Cutoff.* Every feature carries the public date of the evidence that
 *    established it, every derivation takes an explicit `as_of`, and evidence
 *    published after that instant is excluded and the exclusion is listed in
 *    the basis rather than dropped. Moving the cutoff earlier can only lower
 *    the level or null it; it can never raise one.
 *  - *Labor.* A labor organization on the record is a named participant like
 *    any other, and its participation raises filing-watch evidence exactly the
 *    way an advocacy group's does. It is never a motive, misconduct, or
 *    legal-viability inference, and the feature record carries that
 *    suppression rule as a field so a consumer inherits it rather than
 *    remembering it.
 *  - *Label.* The output is a **challenge watch**. It is not a prediction, and
 *    `FORBIDDEN_CHALLENGE_WATCH_PREDICTION_WORDINGS` plus
 *    `assertNoChallengeWatchPredictionWording` refuse the register that would
 *    turn recorded process evidence into a forecast about a court.
 *
 * This module adds no record shape. It reads A78-01's determination context
 * and search-coverage receipts, A78-03's grade, and the SEQRA-07
 * institutional-signal vocabulary (`warehouse/lib/seqra_issue_coalition_signals.mjs`,
 * `warehouse/lib/seqra_public_position_builder.mjs`), and it fetches nothing.
 *
 * It is also distinct from A78-01's `challengeWatchValue`, which counts
 * challenges a recorded search actually located after the fact. That is a
 * backward-looking count; this is a forward-looking watch over evidence public
 * by a cutoff. The two share the coverage grade and nothing else.
 */

import {
  ARTICLE78_COUNTABLE_COVERAGE_GRADES,
  ARTICLE78_COVERAGE_GRADES,
} from "./article78_litigation.mjs";
import { gradeCoverage } from "./article78_search_coverage.mjs";
import {
  computeIssuePreservation,
  filterCutoffValidPositions,
  ISSUE_COALITION_SUPPRESSION_RULE,
  normalizeNamedIssue,
} from "./seqra_issue_coalition_signals.mjs";
import { DEFAULT_SUPPRESSION_RULE } from "./seqra_public_position_builder.mjs";

export const ARTICLE78_CHALLENGE_WATCH_SIGNAL_SCHEMA = "cityscroll.article78_challenge_watch_signal.v1";

export class Article78ChallengeWatchError extends Error {
  constructor(message) {
    super(message);
    this.name = "Article78ChallengeWatchError";
  }
}

// ---------------------------------------------------------------------------
// A4: the label, and the register it is not allowed to drift into.
// ---------------------------------------------------------------------------

/**
 * The only name this output has. It appears on every result object and inside
 * every level wording, so a consumer that renders the wording renders the
 * label with it and cannot relabel the number on the way to a page.
 */
export const CHALLENGE_WATCH_LABEL = "challenge watch";

/**
 * Sentences that turn a watch into a forecast. Each of them claims something
 * about what a court will see, which no amount of recorded process evidence
 * supports. This constant is the one place in the repository they may appear;
 * a test asserts they occur nowhere else under the A78 surfaces, and asserts
 * that within this module they occur only inside this array.
 */
export const FORBIDDEN_CHALLENGE_WATCH_PREDICTION_WORDINGS = Object.freeze([
  "lawsuit predicted",
  "lawsuits predicted",
  "predicted lawsuit",
  "litigation predicted",
  "predicted litigation",
  "challenge predicted",
  "predicted challenge",
  "lawsuit forecast",
  "litigation forecast",
  "lawsuit likely",
  "litigation likely",
  "likely to be sued",
  "likely to be challenged",
  "expected to be sued",
  "will be sued",
  "will be challenged",
  "probability of a lawsuit",
  "probability of litigation",
  "chance of a lawsuit",
  "odds of a lawsuit",
  "lawsuit risk score",
  "litigation risk score",
]);

function normalizeWordingForScan(text) {
  return ` ${String(text).toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim()} `;
}

/**
 * Words that turn an occurrence of a banned phrase into its own refusal. The
 * ban is on *asserting* a prediction; a sentence that denies making one is the
 * opposite of the failure, and a scanner that could not tell the two apart
 * would make it impossible to write the refusal down. The window is short
 * deliberately -- a refusal marker six words back is still governing the
 * clause, one two sentences back is not.
 */
const REFUSAL_MARKERS = Object.freeze(["no", "not", "never", "neither", "nor", "cannot", "without"]);
const REFUSAL_MARKER_WINDOW = 6;

/** Is this occurrence governed by a refusal marker just before it? */
function occurrenceIsRefusal(normalized, index) {
  const before = normalized.slice(0, index).trim().split(" ");
  return before.slice(-REFUSAL_MARKER_WINDOW).some((word) => REFUSAL_MARKERS.includes(word));
}

/**
 * Which forbidden prediction sentences this text asserts, if any. An
 * occurrence a refusal marker governs ("no probability that anyone will be
 * sued") is not an assertion and is not reported.
 */
export function findChallengeWatchPredictionWording(text) {
  const normalized = normalizeWordingForScan(text);
  return FORBIDDEN_CHALLENGE_WATCH_PREDICTION_WORDINGS.filter((phrase) => {
    const needle = ` ${normalizeWordingForScan(phrase).trim()} `;
    let index = normalized.indexOf(needle);
    while (index >= 0) {
      if (!occurrenceIsRefusal(normalized, index)) return true;
      index = normalized.indexOf(needle, index + 1);
    }
    return false;
  });
}

/** Refuse any rendering that reports a watch as a forecast about a court. */
export function assertNoChallengeWatchPredictionWording(texts, context = "challenge watch rendering") {
  const offenders = [];
  for (const text of texts) {
    for (const phrase of findChallengeWatchPredictionWording(text)) offenders.push({ text, phrase });
  }
  if (offenders.length > 0) {
    throw new Article78ChallengeWatchError(
      `${context}: this is a ${CHALLENGE_WATCH_LABEL} over recorded evidence, never a forecast about a court; offending wording ${JSON.stringify(offenders)}`,
    );
  }
  return { ok: true, checked_count: texts.length };
}

// ---------------------------------------------------------------------------
// The levels and their wordings.
// ---------------------------------------------------------------------------

/**
 * Ordered weakest to strongest. `"null"` is a level rather than a missing
 * field: a determination the watch may not speak about at all is a distinct,
 * reportable state, and making it a string keeps the enum uniform for a
 * consumer switching on `level`.
 */
export const CHALLENGE_WATCH_LEVELS = Object.freeze(["null", "baseline", "elevated", "high"]);

/** Why a watch is `"null"`. Each reason is an absence in the record, never a fact about the world. */
export const CHALLENGE_WATCH_NULL_REASONS = Object.freeze([
  "coverage_grade_not_countable",
  "determination_not_final_at_cutoff",
  "determination_finality_unknown",
]);

/** The rendering for each level that is allowed to carry features. */
export const CHALLENGE_WATCH_LEVEL_WORDING = Object.freeze({
  high: `${CHALLENGE_WATCH_LABEL}: high -- a specific preserved issue or a named participant is on the public record, together with further recorded evidence`,
  elevated: `${CHALLENGE_WATCH_LABEL}: elevated -- recorded evidence beyond the size and document class of the review`,
  baseline: `${CHALLENGE_WATCH_LABEL}: baseline -- nothing on the public record beyond the size and document class of the review`,
});

/** The rendering for a `"null"` level, per reason. */
export const CHALLENGE_WATCH_NULL_WORDING = Object.freeze({
  coverage_grade_not_countable: `${CHALLENGE_WATCH_LABEL}: not established -- the court-record search behind this determination is not graded well enough to admit it, so a watch over it could never be checked`,
  determination_not_final_at_cutoff: `${CHALLENGE_WATCH_LABEL}: not established -- this determination was not yet final and binding as of the cutoff, so the challenge window had not opened`,
  determination_finality_unknown: `${CHALLENGE_WATCH_LABEL}: not established -- nobody has recorded whether this determination became final and binding`,
});

// ---------------------------------------------------------------------------
// The features.
// ---------------------------------------------------------------------------

/** The document classes a review event can establish, strongest first. */
export const CHALLENGE_WATCH_DOCUMENT_CLASSES = Object.freeze([
  "environmental_impact_statement",
  "positive_declaration",
  "negative_declaration",
  "type_ii",
  "not_recorded",
]);

/**
 * SEQRA-02 `review_event` types this module reads, mapped to the document
 * class each one establishes. Reusing the ontology's own event vocabulary is
 * deliberate: a second enum for "was there an EIS" would drift from the event
 * log that actually records it.
 */
export const REVIEW_EVENT_DOCUMENT_CLASS = Object.freeze({
  positive_declaration_issued: "positive_declaration",
  draft_document_published: "environmental_impact_statement",
  final_document_published: "environmental_impact_statement",
  supplemental_eis_initiated: "environmental_impact_statement",
  negative_declaration_issued: "negative_declaration",
  conditioned_negative_declaration_issued: "negative_declaration",
  type_ii_classified: "type_ii",
});

/**
 * The dated institutional signals this module accepts. Each one has no other
 * home in the ontology at the granularity a watch needs; the two features that
 * rest on a *named participant* are deliberately not in this list, because
 * they may only be established from a resolved organization on a public
 * position, never asserted directly.
 */
export const CHALLENGE_WATCH_SIGNAL_TYPES = Object.freeze([
  "adverse_public_body_signal",
  "sensitive_receptor_identified",
  "prior_administrative_challenge",
  "preserved_issue_raised",
]);

/** Organization types whose recorded opposition is a public-body signal rather than a participant's. */
export const PUBLIC_BODY_ORGANIZATION_TYPES = Object.freeze([
  "community_board",
  "elected_official_office",
  "government_agency",
]);

export const CHALLENGE_WATCH_FEATURE_KEYS = Object.freeze([
  "document_class",
  "organized_opposition",
  "preserved_issue",
  "adverse_public_body_signal",
  "multiple_discretionary_actions",
  "sensitive_receptor",
  "prior_administrative_challenge",
  "labor_organization_participation",
]);

/**
 * The exact suppression the commission's negative rule requires on the labor
 * feature. It is a constant rather than prose so a consumer can assert on it,
 * and so the rule travels with the feature record into whatever reads it.
 */
export const LABOR_PARTICIPATION_SUPPRESSION = "no motive, misconduct, or legal-viability inference";

/** The longer form, for a surface with room for a sentence. */
export const LABOR_PARTICIPATION_SUPPRESSION_RULE =
  "A labor organization on the public record is a named participant and nothing more. Its "
  + "participation raises filing-watch evidence exactly as any other named participant's does, and it "
  + `carries ${LABOR_PARTICIPATION_SUPPRESSION}: it is never evidence about why the organization `
  + "participated, never a misconduct label, and never a statement about whether any claim it might "
  + "raise would succeed. The same rule governs developer and community participation.";

/**
 * The only sentence a consumer may print for the labor feature. Every wording
 * in this module is a constant for the same reason A78-01's zero wording is:
 * the failure this card exists to prevent is a consumer looking at a `true`
 * and writing the sentence itself.
 */
export const CHALLENGE_WATCH_FEATURE_WORDING = Object.freeze({
  document_class: "the review's published document class is on the record",
  organized_opposition: "a named organization is on the record in opposition",
  preserved_issue: "a specific issue was named and reaffirmed on the record",
  adverse_public_body_signal: "a public body is on the record adverse to the action",
  multiple_discretionary_actions: "the action required more than one discretionary approval",
  sensitive_receptor: "a sensitive receptor is recorded near the action",
  prior_administrative_challenge: "an earlier administrative challenge is on the record",
  labor_organization_participation: "a labor organization is on the record as a participant",
});

/**
 * What else could produce each feature. Carried on the feature record for the
 * same reason SEQRA-07 carries one on every position: a signal with no rival
 * explanation reads as a conclusion.
 */
export const CHALLENGE_WATCH_FEATURE_RIVAL_EXPLANATION = Object.freeze({
  document_class: "An environmental impact statement records the size and complexity of the action, not a dispute about it; large projects routinely produce one and are never challenged.",
  organized_opposition: "An organization on the record in opposition may be commenting as a matter of routine practice on every action in its area rather than contesting this one.",
  preserved_issue: ISSUE_COALITION_SUPPRESSION_RULE,
  adverse_public_body_signal: "An advisory body's adverse position may reflect a standing policy position it takes on a whole action class rather than a specific objection to this action.",
  multiple_discretionary_actions: "A bundle of discretionary approvals reflects how the action was packaged for review, which is a drafting choice as much as a measure of contestedness.",
  sensitive_receptor: "A nearby sensitive receptor is a fact about geography; the review may have addressed it in full, and proximity is not itself an objection.",
  prior_administrative_challenge: "An earlier administrative challenge may have been resolved on the merits or withdrawn, and an exhausted objection is not a live one.",
  labor_organization_participation: "A labor organization may participate as a matter of standing practice on projects of this size or in this trade, independently of anything specific to this action.",
});

/** Features that rest on a named participant: the anchor a `high` watch may be built on. */
export const NAMED_PARTICIPATION_FEATURES = Object.freeze([
  "organized_opposition",
  "labor_organization_participation",
]);

/**
 * Features that describe how conspicuous an action is rather than whether
 * anyone contested it. Neither may lift a watch above `baseline`, alone or
 * together: that is the whole point of the card.
 */
export const CONSPICUOUSNESS_ONLY_FEATURES = Object.freeze([
  "document_class",
  "multiple_discretionary_actions",
]);

// ---------------------------------------------------------------------------
// The policy, as data.
// ---------------------------------------------------------------------------

export const CHALLENGE_WATCH_POLICY = Object.freeze({
  policy_id: "cityscroll.article78_challenge_watch_signal.policy.v1",
  label: CHALLENGE_WATCH_LABEL,
  levels: CHALLENGE_WATCH_LEVELS,
  feature_keys: CHALLENGE_WATCH_FEATURE_KEYS,
  anchor_features: NAMED_PARTICIPATION_FEATURES,
  /**
   * A preserved issue anchors a `high` watch on its own, the way a named
   * participant does: the card's rule is "a specific preserved issue OR a
   * named participant", not both.
   */
  issue_anchor_features: Object.freeze(["preserved_issue"]),
  conspicuousness_only_features: CONSPICUOUSNESS_ONLY_FEATURES,
  null_reasons: CHALLENGE_WATCH_NULL_REASONS,
  admissible_coverage_grades: ARTICLE78_COUNTABLE_COVERAGE_GRADES,
  level_rules: Object.freeze([
    Object.freeze({
      level: "high",
      rule_id: "anchor_plus_one",
      summary: "a specific preserved issue or a named participant, plus at least one further present feature",
      requires_anchor: true,
      minimum_present_features: 2,
    }),
    Object.freeze({
      level: "elevated",
      rule_id: "anchor_or_substantive",
      summary: "an anchor on its own, or any present feature that is more than conspicuousness",
      requires_anchor: false,
      minimum_present_features: 1,
      minimum_non_conspicuousness_features: 1,
    }),
    Object.freeze({
      level: "baseline",
      rule_id: "conspicuousness_floor",
      summary: "nothing present beyond the size and document class of the review; the floor a document class alone can reach",
      requires_anchor: false,
      minimum_present_features: 0,
    }),
  ]),
  document_class_ceiling: Object.freeze({
    rule_id: "document_class_never_exceeds_baseline",
    statement: "An environmental impact statement or positive declaration, alone or with any other conspicuousness-only feature, can never carry a watch above baseline.",
  }),
});

// ---------------------------------------------------------------------------
// Cutoff plumbing.
// ---------------------------------------------------------------------------

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function requireInstant(value, fieldName) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Article78ChallengeWatchError(`${fieldName} is required and must be a non-empty ISO date or date-time string`);
  }
  const text = value.trim();
  const normalized = DATE_ONLY.test(text) ? `${text}T00:00:00Z` : text;
  const ms = new Date(normalized).getTime();
  if (Number.isNaN(ms)) {
    throw new Article78ChallengeWatchError(`${fieldName} must be a parseable ISO date or date-time, got ${JSON.stringify(value)}`);
  }
  return { text, normalized, ms };
}

function instantOrNull(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const text = value.trim();
  const normalized = DATE_ONLY.test(text) ? `${text}T00:00:00Z` : text;
  const ms = new Date(normalized).getTime();
  return Number.isNaN(ms) ? null : { text, ms };
}

/**
 * Split one channel of dated records into what the cutoff admits and what it
 * excludes, and why. An undated record is excluded on the same footing as a
 * too-late one: a record that never says when it became public cannot support
 * a claim about what was knowable on a given day.
 */
export function partitionByCutoff(rows, { asOf, dateField = "available_to_public_at" } = {}) {
  const cutoff = requireInstant(asOf, "asOf");
  const included = [];
  const excludedPublishedAfterCutoff = [];
  const excludedNoPublicDate = [];
  for (const row of rows ?? []) {
    const at = instantOrNull(row?.[dateField]);
    if (at === null) {
      excludedNoPublicDate.push(row);
      continue;
    }
    if (at.ms > cutoff.ms) {
      excludedPublishedAfterCutoff.push(row);
      continue;
    }
    included.push(row);
  }
  return { included, excludedPublishedAfterCutoff, excludedNoPublicDate };
}

function evidenceRef(row, dateField, detail) {
  return {
    source_id: row?.source_id ?? null,
    source_record_id: row?.source_record_id ?? null,
    public_date: row?.[dateField] ?? null,
    detail,
  };
}

function earliestPublicDate(evidence) {
  const dates = evidence.map((entry) => entry.public_date).filter((value) => typeof value === "string").sort();
  return dates.length > 0 ? dates[0] : null;
}

function feature(key, { present, value = null, evidence = [], suppression = null }) {
  const sortKey = (ref) => `${ref.public_date}|${ref.source_record_id}|${ref.detail}`;
  const refs = [...evidence].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  return {
    key,
    present,
    value,
    public_date: present ? earliestPublicDate(refs) : null,
    evidence: refs,
    wording: CHALLENGE_WATCH_FEATURE_WORDING[key],
    rival_explanation: CHALLENGE_WATCH_FEATURE_RIVAL_EXPLANATION[key],
    suppression,
  };
}

// ---------------------------------------------------------------------------
// The derivation.
// ---------------------------------------------------------------------------

/** Read the coverage argument, which is either A78-03 receipts or an already-derived grade. */
function resolveCoverageGrade(determination, coverage) {
  if (coverage && !Array.isArray(coverage) && typeof coverage === "object") {
    const grade = coverage.grade;
    if (!ARTICLE78_COVERAGE_GRADES.includes(grade)) {
      throw new Article78ChallengeWatchError(
        `deriveChallengeWatch: coverage.grade ${JSON.stringify(grade)} is not one of ${JSON.stringify(ARTICLE78_COVERAGE_GRADES)}`,
      );
    }
    return { grade, source: "supplied_grade", receipts_considered: null };
  }
  const receipts = Array.isArray(coverage) ? coverage : [];
  const graded = gradeCoverage({ determination, receipts });
  return { grade: graded.grade ?? "U", source: "graded_from_receipts", receipts_considered: graded.receipts_considered };
}

/** Positions carrying a resolved organization: the only route to a named-participant feature. */
function namedPositions(positions) {
  return positions.filter((row) => {
    const org = row?.organization;
    return Boolean(org) && typeof org.organization_key === "string" && typeof org.name === "string" && org.name.trim() !== "";
  });
}

function documentClassFeature(events) {
  const classed = events
    .map((row) => ({ row, documentClass: REVIEW_EVENT_DOCUMENT_CLASS[row?.event_type] ?? null }))
    .filter((entry) => entry.documentClass !== null);
  if (classed.length === 0) {
    return feature("document_class", { present: false, value: "not_recorded" });
  }
  // Strongest class any cutoff-valid event established. Taking the strongest
  // rather than the latest is what makes the feature monotone in the cutoff: a
  // later negative declaration cannot un-publish an earlier statement.
  const strongest = CHALLENGE_WATCH_DOCUMENT_CLASSES.find((candidate) => classed.some((entry) => entry.documentClass === candidate));
  const supporting = classed.filter((entry) => entry.documentClass === strongest);
  return feature("document_class", {
    // "Present" here means only that the review reached the statement track.
    // It is never on its own a reason to raise a level, and the policy's
    // conspicuousness list is what enforces that.
    present: strongest === "environmental_impact_statement" || strongest === "positive_declaration",
    value: strongest,
    evidence: supporting.map((entry) => evidenceRef(entry.row, "available_to_public_at", `review event ${entry.row.event_type}`)),
  });
}

function signalsOfType(signals, type) {
  return signals.filter((row) => row?.signal_type === type);
}

/**
 * Derive one determination's challenge watch as of a cutoff.
 *
 * `determination` is an A78-01 `determination_context`. `review` is a
 * challenge-watch view over one environmental review: `{ review_key, events,
 * actions }`, where `events` are SEQRA-02 `review_event`-shaped rows and
 * `actions` are `government_action` rows projected with the public date of the
 * record showing the action was required and an explicit `discretionary`
 * flag -- SEQRA distinguishes discretionary from ministerial actions and the
 * ontology's `action_type` is free text, so the caller states which it is
 * rather than this module guessing from a string.
 *
 * `positions` are SEQRA-02 `public_position` rows, each optionally decorated
 * with a resolved `organization` (`{ organization_key, name, organization_type }`).
 * A position with no resolved organization contributes to issue preservation
 * but never to a named-participant feature, because the feature is about a
 * named participant.
 *
 * `signals` are dated institutional signals whose `signal_type` is one of
 * `CHALLENGE_WATCH_SIGNAL_TYPES`. `coverage` is either an array of A78-01
 * search-coverage receipts (graded here through A78-03) or an object carrying
 * an already-derived `{ grade }`.
 *
 * Deterministic by construction: it reads no clock and fetches nothing. The
 * same inputs and the same `as_of` always produce the same object.
 */
export function deriveChallengeWatch({
  determination,
  review = null,
  positions = [],
  signals = [],
  coverage = [],
  as_of: asOf,
} = {}) {
  if (!determination || typeof determination !== "object" || typeof determination.determination_key !== "string") {
    throw new Article78ChallengeWatchError("deriveChallengeWatch: determination must be an A78-01 determination_context with a determination_key");
  }
  const cutoff = requireInstant(asOf, "as_of");
  for (const [name, rows] of Object.entries({ positions, signals })) {
    if (!Array.isArray(rows)) throw new Article78ChallengeWatchError(`deriveChallengeWatch: ${name} must be an array`);
  }
  for (const row of signals) {
    if (!CHALLENGE_WATCH_SIGNAL_TYPES.includes(row?.signal_type)) {
      throw new Article78ChallengeWatchError(
        `deriveChallengeWatch: signal_type ${JSON.stringify(row?.signal_type)} is not one of ${JSON.stringify(CHALLENGE_WATCH_SIGNAL_TYPES)}`,
      );
    }
  }

  const basis = [];
  const coverageGrade = resolveCoverageGrade(determination, coverage);
  basis.push({
    kind: "coverage_grade",
    grade: coverageGrade.grade,
    source: coverageGrade.source,
    receipts_considered: coverageGrade.receipts_considered,
    statement: `court-search coverage for this determination grades ${coverageGrade.grade} (A78-03); only ${CHALLENGE_WATCH_POLICY.admissible_coverage_grades.join("/")} admit a watch`,
  });

  // The cutoff governs what the watch is allowed to KNOW. The coverage grade
  // governs whether it is allowed to SPEAK, and is deliberately not filtered by
  // the cutoff: it is a property of the observation program behind the
  // determination, not of the world as of a date. A watch over a determination
  // nobody could adequately search is unfalsifiable however good its features.
  if (!CHALLENGE_WATCH_POLICY.admissible_coverage_grades.includes(coverageGrade.grade)) {
    return emitNull("coverage_grade_not_countable", determination, cutoff, basis, coverageGrade.grade);
  }
  if (determination.finality === "unknown") {
    basis.push({ kind: "finality", finality: "unknown", statement: "nobody has recorded whether this determination became final and binding" });
    return emitNull("determination_finality_unknown", determination, cutoff, basis, coverageGrade.grade);
  }
  const finalAt = instantOrNull(determination.final_and_binding_date);
  if (determination.finality !== "final" || finalAt === null || finalAt.ms > cutoff.ms) {
    basis.push({
      kind: "finality",
      finality: determination.finality ?? null,
      final_and_binding_date: determination.final_and_binding_date ?? null,
      statement: `this determination was not final and binding as of ${cutoff.text}`,
    });
    return emitNull("determination_not_final_at_cutoff", determination, cutoff, basis, coverageGrade.grade);
  }
  basis.push({
    kind: "finality",
    finality: "final",
    final_and_binding_date: determination.final_and_binding_date,
    statement: `this determination was final and binding on ${determination.final_and_binding_date}, on or before the cutoff ${cutoff.text}`,
  });

  // --- cutoff filtering, one channel at a time, every exclusion recorded ----
  const events = review?.events ?? [];
  const actions = review?.actions ?? [];
  const channels = {
    review_events: partitionByCutoff(events, { asOf: cutoff.text }),
    review_actions: partitionByCutoff(actions, { asOf: cutoff.text }),
    signals: partitionByCutoff(signals, { asOf: cutoff.text }),
  };
  // Positions go through SEQRA-07's own cutoff filter rather than a second
  // implementation of the same rule.
  const positionSplit = filterCutoffValidPositions(positions, { asOfCutoff: cutoff.normalized });
  const includedPositions = positionSplit.included;

  for (const [channel, split] of Object.entries(channels)) {
    for (const [reason, rows] of Object.entries({
      published_after_cutoff: split.excludedPublishedAfterCutoff,
      no_public_date: split.excludedNoPublicDate,
    })) {
      if (rows.length === 0) continue;
      basis.push({
        kind: "excluded_evidence",
        channel,
        reason,
        count: rows.length,
        source_record_ids: rows.map((row) => row?.source_record_id ?? null).sort(),
        statement: reason === "published_after_cutoff"
          ? `${rows.length} ${channel} record(s) became public after the cutoff ${cutoff.text} and are excluded`
          : `${rows.length} ${channel} record(s) carry no public date and are excluded; an undated record cannot say what was knowable on a given day`,
      });
    }
  }
  for (const [reason, count] of Object.entries({
    published_after_cutoff: positionSplit.excludedNotYetPublic,
    no_public_date: positionSplit.excludedUndated,
  })) {
    if (count === 0) continue;
    basis.push({
      kind: "excluded_evidence",
      channel: "positions",
      reason,
      count,
      source_record_ids: [],
      statement: reason === "published_after_cutoff"
        ? `${count} public position(s) became public after the cutoff ${cutoff.text} and are excluded`
        : `${count} public position(s) carry no usable public date and are excluded`,
    });
  }

  // --- the features -------------------------------------------------------
  const named = namedPositions(includedPositions);

  const opposing = named.filter((row) => row.position === "oppose"
    && !PUBLIC_BODY_ORGANIZATION_TYPES.includes(row.organization.organization_type));
  const organizedOpposition = feature("organized_opposition", {
    present: opposing.length > 0,
    value: [...new Set(opposing.map((row) => row.organization.organization_key))].sort(),
    evidence: opposing.map((row) => evidenceRef(row, "available_to_public_at", `${row.organization.name} recorded ${row.position}`)),
  });

  const preservation = computeIssuePreservation(includedPositions, { asOfCutoff: cutoff.normalized });
  const preservedIssues = preservation.issues.filter((issue) => issue.preserved);
  const issueSignals = signalsOfType(channels.signals.included, "preserved_issue_raised")
    .filter((row) => normalizeNamedIssue(row.named_issue) !== null);
  const preservedIssue = feature("preserved_issue", {
    present: preservedIssues.length > 0 || issueSignals.length > 0,
    value: [...new Set([
      ...preservedIssues.map((issue) => issue.named_issue),
      ...issueSignals.map((row) => normalizeNamedIssue(row.named_issue)),
    ])].sort(),
    evidence: [
      ...includedPositions
        .filter((row) => preservedIssues.some((issue) => issue.named_issue === normalizeNamedIssue(row.named_issue)))
        .map((row) => evidenceRef(row, "available_to_public_at", `position naming ${normalizeNamedIssue(row.named_issue)}`)),
      ...issueSignals.map((row) => evidenceRef(row, "available_to_public_at", `record naming ${normalizeNamedIssue(row.named_issue)}`)),
    ],
  });

  const adverseSignals = signalsOfType(channels.signals.included, "adverse_public_body_signal");
  const adverseBodies = named.filter((row) => row.position === "oppose"
    && PUBLIC_BODY_ORGANIZATION_TYPES.includes(row.organization.organization_type));
  const adversePublicBody = feature("adverse_public_body_signal", {
    present: adverseSignals.length > 0 || adverseBodies.length > 0,
    value: [...new Set(adverseBodies.map((row) => row.organization.organization_key))].sort(),
    evidence: [
      ...adverseSignals.map((row) => evidenceRef(row, "available_to_public_at", row.description ?? "adverse public-body signal")),
      ...adverseBodies.map((row) => evidenceRef(row, "available_to_public_at", `${row.organization.name} recorded ${row.position}`)),
    ],
  });

  const discretionary = channels.review_actions.included.filter((row) => row?.discretionary === true);
  const multipleActions = feature("multiple_discretionary_actions", {
    present: discretionary.length >= 2,
    value: discretionary.length,
    evidence: discretionary.map((row) => evidenceRef(row, "available_to_public_at", `discretionary action ${row.action_key ?? row.action_type ?? "unnamed"}`)),
  });

  const receptorSignals = signalsOfType(channels.signals.included, "sensitive_receptor_identified");
  const sensitiveReceptor = feature("sensitive_receptor", {
    present: receptorSignals.length > 0,
    value: [...new Set(receptorSignals.map((row) => row.receptor_type ?? row.description ?? "recorded"))].sort(),
    evidence: receptorSignals.map((row) => evidenceRef(row, "available_to_public_at", row.description ?? "sensitive receptor recorded")),
  });

  const priorSignals = signalsOfType(channels.signals.included, "prior_administrative_challenge");
  const priorChallenge = feature("prior_administrative_challenge", {
    present: priorSignals.length > 0,
    value: priorSignals.length,
    evidence: priorSignals.map((row) => evidenceRef(row, "available_to_public_at", row.description ?? "prior administrative challenge recorded")),
  });

  // The same stance test the named-participant feature above applies. A labor
  // organization on the record in support is a participant, but it is not
  // filing-watch evidence, and treating any union appearance as adverse is
  // exactly the reading the labor rule exists to prevent.
  const laborPositions = named.filter((row) => row.organization.organization_type === "labor_organization"
    && row.position === "oppose");
  const laborParticipation = feature("labor_organization_participation", {
    present: laborPositions.length > 0,
    value: [...new Set(laborPositions.map((row) => row.organization.organization_key))].sort(),
    evidence: laborPositions.map((row) => evidenceRef(row, "available_to_public_at", `${row.organization.name} recorded ${row.position}`)),
    // The whole labor rule, carried on the record rather than remembered by a
    // consumer. `suppression` is the exact constant the card names; the longer
    // sentence sits beside it for a surface with room for one.
    suppression: LABOR_PARTICIPATION_SUPPRESSION,
  });
  laborParticipation.suppression_rule = LABOR_PARTICIPATION_SUPPRESSION_RULE;
  laborParticipation.participation_is_evidence_of = "filing watch only";
  laborParticipation.default_suppression_rule = DEFAULT_SUPPRESSION_RULE;

  const features = {
    document_class: documentClassFeature(channels.review_events.included),
    organized_opposition: organizedOpposition,
    preserved_issue: preservedIssue,
    adverse_public_body_signal: adversePublicBody,
    multiple_discretionary_actions: multipleActions,
    sensitive_receptor: sensitiveReceptor,
    prior_administrative_challenge: priorChallenge,
    labor_organization_participation: laborParticipation,
  };

  for (const key of CHALLENGE_WATCH_FEATURE_KEYS) {
    const row = features[key];
    basis.push({
      kind: "feature",
      feature: key,
      present: row.present,
      value: row.value,
      public_date: row.public_date,
      evidence_count: row.evidence.length,
      statement: row.present
        ? `${row.wording} (public by ${row.public_date ?? "an unrecorded date"})`
        : `not on the record as of the cutoff: ${row.wording}`,
    });
  }

  const { level, rule } = applyLevelRules(features);
  basis.push({
    kind: "rule",
    rule_id: rule.rule_id,
    level,
    statement: `${level}: ${rule.summary}`,
  });
  if (features.document_class.present) {
    basis.push({
      kind: "rule",
      rule_id: CHALLENGE_WATCH_POLICY.document_class_ceiling.rule_id,
      level,
      statement: CHALLENGE_WATCH_POLICY.document_class_ceiling.statement,
    });
  }

  return assertChallengeWatchSignal({
    schema: ARTICLE78_CHALLENGE_WATCH_SIGNAL_SCHEMA,
    policy_id: CHALLENGE_WATCH_POLICY.policy_id,
    label: CHALLENGE_WATCH_LABEL,
    determination_key: determination.determination_key,
    review_key: review?.review_key ?? null,
    as_of: cutoff.text,
    coverage_grade: coverageGrade.grade,
    level,
    features,
    basis,
    statement: renderChallengeWatchLevel({ level, basis }),
  });
}

function isAnchor(key) {
  return NAMED_PARTICIPATION_FEATURES.includes(key) || CHALLENGE_WATCH_POLICY.issue_anchor_features.includes(key);
}

/**
 * Walk the policy's level rules strongest-first and return the first that
 * holds. Written as a walk over `CHALLENGE_WATCH_POLICY.level_rules` rather
 * than as a chain of conditionals so the rules stay arguable as data: a reader
 * can print the policy object and see the whole ladder.
 */
function applyLevelRules(features) {
  const presentKeys = CHALLENGE_WATCH_FEATURE_KEYS.filter((key) => features[key].present);
  const anchorPresent = presentKeys.some((key) => isAnchor(key));
  const nonConspicuousPresent = presentKeys.filter((key) => !CONSPICUOUSNESS_ONLY_FEATURES.includes(key));

  for (const rule of CHALLENGE_WATCH_POLICY.level_rules) {
    if (rule.requires_anchor && !anchorPresent) continue;
    if (presentKeys.length < rule.minimum_present_features) continue;
    if (rule.minimum_non_conspicuousness_features !== undefined
      && nonConspicuousPresent.length < rule.minimum_non_conspicuousness_features) continue;
    return { level: rule.level, rule };
  }
  const floor = CHALLENGE_WATCH_POLICY.level_rules[CHALLENGE_WATCH_POLICY.level_rules.length - 1];
  return { level: floor.level, rule: floor };
}

function emitNull(reason, determination, cutoff, basis, coverageGrade) {
  const withRule = [...basis, {
    kind: "rule",
    rule_id: `null_${reason}`,
    level: "null",
    statement: CHALLENGE_WATCH_NULL_WORDING[reason],
  }];
  return assertChallengeWatchSignal({
    schema: ARTICLE78_CHALLENGE_WATCH_SIGNAL_SCHEMA,
    policy_id: CHALLENGE_WATCH_POLICY.policy_id,
    label: CHALLENGE_WATCH_LABEL,
    determination_key: determination.determination_key,
    review_key: null,
    as_of: cutoff.text,
    coverage_grade: coverageGrade,
    level: "null",
    features: {},
    null_reason: reason,
    basis: withRule,
    statement: CHALLENGE_WATCH_NULL_WORDING[reason],
  });
}

/** The one rendering entry point, asserting its own output before returning it. */
export function renderChallengeWatchLevel(result) {
  const text = result.level === "null"
    ? (CHALLENGE_WATCH_NULL_WORDING[result.null_reason]
      ?? `${CHALLENGE_WATCH_LABEL}: not established`)
    : CHALLENGE_WATCH_LEVEL_WORDING[result.level];
  if (typeof text !== "string") {
    throw new Article78ChallengeWatchError(`renderChallengeWatchLevel: no wording for level ${JSON.stringify(result.level)}`);
  }
  assertNoChallengeWatchPredictionWording([text], "renderChallengeWatchLevel");
  return text;
}

/**
 * The callable form of the card's rules. A result that reached `high` without
 * an anchor, or that let a document class alone carry a level above
 * `baseline`, is a validation error here rather than an intention documented
 * in a comment.
 */
export function assertChallengeWatchSignal(result, context = "challenge watch signal") {
  if (!result || typeof result !== "object") throw new Article78ChallengeWatchError(`${context}: malformed result`);
  if (result.label !== CHALLENGE_WATCH_LABEL) {
    throw new Article78ChallengeWatchError(`${context}: label must be ${JSON.stringify(CHALLENGE_WATCH_LABEL)}, got ${JSON.stringify(result.label)}`);
  }
  if (!CHALLENGE_WATCH_LEVELS.includes(result.level)) {
    throw new Article78ChallengeWatchError(`${context}: level ${JSON.stringify(result.level)} is not one of ${JSON.stringify(CHALLENGE_WATCH_LEVELS)}`);
  }
  if (typeof result.as_of !== "string" || result.as_of.trim() === "") {
    throw new Article78ChallengeWatchError(`${context}: every watch must carry the cutoff it was computed as of`);
  }
  if (!Array.isArray(result.basis) || result.basis.length === 0) {
    throw new Article78ChallengeWatchError(`${context}: a watch with no basis is a claim nobody can argue with`);
  }
  assertNoChallengeWatchPredictionWording(
    result.basis.map((entry) => entry.statement).filter((text) => typeof text === "string").concat([result.statement ?? ""]),
    context,
  );

  if (result.level === "null") {
    if (!CHALLENGE_WATCH_NULL_REASONS.includes(result.null_reason)) {
      throw new Article78ChallengeWatchError(`${context}: null_reason ${JSON.stringify(result.null_reason)} is not one of ${JSON.stringify(CHALLENGE_WATCH_NULL_REASONS)}`);
    }
    return result;
  }

  const features = result.features ?? {};
  for (const key of CHALLENGE_WATCH_FEATURE_KEYS) {
    const row = features[key];
    if (!row || typeof row.present !== "boolean") {
      throw new Article78ChallengeWatchError(`${context}: feature ${JSON.stringify(key)} is missing or carries no present flag`);
    }
    if (row.present && !Array.isArray(row.evidence)) {
      throw new Article78ChallengeWatchError(`${context}: present feature ${JSON.stringify(key)} must carry its evidence references`);
    }
    if (row.present && row.public_date === null) {
      throw new Article78ChallengeWatchError(
        `${context}: present feature ${JSON.stringify(key)} must carry the public date of the evidence that established it`,
      );
    }
    for (const ref of row.evidence ?? []) {
      if (ref.public_date === null || ref.public_date === undefined) {
        throw new Article78ChallengeWatchError(`${context}: feature ${JSON.stringify(key)} cites evidence with no public date`);
      }
    }
  }

  if (features.labor_organization_participation.suppression !== LABOR_PARTICIPATION_SUPPRESSION) {
    throw new Article78ChallengeWatchError(
      `${context}: the labor-participation feature must carry the suppression ${JSON.stringify(LABOR_PARTICIPATION_SUPPRESSION)}`,
    );
  }

  const presentKeys = CHALLENGE_WATCH_FEATURE_KEYS.filter((key) => features[key].present);
  const anchorPresent = presentKeys.some((key) => isAnchor(key));
  if (result.level === "high" && !anchorPresent) {
    throw new Article78ChallengeWatchError(
      `${context}: a high ${CHALLENGE_WATCH_LABEL} must rest on a specific preserved issue or a named participant; present features were ${JSON.stringify(presentKeys)}`,
    );
  }
  if (result.level === "high" && presentKeys.length < 2) {
    throw new Article78ChallengeWatchError(`${context}: a high ${CHALLENGE_WATCH_LABEL} needs a further feature beyond its anchor`);
  }
  if (presentKeys.every((key) => CONSPICUOUSNESS_ONLY_FEATURES.includes(key)) && result.level !== "baseline") {
    throw new Article78ChallengeWatchError(
      `${context}: ${CHALLENGE_WATCH_POLICY.document_class_ceiling.statement} Present features were ${JSON.stringify(presentKeys)} at level ${JSON.stringify(result.level)}`,
    );
  }
  if (!ARTICLE78_COUNTABLE_COVERAGE_GRADES.includes(result.coverage_grade)) {
    throw new Article78ChallengeWatchError(
      `${context}: a watch above null must rest on a countable coverage grade (${ARTICLE78_COUNTABLE_COVERAGE_GRADES.join("/")}), got ${JSON.stringify(result.coverage_grade)}`,
    );
  }
  return result;
}

/** Rank a level for comparison; `"null"` is the floor. */
export function challengeWatchLevelRank(level) {
  const index = CHALLENGE_WATCH_LEVELS.indexOf(level);
  if (index < 0) throw new Article78ChallengeWatchError(`challengeWatchLevelRank: unknown level ${JSON.stringify(level)}`);
  return index;
}
