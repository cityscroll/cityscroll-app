/**
 * Real public-document corpus for contract-substance access grounding.
 *
 * Retains hash-addressed official examples (award notice, bid tab, proposed
 * agreement / site schedule, performance evaluation) and binds them to
 * CityScroll contract identities only through exact identity relations.
 * Document role travels with every retained object: bid tabs, proposed
 * packets, and audits never become executed agreements without independent
 * signature and effective-status evidence.
 *
 * Uses the publisher-neutral document-processing primitives for hashing and
 * receipt shape. Does not introduce a parallel evidence store.
 */

import { contentHashOf } from "../warehouse/lib/document_processing.mjs";
import {
  ACCESS_STATES,
  DOCUMENT_ROLES as ACCESS_DOCUMENT_ROLES,
  FIXED_CONTRACT_IDS,
  REQUIRED_DOCUMENT_ROLES,
  indexAccessObservations,
  roleAccessForContract,
  validateFixedContractAccessCoverage,
} from "./procurement_contract_substance_access.mjs";

export const REAL_CORPUS_SCHEMA = "cityscroll.procurement_contract_substance_real_corpus.v1";

/** Bounded source roles for retained official documents. */
export const CORPUS_DOCUMENT_ROLES = Object.freeze({
  AWARD_NOTICE: "award_notice",
  BID_TAB: "bid_tab",
  PROPOSED_AGREEMENT: "proposed_agreement",
  SITE_SCHEDULE: "site_schedule",
  PERFORMANCE_EVALUATION: "performance_evaluation",
});

export const CORPUS_ROLE_SET = new Set(Object.values(CORPUS_DOCUMENT_ROLES));

/** Claims that require admitted executed-agreement evidence. */
export const EXECUTED_SCOPE_CLAIMS = Object.freeze([
  "executed_scope",
  "contractual_price",
  "vendor_promise",
]);

export const BHRAGS_CONTRACT_ID = "CT107120258801626";
export const BHRAGS_NOTICE_ID = "20240829105";
export const DOCGO_CONTRACT_ID = "CT180620248801671";
export const DOCGO_CONTRACT_NUMBER = "20248801671";

export const FIXED_CORPUS_DOCUMENT_IDS = Object.freeze([
  "city-record-notice-20240829105",
  "dcas-bid-tab-2000090",
  "mocs-fcrc-packet-202411-proposed-agreement",
  "mocs-fcrc-packet-202411-site-schedule",
  "comptroller-docgo-audit-20248801671",
]);

const CONTENT_HASH_RE = /^(sha256:)?[a-f0-9]{64}$/i;
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const DISQUALIFIED_PROVENANCE = new Set([
  "nonofficial_repost",
  "authenticated_passport_view",
  "login_url",
  "unsigned_template",
  "title",
  "metadata_row",
  "agency_description",
  "candidate_copy_without_authority",
]);

