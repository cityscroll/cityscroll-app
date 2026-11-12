/**
 * M/WBE goal chips + award sub-outreach surface (pure view models).
 *
 * Consumes:
 *   - cityscroll.solicitation_procurement_method.v1 (structured_facts.procurement_method
 *     or live extract via extractSolicitationProcurementMethod)
 *   - cityscroll.award_prime_goal.v1 on GET /contract-lifecycle
 *
 * Never invents goal % or remaining utilization. Class-(b) when subcontract
 * goals are not published. Chips are presence-gated: ordinary method floors
 * (sealed proposals 20 days, sealed bids 15 days) do not spam every list row.
 *
 * Published goal chips are never removed or rewritten by the legal register.
 * The register's answer (site/mwbe_requirement_state.mjs) is added beside them:
 * a human services notice that cites a goal keeps its goal chip and gains a
 * "not required by law" chip and sentence. A response floor is shown as a rule
 * only when its register rule is source_checked and in force on the notice date.
 */

import {
  DEFAULT_RESPONSE_FLOOR_KINDS,
  SOLICITATION_PROCUREMENT_METHOD_SCHEMA,
  extractSolicitationProcurementMethod,
  withRegisterFacts,
} from "./solicitation_procurement_method.mjs";
import {
  MWBE_READER_STATES,
  mwbeStateAnnotation,
} from "./mwbe_requirement_state.mjs";

export const MWBE_GOAL_SURFACE_SCHEMA = "cityscroll.mwbe_goal_surface.v1";

/** Chip kinds for solicitation list/detail badges. */
export const SOLICITATION_CHIP_KIND = Object.freeze({
  SECTION_6_129_GOAL: "section_6_129_goal",
  SECTION_6_129: "section_6_129",
  REQUIREMENT_NOT_APPLICABLE: "mwbe_requirement_not_applicable",
  NCSP: "mwbe_ncsp",
  ACCELERATED: "accelerated",
  RESPONSE_FLOOR: "response_floor",
});

function currentPayload(pm, row) {
  if (!pm || typeof pm !== "object") return null;
  if (pm.schema === SOLICITATION_PROCUREMENT_METHOD_SCHEMA) return pm;
  // Stored v1 payload (structured_facts written before this change): keep its
  // published markers, recompute the register-derived fields from the row.
  return withRegisterFacts(pm, row && typeof row === "object" ? row : {});
}

/**
 * Resolve procurement_method payload from structured_facts or body extract.
 * @param {object} row
 * @param {object|null} [procurementMethod] - precomputed payload when available
 * @returns {object|null}
 */
export function resolveProcurementMethod(row = {}, procurementMethod = null) {
  if (procurementMethod && typeof procurementMethod === "object") {
    return currentPayload(procurementMethod, row);
  }
  const facts = row?.structured_facts;
  if (facts && typeof facts === "object" && facts.procurement_method) {
    return currentPayload(facts.procurement_method, row);
  }
  if (typeof facts === "string") {
    try {
      const parsed = JSON.parse(facts);
      if (parsed?.procurement_method) return currentPayload(parsed.procurement_method, row);
    } catch {
      /* ignore */
    }
  }
  // Client path: SODA rows lack structured_facts — extract from published fields.
  if (row && typeof row === "object") {
    return extractSolicitationProcurementMethod(row);
  }
  return null;
}

/**
 * Compact chip descriptors for solicitation list/detail.
 * Default 20-calendar-day floor is detail-only (not a list chip) so every open
 * RFP does not grow a noise badge.
 *
 * @param {object|null} pm - procurement_method payload
 * @param {{ includeDefaultFloor?: boolean }} [opts]
 * @returns {Array<{ kind: string, key: string, i18n_key: string, i18n_params?: object, tone: string }>}
 */
