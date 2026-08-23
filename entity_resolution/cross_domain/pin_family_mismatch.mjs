/**
 * PIN-family Checkbook ↔ PASSPort identity classification.
 *
 * A crosswalk row that shares a PIN/EPIN but not an FMS contract-id string is
 * not automatically the same registered contract. Most of those pairs are
 * resolvable by rule (requirement-contract vs master-agreement, successor
 * term). Only distinct-vendor shared-PIN pairs stay on a human queue.
 */

import { sameVendorStem, vendorStem } from "../normalizers/vendor_stem.mjs";

export const PIN_FAMILY_REVIEW_VERSION = "pin_family_mismatch_review_v1";
export const PIN_FAMILY_IDENTITY_CLASSES = Object.freeze([
  "same_contract",
  "related_instrument",
  "needs_review",
]);
export const PIN_FAMILY_RULES = Object.freeze([
  "fms_document_type_mismatch",
  "successor_term",
  "later_term_renewal",
]);
export const PIN_FAMILY_DECISIONS = Object.freeze(["same_contract", "related_instrument"]);

/** Longest-first FMS document codes used in Checkbook compact ids and PASSPort hyphenated ids. */
export const FMS_DOCUMENT_TYPES = Object.freeze([
  "MMA1",
  "CTA1",
  "POD1",
  "POC1",
  "PCC1",
  "RCT1",
  "CT1",
  "MA1",
  "DO1",
  "PO1",
]);

const SUCCESSOR_GAP_DAYS = 3;

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

