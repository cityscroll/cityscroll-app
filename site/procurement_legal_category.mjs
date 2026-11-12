/**
 * Legal procurement category and point-in-time register lookups for site modules.
 *
 * Reads only the generated site/procurement_legal_projection.mjs (built from the policy
 * registry and the procurement legal register), so it is safe in the browser, the Pages
 * bundle and the Worker. Three-valued throughout: a missing or unrecognised label, an
 * ambiguous candidate set that disagrees, or a missing date answers unknown and never
 * a verdict.
 *
 * Engine path: site/procurement_legal_category.mjs
 */

import { PROCUREMENT_LEGAL_PROJECTION } from "./procurement_legal_projection.mjs";

const PROJECTION = PROCUREMENT_LEGAL_PROJECTION;

export const LEGAL_PROCUREMENT_CATEGORIES = Object.freeze([
  "goods", "standard_services", "professional_services", "construction", "human_services",
]);
const POLICY_BAND_CATEGORIES = Object.freeze(Object.keys(
  Object.values(PROJECTION.policy.families)[0]?.bands || {},
));

export const LEGAL_CATEGORY_STATES = Object.freeze({
  RESOLVED: "resolved",
  MISSING: "missing",
  UNMAPPED: "unmapped",
});

function clean(value, max = 160) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function isoDate(value) {
  const raw = clean(value, 40);
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const us = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!us) return null;
  const month = Number(us[1]);
  const day = Number(us[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${us[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Citation summary for a register rule id, or null when the projection does not carry it. */
export function legalRuleCitation(ruleId) {
  const rule = PROJECTION.rules[ruleId];
  if (!rule) return null;
  return Object.freeze({
    rule_id: ruleId,
    record_version: rule.record_version,
    section: rule.section,
    instrument: rule.instrument,
    review_status: rule.review_status,
  });
}

/**
 * Exact publisher label -> register procurement_category candidate set.
 * Accepts an explicit procurement_category first (register vocabulary, or a policy-registry
 * band category asserted by the caller), then City Record category_description.
 */
export function resolveLegalCategory(record = {}) {
  const explicit = clean(record.procurement_category, 80);
  if (LEGAL_PROCUREMENT_CATEGORIES.includes(explicit)) {
    return Object.freeze({
      state: LEGAL_CATEGORY_STATES.RESOLVED,
      source: "procurement_category",
      candidates: Object.freeze([explicit]),
      band_categories: Object.freeze([PROJECTION.band_category_by_legal_category[explicit]]),
      label: null,
      mapping_rule: null,
    });
  }
  if (POLICY_BAND_CATEGORIES.includes(explicit)) {
    return Object.freeze({
      state: LEGAL_CATEGORY_STATES.RESOLVED,
      source: "policy_band_category",
      candidates: Object.freeze([]),
      band_categories: Object.freeze([explicit]),
      label: null,
      mapping_rule: null,
    });
  }
  const label = clean(record.category_description ?? record.category, 160);
  if (!label) {
    return Object.freeze({
      state: LEGAL_CATEGORY_STATES.MISSING, source: null, candidates: Object.freeze([]),
      band_categories: Object.freeze([]), label: null, mapping_rule: null,
    });
  }
  const mapping = PROJECTION.category_labels[label];
  if (!mapping) {
    return Object.freeze({
      state: LEGAL_CATEGORY_STATES.UNMAPPED, source: "category_description", candidates: Object.freeze([]),
      band_categories: Object.freeze([]), label, mapping_rule: null,
    });
  }
  return Object.freeze({
    state: LEGAL_CATEGORY_STATES.RESOLVED,
    source: "category_description",
    candidates: Object.freeze([...mapping.candidates]),
    band_categories: Object.freeze([...new Set(mapping.candidates.map((c) => PROJECTION.band_category_by_legal_category[c]))]),
    label,
    mapping_rule: legalRuleCitation(mapping.rule_id),
  });
}

function intervalOn(intervals, date) {
  return intervals.find((interval) => date >= interval.from && (interval.to === null || date < interval.to)) || null;
}

/**
 * Admin Code 6-129 participation requirement for one category candidate set on a date.
 * value: "not_applicable" (a rule rules it out), "not_ruled_out" (category and date known,
 * no exemption applies on the facts available) or "unknown".
 */
export function participationRequirement({ candidates = [], awardee_legal_form = null, occurred_on = null } = {}) {
  const date = isoDate(occurred_on);
  const form = awardee_legal_form === "for_profit" || awardee_legal_form === "not_for_profit" ? awardee_legal_form : null;
  const unknown = (reason) => Object.freeze({ value: "unknown", reason, rule_ids: Object.freeze([]), rules: Object.freeze([]), review_status: null, as_of: date });
  if (!date) return unknown("occurred_on_missing");
  const keys = candidates.length ? candidates : [null];
  const results = keys.map((category) => {
    const table = PROJECTION.participation.table[`${category ?? "_"}|${form ?? "_"}`];
    return table ? intervalOn(table, date) : null;
  });
  if (results.some((r) => !r)) return unknown("no_projection_row");
  const kinds = new Set(results.map((r) => r.kind));
  if (kinds.size !== 1) return unknown("candidates_disagree");
  const [kind] = kinds;
  if (kind === "unknown") return unknown(candidates.length ? "register_unknown" : "category_unknown");
  const ruleIds = [...new Set(results.flatMap((r) => r.rule_ids))].sort();
  return Object.freeze({
    value: kind,
    reason: kind === "not_applicable" ? "rule_applies" : "no_exemption_on_available_facts",
    rule_ids: Object.freeze(ruleIds),
    rules: Object.freeze(ruleIds.map(legalRuleCitation)),
    review_status: kind === "not_applicable" ? results[0].review_status : null,
    as_of: date,
  });
}

/** Charter 311(i)(1) M/WBE ceiling the register records for a date, or null when unknown. */
export function mwbeSmallPurchaseCeilingOn(occurredOn) {
  const date = isoDate(occurredOn);
  if (!date) return null;
  const interval = intervalOn(PROJECTION.mwbe_small_purchase_ceiling, date);
  if (!interval || interval.max_usd == null) return null;
  return Object.freeze({ max_usd: interval.max_usd, rule_ids: interval.rule_ids, review_status: interval.review_status });
}

/**
 * Response-floor rule for a floor kind on a date.
 * claim "rule" only for a source_checked (or better) rule in force on the date;
 * otherwise "unverified" and the reader copy must not assert a rule.
 */
export function responseFloorRule(kind, occurredOn) {
  const floor = PROJECTION.floors[kind];
  if (!floor) return null;
  const date = isoDate(occurredOn);
  const rule = PROJECTION.rules[floor.rule_id];
  const inForce = Boolean(date) && date >= floor.in_force_from && (floor.in_force_to === null || date < floor.in_force_to);
  const reviewed = rule?.review_status === "source_checked" || rule?.review_status === "practitioner_reviewed";
  return Object.freeze({
    kind,
    rule_id: floor.rule_id,
    record_version: rule?.record_version ?? null,
    days: floor.days,
    day_unit: floor.day_unit,
    section: rule?.section ?? null,
    review_status: rule?.review_status ?? null,
    temporal: !date ? "date_missing" : inForce ? "in_force" : date < floor.in_force_from ? floor.before_in_force_from : "not_in_force",
    claim: reviewed && inForce ? "rule" : "unverified",
  });
}

export const PROCUREMENT_LEGAL_PROJECTION_VERSION = PROJECTION.generated_from;
