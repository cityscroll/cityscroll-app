/**
 * Record-varying procurement coverage copy.
 *
 * Labels render only when a method/policy/coverage predicate is informative.
 * Unknown methods, source absence, and empty facets emit nothing. Candidate
 * gaps stay coverage facts — never compliance verdicts or always-on caveats.
 */

export const PROCUREMENT_COVERAGE_LABEL_SCHEMA = "cityscroll.procurement_coverage_label.v1";
export const PROCUREMENT_COVERAGE_FACT_SCHEMA = "cityscroll.procurement_coverage_fact.v1";

export const PROCUREMENT_COVERAGE_KINDS = Object.freeze({
  TARGETED_SMALL_PURCHASE: "targeted_small_purchase",
  MWBE_AWARD_NOTICE_NOT_YET_FOUND: "mwbe_award_notice_not_yet_found",
  OBSERVED_VS_PUBLISHER: "observed_vs_publisher",
});

const COPY = Object.freeze({
  [PROCUREMENT_COVERAGE_KINDS.TARGETED_SMALL_PURCHASE]: Object.freeze({
    key: "procurement_coverage_targeted_small_purchase",
    fallback: "Targeted small-purchase — no public solicitation required",
  }),
  [PROCUREMENT_COVERAGE_KINDS.MWBE_AWARD_NOTICE_NOT_YET_FOUND]: Object.freeze({
    key: "procurement_coverage_mwbe_award_not_yet_found",
    fallback: "M/WBE award notice not yet found",
  }),
  [PROCUREMENT_COVERAGE_KINDS.OBSERVED_VS_PUBLISHER]: Object.freeze({
    key: "procurement_coverage_counts",
    fallback: "{observed} observed, publisher reports {publisher}",
  }),
});

const ORDINARY_FAMILIES = new Set(["ordinary_micropurchase", "ordinary_5_plus_10"]);
const POLICY_FAMILIES = new Set([
  "ordinary_micropurchase",
  "ordinary_5_plus_10",
  "mwbe_small_purchase",
]);

/** Exact publisher labels only. Variants stay unmapped and make no legal claim. */
const EXACT_METHOD_FAMILY = Object.freeze({
  MICROPURCHASE: "ordinary_micropurchase",
  "SMALL PURCHASE UNDER $5000": "ordinary_micropurchase",
  "SMALL PURCHASE WRITTEN": "ordinary_5_plus_10",
  "MWBE NON COMPETITIVE SMALL PURCHASE": "mwbe_small_purchase",
  "M WBE SMALL PURCHASE": "mwbe_small_purchase",
  "M WBE SMALL PURCHASE RENEWALS": "mwbe_small_purchase",
});

const AMOUNT_BANDS = Object.freeze({
  ordinary_micropurchase: Object.freeze({
    goods_and_non_construction_services: Object.freeze({ min: 0, minInclusive: true, max: 20_000, maxInclusive: true }),
    construction: Object.freeze({ min: 0, minInclusive: true, max: 35_000, maxInclusive: true }),
  }),
  ordinary_5_plus_10: Object.freeze({
    goods_and_non_construction_services: Object.freeze({ min: 20_000, minInclusive: false, max: 100_000, maxInclusive: true }),
    construction: Object.freeze({ min: 35_000, minInclusive: false, max: 100_000, maxInclusive: true }),
  }),
  mwbe_small_purchase: Object.freeze({
    goods_and_non_construction_services: Object.freeze({ min: 20_000, minInclusive: false, max: 1_500_000, maxInclusive: true }),
    construction: Object.freeze({ min: 35_000, minInclusive: false, max: 1_500_000, maxInclusive: true }),
  }),
});

const CATEGORIES = Object.freeze([
  "goods_and_non_construction_services",
  "construction",
]);

const POLICY_EFFECTIVE_FROM = "2023-06-03";

function clean(value, max = 240) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function interpolate(template, variables = {}) {
  return Object.entries(variables).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    template,
  );
}

