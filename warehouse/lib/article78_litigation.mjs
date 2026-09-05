/**
 * A78-01: Article 78 litigation, modelled with search coverage and decision
 * supersession as first-class fields.
 *
 * Two facts about litigation data motivate every design choice below.
 *
 * The first is that a negative number in a litigation series is a claim about
 * search effort, not about the world. "Zero challenges" is only ever "zero
 * challenges found by a search whose bounds are written down"; a court-record
 * search that did not cover the right court, the right window or the right
 * party produces the same zero as a determination nobody ever sued over, and
 * nothing downstream can tell the two apart unless the search itself is a
 * stored entity. So `search_coverage` is a record here, not a footnote, and
 * `challengeWatchValue` refuses to return a number that is not attached to
 * one.
 *
 * The second is that a decision can be undone. A trial-level annulment
 * reversed on appeal is not a durable win, and a store that overwrites the
 * trial decision in place, or that reports the most recent decision by date,
 * cannot say so. Supersession is therefore an explicit edge with a recorded
 * procedural posture -- the same shape SEQRA-02 already uses for
 * `review_document -> supersedes_document` and `land_use_determination ->
 * decision_supersedes` -- and `applyDecisionSupersession` resolves the
 * effective decision by following those edges and nothing else. It never
 * infers supersession from dates.
 *
 * What this module does NOT do:
 *  - it never collapses filing, procedure, merits, remedy and relief into one
 *    number. `procedural_survival`, `durable_petitioner_relief` and
 *    `remedy_exposure` are three independently nullable fields, and
 *    `findCombinedOutcomeScoreFields` is the callable form of that rule
 *    rather than a comment (A3);
 *  - it emits no prediction, no probability that anyone will be sued, and no
 *    resident-facing legal conclusion. It records what a court record says
 *    and what a recorded search looked for;
 *  - it invents no parallel key scheme. Keys extend SEQRA-02's vocabulary and
 *    reuse its token normalization (`warehouse/lib/seqra_stable_keys.mjs`), so
 *    a court name or an index number normalizes the same way here as an agency
 *    name does there, and `projectToOntologyEntities` projects these records
 *    down onto SEQRA-02's frozen entity shapes so the relation graph can be
 *    validated against them rather than beside them.
 *
 * Determinism. Nothing here reads a clock, the network or the filesystem. The
 * as-of instant a challenge-watch value is computed against is taken from the
 * recorded searches themselves, which is also the honest answer to "as of
 * when?" -- a count of challenges is current as of the last search that
 * looked, never as of the moment somebody rendered the page.
 */
import { createHash } from "node:crypto";

import { normalizeKeyToken, SeqraStableKeyError } from "./seqra_stable_keys.mjs";

export const ARTICLE78_LITIGATION_SCHEMA = "cityscroll.article78_litigation.v1";
export const ARTICLE78_LITIGATION_SCHEMA_VERSION = 1;
const SCHEMA_PREFIX = "cityscroll.article78_litigation";

export class Article78LitigationError extends Error {
  constructor(message) {
    super(message);
    this.name = "Article78LitigationError";
  }
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

// ---------------------------------------------------------------------------
// Vocabularies.
// ---------------------------------------------------------------------------

/**
 * The jurisdiction boundary SEQRA-02 already draws: New York Article 78 and
 * hybrid proceedings only. No other case type is represented, and this module
 * deliberately offers no enum value that would let one in.
 */
export const ARTICLE78_JUDICIAL_REVIEW_REGIMES = Object.freeze(["NY_ARTICLE_78", "NY_HYBRID"]);

/** Court levels, ordered trial -> intermediate appellate -> highest. */
export const ARTICLE78_COURT_LEVELS = Object.freeze([
  "supreme_court",
  "appellate_division",
  "court_of_appeals",
  "other",
]);

/** SEQRA-02's `case_filing.filing_type` vocabulary, reused unchanged. */
export const ARTICLE78_FILING_TYPES = Object.freeze([
  "petition",
  "answer",
  "motion",
  "decision",
  "order",
  "stipulation",
  "other",
]);

/**
 * The filing types that carry an outcome. A filing of any other type records
 * that something was filed and nothing about who won; `decision` must be null
 * on those, which is the schema-level form of SEQRA-02's note that a
 * case_filing is "procedural, not merits or remedy".
 */
export const ARTICLE78_DECISION_FILING_TYPES = Object.freeze(["decision", "order"]);

/** SEQRA-02's `claim_theory.theory_category` vocabulary, reused unchanged. */
export const ARTICLE78_CLAIM_THEORY_CATEGORIES = Object.freeze([
  "procedural",
  "substantive_seqra_ceqr",
  "constitutional",
  "other",
]);

/**
 * Did the petition get past the threshold objections an Article 78 respondent
 * raises before the merits are reached? This is a fact about procedure only.
 * `not_reached` is not a synonym for `survived`: it means the decision did not
 * rule on the threshold question at all.
 */
export const ARTICLE78_PROCEDURAL_SURVIVAL_STATES = Object.freeze([
  "survived",
  "dismissed_standing",
  "dismissed_statute_of_limitations",
  "dismissed_ripeness",
  "dismissed_failure_to_join_necessary_party",
  "dismissed_other_threshold",
  "not_reached",
]);

/**
 * What the petitioner actually got from this decision. "Durable" is a
 * property of the decision that survives supersession, not of any single
 * decision in isolation -- `applyDecisionSupersession` is what makes the word
 * true, by reporting this field from the effective decision rather than from
 * whichever decision was found first.
 */
export const ARTICLE78_PETITIONER_RELIEF_STATES = Object.freeze([
  "none",
  "annulment",
  "remand_for_further_agency_action",
  "declaratory_relief",
  "injunctive_relief",
  "relief_by_stipulation",
]);

/**
 * What the approved project was exposed to as a result. Kept separate from
 * relief because the two come apart constantly: a remand that leaves every
 * permit in force is real relief and near-zero exposure, and a stay entered
 * without any merits ruling is exposure without relief.
 */
export const ARTICLE78_REMEDY_EXPOSURE_STATES = Object.freeze([
  "no_remedy_ordered",
  "record_remand_only",
  "supplemental_environmental_review_ordered",
  "approval_vacated",
  "construction_restrained",
]);

/**
 * What a later decision did to an earlier one. `affirmed` is recorded as an
 * edge like the rest, for one reason: it keeps every case's decision graph a
 * single chain with exactly one head, so "the effective decision" is a
 * structural fact rather than a date comparison. It is also the one
 * disposition that leaves the earlier decision's relief standing, which
 * `DISPOSITION_DISTURBS_RELIEF` states explicitly rather than leaving to a
 * reader.
 */
export const ARTICLE78_SUPERSESSION_DISPOSITIONS = Object.freeze([
  "affirmed",
  "reversed",
  "vacated",
  "modified",
  "remanded",
  "appeal_dismissed",
]);

const DISPOSITION_DISTURBS_RELIEF = Object.freeze({
  affirmed: false,
  appeal_dismissed: false,
  reversed: true,
  vacated: true,
  modified: true,
  remanded: true,
});

/** How the later decision came to be made. Required on every edge. */
export const ARTICLE78_PROCEDURAL_POSTURES = Object.freeze([
  "appeal_as_of_right",
  "appeal_by_permission",
  "motion_to_reargue",
  "motion_to_renew",
  "motion_to_vacate",
  "remand_from_higher_court",
  "other",
]);

/**
 * SEQRA-02's coverage grades, reused unchanged. Only A and B support a
 * counted challenge-watch value; C and U are recorded so that the inadequacy
 * itself is a fact in the store rather than a missing row.
 */
export const ARTICLE78_COVERAGE_GRADES = Object.freeze(["A", "B", "C", "U"]);
export const ARTICLE78_COUNTABLE_COVERAGE_GRADES = Object.freeze(["A", "B"]);

/**
 * CPLR 217(1): four months after the determination becomes final and binding
 * upon the petitioner. This is the general rule and not the only one -- some
 * land-use and municipal provisions carry their own shorter periods -- so a
 * determination context may override it with an explicit
 * `limitations_window_closes_on`, and this constant is the default used only
 * when it does not.
 */
export const ARTICLE78_LIMITATIONS_MONTHS = 4;

// ---------------------------------------------------------------------------
// Small shared helpers.
// ---------------------------------------------------------------------------

function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

function requireNonEmptyString(value, fieldName) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SeqraStableKeyError(`${fieldName} is required and must be a non-empty string`);
  }
  return value.trim();
}

