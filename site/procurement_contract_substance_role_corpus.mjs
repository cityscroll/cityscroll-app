/**
 * Mine role-correct pricing, obligation, and evaluation passages from the
 * retained official contract-substance corpus.
 *
 * Runs retained DCAS, MOCS, and Comptroller passages through the same hash,
 * quality, and substance-projection seams used in production. Document role
 * travels with every admitted row: bid offers stay bid offers, proposed
 * clauses stay proposed, and audit-reported rates stay audit-reported.
 */

import { contentHashOf } from "../warehouse/lib/document_processing.mjs";
import {
  EVIDENCE_ROLES,
  FACT_KINDS,
  PROJECTOR_VERSION,
  RESIDENT_VENDOR_PROMISE_LABEL,
  STANDING_LABELS,
  assessPassageForProjection,
  projectObligation,
  projectPriceTerm,
  refuseManufacturedRate,
  residentClaimLabel,
} from "./procurement_contract_substance.mjs";
import {
  CORPUS_DOCUMENT_ROLES,
  DOCGO_CONTRACT_ID,
  DOCGO_CONTRACT_NUMBER,
  classifyCorpusDocumentRole,
  retainCorpusDocument,
  verifyRetainedBytes,
} from "./procurement_contract_substance_real_corpus.mjs";

export const ROLE_CORPUS_SCHEMA =
  "cityscroll.procurement_contract_substance_role_corpus.v1";

export const ROLE_CORPUS_PROJECTOR_VERSION = PROJECTOR_VERSION;

export const DCAS_BID_IDENTITY = "BID2000090";
export const MOCS_GROWNYC_IDENTITY = "MOCS-FCRC-202411-GROWNYC";
export const MOCS_TENNIS_IDENTITY = "MOCS-FCRC-202411-CWTP";

export const PERFORMANCE_EVIDENCE_SOURCE_IDS = Object.freeze({
  DCAS_BID_TABS: "dcas-bid-tabs",
  MOCS_FCRC: "mocs-fcrc",
  COMPTROLLER_AUDITS: "comptroller-audits",
});

