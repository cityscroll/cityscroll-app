/**
 * Explicit buyer-history comparison from a solicitation.
 *
 * The pursuit surface names a buyer and a comparison the vendor can narrow.
 * Industry and award method come only from a reviewed vocabulary map: a broad
 * City Record category or a similar title never silently becomes a Checkbook
 * industry. Amount is restricted only when the solicitation itself publishes
 * one. Fiscal year is the registration year of the counted contracts, not the
 * notice's publication date.
 *
 * Counts and inspectable cases always use the full matching registered-contract
 * cohort from buyerContractingHistory(), before pagination or optional
 * enrichment. Related-context candidates are never the denominator.
 */

import { resolveAgencyIdentity } from "./agency_identity.mjs";
import { analyticalDrillThroughHref, contractAmountBand } from "./analytical_projection.mjs";
import {
  buyerContractingHistory,
  buyerContractingHistoryFailure,
} from "./buyer_contracting_history.mjs";

export const BUYER_HISTORY_PURSUIT_COMPARISON_SCHEMA = "cityscroll.buyer_history_pursuit_comparison.v1";

/** Checkbook amount band the Parks $1m–under $10m comparison uses. */
export const BUYER_HISTORY_AMOUNT_BAND_1M_UNDER_10M = "$1 million–$9.99 million";

/**
 * Reviewed City Record category → Checkbook industry. Keys are lowercased
 * trimmed source strings. Anything absent here stays unrestricted.
 */
export const BUYER_HISTORY_INDUSTRY_VOCABULARY = Object.freeze({
  "construction/construction services": "Construction Services",
  "construction services": "Construction Services",
  "human services": "Human Services",
  "goods": "Goods",
});

/**
 * Reviewed City Record selection method → Checkbook award method.
 * Competitive Sealed Proposals is deliberately unmapped: it is not always
 * Checkbook REQUEST FOR PROPOSAL (RFP), and RFP FROM A PQVL is a different
 * source method.
 */
export const BUYER_HISTORY_METHOD_VOCABULARY = Object.freeze({
  "competitive sealed bids": "COMPETITIVE SEALED BIDDING",
  "competitive sealed bidding": "COMPETITIVE SEALED BIDDING",
  "request for proposals": "REQUEST FOR PROPOSAL (RFP)",
  "request for proposal": "REQUEST FOR PROPOSAL (RFP)",
  "request for proposal (rfp)": "REQUEST FOR PROPOSAL (RFP)",
  "rfp from a pqvl": "RFP FROM A PQVL",
});

function trimmed(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || null;
}

function vocabularyKey(value) {
  return trimmed(value)?.toLowerCase() || null;
}

export function mapSolicitationIndustry(categoryDescription) {
  const key = vocabularyKey(categoryDescription);
  if (!key) return { from: trimmed(categoryDescription), to: null, mapped: false };
  const to = BUYER_HISTORY_INDUSTRY_VOCABULARY[key] || null;
  return { from: trimmed(categoryDescription), to, mapped: Boolean(to) };
}

export function mapSolicitationAwardMethod(selectionMethod) {
  const key = vocabularyKey(selectionMethod);
  if (!key) return { from: trimmed(selectionMethod), to: null, mapped: false };
  const to = BUYER_HISTORY_METHOD_VOCABULARY[key] || null;
  return { from: trimmed(selectionMethod), to, mapped: Boolean(to) };
}

