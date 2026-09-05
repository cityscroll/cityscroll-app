/**
 * Reusable vendor procurement preferences, and a deterministic explanation of
 * why one record does or does not qualify against them
 * (procurement-pursuit-decision, Card "PPD-05").
 *
 * A vendor states agencies, categories, capability keywords, an amount
 * range, procurement methods, certification status/interest, a closing-date
 * window, and exclusions ONCE via `normalizePreferenceSet()`, then reuses
 * that same object across any number of records via `explainMatch()`. This
 * is a pure view-model module: it never fetches a source, never infers a
 * preference the vendor did not state, and never turns a preference into a
 * strategic bid/no-bid judgment. Eligibility (`explainMatch().eligible`) is
 * a mechanical AND over the preferences actually stated and actually
 * observable on the record -- it carries no score, weight, or rank, and this
 * module exports no ranking function. `orderExplanations()` only imposes a
 * deterministic presentation order on an already-eligible reason list.
 *
 * Reused, not reinvented:
 *   - resolveKeywordQuery() / keywordTextMatches() (./keyword_matcher.mjs) is
 *     the exact-token capability-keyword matcher already used elsewhere in
 *     this codebase -- no second substring/fuzzy matcher.
 *   - The record fields read here (agency_name, category_description,
 *     procurement_category, selection_method_description, method_family,
 *     contract_amount/amount, due_date, short_title/title,
 *     additional_description_1) are the same facet vocabulary
 *     procurement_browse_query.mjs already queries on -- this module adds no
 *     parallel enum for agency, category, method, or amount.
 *
 * Every preference-derived value that can reach a surface carries
 * `provenance: PREFERENCE_PROVENANCE_LABEL` ("user-supplied") -- a token
 * deliberately distinct from procurement_pursuit_snapshot.mjs's own
 * published-fact grammar (PURSUIT_FIELD_STATUS.USER_PROVIDED, spelled with an
 * underscore). `isUserSuppliedProvenanceLabel()` is exported so a renderer
 * cannot blend the two by accident.
 *
 * Negative rule: never infer a preference the vendor did not state, never
 * turn a preference into a strategic judgment (bid or no-bid), never fetch a
 * new source.
 */

import { resolveKeywordQuery, keywordTextMatches } from "./keyword_matcher.mjs";

export const PROCUREMENT_PREFERENCE_SET_SCHEMA = "cityscroll.procurement_preference_set.v1";
export const PROCUREMENT_PREFERENCE_MATCH_SCHEMA = "cityscroll.procurement_preference_match.v1";

/** The one provenance token every preference-derived reason carries. */
export const PREFERENCE_PROVENANCE_LABEL = "user-supplied";
export const PREFERENCE_PROVENANCE_VOCABULARY = Object.freeze({
  USER_SUPPLIED: PREFERENCE_PROVENANCE_LABEL,
});

/** True only for the exact preference-provenance token, never the
 * published-fact grammar's own "user_provided" (underscore) value. */
export function isUserSuppliedProvenanceLabel(label) {
  return label === PREFERENCE_PROVENANCE_LABEL;
}

/** True only when every reason in the list carries the preference-set's own
 * provenance token. A renderer that blends in a published-fact label (or any
 * other value) fails this check. */
export function reasonsCarryPreferenceProvenance(reasons) {
  return (Array.isArray(reasons) ? reasons : []).every(
    (reason) => reason && isUserSuppliedProvenanceLabel(reason.provenance),
  );
}

// Fixed, canonical iteration/presentation order. explainMatch() always walks
// fields in this order regardless of the input object's own key order, so
// output is deterministic under shuffled input (A3).
const REASON_FIELD_ORDER = Object.freeze([
  "agencies",
  "categories",
  "capability_keywords",
  "amount",
  "methods",
  "certification_interest",
  "closing_horizon",
  "exclusions.agencies",
  "exclusions.categories",
  "exclusions.methods",
  "exclusions.keywords",
]);