function requireDateOnly(value, fieldName) {
  const raw = requireNonEmptyString(value, fieldName);
  if (!DATE_ONLY.test(raw)) {
    throw new SeqraStableKeyError(`${fieldName} must be an ISO date (YYYY-MM-DD), got ${JSON.stringify(value)}`);
  }
  return raw;
}

/**
 * Normalize an ISO instant into a key-safe token. The colons in an ISO
 * timestamp are the same character this repository's stable keys use as a
 * segment separator, so an instant cannot go into a key unmodified without
 * making the key ambiguous to split.
 */
export function normalizeInstantToken(value, fieldName = "instant") {
  const raw = requireNonEmptyString(value, fieldName);
  if (!INSTANT.test(raw)) {
    throw new SeqraStableKeyError(`${fieldName} must be a UTC ISO instant (YYYY-MM-DDTHH:MM:SSZ), got ${JSON.stringify(value)}`);
  }
  return raw.replace(/\.\d{1,3}Z$/, "Z").toLowerCase().replace(/[:-]/g, "");
}

/**
 * Add whole months to an ISO date, clamping the day to the last day of the
 * target month. October 31 plus four months is the last day of February, not
 * an overflow into March -- a limitations window that silently gained a day or
 * three would make a timely petition read as untimely.
 */
