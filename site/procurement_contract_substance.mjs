/**
 * Typed contract-substance projection: cited scope_fact, price_term, and
 * obligation rows with exact passages and document roles.
 *
 * Conservative clause projector over admitted documents. Reuses the
 * publisher-neutral page-quality contract; never invents unit prices from
 * totals, never labels solicitation language as executed, and never treats
 * titles, payment rows, or performance evaluations as obligations.
 */

import {
  assessPageQuality,
  contentHashOf,
} from "../warehouse/lib/document_processing.mjs";
import {
  ACCESS_STATES,
  FIXED_CONTRACT_IDS,
} from "./procurement_contract_substance_access.mjs";
import {
  CONTRACT_SUBSTANCE_SCHEMA,
  EVIDENCE_ROLES,
  FACT_KINDS,
  RESIDENT_VENDOR_PROMISE_LABEL,
  STANDING_LABELS,
  deskUnresolvedRows,
  residentPositiveAssertions,
} from "./procurement_contract_substance_contract.mjs";

// The shared vocabulary above is re-exported so every importer keeps one
// canonical source while the browser-side projection stays free of the
// document-processing seam this projector owns.
export {
  CONTRACT_SUBSTANCE_SCHEMA,
  EVIDENCE_ROLES,
  FACT_KINDS,
  RESIDENT_VENDOR_PROMISE_LABEL,
  STANDING_LABELS,
  deskUnresolvedRows,
  residentPositiveAssertions,
};

/** Projector version stamped on every admitted substance row. */
export const PROJECTOR_VERSION =
  "cityscroll.procurement_contract_substance.projector.v1";

export const UNRESOLVED_REASONS = Object.freeze({
  EMPTY_TEXT_LAYER: "empty_text_layer",
  LOW_QUALITY_EXTRACTION: "low_quality_extraction",
  UNREADABLE_NO_OCR: "unreadable_no_ocr",
  CONFLICTING_PASSAGES: "conflicting_passages",
  MISSING_REQUIRED_FIELDS: "missing_required_fields",
  DISQUALIFIED_SOURCE: "disqualified_source",
  MANUFACTURED_RATE: "manufactured_rate_refused",
  ACCESS_NOT_PUBLIC: "access_not_public_document",
});

export const PAYMENT_BASES = Object.freeze([
  "unit_price",
  "fixed_fee",
  "time_and_materials",
  "milestone",
  "percentage",
  "not_to_exceed",
  "other",
]);

const EXECUTED_ROLES = new Set([
  EVIDENCE_ROLES.EXECUTED_SCOPE,
  EVIDENCE_ROLES.EXECUTED_OBLIGATION,
  EVIDENCE_ROLES.PRICING_SCHEDULE,
  EVIDENCE_ROLES.AMENDMENT,
]);

const SCOPE_ROLES = new Set([
  EVIDENCE_ROLES.SOLICITATION_SCOPE,
  EVIDENCE_ROLES.EXECUTED_SCOPE,
  EVIDENCE_ROLES.AMENDMENT,
]);

const PRICE_ROLES = new Set([
  EVIDENCE_ROLES.PRICING_SCHEDULE,
  EVIDENCE_ROLES.AMENDMENT,
  EVIDENCE_ROLES.BID_TAB,
  EVIDENCE_ROLES.PROPOSED_AGREEMENT,
  EVIDENCE_ROLES.TEMPLATE_PRICING,
  EVIDENCE_ROLES.PERFORMANCE_EVALUATION,
]);

const OBLIGATION_ROLES = new Set([
  EVIDENCE_ROLES.EXECUTED_OBLIGATION,
  EVIDENCE_ROLES.EXECUTED_SCOPE,
  EVIDENCE_ROLES.AMENDMENT,
  EVIDENCE_ROLES.PROPOSED_AGREEMENT,
]);

const DISQUALIFIED_OBLIGATION_ROLES = new Set([
  EVIDENCE_ROLES.SOLICITATION_SCOPE,
  EVIDENCE_ROLES.PERFORMANCE_EVALUATION,
  EVIDENCE_ROLES.INVOICE_OR_ACCEPTANCE,
  EVIDENCE_ROLES.BID_TAB,
  EVIDENCE_ROLES.TEMPLATE_PRICING,
  EVIDENCE_ROLES.PRIOR_TERM,
  EVIDENCE_ROLES.TITLE,
  EVIDENCE_ROLES.PAYMENT,
  EVIDENCE_ROLES.PROJECT_SUMMARY,
  "project_description",
  "project_summary",
  "scope_summary",
  "contract_title",
  "title",
  "payment_row",
  "payment",
  "analytics_row",
  "notice_description",
  "metadata",
  "bid",
  "template",
  "audit",
]);