export function solicitationMethodChips(pm, opts = {}) {
  if (!pm || typeof pm !== "object") return [];
  const chips = [];
  const s6129 = pm.section_6_129;
  if (s6129?.present) {
    if (s6129.goal_percent != null && Number.isFinite(Number(s6129.goal_percent))) {
      chips.push({
        kind: SOLICITATION_CHIP_KIND.SECTION_6_129_GOAL,
        key: `goal_${s6129.goal_percent}`,
        i18n_key: "mwbe_chip_goal_percent",
        i18n_params: { pct: String(s6129.goal_percent) },
        tone: "mwbe",
        goal_percent: Number(s6129.goal_percent),
      });
    } else {
      chips.push({
        kind: SOLICITATION_CHIP_KIND.SECTION_6_129,
        key: "section_6_129",
        i18n_key: "mwbe_chip_section_6_129",
        tone: "mwbe",
      });
    }
    // Beside (never instead of) the published goal chip.
    const annotation = mwbeStateAnnotation(pm.mwbe_requirement);
    if (annotation && pm.mwbe_requirement.state === MWBE_READER_STATES.GOAL_PUBLISHED_REQUIREMENT_NOT_APPLICABLE) {
      chips.push({
        kind: SOLICITATION_CHIP_KIND.REQUIREMENT_NOT_APPLICABLE,
        key: pm.mwbe_requirement.state,
        i18n_key: "mwbe_chip_goal_not_required",
        tone: "muted",
        rule_id: annotation.rule.rule_id,
        rule_section: annotation.rule.section,
      });
    }
  }
  if (pm.mwbe_noncompetitive_small_purchase?.present) {
    chips.push({
      kind: SOLICITATION_CHIP_KIND.NCSP,
      key: "ncsp",
      i18n_key: "mwbe_chip_ncsp",
      tone: "method",
    });
  }
  if (pm.accelerated?.present) {
    chips.push({
      kind: SOLICITATION_CHIP_KIND.ACCELERATED,
      key: "accelerated",
      i18n_key: "mwbe_chip_accelerated",
      tone: "soon",
    });
  }
  const floor = pm.response_floor;
  if (floor && floor.kind) {
    const isDefault = DEFAULT_RESPONSE_FLOOR_KINDS.includes(floor.kind);
    const isRule = floor.claim === "rule";
    // A list row only ever shows a checked, distinctive rule floor.
    if (opts.includeDefaultFloor || (!isDefault && isRule)) {
      chips.push({
        kind: SOLICITATION_CHIP_KIND.RESPONSE_FLOOR,
        key: floor.kind,
        i18n_key: !isRule
          ? (floor.day_unit === "business_days" ? "mwbe_chip_floor_unverified_business" : "mwbe_chip_floor_unverified_calendar")
          : floor.day_unit === "business_days"
            ? "mwbe_chip_floor_business"
            : "mwbe_chip_floor_calendar",
        i18n_params: { days: String(floor.days) },
        tone: isDefault || !isRule ? "muted" : "floor",
        floor_kind: floor.kind,
        days: floor.days,
        day_unit: floor.day_unit,
        claim: floor.claim || null,
        rule_cite: isRule ? floor.rule_cite || null : null,
      });
    }
  }
  return chips;
}

/**
 * Solicitation detail panel view model (chips + optional methodology line).
 * Empty when no distinctive method markers (and default floor is the only signal).
 *
 * @param {object} row
 * @param {object|null} [procurementMethod]
 * @returns {{ schema: string, show: boolean, chips: object[], floor: object|null, section_6_129: object|null, ncsp: object|null, accelerated: object|null } | null}
 */
export function buildSolicitationMwbeView(row = {}, procurementMethod = null) {
  const pm = resolveProcurementMethod(row, procurementMethod);
  if (!pm) return null;
  const chips = solicitationMethodChips(pm, { includeDefaultFloor: false });
  // Detail still surfaces a non-default floor if chips already include distinctive markers,
  // and always includes floor in the chip set when distinctive; for default-only
  // solicitations with no markers, hide the panel (nothing to teach).
  const state = pm.mwbe_requirement?.state || null;
  const hasSignal =
    chips.length > 0 ||
    !!pm.section_6_129?.present ||
    !!pm.mwbe_noncompetitive_small_purchase?.present ||
    !!pm.accelerated?.present ||
    state === MWBE_READER_STATES.REQUIREMENT_NOT_APPLICABLE;
  if (!hasSignal) return null;
  const annotation = mwbeStateAnnotation(pm.mwbe_requirement);
  return {
    schema: MWBE_GOAL_SURFACE_SCHEMA,
    show: true,
    chips: solicitationMethodChips(pm, { includeDefaultFloor: true }),
    floor: pm.response_floor || null,
    section_6_129: pm.section_6_129 || null,
    ncsp: pm.mwbe_noncompetitive_small_purchase || null,
    accelerated: pm.accelerated || null,
    mwbe_requirement: pm.mwbe_requirement || null,
    mwbe_state: state,
    mwbe_annotation: annotation,
  };
}