export function moneyNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function normalizeCivicDate(value) {
  const text = clean(value);
  if (!text) return null;
  const mdy = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2, "0")}-${mdy[2].padStart(2, "0")}`;
  const iso = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return iso ? iso[1] : null;
}

export function daysBetween(from, to) {
  const a = normalizeCivicDate(from);
  const b = normalizeCivicDate(to);
  if (!a || !b) return null;
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}

export function amountRatio(left, right) {
  const a = moneyNumber(left);
  const b = moneyNumber(right);
  if (a == null || b == null) return null;
  const hi = Math.max(Math.abs(a), Math.abs(b));
  if (hi === 0) return 1;
  return Math.min(Math.abs(a), Math.abs(b)) / hi;
}

/**
 * Parse NYC FMS document type + agency from a Checkbook compact id or a
 * PASSPort hyphenated id. Unknown shapes fail closed.
 */
export function parseFmsContractId(contractId) {
  const raw = clean(contractId);
  if (!raw) return { type: null, agency: null, form: "empty" };
  const hyphen = raw.match(/^([A-Za-z]+[0-9]?)-(\d{3})-/);
  if (hyphen) {
    return { type: hyphen[1].toUpperCase(), agency: hyphen[2], form: "hyphen" };
  }
  const compact = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  for (const type of FMS_DOCUMENT_TYPES) {
    if (!compact.startsWith(type)) continue;
    const agency = compact.slice(type.length, type.length + 3);
    if (/^\d{3}$/.test(agency)) return { type, agency, form: "compact" };
  }
  return { type: null, agency: null, form: "unknown" };
}

export function pinFamilyPairId(checkbookContractId, passportContractId) {
  return `pf:${clean(checkbookContractId)}::${clean(passportContractId)}`;
}

export function isPinFamilyIdMismatch(row = {}) {
  if (row.status !== "matched") return false;
  if (row.join_method === "contract_id_exact") return false;
  const checkbookId = clean(row.checkbook_contract_id);
  const passportId = clean(row.passport_contract_id);
  return Boolean(checkbookId && passportId && checkbookId !== passportId);
}

/** Public same-contract corroboration admits exact FMS contract-id joins only. */
export function isPublicSameContractCrosswalkRow(row = {}) {
  return row.status === "matched" && row.join_method === "contract_id_exact";
}

function indexByContractId(rows, field = "contract_id") {
  const map = new Map();
  for (const row of rows || []) {
    const id = clean(row?.[field] || row?.prime_contract_id || row?.ctr_id);
    if (id && !map.has(id)) map.set(id, row);
  }
  return map;
}

function indexPassport(rows) {
  const byId = indexByContractId(rows, "contract_id");
  const byEpin = new Map();
  for (const row of rows || []) {
    const epin = clean(row?.epin);
    if (epin && !byEpin.has(epin)) byEpin.set(epin, row);
  }
  return { byId, byEpin };
}

export function gatherPinFamilyEvidence(crosswalkRow, spine = {}) {
  const checkbookRows = spine.checkbookContracts || spine.checkbook_contracts || [];
  const passportRows = spine.passportContracts || spine.passport_contracts || [];
  const checkbook = indexByContractId(checkbookRows).get(clean(crosswalkRow.checkbook_contract_id)) || {};
  const passportIndex = indexPassport(passportRows);
  const passport = passportIndex.byId.get(clean(crosswalkRow.passport_contract_id))
    || passportIndex.byEpin.get(clean(crosswalkRow.passport_epin))
    || {};

  const checkbookAmount = moneyNumber(checkbook.current ?? checkbook.original);
  const passportAmount = moneyNumber(passport.current_amount ?? passport.award_amount);
  const checkbookStart = normalizeCivicDate(checkbook.start);
  const checkbookEnd = normalizeCivicDate(checkbook.end);
  const passportStart = normalizeCivicDate(passport.start_date);
  const passportEnd = normalizeCivicDate(passport.end_date);
  const checkbookFms = parseFmsContractId(crosswalkRow.checkbook_contract_id);
  const passportFms = parseFmsContractId(crosswalkRow.passport_contract_id);

  return {
    pin: clean(crosswalkRow.checkbook_pin) || null,
    epin: clean(crosswalkRow.passport_epin) || null,
    join_method: crosswalkRow.join_method || null,
    checkbook: {
      contract_id: clean(crosswalkRow.checkbook_contract_id) || null,
      subject_ref: clean(crosswalkRow.checkbook_subject_ref) || null,
      source_record_id: clean(crosswalkRow.checkbook_source_record_id) || null,
      vendor: clean(checkbook.prime_vendor || checkbook.vendor) || null,
      agency: clean(checkbook.agency) || null,
      current_amount: checkbookAmount,
      original_amount: moneyNumber(checkbook.original),
      spent_amount: moneyNumber(checkbook.spent),
      start: checkbookStart,
      end: checkbookEnd,
      registered: normalizeCivicDate(checkbook.registered),
      status: clean(checkbook.status) || null,
      fms: checkbookFms,
    },
    passport: {
      contract_id: clean(crosswalkRow.passport_contract_id) || null,
      subject_ref: clean(crosswalkRow.passport_subject_ref) || null,
      source_record_id: clean(crosswalkRow.passport_source_record_id) || null,
      vendor: clean(passport.vendor) || null,
      agency: clean(passport.agency) || null,
      current_amount: passportAmount,
      award_amount: moneyNumber(passport.award_amount),
      paid_amount: moneyNumber(passport.paid_amount),
      start: passportStart,
      end: passportEnd,
      registered: normalizeCivicDate(passport.registration_date),
      status: clean(passport.status) || null,
      title: clean(passport.title) || null,
      procurement_method: clean(passport.procurement_method) || null,
      fms: passportFms,
    },
    vendor_same: sameVendorStem(
      checkbook.prime_vendor || checkbook.vendor,
      passport.vendor,
    ),
    vendor_stems: {
      checkbook: vendorStem(checkbook.prime_vendor || checkbook.vendor) || null,
      passport: vendorStem(passport.vendor) || null,
    },
    amount_ratio: amountRatio(checkbookAmount, passportAmount),
    term_gap_days: daysBetween(passportEnd, checkbookStart),
  };
}

function documentTypesDiffer(evidence) {
  const left = evidence.checkbook?.fms?.type;
  const right = evidence.passport?.fms?.type;
  return Boolean(left && right && left !== right);
}

function successorTerm(evidence) {
  const gap = evidence.term_gap_days;
  return evidence.vendor_same
    && !documentTypesDiffer(evidence)
    && gap != null
    && gap >= 0
    && gap <= SUCCESSOR_GAP_DAYS;
}

function laterTermRenewal(evidence) {
  const gap = evidence.term_gap_days;
  return evidence.vendor_same
    && !documentTypesDiffer(evidence)
    && gap != null
    && gap > SUCCESSOR_GAP_DAYS;
}

export function classifyPinFamilyEvidence(evidence = {}) {
  if (documentTypesDiffer(evidence)) {
    const fromType = evidence.checkbook.fms.type;
    const toType = evidence.passport.fms.type;
    return {
      identity_class: "related_instrument",
      label_source: "rule",
      rule: "fms_document_type_mismatch",
      rationale: `Checkbook ${fromType} and PASSPort ${toType} are different FMS document types sharing a PIN (requirement contract / task order vs master agreement, or another instrument pair). They are related, not the same registered contract.`,
    };
  }
  if (successorTerm(evidence)) {
    return {
      identity_class: "related_instrument",
      label_source: "rule",
      rule: "successor_term",
      rationale: `Same vendor and same FMS document type, but Checkbook's term starts ${evidence.term_gap_days} day(s) after the PASSPort term ends. That is a newly registered successor instrument, not the same contract id.`,
    };
  }
  if (laterTermRenewal(evidence)) {
    return {
      identity_class: "related_instrument",
      label_source: "rule",
      rule: "later_term_renewal",
      rationale: `Same vendor and same FMS document type, with Checkbook starting ${evidence.term_gap_days} days after the PASSPort end date. Distinct FMS serials make this a later-term renewal, not the same contract.`,
    };
  }
  const why = evidence.vendor_same
    ? "Same vendor and overlapping or incomplete term evidence with distinct FMS contract ids — a person has to say whether this is one instrument or two."
    : "The two publishers name different vendors on the same PIN. That can be a multi-award sibling, a firm rename, or a PIN collision; it is not mechanically the same contract.";
  return {
    identity_class: "needs_review",
    label_source: "human",
    rule: null,
    rationale: why,
  };
}

