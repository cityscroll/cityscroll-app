// Pure lifecycle assembly for the Checkbook contract lifecycle (PROC-001).
//
// Parses Checkbook NYC XML for pending contracts, registered contracts, and spending
// transactions, then assembles a bounded procurement timeline joining City Record
// solicitation/award to Checkbook pending → registered → payment, with explicit
// unmatched/ambiguous/unknown states.
//
// This is a pure module (no fetch, no env) so test/contract tests exercise the join
// logic directly. The worker module (worker/src/checkbook_lifecycle.mjs) wraps these
// functions with precompute + cache + endpoint.

import { usablePin, pinBase } from "./lineage.mjs";

export { usablePin, pinBase };

// ---------------------------------------------------------------------------
// XML parsing (regex-based, matching the pattern in checkbook.mjs / external_award.mjs)
// ---------------------------------------------------------------------------

function extractTag(xml, tag) {
  const m = String(xml || "").match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1].trim() : "";
}

function parseAmount(s) {
  const n = parseFloat(String(s || "").replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

// Parse a <transaction> block from the Contracts domain (pending or registered).
export function parseContractTransaction(txXml) {
  return {
    id: extractTag(txXml, "prime_contract_id"),
    vendor: extractTag(txXml, "prime_vendor"),
    agency: extractTag(txXml, "agency_name"),
    pin: extractTag(txXml, "pin"),
    status: extractTag(txXml, "status"),
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
export function parseSpendingTransaction(txXml) {
  return {
    id: extractTag(txXml, "spending_id") || extractTag(txXml, "transaction_id"),
    contractId: extractTag(txXml, "contract_id") || extractTag(txXml, "prime_contract_id"),
    vendor: extractTag(txXml, "vendor_name") || extractTag(txXml, "prime_vendor"),
    agency: extractTag(txXml, "agency_name"),
    pin: extractTag(txXml, "pin"),
    amount: parseAmount(extractTag(txXml, "check_amount") || extractTag(txXml, "amount")),
    date: extractTag(txXml, "check_date") || extractTag(txXml, "transaction_date"),
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
// Stage classification
// ---------------------------------------------------------------------------

export const STAGE_SOLICITATION = "solicitation";
export const STAGE_AWARD = "award";
export const STAGE_PENDING = "pending";
export const STAGE_REGISTERED = "registered";
export const STAGE_PAYMENT = "payment";

export const STAGES = [STAGE_SOLICITATION, STAGE_AWARD, STAGE_PENDING, STAGE_REGISTERED, STAGE_PAYMENT];

// matched = exactly one record found
// unmatched = confirmed lookup, nothing found
// ambiguous = multiple records found, cannot auto-resolve
// unknown = could not complete the lookup
export function classifyStage(records) {
  if (!Array.isArray(records)) return "unknown";
  if (records.length === 0) return "unmatched";
  if (records.length === 1) return "matched";
  return "ambiguous";
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

// Assemble the full procurement lifecycle from City Record notice + Checkbook data.
//
// noticeRow: the City Record notice (request_id, agency_name, type_of_notice_description,
//            pin, start_date, short_title, contract_amount, vendor_name)
// pending: array of parsed Checkbook pending-contract records for this PIN
// registered: array of parsed Checkbook registered-contract records for this PIN
// spending: array of parsed Checkbook spending records for this PIN
// opts.pinStrategy: "exact" or "legacy-base" (for legacy PIN fallback reporting)
// opts.lookupStatus: { pending: "ok"|"error", registered: "ok"|"error", spending: "ok"|"error" }
//
// Returns a lifecycle object with an explicit timeline array, amendments, and ok flag.
export function assembleLifecycle(noticeRow, pending, registered, spending, opts = {}) {
  const r = noticeRow || {};
  const pinStrategy = opts.pinStrategy || "exact";
  const lookupStatus = opts.lookupStatus || {};

  // --- City Record stages (solicitation + award) ---
  // The notice itself is the solicitation; an award notice carries the vendor + amount.
  const isAward = r.type_of_notice_description === "Award";
  const isSolicitation = r.type_of_notice_description === "Solicitation" || !isAward;

  const timeline = [];

  if (isSolicitation) {
    timeline.push(stageEntry(STAGE_SOLICITATION, "matched", "city-record", {
      date: r.start_date || null,
      source_timestamp: r.start_date || null,
      detail: {
        request_id: r.request_id,
        agency: r.agency_name,
        title: r.short_title || null,
        pin: r.pin || null,
      },
    }));
  }

  if (isAward) {
    timeline.push(stageEntry(STAGE_AWARD, "matched", "city-record", {
      date: r.start_date || null,
      source_timestamp: r.start_date || null,
      detail: {
        request_id: r.request_id,
        agency: r.agency_name,
        title: r.short_title || null,
        pin: r.pin || null,
        vendor: r.vendor_name || null,
        amount: r.contract_amount ? Number(r.contract_amount) || 0 : null,
      },
    }));
  }

  // --- Checkbook pending stage ---
  const pendingStatus = lookupStatus.pending === "error" ? "unknown" : classifyStage(pending);
  timeline.push(stageEntry(STAGE_PENDING, pendingStatus, "checkbook-contracts", {
    date: pendingStatus === "matched" ? (pending[0].received || pending[0].start || null) : null,
    source_timestamp: pendingStatus === "matched" ? (pending[0].received || pending[0].start || null) : null,
    detail: pendingStatus === "matched" ? {
      contract_id: pending[0].id,
      vendor: pending[0].vendor,
      received_date: pending[0].received || null,
      start_date: pending[0].start || null,
      amount: pending[0].current || pending[0].original || 0,
    } : pendingStatus === "ambiguous" ? {
      candidates: pending.map((c) => ({
        contract_id: c.id, vendor: c.vendor, amount: c.current || c.original || 0,
        received_date: c.received || null,
      })),
    } : null,
  }));

  // --- Checkbook registered stage ---
  const regStatus = lookupStatus.registered === "error" ? "unknown" : classifyStage(registered);
  timeline.push(stageEntry(STAGE_REGISTERED, regStatus, "checkbook-contracts", {
    date: regStatus === "matched" ? (registered[0].registered || null) : null,
    source_timestamp: regStatus === "matched" ? (registered[0].registered || null) : null,
    detail: regStatus === "matched" ? {
      contract_id: registered[0].id,
      vendor: registered[0].vendor,
      registration_date: registered[0].registered || null,
      original_amount: registered[0].original || 0,
      current_amount: registered[0].current || 0,
      spent_to_date: registered[0].spent || 0,
      start_date: registered[0].start || null,
      end_date: registered[0].end || null,
      duration: registered[0].duration || null,
      mwbe: registered[0].mwbe || null,
    } : regStatus === "ambiguous" ? {
      candidates: registered.map((c) => ({
        contract_id: c.id, vendor: c.vendor,
        registration_date: c.registered || null,
        current_amount: c.current || 0,
      })),
    } : null,
  }));

  // --- Checkbook spending stage ---
  // Multiple payments are normal over a contract's life, so 1+ records = matched.
  const spendStatus = lookupStatus.spending === "error"
    ? "unknown"
    : (Array.isArray(spending) && spending.length > 0 ? "matched" : "unmatched");
  const totalSpent = Array.isArray(spending) && spending.length > 0
    ? spending.reduce((sum, s) => sum + (s.amount || 0), 0)
    : 0;
  const sortedSpending = Array.isArray(spending)
    ? spending.slice().sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))
    : [];
  const latestPayment = sortedSpending[0] || null;
  timeline.push(stageEntry(STAGE_PAYMENT, spendStatus, "checkbook-spending", {
    date: spendStatus === "matched" ? (latestPayment && latestPayment.date) || null : null,
    source_timestamp: spendStatus === "matched" ? (latestPayment && latestPayment.date) || null : null,
    detail: spendStatus === "matched" ? {
      total_payments: spending.length,
      total_spent: Math.round(totalSpent * 100) / 100,
      latest_payment_date: latestPayment ? latestPayment.date : null,
      latest_payment_amount: latestPayment ? latestPayment.amount : null,
      fiscal_year: latestPayment ? latestPayment.year : null,
    } : null,
  }));

  // --- Amendments (derived from registered contracts) ---
  const amendments = detectAmendments(regStatus === "matched" ? registered : []);

  // --- ok flag: true when all Checkbook lookups completed (even if empty) ---
  const ok = lookupStatus.pending !== "error" && lookupStatus.registered !== "error" && lookupStatus.spending !== "error";

  return {
    pin: r.pin || null,
    pin_strategy: pinStrategy,
    timeline,
    amendments,
    ok,
  };
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