const NON_PROMISE_ROLES = new Set([
  EVIDENCE_ROLES.PROPOSED_AGREEMENT,
  EVIDENCE_ROLES.PRIOR_TERM,
  EVIDENCE_ROLES.BID_TAB,
  EVIDENCE_ROLES.TEMPLATE_PRICING,
  EVIDENCE_ROLES.PERFORMANCE_EVALUATION,
  EVIDENCE_ROLES.TITLE,
  EVIDENCE_ROLES.PAYMENT,
  EVIDENCE_ROLES.PROJECT_SUMMARY,
  EVIDENCE_ROLES.SOLICITATION_SCOPE,
  "bid",
  "template",
  "audit",
  "payment_row",
  "project_description",
]);

const CONTENT_HASH_RE = /^(sha256:)?[a-f0-9]{64}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clean(value, max = 500) {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

function normalizeRole(value) {
  return clean(value, 80)?.toLowerCase().replace(/[\s-]+/g, "_") || null;
}

function isoDate(value) {
  return Boolean(clean(value, 10) && ISO_DATE_RE.test(String(value).trim()));
}

function isoInstant(value) {
  if (!clean(value, 64) || !ISO_INSTANT_RE.test(String(value).trim())) return false;
  return Number.isFinite(new Date(value).getTime());
}

function normalizeContentHash(value) {
  const raw = clean(value, 100);
  if (!raw || !CONTENT_HASH_RE.test(raw)) return null;
  return `sha256:${raw.toLowerCase().replace(/^sha256:/, "")}`;
}

function finiteNumber(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = clean(value, 40);
  if (!text || !/^-?\d+(?:\.\d+)?$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function normalizePaymentBasis(value) {
  const basis = normalizeRole(value);
  return basis && PAYMENT_BASES.includes(basis) ? basis : null;
}

/**
 * Exact citation required on every positive substance row.
 */
export function normalizeCitation(raw = {}) {
  const contractId = clean(raw.contract_id || raw.prime_contract_id, 160);
  const sourceDocumentId = clean(raw.source_document_id || raw.document_id, 180);
  const contentHash = normalizeContentHash(raw.content_hash || raw.document_hash);
  const locator = clean(raw.locator || raw.page_section_locator || raw.page_locator, 240);
  const excerpt = clean(raw.excerpt || raw.passage_excerpt || raw.text, 800);
  const url = clean(raw.public_url || raw.url, 2000);
  const publicationDate = isoDate(raw.publication_date || raw.effective_date)
    ? clean(raw.publication_date || raw.effective_date, 10)
    : null;
  const documentRole = normalizeRole(raw.document_role || raw.evidence_role || raw.role);

  const missing = [];
  if (!contractId) missing.push("contract_identity");
  if (!sourceDocumentId) missing.push("document_identity");
  if (!contentHash) missing.push("document_hash");
  if (!locator) missing.push("page_locator");
  if (!excerpt) missing.push("excerpt");
  if (!documentRole) missing.push("document_role");
  if (!publicationDate) missing.push("publication_or_effective_date");

  if (missing.length) {
    return { ok: false, citation: null, missing };
  }

  return {
    ok: true,
    missing: [],
    citation: {
      contract_id: contractId,
      source_document_id: sourceDocumentId,
      content_hash: contentHash,
      document_role: documentRole,
      locator,
      excerpt,
      public_url: url,
      publication_date: publicationDate,
      effective_date: isoDate(raw.effective_date) ? clean(raw.effective_date, 10) : publicationDate,
    },
  };
}

/**
 * Gate a passage through the publisher-neutral page-quality contract.
 * Empty layers, unreadable (no OCR) pages, and low-quality extractions never
 * produce a positive resident assertion.
 */
export function assessPassageForProjection(passage = {}) {
  const text = clean(passage.text || passage.excerpt || passage.passage_text, 20000) || "";
  const ocrRequired = passage.ocr_required === true || passage.ocrRequired === true;
  const ocrAttempted = passage.ocr_attempted === true || passage.ocrAttempted === true;
  const ocrEngineAvailable = passage.ocr_engine_available === true
    || passage.ocrEngineAvailable === true;
  const quality = assessPageQuality({
    text,
    ocrRequired,
    ocrAttempted,
    ocrEngineAvailable,
  });

  if (!quality.measured) {
    return {
      ok: false,
      reason: UNRESOLVED_REASONS.UNREADABLE_NO_OCR,
      quality,
      desk: true,
    };
  }
  if (!text || quality.quality_state === "low" && quality.score === 0 && quality.reasons?.some((r) => /empty/i.test(r))) {
    return {
      ok: false,
      reason: UNRESOLVED_REASONS.EMPTY_TEXT_LAYER,
      quality,
      desk: true,
    };
  }
  if (quality.quality_state === "low") {
    return {
      ok: false,
      reason: UNRESOLVED_REASONS.LOW_QUALITY_EXTRACTION,
      quality,
      desk: true,
    };
  }
  return { ok: true, reason: null, quality, desk: false };
}

function standingLabelForRole(documentRole, { forObligation = false } = {}) {
  const role = normalizeRole(documentRole);
  if (role === EVIDENCE_ROLES.SOLICITATION_SCOPE) {
    return STANDING_LABELS.ADVERTISED;
  }
  if (role === EVIDENCE_ROLES.AMENDMENT) {
    return STANDING_LABELS.AMENDED;
  }
  if (role === EVIDENCE_ROLES.BID_TAB) {
    return STANDING_LABELS.BID_OFFER;
  }
  if (role === EVIDENCE_ROLES.TEMPLATE_PRICING) {
    return STANDING_LABELS.TEMPLATE;
  }
  if (role === EVIDENCE_ROLES.PROPOSED_AGREEMENT) {
    return STANDING_LABELS.PROPOSED;
  }
  if (role === EVIDENCE_ROLES.PERFORMANCE_EVALUATION) {
    return STANDING_LABELS.AUDIT_REPORTED;
  }
  if (forObligation && EXECUTED_ROLES.has(role) && OBLIGATION_ROLES.has(role)) {
    return STANDING_LABELS.VENDOR_PROMISED;
  }
  if (EXECUTED_ROLES.has(role)) {
    return STANDING_LABELS.EXECUTED;
  }
  return STANDING_LABELS.REQUESTED;
}

/**
 * Resident-facing claim label. Only an executed vendor-promise standing may
 * produce "What the vendor promised"; bid, proposed, template, audit, title,
 * payment, prior-term, and project-summary evidence never do.
 */
export function residentClaimLabel(factOrStanding = {}) {
  const standing = clean(
    typeof factOrStanding === "string"
      ? factOrStanding
      : (factOrStanding?.standing_label || factOrStanding?.standing),
    80,
  );
  const role = normalizeRole(
    typeof factOrStanding === "string" ? null : factOrStanding?.document_role,
  );
  if (role && NON_PROMISE_ROLES.has(role)) {
    if (standing === STANDING_LABELS.AUDIT_REPORTED || role === EVIDENCE_ROLES.PERFORMANCE_EVALUATION) {
      return "The audit reports these contract terms";
    }
    if (standing === STANDING_LABELS.BID_OFFER || role === EVIDENCE_ROLES.BID_TAB) {
      return "Bid offer";
    }
    if (standing === STANDING_LABELS.PROPOSED || role === EVIDENCE_ROLES.PROPOSED_AGREEMENT) {
      return "Proposed agreement term";
    }
    if (standing === STANDING_LABELS.TEMPLATE || role === EVIDENCE_ROLES.TEMPLATE_PRICING) {
      return "Template pricing";
    }
    return standing || "Non-executed evidence";
  }
  if (standing === STANDING_LABELS.VENDOR_PROMISED) {
    return RESIDENT_VENDOR_PROMISE_LABEL;
  }
  return standing || null;
}

function projectionProvenance(citation, qualityGate, raw = {}) {
  const excerpt = citation?.excerpt || "";
  return {
    excerpt_hash: excerpt ? contentHashOf(excerpt) : null,
    extraction_quality: qualityGate?.quality?.quality_state
      || qualityGate?.quality_state
      || raw.extraction_quality
      || null,
    projector_version: PROJECTOR_VERSION,
    resident_claim_label: null,
  };
}

function unresolvedRow({
  kind,
  reason,
  contractId = null,
  documentRole = null,
  details = null,
  quality = null,
  citations = null,
} = {}) {
  return {
    schema: CONTRACT_SUBSTANCE_SCHEMA,
    kind: kind || null,
    status: "unresolved",
    reason,
    contract_id: contractId,
    document_role: documentRole,
    resident_assertion: false,
    desk_reviewable: true,
    details: details || null,
    quality: quality || null,
    citations: Array.isArray(citations) ? citations : null,
  };
}

/**
 * Refuse manufactured unit prices: totals must never be divided by capacity,
 * payment count, or term length to invent a rate.
 */
export function refuseManufacturedRate(candidate = {}) {
  const reasons = [];
  if (candidate.derive_rate_from_total === true
    || candidate.invent_unit_price === true
    || candidate.manufactured_rate === true) {
    reasons.push(UNRESOLVED_REASONS.MANUFACTURED_RATE);
  }
  if (candidate.rate_source === "total_divided_by_quantity"
    || candidate.rate_source === "total_divided_by_payments"
    || candidate.rate_source === "total_divided_by_term"
    || candidate.rate_source === "total_divided_by_duration"
    || candidate.rate_source === "total_divided_by_capacity"
    || candidate.rate_source === "total_divided_by_meals"
    || candidate.rate_source === "total_divided_by_sites"
    || candidate.rate_source === "derived_from_total") {
    reasons.push(UNRESOLVED_REASONS.MANUFACTURED_RATE);
  }
  const total = finiteNumber(candidate.contract_total || candidate.total || candidate.authorized_amount);
  const quantity = finiteNumber(candidate.quantity);
  const rate = finiteNumber(candidate.rate);
  if (
    total != null
    && quantity != null
    && quantity !== 0
    && rate != null
    && candidate.rate_was_derived === true
  ) {
    reasons.push(UNRESOLVED_REASONS.MANUFACTURED_RATE);
  }
  // Explicit derivation payload: { total, divisor, operation: "divide" }.
  if (isRecord(candidate.derived_rate) && candidate.derived_rate.operation === "divide") {
    reasons.push(UNRESOLVED_REASONS.MANUFACTURED_RATE);
  }
  return reasons;
}

/**
 * Project one scope_fact from an admitted cited passage.
 */
export function projectScopeFact(raw = {}) {
  const citationResult = normalizeCitation(raw);
  if (!citationResult.ok) {
    return {
      ok: false,
      fact: null,
      unresolved: unresolvedRow({
        kind: FACT_KINDS.SCOPE_FACT,
        reason: UNRESOLVED_REASONS.MISSING_REQUIRED_FIELDS,
        contractId: clean(raw.contract_id, 160),
        documentRole: normalizeRole(raw.document_role || raw.role),
        details: { missing: citationResult.missing },
      }),
    };
  }

  const citation = citationResult.citation;
  const role = citation.document_role;
  if (!SCOPE_ROLES.has(role)) {
    return {
      ok: false,
      fact: null,
      unresolved: unresolvedRow({
        kind: FACT_KINDS.SCOPE_FACT,
        reason: UNRESOLVED_REASONS.DISQUALIFIED_SOURCE,
        contractId: citation.contract_id,
        documentRole: role,
        details: { refused_role: role },
        citations: [citation],
      }),
    };
  }

  const qualityGate = assessPassageForProjection({
    text: citation.excerpt,
    ...raw,
  });
  if (!qualityGate.ok) {
    return {
      ok: false,
      fact: null,
      unresolved: unresolvedRow({
        kind: FACT_KINDS.SCOPE_FACT,
        reason: qualityGate.reason,
        contractId: citation.contract_id,
        documentRole: role,
        quality: qualityGate.quality,
        citations: [citation],
      }),
    };
  }

  const subject = clean(raw.subject, 240);
  const action = clean(raw.action || raw.action_object, 240);
  const object = clean(raw.object || raw.action_object_target, 240);
  const exclusions = clean(raw.exclusions || raw.exclusion, 400);
  const period = clean(raw.period || raw.term_period, 120);
  if (!subject && !action && !object) {
    return {
      ok: false,
      fact: null,
      unresolved: unresolvedRow({
        kind: FACT_KINDS.SCOPE_FACT,
        reason: UNRESOLVED_REASONS.MISSING_REQUIRED_FIELDS,
        contractId: citation.contract_id,
        documentRole: role,
        details: { missing: ["subject_or_action_object"] },
        citations: [citation],
      }),
    };
  }

  const standing = standingLabelForRole(role);
  // Solicitation scope is never executed wording.
  if (role === EVIDENCE_ROLES.SOLICITATION_SCOPE
    && (standing === STANDING_LABELS.EXECUTED || standing === STANDING_LABELS.VENDOR_PROMISED)) {
    return {
      ok: false,
      fact: null,
      unresolved: unresolvedRow({
        kind: FACT_KINDS.SCOPE_FACT,
        reason: UNRESOLVED_REASONS.DISQUALIFIED_SOURCE,
        contractId: citation.contract_id,
        documentRole: role,
        details: { refused_standing: standing },
        citations: [citation],
      }),
    };
  }

  const factId = clean(raw.fact_id || raw.id, 120)
    || `scope:${citation.contract_id}:${citation.source_document_id}:${citation.locator}`;
  const provenance = projectionProvenance(citation, qualityGate, raw);
  const fact = {
    schema: CONTRACT_SUBSTANCE_SCHEMA,
    kind: FACT_KINDS.SCOPE_FACT,
    status: "admitted",
    fact_id: factId,
    contract_id: citation.contract_id,
    subject,
    action,
    object,
    exclusions,
    period,
    document_role: role,
    standing_label: standing,
    locator: citation.locator,
    excerpt: citation.excerpt,
    source_document_id: citation.source_document_id,
    content_hash: citation.content_hash,
    public_url: citation.public_url,
    publication_date: citation.publication_date,
    effective_date: citation.effective_date,
    version: clean(raw.version, 40) || "1",
    supersedes_fact_id: clean(raw.supersedes_fact_id, 120),
    superseded_by_fact_id: clean(raw.superseded_by_fact_id, 120),
    resident_assertion: true,
    desk_reviewable: false,
    ...provenance,
    resident_claim_label: residentClaimLabel({ standing_label: standing, document_role: role }),
  };
  return { ok: true, unresolved: null, fact };
}

/**
 * Project one price_term. Missing quantity/unit/rate stay null; never derived.
 */
export function projectPriceTerm(raw = {}) {
  const manufactured = refuseManufacturedRate(raw);
  if (manufactured.length) {
    return {
      ok: false,
      fact: null,
      unresolved: unresolvedRow({
        kind: FACT_KINDS.PRICE_TERM,
        reason: UNRESOLVED_REASONS.MANUFACTURED_RATE,
        contractId: clean(raw.contract_id, 160),
        documentRole: normalizeRole(raw.document_role || raw.role),
        details: { refusal_reasons: manufactured },
      }),
    };
  }

  const citationResult = normalizeCitation(raw);
  if (!citationResult.ok) {
    return {
      ok: false,
      fact: null,
      unresolved: unresolvedRow({
        kind: FACT_KINDS.PRICE_TERM,
        reason: UNRESOLVED_REASONS.MISSING_REQUIRED_FIELDS,
        contractId: clean(raw.contract_id, 160),
        documentRole: normalizeRole(raw.document_role || raw.role),
        details: { missing: citationResult.missing },
      }),
    };
  }

  const citation = citationResult.citation;
  const role = citation.document_role;
  if (!PRICE_ROLES.has(role)) {
    return {
      ok: false,
      fact: null,
      unresolved: unresolvedRow({
        kind: FACT_KINDS.PRICE_TERM,
        reason: UNRESOLVED_REASONS.DISQUALIFIED_SOURCE,
        contractId: citation.contract_id,
        documentRole: role,
        details: { refused_role: role },
        citations: [citation],
      }),
    };
  }

  const qualityGate = assessPassageForProjection({ text: citation.excerpt, ...raw });
  if (!qualityGate.ok) {
    return {
      ok: false,
      fact: null,
      unresolved: unresolvedRow({
        kind: FACT_KINDS.PRICE_TERM,
        reason: qualityGate.reason,
        contractId: citation.contract_id,
        documentRole: role,
        quality: qualityGate.quality,
        citations: [citation],
      }),
    };
  }

  const paymentBasis = normalizePaymentBasis(raw.payment_basis || raw.basis);
  if (!paymentBasis) {
    return {
      ok: false,
      fact: null,
      unresolved: unresolvedRow({
        kind: FACT_KINDS.PRICE_TERM,
        reason: UNRESOLVED_REASONS.MISSING_REQUIRED_FIELDS,
        contractId: citation.contract_id,
        documentRole: role,
        details: { missing: ["payment_basis"] },
        citations: [citation],
      }),
    };
  }

  // Preserve available components without inventing missing ones.
  const quantity = finiteNumber(raw.quantity);
  const unit = clean(raw.unit, 40);
  const rate = finiteNumber(raw.rate);
  // Quantity without unit (or unit without quantity) is kept as published
  // when present, but a mutation that strips one of a required pair for a
  // unit_price basis is refused rather than half-filled.
  if (paymentBasis === "unit_price") {
    if ((quantity != null && !unit) || (unit && quantity == null) || rate == null) {
      // Still admit when the published schedule simply omits a component
      // and the caller did not claim a unit_price derivation — unless the
      // caller marked the pair as required-together.
      if (raw.require_quantity_unit_pair === true) {
        return {
          ok: false,
          fact: null,
          unresolved: unresolvedRow({
            kind: FACT_KINDS.PRICE_TERM,
            reason: UNRESOLVED_REASONS.MISSING_REQUIRED_FIELDS,
            contractId: citation.contract_id,
            documentRole: role,
            details: { missing: ["quantity_unit_pair_or_rate"] },
            citations: [citation],
          }),
        };
      }
    }
  }

  const factId = clean(raw.fact_id || raw.id, 120)
    || `price:${citation.contract_id}:${citation.source_document_id}:${citation.locator}`;
  const standing = standingLabelForRole(role);
  const provenance = projectionProvenance(citation, qualityGate, raw);
  const fact = {
    schema: CONTRACT_SUBSTANCE_SCHEMA,
    kind: FACT_KINDS.PRICE_TERM,
    status: "admitted",
    fact_id: factId,
    contract_id: citation.contract_id,
    payment_basis: paymentBasis,
    description: clean(raw.description, 400),
    quantity,
    unit,
    rate,
    maximum: finiteNumber(raw.maximum || raw.not_to_exceed),
    period: clean(raw.period, 120),
    option_period: clean(raw.option_period, 120),
    conditions: clean(raw.conditions || raw.condition, 400),
    document_role: role,
    standing_label: standing,
    locator: citation.locator,
    excerpt: citation.excerpt,
    source_document_id: citation.source_document_id,
    content_hash: citation.content_hash,
    public_url: citation.public_url,
    publication_date: citation.publication_date,
    effective_date: citation.effective_date,
    version: clean(raw.version, 40) || "1",
    supersedes_fact_id: clean(raw.supersedes_fact_id, 120),
    superseded_by_fact_id: clean(raw.superseded_by_fact_id, 120),
    resident_assertion: true,
    desk_reviewable: false,
    ...provenance,
    resident_claim_label: residentClaimLabel({ standing_label: standing, document_role: role }),
  };
  return { ok: true, unresolved: null, fact };
}

/**
 * Project one obligation. Only executed roles may carry "the vendor promised".
 * Project descriptions, titles, payment rows, and performance evaluations refuse.
 */
export function projectObligation(raw = {}) {
  const role = normalizeRole(raw.document_role || raw.evidence_role || raw.role);
  if (role && DISQUALIFIED_OBLIGATION_ROLES.has(role)) {
    return {
      ok: false,
      fact: null,
      unresolved: unresolvedRow({
        kind: FACT_KINDS.OBLIGATION,
        reason: UNRESOLVED_REASONS.DISQUALIFIED_SOURCE,
        contractId: clean(raw.contract_id, 160),
        documentRole: role,
        details: {
          refused_role: role,
          note: "project descriptions, titles, payment rows, and performance evaluations cannot create an obligation",
        },
      }),
    };
  }

  const citationResult = normalizeCitation(raw);
  if (!citationResult.ok) {
    return {
      ok: false,
      fact: null,
      unresolved: unresolvedRow({
        kind: FACT_KINDS.OBLIGATION,
        reason: UNRESOLVED_REASONS.MISSING_REQUIRED_FIELDS,
        contractId: clean(raw.contract_id, 160),
        documentRole: role,
        details: { missing: citationResult.missing },
      }),
    };
  }

  const citation = citationResult.citation;
  const documentRole = citation.document_role;
  if (!OBLIGATION_ROLES.has(documentRole)) {
    return {
      ok: false,
      fact: null,
      unresolved: unresolvedRow({
        kind: FACT_KINDS.OBLIGATION,
        reason: UNRESOLVED_REASONS.DISQUALIFIED_SOURCE,
        contractId: citation.contract_id,
        documentRole,
        details: { refused_role: documentRole },
        citations: [citation],
      }),
    };
  }

  // Solicitation language can never become "the vendor promised".
  if (documentRole === EVIDENCE_ROLES.SOLICITATION_SCOPE
    || raw.standing_label === STANDING_LABELS.VENDOR_PROMISED
      && !EXECUTED_ROLES.has(documentRole)) {
    return {
      ok: false,
      fact: null,
      unresolved: unresolvedRow({
        kind: FACT_KINDS.OBLIGATION,
        reason: UNRESOLVED_REASONS.DISQUALIFIED_SOURCE,
        contractId: citation.contract_id,
        documentRole,
        details: { refused_standing: STANDING_LABELS.VENDOR_PROMISED },
        citations: [citation],
      }),
    };
  }

  const qualityGate = assessPassageForProjection({ text: citation.excerpt, ...raw });
  if (!qualityGate.ok) {
    return {
      ok: false,
      fact: null,
      unresolved: unresolvedRow({
        kind: FACT_KINDS.OBLIGATION,
        reason: qualityGate.reason,
        contractId: citation.contract_id,
        documentRole,
        quality: qualityGate.quality,
        citations: [citation],
      }),
    };
  }

  const obligatedParty = clean(raw.obligated_party || raw.party, 120);
  const action = clean(raw.action, 240);
  const deliverable = clean(raw.deliverable || raw.object, 240);
  if (!obligatedParty || !action || !deliverable) {
    return {
      ok: false,
      fact: null,
      unresolved: unresolvedRow({
        kind: FACT_KINDS.OBLIGATION,
        reason: UNRESOLVED_REASONS.MISSING_REQUIRED_FIELDS,
        contractId: citation.contract_id,
        documentRole,
        details: { missing: ["obligated_party", "action", "deliverable"].filter((key) => {
          if (key === "obligated_party") return !obligatedParty;
          if (key === "action") return !action;
          return !deliverable;
        }) },
        citations: [citation],
      }),
    };
  }

  const standing = standingLabelForRole(documentRole, { forObligation: true });
  if (standing === STANDING_LABELS.VENDOR_PROMISED && !EXECUTED_ROLES.has(documentRole)) {
    return {
      ok: false,
      fact: null,
      unresolved: unresolvedRow({
        kind: FACT_KINDS.OBLIGATION,
        reason: UNRESOLVED_REASONS.DISQUALIFIED_SOURCE,
        contractId: citation.contract_id,
        documentRole,
        details: { refused_standing: standing },
        citations: [citation],
      }),
    };
  }

  const factId = clean(raw.fact_id || raw.id, 120)
    || `obligation:${citation.contract_id}:${citation.source_document_id}:${citation.locator}`;
  const provenance = projectionProvenance(citation, qualityGate, raw);
  const fact = {
    schema: CONTRACT_SUBSTANCE_SCHEMA,
    kind: FACT_KINDS.OBLIGATION,
    status: "admitted",
    fact_id: factId,
    contract_id: citation.contract_id,
    obligated_party: obligatedParty,
    action,
    deliverable,
    quantity: finiteNumber(raw.quantity),
    frequency: clean(raw.frequency, 80),
    deadline: clean(raw.deadline, 80),
    period: clean(raw.period || raw.deadline_period, 120),
    condition: clean(raw.condition || raw.conditions, 400),
    document_role: documentRole,
    standing_label: standing,
    locator: citation.locator,
    excerpt: citation.excerpt,
    source_document_id: citation.source_document_id,
    content_hash: citation.content_hash,
    public_url: citation.public_url,
    publication_date: citation.publication_date,
    effective_date: citation.effective_date,
    version: clean(raw.version, 40) || "1",
    supersedes_fact_id: clean(raw.supersedes_fact_id, 120),
    superseded_by_fact_id: clean(raw.superseded_by_fact_id, 120),
    resident_assertion: true,
    desk_reviewable: false,
    ...provenance,
    resident_claim_label: residentClaimLabel({ standing_label: standing, document_role: documentRole }),
  };
  return { ok: true, unresolved: null, fact };
}

/**
 * Link an amendment to the affected prior term without erasing it.
 * Returns { prior, amended } where prior retains its fields and gains
 * superseded_by_fact_id; amended carries supersedes_fact_id.
 */
export function applyAmendment({ prior, amendment } = {}) {
  if (!isRecord(prior) || prior.status !== "admitted" || !prior.fact_id) {
    return {
      ok: false,
      prior: null,
      amended: null,
      unresolved: unresolvedRow({
        kind: prior?.kind || null,
        reason: UNRESOLVED_REASONS.MISSING_REQUIRED_FIELDS,
        details: { missing: ["admitted_prior_fact"] },
      }),
    };
  }

  const projector = prior.kind === FACT_KINDS.SCOPE_FACT
    ? projectScopeFact
    : prior.kind === FACT_KINDS.PRICE_TERM
      ? projectPriceTerm
      : prior.kind === FACT_KINDS.OBLIGATION
        ? projectObligation
        : null;
  if (!projector) {
    return {
      ok: false,
      prior: null,
      amended: null,
      unresolved: unresolvedRow({
        reason: UNRESOLVED_REASONS.DISQUALIFIED_SOURCE,
        details: { refused_kind: prior.kind },
      }),
    };
  }

  const amendmentInput = {
    ...amendment,
    document_role: normalizeRole(amendment?.document_role || amendment?.role) || EVIDENCE_ROLES.AMENDMENT,
    supersedes_fact_id: prior.fact_id,
    version: clean(amendment?.version, 40)
      || String(Number(prior.version || 1) + 1),
  };
  const projected = projector(amendmentInput);
  if (!projected.ok) {
    return {
      ok: false,
      prior: { ...prior },
      amended: null,
      unresolved: projected.unresolved,
    };
  }

  const amended = {
    ...projected.fact,
    supersedes_fact_id: prior.fact_id,
    standing_label: STANDING_LABELS.AMENDED,
    document_role: EVIDENCE_ROLES.AMENDMENT,
  };
  const retainedPrior = {
    ...prior,
    superseded_by_fact_id: amended.fact_id,
    // Prior version is retained, not erased.
    status: "admitted",
    resident_assertion: true,
  };

  return { ok: true, prior: retainedPrior, amended, unresolved: null };
}

/**
 * Detect conflicting passages for the same fact identity and emit a Desk
 * unresolved row instead of a positive resident assertion.
 */
export function resolveConflictingPassages(candidates = [], { kind } = {}) {
  const admitted = [];
  const unresolved = [];
  const byKey = new Map();

  for (const raw of Array.isArray(candidates) ? candidates : []) {
    const projector = kind === FACT_KINDS.SCOPE_FACT
      ? projectScopeFact
      : kind === FACT_KINDS.PRICE_TERM
        ? projectPriceTerm
        : kind === FACT_KINDS.OBLIGATION
          ? projectObligation
          : null;
    if (!projector) continue;
    const result = projector(raw);
    if (!result.ok) {
      if (result.unresolved) unresolved.push(result.unresolved);
      continue;
    }
    // Identity for conflict detection deliberately excludes action/excerpt/rate
    // so disagreeing passages about the same subject collide into one review.
    const key = [
      result.fact.contract_id,
      result.fact.kind,
      result.fact.subject || result.fact.description || result.fact.deliverable || "",
      result.fact.object || "",
      result.fact.payment_basis || "",
      result.fact.obligated_party || "",
    ].join("|");
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(result.fact);
  }

  for (const [, group] of byKey) {
    if (group.length === 1) {
      admitted.push(group[0]);
      continue;
    }
    // Conflict when excerpts, rates, or actions disagree for the same identity.
    const excerpts = new Set(group.map((f) => f.excerpt));
    const rates = new Set(group.map((f) => String(f.rate ?? "")));
    const actions = new Set(group.map((f) => f.action || ""));
    if (excerpts.size > 1 || rates.size > 1 || actions.size > 1) {
      unresolved.push(unresolvedRow({
        kind,
        reason: UNRESOLVED_REASONS.CONFLICTING_PASSAGES,
        contractId: group[0].contract_id,
        documentRole: group[0].document_role,
        details: {
          conflict_count: group.length,
          fact_ids: group.map((f) => f.fact_id),
        },
        citations: group.map((f) => ({
          contract_id: f.contract_id,
          source_document_id: f.source_document_id,
          content_hash: f.content_hash,
          locator: f.locator,
          excerpt: f.excerpt,
          document_role: f.document_role,
        })),
      }));
    } else {
      // Identical repeats: keep the first.
      admitted.push(group[0]);
    }
  }

  return { admitted, unresolved };
}

/**
 * Project a batch of raw candidates into admitted facts and Desk unresolved rows.
 */
export function projectContractSubstance({
  scopeCandidates = [],
  priceCandidates = [],
  obligationCandidates = [],
} = {}) {
  const scope = resolveConflictingPassages(scopeCandidates, { kind: FACT_KINDS.SCOPE_FACT });
  const price = resolveConflictingPassages(priceCandidates, { kind: FACT_KINDS.PRICE_TERM });
  const obligation = resolveConflictingPassages(obligationCandidates, { kind: FACT_KINDS.OBLIGATION });

  return {
    scope_facts: scope.admitted,
    price_terms: price.admitted,
    obligations: obligation.admitted,
    unresolved: [
      ...scope.unresolved,
      ...price.unresolved,
      ...obligation.unresolved,
    ],
  };
}

/**
 * Build unresolved Desk rows when access classification shows no public
 * document for a contract's substance roles.
 */
export function unresolvedFromAccessObservations(observations = []) {
  const rows = [];
  for (const observation of Array.isArray(observations) ? observations : []) {
    const contractId = clean(observation.contract_id, 160);
    const documentRole = normalizeRole(observation.document_role || observation.role);
    const accessState = clean(observation.access_state, 40);
    if (!contractId || !documentRole) continue;
    if (accessState === ACCESS_STATES.PUBLIC_DOCUMENT) continue;
    rows.push(unresolvedRow({
      reason: UNRESOLVED_REASONS.ACCESS_NOT_PUBLIC,
      contractId,
      documentRole,
      details: {
        access_state: accessState,
        checked_source_ids: Array.isArray(observation.checked_source_ids)
          ? [...observation.checked_source_ids]
          : [],
        observed_at: observation.observed_at || null,
      },
    }));
  }
  return rows;
}

export function buildContractSubstanceDocument({
  scopeFacts = [],
  priceTerms = [],
  obligations = [],
  unresolved = [],
  generatedAt = null,
  observationVintage = null,
  notes = null,
} = {}) {
  const generated = generatedAt && isoInstant(generatedAt)
    ? generatedAt
    : new Date().toISOString();

  const sortById = (left, right) => String(left.fact_id || "").localeCompare(String(right.fact_id || ""));

  return {
    schema: CONTRACT_SUBSTANCE_SCHEMA,
    generated_at: generated,
    observation_vintage: observationVintage,
    notes: notes || null,
    fixed_contract_ids: [...FIXED_CONTRACT_IDS],
    scope_facts: [...scopeFacts].sort(sortById),
    price_terms: [...priceTerms].sort(sortById),
    obligations: [...obligations].sort(sortById),
    unresolved: [...unresolved],
    boundaries: {
      manufactured_rates: "Contract totals are never divided by capacity, payments, or term to invent unit prices.",
      solicitation_labeling: "Solicitation and RFx language is labeled advertised or requested, never executed.",
      obligation_sources: "Project descriptions, titles, payment rows, and performance evaluations cannot create an obligation.",
      promise_wording: "Only executed document roles may be labeled \"the vendor promised.\" Proposed, prior-term, bid, template, audit, title, payment, and project-summary evidence cannot produce \"What the vendor promised.\"",
      quality_gate: "Empty text layers, low-quality extraction, and unreadable pages (no OCR) produce Desk unresolved rows with no positive resident assertion.",
      amendments: "Amendments link to the affected term and retain the prior version.",
    },
  };
}