function numericAmount(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  const parsed = Number(String(value).replace(/[$,]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function mapSolicitationAmountBand(solicitation = {}, options = {}) {
  const amount = numericAmount(options.amount)
    ?? numericAmount(solicitation.contract_amount)
    ?? numericAmount(solicitation.amount);
  if (amount == null) {
    return { from: null, to: null, mapped: false, restricted: false };
  }
  const to = contractAmountBand(amount);
  return { from: amount, to, mapped: Boolean(to), restricted: Boolean(to) };
}

function snapshotFiscalYear(options = {}) {
  if (options.registration_fiscal_year != null && options.registration_fiscal_year !== "") {
    const year = Number(options.registration_fiscal_year);
    return Number.isInteger(year) ? year : null;
  }
  const years = [...new Set((Array.isArray(options.rows) ? options.rows : [])
    .map((row) => Number(row?.registration_fiscal_year))
    .filter(Number.isInteger))].sort((left, right) => right - left);
  return years.length === 1 ? years[0] : null;
}

function titleDepartment(value) {
  return String(value)
    .toLowerCase()
    .replace(/\b[a-z]/g, (char) => char.toUpperCase())
    .replace(/\bOf\b/g, "of");
}

/**
 * Source-owned Checkbook buyer label for a notice agency. Uses the
 * projection's own spelling when rows are supplied; otherwise a Department-of
 * variant from the reviewed identity group. An unmatched label stays the
 * notice's own spelling and is never read as a clean zero.
 */
export function checkbookBuyerLabelForNotice(noticeAgency, rows = []) {
  const noticeLabel = trimmed(noticeAgency);
  const identity = resolveAgencyIdentity(noticeLabel);
  const list = Array.isArray(rows) ? rows : [];
  if (identity.matched) {
    const counts = new Map();
    for (const row of list) {
      const rowIdentity = resolveAgencyIdentity(row?.agency);
      if (!rowIdentity.matched || rowIdentity.canonical_id !== identity.canonical_id) continue;
      const label = trimmed(row.agency);
      if (!label) continue;
      counts.set(label, (counts.get(label) || 0) + 1);
    }
    const fromRows = [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
    if (fromRows) {
      return { label: fromRows, notice_label: noticeLabel, matched: true, identity };
    }
    const variants = identity.variants || [];
    const department = variants.find((value) => /^Department of /i.test(String(value)));
    if (department) {
      return { label: department, notice_label: noticeLabel, matched: true, identity };
    }
    const caps = variants.find((value) => /^DEPARTMENT OF /i.test(String(value)));
    if (caps) {
      return { label: titleDepartment(caps), notice_label: noticeLabel, matched: true, identity };
    }
    return { label: identity.canonical_name || noticeLabel, notice_label: noticeLabel, matched: true, identity };
  }
  return { label: noticeLabel, notice_label: noticeLabel, matched: false, identity };
}

function solicitationFrom(input = {}) {
  if (!input || typeof input !== "object") return {};
  if (input.solicitation && typeof input.solicitation === "object") return input.solicitation;
  return input;
}

/**
 * Comparison query params belong on the contracts (or search) document.
 * The amount-band control lives in the shared shell, so a change or popstate
 * on Property / other browse children must not rewrite those routes to
 * `mode=award` or re-render the hidden buyer-history panel.
 */
export function isBuyerHistoryComparisonDocument(locationLike = {}) {
  const path = String(locationLike.pathname || "").replace(/\/+$/, "") || "/";
  if (path === "/browse/contracts" || path === "/search") return true;
  if (path !== "/") return false;
  const hash = String(locationLike.hash || "").replace(/^#/, "");
  return !hash || hash === "money" || hash.startsWith("money?");
}

/**
 * Build the explicit comparison a pursuit page can open. Unmapped industry,
 * method, or amount stay unrestricted rather than inferred.
 */
export function buyerHistoryComparisonFromSolicitation(input = {}, options = {}) {
  const solicitation = solicitationFrom(input);
  const buyer = checkbookBuyerLabelForNotice(
    solicitation.agency_name || solicitation.agency || options.agency,
    options.rows,
  );
  const industry = mapSolicitationIndustry(
    options.industry_from || solicitation.category_description || solicitation.industry,
  );
  const awardMethod = mapSolicitationAwardMethod(
    options.award_method_from || solicitation.selection_method_description || solicitation.method,
  );
  const amount = mapSolicitationAmountBand(solicitation, options);
  const fiscalYear = snapshotFiscalYear({
    registration_fiscal_year: options.registration_fiscal_year,
    rows: options.rows,
  });
  const scope = {
    industry: industry.to,
    award_method: awardMethod.to,
    contract_amount_band: amount.to,
  };
  const href = buyer.label
    ? analyticalDrillThroughHref({
      agency: buyer.label,
      registration_fiscal_year: fiscalYear == null ? undefined : fiscalYear,
      industry: scope.industry || undefined,
      award_method: scope.award_method || undefined,
      contract_amount_band: scope.contract_amount_band || undefined,
    })
    : null;
  return {
    schema: BUYER_HISTORY_PURSUIT_COMPARISON_SCHEMA,
    state: "ready",
    request_id: trimmed(solicitation.request_id),
    buyer,
    registration_fiscal_year: fiscalYear,
    scope,
    mapping: {
      industry,
      award_method: awardMethod,
      amount,
    },
    population: "registered_contracts_in_selected_fiscal_year",
    href,
  };
}

export function buyerHistoryComparisonFailure(input = {}, options = {}) {
  const comparison = buyerHistoryComparisonFromSolicitation(input, options);
  const history = buyerContractingHistoryFailure({
    agency: comparison.buyer.label,
    registration_fiscal_year: comparison.registration_fiscal_year,
    industry: comparison.scope.industry,
    award_method: comparison.scope.award_method,
    contract_amount_band: comparison.scope.contract_amount_band,
    reason: trimmed(options.reason) || "source-request-failed",
    detail: trimmed(options.detail),
  });
  return {
    ...comparison,
    state: "unavailable",
    history,
  };
}

/**
 * Open the buyer's registered-contract comparison for this solicitation.
 * `rows` must be the complete registered-contract projection. A relevance-
 * ranked candidate list is not a valid population.
 */
export function compareBuyerHistoryFromSolicitation(rows, input = {}, options = {}) {
  const comparison = buyerHistoryComparisonFromSolicitation(input, { ...options, rows });
  if (!Array.isArray(rows)) {
    return buyerHistoryComparisonFailure(input, { ...options, rows: undefined });
  }
  const history = buyerContractingHistory(rows, {
    agency: comparison.buyer.label,
    registration_fiscal_year: comparison.registration_fiscal_year,
    industry: options.industry !== undefined ? options.industry : comparison.scope.industry,
    award_method: options.award_method !== undefined ? options.award_method : comparison.scope.award_method,
    contract_amount_band: options.contract_amount_band !== undefined
      ? options.contract_amount_band
      : comparison.scope.contract_amount_band,
    snapshot_date: options.snapshot_date,
    generated_at: options.generated_at,
    population_definition: options.population_definition,
  });
  const scope = {
    industry: options.industry !== undefined ? options.industry : comparison.scope.industry,
    award_method: options.award_method !== undefined ? options.award_method : comparison.scope.award_method,
    contract_amount_band: options.contract_amount_band !== undefined
      ? options.contract_amount_band
      : comparison.scope.contract_amount_band,
  };
  const href = analyticalDrillThroughHref({
    agency: history.buyer?.label || comparison.buyer.label,
    registration_fiscal_year: history.registration_fiscal_year == null ? undefined : history.registration_fiscal_year,
    industry: scope.industry || undefined,
    award_method: scope.award_method || undefined,
    contract_amount_band: scope.contract_amount_band || undefined,
  });
  return {
    ...comparison,
    state: "available",
    scope,
    href,
    history,
  };
}
