// Pure lifecycle assembly for the Checkbook contract lifecycle (PROC-001).
//
// Parses Checkbook NYC XML for pending contracts, registered contracts, and spending
// transactions, then assembles a bounded procurement timeline joining City Record
// stages (solicitation → intent-to-negotiate → vendor list → intent-to-award → award)
// to Checkbook pending → registered → payment, with explicit
// unmatched/ambiguous/unknown states.
//
// Intermediate City Record notice types (Intent to Award, Vendor List, Intent to
// Negotiate) are first-class timeline stages when the notice itself or a PIN-sibling
// related notice carries that type — they are no longer collapsed into solicitation.
//
// This is a pure module (no fetch, no env) so test/contract tests exercise the join
// logic directly. The worker module (worker/src/checkbook_lifecycle.mjs) wraps these
// functions with precompute + cache + endpoint.

import { usablePin, pinBase } from "./lineage.mjs";
import {
  CURRENT_SOLICITATIONS_SOURCE,
  joinSolicitationEnrichment,
  applySolicitationDetail,
  documentsStatusFor,
} from "./current_solicitations.mjs";
import {
  attachLifecycleCoherence,
  DATE_BASIS_PUBLICATION,
  DATE_BASIS_REGISTRATION,
  DATE_BASIS_RECEIVED,
  DATE_BASIS_PAYMENT,
  DATE_BASIS_EVENT,
  SOLICITATION_RECOVERY_SOURCES,
} from "./lifecycle_coherence.mjs";
import { linksFromLifecycle } from "./subject_registry.mjs";
import { attachAwardPrimeGoal } from "./award_prime_goal.mjs";

export { usablePin, pinBase };
export { CURRENT_SOLICITATIONS_SOURCE };

// ---------------------------------------------------------------------------
// XML parsing (regex-based, matching the pattern in checkbook.mjs / external_award.mjs)
// ---------------------------------------------------------------------------

function decodeXmlText(value) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return String(value || "").replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity) => {
    const lower = entity.toLowerCase();
    if (lower in named) return named[lower];
    const codePoint = lower.startsWith("#x")
      ? Number.parseInt(lower.slice(2), 16)
      : Number.parseInt(lower.slice(1), 10);
    try { return String.fromCodePoint(codePoint); } catch { return match; }
  });
}

function extractTag(xml, tag) {
  const m = String(xml || "").match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? decodeXmlText(m[1]).trim() : "";
}

