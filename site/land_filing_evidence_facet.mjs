/**
 * LDP-27 (A8): the Land filing-evidence search filter. Exactly three
 * factual values -- the applicability "required" state and the two
 * observable fulfillment states -- and nothing judgemental. This module is
 * fetched by the browser, so it never imports `ontology/land_use_filing.mjs`
 * directly; its three literal values are cross-checked against that module's
 * own enums by `test/land_rer_product.test.mjs` so they can never drift.
 */

/**
 * The only three filters LDP-27 is allowed to expose (A8): the applicability
 * "required" state and the two observable fulfillment states. Every value
 * here is copied verbatim from `ontology/land_use_filing.mjs`'s own enums
 * (never a paraphrase); cross-checked against them, and against
 * `FORBIDDEN_FILING_OBSERVATION_SYNONYMS`, by `test/land_rer_product.test.mjs`.
 */
export const FILING_EVIDENCE_SEARCH_FILTERS = Object.freeze([
  "required",
  "document_observed",
  "publisher_identifies_not_timely_filed",
]);

export const LAND_FILING_EVIDENCE_OPTIONS = Object.freeze([
  { id: "any", label_key: "status_all" },
  { id: "required", label_key: "land_filing_facet_required" },
  { id: "document_observed", label_key: "land_filing_facet_document_observed" },
  { id: "publisher_identifies_not_timely_filed", label_key: "land_filing_facet_not_timely_filed" },
]);

const FILING_EVIDENCE_IDS = new Set(LAND_FILING_EVIDENCE_OPTIONS.map(({ id }) => id));

export function normalizeLandFilingEvidenceFilter(value, fallback = "any") {
  const raw = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return FILING_EVIDENCE_IDS.has(raw) ? raw : fallback;
}

/** Reads and normalizes the `#lfiling` control directly -- one call site everywhere land.mjs needs the current value, so the DOM id lives in one place. */
export function landFilingEvidenceFilterFromControls() {
  return normalizeLandFilingEvidenceFilter(document.querySelector("#lfiling")?.value);
}

/**
 * `row.filing_evidence` is the attached `land_filing_evidence_summary.v1`
 * record (see `land_filing_evidence_view.mjs#attachLandFilingEvidenceSummaries`).
 * A row carrying none (an older/out-of-scope project, A9) never matches a
 * specific filter value -- only "any" -- rather than being treated as a
 * false positive or negative for a state nobody observed.
 */
export function landRowMatchesFilingEvidenceFilter(row, filterValue = "any") {
  if (filterValue === "any") return true;
  const evidence = row?.filing_evidence;
  if (!evidence) return false;
  if (filterValue === "required") return evidence.applicability?.state === "required";
  return evidence.fulfillment?.state === filterValue;
}

/**
 * A not-required project and a pre-effective (not_yet_effective) project
 * must render different explanations (A3) -- one key per applicability
 * state, none shared. `ontology/land_use_filing.mjs#FILING_APPLICABILITY_STATES`
 * is the source of truth for the state values themselves; this map is
 * cross-checked against it (never imported directly, since this module ships
 * to the browser) by `test/land_rer_product.test.mjs`.
 */
export const FILING_APPLICABILITY_EXPLANATION_KEYS = Object.freeze({
  required: "land_filing_applicability_required",
  not_required: "land_filing_applicability_not_required",
  unknown: "land_filing_applicability_unknown",
  not_yet_effective: "land_filing_applicability_not_yet_effective",
  source_conflict: "land_filing_applicability_source_conflict",
});

/**
 * G1's guardrail at the copy layer: an active-required project with no
 * observed document must say exactly that -- `not_observed` -- and never
 * "not filed", "blocked", or "failed". Cross-checked the same way as
 * `FILING_APPLICABILITY_EXPLANATION_KEYS` above.
 */
export const FILING_FULFILLMENT_EXPLANATION_KEYS = Object.freeze({
  document_observed: "land_filing_fulfillment_document_observed",
  publisher_identifies_not_timely_filed: "land_filing_fulfillment_not_timely_filed",
  not_observed: "land_filing_fulfillment_not_observed",
  not_checked: "land_filing_fulfillment_not_checked",
  source_unavailable: "land_filing_fulfillment_source_unavailable",
});

export function landFilingApplicabilityExplanationKey(state) {
  return FILING_APPLICABILITY_EXPLANATION_KEYS[state] ?? FILING_APPLICABILITY_EXPLANATION_KEYS.unknown;
}

export function landFilingFulfillmentExplanationKey(state) {
  return FILING_FULFILLMENT_EXPLANATION_KEYS[state] ?? FILING_FULFILLMENT_EXPLANATION_KEYS.not_checked;
}
