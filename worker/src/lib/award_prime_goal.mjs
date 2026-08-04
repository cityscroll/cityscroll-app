// Award → prime vendor → M/WBE-goal join (payload only).
//
// Materializes the join sketch that unblocks honest "prime just won / possible
// subcontract window" packaging: per award or registration-bearing notice,
// stamp prime identity (entity-resolved stem + subject_ref), agency, dollars,
// and industry classification chips. Subcontractor goal % is almost never in
// public joinable feeds — the Comptroller has repeatedly noted that gap — so
// this payload carries honest-absent fields rather than inventing utilization
// targets or remaining goal capacity.
//
// Sub-outreach UI: site/sub_outreach.mjs consumes this side-car on notice
// detail. Payload only here — never invent goal % or card apology copy.
//
// Pure: no fetch, no env. Call sites attach after lifecycle assembly.

import { vendorStem } from "./compile.mjs";
import { canonicalAgency } from "./agencies.mjs";
import { formatSubjectRef } from "./subject_registry.mjs";

export const AWARD_PRIME_GOAL_SCHEMA = "cityscroll.award_prime_goal.v1";
export const AWARD_PRIME_GOAL_METHOD = "award_prime_goal_v1";
export const AWARD_PRIME_GOAL_METHOD_VERSION = "1.0.0";

/** Notice types that are award / selection / registration-facing for this join. */
export const AWARD_PRIME_GOAL_NOTICE_TYPES = Object.freeze([
  "Award",
  "Intent to Award",
  "Intent to Negotiate",
  "Vendor List",
]);

/**
 * Comptroller-noted gap: joinable public feeds do not publish M/WBE
 * subcontract goal percentages (or remaining utilization) next to awards.
 * Checkbook exposes prime M/WBE category and whether sub-vendors exist — not goal %.
 */
export const SUBCONTRACT_GOAL_GAP = Object.freeze({
  class: "not_published",
  status: "not_published",
  would_appear_in:
    "agency or Comptroller subcontract-utilization / M/WBE goal reports if released as a joinable public feed keyed by PIN or contract id",
  evidence:
    "NYC Comptroller reporting repeatedly flags missing joinable subcontractor participation and goal data; Checkbook Contracts publishes prime_vendor_mwbe_category and contract_includes_sub_vendors, not goal percent remaining",
  public_pointer:
    "https://comptroller.nyc.gov/reports/nyc-contracts/",
});

/**
 * @param {object|null|undefined} noticeRow
 * @returns {boolean}
 */
export function isAwardPrimeGoalEligible(noticeRow) {
  if (!noticeRow || typeof noticeRow !== "object") return false;
  const section = String(noticeRow.section_name || "").trim();
  if (section === "Public Hearings and Meetings") return false;
  if (section === "Agency Rules") return false;
  if (section === "Property Disposition") return false;
  if (section === "Changes in Personnel") return false;
  if (section === "Procurement") return true;
  const type = String(
    noticeRow.type_of_notice_description || noticeRow.type_of_notice || "",
  ).trim();
  if (AWARD_PRIME_GOAL_NOTICE_TYPES.includes(type)) return true;
  // Lifecycle-eligible solicitations stay out unless they already carry award-side facts
  // (vendor/amount) or a matched registration — surface code can still call extract with
  // lifecycle context for registration-only joins.
  return false;
}

/**
 * @param {string|null|undefined} label
 * @returns {string|null}
 */
export function industryChipKey(label) {
  const raw = String(label || "").replace(/\s+/g, " ").trim();
  if (!raw) return null;
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || null;
}

/**
 * @param {string|null|undefined} label
 * @param {{ source: string, field: string }} meta
 * @returns {{ key: string, label: string, source: string, field: string } | null}
 */