export function classifyPinFamilyRow(crosswalkRow, spine = {}) {
  const evidence = gatherPinFamilyEvidence(crosswalkRow, spine);
  const classification = classifyPinFamilyEvidence(evidence);
  return {
    pair_id: pinFamilyPairId(evidence.checkbook.contract_id, evidence.passport.contract_id),
    ...classification,
    evidence,
  };
}

export function buildPinFamilyReview(input = {}) {
  const crosswalkRows = input.crosswalkRows
    || input.crosswalk?.rows
    || [];
  const spine = {
    checkbookContracts: input.checkbookContracts || [],
    passportContracts: input.passportContracts || [],
  };
  const pairs = crosswalkRows
    .filter(isPinFamilyIdMismatch)
    .map((row) => classifyPinFamilyRow(row, spine))
    .sort((a, b) => a.pair_id.localeCompare(b.pair_id));

  const byClass = { same_contract: 0, related_instrument: 0, needs_review: 0 };
  const byRule = {};
  for (const pair of pairs) {
    byClass[pair.identity_class] = (byClass[pair.identity_class] || 0) + 1;
    if (pair.rule) byRule[pair.rule] = (byRule[pair.rule] || 0) + 1;
  }

  return {
    schema_version: 1,
    version: PIN_FAMILY_REVIEW_VERSION,
    title: "PIN-family Checkbook ↔ PASSPort contract-id mismatches",
    observed_on: input.observed_on || null,
    generated_at: input.generated_at || null,
    sources: {
      crosswalk: "site/data/passport_checkbook_crosswalk.json",
      spine: "site/data/procurement_spine_sources.json",
    },
    metrics: {
      pin_family_id_mismatches: pairs.length,
      auto_related_instrument: byClass.related_instrument,
      needs_review: byClass.needs_review,
      auto_same_contract: byClass.same_contract,
      by_rule: byRule,
      public_same_contract_rule: "contract_id_exact only; PIN-family id mismatches are not sold as the same contract",
    },
    pairs,
  };
}

export function reviewQueuePairs(doc, { includeAuto = false } = {}) {
  const pairs = Array.isArray(doc?.pairs) ? doc.pairs : [];
  if (includeAuto) return pairs;
  return pairs.filter((pair) => pair.identity_class === "needs_review");
}

export function findReviewPair(doc, pairId) {
  const wanted = clean(pairId);
  return (doc?.pairs || []).find((pair) => pair.pair_id === wanted) || null;
}