/**
 * List-row chip set for solicitations (compact; no default floor).
 * @param {object} row
 * @param {object|null} [procurementMethod]
 * @returns {object[]}
 */
export function buildSolicitationListChips(row = {}, procurementMethod = null) {
  const type = String(row?.type_of_notice_description || row?.type_of_notice || "");
  if (!/solicitation/i.test(type)) return [];
  const pm = resolveProcurementMethod(row, procurementMethod);
  return solicitationMethodChips(pm, { includeDefaultFloor: false });
}

/**
 * Award sub-outreach card view model from lifecycle.award_prime_goal.
 * Gated on possible_subcontract_window.status === "open_candidate" (or present prime).
 *
 * @param {object|null} awardPrimeGoal
 * @returns {object|null}
 */
export function buildSubOutreachView(awardPrimeGoal) {
  const apg = awardPrimeGoal;
  if (!apg || typeof apg !== "object") return null;
  if (apg.eligible === false) return null;

  const window = apg.possible_subcontract_window || {};
  // Gate: open_candidate is the surface callout; unknown/not_applicable hide the card.
  if (window.status && window.status !== "open_candidate") return null;
  // When window is missing on old payloads, require a resolved prime.
  if (!window.status && !(apg.prime && apg.prime.display_name)) return null;

  const prime = apg.prime || {};
  const agency = apg.agency || {};
  const dollars = apg.dollars || {};
  const goal = apg.subcontract_goal || {};
  const industry = Array.isArray(apg.industry_chips) ? apg.industry_chips : [];

  const goalPresent = goal.status === "present" && goal.goal_percent != null;
  const goalNotPublished =
    goal.status === "not_published" || goal.class === "not_published";

  return {
    schema: MWBE_GOAL_SURFACE_SCHEMA,
    show: true,
    callout: window.status === "open_candidate",
    prime: {
      display_name: prime.display_name || null,
      stem: prime.stem || null,
      subject_ref: prime.subject_ref || null,
      mwbe_category: prime.mwbe_category || null,
    },
    agency: {
      display_name: agency.display_name || null,
      canonical_id: agency.canonical_id || null,
      subject_ref: agency.subject_ref || null,
    },
    dollars: {
      amount: dollars.amount != null && Number.isFinite(Number(dollars.amount))
        ? Number(dollars.amount)
        : null,
      source: dollars.source || null,
      basis: dollars.basis || null,
    },
    industry_chips: industry
      .filter((c) => c && c.label)
      .map((c) => ({
        key: c.key || null,
        label: c.label,
        source: c.source || null,
      })),
    subcontract_goal: {
      status: goal.status || null,
      class: goal.class || null,
      goal_percent: goalPresent ? Number(goal.goal_percent) : null,
      remaining_percent: goal.remaining_percent != null ? Number(goal.remaining_percent) : null,
      goal_data: window.goal_data || (goalPresent ? "present" : goalNotPublished ? "honest_absent" : "unknown"),
      would_appear_in: goal.would_appear_in || null,
      public_pointer: goal.public_pointer || null,
      contract_includes_sub_vendors: goal.contract_includes_sub_vendors || null,
    },
    pin: apg.pin || null,
    contract_id: apg.contract_id || null,
  };
}

/**
 * Whether a sub-outreach card should mount for this lifecycle payload.
 * @param {object|null} lifecycle
 * @returns {boolean}
 */
export function shouldShowSubOutreach(lifecycle) {
  return !!buildSubOutreachView(lifecycle?.award_prime_goal || null);
}