function text(value) {
  const s = String(value ?? "").trim();
  return s || null;
}

function stringList(value) {
  const raw = Array.isArray(value) ? value : (value == null ? [] : [value]);
  const cleaned = raw.map((v) => text(v)).filter(Boolean);
  return [...new Set(cleaned)].sort((a, b) => a.localeCompare(b));
}

function dateOnly(value) {
  const s = text(value);
  if (!s) return null;
  const candidate = s.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : null;
}

function pushError(errors, field, message) {
  errors.push({ field, message });
}

/**
 * Normalize a caller-stated preference set: stable key order, trimmed and
 * deduplicated values, validation errors named per field. A value that fails
 * validation (an inverted amount/date range, a malformed date, a
 * non-boolean interest flag) is never silently dropped -- it is preserved
 * in the normalized output and reported as a named error so the vendor's
 * stated intent stays inspectable.
 */
export function normalizePreferenceSet(input = {}) {
  const raw = input && typeof input === "object" ? input : {};
  const errors = [];

  const agencies = stringList(raw.agencies);
  const categories = stringList(raw.categories);
  const capabilityKeywords = stringList(raw.capabilityKeywords ?? raw.capability_keywords);
  const methods = stringList(raw.methods);
  const certificationStatus = stringList(raw.certificationStatus ?? raw.certification_status);

  let minAmount = null;
  if (raw.minAmount != null || raw.min_amount != null) {
    const n = Number(raw.minAmount ?? raw.min_amount);
    minAmount = Number.isFinite(n) ? n : null;
    if (!Number.isFinite(n)) pushError(errors, "minAmount", "not a finite number");
    else if (n < 0) pushError(errors, "minAmount", "must not be negative");
  }
  let maxAmount = null;
  if (raw.maxAmount != null || raw.max_amount != null) {
    const n = Number(raw.maxAmount ?? raw.max_amount);
    maxAmount = Number.isFinite(n) ? n : null;
    if (!Number.isFinite(n)) pushError(errors, "maxAmount", "not a finite number");
    else if (n < 0) pushError(errors, "maxAmount", "must not be negative");
  }
  if (minAmount != null && maxAmount != null && minAmount > maxAmount) {
    pushError(errors, "minAmount", "exceeds maxAmount");
  }

  let certificationInterest = null;
  if (raw.certificationInterest != null || raw.certification_interest != null) {
    const v = raw.certificationInterest ?? raw.certification_interest;
    if (typeof v === "boolean") certificationInterest = v;
    else pushError(errors, "certificationInterest", "must be a boolean");
  }

  const horizonInput = raw.closingHorizon ?? raw.closing_horizon ?? {};
  const notBeforeRaw = text(horizonInput.notBefore ?? horizonInput.not_before ?? horizonInput.after);
  const notAfterRaw = text(horizonInput.notAfter ?? horizonInput.not_after ?? horizonInput.before);
  const notBefore = notBeforeRaw ? dateOnly(notBeforeRaw) : null;
  const notAfter = notAfterRaw ? dateOnly(notAfterRaw) : null;
  if (notBeforeRaw && !notBefore) pushError(errors, "closingHorizon.notBefore", "not a valid YYYY-MM-DD date");
  if (notAfterRaw && !notAfter) pushError(errors, "closingHorizon.notAfter", "not a valid YYYY-MM-DD date");
  if (notBefore && notAfter && notBefore > notAfter) {
    pushError(errors, "closingHorizon", "notBefore is after notAfter");
  }

  const exclusionsInput = raw.exclusions && typeof raw.exclusions === "object" ? raw.exclusions : {};
  const exclusions = {
    agencies: stringList(exclusionsInput.agencies),
    categories: stringList(exclusionsInput.categories),
    methods: stringList(exclusionsInput.methods),
    keywords: stringList(exclusionsInput.keywords),
  };

  return {
    schema: PROCUREMENT_PREFERENCE_SET_SCHEMA,
    agencies,
    categories,
    capability_keywords: capabilityKeywords,
    min_amount: minAmount,
    max_amount: maxAmount,
    methods,
    certification_status: certificationStatus,
    certification_interest: certificationInterest,
    closing_horizon: {
      not_before: notBeforeRaw ? (notBefore || notBeforeRaw) : null,
      not_after: notAfterRaw ? (notAfter || notAfterRaw) : null,
    },
    exclusions,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Record field readers. Every reader returns null (never false, never an
// inferred default) when the underlying fact is not observed on the record,
// so an unobserved fact never produces a reason and never narrows results --
// the same non-narrowing rule unset preference fields follow (A5).
// ---------------------------------------------------------------------------

function observedAgency(record) {
  return text(record?.agency_name || record?.agency);
}

function observedCategories(record) {
  return [text(record?.category_description), text(record?.procurement_category)].filter(Boolean);
}

function observedMethods(record) {
  return [text(record?.selection_method_description), text(record?.method_family)].filter(Boolean);
}

function observedAmount(record) {
  const n = Number(record?.amount ?? record?.contract_amount);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function observedDueDate(record) {
  return dateOnly(record?.due_date ?? record?.closing_date);
}

function observedCorpusText(record) {
  return [record?.short_title, record?.title, record?.additional_description_1, record?.category_description]
    .map((v) => text(v))
    .filter(Boolean)
    .join(" — ");
}

function observedMwbeGoalPresent(record) {
  return typeof record?.mwbe_goal_present === "boolean" ? record.mwbe_goal_present : null;
}

// Substring overlap is only trusted at 3+ characters (either direction) --
// short tokens ("IT", "PS") produce too many coincidental hits inside longer
// published category/method text to count as a stated match.
const SUBSTRING_MATCH_MIN_LENGTH = 3;

function textIncludesAny(haystacks, needle) {
  const target = needle.toLowerCase();
  return haystacks.some((h) => {
    const hay = h.toLowerCase();
    if (hay === target) return true;
    if (target.length < SUBSTRING_MATCH_MIN_LENGTH || hay.length < SUBSTRING_MATCH_MIN_LENGTH) return false;
    return hay.includes(target) || target.includes(hay);
  });
}

function equalsAny(haystack, values) {
  const target = haystack.toLowerCase();
  return values.some((v) => v.toLowerCase() === target);
}

function formatMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `$${n.toLocaleString("en-US")}` : null;
}

function reason(field, satisfied, stated, observed, wording) {
  return { field, satisfied, stated, observed, wording, provenance: PREFERENCE_PROVENANCE_LABEL };
}

function agenciesReason(preferences, record) {
  if (!preferences.agencies.length) return null;
  const observed = observedAgency(record);
  if (!observed) return null;
  const satisfied = equalsAny(observed, preferences.agencies);
  return reason(
    "agencies", satisfied, preferences.agencies, observed,
    satisfied
      ? `This opportunity's agency (${observed}) matches one of your stated agencies.`
      : `This opportunity's agency (${observed}) is not one of your stated agencies (${preferences.agencies.join(", ")}).`,
  );
}

function categoriesReason(preferences, record) {
  if (!preferences.categories.length) return null;
  const observed = observedCategories(record);
  if (!observed.length) return null;
  const satisfied = preferences.categories.some((stated) => textIncludesAny(observed, stated));
  return reason(
    "categories", satisfied, preferences.categories, observed,
    satisfied
      ? `This opportunity's category (${observed.join(", ")}) matches one of your stated categories.`
      : `This opportunity's category (${observed.join(", ")}) does not match your stated categories (${preferences.categories.join(", ")}).`,
  );
}

function capabilityKeywordsReason(preferences, record) {
  if (!preferences.capability_keywords.length) return null;
  const corpus = observedCorpusText(record);
  if (!corpus) return null;
  const matched = preferences.capability_keywords.filter((kw) => keywordTextMatches(corpus, resolveKeywordQuery(kw)));
  const satisfied = matched.length > 0;
  return reason(
    "capability_keywords", satisfied, preferences.capability_keywords, corpus,
    satisfied
      ? `This opportunity's published text mentions your stated capability keyword(s): ${matched.join(", ")}.`
      : `This opportunity's published text does not mention any of your stated capability keywords (${preferences.capability_keywords.join(", ")}).`,
  );
}

function amountReason(preferences, record) {
  const { min_amount: min, max_amount: max } = preferences;
  if (min == null && max == null) return null;
  const observed = observedAmount(record);
  if (observed == null) return null;
  const satisfied = (min == null || observed >= min) && (max == null || observed <= max);
  const statedLabel = min != null && max != null
    ? `between ${formatMoney(min)} and ${formatMoney(max)}`
    : min != null
      ? `at least ${formatMoney(min)}`
      : `at most ${formatMoney(max)}`;
  return reason(
    "amount", satisfied, { min_amount: min, max_amount: max }, observed,
    satisfied
      ? `This opportunity's amount (${formatMoney(observed)}) falls within your stated amount preference (${statedLabel}).`
      : `This opportunity's amount (${formatMoney(observed)}) falls outside your stated amount preference (${statedLabel}).`,
  );
}

function methodsReason(preferences, record) {
  if (!preferences.methods.length) return null;
  const observed = observedMethods(record);
  if (!observed.length) return null;
  const satisfied = preferences.methods.some((stated) => textIncludesAny(observed, stated));
  return reason(
    "methods", satisfied, preferences.methods, observed,
    satisfied
      ? `This opportunity's procurement method (${observed.join(", ")}) matches one of your stated methods.`
      : `This opportunity's procurement method (${observed.join(", ")}) does not match your stated methods (${preferences.methods.join(", ")}).`,
  );
}

function certificationInterestReason(preferences, record) {
  if (preferences.certification_interest == null) return null;
  const observed = observedMwbeGoalPresent(record);
  if (observed == null) return null;
  const satisfied = observed === preferences.certification_interest;
  const stated = preferences.certification_interest;
  return reason(
    "certification_interest", satisfied, stated, observed,
    stated
      ? (satisfied
        ? "This opportunity carries a published M/WBE participation goal, matching your stated interest."
        : "This opportunity does not carry a published M/WBE participation goal, though you stated interest in opportunities that do.")
      : (satisfied
        ? "This opportunity does not carry a published M/WBE participation goal, matching your stated preference."
        : "This opportunity carries a published M/WBE participation goal, though you stated you are not looking for those."),
  );
}

function closingHorizonReason(preferences, record) {
  const { not_before: notBefore, not_after: notAfter } = preferences.closing_horizon;
  const validNotBefore = notBefore && dateOnly(notBefore) ? notBefore : null;
  const validNotAfter = notAfter && dateOnly(notAfter) ? notAfter : null;
  if (!validNotBefore && !validNotAfter) return null;
  const observed = observedDueDate(record);
  if (!observed) return null;
  const satisfied = (!validNotBefore || observed >= validNotBefore) && (!validNotAfter || observed <= validNotAfter);
  const statedLabel = validNotBefore && validNotAfter
    ? `${validNotBefore} to ${validNotAfter}`
    : validNotBefore
      ? `on or after ${validNotBefore}`
      : `on or before ${validNotAfter}`;
  return reason(
    "closing_horizon", satisfied, { not_before: validNotBefore, not_after: validNotAfter }, observed,
    satisfied
      ? `This opportunity's due date (${observed}) falls within your stated closing-horizon window (${statedLabel}).`
      : `This opportunity's due date (${observed}) falls outside your stated closing-horizon window (${statedLabel}).`,
  );
}

function exclusionReason(field, statedList, observedValues, matcher, label) {
  if (!statedList.length || !observedValues.length) return null;
  const hit = statedList.find((stated) => matcher(observedValues, stated));
  if (!hit) return null;
  return reason(
    `exclusions.${field}`, false, hit, observedValues,
    `Excluded: this opportunity's ${label} (${observedValues.join(", ")}) is in your stated exclusion list.`,
  );
}

function exclusionReasons(preferences, record) {
  const out = [];
  const agency = observedAgency(record);
  const agencyHit = agency
    ? exclusionReason("agencies", preferences.exclusions.agencies, [agency], textIncludesAny, "agency")
    : null;
  if (agencyHit) out.push(agencyHit);
  const categories = observedCategories(record);
  const categoryHit = exclusionReason("categories", preferences.exclusions.categories, categories, textIncludesAny, "category");
  if (categoryHit) out.push(categoryHit);
  const methods = observedMethods(record);
  const methodHit = exclusionReason("methods", preferences.exclusions.methods, methods, textIncludesAny, "procurement method");
  if (methodHit) out.push(methodHit);
  if (preferences.exclusions.keywords.length) {
    const corpus = observedCorpusText(record);
    if (corpus) {
      const hit = preferences.exclusions.keywords.find((kw) => keywordTextMatches(corpus, resolveKeywordQuery(kw)));
      if (hit) {
        out.push(reason(
          "exclusions.keywords", false, hit, corpus,
          `Excluded: this opportunity's published text mentions your stated exclusion keyword "${hit}".`,
        ));
      }
    }
  }
  return out;
}

/**
 * Explain whether one record qualifies against a stated preference set.
 * Deterministic: fields are always evaluated in the same fixed order
 * (REASON_FIELD_ORDER), independent of the input objects' own key order, so
 * the same record and preference set always produce byte-identical reasons.
 *
 * A reason is produced only when the preference field is stated AND the
 * corresponding fact is observed on the record -- an unset preference field
 * never narrows (A5), and an unobserved record fact never becomes a false
 * exclusion (the resident-read invariant: never infer a missing fact as a
 * negative).
 *
 * @returns {{ schema: string, eligible: boolean, reasons: object[], excluded_by: object|null }}
 */
export function explainMatch({ record = {}, preferences = null } = {}) {
  const prefs = preferences && preferences.schema === PROCUREMENT_PREFERENCE_SET_SCHEMA
    ? preferences
    : normalizePreferenceSet(preferences || {});
  const r = record || {};

  const byField = new Map();
  const set = (result) => { if (result) byField.set(result.field, result); };
  set(agenciesReason(prefs, r));
  set(categoriesReason(prefs, r));
  set(capabilityKeywordsReason(prefs, r));
  set(amountReason(prefs, r));
  set(methodsReason(prefs, r));
  set(certificationInterestReason(prefs, r));
  set(closingHorizonReason(prefs, r));
  for (const excl of exclusionReasons(prefs, r)) set(excl);

  const reasons = REASON_FIELD_ORDER.map((field) => byField.get(field)).filter(Boolean);
  const excludedBy = reasons.find((entry) => entry.field.startsWith("exclusions.")) || null;
  const eligible = reasons.length === 0 || reasons.every((entry) => entry.satisfied === true);

  return {
    schema: PROCUREMENT_PREFERENCE_MATCH_SCHEMA,
    eligible,
    reasons,
    excluded_by: excludedBy,
  };
}

/**
 * Deterministic presentation order for an already-eligible reason list --
 * documented as display order, never a relevance ranking. No score, weight,
 * or rank is computed or exposed anywhere in this module.
 */
export function orderExplanations(reasons) {
  const list = Array.isArray(reasons) ? reasons.slice() : [];
  const priority = new Map(REASON_FIELD_ORDER.map((field, index) => [field, index]));
  return list.sort((a, b) => {
    const pa = priority.has(a?.field) ? priority.get(a.field) : REASON_FIELD_ORDER.length;
    const pb = priority.has(b?.field) ? priority.get(b.field) : REASON_FIELD_ORDER.length;
    if (pa !== pb) return pa - pb;
    return String(a?.field || "").localeCompare(String(b?.field || ""));
  });
}