export function addMonthsToDate(date, months) {
  const iso = requireDateOnly(date, "date");
  if (!Number.isInteger(months)) throw new Article78LitigationError(`months must be an integer, got ${JSON.stringify(months)}`);
  const [year, month, day] = iso.split("-").map((part) => Number(part));
  const zeroBased = (month - 1) + months;
  const targetYear = year + Math.floor(zeroBased / 12);
  const targetMonth = ((zeroBased % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const targetDay = day < lastDay ? day : lastDay;
  return `${String(targetYear).padStart(4, "0")}-${String(targetMonth + 1).padStart(2, "0")}-${String(targetDay).padStart(2, "0")}`;
}

/** Stable JSON: object keys sorted at every depth, so a hash of it is stable. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

// ---------------------------------------------------------------------------
// Stable keys. Every builder is a deterministic function of identity inputs
// and throws rather than emitting an unstable key.
// ---------------------------------------------------------------------------

/**
 * `judicial_case:{court}:{index_number_or_hash}`.
 *
 * The hash branch exists because a case is sometimes first observed from a
 * decision text that names the court and the parties but not the index
 * number. The seed must itself be stable across re-observations of the same
 * case (court plus caption plus filing date, typically), never a fetch-time
 * value, or the same case fragments into two rows on the next crawl.
 */
export function buildJudicialCaseKey({ court, indexNumber = null, indexNumberHashSeed = null } = {}) {
  const courtSegment = normalizeKeyToken(court, "court");
  if (indexNumber != null && String(indexNumber).trim() !== "") {
    return `judicial_case:${courtSegment}:${normalizeKeyToken(indexNumber, "indexNumber")}`;
  }
  if (indexNumberHashSeed != null && String(indexNumberHashSeed).trim() !== "") {
    return `judicial_case:${courtSegment}:h${sha256Hex(String(indexNumberHashSeed)).slice(0, 16)}`;
  }
  throw new SeqraStableKeyError("judicial_case key requires indexNumber or indexNumberHashSeed");
}

/**
 * `case_filing:{case_key}:{filing_type}:{filed_date}:{source_hash_prefix}`,
 * following `review_document:{review_key}:{document_type}:{issued_date}:
 * {content_hash_prefix}`. The suffix is derived from the source record id, so
 * two distinct filings of the same type on the same day in the same case stay
 * distinct without a fetch-time counter.
 */
export function buildCaseFilingKey({ caseKey, filingType, filedDate, sourceRecordId } = {}) {
  const key = requireNonEmptyString(caseKey, "caseKey");
  if (!key.startsWith("judicial_case:")) {
    throw new SeqraStableKeyError(`caseKey must be a judicial_case stable key, got ${JSON.stringify(caseKey)}`);
  }
  const typeSegment = requireNonEmptyString(filingType, "filingType").toLowerCase();
  if (!ARTICLE78_FILING_TYPES.includes(typeSegment)) {
    throw new SeqraStableKeyError(`filingType ${JSON.stringify(filingType)} is not one of ARTICLE78_FILING_TYPES`);
  }
  const dateSegment = requireDateOnly(filedDate, "filedDate");
  const hashPrefix = sha256Hex(requireNonEmptyString(sourceRecordId, "sourceRecordId")).slice(0, 12);
  return `case_filing:${key}:${typeSegment}:${dateSegment}:${hashPrefix}`;
}

/**
 * `claim_theory:{case_key}:{theory_category}:{claim_hash_prefix}`. The hash is
 * taken over the normalized claim text so that the same theory pleaded twice
 * in one case resolves to one row, and two different theories in the same
 * category do not collide.
 */
export function buildClaimTheoryKey({ caseKey, theoryCategory, description } = {}) {
  const key = requireNonEmptyString(caseKey, "caseKey");
  if (!key.startsWith("judicial_case:")) {
    throw new SeqraStableKeyError(`caseKey must be a judicial_case stable key, got ${JSON.stringify(caseKey)}`);
  }
  const categorySegment = requireNonEmptyString(theoryCategory, "theoryCategory").toLowerCase();
  if (!ARTICLE78_CLAIM_THEORY_CATEGORIES.includes(categorySegment)) {
    throw new SeqraStableKeyError(`theoryCategory ${JSON.stringify(theoryCategory)} is not one of ARTICLE78_CLAIM_THEORY_CATEGORIES`);
  }
  const normalized = requireNonEmptyString(description, "description").toLowerCase().replace(/\s+/g, " ");
  return `claim_theory:${key}:${categorySegment}:${sha256Hex(normalized).slice(0, 12)}`;
}

/**
 * Hash the bounded scope of a court-record search. The key of a search is a
 * function of what it looked for, so re-running the identical search on a
 * later day produces a new coverage record (different `searched_at`) that is
 * recognisably the same query, while widening the courts or the date window
 * produces a different query rather than silently overwriting the narrower
 * one it replaced.
 */
export function hashSearchQuery(scope) {
  const normalized = normalizeSearchScope(scope);
  return sha256Hex(canonicalJson(normalized)).slice(0, 16);
}

/** `search_coverage:{source}:{query_hash}:{searched_at}` */
export function buildSearchCoverageKey({ source, queryHash, searchedAt } = {}) {
  const sourceSegment = normalizeKeyToken(source, "source");
  const hash = requireNonEmptyString(queryHash, "queryHash").toLowerCase();
  if (!/^[a-f0-9]{16}$/.test(hash)) {
    throw new SeqraStableKeyError(`queryHash must be the 16-hex digest hashSearchQuery returns, got ${JSON.stringify(queryHash)}`);
  }
  return `search_coverage:${sourceSegment}:${hash}:${normalizeInstantToken(searchedAt, "searchedAt")}`;
}

/** `decision_supersession:{superseding_decision_key}:{superseded_decision_key}` */
export function buildDecisionSupersessionKey({ supersedingDecisionKey, supersededDecisionKey } = {}) {
  const superseding = requireNonEmptyString(supersedingDecisionKey, "supersedingDecisionKey");
  const superseded = requireNonEmptyString(supersededDecisionKey, "supersededDecisionKey");
  for (const [label, value] of [["supersedingDecisionKey", superseding], ["supersededDecisionKey", superseded]]) {
    if (!value.startsWith("case_filing:")) {
      throw new SeqraStableKeyError(`${label} must be a case_filing stable key, got ${JSON.stringify(value)}`);
    }
  }
  if (superseding === superseded) {
    throw new SeqraStableKeyError("a decision cannot supersede itself");
  }
  return `decision_supersession:${superseding}:${superseded}`;
}

// ---------------------------------------------------------------------------
// A3: the no-combined-score rule, as a callable check rather than a comment.
// ---------------------------------------------------------------------------

/**
 * Field names that would reduce filing, procedure, merits, remedy and relief
 * to one number. The closed property sets below already reject an unknown
 * field, but "unsupported field" is the wrong finding for this one: a reader
 * of the validator output should be told which rule was broken, not merely
 * that a key was not on a list.
 *
 * Matched on whole tokens rather than substrings, for the reason SEQRA-09's
 * forbidden-estimate scan records: a substring rule flags innocent names and
 * misses camel-cased offenders in the same pass.
 */
export const COMBINED_OUTCOME_SCORE_TERMS = Object.freeze([
  "score",
  "scores",
  "rating",
  "composite",
  "overall",
  "combined",
  "strength",
  "severity",
  "risk",
  // `index` alone is deliberately absent, and `outcome_index` is here in its
  // place. In a court-records vocabulary the index number IS the identifier of
  // a proceeding, so a bare `index` token would reject `index_number` -- the
  // one field a case cannot be stored without. Every composite name that
  // matters carries a second flagged token anyway (`risk_index`,
  // `composite_index`, `overall_index`), which leaves exactly one gap to close
  // by hand.
  "outcome_index",
]);

function normalizeForTokenScan(text) {
  const collapsed = String(text)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `_${collapsed}_`;
}

/** Which field names in `names` read as a combined outcome score, if any. */
export function findCombinedOutcomeScoreFields(names) {
  const offenders = [];
  for (const name of names) {
    const normalized = normalizeForTokenScan(name);
    for (const term of COMBINED_OUTCOME_SCORE_TERMS) {
      if (normalized.includes(`_${term}_`)) offenders.push({ field: name, term });
    }
  }
  return offenders;
}

/**
 * Refuse any record carrying a combined outcome score. The three outcome
 * fields are reported separately or not at all; there is no field in this
 * module that could be renamed into a single number without tripping this.
 */
export function assertNoCombinedOutcomeScore(names, context = "case outcome") {
  const offenders = findCombinedOutcomeScoreFields(names);
  if (offenders.length > 0) {
    throw new Article78LitigationError(
      `${context}: filing, procedure, merits, remedy and relief are reported separately and are never combined into one number; offending field(s) ${JSON.stringify(offenders)}`,
    );
  }
  return { ok: true, checked_count: names.length, terms: COMBINED_OUTCOME_SCORE_TERMS };
}

// ---------------------------------------------------------------------------
// Record contracts.
// ---------------------------------------------------------------------------

function str(extra = {}) {
  return { type: "string", ...extra };
}
function strOrNull(extra = {}) {
  return { type: ["string", "null"], ...extra };
}
function enumStr(values, extra = {}) {
  return { type: "string", enum: [...values], ...extra };
}
function enumStrOrNull(values, extra = {}) {
  return { type: ["string", "null"], enum: [...values, null], ...extra };
}
function arrOfStr(extra = {}) {
  return { type: "array", items: { type: "string" }, ...extra };
}
function dateOnly(extra = {}) {
  return str({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", ...extra });
}
function dateOnlyOrNull(extra = {}) {
  return strOrNull({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", ...extra });
}
function instant(extra = {}) {
  return str({ pattern: INSTANT.source, ...extra });
}
function intMin(min, extra = {}) {
  return { type: "integer", minimum: min, ...extra };
}

/** SEQRA-02's minimal provenance envelope, unchanged. */
function provenanceFields() {
  return { observed_at: instant(), source_id: str(), source_record_id: str() };
}
const PROVENANCE_REQUIRED = ["observed_at", "source_id", "source_record_id"];

function record({ type, description, required, properties }) {
  return Object.freeze({
    schema: `${SCHEMA_PREFIX}.${type}.v${ARTICLE78_LITIGATION_SCHEMA_VERSION}`,
    record_type: type,
    description,
    required: Object.freeze([...required]),
    properties: Object.freeze(properties),
    additionalProperties: false,
  });
}

/**
 * The case outcome, as three independently nullable fields. Null means "this
 * decision does not say", which is a different fact from every value in every
 * enum -- notably from `procedural_survival: "not_reached"`, which means the
 * decision considered the question and declined to reach it.
 */
const CASE_OUTCOME_PROPERTIES = Object.freeze({
  court_level: enumStr(ARTICLE78_COURT_LEVELS),
  decided_date: dateOnly(),
  procedural_survival: enumStrOrNull(ARTICLE78_PROCEDURAL_SURVIVAL_STATES),
  durable_petitioner_relief: enumStrOrNull(ARTICLE78_PETITIONER_RELIEF_STATES),
  remedy_exposure: enumStrOrNull(ARTICLE78_REMEDY_EXPOSURE_STATES),
});
const CASE_OUTCOME_REQUIRED = Object.freeze([
  "court_level",
  "decided_date",
  "procedural_survival",
  "durable_petitioner_relief",
  "remedy_exposure",
]);

export const ARTICLE78_CASE_OUTCOME_FIELDS = Object.freeze([
  "procedural_survival",
  "durable_petitioner_relief",
  "remedy_exposure",
]);

/** The bounded scope of one court-record search. Every field is required. */
const SEARCH_SCOPE_PROPERTIES = Object.freeze({
  courts: arrOfStr({ minItems: 1 }),
  date_window: { type: "object" },
  party_filters: arrOfStr(),
  determination_filters: arrOfStr(),
});
const SEARCH_SCOPE_REQUIRED = Object.freeze(["courts", "date_window", "party_filters", "determination_filters"]);

export const ARTICLE78_RECORD_SPECS = Object.freeze({
  judicial_case: record({
    type: "judicial_case",
    description: "One New York Article 78 or hybrid proceeding challenging a land-use determination. Extends SEQRA-02's judicial_case identity shape with the county and caption a court-record search matches on.",
    required: [
      "record_schema", "case_key", "determination_key", "court", "court_level", "county",
      "index_number", "caption", "filed_date", "judicial_review_regime",
      "located_by_coverage_key", ...PROVENANCE_REQUIRED,
    ],
    properties: {
      record_schema: str(),
      case_key: str({ pattern: "^judicial_case:.+$" }),
      determination_key: str({ pattern: "^determination:[a-z0-9_]+:[a-z0-9_]+:\\d{4}-\\d{2}-\\d{2}$" }),
      court: str(),
      court_level: enumStr(ARTICLE78_COURT_LEVELS),
      county: strOrNull(),
      index_number: strOrNull(),
      caption: strOrNull(),
      filed_date: dateOnlyOrNull(),
      judicial_review_regime: enumStr(ARTICLE78_JUDICIAL_REVIEW_REGIMES),
      // Which recorded search found this case. A case with no coverage key is
      // a case somebody typed in; that is allowed, and it is why the field is
      // nullable rather than absent, but such a case cannot be counted by
      // challengeWatchValue, which only counts what a recorded search located.
      located_by_coverage_key: strOrNull({ pattern: "^search_coverage:.+$" }),
      ...provenanceFields(),
    },
  }),

  case_filing: record({
    type: "case_filing",
    description: "One filing within a proceeding. Filings of type decision or order carry a case outcome; every other filing type records that something was filed and nothing about who won.",
    required: [
      "record_schema", "filing_key", "case_key", "filing_type", "filed_date",
      "document_key", "decision", ...PROVENANCE_REQUIRED,
    ],
    properties: {
      record_schema: str(),
      filing_key: str({ pattern: "^case_filing:.+$" }),
      case_key: str({ pattern: "^judicial_case:.+$" }),
      filing_type: enumStr(ARTICLE78_FILING_TYPES),
      filed_date: dateOnly(),
      document_key: strOrNull(),
      decision: { type: ["object", "null"], nested: { properties: CASE_OUTCOME_PROPERTIES, required: CASE_OUTCOME_REQUIRED } },
      ...provenanceFields(),
    },
  }),

  claim_theory: record({
    type: "claim_theory",
    description: "One legal theory raised within a proceeding, kept separate from procedural survival, merits, remedy and relief so that what was argued is never read off what was won.",
    required: [
      "record_schema", "claim_key", "case_key", "theory_category", "description",
      "raised_in_filing_key", ...PROVENANCE_REQUIRED,
    ],
    properties: {
      record_schema: str(),
      claim_key: str({ pattern: "^claim_theory:.+$" }),
      case_key: str({ pattern: "^judicial_case:.+$" }),
      theory_category: enumStr(ARTICLE78_CLAIM_THEORY_CATEGORIES),
      description: str(),
      raised_in_filing_key: strOrNull({ pattern: "^case_filing:.+$" }),
      ...provenanceFields(),
    },
  }),

  search_coverage: record({
    type: "search_coverage",
    description: "One bounded court-record search: what was searched, over which courts and window, with which party and determination filters, how many results came back, and when. A challenge-watch value of zero resolves to one of these; without one there is no zero to report.",
    required: [
      "record_schema", "coverage_key", "determination_key", "source", "query_hash",
      "searched_at", "scope", "result_count", "located_case_keys", "coverage_grade",
      "coverage_note", ...PROVENANCE_REQUIRED,
    ],
    properties: {
      record_schema: str(),
      coverage_key: str({ pattern: "^search_coverage:[a-z0-9_]+:[a-f0-9]{16}:[0-9a-z]+$" }),
      determination_key: strOrNull({ pattern: "^determination:[a-z0-9_]+:[a-z0-9_]+:\\d{4}-\\d{2}-\\d{2}$" }),
      source: str(),
      query_hash: str({ pattern: "^[a-f0-9]{16}$" }),
      searched_at: instant(),
      scope: { type: "object", nested: { properties: SEARCH_SCOPE_PROPERTIES, required: SEARCH_SCOPE_REQUIRED } },
      // Raw hits the search returned, before any matching to a determination.
      // It is not the challenge count and must never be reported as one: a
      // docket search over a four-month window returns unrelated proceedings.
      result_count: intMin(0),
      located_case_keys: arrOfStr(),
      coverage_grade: enumStr(ARTICLE78_COVERAGE_GRADES),
      coverage_note: str(),
      ...provenanceFields(),
    },
  }),

  decision_supersession: record({
    type: "decision_supersession",
    description: "An explicit edge from a later decision to the earlier decision it affirmed, reversed, vacated, modified or remanded, with the procedural posture it arrived on. Supersession is never inferred from dates.",
    required: [
      "record_schema", "supersession_key", "case_key", "superseding_decision_key",
      "superseded_decision_key", "disposition", "procedural_posture", "effective_date",
      ...PROVENANCE_REQUIRED,
    ],
    properties: {
      record_schema: str(),
      supersession_key: str({ pattern: "^decision_supersession:case_filing:.+:case_filing:.+$" }),
      case_key: str({ pattern: "^judicial_case:.+$" }),
      superseding_decision_key: str({ pattern: "^case_filing:.+$" }),
      superseded_decision_key: str({ pattern: "^case_filing:.+$" }),
      disposition: enumStr(ARTICLE78_SUPERSESSION_DISPOSITIONS),
      procedural_posture: enumStr(ARTICLE78_PROCEDURAL_POSTURES),
      effective_date: dateOnly(),
      ...provenanceFields(),
    },
  }),
});

export const ARTICLE78_RECORD_TYPES = Object.freeze(Object.keys(ARTICLE78_RECORD_SPECS));

/**
 * The determination context `challengeWatchValue` needs. SEQRA-02's
 * `land_use_determination` records what the agency decided; it does not
 * record when that decision became final and binding upon a petitioner, which
 * is the date every Article 78 limitations question turns on. That
 * observation is carried here rather than bolted onto the frozen entity.
 */
export const ARTICLE78_DETERMINATION_CONTEXT_SPEC = record({
  type: "determination_context",
  description: "A land_use_determination plus the finality observation Article 78 timing depends on.",
  required: ["record_schema", "determination_key", "finality", "final_and_binding_date", "limitations_window_closes_on"],
  properties: {
    record_schema: str(),
    determination_key: str({ pattern: "^determination:[a-z0-9_]+:[a-z0-9_]+:\\d{4}-\\d{2}-\\d{2}$" }),
    // "unknown" is not a synonym for "nonfinal": it records that nobody has
    // established finality either way, and it produces the same null as
    // "nonfinal" for a different stated reason.
    finality: enumStr(["final", "nonfinal", "unknown"]),
    final_and_binding_date: dateOnlyOrNull(),
    limitations_window_closes_on: dateOnlyOrNull(),
  },
});

// ---------------------------------------------------------------------------
// Validation.
// ---------------------------------------------------------------------------

function typeMatches(value, typeSpec) {
  const types = Array.isArray(typeSpec) ? typeSpec : [typeSpec];
  return types.some((type) => {
    if (type === "null") return value === null;
    if (type === "string") return typeof value === "string";
    if (type === "number") return typeof value === "number" && Number.isFinite(value);
    if (type === "integer") return Number.isInteger(value);
    if (type === "boolean") return typeof value === "boolean";
    if (type === "array") return Array.isArray(value);
    if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
    return false;
  });
}

function validateFields(properties, required, obj, label, findings) {
  for (const field of required) {
    if (!(field in obj)) findings.push(`${label}: missing required field ${field}`);
  }
  const allowed = new Set(Object.keys(properties));
  const unsupported = Object.keys(obj).filter((key) => !allowed.has(key));
  for (const offender of findCombinedOutcomeScoreFields(unsupported)) {
    findings.push(`${label}: field ${offender.field} reads as a combined outcome score ("${offender.term}"); filing, procedure, merits, remedy and relief are reported separately and are never combined into one number`);
  }
  const flagged = new Set(findCombinedOutcomeScoreFields(unsupported).map((offender) => offender.field));
  for (const key of unsupported) {
    if (!flagged.has(key)) findings.push(`${label}: unsupported field ${key}`);
  }
  for (const [field, fieldSpec] of Object.entries(properties)) {
    if (!(field in obj)) continue;
    const value = obj[field];
    if (!typeMatches(value, fieldSpec.type)) {
      findings.push(`${label}: ${field} has wrong type (expected ${JSON.stringify(fieldSpec.type)})`);
      continue;
    }
    if (fieldSpec.enum && !fieldSpec.enum.includes(value)) {
      findings.push(`${label}: ${field} value ${JSON.stringify(value)} is not one of ${JSON.stringify(fieldSpec.enum)}`);
    }
    if (fieldSpec.pattern && typeof value === "string" && !new RegExp(fieldSpec.pattern).test(value)) {
      findings.push(`${label}: ${field} value ${JSON.stringify(value)} does not match ${fieldSpec.pattern}`);
    }
    if (typeof value === "number" && fieldSpec.minimum != null && value < fieldSpec.minimum) {
      findings.push(`${label}: ${field} below minimum ${fieldSpec.minimum}`);
    }
    if (Array.isArray(value)) {
      if (fieldSpec.minItems != null && value.length < fieldSpec.minItems) {
        findings.push(`${label}: ${field} requires at least ${fieldSpec.minItems} item(s)`);
      }
      if (fieldSpec.items) {
        value.forEach((item, index) => {
          if (!typeMatches(item, fieldSpec.items.type)) {
            findings.push(`${label}: ${field}[${index}] has wrong item type (expected ${JSON.stringify(fieldSpec.items.type)})`);
          }
        });
      }
    }
    if (fieldSpec.nested && value !== null && typeof value === "object" && !Array.isArray(value)) {
      validateFields(fieldSpec.nested.properties, fieldSpec.nested.required, value, `${label}.${field}`, findings);
    }
  }
}

/**
 * Validate one record against one A78-01 contract. Returns an array of
 * human-readable findings (empty when valid), following this repository's
 * `findings.push(...)` convention rather than throwing, so a caller can report
 * every violation at once.
 */
export function validateArticle78Record(recordType, obj, label = recordType) {
  const spec = ARTICLE78_RECORD_SPECS[recordType];
  const findings = [];
  if (!spec) {
    findings.push(`${label}: unknown A78-01 record type ${JSON.stringify(recordType)}`);
    return findings;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    findings.push(`${label}: malformed ${recordType} (not an object)`);
    return findings;
  }
  validateFields(spec.properties, spec.required, obj, label, findings);
  if (obj.record_schema !== undefined && obj.record_schema !== spec.schema) {
    findings.push(`${label}: record_schema ${JSON.stringify(obj.record_schema)} is not ${spec.schema}`);
  }
  findings.push(...validateRecordInvariants(recordType, obj, label));
  return findings;
}

/** The cross-field rules a per-field spec cannot express. */
function validateRecordInvariants(recordType, obj, label) {
  const findings = [];
  if (recordType === "case_filing") {
    const carriesOutcome = ARTICLE78_DECISION_FILING_TYPES.includes(obj.filing_type);
    if (carriesOutcome && obj.decision === null) {
      findings.push(`${label}: a ${obj.filing_type} filing must carry a decision block`);
    }
    if (!carriesOutcome && obj.decision !== null && obj.decision !== undefined) {
      findings.push(`${label}: a ${obj.filing_type} filing is procedural and must not carry a decision block`);
    }
    if (typeof obj.filing_key === "string" && typeof obj.case_key === "string"
      && !obj.filing_key.startsWith(`case_filing:${obj.case_key}:`)) {
      findings.push(`${label}: filing_key does not embed its own case_key`);
    }
  }
  if (recordType === "search_coverage") {
    const scope = obj.scope;
    if (scope && typeof scope === "object") {
      const window = scope.date_window;
      if (!window || typeof window !== "object" || !DATE_ONLY.test(window.from ?? "") || !DATE_ONLY.test(window.to ?? "")) {
        findings.push(`${label}: scope.date_window must carry ISO from and to dates`);
      } else if (window.from > window.to) {
        findings.push(`${label}: scope.date_window.from ${window.from} is after to ${window.to}`);
      }
      if (typeof obj.query_hash === "string" && obj.query_hash !== hashSearchQuery(scope)) {
        findings.push(`${label}: query_hash is not the digest of the recorded scope; a search whose key does not follow from its own bounds cannot be reproduced`);
      }
    }
    if (Array.isArray(obj.located_case_keys) && Number.isInteger(obj.result_count)
      && obj.located_case_keys.length > obj.result_count) {
      findings.push(`${label}: located_case_keys (${obj.located_case_keys.length}) exceeds result_count (${obj.result_count})`);
    }
    for (const [index, key] of (obj.located_case_keys ?? []).entries()) {
      if (typeof key !== "string" || !key.startsWith("judicial_case:")) {
        findings.push(`${label}: located_case_keys[${index}] is not a judicial_case stable key`);
      }
    }
  }
  if (recordType === "decision_supersession") {
    if (obj.superseding_decision_key === obj.superseded_decision_key) {
      findings.push(`${label}: a decision cannot supersede itself`);
    }
    if (typeof obj.supersession_key === "string"
      && obj.supersession_key !== `decision_supersession:${obj.superseding_decision_key}:${obj.superseded_decision_key}`) {
      findings.push(`${label}: supersession_key does not follow from the two decisions it joins`);
    }
  }
  return findings;
}

/** Validate a determination context against ARTICLE78_DETERMINATION_CONTEXT_SPEC. */
export function validateDeterminationContext(obj, label = "determination_context") {
  const findings = [];
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    findings.push(`${label}: malformed determination_context (not an object)`);
    return findings;
  }
  validateFields(ARTICLE78_DETERMINATION_CONTEXT_SPEC.properties, ARTICLE78_DETERMINATION_CONTEXT_SPEC.required, obj, label, findings);
  if (obj.record_schema !== undefined && obj.record_schema !== ARTICLE78_DETERMINATION_CONTEXT_SPEC.schema) {
    findings.push(`${label}: record_schema ${JSON.stringify(obj.record_schema)} is not ${ARTICLE78_DETERMINATION_CONTEXT_SPEC.schema}`);
  }
  if (obj.finality === "final" && !obj.final_and_binding_date) {
    findings.push(`${label}: a final determination must record the date it became final and binding, because the limitations window runs from it`);
  }
  return findings;
}

/**
 * Validate a whole record set, including the foreign keys that only resolve
 * across records: every filing and claim names a known case, every
 * supersession names two known decisions in the case it claims, and every
 * case's `located_by_coverage_key` names a known search.
 */
export function validateArticle78RecordSet({ cases = [], filings = [], claims = [], coverage = [], supersessions = [] } = {}) {
  const findings = [];
  const collect = (recordType, rows) => {
    const keyField = { judicial_case: "case_key", case_filing: "filing_key", claim_theory: "claim_key", search_coverage: "coverage_key", decision_supersession: "supersession_key" }[recordType];
    const seen = new Set();
    rows.forEach((row, index) => {
      const label = `${recordType}[${index}]`;
      findings.push(...validateArticle78Record(recordType, row, label));
      const key = row?.[keyField];
      if (typeof key === "string") {
        if (seen.has(key)) findings.push(`${label}: duplicate ${keyField} ${key}`);
        seen.add(key);
      }
    });
    return seen;
  };

  const caseKeys = collect("judicial_case", cases);
  const filingKeys = collect("case_filing", filings);
  collect("claim_theory", claims);
  const coverageKeys = collect("search_coverage", coverage);
  collect("decision_supersession", supersessions);

  const decisionKeys = new Set(filings.filter((row) => ARTICLE78_DECISION_FILING_TYPES.includes(row?.filing_type)).map((row) => row?.filing_key));
  const caseKeyByFiling = new Map(filings.map((row) => [row?.filing_key, row?.case_key]));

  cases.forEach((row, index) => {
    const key = row?.located_by_coverage_key;
    if (key != null && !coverageKeys.has(key)) {
      findings.push(`judicial_case[${index}]: located_by_coverage_key ${JSON.stringify(key)} does not resolve to a known search_coverage`);
    }
  });
  filings.forEach((row, index) => {
    if (!caseKeys.has(row?.case_key)) findings.push(`case_filing[${index}]: case_key ${JSON.stringify(row?.case_key)} does not resolve to a known judicial_case`);
  });
  claims.forEach((row, index) => {
    if (!caseKeys.has(row?.case_key)) findings.push(`claim_theory[${index}]: case_key ${JSON.stringify(row?.case_key)} does not resolve to a known judicial_case`);
    if (row?.raised_in_filing_key != null && !filingKeys.has(row.raised_in_filing_key)) {
      findings.push(`claim_theory[${index}]: raised_in_filing_key ${JSON.stringify(row.raised_in_filing_key)} does not resolve to a known case_filing`);
    }
  });
  coverage.forEach((row, index) => {
    for (const [position, key] of (row?.located_case_keys ?? []).entries()) {
      if (!caseKeys.has(key)) findings.push(`search_coverage[${index}]: located_case_keys[${position}] ${JSON.stringify(key)} does not resolve to a known judicial_case`);
    }
  });
  supersessions.forEach((row, index) => {
    for (const field of ["superseding_decision_key", "superseded_decision_key"]) {
      const key = row?.[field];
      if (!decisionKeys.has(key)) {
        findings.push(`decision_supersession[${index}]: ${field} ${JSON.stringify(key)} does not resolve to a known decision or order filing`);
        continue;
      }
      if (caseKeyByFiling.get(key) !== row?.case_key) {
        findings.push(`decision_supersession[${index}]: ${field} belongs to ${JSON.stringify(caseKeyByFiling.get(key))}, not to the declared case ${JSON.stringify(row?.case_key)}`);
      }
    }
  });

  return findings;
}

/** Throw on any finding. The assertion form, for callers that want one. */
export function assertValidArticle78RecordSet(recordSet, context = "article 78 record set") {
  const findings = validateArticle78RecordSet(recordSet);
  if (findings.length > 0) throw new Article78LitigationError(`${context}: ${findings.join("; ")}`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Search coverage.
// ---------------------------------------------------------------------------

/** Sort and de-duplicate the scope's list fields so the query hash is stable. */
export function normalizeSearchScope(scope) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    throw new Article78LitigationError("search scope must be an object carrying courts, date_window, party_filters and determination_filters");
  }
  const window = scope.date_window;
  if (!window || typeof window !== "object" || !DATE_ONLY.test(window.from ?? "") || !DATE_ONLY.test(window.to ?? "")) {
    throw new Article78LitigationError("search scope requires date_window: { from, to } as ISO dates");
  }
  const list = (values, fieldName) => {
    if (!Array.isArray(values)) throw new Article78LitigationError(`search scope ${fieldName} must be an array of strings`);
    return [...new Set(values.map((value) => requireNonEmptyString(value, `${fieldName} entry`)))].sort();
  };
  const courts = list(scope.courts, "courts");
  if (courts.length === 0) throw new Article78LitigationError("search scope requires at least one court; a search of no courts covers nothing");
  return {
    courts,
    date_window: { from: window.from, to: window.to },
    party_filters: list(scope.party_filters ?? [], "party_filters"),
    determination_filters: list(scope.determination_filters ?? [], "determination_filters"),
  };
}

/** Build a search_coverage record, with the key derived from the scope. */
export function buildSearchCoverageRecord({
  determinationKey = null,
  source,
  scope,
  searchedAt,
  resultCount,
  locatedCaseKeys = [],
  coverageGrade,
  coverageNote,
  observedAt,
  sourceId,
  sourceRecordId,
} = {}) {
  const normalizedScope = normalizeSearchScope(scope);
  const queryHash = hashSearchQuery(normalizedScope);
  const coverageRecord = {
    record_schema: ARTICLE78_RECORD_SPECS.search_coverage.schema,
    coverage_key: buildSearchCoverageKey({ source, queryHash, searchedAt }),
    determination_key: determinationKey,
    source: requireNonEmptyString(source, "source"),
    query_hash: queryHash,
    searched_at: searchedAt,
    scope: normalizedScope,
    result_count: resultCount,
    located_case_keys: [...locatedCaseKeys].sort(),
    coverage_grade: coverageGrade,
    coverage_note: coverageNote,
    observed_at: observedAt,
    source_id: sourceId,
    source_record_id: sourceRecordId,
  };
  const findings = validateArticle78Record("search_coverage", coverageRecord);
  if (findings.length > 0) throw new Article78LitigationError(`buildSearchCoverageRecord: ${findings.join("; ")}`);
  return coverageRecord;
}

/**
 * The limitations window a challenge to this determination would have to be
 * filed inside. Returns null when the determination is not final, because a
 * window that has not opened has no bounds.
 */
export function limitationsWindow(determination) {
  if (determination?.finality !== "final" || !determination.final_and_binding_date) return null;
  const opensOn = determination.final_and_binding_date;
  const closesOn = determination.limitations_window_closes_on
    ?? addMonthsToDate(opensOn, ARTICLE78_LIMITATIONS_MONTHS);
  return { opens_on: opensOn, closes_on: closesOn };
}

/**
 * Is this recorded search good enough to support a count for this
 * determination? Three separate questions, each answered separately, so that
 * a caller can say which one failed rather than only that something did.
 */
export function assessSearchCoverageAdequacy({ determination, coverage, window = null }) {
  const limits = window ?? limitationsWindow(determination);
  const targetsDetermination = coverage.determination_key === determination.determination_key
    || (coverage.scope?.determination_filters ?? []).includes(determination.determination_key);
  const gradeCountable = ARTICLE78_COUNTABLE_COVERAGE_GRADES.includes(coverage.coverage_grade);
  const spansWindow = Boolean(limits)
    && coverage.scope?.date_window?.from <= limits.opens_on
    && coverage.scope?.date_window?.to >= limits.closes_on;
  const reasons = [];
  if (!targetsDetermination) reasons.push("the search neither names this determination nor filters on it");
  if (!gradeCountable) reasons.push(`coverage grade ${JSON.stringify(coverage.coverage_grade)} is below the countable grades ${ARTICLE78_COUNTABLE_COVERAGE_GRADES.join("/")}`);
  if (!spansWindow) reasons.push("the searched date window does not span the whole limitations window");
  return {
    coverage_key: coverage.coverage_key,
    targets_determination: targetsDetermination,
    grade_countable: gradeCountable,
    spans_limitations_window: spansWindow,
    adequate: targetsDetermination && gradeCountable && spansWindow,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// A1/A2/A5: the challenge-watch derivation.
// ---------------------------------------------------------------------------

export const CHALLENGE_WATCH_SCHEMA = "cityscroll.article78_challenge_watch.v1";

export const CHALLENGE_WATCH_BASIS_REASONS = Object.freeze([
  "counted_under_recorded_search",
  "determination_not_final",
  "determination_finality_unknown",
  "limitations_window_open",
  "no_recorded_search",
  "recorded_search_does_not_cover_this_determination",
]);

/**
 * The one rendering a zero is allowed to have. It is a constant rather than a
 * string a caller assembles, because the whole failure this card exists to
 * prevent is a consumer looking at `value === 0` and writing the sentence
 * itself.
 */
export const CHALLENGE_WATCH_ZERO_WORDING = "no challenge found after the recorded search";

/**
 * The rendering for a null, per reason. Every one of them is phrased as an
 * absence in the record rather than as a fact about the world, matching the
 * `missing-data` register SEQRA-09's review card already renders in.
 */
export const CHALLENGE_WATCH_UNKNOWN_WORDING = Object.freeze({
  determination_not_final: "not established: this determination is not recorded as final and binding, so the challenge window has not opened",
  determination_finality_unknown: "not established: nobody has recorded whether this determination became final and binding, so there is no window to measure against",
  limitations_window_open: "not established: the challenge window is still open",
  no_recorded_search: "not established: no court-record search for this determination is on file",
  recorded_search_does_not_cover_this_determination: "not established: the recorded searches do not cover this determination",
});

/**
 * Sentences a consumer must never print from a challenge-watch value. Each of
 * them turns a fact about search effort into a fact about the world, which is
 * exactly the inference this module refuses to support.
 */
export const FORBIDDEN_CHALLENGE_WATCH_WORDINGS = Object.freeze([
  "no lawsuit was filed",
  "no lawsuits were filed",
  "no lawsuit has been filed",
  "no case was filed",
  "no cases were filed",
  "no challenge was filed",
  "no one sued",
  "nobody sued",
  "was never challenged",
  "was never sued",
  "never went to court",
  "no litigation",
  "not litigated",
  "unchallenged",
]);

function normalizeWordingForScan(text) {
  return ` ${String(text).toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim()} `;
}

/** Which forbidden sentences appear in this text, if any. */
export function findForbiddenChallengeWatchWording(text) {
  const normalized = normalizeWordingForScan(text);
  return FORBIDDEN_CHALLENGE_WATCH_WORDINGS.filter((phrase) => normalized.includes(` ${normalizeWordingForScan(phrase).trim()} `));
}

/** Refuse any rendering that reports a search result as a fact about the world. */
export function assertNoForbiddenChallengeWatchWording(texts, context = "challenge watch rendering") {
  const offenders = [];
  for (const text of texts) {
    for (const phrase of findForbiddenChallengeWatchWording(text)) offenders.push({ text, phrase });
  }
  if (offenders.length > 0) {
    throw new Article78LitigationError(
      `${context}: a court-search miss is never proof that no case was filed; offending wording ${JSON.stringify(offenders)}`,
    );
  }
  return { ok: true, checked_count: texts.length };
}

/** The rendering for a positive count. Plural handled here, not by callers. */
export function renderChallengeWatchCount(value) {
  return `${value} challenge${value === 1 ? "" : "s"} found by the recorded search`;
}

/**
 * The single rendering entry point. It asserts its own output against the
 * forbidden list before returning, so a future edit to a wording constant
 * cannot quietly reintroduce the sentence this card exists to prevent.
 */
export function renderChallengeWatchValue(result) {
  const text = result.value === null
    ? (CHALLENGE_WATCH_UNKNOWN_WORDING[result.basis.reason]
      ?? `not established: ${result.basis.reason}`)
    : result.value === 0
      ? CHALLENGE_WATCH_ZERO_WORDING
      : renderChallengeWatchCount(result.value);
  assertNoForbiddenChallengeWatchWording([text], "renderChallengeWatchValue");
  return text;
}

/**
 * How many Article 78 challenges to this determination a recorded search
 * located, or null when no honest count can be made.
 *
 * `value` is null -- never zero -- when the determination is not recorded as
 * final and binding, when the limitations window was still open as of the
 * search, or when no adequate recorded search covers the determination. Zero
 * means something narrower and stronger: an adequate search ran, its bounds
 * are on file, and it found nothing.
 *
 * `basis` names the coverage records the value rests on, so a consumer that
 * renders the number can also render what produced it. A zero whose basis
 * names no coverage record is a validation error, asserted below rather than
 * merely intended.
 *
 * `asOf` defaults to the latest `searched_at` among the supplied coverage.
 * That is deliberate: the count is current as of the last search that looked,
 * and taking it from a clock instead would make the same inputs produce
 * different answers on different days.
 */
export function challengeWatchValue({ determination, cases = [], coverage = [], asOf = null } = {}) {
  const contextFindings = validateDeterminationContext(determination);
  if (contextFindings.length > 0) {
    throw new Article78LitigationError(`challengeWatchValue: ${contextFindings.join("; ")}`);
  }
  coverage.forEach((row, index) => {
    const findings = validateArticle78Record("search_coverage", row, `coverage[${index}]`);
    if (findings.length > 0) throw new Article78LitigationError(`challengeWatchValue: ${findings.join("; ")}`);
  });

  const determinationKey = determination.determination_key;
  const relevantCoverage = coverage
    .filter((row) => row.determination_key === determinationKey
      || (row.scope?.determination_filters ?? []).includes(determinationKey))
    .sort((a, b) => (a.coverage_key < b.coverage_key ? -1 : 1));
  const searchedAt = relevantCoverage.map((row) => row.searched_at).sort();
  const effectiveAsOf = asOf ?? (searchedAt.length > 0 ? searchedAt[searchedAt.length - 1] : null);

  const window = limitationsWindow(determination);
  const emit = (value, reason, extra = {}) => {
    const basis = {
      reason,
      as_of: effectiveAsOf,
      coverage_keys: [],
      searched_at: [],
      limitations_window: window,
      located_case_keys: [],
      ...extra,
    };
    const result = { schema: CHALLENGE_WATCH_SCHEMA, determination_key: determinationKey, value, basis };
    basis.statement = renderChallengeWatchValue(result);
    return assertChallengeWatchResult(result);
  };

  if (determination.finality === "unknown") {
    return emit(null, "determination_finality_unknown");
  }
  if (determination.finality !== "final" || !window) {
    return emit(null, "determination_not_final");
  }
  if (relevantCoverage.length === 0) {
    return emit(null, "no_recorded_search");
  }

  const adequacy = relevantCoverage.map((row) => assessSearchCoverageAdequacy({ determination, coverage: row, window }));
  const adequate = relevantCoverage.filter((_, index) => adequacy[index].adequate);
  if (adequate.length === 0) {
    return emit(null, "recorded_search_does_not_cover_this_determination", {
      coverage_assessments: adequacy,
    });
  }

  // The window closes on `closes_on`; a search run on that day has not yet
  // seen a petition filed later the same day, so the count is only safe once
  // the search postdates the close.
  const latestAdequateSearch = adequate.map((row) => row.searched_at).sort().slice(-1)[0];
  if (latestAdequateSearch.slice(0, 10) <= window.closes_on) {
    return emit(null, "limitations_window_open", {
      coverage_keys: adequate.map((row) => row.coverage_key).sort(),
      searched_at: adequate.map((row) => row.searched_at).sort(),
      coverage_assessments: adequacy,
    });
  }

  const adequateKeys = new Set(adequate.map((row) => row.coverage_key));
  const locatedCaseKeys = [...new Set(
    cases
      .filter((row) => row.determination_key === determinationKey && adequateKeys.has(row.located_by_coverage_key))
      .map((row) => row.case_key),
  )].sort();

  return emit(locatedCaseKeys.length, "counted_under_recorded_search", {
    coverage_keys: adequate.map((row) => row.coverage_key).sort(),
    searched_at: adequate.map((row) => row.searched_at).sort(),
    located_case_keys: locatedCaseKeys,
    coverage_assessments: adequacy,
  });
}

/**
 * The callable form of A1's rule: a zero must resolve to the bounded search
 * that produced it. A zero carrying no coverage record is a validation error,
 * not a zero, and this is where that is enforced rather than assumed.
 */
export function assertChallengeWatchResult(result, context = "challenge watch value") {
  if (!result || typeof result !== "object") throw new Article78LitigationError(`${context}: malformed result`);
  const { value, basis } = result;
  if (value !== null && !Number.isInteger(value)) {
    throw new Article78LitigationError(`${context}: value must be an integer or null, got ${JSON.stringify(value)}`);
  }
  if (!basis || !CHALLENGE_WATCH_BASIS_REASONS.includes(basis.reason)) {
    throw new Article78LitigationError(`${context}: basis.reason ${JSON.stringify(basis?.reason)} is not one of ${JSON.stringify(CHALLENGE_WATCH_BASIS_REASONS)}`);
  }
  if (value !== null && (!Array.isArray(basis.coverage_keys) || basis.coverage_keys.length === 0)) {
    throw new Article78LitigationError(
      `${context}: a counted value must name the recorded search that produced it; a ${value} with no coverage record is a validation error, not a ${value}`,
    );
  }
  if (value !== null && basis.reason !== "counted_under_recorded_search") {
    throw new Article78LitigationError(`${context}: a counted value must carry reason "counted_under_recorded_search", got ${JSON.stringify(basis.reason)}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// A4: decision supersession.
// ---------------------------------------------------------------------------

export const DECISION_SUPERSESSION_SCHEMA = "cityscroll.article78_effective_decision.v1";

/** Does this disposition disturb the relief the earlier decision granted? */
export function dispositionDisturbsRelief(disposition) {
  if (!(disposition in DISPOSITION_DISTURBS_RELIEF)) {
    throw new Article78LitigationError(`unknown disposition ${JSON.stringify(disposition)}`);
  }
  return DISPOSITION_DISTURBS_RELIEF[disposition];
}

/**
 * Resolve the currently effective decision for every case in `decisions`, by
 * following explicit supersession edges and nothing else.
 *
 * The rule is structural, not chronological: a decision is superseded exactly
 * when some edge names it as superseded, and the effective decision is the one
 * no edge supersedes. A case with two unsuperseded decisions is reported
 * `unresolved` rather than silently resolved to the later date -- a store that
 * guesses here is a store that will eventually report a reversed trial win as
 * a durable one, which is the failure this whole edge type exists to prevent.
 *
 * The returned `case_outcome` is read from the effective decision, which is
 * what makes `durable_petitioner_relief` durable rather than merely granted.
 * The three fields are carried across separately and are never combined.
 */
export function applyDecisionSupersession(decisions = [], supersessions = []) {
  if (!Array.isArray(decisions)) throw new Article78LitigationError("applyDecisionSupersession requires an array of decision filings");
  if (!Array.isArray(supersessions)) throw new Article78LitigationError("applyDecisionSupersession requires an array of decision_supersession edges");

  const decisionsByKey = new Map();
  for (const filing of decisions) {
    if (!ARTICLE78_DECISION_FILING_TYPES.includes(filing?.filing_type)) {
      throw new Article78LitigationError(
        `applyDecisionSupersession: ${JSON.stringify(filing?.filing_key)} is a ${JSON.stringify(filing?.filing_type)} filing, not a decision or order`,
      );
    }
    if (decisionsByKey.has(filing.filing_key)) {
      throw new Article78LitigationError(`applyDecisionSupersession: duplicate decision ${filing.filing_key}`);
    }
    decisionsByKey.set(filing.filing_key, filing);
  }
  for (const edge of supersessions) {
    for (const field of ["superseding_decision_key", "superseded_decision_key"]) {
      if (!decisionsByKey.has(edge?.[field])) {
        throw new Article78LitigationError(`applyDecisionSupersession: edge ${JSON.stringify(edge?.supersession_key)} names an unknown decision in ${field}`);
      }
    }
  }

  const caseKeys = [...new Set(decisions.map((filing) => filing.case_key))].sort();
  return caseKeys.map((caseKey) => {
    const caseDecisions = decisions.filter((filing) => filing.case_key === caseKey);
    const caseEdges = supersessions
      .filter((edge) => edge.case_key === caseKey)
      .sort((a, b) => (a.supersession_key < b.supersession_key ? -1 : 1));

    const supersededBy = new Map();
    const duplicateSupersessions = [];
    for (const edge of caseEdges) {
      if (supersededBy.has(edge.superseded_decision_key)) {
        duplicateSupersessions.push(edge.superseded_decision_key);
        continue;
      }
      supersededBy.set(edge.superseded_decision_key, edge);
    }

    const heads = caseDecisions.filter((filing) => !supersededBy.has(filing.filing_key));
    const cycle = detectSupersessionCycle(caseDecisions, supersededBy);

    let unresolved = null;
    if (cycle) {
      unresolved = `supersession edges form a cycle through ${cycle.join(" -> ")}`;
    } else if (duplicateSupersessions.length > 0) {
      unresolved = `more than one decision claims to supersede ${[...new Set(duplicateSupersessions)].sort().join(", ")}`;
    } else if (heads.length === 0) {
      unresolved = "every recorded decision is superseded, so no decision is currently effective";
    } else if (heads.length > 1) {
      unresolved = `${heads.length} decisions are unsuperseded (${heads.map((filing) => filing.filing_key).sort().join(", ")}); supersession is explicit and is never inferred from dates`;
    }

    const effective = unresolved === null ? heads[0] : null;
    const chain = [];
    if (effective) {
      let current = effective.filing_key;
      const seen = new Set([current]);
      // Walk backwards from the head through the decisions it displaced.
      for (;;) {
        const edge = caseEdges.find((candidate) => candidate.superseding_decision_key === current);
        if (!edge || seen.has(edge.superseded_decision_key)) break;
        chain.push({
          superseding_decision_key: edge.superseding_decision_key,
          superseded_decision_key: edge.superseded_decision_key,
          disposition: edge.disposition,
          procedural_posture: edge.procedural_posture,
          effective_date: edge.effective_date,
          disturbs_relief: dispositionDisturbsRelief(edge.disposition),
        });
        seen.add(edge.superseded_decision_key);
        current = edge.superseded_decision_key;
      }
    }

    const outcome = effective?.decision ?? null;
    return {
      schema: DECISION_SUPERSESSION_SCHEMA,
      case_key: caseKey,
      effective_decision_key: effective?.filing_key ?? null,
      effective_decision_court_level: outcome?.court_level ?? null,
      effective_decision_date: outcome?.decided_date ?? null,
      superseded_decision_keys: [...supersededBy.keys()].sort(),
      supersession_chain: chain,
      // Three fields, carried across separately. There is no fourth field
      // here, and no code path that reduces these to one.
      case_outcome: {
        procedural_survival: outcome?.procedural_survival ?? null,
        durable_petitioner_relief: outcome?.durable_petitioner_relief ?? null,
        remedy_exposure: outcome?.remedy_exposure ?? null,
      },
      unresolved,
    };
  });
}

function detectSupersessionCycle(caseDecisions, supersededBy) {
  for (const filing of caseDecisions) {
    const seen = [];
    let current = filing.filing_key;
    while (supersededBy.has(current)) {
      if (seen.includes(current)) return [...seen.slice(seen.indexOf(current)), current];
      seen.push(current);
      current = supersededBy.get(current).superseding_decision_key;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Projection onto SEQRA-02's frozen entity shapes.
// ---------------------------------------------------------------------------

/**
 * Project these records down onto SEQRA-02's `judicial_case`, `case_filing`,
 * `claim_theory` and `search_coverage` entity shapes, so that the relation
 * graph can be validated with `warehouse/lib/seqra_ontology_graph.mjs`
 * against them rather than beside them. The projection is lossy by design:
 * SEQRA-02's entities carry identity and relationship shape, and the fields
 * this card adds -- the bounded search scope, the case outcome, the
 * supersession edge -- stay here.
 */
export function projectToOntologyEntities({ cases = [], filings = [], claims = [], coverage = [] } = {}) {
  return {
    judicial_case: cases.map((row) => ({
      case_key: row.case_key,
      determination_key: row.determination_key,
      court: row.court,
      index_number: row.index_number,
      filed_date: row.filed_date,
      judicial_review_regime: row.judicial_review_regime,
      observed_at: row.observed_at,
      source_id: row.source_id,
      source_record_id: row.source_record_id,
    })),
    case_filing: filings.map((row) => ({
      filing_key: row.filing_key,
      case_key: row.case_key,
      filing_type: row.filing_type,
      filed_date: row.filed_date,
      document_key: row.document_key,
      observed_at: row.observed_at,
      source_id: row.source_id,
      source_record_id: row.source_record_id,
    })),
    claim_theory: claims.map((row) => ({
      claim_key: row.claim_key,
      case_key: row.case_key,
      theory_category: row.theory_category,
      description: row.description,
      observed_at: row.observed_at,
      source_id: row.source_id,
      source_record_id: row.source_record_id,
    })),
    search_coverage: coverage.map((row) => ({
      coverage_key: row.coverage_key,
      determination_key: row.determination_key,
      systems_searched: [row.source, ...row.scope.courts].sort(),
      coverage_grade: row.coverage_grade,
      search_date: row.searched_at.slice(0, 10),
      observed_at: row.observed_at,
      source_id: row.source_id,
      source_record_id: row.source_record_id,
    })),
  };
}