export function makeIndustryChip(label, meta) {
  const text = String(label || "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const key = industryChipKey(text);
  if (!key) return null;
  return {
    key,
    label: text,
    source: meta.source,
    field: meta.field,
  };
}

/**
 * Collect industry classification chips from honest published fields only.
 * Never invents NIGP codes or commodity classes from free-text titles.
 *
 * @param {object} noticeRow
 * @param {object} [opts]
 * @param {object|null} [opts.passport] - matched PASSPort contract/rfx detail
 * @param {object|null} [opts.ocpAward] - lifecycle ocp_award side-car
 * @returns {Array<{ key: string, label: string, source: string, field: string }>}
 */
export function collectIndustryChips(noticeRow = {}, opts = {}) {
  const chips = [];
  const seen = new Set();
  const push = (chip) => {
    if (!chip || !chip.key || seen.has(chip.key)) return;
    seen.add(chip.key);
    chips.push(chip);
  };

  const r = noticeRow || {};
  push(
    makeIndustryChip(r.category_description || r.category, {
      source: "city-record",
      field: "category_description",
    }),
  );

  const passport = opts.passport || null;
  if (passport && typeof passport === "object") {
    push(
      makeIndustryChip(passport.industry, {
        source: "passport",
        field: "industry",
      }),
    );
    push(
      makeIndustryChip(passport.main_commodity, {
        source: "passport",
        field: "main_commodity",
      }),
    );
  }

  // OCP side-car does not publish industry; ignore.

  return chips;
}

/**
 * Resolve prime vendor display name + ER stem + subject_ref from notice + lifecycle.
 * Prefer City Record vendor_name, then Checkbook registered/pending prime, then OCP.
 *
 * @param {object} noticeRow
 * @param {object|null} lifecycle
 * @returns {{
 *   display_name: string|null,
 *   stem: string|null,
 *   subject_ref: string|null,
 *   sources: string[],
 *   mwbe_category: string|null,
 *   mwbe_category_source: string|null,
 * } | null}
 */
export function resolvePrimeVendor(noticeRow = {}, lifecycle = null) {
  const sources = [];
  let display = null;
  let mwbe_category = null;
  let mwbe_category_source = null;

  const noticeVendor = clean(noticeRow?.vendor_name);
  if (noticeVendor) {
    display = noticeVendor;
    sources.push("city-record");
  }

  const timeline = Array.isArray(lifecycle?.timeline) ? lifecycle.timeline : [];
  const reg = timeline.find((e) => e && e.stage === "registered" && e.status === "matched");
  const pending = timeline.find((e) => e && e.stage === "pending" && e.status === "matched");
  const award = timeline.find((e) => e && e.stage === "award" && e.status === "matched");
  const intent = timeline.find(
    (e) => e && e.stage === "intent_to_award" && e.status === "matched",
  );

  const checkbookVendor = clean(reg?.detail?.vendor || pending?.detail?.vendor);
  if (checkbookVendor) {
    if (!display) display = checkbookVendor;
    else if (vendorStem(display) === vendorStem(checkbookVendor)) {
      // Same ER identity — keep City Record display, note Checkbook corroboration.
    } else if (!noticeVendor) {
      display = checkbookVendor;
    }
    if (!sources.includes("checkbook-contracts")) sources.push("checkbook-contracts");
  }

  const crAwardVendor = clean(award?.detail?.vendor || intent?.detail?.vendor);
  if (crAwardVendor && !display) {
    display = crAwardVendor;
    if (!sources.includes("city-record")) sources.push("city-record");
  }

  const ocp = lifecycle?.ocp_award;
  const ocpVendor = clean(
    ocp?.status === "matched" ? ocp?.detail?.vendor || ocp?.vendor : null,
  );
  if (ocpVendor) {
    if (!display) {
      display = ocpVendor;
      sources.push("ocp-recent-awards");
    } else if (!sources.includes("ocp-recent-awards")
      && vendorStem(display) === vendorStem(ocpVendor)) {
      sources.push("ocp-recent-awards");
    }
  }

  if (reg?.detail?.mwbe) {
    mwbe_category = clean(reg.detail.mwbe);
    mwbe_category_source = "checkbook-contracts";
  }

  if (!display) {
    return {
      display_name: null,
      stem: null,
      subject_ref: null,
      sources: [],
      mwbe_category,
      mwbe_category_source,
    };
  }

  const stem = vendorStem(display) || null;
  const subject_ref = formatSubjectRef(
    "vendor",
    `name:${encodeURIComponent(display.toLowerCase())}`,
  );

  return {
    display_name: display,
    stem,
    subject_ref,
    sources,
    mwbe_category,
    mwbe_category_source,
  };
}

/**
 * @param {object} noticeRow
 * @param {object|null} lifecycle
 * @returns {{
 *   display_name: string|null,
 *   canonical_id: string|null,
 *   canonical_name: string|null,
 *   subject_ref: string|null,
 *   source: string|null,
 * }}
 */
export function resolveAgency(noticeRow = {}, lifecycle = null) {
  const timeline = Array.isArray(lifecycle?.timeline) ? lifecycle.timeline : [];
  const reg = timeline.find((e) => e && e.stage === "registered" && e.status === "matched");
  const award = timeline.find((e) => e && e.stage === "award" && e.status === "matched");

  const raw =
    clean(noticeRow?.agency_name || noticeRow?.agency)
    || clean(award?.detail?.agency)
    || clean(reg?.detail?.agency)
    || null;

  if (!raw) {
    return {
      display_name: null,
      canonical_id: null,
      canonical_name: null,
      subject_ref: null,
      source: null,
    };
  }

  const { canonical_id, canonical_name } = canonicalAgency(raw);
  const subject_ref = canonical_id
    ? formatSubjectRef("agency", canonical_id)
    : null;
  const source = noticeRow?.agency_name || noticeRow?.agency
    ? "city-record"
    : award?.detail?.agency
      ? "city-record"
      : "checkbook-contracts";

  return {
    display_name: raw,
    canonical_id: canonical_id || null,
    canonical_name: canonical_name || null,
    subject_ref,
    source,
  };
}

/**
 * Prefer published award amount, then registered current/original, then OCP.
 *
 * @param {object} noticeRow
 * @param {object|null} lifecycle
 * @returns {{
 *   amount: number|null,
 *   source: string|null,
 *   basis: string|null,
 * }}
 */
export function resolveDollars(noticeRow = {}, lifecycle = null) {
  const timeline = Array.isArray(lifecycle?.timeline) ? lifecycle.timeline : [];
  const reg = timeline.find((e) => e && e.stage === "registered" && e.status === "matched");
  const award = timeline.find((e) => e && e.stage === "award" && e.status === "matched");
  const intent = timeline.find(
    (e) => e && e.stage === "intent_to_award" && e.status === "matched",
  );

  const noticeAmt = parseAmount(noticeRow?.contract_amount);
  if (noticeAmt != null) {
    return { amount: noticeAmt, source: "city-record", basis: "contract_amount" };
  }

  const awardAmt = parseAmount(award?.detail?.amount ?? intent?.detail?.amount);
  if (awardAmt != null) {
    return { amount: awardAmt, source: "city-record", basis: "award_stage_amount" };
  }

  if (reg?.detail) {
    const current = parseAmount(reg.detail.current_amount);
    if (current != null) {
      return {
        amount: current,
        source: "checkbook-contracts",
        basis: "prime_contract_current_amount",
      };
    }
    const original = parseAmount(reg.detail.original_amount);
    if (original != null) {
      return {
        amount: original,
        source: "checkbook-contracts",
        basis: "prime_contract_original_amount",
      };
    }
  }

  const ocp = lifecycle?.ocp_award;
  if (ocp?.status === "matched") {
    const ocpAmt = parseAmount(ocp?.detail?.amount ?? ocp?.amount);
    if (ocpAmt != null) {
      return { amount: ocpAmt, source: "ocp-recent-awards", basis: "contract_amount" };
    }
  }

  return { amount: null, source: null, basis: null };
}

/**
 * Honest subcontract-goal slot. Never fabricates goal % or remaining capacity.
 * When a future joinable feed lands, `goals` may become a non-null list and
 * status may become "present".
 *
 * @param {object} [opts]
 * @param {object|null} [opts.goals] - only when a real publisher join exists
 * @param {string|null} [opts.contract_includes_sub_vendors] - Checkbook flag, not a goal
 * @returns {object}
 */
export function buildSubcontractGoalSlot(opts = {}) {
  const goals = opts.goals;
  const hasGoals = Array.isArray(goals) && goals.length > 0;

  if (hasGoals) {
    return {
      status: "present",
      class: null,
      goals,
      goal_percent: sumGoalPercent(goals),
      remaining_percent: null,
      contract_includes_sub_vendors: clean(opts.contract_includes_sub_vendors),
      would_appear_in: null,
      evidence: clean(opts.evidence) || "publisher_goal_join",
      public_pointer: opts.public_pointer || null,
    };
  }

  // Default path today: Comptroller-noted unpublished / not joinable.
  return {
    status: SUBCONTRACT_GOAL_GAP.status,
    class: SUBCONTRACT_GOAL_GAP.class,
    goals: null,
    goal_percent: null,
    remaining_percent: null,
    // Related Checkbook fact when known — not a goal percentage.
    contract_includes_sub_vendors: clean(opts.contract_includes_sub_vendors),
    would_appear_in: SUBCONTRACT_GOAL_GAP.would_appear_in,
    evidence: SUBCONTRACT_GOAL_GAP.evidence,
    public_pointer: SUBCONTRACT_GOAL_GAP.public_pointer,
  };
}

/**
 * Interface for the separate sub-outreach surface card.
 * Payload only stamps structural readiness — never copy or CTAs.
 *
 * @param {{ prime: object, dollars: object, subcontract_goal: object, eligible: boolean }} parts
 * @returns {object}
 */
export function buildPossibleSubcontractWindow(parts) {
  const { prime, dollars, subcontract_goal, eligible } = parts;
  if (!eligible) {
    return {
      status: "not_applicable",
      basis: "wrong_universe_or_ineligible_notice",
      has_prime: false,
      has_dollars: false,
      goal_data: "not_applicable",
    };
  }
  const has_prime = !!(prime && prime.display_name);
  const has_dollars = dollars?.amount != null && Number.isFinite(Number(dollars.amount));
  const goal_data =
    subcontract_goal?.status === "present"
      ? "present"
      : subcontract_goal?.status === "not_published"
        ? "honest_absent"
        : "unknown";

  if (!has_prime) {
    return {
      status: "unknown",
      basis: "prime_vendor_not_resolved",
      has_prime: false,
      has_dollars,
      goal_data,
    };
  }

  return {
    // Candidate for a "possible subcontract window" callout even when goal % is absent.
    status: "open_candidate",
    basis: "award_or_registration_with_prime",
    has_prime: true,
    has_dollars,
    goal_data,
  };
}

/**
 * Build the full award→prime→goal payload for one notice + optional lifecycle.
 *
 * @param {object} noticeRow
 * @param {object|null} [lifecycle]
 * @param {object} [opts]
 * @param {object|null} [opts.passport]
 * @param {object|null} [opts.goals] - only when a real goal join exists
 * @param {string|null} [opts.contract_includes_sub_vendors]
 * @returns {object}
 */
export function buildAwardPrimeGoal(noticeRow = {}, lifecycle = null, opts = {}) {
  const r = noticeRow || {};
  const request_id = clean(r.request_id || r.id);
  const type = clean(r.type_of_notice_description || r.type_of_notice);

  // Registration-matched lifecycles are eligible even when the focal notice is a solicitation.
  const regMatched = Array.isArray(lifecycle?.timeline)
    && lifecycle.timeline.some((e) => e && e.stage === "registered" && e.status === "matched");
  const awardMatched = Array.isArray(lifecycle?.timeline)
    && lifecycle.timeline.some(
      (e) => e && (e.stage === "award" || e.stage === "intent_to_award") && e.status === "matched",
    );
  const eligible =
    isAwardPrimeGoalEligible(r) || regMatched || awardMatched || !!(r.vendor_name && r.contract_amount);

  const prime = resolvePrimeVendor(r, lifecycle);
  const agency = resolveAgency(r, lifecycle);
  const dollars = resolveDollars(r, lifecycle);
  const passportIndustry =
    opts.passport
    || lifecycle?.rfx_detail?.detail
    || (lifecycle?.rfx_detail?.status === "matched" ? lifecycle.rfx_detail.detail : null)
    || null;
  const industry_chips = collectIndustryChips(r, {
    passport: passportIndustry,
  });

  const includesSubs =
    clean(opts.contract_includes_sub_vendors)
    || clean(findCheckbookSubsFlag(lifecycle));

  const subcontract_goal = buildSubcontractGoalSlot({
    goals: opts.goals,
    contract_includes_sub_vendors: includesSubs,
  });

  const possible_subcontract_window = buildPossibleSubcontractWindow({
    prime,
    dollars,
    subcontract_goal,
    eligible,
  });

  return {
    schema: AWARD_PRIME_GOAL_SCHEMA,
    method: AWARD_PRIME_GOAL_METHOD,
    method_version: AWARD_PRIME_GOAL_METHOD_VERSION,
    request_id: request_id || null,
    notice_type: type || null,
    eligible: !!eligible,
    prime,
    agency,
    dollars,
    industry_chips,
    subcontract_goal,
    possible_subcontract_window,
    pin: clean(lifecycle?.pin || r.pin) || null,
    contract_id: findMatchedContractId(lifecycle),
  };
}

/**
 * Attach `award_prime_goal` onto an assembled lifecycle (idempotent).
 *
 * @param {object|null} lifecycle
 * @param {object|null} noticeRow
 * @param {object} [opts]
 * @returns {object|null}
 */
export function attachAwardPrimeGoal(lifecycle, noticeRow = null, opts = {}) {
  if (!lifecycle || typeof lifecycle !== "object") return lifecycle;
  const payload = buildAwardPrimeGoal(noticeRow || {}, lifecycle, opts);
  return { ...lifecycle, award_prime_goal: payload };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function clean(value) {
  if (value == null) return null;
  const s = String(value).replace(/\s+/g, " ").trim();
  return s || null;
}

function parseAmount(value) {
  if (value == null || value === "") return null;
  const n = parseFloat(String(value).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function sumGoalPercent(goals) {
  let sum = 0;
  let any = false;
  for (const g of goals) {
    const p = Number(g?.percent ?? g?.goal_percent);
    if (Number.isFinite(p)) {
      sum += p;
      any = true;
    }
  }
  return any ? Math.round(sum * 100) / 100 : null;
}

function findMatchedContractId(lifecycle) {
  const timeline = Array.isArray(lifecycle?.timeline) ? lifecycle.timeline : [];
  const reg = timeline.find((e) => e && e.stage === "registered" && e.status === "matched");
  const pending = timeline.find((e) => e && e.stage === "pending" && e.status === "matched");
  return clean(reg?.detail?.contract_id || pending?.detail?.contract_id);
}

function findCheckbookSubsFlag(lifecycle) {
  // Prefer explicit side-car if a future attach stamps it; registered detail may grow.
  const timeline = Array.isArray(lifecycle?.timeline) ? lifecycle.timeline : [];
  for (const e of timeline) {
    if (!e || e.status !== "matched") continue;
    const flag = e.detail?.contract_includes_sub_vendors ?? e.detail?.subs;
    if (flag != null && String(flag).trim()) return String(flag).trim();
  }
  return null;
}
