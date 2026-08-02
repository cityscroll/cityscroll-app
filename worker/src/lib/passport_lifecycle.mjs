// Enrich a Checkbook procurement lifecycle with PASSPort Public contracts + RFx.
//
// Pure module (no fetch). When Checkbook leaves pending/registered unmatched, a strict
// EPIN↔PIN join can fill those stages from PASSPort. Solicitations gain an RFx detail
// block when a join succeeds. Unmatched stays in the not-yet-ingested register with a
// specific PASSPort source name — never a blank slot.

import {
  buildEpinIndex,
  joinPinToEpin,
  isPassportPendingStatus,
  isPassportRegisteredStatus,
  normId,
} from "./passport_join.mjs";
import { CONTRACTS_PORTAL, RFX_PORTAL, passportRfxHandoffUrl } from "./passport_parse.mjs";
import { recoverPaymentFromRegisteredJoin } from "./checkbook_lifecycle.mjs";

export { buildEpinIndex, joinPinToEpin, normId };

/**
 * @param {object} lifecycle — output of assembleLifecycle
 * @param {object} notice — City Record notice row
 * @param {{ contracts?: object[], rfx?: object[], lookupStatus?: object }} passport
 */
export function enrichLifecycleWithPassport(lifecycle, notice, passport = {}) {
  if (!lifecycle || !Array.isArray(lifecycle.timeline)) return lifecycle;

  const contracts = Array.isArray(passport.contracts) ? passport.contracts : [];
  const rfxRows = Array.isArray(passport.rfx) ? passport.rfx : [];
  const lookup = passport.lookupStatus || {};
  const pin = notice?.pin || lifecycle.pin;

  const contractIndex = buildEpinIndex(contracts.map((c) => c.epin || c.epin_norm));
  const rfxIndex = buildEpinIndex(rfxRows.map((r) => r.epin || r.epin_norm));
  const contractsByEpin = groupByEpin(contracts);
  const rfxByEpin = groupByEpin(rfxRows);

  const contractJoin = pin ? joinPinToEpin(pin, contractIndex) : null;
  const rfxJoin = pin ? joinPinToEpin(pin, rfxIndex) : null;

  const matchedContracts = contractJoin ? (contractsByEpin.get(contractJoin.epin) || []) : [];
  const matchedRfx = rfxJoin ? (rfxByEpin.get(rfxJoin.epin) || []) : [];

  const pendingContracts = matchedContracts.filter((c) => isPassportPendingStatus(c.status));
  const registeredContracts = matchedContracts.filter((c) => isPassportRegisteredStatus(c.status));
  // If status taxonomy is unknown, treat non-Registered non-empty as pending-ish for enrichment.
  const pendingPool = pendingContracts.length
    ? pendingContracts
    : matchedContracts.filter((c) => c.status && !isPassportRegisteredStatus(c.status));

  const timeline = lifecycle.timeline.map((entry) => {
    if (entry.stage === "solicitation") {
      return enrichSolicitation(entry, matchedRfx, rfxJoin, lookup.rfx);
    }
    if (entry.stage === "pending") {
      return enrichPending(entry, pendingPool, contractJoin, lookup.contracts);
    }
    if (entry.stage === "registered") {
      return enrichRegistered(entry, registeredContracts, contractJoin, lookup.contracts);
    }
    return entry;
  });

  // Solicitation-only notices: inject solicitation stage RFx enrichment already handled.
  // If there is no solicitation stage but we have RFx (award notice that still has live RFx),
  // attach rfx_detail on the lifecycle root for the surface to read.
  const rfxDetail = matchedRfx.length === 1
    ? rfxDetailFrom(matchedRfx[0], rfxJoin)
    : matchedRfx.length > 1
      ? { status: "ambiguous", join_method: rfxJoin?.method || null, candidates: matchedRfx.map(slimRfx) }
      : null;

  // PASSPort may fill registered after Checkbook left payment unknown/unavailable.
  // Recover paid-to-date from registration so the payments card and Follow-the-Dollars
  // agree (field case #notice/20240723114: join had $4.02M, payments said unavailable).
  const withPayment = recoverPaymentFromRegisteredJoin({
    ...lifecycle,
    timeline,
  });

  return {
    ...withPayment,
    passport: {
      contract_join: contractJoin,
      rfx_join: rfxJoin,
      contracts_found: matchedContracts.length,
      rfx_found: matchedRfx.length,
      lookup_status: {
        contracts: lookup.contracts || (contracts.length ? "ok" : "skipped"),
        rfx: lookup.rfx || (rfxRows.length ? "ok" : "skipped"),
      },
    },
    rfx_detail: rfxDetail,
  };
}

