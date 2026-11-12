/**
 * M/WBE participation: three separate facts for one notice.
 *
 *   published  what the notice text states (Admin Code 6-129 citation, goal percent),
 *              copied unchanged from the solicitation extraction; never overwritten.
 *   register   what the procurement legal register says applies for this category on
 *              this date, with rule ids, citations and review status.
 *   state      the combined reader state from a closed set.
 *
 * The register can rule a requirement out (6-129(q)(7) human services; (q)(8) a
 * not-for-profit awardee, only when a sourced awardee legal form is supplied). It never
 * asserts that goals are required: with no exemption on the available facts the answer
 * is "not_ruled_out". A missing or unrecognised category, a candidate set that
 * disagrees, or a missing date answers unknown.
 *
 * Engine path: site/mwbe_requirement_state.mjs
 */

import {
  isoDate,
  participationRequirement,
  resolveLegalCategory,
} from "./procurement_legal_category.mjs";

export const MWBE_REQUIREMENT_STATE_SCHEMA = "cityscroll.mwbe_requirement_state.v1";

export const MWBE_READER_STATES = Object.freeze({
  GOAL_PUBLISHED: "goal_published",
  GOAL_PUBLISHED_REQUIREMENT_NOT_APPLICABLE: "goal_published_requirement_not_applicable",
  REQUIREMENT_NOT_APPLICABLE: "requirement_not_applicable",
  NEEDS_CHECKING: "needs_checking",
  NO_GOAL_PUBLISHED: "no_goal_published",
});

/** States in which a 6-129 participation requirement is not ruled out (27/22-day floors may apply). */
export const PARTICIPATION_NOT_RULED_OUT_STATES = Object.freeze([
  MWBE_READER_STATES.GOAL_PUBLISHED,
  MWBE_READER_STATES.NEEDS_CHECKING,
  MWBE_READER_STATES.NO_GOAL_PUBLISHED,
]);

/** Reader copy per state (English fallbacks; i18n keys ship in site/i18n.js and i18n/lang/*). */
export const MWBE_STATE_COPY = Object.freeze({
  [MWBE_READER_STATES.GOAL_PUBLISHED_REQUIREMENT_NOT_APPLICABLE]: Object.freeze({
    i18n_key: "mwbe_state_goal_published_not_required",
    fallback: "This notice lists an M/WBE participation goal. City law does not require participation goals for {basis} ({section}). Check the solicitation for what applies.",
  }),
  [MWBE_READER_STATES.REQUIREMENT_NOT_APPLICABLE]: Object.freeze({
    i18n_key: "mwbe_state_not_required",
    fallback: "City law does not require M/WBE participation goals for {basis} ({section}).",
  }),
  [MWBE_READER_STATES.NEEDS_CHECKING]: Object.freeze({
    i18n_key: "mwbe_state_needs_checking",
    fallback: "We could not tell this contract's category from the notice. Check the solicitation for M/WBE requirements.",
  }),
});

const BASIS_BY_RULE = Object.freeze({
  "nyc.admin_code.6-129.q.7.human_services_contracts": Object.freeze({ i18n_key: "mwbe_state_basis_human_services", fallback: "human services contracts" }),
  "nyc.admin_code.6-129.q.8.not_for_profit_awardees": Object.freeze({ i18n_key: "mwbe_state_basis_not_for_profit", fallback: "contracts awarded to not-for-profit organizations" }),
});

function publishedFacts(section6129) {
  const present = Boolean(section6129?.present);
  const pct = Number(section6129?.goal_percent);
  return Object.freeze({
    goal_cited: present,
    goal_percent: present && section6129.goal_percent != null && Number.isFinite(pct) ? pct : null,
    source: present ? section6129.source || "notice_body" : null,
  });
}

/**
 * @param {object} input
 * @param {object|null} input.section_6_129 extraction payload (fact a)
 * @param {object} [input.row] notice row (category_description, start_date)
 * @param {string|null} [input.awardee_legal_form] sourced legal form; award stage only
 * @param {string|null} [input.occurred_on] defaults to row.start_date
 */
export function mwbeRequirementState({ section_6_129 = null, row = {}, awardee_legal_form = null, occurred_on = undefined } = {}) {
  const published = publishedFacts(section_6_129);
  const category = resolveLegalCategory(row || {});
  const date = isoDate(occurred_on === undefined ? row?.start_date : occurred_on);
  const requirement = category.state === "resolved" && category.candidates.length > 0
    ? participationRequirement({ candidates: category.candidates, awardee_legal_form, occurred_on: date })
    : participationRequirement({ candidates: [], awardee_legal_form, occurred_on: date });

  let state;
  if (published.goal_cited) {
    state = requirement.value === "not_applicable"
      ? MWBE_READER_STATES.GOAL_PUBLISHED_REQUIREMENT_NOT_APPLICABLE
      : MWBE_READER_STATES.GOAL_PUBLISHED;
  } else if (requirement.value === "not_applicable") {
    state = MWBE_READER_STATES.REQUIREMENT_NOT_APPLICABLE;
  } else if (requirement.value === "unknown") {
    state = MWBE_READER_STATES.NEEDS_CHECKING;
  } else {
    state = MWBE_READER_STATES.NO_GOAL_PUBLISHED;
  }

  return Object.freeze({
    schema: MWBE_REQUIREMENT_STATE_SCHEMA,
    published,
    register: Object.freeze({
      category: Object.freeze({
        state: category.state,
        source: category.source,
        label: category.label,
        candidates: category.candidates,
        mapping_rule: category.mapping_rule,
      }),
      awardee_legal_form: awardee_legal_form || null,
      requirement,
    }),
    state,
    participation_not_ruled_out: PARTICIPATION_NOT_RULED_OUT_STATES.includes(state),
  });
}

/**
 * Reader annotation for a state, or null when the state adds nothing to the published chips.
 * A rule is named only when it is source_checked or practitioner_reviewed.
 */
export function mwbeStateAnnotation(stateResult) {
  const copy = MWBE_STATE_COPY[stateResult?.state];
  if (!copy) return null;
  if (stateResult.state === MWBE_READER_STATES.NEEDS_CHECKING) {
    return Object.freeze({ state: stateResult.state, i18n_key: copy.i18n_key, fallback: copy.fallback, variables: Object.freeze({}), rule: null });
  }
  const rule = stateResult.register.requirement.rules
    .find((r) => BASIS_BY_RULE[r.rule_id] && (r.review_status === "source_checked" || r.review_status === "practitioner_reviewed"));
  if (!rule) return null;
  const basis = BASIS_BY_RULE[rule.rule_id];
  return Object.freeze({
    state: stateResult.state,
    i18n_key: copy.i18n_key,
    fallback: copy.fallback,
    variables: Object.freeze({ basis: basis.fallback, basis_key: basis.i18n_key, section: `Admin Code § ${rule.section}` }),
    rule,
  });
}

export function formatMwbeStateAnnotation(annotation, { translate = null } = {}) {
  if (!annotation) return "";
  const variables = { ...annotation.variables };
  if (translate && variables.basis_key) {
    const basis = translate(variables.basis_key);
    if (basis && basis !== variables.basis_key) variables.basis = basis;
  }
  if (translate) {
    const text = translate(annotation.i18n_key, variables);
    if (text && text !== annotation.i18n_key) return text;
  }
  return Object.entries(variables).reduce((text, [k, v]) => text.replaceAll(`{${k}}`, String(v)), annotation.fallback);
}