const FIRST_PARTY_HOST_SUFFIXES = Object.freeze([
  "nyc.gov",
  "cityofnewyork.us",
  "comptroller.nyc.gov",
  "cityscroll.org",
]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clean(value, max = 500) {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

function isoInstant(value) {
  if (!clean(value, 64) || !ISO_INSTANT_RE.test(String(value).trim())) return false;
  return Number.isFinite(new Date(value).getTime());
}

function isoDate(value) {
  return Boolean(clean(value, 10) && ISO_DATE_RE.test(String(value).trim()));
}

function normalizeHash(value) {
  const raw = clean(value, 100);
  if (!raw || !CONTENT_HASH_RE.test(raw)) return null;
  return `sha256:${raw.toLowerCase().replace(/^sha256:/, "")}`;
}

function normalizeRole(value) {
  return clean(value, 80)?.toLowerCase().replace(/[\s-]+/g, "_") || null;
}

function isHttpsUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isLoginOrAuthenticatedUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return true;
    if (/\/(?:login|signin)(?:[/?#]|$)/i.test(parsed.pathname)) return true;
    if (/[?&](?:ReturnUrl|returnUrl|return_url)=/i.test(parsed.search)) return true;
    if (/(^|\.)passport\.cityofnewyork\.us$/i.test(parsed.hostname)) return true;
    return false;
  } catch {
    return true;
  }
}

function hostIsFirstParty(hostname) {
  const host = String(hostname || "").toLowerCase();
  return FIRST_PARTY_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * Refusal reasons for retaining a candidate as a corpus public document.
 */
export function corpusRetentionRefusalReasons(candidate = {}) {
  const reasons = [];
  const role = normalizeRole(candidate.document_role || candidate.role);
  const provenance = normalizeRole(candidate.provenance_class || candidate.provenance);

  if (!clean(candidate.document_id || candidate.source_document_id, 180)) {
    reasons.push("missing_document_id");
  }
  if (!clean(candidate.publisher, 160)) reasons.push("missing_publisher");
  if (!isoInstant(candidate.retrieved_at || candidate.retrieval_time)) {
    reasons.push("missing_retrieval_time");
  }
  const finalUrl = clean(candidate.final_url || candidate.public_url || candidate.url, 2000);
  if (!finalUrl || !isHttpsUrl(finalUrl)) reasons.push("missing_or_invalid_final_url");
  if (finalUrl && isLoginOrAuthenticatedUrl(finalUrl)) reasons.push("login_or_authenticated_url");

  if (!normalizeHash(candidate.content_hash)) reasons.push("missing_or_invalid_content_hash");
  if (!clean(candidate.media_type || candidate.content_type, 120)) reasons.push("missing_media_type");

  const pageCount = candidate.page_count;
  const extractionExtent = clean(candidate.extraction_extent, 240);
  const hasPageCount = Number.isInteger(pageCount) && pageCount >= 1;
  if (!hasPageCount && !extractionExtent) {
    reasons.push("missing_page_count_or_extraction_extent");
  }

  if (!clean(candidate.locator || candidate.page_section_locator, 240)) {
    reasons.push("missing_page_section_locator");
  }
  if (!role || !CORPUS_ROLE_SET.has(role)) reasons.push("missing_or_unsupported_document_role");
  if (!isoDate(candidate.publication_date || candidate.document_date)) {
    reasons.push("missing_publication_date");
  }

  if (provenance && DISQUALIFIED_PROVENANCE.has(provenance)) {
    reasons.push(`disqualified_provenance:${provenance}`);
  }
  if (candidate.redistribution_authority === false && candidate.held_candidate === true) {
    reasons.push("candidate_copy_held_without_authority");
  }
  if (candidate.authenticated_passport_view === true) {
    reasons.push("authenticated_passport_view");
  }
  if (candidate.nonofficial_repost === true) reasons.push("nonofficial_repost");
  if (candidate.unsigned_template === true && role === CORPUS_DOCUMENT_ROLES.PROPOSED_AGREEMENT) {
    // Unsigned templates may be retained as proposed, but never as executed.
  } else if (candidate.unsigned_template === true && role !== CORPUS_DOCUMENT_ROLES.PROPOSED_AGREEMENT) {
    reasons.push("unsigned_template_not_admitted_as_role");
  }

  if (finalUrl) {
    try {
      const host = new URL(finalUrl).hostname;
      if (!hostIsFirstParty(host) && candidate.first_party_provenance !== true) {
        reasons.push("non_first_party_host_without_provenance");
      }
    } catch {
      reasons.push("missing_or_invalid_final_url");
    }
  }

  return reasons;
}

/**
 * Admit one retained corpus document, or refuse with reasons.
 */
export function retainCorpusDocument(candidate = {}) {
  const reasons = corpusRetentionRefusalReasons(candidate);
  if (reasons.length) {
    return { ok: false, reasons, document: null };
  }

  const role = normalizeRole(candidate.document_role || candidate.role);
  const pageCount = Number.isInteger(candidate.page_count) && candidate.page_count >= 1
    ? candidate.page_count
    : null;
  const extractionExtent = clean(candidate.extraction_extent, 240);
  const execution = normalizeExecutionEvidence(candidate.execution_evidence || candidate.execution);

  // Proposed agreements stay proposed unless signature + effective status are admitted.
  let effectiveRole = role;
  if (role === CORPUS_DOCUMENT_ROLES.PROPOSED_AGREEMENT) {
    if (!(execution.signature_present === true && execution.effective_status_admitted === true)) {
      effectiveRole = CORPUS_DOCUMENT_ROLES.PROPOSED_AGREEMENT;
    }
  }

  return {
    ok: true,
    reasons: [],
    document: {
      document_id: clean(candidate.document_id || candidate.source_document_id, 180),
      publisher: clean(candidate.publisher, 160),
      retrieved_at: clean(candidate.retrieved_at || candidate.retrieval_time, 64),
      final_url: clean(candidate.final_url || candidate.public_url || candidate.url, 2000),
      content_hash: normalizeHash(candidate.content_hash),
      media_type: clean(candidate.media_type || candidate.content_type, 120),
      page_count: pageCount,
      extraction_extent: extractionExtent,
      locator: clean(candidate.locator || candidate.page_section_locator, 240),
      document_role: effectiveRole,
      publication_date: clean(candidate.publication_date || candidate.document_date, 10),
      redistribution_authority: candidate.redistribution_authority === true,
      first_party_provenance: candidate.first_party_provenance === true,
      execution_evidence: execution,
      identity_links: normalizeIdentityLinks(candidate.identity_links || candidate.links),
    },
  };
}

function normalizeExecutionEvidence(raw = {}) {
  if (!isRecord(raw)) {
    return {
      signature_present: false,
      effective_status_admitted: false,
      status: "not_admitted",
      notes: null,
    };
  }
  const signaturePresent = raw.signature_present === true;
  const effectiveAdmitted = raw.effective_status_admitted === true;
  return {
    signature_present: signaturePresent,
    effective_status_admitted: effectiveAdmitted,
    status: signaturePresent && effectiveAdmitted ? "executed_admitted" : clean(raw.status, 80) || "not_admitted",
    notes: clean(raw.notes, 400),
  };
}

function normalizeIdentityLinks(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const links = [];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const relation = clean(entry.relation || entry.relation_basis, 80);
    const contractId = clean(entry.contract_id, 160);
    const matchedValue = clean(entry.matched_value || entry.contract_number || contractId, 160);
    if (!relation || !contractId || !matchedValue) continue;
    // Only exact identity relations may attach a real document to a contract.
    if (relation !== "exact_contract_id" && relation !== "exact_contract_number") continue;
    links.push({
      relation,
      contract_id: contractId,
      matched_value: matchedValue,
    });
  }
  return links;
}

/**
 * Classify a retained object into its bounded source role(s). The MOCS packet
 * remains proposed_agreement unless signature and effective status are both
 * independently admitted.
 */
export function classifyCorpusDocumentRole(candidate = {}) {
  const retained = retainCorpusDocument(candidate);
  if (!retained.ok) {
    return { ok: false, roles: [], reasons: retained.reasons, executed_agreement: false };
  }
  const doc = retained.document;
  const roles = [doc.document_role];
  const executed = doc.document_role !== CORPUS_DOCUMENT_ROLES.PROPOSED_AGREEMENT
    && doc.execution_evidence?.signature_present === true
    && doc.execution_evidence?.effective_status_admitted === true
    && doc.document_role === "executed_agreement";

  return {
    ok: true,
    roles,
    reasons: [],
    executed_agreement: executed === true,
    document: doc,
  };
}

/**
 * Attach a retained document to a CityScroll contract only through an exact
 * identity relation. Soft resemblance links are refused.
 */
export function attachDocumentViaExactIdentity(document, link = {}) {
  const retained = isRecord(document?.content_hash) || document?.document_id
    ? retainCorpusDocument(document)
    : { ok: Boolean(document?.document_id && document?.content_hash), document, reasons: [] };

  if (!retained.ok || !retained.document) {
    return { ok: false, reasons: retained.reasons || ["document_not_retained"], attachment: null };
  }

  const relation = clean(link.relation || link.relation_basis, 80);
  const contractId = clean(link.contract_id, 160);
  const matchedValue = clean(link.matched_value || link.contract_number || contractId, 160);
  const reasons = [];
  if (!contractId) reasons.push("missing_contract_identity");
  if (!matchedValue) reasons.push("missing_matched_value");
  if (relation !== "exact_contract_id" && relation !== "exact_contract_number") {
    reasons.push("identity_relation_must_be_exact");
  }
  if (reasons.length) return { ok: false, reasons, attachment: null };

  return {
    ok: true,
    reasons: [],
    attachment: {
      document_id: retained.document.document_id,
      document_role: retained.document.document_role,
      content_hash: retained.document.content_hash,
      contract_id: contractId,
      matched_value: matchedValue,
      relation,
      // An attached performance evaluation or award notice is never the executed agreement.
      treats_as_executed_agreement: false,
    },
  };
}

/**
 * Resolve DocGo CT180620248801671 against contract number 20248801671 and
 * link the Comptroller audit without treating the audit as the executed agreement.
 */
export function resolveDocGoAuditIdentity(document, {
  contractId = DOCGO_CONTRACT_ID,
  contractNumber = DOCGO_CONTRACT_NUMBER,
} = {}) {
  const retained = retainCorpusDocument(document);
  if (!retained.ok) return { ok: false, reasons: retained.reasons, link: null };
  if (retained.document.document_role !== CORPUS_DOCUMENT_ROLES.PERFORMANCE_EVALUATION) {
    return { ok: false, reasons: ["docgo_audit_must_be_performance_evaluation"], link: null };
  }

  const linkedNumber = retained.document.identity_links.find((link) => (
    link.relation === "exact_contract_number"
    && link.contract_id === contractId
    && link.matched_value === contractNumber
  ));
  const reportsNumber = clean(document.reports_contract_number || document.matched_contract_number, 160);
  if (!linkedNumber && reportsNumber !== contractNumber) {
    return {
      ok: false,
      reasons: ["docgo_audit_missing_exact_contract_number_link"],
      link: null,
    };
  }

  const attachment = attachDocumentViaExactIdentity(retained.document, {
    relation: "exact_contract_number",
    contract_id: contractId,
    matched_value: contractNumber,
  });
  if (!attachment.ok) return { ok: false, reasons: attachment.reasons, link: null };

  return {
    ok: true,
    reasons: [],
    link: {
      ...attachment.attachment,
      cityscroll_contract_id: contractId,
      publisher_contract_number: contractNumber,
      executed_agreement: false,
      reader_basis: "comptroller_audit_reports_contract_terms",
    },
  };
}

/**
 * Hard-negative gate: nonofficial reposts, authenticated PASSPort views, login
 * URLs, unsigned templates (as executed), titles, metadata rows, and agency
 * descriptions cannot become public_document or executed_agreement.
 */
export function refuseNonPublicOrExecutedClaim(candidate = {}) {
  const reasons = [];
  const role = normalizeRole(candidate.document_role || candidate.role || candidate.claimed_role);
  const claim = normalizeRole(candidate.claim || candidate.access_state || candidate.label);
  const evidenceKind = normalizeRole(candidate.evidence_kind || candidate.kind);

  if (candidate.nonofficial_repost === true) reasons.push("nonofficial_repost");
  if (candidate.authenticated_passport_view === true) reasons.push("authenticated_passport_view");
  const url = clean(candidate.public_url || candidate.final_url || candidate.url, 2000);
  if (url && isLoginOrAuthenticatedUrl(url)) reasons.push("login_url");
  if (candidate.unsigned_template === true) reasons.push("unsigned_template");
  if (role === "title" || evidenceKind === "title") reasons.push("title");
  if (role === "metadata_row" || role === "metadata" || evidenceKind === "metadata_row") {
    reasons.push("metadata_row");
  }
  if (role === "agency_description" || evidenceKind === "agency_description") {
    reasons.push("agency_description");
  }
  if (candidate.held_candidate === true && candidate.redistribution_authority !== true) {
    reasons.push("candidate_copy_held_until_authority");
  }

  const claimsPublic = claim === "public_document" || claim === ACCESS_STATES.PUBLIC_DOCUMENT;
  const claimsExecuted = claim === "executed_agreement"
    || role === "executed_agreement"
    || claim === ACCESS_DOCUMENT_ROLES.EXECUTED_CONTRACT;

  if (claimsExecuted) {
    const execution = normalizeExecutionEvidence(candidate.execution_evidence || candidate.execution);
    if (!(execution.signature_present && execution.effective_status_admitted)) {
      reasons.push("executed_agreement_requires_signature_and_effective_status");
    }
  }

  if (claimsPublic && !reasons.length) {
    const retained = retainCorpusDocument({
      ...candidate,
      document_role: role && CORPUS_ROLE_SET.has(role) ? role : CORPUS_DOCUMENT_ROLES.AWARD_NOTICE,
    });
    if (!retained.ok) reasons.push(...retained.reasons);
  }

  return {
    ok: false,
    access_state: null,
    executed_agreement: false,
    public_document: false,
    reasons: reasons.length ? reasons : ["hard_negative_refused"],
  };
}

/**
 * Prove that removing one required field at a time blocks executed-scope,
 * contractual-price, and vendor-promise assertions.
 */
export function mutationBlocksExecutedScopeClaims(baseDocument, field) {
  const mutated = { ...baseDocument };
  switch (field) {
    case "document_role":
      delete mutated.document_role;
      delete mutated.role;
      break;
    case "publisher":
      mutated.publisher = "";
      break;
    case "contract_identity":
      mutated.identity_links = [];
      mutated.contract_id = "";
      mutated.reports_contract_number = null;
      break;
    case "signature_execution_evidence":
      mutated.execution_evidence = {
        signature_present: false,
        effective_status_admitted: false,
        status: "blank_signature",
      };
      break;
    case "public_url":
      mutated.final_url = "";
      mutated.public_url = "";
      mutated.url = "";
      break;
    case "content_hash":
      mutated.content_hash = "";
      break;
    case "page_locator":
      mutated.locator = "";
      mutated.page_section_locator = "";
      break;
    default:
      throw new Error(`unknown mutation field: ${field}`);
  }

  const retained = retainCorpusDocument(mutated);
  const claims = {};
  for (const claim of EXECUTED_SCOPE_CLAIMS) {
    claims[claim] = claimSurvivesMutation(retained, mutated, claim);
  }
  return {
    field,
    retained_ok: retained.ok,
    reasons: retained.reasons,
    claims,
    any_claim_survives: Object.values(claims).some(Boolean),
  };
}

function claimSurvivesMutation(retained, candidate, claim) {
  if (!retained.ok) return false;
  const doc = retained.document;
  if (claim === "executed_scope" || claim === "vendor_promise") {
    return doc.execution_evidence?.signature_present === true
      && doc.execution_evidence?.effective_status_admitted === true
      && doc.document_role !== CORPUS_DOCUMENT_ROLES.PROPOSED_AGREEMENT
      && doc.document_role !== CORPUS_DOCUMENT_ROLES.BID_TAB
      && doc.document_role !== CORPUS_DOCUMENT_ROLES.PERFORMANCE_EVALUATION
      && doc.document_role !== CORPUS_DOCUMENT_ROLES.AWARD_NOTICE;
  }
  if (claim === "contractual_price") {
    // Bid tabs and audits may report prices, but not as executed contractual prices.
    return doc.document_role !== CORPUS_DOCUMENT_ROLES.BID_TAB
      && doc.document_role !== CORPUS_DOCUMENT_ROLES.PERFORMANCE_EVALUATION
      && doc.document_role !== CORPUS_DOCUMENT_ROLES.PROPOSED_AGREEMENT
      && doc.execution_evidence?.signature_present === true
      && doc.execution_evidence?.effective_status_admitted === true;
  }
  return false;
}

/**
 * Verify optional byte payloads against a retained content hash using the
 * publisher-neutral hasher.
 */
export function verifyRetainedBytes(document, bytes) {
  const hash = normalizeHash(document?.content_hash);
  if (!hash) return { ok: false, reasons: ["missing_or_invalid_content_hash"] };
  if (bytes == null) return { ok: false, reasons: ["missing_bytes"] };
  const measured = contentHashOf(bytes);
  return {
    ok: measured === hash,
    reasons: measured === hash ? [] : ["content_hash_mismatch"],
    content_hash: measured,
    expected_content_hash: hash,
  };
}

export function buildRealCorpusDocument({
  rows = [],
  generatedAt = null,
  retrievalVintage = null,
} = {}) {
  const normalized = [];
  for (const raw of rows) {
    const retained = retainCorpusDocument(raw);
    if (retained.ok) normalized.push(retained.document);
  }
  normalized.sort((left, right) => (
    left.document_id.localeCompare(right.document_id)
    || left.document_role.localeCompare(right.document_role)
  ));
  return {
    schema: REAL_CORPUS_SCHEMA,
    generated_at: generatedAt,
    retrieval_vintage: retrievalVintage,
    document_roles: { ...CORPUS_DOCUMENT_ROLES },
    fixed_contract_ids: [...FIXED_CONTRACT_IDS],
    docgo_contract_id: DOCGO_CONTRACT_ID,
    docgo_contract_number: DOCGO_CONTRACT_NUMBER,
    absence_scope: "An unlocated executed agreement remains a bounded access result and is not an assertion that no agreement exists.",
    role_boundary: "Bid tabs, proposed agreements, site schedules, award notices, and performance evaluations retain their source roles and do not become executed agreements without independent signature and effective-status evidence.",
    rows: normalized,
  };
}

export function validateRealCorpusCoverage(document) {
  const errors = [];
  if (!isRecord(document) || document.schema !== REAL_CORPUS_SCHEMA) {
    return { ok: false, errors: ["document must use the real-corpus schema"] };
  }
  const rows = Array.isArray(document.rows) ? document.rows : [];
  const byId = new Map();
  for (const raw of rows) {
    const retained = retainCorpusDocument(raw);
    if (!retained.ok) {
      errors.push(`row refused: ${(raw?.document_id || "?").toString()} (${retained.reasons.join(",")})`);
      continue;
    }
    byId.set(retained.document.document_id, retained.document);
  }

  for (const id of FIXED_CORPUS_DOCUMENT_IDS) {
    if (!byId.has(id)) errors.push(`missing retained document ${id}`);
  }

  const rolesPresent = new Set([...byId.values()].map((row) => row.document_role));
  for (const role of [
    CORPUS_DOCUMENT_ROLES.AWARD_NOTICE,
    CORPUS_DOCUMENT_ROLES.BID_TAB,
    CORPUS_DOCUMENT_ROLES.PROPOSED_AGREEMENT,
    CORPUS_DOCUMENT_ROLES.SITE_SCHEDULE,
    CORPUS_DOCUMENT_ROLES.PERFORMANCE_EVALUATION,
  ]) {
    if (!rolesPresent.has(role)) errors.push(`missing corpus role ${role}`);
  }

  const mocsAgreement = byId.get("mocs-fcrc-packet-202411-proposed-agreement");
  if (mocsAgreement) {
    if (mocsAgreement.document_role !== CORPUS_DOCUMENT_ROLES.PROPOSED_AGREEMENT) {
      errors.push("MOCS agreement must remain proposed_agreement without admitted execution");
    }
    if (mocsAgreement.execution_evidence?.signature_present === true
      && mocsAgreement.execution_evidence?.effective_status_admitted === true) {
      errors.push("MOCS agreement must not admit signature and effective status together without independent evidence");
    }
  }

  const audit = byId.get("comptroller-docgo-audit-20248801671");
  if (audit) {
    const link = audit.identity_links.find((entry) => (
      entry.contract_id === DOCGO_CONTRACT_ID
      && entry.matched_value === DOCGO_CONTRACT_NUMBER
    ));
    if (!link) errors.push("DocGo audit must link CT180620248801671 by contract number 20248801671");
    if (audit.document_role !== CORPUS_DOCUMENT_ROLES.PERFORMANCE_EVALUATION) {
      errors.push("DocGo audit must be classified as performance_evaluation");
    }
  }

  const notice = byId.get("city-record-notice-20240829105");
  if (notice) {
    const link = notice.identity_links.find((entry) => (
      entry.contract_id === BHRAGS_CONTRACT_ID
      && entry.relation === "exact_contract_id"
    ));
    if (!link) errors.push("BHRAGS notice must link CT107120258801626 by exact contract id");
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Confirm the four fixed access contracts still carry dated role-specific
 * states, and that corpus documents attach only through exact identity.
 */
export function validateAccessStatesWithCorpus(accessDocument, corpusDocument) {
  const accessCoverage = validateFixedContractAccessCoverage(accessDocument);
  if (!accessCoverage.ok) {
    return { ok: false, errors: accessCoverage.errors };
  }
  const corpusCoverage = validateRealCorpusCoverage(corpusDocument);
  if (!corpusCoverage.ok) {
    return { ok: false, errors: corpusCoverage.errors };
  }

  const errors = [];
  const indexed = indexAccessObservations(accessDocument.rows);
  for (const contractId of FIXED_CONTRACT_IDS) {
    for (const role of REQUIRED_DOCUMENT_ROLES) {
      const observation = roleAccessForContract(indexed, contractId, role);
      if (!observation) {
        errors.push(`missing access state ${contractId}/${role}`);
        continue;
      }
      // Real public documents do not silently rewrite role access unless an
      // exact identity attachment exists for that same role.
      if (observation.access_state === ACCESS_STATES.PUBLIC_DOCUMENT) {
        const attachments = (corpusDocument.rows || [])
          .flatMap((row) => (row.identity_links || []).map((link) => ({ row, link })))
          .filter(({ link }) => link.contract_id === contractId);
        if (!attachments.length) {
          errors.push(`public_document access without exact corpus identity for ${contractId}/${role}`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export {
  ACCESS_STATES,
  ACCESS_DOCUMENT_ROLES,
  FIXED_CONTRACT_IDS,
  REQUIRED_DOCUMENT_ROLES,
};