function parseAmount(s) {
  const n = parseFloat(String(s || "").replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

// Parse a <transaction> block from the Contracts domain (pending or registered).
// vendor_record_type is retained so immutable observations can distinguish Prime
// Vendor amount rows from Sub Vendor / expense-category slices of the same
// prime_contract_id (see aggregateContractsById).
export function parseContractTransaction(txXml) {
  return {
    id: extractTag(txXml, "prime_contract_id"),
    vendor: extractTag(txXml, "prime_vendor"),
    agency: extractTag(txXml, "agency_name")
      || extractTag(txXml, "prime_contracting_agency"),
    pin: extractTag(txXml, "pin")
      || extractTag(txXml, "prime_contract_pin"),
    status: extractTag(txXml, "status"),
    vendorRecordType: extractTag(txXml, "vendor_record_type"),
    subVendor: extractTag(txXml, "sub_vendor"),
    current: parseAmount(extractTag(txXml, "prime_contract_current_amount")),
    original: parseAmount(extractTag(txXml, "prime_contract_original_amount")),
    spent: parseAmount(extractTag(txXml, "prime_vendor_spent_to_date")),
    start: extractTag(txXml, "prime_contract_start_date"),
    end: extractTag(txXml, "prime_contract_end_date"),
    registered: extractTag(txXml, "prime_contract_registration_date"),
    received: extractTag(txXml, "received_date"),
    mwbe: extractTag(txXml, "prime_vendor_mwbe_category"),
    duration: extractTag(txXml, "prime_contract_duration") || extractTag(txXml, "prime_contract_term"),
    subs: extractTag(txXml, "contract_includes_sub_vendors"),
  };
}

// Parse a <transaction> block from the Spending domain.
// Live Checkbook Spending XML uses payee_name / issue_date / document_id / agency
// (not spending_id / vendor_name / check_date). Keep legacy aliases for fixtures.
export function parseSpendingTransaction(txXml) {
  return {
    id: extractTag(txXml, "document_id")
      || extractTag(txXml, "spending_id")
      || extractTag(txXml, "transaction_id"),
    contractId: extractTag(txXml, "contract_id") || extractTag(txXml, "prime_contract_id"),
    vendor: extractTag(txXml, "payee_name")
      || extractTag(txXml, "vendor_name")
      || extractTag(txXml, "prime_vendor"),
    agency: extractTag(txXml, "agency") || extractTag(txXml, "agency_name"),
    pin: extractTag(txXml, "pin"),
    amount: parseAmount(extractTag(txXml, "check_amount") || extractTag(txXml, "amount")),
    date: extractTag(txXml, "issue_date")
      || extractTag(txXml, "check_date")
      || extractTag(txXml, "transaction_date"),
    year: extractTag(txXml, "fiscal_year"),
  };
}

// Extract all <transaction> blocks from a Contracts-domain response.
export function parseContractTransactions(xml) {
  const out = [];
  for (const m of String(xml || "").matchAll(/<transaction>([\s\S]*?)<\/transaction>/g)) {
    out.push(parseContractTransaction(m[1]));
  }
  return out;
}

// Extract all <transaction> blocks from a Spending-domain response.
export function parseSpendingTransactions(xml) {
  const out = [];
  for (const m of String(xml || "").matchAll(/<transaction>([\s\S]*?)<\/transaction>/g)) {
    out.push(parseSpendingTransaction(m[1]));
  }
  return out;
}

// Check whether a Checkbook response indicates success.
export function checkbookSuccess(xml) {
  const status = String(xml || "").match(/<status>[\s\S]*?<result>([^<]*)<\/result>/);
  return !!(status && status[1].trim() === "success");
}

// ---------------------------------------------------------------------------
// Contract-id aggregation (Checkbook row slicing)
// ---------------------------------------------------------------------------

// Checkbook's Contracts domain returns multiple <transaction> rows per
// prime_contract_id. Verified 2026-07-30 on PIN 07123E0076001 (CT107120248803393):
//   - one vendor_record_type="Prime Vendor" row carries the real
//     prime_contract_current_amount / original / spent_to_date
//   - sibling rows are vendor_record_type="Sub Vendor" slices (one per
//     subcontract); prime-side amounts are 0.00 and the real dollars live in
//     sub_contract_* fields
// Expense-category / fiscal-year facets can multiply rows the same way.
// Lifecycle identity is the prime contract id — collapse to one record per id
// before classifyStage so "Multiple contracts found" fires only on ≥2 distinct
// ids (a real case: one PIN covering multiple awards). Display amounts take
// the max across slices so the Prime Vendor row wins over $0 sub-slices.
function contractAmountScore(c) {
  return Math.max(
    Number(c && c.current) || 0,
    Number(c && c.original) || 0,
    Number(c && c.spent) || 0,
  );
}

function collapseContractSlices(id, rows) {
  const sorted = rows.slice().sort((a, b) => contractAmountScore(b) - contractAmountScore(a));
  const best = sorted[0] || { id };
  let current = 0;
  let original = 0;
  let spent = 0;
  for (const r of rows) {
    current = Math.max(current, Number(r.current) || 0);
    original = Math.max(original, Number(r.original) || 0);
    spent = Math.max(spent, Number(r.spent) || 0);
  }
  return {
    ...best,
    id,
    current,
    original,
    spent,
  };
}

// Collapse Contracts-domain rows to one entry per distinct prime_contract_id.
// Rows missing an id are kept as-is (each remains a distinct candidate).
// Spending transactions are NOT collapsed here — many payments per contract is normal.
export function aggregateContractsById(records) {
  if (!Array.isArray(records)) return [];
  if (records.length === 0) return [];
  const groups = new Map();
  const noId = [];
  for (const c of records) {
    const id = c && c.id != null && String(c.id).trim() ? String(c.id).trim() : "";
    if (!id) {
      noId.push(c);
      continue;
    }
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(c);
  }
  const out = [];
  for (const [id, rows] of groups) {
    out.push(collapseContractSlices(id, rows));
  }
  out.push(...noId);
  return out;
}

// ---------------------------------------------------------------------------
// Stage classification
// ---------------------------------------------------------------------------

export const STAGE_SOLICITATION = "solicitation";
/** City Record intermediate: Intent to Negotiate (between solicitation and award). */
export const STAGE_INTENT_TO_NEGOTIATE = "intent_to_negotiate";
/** City Record intermediate: Vendor List (between solicitation and award). */
export const STAGE_VENDOR_LIST = "vendor_list";
/** City Record intermediate: Intent to Award (high-volume ~700 modern notices). */
export const STAGE_INTENT_TO_AWARD = "intent_to_award";
export const STAGE_AWARD = "award";
export const STAGE_PENDING = "pending";
export const STAGE_REGISTERED = "registered";
export const STAGE_PAYMENT = "payment";

/** Cap individual payment rows stamped onto payment-stage detail (newest first). */
export const PAYMENT_ROWS_DETAIL_CAP = 12;

/**
 * Project Checkbook Spending transactions into public payment-row detail.
 * Newest issue_date first; preserves source-null as null (never invents payee/date).
 *
 * @param {Array<object>|null|undefined} spending
 * @param {{ limit?: number }} [opts]
 * @returns {Array<{ document_id: string|null, payee: string|null, amount: number|null, date: string|null, fiscal_year: string|null, contract_id: string|null }>}
 */
export function projectPaymentRows(spending, opts = {}) {
  const limit = Number.isFinite(Number(opts.limit))
    ? Math.max(0, Math.floor(Number(opts.limit)))
    : PAYMENT_ROWS_DETAIL_CAP;
  if (!Array.isArray(spending) || spending.length === 0 || limit === 0) return [];
  const sorted = spending.slice().sort((a, b) =>
    String(b?.date || "").localeCompare(String(a?.date || "")),
  );
  const out = [];
  for (const row of sorted) {
    if (!row || typeof row !== "object") continue;
    const amount = row.amount != null && Number.isFinite(Number(row.amount))
      ? Math.round(Number(row.amount) * 100) / 100
      : null;
    out.push({
      document_id: row.id != null && String(row.id).trim() ? String(row.id).trim() : null,
      payee: row.vendor != null && String(row.vendor).trim() ? String(row.vendor).trim() : null,
      amount,
      date: row.date != null && String(row.date).trim() ? String(row.date).trim() : null,
      fiscal_year: row.year != null && String(row.year).trim() ? String(row.year).trim() : null,
      contract_id: row.contractId != null && String(row.contractId).trim()
        ? String(row.contractId).trim()
        : null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Full money-chain succession order.
 * Intermediate City Record stages appear on the timeline only when matched
 * (this notice or a PIN-related notice); Checkbook stages always appear.
 */
export const STAGES = [
  STAGE_SOLICITATION,
  STAGE_INTENT_TO_NEGOTIATE,
  STAGE_VENDOR_LIST,
  STAGE_INTENT_TO_AWARD,
  STAGE_AWARD,
  STAGE_PENDING,
  STAGE_REGISTERED,
  STAGE_PAYMENT,
];

/**
 * Map City Record type_of_notice_description → money-chain stage key.
 * Unknown / non-procurement types return null (do not invent a stage).
 */
export const CITY_RECORD_TYPE_TO_STAGE = Object.freeze({
  Solicitation: STAGE_SOLICITATION,
  "Intent to Negotiate": STAGE_INTENT_TO_NEGOTIATE,
  "Vendor List": STAGE_VENDOR_LIST,
  "Intent to Award": STAGE_INTENT_TO_AWARD,
  Award: STAGE_AWARD,
});

/** Ordered City Record intermediate stages (between solicitation and award). */
export const INTERMEDIATE_CITY_RECORD_STAGES = Object.freeze([
  STAGE_INTENT_TO_NEGOTIATE,
  STAGE_VENDOR_LIST,
  STAGE_INTENT_TO_AWARD,
]);

/**
 * Resolve a City Record notice row to a money-chain stage key, or null.
 * @param {object} row
 * @returns {string|null}
 */
export function cityRecordStageForNotice(row) {
  const type = String(row?.type_of_notice_description || row?.type_of_notice || "").trim();
  return CITY_RECORD_TYPE_TO_STAGE[type] || null;
}

/**
 * Build a matched City Record stage entry from a notice row.
 * @param {string} stage
 * @param {object} row
 * @param {object} [extra] extra fields (documents_status, detail overrides)
 */
function cityRecordStageEntry(stage, row, extra = {}) {
  const r = row || {};
  const detail = {
    request_id: r.request_id || null,
    agency: r.agency_name || r.agency || null,
    title: r.short_title || null,
    pin: r.pin || null,
  };
  // Vendor + amount ride on Intent to Award and Award notices when published.
  if (stage === STAGE_AWARD || stage === STAGE_INTENT_TO_AWARD) {
    detail.vendor = r.vendor_name || null;
    detail.amount = r.contract_amount != null && r.contract_amount !== ""
      ? Number(r.contract_amount) || 0
      : null;
  }
  if (extra.detail && typeof extra.detail === "object") {
    Object.assign(detail, extra.detail);
  }
  const { detail: _d, ...rest } = extra;
  return stageEntry(stage, "matched", "city-record", {
    date: r.start_date || null,
    source_timestamp: r.start_date || null,
    date_basis: DATE_BASIS_PUBLICATION,
    detail,
    ...rest,
  });
}

/**
 * Pick the best notice for each City Record stage from the current notice + related
 * PIN-siblings. Prefer the focal notice when it owns the stage; otherwise earliest
 * start_date among related rows of that type.
 *
 * @param {object} noticeRow - focal City Record notice
 * @param {object[]} relatedNotices - other notices sharing the PIN (optional)
 * @returns {Map<string, object>} stage → notice row
 */
export function pickCityRecordStageNotices(noticeRow, relatedNotices = []) {
  const byStage = new Map();
  const candidates = [];
  if (noticeRow && (noticeRow.request_id || noticeRow.type_of_notice_description || noticeRow.type_of_notice)) {
    candidates.push(noticeRow);
  }
  for (const row of Array.isArray(relatedNotices) ? relatedNotices : []) {
    if (!row) continue;
    // Skip exact duplicate of the focal notice.
    if (noticeRow?.request_id && row.request_id && String(row.request_id) === String(noticeRow.request_id)) {
      continue;
    }
    candidates.push(row);
  }

  const focalId = noticeRow?.request_id != null ? String(noticeRow.request_id) : null;

  for (const row of candidates) {
    const stage = cityRecordStageForNotice(row);
    if (!stage) continue;
    const existing = byStage.get(stage);
    if (!existing) {
      byStage.set(stage, row);
      continue;
    }
    // Prefer the focal notice when it owns this stage.
    if (focalId && String(row.request_id) === focalId) {
      byStage.set(stage, row);
      continue;
    }
    if (focalId && String(existing.request_id) === focalId) continue;
    // Otherwise earliest publication date (stable chain order).
    const a = String(existing.start_date || "");
    const b = String(row.start_date || "");
    if (b && (!a || b < a)) byStage.set(stage, row);
  }
  return byStage;
}

// matched = exactly one record found
// unmatched = confirmed lookup, nothing found
// ambiguous = multiple records found, cannot auto-resolve
// unknown = could not complete the lookup (precompute-internal; public UI must not
//           surface this as a transient-error register — see lifecycle renderers)
// passed = earlier stage superseded because a later stage is on record
// not_applicable = stage cannot be joined (e.g. no PIN on the notice)
//
// Callers must pass already-aggregated contract lists (see aggregateContractsById).
// Raw Checkbook Contracts rows over-count identity when Sub Vendor slices share an id.
export function classifyStage(records) {
  if (!Array.isArray(records)) return "unknown";
  if (records.length === 0) return "unmatched";
  if (records.length === 1) return "matched";
  return "ambiguous";
}

function lookupStageStatus(lookupFlag, records) {
  if (lookupFlag === "skip" || lookupFlag === "none") return "not_applicable";
  if (lookupFlag === "error") return "unknown";
  return classifyStage(records);
}

// ---------------------------------------------------------------------------
// Amendment detection
// ---------------------------------------------------------------------------

// A registered contract where current_amount differs from original_amount signals
// an amendment (budget modification). Each amendment is an explicit lifecycle event
// so the reader sees the change, not just the final amount.
export function detectAmendments(registered) {
  if (!Array.isArray(registered)) return [];
  return registered
    .filter((c) => c.original > 0 && c.current > 0 && c.current !== c.original)
    .map((c) => ({
      contract_id: c.id,
      original_amount: c.original,
      current_amount: c.current,
      delta: c.current - c.original,
      date: c.registered || c.start || null,
    }));
}

// ---------------------------------------------------------------------------
// Timeline assembly
// ---------------------------------------------------------------------------

function stageEntry(stage, status, source, opts = {}) {
  return {
    stage,
    status,
    source,
    ...opts,
  };
}

// Assemble the full procurement lifecycle from City Record notice + Checkbook data
// + optional Current Solicitations (3khw-qi8f) package enrichment + related PIN notices.
//
// noticeRow: the City Record notice (request_id, agency_name, type_of_notice_description,
//            pin, start_date, short_title, contract_amount, vendor_name)
// pending: array of parsed Checkbook pending-contract records for this PIN
// registered: array of parsed Checkbook registered-contract records for this PIN
// spending: array of parsed Checkbook spending records for this PIN
// opts.pinStrategy: "exact" | "legacy-base" | "none"
// opts.lookupStatus: { pending/registered/spending: "ok"|"error"|"skip" }
// opts.currentSolicitation: { status: "ok"|"error", rows: raw Socrata rows[] }
// opts.relatedNotices: City Record PIN-siblings (Solicitation / Intent* / Vendor List / Award)
// opts.ocpAward: optional pre-joined OCP Recent Contract Awards side-car
//   (from worker/src/lib/ocp_awards.mjs). When omitted the side-car is absent until the
//   worker attaches it — cached lifecycles without ocp_award are treated as a miss.
//
// Returns a lifecycle object with an explicit timeline array, amendments, and ok flag.
// Stage succession: when a later stage is matched, earlier unmatched/unknown stages
// become "passed". Spending lookup failure is recovered from registered.spent_to_date
// so the public never sees a transient-error register when the join already has dollars.
export function assembleLifecycle(noticeRow, pending, registered, spending, opts = {}) {
  const r = noticeRow || {};
  const pinStrategy = opts.pinStrategy || "exact";
  const lookupStatus = opts.lookupStatus || {};
  // pinStrategy "none" is the explicit no-PIN path from computeLifecycle. Do not
  // re-derive from usablePin here — fixtures may use short PIN stubs with real stages.
  const noPin = pinStrategy === "none"
    || (lookupStatus.pending === "skip" && lookupStatus.registered === "skip" && lookupStatus.spending === "skip");

  // Current Solicitations enrichment (package documents / due date). Fail-soft:
  // missing opts → treat as unmatched (gap copy); status error → unknown.
  const cs = opts.currentSolicitation;
  let enrichment;
  if (!cs) {
    enrichment = { status: "unmatched", match: null, candidates: [], basis: null };
  } else if (cs.status === "error") {
    enrichment = { status: "unknown", match: null, candidates: null, basis: null };
  } else {
    enrichment = joinSolicitationEnrichment(r, cs.rows || []);
  }
  const docsStatus = documentsStatusFor(enrichment);

  // --- City Record stages (solicitation + intermediates + award) ---
  // Reconstruct the publisher's notice typology as distinct timeline stages.
  // Related PIN-siblings (opts.relatedNotices) fill intermediate stages so a
  // solicitation notice can show a later Intent to Award on the same chain.
  // Matched-only: do not invent empty intermediate chips for every notice.
  const stageNotices = pickCityRecordStageNotices(r, opts.relatedNotices || []);
  const timeline = [];

  // Solicitation: prefer a City Record Solicitation row; else Current Solicitations
  // package join on non-solicitation notices (award / intent) — never invent empty.
  if (stageNotices.has(STAGE_SOLICITATION)) {
    const solRow = stageNotices.get(STAGE_SOLICITATION);
    const detail = applySolicitationDetail({
      request_id: solRow.request_id,
      agency: solRow.agency_name || solRow.agency,
      title: solRow.short_title || null,
      pin: solRow.pin || r.pin || null,
    }, enrichment);
    timeline.push(stageEntry(STAGE_SOLICITATION, "matched", "city-record", {
      date: solRow.start_date || null,
      source_timestamp: solRow.start_date || null,
      date_basis: DATE_BASIS_PUBLICATION,
      documents_status: docsStatus,
      detail,
    }));
  } else if (enrichment.status === "matched" && enrichment.match) {
    // Non-solicitation notice with a linked solicitation package from Current Solicitations.
    const m = enrichment.match;
    const detail = applySolicitationDetail({
      request_id: m.request_id,
      agency: m.agency_name,
      title: m.short_title || null,
      pin: m.pin || r.pin || null,
    }, enrichment);
    timeline.push(stageEntry(STAGE_SOLICITATION, "matched", CURRENT_SOLICITATIONS_SOURCE, {
      date: m.start_date || null,
      source_timestamp: m.start_date || null,
      date_basis: DATE_BASIS_EVENT,
      documents_status: docsStatus,
      detail,
    }));
  }

  // Intermediate City Record stages (Intent to Negotiate → Vendor List → Intent to Award).
  for (const stage of INTERMEDIATE_CITY_RECORD_STAGES) {
    if (!stageNotices.has(stage)) continue;
    timeline.push(cityRecordStageEntry(stage, stageNotices.get(stage)));
  }

  // Award stage when an Award notice is on the chain.
  if (stageNotices.has(STAGE_AWARD)) {
    timeline.push(cityRecordStageEntry(STAGE_AWARD, stageNotices.get(STAGE_AWARD)));
  }

  // No PIN → Checkbook stages cannot be joined. Mark not_applicable (not "unknown"/
  // transient error) so the renderer collapses them into the single no-PIN note.
  if (noPin) {
    for (const stage of [STAGE_PENDING, STAGE_REGISTERED, STAGE_PAYMENT]) {
      const source = stage === STAGE_PAYMENT ? "checkbook-spending" : "checkbook-contracts";
      timeline.push(stageEntry(stage, "not_applicable", source, {
        date: null, source_timestamp: null, detail: null,
      }));
    }
    const partial = {
      pin: null,
      pin_strategy: "none",
      timeline,
      amendments: [],
      ok: true,
      solicitation_enrichment: {
        status: enrichment.status,
        basis: enrichment.basis,
        documents_status: docsStatus,
        source: CURRENT_SOLICITATIONS_SOURCE,
      },
    };
    // Notice subject only — no PIN means no contract join edge.
    const subjects = linksFromLifecycle(partial, r);
    partial.subject_refs = subjects.subject_refs;
    partial.subject_links = subjects.subject_links;
    // Solicitation recovery side-car (sources checked even when unmatched).
    partial.solicitation_recovery = {
      status: timeline.some((e) => e.stage === STAGE_SOLICITATION && e.status === "matched")
        ? "matched"
        : "unmatched",
      source: (timeline.find((e) => e.stage === STAGE_SOLICITATION && e.status === "matched") || {}).source || null,
      sources_checked: SOLICITATION_RECOVERY_SOURCES.slice(),
    };
    // Orphan / amount / date coherence counters (metric + side-car).
    const coherentPartial = attachLifecycleCoherence(partial);
    return attachAwardPrimeGoal(coherentPartial, r, {
      passport: opts.passport || null,
      goals: opts.subcontractGoals || null,
    });
  }

  // Collapse Checkbook Contracts slices (Prime Vendor + Sub Vendor rows, etc.) to
  // distinct prime_contract_id before classifyStage. Pending and registered both
  // use the Contracts domain and share this defect; spending stays raw (many
  // payments per contract is expected).
  const pendingRows = aggregateContractsById(pending);
  const registeredRows = aggregateContractsById(registered);

  // --- Checkbook pending stage ---
  let pendingStatus = lookupStageStatus(lookupStatus.pending, pendingRows);
  const pendingEntry = stageEntry(STAGE_PENDING, pendingStatus, "checkbook-contracts", {
    date: pendingStatus === "matched" ? (pendingRows[0].received || pendingRows[0].start || null) : null,
    source_timestamp: pendingStatus === "matched" ? (pendingRows[0].received || pendingRows[0].start || null) : null,
    date_basis: DATE_BASIS_RECEIVED,
    detail: pendingStatus === "matched" ? {
      contract_id: pendingRows[0].id,
      vendor: pendingRows[0].vendor,
      received_date: pendingRows[0].received || null,
      start_date: pendingRows[0].start || null,
      amount: pendingRows[0].current || pendingRows[0].original || 0,
    } : pendingStatus === "ambiguous" ? {
      candidates: pendingRows.map((c) => ({
        contract_id: c.id, vendor: c.vendor, amount: c.current || c.original || 0,
        received_date: c.received || null,
      })),
    } : null,
  });

  // --- Checkbook registered stage ---
  let regStatus = lookupStageStatus(lookupStatus.registered, registeredRows);
  const regDetail = regStatus === "matched" ? {
    contract_id: registeredRows[0].id,
    vendor: registeredRows[0].vendor,
    registration_date: registeredRows[0].registered || null,
    original_amount: registeredRows[0].original || 0,
    current_amount: registeredRows[0].current || 0,
    spent_to_date: registeredRows[0].spent || 0,
    start_date: registeredRows[0].start || null,
    end_date: registeredRows[0].end || null,
    duration: registeredRows[0].duration || null,
    mwbe: registeredRows[0].mwbe || null,
    // Related Checkbook fact for the award→prime→goal payload (not a goal %).
    contract_includes_sub_vendors: registeredRows[0].subs || null,
  } : regStatus === "ambiguous" ? {
    candidates: registeredRows.map((c) => ({
      contract_id: c.id, vendor: c.vendor,
      registration_date: c.registered || null,
      current_amount: c.current || 0,
    })),
  } : null;
  const regEntry = stageEntry(STAGE_REGISTERED, regStatus, "checkbook-contracts", {
    date: regStatus === "matched" ? (registeredRows[0].registered || null) : null,
    source_timestamp: regStatus === "matched" ? (registeredRows[0].registered || null) : null,
    date_basis: DATE_BASIS_REGISTRATION,
    detail: regDetail,
  });

  // --- Checkbook spending stage ---
  // Three-state payment honesty:
  //   1. spending transactions present → real paid amount (payment_state: "paid")
  //   2. spending feed healthy + empty → verified $0 / registered spent
  //      (payment_state: "verified_zero" | "from_registered")
  //   3. spending feed error → unavailable (never a confident $0 fallback)
  // Multiple payments are normal over a contract's life, so 1+ records = matched.
  let spendStatus;
  let payDetail = null;
  let payDate = null;
  if (lookupStatus.spending === "skip" || lookupStatus.spending === "none") {
    spendStatus = "not_applicable";
  } else if (Array.isArray(spending) && spending.length > 0) {
    spendStatus = "matched";
    const totalSpent = spending.reduce((sum, s) => sum + (s.amount || 0), 0);
    const sortedSpending = spending.slice().sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    const latestPayment = sortedSpending[0] || null;
    payDate = (latestPayment && latestPayment.date) || null;
    const paymentRows = projectPaymentRows(spending, { limit: PAYMENT_ROWS_DETAIL_CAP });
    payDetail = {
      total_payments: spending.length,
      total_spent: Math.round(totalSpent * 100) / 100,
      latest_payment_date: latestPayment ? latestPayment.date : null,
      latest_payment_amount: latestPayment ? latestPayment.amount : null,
      fiscal_year: latestPayment ? latestPayment.year : null,
      payment_state: "paid",
      // Check-level trail for Follow-the-Dollars (cg-v1-payment-row-surface).
      payment_rows: paymentRows,
      payment_rows_shown: paymentRows.length,
      payment_rows_capped: spending.length > paymentRows.length,
    };
  } else if (lookupStatus.spending === "error") {
    // Spending feed failed. Prefer a non-zero paid-to-date from the registered join
    // (Contracts/PASSPort) so the payments card and Follow-the-Dollars never disagree.
    // HONESTY (PR 192): never invent a confident $0 when spending could not be checked —
    // only "unavailable" when the registration join also has no positive paid figure.
    if (regStatus === "matched") {
      const regSpent = Number(registeredRows[0].spent) || 0;
      if (regSpent > 0) {
        spendStatus = "matched";
        payDetail = {
          total_payments: null,
          total_spent: regSpent,
          latest_payment_date: null,
          latest_payment_amount: null,
          fiscal_year: null,
          derived_from: "registered",
          payment_state: "from_registered",
        };
      } else {
        spendStatus = "matched";
        payDetail = {
          total_payments: null,
          total_spent: null,
          latest_payment_date: null,
          latest_payment_amount: null,
          fiscal_year: null,
          payment_state: "unavailable",
        };
      }
    } else {
      spendStatus = "unknown";
    }
  } else if (regStatus === "matched") {
    // Spending feed healthy — use registered spent_to_date as the verified figure
    // (often $0 / normal lag on a young contract).
    const spent = Number(registeredRows[0].spent) || 0;
    spendStatus = "matched";
    payDetail = {
      total_payments: null,
      total_spent: spent,
      latest_payment_date: null,
      latest_payment_amount: null,
      fiscal_year: null,
      derived_from: "registered",
      payment_state: spent === 0 ? "verified_zero" : "from_registered",
    };
  } else {
    spendStatus = "unmatched";
  }

  const payEntry = stageEntry(STAGE_PAYMENT, spendStatus, "checkbook-spending", {
    date: spendStatus === "matched" ? payDate : null,
    source_timestamp: spendStatus === "matched" ? payDate : null,
    date_basis: DATE_BASIS_PAYMENT,
    detail: payDetail,
  });

  // Stage succession: a later matched stage supersedes earlier gap/error stages.
  if (regStatus === "matched" && (pendingStatus === "unmatched" || pendingStatus === "unknown")) {
    pendingEntry.status = "passed";
    pendingStatus = "passed";
  }
  if (spendStatus === "matched" && (regStatus === "unmatched" || regStatus === "unknown")) {
    // Unusual (payments without registration) but keep data honest — no succession rewrite.
  }

  timeline.push(pendingEntry, regEntry, payEntry);

  // --- Amendments (derived from aggregated registered contracts) ---
  const amendments = detectAmendments(regStatus === "matched" ? registeredRows : []);

  // ok: true when every Checkbook stage is resolved to a public-facing status
  // (matched / unmatched / ambiguous / passed / not_applicable) — not stuck on unknown.
  // Spending errors surface as payment_state "unavailable" (matched, resolved) so the
  // cache still serves an honest unavailable card instead of inventing $0.
  const unresolved = timeline.some((e) => e.status === "unknown");
  const ok = !unresolved;

  const out = {
    pin: r.pin || null,
    pin_strategy: pinStrategy,
    timeline,
    amendments,
    ok,
    solicitation_enrichment: {
      status: enrichment.status,
      basis: enrichment.basis,
      documents_status: docsStatus,
      source: CURRENT_SOLICITATIONS_SOURCE,
    },
  };
  // Typed subject links: notice ↔ contract stay distinct refs connected by edges.
  // Civic-time, claim layer, and ER resolve the same real-world award via this graph.
  const subjects = linksFromLifecycle(out, r);
  out.subject_refs = subjects.subject_refs;
  out.subject_links = subjects.subject_links;
  // OCP side-car is optional on pure assemble; worker attach always sets it after fetch.
  if (opts.ocpAward) out.ocp_award = opts.ocpAward;
  // Solicitation recovery: which honest source filled the stage (CR / OCP / later RFx).
  const solMatched = timeline.find((e) => e.stage === STAGE_SOLICITATION && e.status === "matched");
  out.solicitation_recovery = {
    status: solMatched ? "matched" : "unmatched",
    source: solMatched?.source || null,
    sources_checked: SOLICITATION_RECOVERY_SOURCES.slice(),
  };
  // Coherence side-car: orphaned award, payment > commitment, out-of-order dates.
  // Named metrics: procurement_lifecycle_coherence_rate, award_solicitation_recovery_rate.
  const coherent = attachLifecycleCoherence(out);
  // Award → prime → M/WBE-goal join (payload only; persona surface is a separate card).
  return attachAwardPrimeGoal(coherent, r, {
    passport: opts.passport || null,
    goals: opts.subcontractGoals || null,
  });
}

// ---------------------------------------------------------------------------
// Payment recovery from a later registration join
// ---------------------------------------------------------------------------

// When registration is filled after Checkbook assembly (e.g. PASSPort enrichment) or
// spending stays unknown while registered.spent_to_date is known, promote the payment
// stage so both the payments card and Follow-the-Dollars share one paid-to-date owner.
// Does not override a real spending-feed "paid" result. Does not invent confident $0
// over an explicit spending-error "unavailable" when registration spent is also 0.
export function recoverPaymentFromRegisteredJoin(lifecycle) {
  if (!lifecycle || !Array.isArray(lifecycle.timeline)) return lifecycle;
  const timeline = lifecycle.timeline;
  const reg = timeline.find((e) => e && e.stage === STAGE_REGISTERED);
  const payIdx = timeline.findIndex((e) => e && e.stage === STAGE_PAYMENT);
  if (payIdx < 0 || !reg || reg.status !== "matched" || !reg.detail) return lifecycle;

  const spentRaw = reg.detail.spent_to_date;
  if (spentRaw == null || !Number.isFinite(Number(spentRaw))) return lifecycle;
  const spent = Number(spentRaw);

  const pay = timeline[payIdx];
  const d = pay.detail || null;
  const state = d && d.payment_state;

  // Spending transactions already joined — leave them.
  if (pay.status === "matched" && state === "paid" && d && d.total_spent != null) {
    return lifecycle;
  }
  // Already recovered / verified from registration.
  if (pay.status === "matched" && (state === "from_registered" || state === "verified_zero")
    && d && d.total_spent != null) {
    return lifecycle;
  }
  // Explicit spending failure with $0 on the join: keep unavailable (no confident $0).
  if (pay.status === "matched" && state === "unavailable" && spent === 0) {
    return lifecycle;
  }

  // Recover when payment is missing, unmatched, unknown, unavailable-with-positive-join,
  // or matched without a usable total.
  const recoverable =
    pay.status === "unknown"
    || pay.status === "unmatched"
    || (pay.status === "matched" && state === "unavailable" && spent > 0)
    || (pay.status === "matched" && (!d || d.total_spent == null));

  if (!recoverable) return lifecycle;

  const newTimeline = timeline.slice();
  newTimeline[payIdx] = {
    ...pay,
    status: "matched",
    source: pay.source || "checkbook-spending",
    date: pay.date || null,
    source_timestamp: pay.source_timestamp || null,
    detail: {
      total_payments: null,
      total_spent: spent,
      latest_payment_date: null,
      latest_payment_amount: null,
      fiscal_year: null,
      derived_from: "registered",
      payment_state: spent === 0 ? "verified_zero" : "from_registered",
    },
  };

  // Pending gap is superseded once registration is on record.
  const pendingIdx = newTimeline.findIndex((e) => e && e.stage === STAGE_PENDING);
  if (pendingIdx >= 0) {
    const p = newTimeline[pendingIdx];
    if (p.status === "unmatched" || p.status === "unknown") {
      newTimeline[pendingIdx] = { ...p, status: "passed" };
    }
  }

  const unresolved = newTimeline.some((e) => e.status === "unknown");
  return attachLifecycleCoherence({
    ...lifecycle,
    timeline: newTimeline,
    ok: !unresolved,
  });
}

// ---------------------------------------------------------------------------
// PIN matching strategy
// ---------------------------------------------------------------------------

// Given a notice's PIN, produce the list of PIN values to try against Checkbook,
// in priority order: exact first, then the base PIN (renewal suffix stripped).
// Returns { pins: [...], strategy: "exact" | "legacy-base" }.
export function pinMatchStrategy(pin) {
  if (!usablePin(pin)) return { pins: [], strategy: "none" };
  const exact = String(pin).trim();
  const base = pinBase(exact);
  if (base && base !== exact) {
    return { pins: [exact, base], strategy: "legacy-base" };
  }
  return { pins: [exact], strategy: "exact" };
}