function count(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isoDay(value) {
  const text = clean(value, 40);
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

function amountOf(value) {
  if (Number.isFinite(value)) return value;
  const text = clean(value, 80).replace(/[$,]/g, "");
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function amountWithin(amount, band) {
  if (!Number.isFinite(amount) || !band) return false;
  if (band.minInclusive ? amount < band.min : amount <= band.min) return false;
  if (band.maxInclusive ? amount > band.max : amount >= band.max) return false;
  return true;
}

function dateApplies(occurredOn) {
  return validDate(occurredOn) && occurredOn >= POLICY_EFFECTIVE_FROM;
}

function normalizePublisherMethod(value) {
  return clean(value, 160)
    .toUpperCase()
    .replace(/,/g, "")
    .replace(/[./]/g, " ")
    .replace(/[^A-Z0-9$]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Map an exact publisher method label. Unknown strings stay unmapped. */
export function mapPublisherMethodFamily(value) {
  const normalized = normalizePublisherMethod(value);
  return EXACT_METHOD_FAMILY[normalized] || null;
}

function familyMatches(familyId, record) {
  if (!POLICY_FAMILIES.has(familyId) || !dateApplies(record.occurred_on)) return false;
  if (familyId === "mwbe_small_purchase" && record.procurement_category === "human_services") {
    return false;
  }
  const bands = AMOUNT_BANDS[familyId];
  const amount = amountOf(record.amount);
  const categories = CATEGORIES.includes(record.procurement_category)
    ? [record.procurement_category]
    : CATEGORIES;
  return categories.some((category) => amountWithin(amount, bands[category]));
}

function resolvedPolicy(record, stageId) {
  if (record?.policy_match && record?.publication_obligation) {
    return {
      policy_match: record.policy_match,
      publication_obligation: record.publication_obligation,
      method_family: record.method_family || null,
      coverage_state: record.coverage_state || "unknown",
      stage: stageId || record.stage || null,
    };
  }

  const family = POLICY_FAMILIES.has(record?.method_family)
    ? record.method_family
    : mapPublisherMethodFamily(record?.publisher_method || record?.selection_method_description);
  if (!family || !familyMatches(family, record || {})) {
    return {
      policy_match: family ? "unmatched" : "unmapped",
      publication_obligation: "unknown",
      method_family: family || "unmapped_publisher_variant",
      coverage_state: record?.coverage_state || "unknown",
      stage: stageId || record?.stage || null,
    };
  }

  const obligation = family === "mwbe_small_purchase" && stageId === "award"
    ? "required"
    : "not_required";
  return {
    policy_match: "matched",
    publication_obligation: obligation,
    method_family: family,
    coverage_state: record?.coverage_state || "not_checked",
    stage: stageId,
  };
}

function signal(kind, variables = {}) {
  const copy = COPY[kind];
  return Object.freeze({
    schema: kind === PROCUREMENT_COVERAGE_KINDS.OBSERVED_VS_PUBLISHER
      ? PROCUREMENT_COVERAGE_FACT_SCHEMA
      : PROCUREMENT_COVERAGE_LABEL_SCHEMA,
    kind,
    i18n_key: copy.key,
    fallback: copy.fallback,
    variables: Object.freeze(variables),
    is_compliance_verdict: false,
  });
}

/**
 * Record label for one resolved policy+coverage predicate.
 * Default is silence: unknown, unmatched, and observed-required rows stay blank.
 */
export function projectProcurementCoverageLabel(record = {}, stageId = null) {
  const stage = stageId || record.stage || null;
  const policy = resolvedPolicy(record, stage);
  if (policy.policy_match !== "matched") return null;

  if (
    policy.method_family === "mwbe_small_purchase"
    && (stage === "award" || stage == null)
    && (policy.publication_obligation === "required" || stage == null)
    && policy.coverage_state === "source_checked_no_record"
  ) {
    const award = stage === "award" ? policy : resolvedPolicy(record, "award");
    if (award.policy_match === "matched" && award.publication_obligation === "required") {
      return signal(PROCUREMENT_COVERAGE_KINDS.MWBE_AWARD_NOTICE_NOT_YET_FOUND);
    }
  }

  if (
    ORDINARY_FAMILIES.has(policy.method_family)
    && policy.publication_obligation === "not_required"
  ) {
    return signal(PROCUREMENT_COVERAGE_KINDS.TARGETED_SMALL_PURCHASE);
  }

  return null;
}

/**
 * Collection coverage sentence. Empty facets stay silent unless both counts
 * exist and disagree. Never emits an always-on incompleteness caveat.
 */
export function projectProcurementCoverageFact({
  observed_count = null,
  publisher_count = null,
  facet_empty = false,
} = {}) {
  const observed = count(observed_count);
  const publisher = count(publisher_count);
  if (publisher == null) return null;
  if (facet_empty && observed == null) return null;
  const seen = observed ?? (facet_empty ? 0 : null);
  if (seen == null || seen === publisher) return null;
  return signal(PROCUREMENT_COVERAGE_KINDS.OBSERVED_VS_PUBLISHER, {
    observed: seen,
    publisher,
  });
}

function snapshotRows(observations) {
  return (Array.isArray(observations) ? observations : [])
    .map((entry) => entry?.snapshot || entry?.normalized_snapshot || entry)
    .filter((row) => row && typeof row === "object" && !Array.isArray(row));
}

function firstField(rows, fields) {
  for (const row of rows) {
    for (const field of fields) {
      const value = row?.[field];
      if (value != null && clean(value)) return value;
    }
  }
  return null;
}

/** Build a fail-closed coverage input from a procurement object + observations. */
export function coverageInputFromProcurement(object = {}, observations = []) {
  const rows = snapshotRows(observations);
  const amount = amountOf(firstField(rows, [
    "contract_amount", "award_amount", "current_amount", "current", "amount", "check_amount",
  ]));
  return {
    method_family: object.method_family || firstField(rows, ["method_family"]) || null,
    publisher_method: firstField(rows, [
      "selection_method_description",
      "procurement_method",
      "prime_contract_award_method",
      "award_method",
      "method",
    ]),
    procurement_category: object.procurement_category
      || firstField(rows, ["procurement_category"])
      || null,
    amount,
    occurred_on: isoDay(object.occurred_on || firstField(rows, [
      "occurred_on", "registration_date", "registered", "start_date", "issue_date", "date",
    ])),
    coverage_state: object.coverage_state || firstField(rows, ["coverage_state"]) || "not_checked",
    stages: Array.isArray(object.stages)
      ? object.stages.map((entry) => entry?.stage || entry).filter(Boolean)
      : [],
  };
}

/** Build a fail-closed coverage input from a Contracts browse / money row. */
export function coverageInputFromBrowseRow(row = {}) {
  return {
    method_family: row.method_family || null,
    publisher_method: row.selection_method_description || row.publisher_method || null,
    procurement_category: row.procurement_category || null,
    amount: amountOf(row.contract_amount ?? row.amount),
    occurred_on: isoDay(row.occurred_on || row.start_date || row.registration_date),
    coverage_state: row.coverage_state || "not_checked",
    stages: Array.isArray(row.procurement_stages)
      ? row.procurement_stages
      : row.primary_stage ? [row.primary_stage] : [],
    observed_count: row.observed_count,
    publisher_count: row.publisher_count,
  };
}

function stagesToCheck(input) {
  const stages = Array.isArray(input?.stages) ? input.stages.map((stage) => clean(stage, 40)) : [];
  if (stages.includes("solicitation")) return ["solicitation"];
  if (stages.some((stage) => ["award", "pending", "registered", "payment", "contract"].includes(stage))) {
    return ["award"];
  }
  return [null];
}

/** Project the informative record labels plus an optional collection fact. */
export function projectProcurementCoverageSignals(input = {}) {
  const labels = [];
  const seen = new Set();
  for (const stage of stagesToCheck(input)) {
    const label = projectProcurementCoverageLabel(input, stage);
    if (label && !seen.has(label.kind)) {
      seen.add(label.kind);
      labels.push(label);
    }
  }
  const fact = projectProcurementCoverageFact(input);
  return Object.freeze({
    labels: Object.freeze(labels),
    fact,
  });
}

export function formatProcurementCoverageCopy(item, options = {}) {
  if (!item) return "";
  const translate = typeof options.translate === "function" ? options.translate : null;
  if (translate) {
    const translated = translate(item.i18n_key, item.variables);
    if (translated && translated !== item.i18n_key) return translated;
  }
  return interpolate(item.fallback, item.variables);
}

function renderItem(item, options = {}) {
  const copy = formatProcurementCoverageCopy(item, options);
  if (!copy) return "";
  return `<p class="procurement-coverage" data-coverage-kind="${escapeHtml(item.kind)}" data-compliance-verdict="not_adjudicated">${escapeHtml(copy)}</p>`;
}

/** Render only the signals that actually vary. Empty input paints nothing. */
export function renderProcurementCoverageHtml(input = {}, options = {}) {
  if (input?.kind && input?.i18n_key) return renderItem(input, options);
  const signals = input?.labels || input?.fact
    ? input
    : projectProcurementCoverageSignals(input);
  const parts = [
    ...(Array.isArray(signals.labels) ? signals.labels : []),
    signals.fact,
  ].filter(Boolean).map((item) => renderItem(item, options));
  return parts.join("");
}

/** Convenience: object + observations → HTML, or "" when nothing informative. */
export function renderProcurementObjectCoverageHtml(object, observations, options = {}) {
  return renderProcurementCoverageHtml(coverageInputFromProcurement(object, observations), options);
}

/** Convenience: browse / money row → HTML, or "" when nothing informative. */
export function renderProcurementRowCoverageHtml(row, options = {}) {
  if (row?.coverage_label && !row.method_family && !row.selection_method_description) {
    return `<p class="procurement-coverage" data-coverage-kind="${escapeHtml(row.coverage_kind || "stamped")}" data-compliance-verdict="not_adjudicated">${escapeHtml(row.coverage_label)}</p>`;
  }
  return renderProcurementCoverageHtml(coverageInputFromBrowseRow(row), options);
}

export const PROCUREMENT_COVERAGE_AMOUNT_BANDS = AMOUNT_BANDS;
export const PROCUREMENT_COVERAGE_POLICY_EFFECTIVE_FROM = POLICY_EFFECTIVE_FROM;