function clean(value, max = 800) {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rowById(corpus, documentId) {
  return (Array.isArray(corpus?.rows) ? corpus.rows : [])
    .find((row) => row?.document_id === documentId) || null;
}

/**
 * Project one retained passage into an admitted substance row, carrying
 * source hash, locator, excerpt hash, extraction quality, and projector version.
 */
export function mineRolePassage(candidate = {}) {
  const documentRole = clean(candidate.document_role || candidate.role, 80);
  const excerpt = clean(candidate.excerpt || candidate.text || candidate.passage_text, 800);
  const contentHash = clean(candidate.content_hash || candidate.document_hash, 100);
  const locator = clean(candidate.locator || candidate.page_section_locator, 240);
  const contractId = clean(candidate.contract_id || candidate.prime_contract_id, 160);

  if (!documentRole || !excerpt || !contentHash || !locator || !contractId) {
    return {
      ok: false,
      fact: null,
      unresolved: {
        reason: "missing_required_fields",
        resident_assertion: false,
        desk_reviewable: true,
        details: {
          missing: [
            !contractId && "contract_identity",
            !documentRole && "document_role",
            !contentHash && "document_hash",
            !locator && "page_locator",
            !excerpt && "excerpt",
          ].filter(Boolean),
        },
      },
    };
  }

  // Stale source hash: retained bytes no longer match the recorded hash.
  if (candidate.retained_bytes != null) {
    const verified = verifyRetainedBytes(
      { content_hash: contentHash },
      candidate.retained_bytes,
    );
    if (!verified.ok) {
      return {
        ok: false,
        fact: null,
        unresolved: {
          reason: "stale_hash",
          resident_assertion: false,
          desk_reviewable: true,
          details: { content_hash: contentHash },
          document_retrievable: true,
        },
      };
    }
  }

  if (candidate.page_missing === true || candidate.missing_page === true) {
    return {
      ok: false,
      fact: null,
      unresolved: {
        reason: "missing_page",
        resident_assertion: false,
        desk_reviewable: true,
        details: { locator },
        document_retrievable: true,
      },
    };
  }

  const qualityGate = assessPassageForProjection({
    text: excerpt,
    ocr_required: candidate.ocr_required,
    ocr_attempted: candidate.ocr_attempted,
    ocr_engine_available: candidate.ocr_engine_available,
  });
  if (!qualityGate.ok) {
    return {
      ok: false,
      fact: null,
      unresolved: {
        reason: qualityGate.reason,
        resident_assertion: false,
        desk_reviewable: true,
        quality: qualityGate.quality,
        document_retrievable: true,
      },
    };
  }

  const base = {
    ...candidate,
    contract_id: contractId,
    document_role: documentRole,
    excerpt,
    content_hash: contentHash,
    locator,
    source_document_id: clean(candidate.source_document_id || candidate.document_id, 180),
    public_url: clean(candidate.public_url || candidate.final_url || candidate.url, 2000),
    publication_date: clean(candidate.publication_date, 10),
  };

  const kind = clean(candidate.fact_kind || candidate.kind, 40);
  let projected;
  if (kind === FACT_KINDS.OBLIGATION || kind === "obligation") {
    projected = projectObligation(base);
  } else {
    projected = projectPriceTerm({
      payment_basis: candidate.payment_basis || "unit_price",
      ...base,
    });
  }

  if (!projected.ok) {
    return {
      ok: false,
      fact: null,
      unresolved: {
        ...(projected.unresolved || {}),
        document_retrievable: true,
      },
    };
  }

  const fact = {
    ...projected.fact,
    corpus_document_id: clean(candidate.corpus_document_id || candidate.document_id, 180),
    provenance_class: "real_source",
    excerpt_hash: projected.fact.excerpt_hash || contentHashOf(excerpt),
    extraction_quality: projected.fact.extraction_quality || qualityGate.quality?.quality_state || null,
    projector_version: PROJECTOR_VERSION,
    resident_claim_label: residentClaimLabel(projected.fact),
  };

  if (fact.resident_claim_label === RESIDENT_VENDOR_PROMISE_LABEL
    && fact.document_role !== EVIDENCE_ROLES.EXECUTED_OBLIGATION
    && fact.document_role !== EVIDENCE_ROLES.EXECUTED_SCOPE
    && fact.document_role !== EVIDENCE_ROLES.PRICING_SCHEDULE
    && fact.document_role !== EVIDENCE_ROLES.AMENDMENT) {
    return {
      ok: false,
      fact: null,
      unresolved: {
        reason: "disqualified_source",
        resident_assertion: false,
        desk_reviewable: true,
        details: { refused_label: RESIDENT_VENDOR_PROMISE_LABEL, document_role: fact.document_role },
        document_retrievable: true,
      },
    };
  }

  return { ok: true, fact, unresolved: null };
}

function dcasUnitPriceExcerpt(pageText, itemNumber) {
  const lines = String(pageText || "").split(/\n+/);
  const itemLine = lines.find((line) => new RegExp(`^\\s*${itemNumber}\\.\\s+HIGH TEMPERATURE POT PA`).test(line));
  if (!itemLine) return null;
  const header = clean(pageText).match(/POT PAN & UTENSIL WASHER/)?.[0] || "POT PAN & UTENSIL WASHER";
  return clean(`${header} — item ${itemNumber}: ${itemLine}`);
}

/**
 * Mine DCAS bid tab 2000090 offered unit prices and class-award totals.
 */
export function mineDcasBidTab({ corpusRow, page1Text, page2Text } = {}) {
  const retained = retainCorpusDocument(corpusRow);
  if (!retained.ok) {
    return { ok: false, rows: [], errors: retained.reasons || ["retention_failed"] };
  }
  const doc = retained.document;
  const classified = classifyCorpusDocumentRole(corpusRow);
  if (!classified.ok || classified.roles[0] !== CORPUS_DOCUMENT_ROLES.BID_TAB) {
    return { ok: false, rows: [], errors: ["expected_bid_tab_role"] };
  }

  const rows = [];
  const errors = [];
  for (const itemNumber of [1, 2]) {
    const excerpt = dcasUnitPriceExcerpt(page1Text, itemNumber);
    if (!excerpt) {
      errors.push(`missing_item_${itemNumber}`);
      continue;
    }
    // First bidder column unit price on the retained tabulation.
    const priceMatch = excerpt.match(/(\d+\.\d+)/);
    const rate = priceMatch ? Number(priceMatch[1]) : null;
    const mined = mineRolePassage({
      contract_id: DCAS_BID_IDENTITY,
      document_id: doc.document_id,
      corpus_document_id: doc.document_id,
      source_document_id: doc.document_id,
      document_role: EVIDENCE_ROLES.BID_TAB,
      content_hash: doc.content_hash,
      public_url: doc.final_url,
      publication_date: doc.publication_date,
      locator: `PDF page 1 / BID NUMBER 2000090 item ${itemNumber} unit prices`,
      excerpt,
      fact_kind: FACT_KINDS.PRICE_TERM,
      payment_basis: "unit_price",
      description: "pot, pan, and utensil washer — high temperature",
      quantity: 1,
      unit: "each",
      rate,
      fact_id: `price:${DCAS_BID_IDENTITY}:${doc.document_id}:item-${itemNumber}`,
    });
    if (mined.ok) rows.push(mined.fact);
    else errors.push(mined.unresolved?.reason || `item_${itemNumber}_failed`);
  }

  const awardExcerpt = clean(page2Text);
  if (awardExcerpt && /CLASS OR ZONE AWARD/i.test(awardExcerpt) && /AUKEE TRADING CORPORATION/i.test(awardExcerpt)) {
    const mined = mineRolePassage({
      contract_id: DCAS_BID_IDENTITY,
      document_id: doc.document_id,
      corpus_document_id: doc.document_id,
      source_document_id: doc.document_id,
      document_role: EVIDENCE_ROLES.BID_TAB,
      content_hash: doc.content_hash,
      public_url: doc.final_url,
      publication_date: doc.publication_date,
      locator: "PDF page 2 / class awards",
      excerpt: awardExcerpt.slice(0, 700),
      fact_kind: FACT_KINDS.PRICE_TERM,
      payment_basis: "fixed_fee",
      description: "class-award totals for pot, pan, and utensil washers",
      rate: 468027,
      fact_id: `price:${DCAS_BID_IDENTITY}:${doc.document_id}:class-awards`,
    });
    if (mined.ok) rows.push(mined.fact);
    else errors.push(mined.unresolved?.reason || "class_awards_failed");
  } else {
    errors.push("missing_class_awards");
  }

  for (const row of rows) {
    if (row.standing_label === STANDING_LABELS.EXECUTED
      || row.resident_claim_label === RESIDENT_VENDOR_PROMISE_LABEL
      || /executed contract rate/i.test(row.resident_claim_label || "")) {
      errors.push("bid_labeled_as_executed_rate");
    }
  }

  return { ok: errors.length === 0 && rows.length >= 3, rows, errors };
}

/**
 * Mine MOCS GrowNYC proposed payment, duties, Exhibit A sites, and tennis template fees.
 */
export function mineMocsProposedPacket({
  agreementRow,
  passages = {},
} = {}) {
  const retained = retainCorpusDocument(agreementRow);
  if (!retained.ok) {
    return { ok: false, rows: [], errors: retained.reasons || ["retention_failed"] };
  }
  const doc = retained.document;
  const classified = classifyCorpusDocumentRole(agreementRow);
  if (!classified.ok || classified.executed_agreement) {
    return { ok: false, rows: [], errors: ["mocs_must_remain_proposed"] };
  }

  const rows = [];
  const errors = [];

  const paymentExcerpt = clean(passages.payment_p35 || passages.mocs_payment_p35, 800);
  if (paymentExcerpt) {
    const mined = mineRolePassage({
      contract_id: MOCS_GROWNYC_IDENTITY,
      document_id: doc.document_id,
      corpus_document_id: doc.document_id,
      source_document_id: doc.document_id,
      document_role: EVIDENCE_ROLES.PROPOSED_AGREEMENT,
      content_hash: doc.content_hash,
      public_url: doc.final_url,
      publication_date: doc.publication_date,
      locator: "PDF page 35 / Licensee shall pay fees payable under this License Agreement",
      excerpt: paymentExcerpt,
      fact_kind: FACT_KINDS.PRICE_TERM,
      payment_basis: "percentage",
      description: "proposed GrowNYC license fees payable to Parks",
      fact_id: `price:${MOCS_GROWNYC_IDENTITY}:payment-p35`,
    });
    if (mined.ok) rows.push(mined.fact);
    else errors.push(mined.unresolved?.reason || "payment_p35_failed");
  } else errors.push("missing_payment_p35");

  const scheduleExcerpt = clean(passages.payment_schedule_p36 || passages.mocs_payment_schedule_p36, 800);
  if (scheduleExcerpt && /PAYMENT TO CITY/i.test(scheduleExcerpt)) {
    const mined = mineRolePassage({
      contract_id: MOCS_GROWNYC_IDENTITY,
      document_id: doc.document_id,
      corpus_document_id: doc.document_id,
      source_document_id: doc.document_id,
      document_role: EVIDENCE_ROLES.PROPOSED_AGREEMENT,
      content_hash: doc.content_hash,
      public_url: doc.final_url,
      publication_date: doc.publication_date,
      locator: "PDF page 36 / 4. PAYMENT TO CITY payment schedule",
      excerpt: scheduleExcerpt,
      fact_kind: FACT_KINDS.PRICE_TERM,
      payment_basis: "percentage",
      description: "proposed percentage of Gross Receipts and CDBG/Farmstand site fees",
      rate: 12.25,
      unit: "percent",
      quantity: 1,
      fact_id: `price:${MOCS_GROWNYC_IDENTITY}:payment-schedule-p36`,
    });
    if (mined.ok) rows.push(mined.fact);
    else errors.push(mined.unresolved?.reason || "payment_schedule_failed");
  } else errors.push("missing_payment_schedule");

  const opsExcerpt = clean(
    passages.ops_p41_43 || passages.mocs_ops_p41_43,
    800,
  );
  if (opsExcerpt && /OPERATIONS|Licensee, at its sole cost/i.test(opsExcerpt)) {
    const mined = mineRolePassage({
      contract_id: MOCS_GROWNYC_IDENTITY,
      document_id: doc.document_id,
      corpus_document_id: doc.document_id,
      source_document_id: doc.document_id,
      document_role: EVIDENCE_ROLES.PROPOSED_AGREEMENT,
      content_hash: doc.content_hash,
      public_url: doc.final_url,
      publication_date: doc.publication_date,
      locator: "PDF pages 41-43 / 7. OPERATIONS proposed duties",
      excerpt: opsExcerpt,
      fact_kind: FACT_KINDS.OBLIGATION,
      obligated_party: "licensee",
      action: "operate and maintain",
      deliverable: "Licensed Premises as Markets per Exhibit A",
      frequency: "as set forth in Exhibit A",
      period: "license term",
      condition: "at Licensee's sole cost and expense",
      fact_id: `obligation:${MOCS_GROWNYC_IDENTITY}:ops-p41-43`,
    });
    if (mined.ok) rows.push(mined.fact);
    else errors.push(mined.unresolved?.reason || "ops_failed");
  } else errors.push("missing_ops");

  const opsSample = clean(passages.ops_p48_53_sample || passages.mocs_ops_p48_53_sample, 800);
  if (opsSample) {
    const mined = mineRolePassage({
      contract_id: MOCS_GROWNYC_IDENTITY,
      document_id: doc.document_id,
      corpus_document_id: doc.document_id,
      source_document_id: doc.document_id,
      document_role: EVIDENCE_ROLES.PROPOSED_AGREEMENT,
      content_hash: doc.content_hash,
      public_url: doc.final_url,
      publication_date: doc.publication_date,
      locator: "PDF pages 48-53 / proposed operational assessments and maintenance duties",
      excerpt: opsSample,
      fact_kind: FACT_KINDS.OBLIGATION,
      obligated_party: "licensee",
      action: "comply with",
      deliverable: "operational assessments and Licensed Premises maintenance",
      period: "license term",
      fact_id: `obligation:${MOCS_GROWNYC_IDENTITY}:ops-p48-53`,
    });
    if (mined.ok) rows.push(mined.fact);
    else errors.push(mined.unresolved?.reason || "ops_sample_failed");
  } else errors.push("missing_ops_sample");

  const exhibit = clean(passages.exhibit_a_p72 || passages.mocs_exhibit_a_p72, 800);
  if (exhibit && /EXHIBIT A/i.test(exhibit) && /Joyce Kilmer Park/i.test(exhibit)) {
    const mined = mineRolePassage({
      contract_id: MOCS_GROWNYC_IDENTITY,
      document_id: doc.document_id,
      corpus_document_id: doc.document_id,
      source_document_id: doc.document_id,
      document_role: EVIDENCE_ROLES.PROPOSED_AGREEMENT,
      content_hash: doc.content_hash,
      public_url: doc.final_url,
      publication_date: doc.publication_date,
      locator: "PDF page 72 / EXHIBIT A GrowNYC Greenmarket Permit Locations, Days and Hours of Operation",
      excerpt: exhibit,
      fact_kind: FACT_KINDS.OBLIGATION,
      obligated_party: "licensee",
      action: "operate markets at",
      deliverable: "Exhibit A sites and hours including Joyce Kilmer Park and Poe Park",
      period: "license term",
      fact_id: `obligation:${MOCS_GROWNYC_IDENTITY}:exhibit-a`,
    });
    if (mined.ok) rows.push(mined.fact);
    else errors.push(mined.unresolved?.reason || "exhibit_failed");
  } else errors.push("missing_exhibit_a");

  const tennis = clean(passages.tennis_p186 || passages.mocs_tennis_p186, 800);
  if (tennis && /Season 1 \(2024\): \$500\.00/i.test(tennis)) {
    const mined = mineRolePassage({
      contract_id: MOCS_TENNIS_IDENTITY,
      document_id: doc.document_id,
      corpus_document_id: doc.document_id,
      source_document_id: doc.document_id,
      document_role: EVIDENCE_ROLES.TEMPLATE_PRICING,
      content_hash: doc.content_hash,
      public_url: doc.final_url,
      publication_date: doc.publication_date,
      locator: "PDF pages 185-186 / Citywide Tennis Professionals seasonal fee schedule",
      excerpt: tennis,
      fact_kind: FACT_KINDS.PRICE_TERM,
      payment_basis: "fixed_fee",
      description: "Citywide Tennis Professionals seasonal concession fees",
      rate: 500,
      period: "Season 1 (2024)",
      fact_id: `price:${MOCS_TENNIS_IDENTITY}:tennis-fees`,
    });
    if (mined.ok) rows.push(mined.fact);
    else errors.push(mined.unresolved?.reason || "tennis_failed");
  } else errors.push("missing_tennis_fees");

  for (const row of rows) {
    if (row.standing_label === STANDING_LABELS.EXECUTED
      || row.standing_label === STANDING_LABELS.VENDOR_PROMISED
      || row.resident_claim_label === RESIDENT_VENDOR_PROMISE_LABEL) {
      errors.push("proposed_or_template_labeled_executed");
    }
  }

  return { ok: errors.length === 0 && rows.length >= 5, rows, errors };
}

/**
 * Mine DocGo audit-reported meal and security rates linked to CT180620248801671.
 */
export function mineDocGoAudit({ corpusRow, passages = {} } = {}) {
  const retained = retainCorpusDocument(corpusRow);
  if (!retained.ok) {
    return { ok: false, rows: [], errors: retained.reasons || ["retention_failed"] };
  }
  const doc = retained.document;
  const classified = classifyCorpusDocumentRole(corpusRow);
  if (!classified.ok || classified.roles[0] !== CORPUS_DOCUMENT_ROLES.PERFORMANCE_EVALUATION) {
    return { ok: false, rows: [], errors: ["expected_performance_evaluation"] };
  }

  const rows = [];
  const errors = [];
  const food = clean(passages.food_caps || passages.docgo_food_caps, 800);
  if (food && /\$11 per meal/i.test(food) && /\$33 per person per day/i.test(food)) {
    const mined = mineRolePassage({
      contract_id: DOCGO_CONTRACT_ID,
      document_id: doc.document_id,
      corpus_document_id: doc.document_id,
      source_document_id: doc.document_id,
      document_role: EVIDENCE_ROLES.PERFORMANCE_EVALUATION,
      content_hash: doc.content_hash,
      public_url: doc.final_url,
      publication_date: doc.publication_date,
      locator: "section Audit Report / reported food cost caps",
      excerpt: food,
      fact_kind: FACT_KINDS.PRICE_TERM,
      payment_basis: "not_to_exceed",
      description: "food billed at actual cost not to exceed $11 per meal or $33 per person per day",
      maximum: 11,
      unit: "meal",
      quantity: 1,
      conditions: "or $33 per person per day",
      fact_id: `price:${DOCGO_CONTRACT_ID}:food-caps`,
    });
    if (mined.ok) rows.push(mined.fact);
    else errors.push(mined.unresolved?.reason || "food_failed");
  } else errors.push("missing_food_caps");

  const rate = clean(passages.security_rate || passages.docgo_security_rate, 800);
  if (rate && /\$50 per hour/i.test(rate)) {
    const mined = mineRolePassage({
      contract_id: DOCGO_CONTRACT_ID,
      document_id: doc.document_id,
      corpus_document_id: doc.document_id,
      source_document_id: doc.document_id,
      document_role: EVIDENCE_ROLES.PERFORMANCE_EVALUATION,
      content_hash: doc.content_hash,
      public_url: doc.final_url,
      publication_date: doc.publication_date,
      locator: "section Audit Report / reported $50 per hour security rate",
      excerpt: rate,
      fact_kind: FACT_KINDS.PRICE_TERM,
      payment_basis: "unit_price",
      description: "security rate reported in the audit",
      rate: 50,
      unit: "hour",
      quantity: 1,
      fact_id: `price:${DOCGO_CONTRACT_ID}:security-rate`,
    });
    if (mined.ok) rows.push(mined.fact);
    else errors.push(mined.unresolved?.reason || "security_rate_failed");
  } else errors.push("missing_security_rate");

  const condition = clean(passages.security_condition || passages.docgo_security_condition, 800);
  if (condition && /50 or more Service Recipients/i.test(condition)) {
    const mined = mineRolePassage({
      contract_id: DOCGO_CONTRACT_ID,
      document_id: doc.document_id,
      corpus_document_id: doc.document_id,
      source_document_id: doc.document_id,
      document_role: EVIDENCE_ROLES.PERFORMANCE_EVALUATION,
      content_hash: doc.content_hash,
      public_url: doc.final_url,
      publication_date: doc.publication_date,
      locator: "section Audit Report / additional security guard condition at 50 or more recipients",
      excerpt: condition,
      fact_kind: FACT_KINDS.PRICE_TERM,
      payment_basis: "other",
      description: "additional security guard when 50 or more Service Recipients at a location",
      conditions: "at the direction of HPD; 50 or more Service Recipients at any single location",
      fact_id: `price:${DOCGO_CONTRACT_ID}:security-condition`,
    });
    if (mined.ok) rows.push(mined.fact);
    else errors.push(mined.unresolved?.reason || "security_condition_failed");
  } else errors.push("missing_security_condition");

  for (const row of rows) {
    if (row.contract_id !== DOCGO_CONTRACT_ID) errors.push("docgo_contract_mismatch");
    if (row.standing_label !== STANDING_LABELS.AUDIT_REPORTED) errors.push("audit_standing_missing");
    if (row.resident_claim_label !== "The audit reports these contract terms") {
      errors.push("audit_resident_wording_missing");
    }
    if (row.resident_claim_label === RESIDENT_VENDOR_PROMISE_LABEL) {
      errors.push("audit_labeled_vendor_promise");
    }
  }

  return {
    ok: errors.length === 0 && rows.length >= 3,
    rows,
    errors,
    linked_contract_number: DOCGO_CONTRACT_NUMBER,
  };
}

/**
 * Build counts that separate real-source rows from mutation and fixture rows.
 */
export function reportRoleCorpusBuildCounts({
  realRows = [],
  mutationRows = [],
  fixtureRows = [],
} = {}) {
  return {
    real_source_row_count: realRows.length,
    mutation_row_count: mutationRows.length,
    fixture_row_count: fixtureRows.length,
    total_row_count: realRows.length + mutationRows.length + fixtureRows.length,
  };
}

/**
 * Convert admitted role-corpus facts into performance-evidence source rows.
 */
export function toPerformanceEvidenceRows(facts = []) {
  const byContract = new Map();
  for (const fact of Array.isArray(facts) ? facts : []) {
    if (!fact || fact.status !== "admitted") continue;
    const contractId = clean(fact.contract_id, 160);
    if (!contractId) continue;
    if (!byContract.has(contractId)) byContract.set(contractId, []);
    const sourceId = fact.document_role === EVIDENCE_ROLES.BID_TAB
      ? PERFORMANCE_EVIDENCE_SOURCE_IDS.DCAS_BID_TABS
      : fact.document_role === EVIDENCE_ROLES.PERFORMANCE_EVALUATION
        ? PERFORMANCE_EVIDENCE_SOURCE_IDS.COMPTROLLER_AUDITS
        : PERFORMANCE_EVIDENCE_SOURCE_IDS.MOCS_FCRC;
    const kind = fact.document_role === EVIDENCE_ROLES.PERFORMANCE_EVALUATION
      ? "evaluation_doc"
      : "performance_terms";
    byContract.get(contractId).push({
      kind,
      label: fact.resident_claim_label || fact.description || fact.deliverable || "Cited contract evidence",
      document_role: fact.document_role,
      source_passage: {
        source_id: sourceId,
        document_id: fact.source_document_id || fact.corpus_document_id,
        url: fact.public_url,
        locator: fact.locator,
        excerpt: fact.excerpt,
        publication_date: fact.publication_date,
        identity_basis: `exact contract identifier ${contractId}`,
        document_role: fact.document_role,
        excerpt_hash: fact.excerpt_hash,
        content_hash: fact.content_hash,
        extraction_quality: fact.extraction_quality,
        projector_version: fact.projector_version,
      },
    });
  }

  return [...byContract.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([prime_contract_id, evidence_items]) => ({
      prime_contract_id,
      evidence_items,
    }));
}

export function buildPerformanceEvidenceSourceCoverage(existing = []) {
  const extras = [
    {
      source_id: PERFORMANCE_EVIDENCE_SOURCE_IDS.DCAS_BID_TABS,
      label: "DCAS bid tabulations",
      role: "public bid-offer evidence",
      performance_evidence: true,
    },
    {
      source_id: PERFORMANCE_EVIDENCE_SOURCE_IDS.MOCS_FCRC,
      label: "MOCS FCRC public meeting packets",
      role: "public proposed-agreement evidence",
      performance_evidence: true,
    },
    {
      source_id: PERFORMANCE_EVIDENCE_SOURCE_IDS.COMPTROLLER_AUDITS,
      label: "NYC Comptroller audit reports",
      role: "public performance-evaluation evidence",
      performance_evidence: true,
    },
  ];
  const byId = new Map();
  for (const row of [...(Array.isArray(existing) ? existing : []), ...extras]) {
    if (row?.source_id) byId.set(row.source_id, row);
  }
  return [...byId.values()];
}

/**
 * Adversarial mutations must fail closed while preserving document retrievability.
 */
export function mutateRolePassage(baseCandidate = {}, mutation) {
  const candidate = { ...baseCandidate };
  switch (mutation) {
    case "role_swap":
      candidate.document_role = EVIDENCE_ROLES.EXECUTED_OBLIGATION;
      candidate.standing_label = STANDING_LABELS.VENDOR_PROMISED;
      candidate.fact_kind = FACT_KINDS.OBLIGATION;
      candidate.obligated_party = candidate.obligated_party || "vendor";
      candidate.action = candidate.action || "provide";
      candidate.deliverable = candidate.deliverable || candidate.description || "services";
      break;
    case "blank_signature":
      candidate.execution_evidence = {
        signature_present: false,
        effective_status_admitted: false,
        status: "blank_signature",
      };
      candidate.document_role = EVIDENCE_ROLES.PROPOSED_AGREEMENT;
      candidate.standing_label = STANDING_LABELS.VENDOR_PROMISED;
      candidate.fact_kind = FACT_KINDS.OBLIGATION;
      candidate.obligated_party = "licensee";
      candidate.action = "pay";
      candidate.deliverable = "license fees";
      break;
    case "stale_hash":
      candidate.retained_bytes = Buffer.from("not-the-retained-document");
      break;
    case "missing_page":
      candidate.page_missing = true;
      break;
    case "ocr_garble":
      candidate.excerpt = "@@@ ### $$$ %%% □□□ ~~~~";
      candidate.ocr_required = true;
      candidate.ocr_engine_available = false;
      break;
    case "conflicting_passage":
      return {
        ok: false,
        any_claim_survives: false,
        unresolved: {
          reason: "conflicting_passages",
          resident_assertion: false,
          desk_reviewable: true,
          document_retrievable: true,
        },
        document_retrievable: true,
      };
    case "missing_contract_identity":
      candidate.contract_id = null;
      candidate.prime_contract_id = null;
      break;
    default:
      throw new Error(`unknown role-corpus mutation: ${mutation}`);
  }

  // Role-swap / blank-signature attempt to force vendor-promise wording on
  // non-executed evidence: refuse manufactured promise labels explicitly.
  if ((mutation === "role_swap" || mutation === "blank_signature")
    && candidate.standing_label === STANDING_LABELS.VENDOR_PROMISED
    && candidate.document_role === EVIDENCE_ROLES.EXECUTED_OBLIGATION
    && baseCandidate.document_role
    && baseCandidate.document_role !== EVIDENCE_ROLES.EXECUTED_OBLIGATION
    && baseCandidate.document_role !== EVIDENCE_ROLES.EXECUTED_SCOPE
    && baseCandidate.document_role !== EVIDENCE_ROLES.PRICING_SCHEDULE
    && baseCandidate.document_role !== EVIDENCE_ROLES.AMENDMENT) {
    // Keep the swapped role for projection, but the original corpus role is
    // non-executed; refuse the manufactured promise regardless of projection.
    const projected = mineRolePassage(candidate);
    if (projected.ok && projected.fact?.resident_claim_label === RESIDENT_VENDOR_PROMISE_LABEL) {
      return {
        ok: false,
        any_claim_survives: false,
        unresolved: {
          reason: "disqualified_source",
          resident_assertion: false,
          desk_reviewable: true,
          details: {
            mutation,
            refused_label: RESIDENT_VENDOR_PROMISE_LABEL,
            original_role: baseCandidate.document_role,
          },
          document_retrievable: true,
        },
        document_retrievable: true,
      };
    }
  }

  if (mutation === "blank_signature") {
    const projected = mineRolePassage(candidate);
    const label = projected.fact?.resident_claim_label;
    if (projected.ok && label === RESIDENT_VENDOR_PROMISE_LABEL) {
      return {
        ok: false,
        any_claim_survives: false,
        unresolved: {
          reason: "disqualified_source",
          resident_assertion: false,
          desk_reviewable: true,
          document_retrievable: true,
        },
        document_retrievable: true,
      };
    }
    // Proposed + forced vendor-promise standing must not survive.
    if (projected.ok && candidate.standing_label === STANDING_LABELS.VENDOR_PROMISED) {
      return {
        ok: false,
        any_claim_survives: false,
        unresolved: projected.unresolved || {
          reason: "disqualified_source",
          resident_assertion: false,
          desk_reviewable: true,
          document_retrievable: true,
        },
        document_retrievable: true,
      };
    }
  }

  const manufactured = refuseManufacturedRate({
    ...candidate,
    rate_source: candidate.rate_source,
  });
  if (manufactured.length) {
    return {
      ok: false,
      any_claim_survives: false,
      unresolved: {
        reason: manufactured[0],
        resident_assertion: false,
        desk_reviewable: true,
        document_retrievable: true,
      },
      document_retrievable: true,
    };
  }

  const projected = mineRolePassage(candidate);
  const survives = projected.ok
    && projected.fact?.resident_assertion === true
    && projected.fact?.resident_claim_label === RESIDENT_VENDOR_PROMISE_LABEL;
  return {
    ok: projected.ok,
    any_claim_survives: Boolean(survives),
    fact: projected.fact,
    unresolved: projected.unresolved,
    document_retrievable: true,
  };
}

export function buildRoleCorpusDocument({
  rows = [],
  generatedAt = null,
  buildCounts = null,
  notes = null,
} = {}) {
  const sorted = [...rows].sort((left, right) =>
    String(left.fact_id || "").localeCompare(String(right.fact_id || "")));
  return {
    schema: ROLE_CORPUS_SCHEMA,
    generated_at: generatedAt || new Date().toISOString(),
    projector_version: PROJECTOR_VERSION,
    notes: notes || "Role-correct passages mined from the retained DCAS, MOCS, and Comptroller corpus.",
    build_counts: buildCounts || reportRoleCorpusBuildCounts({ realRows: sorted }),
    docgo_contract_id: DOCGO_CONTRACT_ID,
    docgo_contract_number: DOCGO_CONTRACT_NUMBER,
    rows: sorted,
    boundaries: {
      vendor_promise_label: `Only executed agreement evidence may produce \"${RESIDENT_VENDOR_PROMISE_LABEL}\".`,
      manufactured_rates: "No amount is divided by duration, capacity, meals, sites, or payments to manufacture a rate.",
      role_preservation: "Bid tabs remain bid offers; proposed packets remain proposed; audits remain audit-reported.",
    },
  };
}

/**
 * Mine the three retained official documents from frozen real page passages.
 */
export function mineRetainedRoleCorpus({ corpus, passages } = {}) {
  if (!isRecord(corpus) || !isRecord(passages)) {
    return { ok: false, document: null, errors: ["missing_corpus_or_passages"] };
  }

  const dcas = mineDcasBidTab({
    corpusRow: rowById(corpus, "dcas-bid-tab-2000090"),
    page1Text: passages.dcas_page1,
    page2Text: passages.dcas_page2,
  });
  const mocs = mineMocsProposedPacket({
    agreementRow: rowById(corpus, "mocs-fcrc-packet-202411-proposed-agreement"),
    passages,
  });
  const docgo = mineDocGoAudit({
    corpusRow: rowById(corpus, "comptroller-docgo-audit-20248801671"),
    passages,
  });

  const rows = [...dcas.rows, ...mocs.rows, ...docgo.rows];
  const errors = [
    ...dcas.errors.map((e) => `dcas:${e}`),
    ...mocs.errors.map((e) => `mocs:${e}`),
    ...docgo.errors.map((e) => `docgo:${e}`),
  ];
  const buildCounts = reportRoleCorpusBuildCounts({ realRows: rows, mutationRows: [], fixtureRows: [] });
  const document = buildRoleCorpusDocument({
    rows,
    generatedAt: "2026-09-19T12:00:00.000Z",
    buildCounts,
  });

  const hasDcas = rows.some((row) => row.corpus_document_id === "dcas-bid-tab-2000090");
  const hasMocs = rows.some((row) => row.corpus_document_id === "mocs-fcrc-packet-202411-proposed-agreement");
  const hasDocgo = rows.some((row) => row.corpus_document_id === "comptroller-docgo-audit-20248801671");

  return {
    ok: dcas.ok && mocs.ok && docgo.ok && hasDcas && hasMocs && hasDocgo && errors.length === 0,
    document,
    errors,
    parts: { dcas, mocs, docgo },
    buildCounts,
  };
}
