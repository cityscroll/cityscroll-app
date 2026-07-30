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
import {
  CURRENT_SOLICITATIONS_SOURCE,
  joinSolicitationEnrichment,
  applySolicitationDetail,
  documentsStatusFor,
} from "./current_solicitations.mjs";

export { usablePin, pinBase };
export { CURRENT_SOLICITATIONS_SOURCE };

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
// unknown = could not complete the lookup (precompute-internal; public UI must not
//           surface this as a transient-error register — see lifecycle renderers)
// passed = earlier stage superseded because a later stage is on record
// not_applicable = stage cannot be joined (e.g. no PIN on the notice)
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
// + optional Current Solicitations (3khw-qi8f) package enrichment.
//
// noticeRow: the City Record notice (request_id, agency_name, type_of_notice_description,
//            pin, start_date, short_title, contract_amount, vendor_name)
// pending: array of parsed Checkbook pending-contract records for this PIN
// registered: array of parsed Checkbook registered-contract records for this PIN
// spending: array of parsed Checkbook spending records for this PIN
// opts.pinStrategy: "exact" | "legacy-base" | "none"
// opts.lookupStatus: { pending/registered/spending: "ok"|"error"|"skip" }
// opts.currentSolicitation: { status: "ok"|"error", rows: raw Socrata rows[] }
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

  // --- City Record stages (solicitation + award) ---
  // The notice itself is the solicitation; an award notice carries the vendor + amount.
  // When an award joins a Current Solicitations row by PIN, prepend that solicitation stage
  // so readers see package metadata that City Record award rows omit.
  const isAward = r.type_of_notice_description === "Award";
  const isSolicitation = r.type_of_notice_description === "Solicitation" || !isAward;

  const timeline = [];

  if (isSolicitation) {
    const detail = applySolicitationDetail({
      request_id: r.request_id,
      agency: r.agency_name,
      title: r.short_title || null,
      pin: r.pin || null,
    }, enrichment);
    // Prefer the City Record notice as the stage source; flag enrichment source in detail.
    // When package documents joined, source still names city-record for the notice itself;
    // documents_status + enrichment_source drive the documents sub-slot.
    timeline.push(stageEntry(STAGE_SOLICITATION, "matched", "city-record", {
      date: r.start_date || null,
      source_timestamp: r.start_date || null,
      documents_status: docsStatus,
      detail,
    }));
  } else if (isAward && enrichment.status === "matched" && enrichment.match) {
    // Award notice with a linked solicitation package from Current Solicitations.
    // Only prepend on a positive join — do not invent an empty solicitation stage for every award.
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
      documents_status: docsStatus,
      detail,
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

  // No PIN → Checkbook stages cannot be joined. Mark not_applicable (not "unknown"/
  // transient error) so the renderer collapses them into the single no-PIN note.
  if (noPin) {
    for (const stage of [STAGE_PENDING, STAGE_REGISTERED, STAGE_PAYMENT]) {
      const source = stage === STAGE_PAYMENT ? "checkbook-spending" : "checkbook-contracts";
      timeline.push(stageEntry(stage, "not_applicable", source, {
        date: null, source_timestamp: null, detail: null,
      }));
    }
    return {
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
  }

  // --- Checkbook pending stage ---
  let pendingStatus = lookupStageStatus(lookupStatus.pending, pending);
  const pendingEntry = stageEntry(STAGE_PENDING, pendingStatus, "checkbook-contracts", {
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
  });

  // --- Checkbook registered stage ---
  let regStatus = lookupStageStatus(lookupStatus.registered, registered);
  const regDetail = regStatus === "matched" ? {
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
  } : null;
  const regEntry = stageEntry(STAGE_REGISTERED, regStatus, "checkbook-contracts", {
    date: regStatus === "matched" ? (registered[0].registered || null) : null,
    source_timestamp: regStatus === "matched" ? (registered[0].registered || null) : null,
    detail: regDetail,
  });

  // --- Checkbook spending stage ---
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
    payDetail = {
      total_payments: spending.length,
      total_spent: Math.round(totalSpent * 100) / 100,
      latest_payment_date: latestPayment ? latestPayment.date : null,
      latest_payment_amount: latestPayment ? latestPayment.amount : null,
      fiscal_year: latestPayment ? latestPayment.year : null,
    };
  } else if (lookupStatus.spending === "error") {
    // Recover from registered.spent_to_date when the spending domain failed but the
    // contracts join already carries paid-to-date — never leave payment as "unknown"
    // when Follow-the-Dollars can show Checkbook data from the same join.
    if (regStatus === "matched") {
      const spent = Number(registered[0].spent) || 0;
      if (spent > 0) {
        spendStatus = "matched";
        payDetail = {
          total_payments: null,
          total_spent: spent,
          latest_payment_date: null,
          latest_payment_amount: null,
          fiscal_year: null,
          derived_from: "registered",
        };
      } else {
        // $0 on the registered contract = no payments yet → taxonomy unmatched
        spendStatus = "unmatched";
      }
    } else {
      spendStatus = "unknown";
    }
  } else {
    spendStatus = "unmatched";
  }

  const payEntry = stageEntry(STAGE_PAYMENT, spendStatus, "checkbook-spending", {
    date: spendStatus === "matched" ? payDate : null,
    source_timestamp: spendStatus === "matched" ? payDate : null,
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

  // --- Amendments (derived from registered contracts) ---
  const amendments = detectAmendments(regStatus === "matched" ? registered : []);

  // ok: true when every Checkbook stage is resolved to a public-facing status
  // (matched / unmatched / ambiguous / passed / not_applicable) — not stuck on unknown.
  // Spending errors recovered via registered.spent count as resolved.
  const unresolved = timeline.some((e) => e.status === "unknown");
  const ok = !unresolved;

  return {
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
