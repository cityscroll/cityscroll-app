/**
 * Pure contract-substance vocabulary shared by the projector and the
 * resident projection.
 *
 * This module is the browser-safe seam: it deliberately imports nothing, so
 * the canonical procurement document can label admitted rows with the same
 * schema, fact kinds, evidence roles, standing labels, and promise wording the
 * projector admits them under — without pulling the publisher-neutral
 * document-processing contract (and its Node-only dependencies) into the
 * Pages Function import graph. The projector re-exports every value here, so
 * existing importers keep one canonical source.
 */

export const CONTRACT_SUBSTANCE_SCHEMA =
  "cityscroll.procurement_contract_substance.v1";

export const FACT_KINDS = Object.freeze({
  SCOPE_FACT: "scope_fact",
  PRICE_TERM: "price_term",
  OBLIGATION: "obligation",
});

/** Evidence roles for substance claims (distinct from access document roles). */
export const EVIDENCE_ROLES = Object.freeze({
  SOLICITATION_SCOPE: "solicitation_scope",
  EXECUTED_SCOPE: "executed_scope",
  PRICING_SCHEDULE: "pricing_schedule",
  EXECUTED_OBLIGATION: "executed_obligation",
  AMENDMENT: "amendment",
  SITE_SCHEDULE: "site_schedule",
  INVOICE_OR_ACCEPTANCE: "invoice_or_acceptance",
  PERFORMANCE_EVALUATION: "performance_evaluation",
  BID_TAB: "bid_tab",
  PROPOSED_AGREEMENT: "proposed_agreement",
  TEMPLATE_PRICING: "template_pricing",
  PRIOR_TERM: "prior_term",
  TITLE: "title",
  PAYMENT: "payment",
  PROJECT_SUMMARY: "project_summary",
});

export const STANDING_LABELS = Object.freeze({
  VENDOR_PROMISED: "the vendor promised",
  ADVERTISED: "advertised",
  REQUESTED: "requested",
  EXECUTED: "executed",
  AMENDED: "amended",
  BID_OFFER: "bid offer",
  PROPOSED: "proposed",
  TEMPLATE: "template pricing",
  AUDIT_REPORTED: "the audit reports",
});

/** Resident-facing claim label reserved for executed vendor promises. */
export const RESIDENT_VENDOR_PROMISE_LABEL = "What the vendor promised";

/**
 * Positive resident assertions require admitted status and resident_assertion.
 */
export function residentPositiveAssertions(document) {
  const rows = [
    ...(Array.isArray(document?.scope_facts) ? document.scope_facts : []),
    ...(Array.isArray(document?.price_terms) ? document.price_terms : []),
    ...(Array.isArray(document?.obligations) ? document.obligations : []),
  ];
  return rows.filter((row) => row?.status === "admitted" && row?.resident_assertion === true);
}

export function deskUnresolvedRows(document) {
  return (Array.isArray(document?.unresolved) ? document.unresolved : [])
    .filter((row) => row?.desk_reviewable === true && row?.resident_assertion === false);
}