function groupByEpin(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = normId(row.epin_norm || row.epin);
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

function enrichSolicitation(entry, matchedRfx, join, lookupStatus) {
  if (lookupStatus === "error") {
    return {
      ...entry,
      rfx: {
        status: "unavailable",
        source: "passport-public-rfx",
        portal: RFX_PORTAL,
      },
      passport_lookup: "unavailable",
    };
  }
  if (entry.status === "matched" && matchedRfx.length === 1) {
    const r = matchedRfx[0];
    return {
      ...entry,
      detail: {
        ...(entry.detail || {}),
        rfx: slimRfx(r),
        rfx_join_method: join?.method || null,
      },
      rfx: {
        status: "matched",
        source: "passport-public-rfx",
        portal: passportRfxHandoffUrl(r.rfp_id),
        join_method: join?.method || null,
        detail: slimRfx(r),
      },
    };
  }
  if (matchedRfx.length > 1) {
    return {
      ...entry,
      rfx: {
        status: "ambiguous",
        source: "passport-public-rfx",
        portal: RFX_PORTAL,
        join_method: join?.method || null,
        candidates: matchedRfx.map(slimRfx),
      },
    };
  }
  // No RFx join — keep solicitation matched from City Record; attach explicit RFx gap.
  return {
    ...entry,
    rfx: {
      status: "unmatched",
      source: "passport-public-rfx",
      portal: RFX_PORTAL,
      reason: join ? "epin_joined_no_row" : "no_epin_pin_join",
    },
  };
}

function enrichPending(entry, pendingPool, join, lookupStatus) {
  // Prefer Checkbook when already matched.
  if (entry.status === "matched") return entry;
  // Operational failure: never claim a confident empty / not-yet-ingested gap.
  // Surface unavailable so the panel matches the three-state honesty pattern
  // (ok / unmatched / unavailable) used for Checkbook payment_state.
  if (lookupStatus === "error") {
    return {
      ...entry,
      passport_lookup: "unavailable",
    };
  }
  if (pendingPool.length === 1) {
    const c = pendingPool[0];
    return {
      stage: "pending",
      status: "matched",
      source: "passport-public-contracts",
      date: parseUsDate(c.start_date) || null,
      source_timestamp: parseUsDate(c.start_date) || null,
      detail: {
        contract_id: c.contract_id || c.ctr_id || null,
        vendor: c.vendor || null,
        received_date: null,
        start_date: c.start_date || null,
        amount: c.current_amount ?? c.award_amount ?? 0,
        passport_status: c.status || null,
        epin: c.epin || null,
        join_method: join?.method || null,
        title: c.title || null,
      },
      portal: CONTRACTS_PORTAL,
    };
  }
  if (pendingPool.length > 1) {
    return {
      stage: "pending",
      status: "ambiguous",
      source: "passport-public-contracts",
      date: null,
      source_timestamp: null,
      detail: {
        candidates: pendingPool.map((c) => ({
          contract_id: c.contract_id || c.ctr_id || null,
          vendor: c.vendor || null,
          amount: c.current_amount ?? c.award_amount ?? 0,
          received_date: null,
          passport_status: c.status || null,
        })),
      },
      portal: CONTRACTS_PORTAL,
    };
  }
  // Still unmatched: name PASSPort as the additional public source for this gap class.
  if (entry.status === "unmatched") {
    return {
      ...entry,
      gap_sources: ["checkbook-contracts", "passport-public-contracts"],
      portal: CONTRACTS_PORTAL,
      passport_join: join || null,
    };
  }
  return entry;
}

function enrichRegistered(entry, registeredPool, join, lookupStatus) {
  if (entry.status === "matched") return entry;
  if (lookupStatus === "error") {
    return {
      ...entry,
      passport_lookup: "unavailable",
    };
  }
  if (registeredPool.length === 1) {
    const c = registeredPool[0];
    return {
      stage: "registered",
      status: "matched",
      source: "passport-public-contracts",
      date: parseUsDate(c.registration_date) || null,
      source_timestamp: parseUsDate(c.registration_date) || null,
      detail: {
        contract_id: c.contract_id || c.ctr_id || null,
        vendor: c.vendor || null,
        registration_date: c.registration_date || null,
        original_amount: c.award_amount ?? 0,
        current_amount: c.current_amount ?? c.award_amount ?? 0,
        spent_to_date: c.paid_amount ?? 0,
        start_date: c.start_date || null,
        end_date: c.end_date || null,
        duration: null,
        mwbe: c.certification_type || null,
        passport_status: c.status || null,
        epin: c.epin || null,
        join_method: join?.method || null,
      },
      portal: CONTRACTS_PORTAL,
    };
  }
  if (registeredPool.length > 1) {
    return {
      stage: "registered",
      status: "ambiguous",
      source: "passport-public-contracts",
      date: null,
      source_timestamp: null,
      detail: {
        candidates: registeredPool.map((c) => ({
          contract_id: c.contract_id || c.ctr_id || null,
          vendor: c.vendor || null,
          registration_date: c.registration_date || null,
          current_amount: c.current_amount ?? 0,
        })),
      },
      portal: CONTRACTS_PORTAL,
    };
  }
  if (entry.status === "unmatched") {
    return {
      ...entry,
      gap_sources: ["checkbook-contracts", "passport-public-contracts"],
      portal: CONTRACTS_PORTAL,
      passport_join: join || null,
    };
  }
  return entry;
}

function slimRfx(r) {
  // public_rfx_data has no addenda date columns today; keep optional fields when a
  // future dump or side-car provides them so the civic-time RFx spine can emit
  // procurement.solicitation_addenda without a second join path.
  const addenda_date =
    r.addenda_date || r.addendum_date || r.last_addenda_date || r.amendment_date || null;
  return {
    epin: r.epin || null,
    procurement_name: r.procurement_name || null,
    agency: r.agency || null,
    rfx_status: r.rfx_status || null,
    release_date: r.release_date || null,
    due_date: r.due_date || null,
    procurement_method: r.procurement_method || null,
    main_commodity: r.main_commodity || null,
    industry: r.industry || null,
    rfp_id: r.rfp_id || null,
    ...(addenda_date ? { addenda_date } : {}),
  };
}

function rfxDetailFrom(r, join) {
  return {
    status: "matched",
    source: "passport-public-rfx",
    // Prefer the publisher extranet deep link when rfp_id is present; browse is fallback.
    portal: passportRfxHandoffUrl(r?.rfp_id),
    join_method: join?.method || null,
    detail: slimRfx(r),
  };
}

/** PASSPort dates look like "7/28/2026 9:00:00 AM" or "07/23/2026". */
export function parseUsDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) {
    // Already ISO-ish
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    return null;
  }
  const mm = m[1].padStart(2, "0");
  const dd = m[2].padStart(2, "0");
  return `${m[3]}-${mm}-${dd}`;
}
