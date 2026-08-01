// Pure OCP Recent Contract Awards (qyyg-4tf5) side-car join for the procurement lifecycle.
//
// Joins Mayor's Office of Contract Services "Recent Contract Awards" Open Data rows to a
// City Record notice by request_id (preferred) then PIN. Corroborates award date and amount
// against City Record fields: when they disagree, both values are returned with sources
// named — never silently preferring one feed. Disagreements carry claim_layer labels
// (source assertion ≠ CityScroll interpretation ≠ derived conclusion).
//
// This module is pure (no fetch, no env) so characterization tests exercise real field cases
// offline. The worker endpoint (checkbook_lifecycle.mjs) fetches SODA and attaches the
// result onto the precomputed lifecycle read model.

import { labelOcpDisagreements } from "./claim_layer.mjs";

export const OCP_DATASET_ID = "qyyg-4tf5";
export const OCP_SOURCE = "ocp-recent-awards";
export const OCP_LANDING_PAGE = "https://data.cityofnewyork.us/d/qyyg-4tf5";

export function parseAmount(value) {
  if (value == null || value === "") return null;
  const n = parseFloat(String(value).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function dateOnly(value) {
  if (value == null || value === "") return null;
  const s = String(value).trim();
  if (!s) return null;
  // Socrata timestamps look like 2026-07-30T00:00:00.000
  return s.slice(0, 10);
}

export function normalizeOcpAward(row) {
  if (!row || typeof row !== "object") return null;
  return {
    request_id: row.request_id ? String(row.request_id) : null,
    pin: row.pin ? String(row.pin).trim() : null,
    date: dateOnly(row.start_date),
    amount: parseAmount(row.contract_amount),
    vendor: row.vendor_name ? String(row.vendor_name).trim() : null,
    title: row.short_title ? String(row.short_title).trim() : null,
    agency: row.agency_name ? String(row.agency_name).trim() : null,
    type: row.type_of_notice_description
      ? String(row.type_of_notice_description).trim()
      : null,
  };
}

function amountsAgree(a, b) {
  if (a == null || b == null) return a == null && b == null;
  return Math.abs(Number(a) - Number(b)) < 0.01;
}

function datesAgree(a, b) {
  const da = dateOnly(a);
  const db = dateOnly(b);
  if (!da || !db) return da === db;
  return da === db;
}

// Compare City Record award fields to a normalized OCP row.
// Returns per-field agreement plus a flat disagreements list for rendering.
export function corroborateAward(cityFields, ocpDetail) {
  const city = cityFields || {};
  const ocp = ocpDetail || {};
  const cityAmount = parseAmount(city.amount ?? city.contract_amount);
  const cityDate = dateOnly(city.date ?? city.start_date);
  const ocpAmount = ocp.amount != null ? ocp.amount : parseAmount(ocp.contract_amount);
  const ocpDate = ocp.date != null ? ocp.date : dateOnly(ocp.start_date);

  const amountAgree = amountsAgree(cityAmount, ocpAmount);
  const dateAgree = datesAgree(cityDate, ocpDate);

  const fields = {
    amount: {
      city_record: cityAmount,
      ocp: ocpAmount,
      agree: amountAgree,
    },
    date: {
      city_record: cityDate,
      ocp: ocpDate,
      agree: dateAgree,
    },
  };

  const rawDisagreements = [];
  if (!amountAgree && (cityAmount != null || ocpAmount != null)) {
    rawDisagreements.push({
      field: "amount",
      city_record: cityAmount,
      ocp: ocpAmount,
    });
  }
  if (!dateAgree && (cityDate || ocpDate)) {
    rawDisagreements.push({
      field: "date",
      city_record: cityDate,
      ocp: ocpDate,
    });
  }

  // Label each disagreement: both publisher values stay source assertions; the compare
  // step is an unresolved CityScroll interpretation with no derived winner.
  const disagreements = labelOcpDisagreements(rawDisagreements, {
    city_source_system: "city_record",
    ocp_source_system: OCP_SOURCE,
  });

  return {
    agree: disagreements.length === 0,
    fields,
    disagreements,
  };
}

function cityAwardFieldsFromNotice(noticeRow) {
  const r = noticeRow || {};
  return {
    amount: r.contract_amount,
    date: r.start_date,
    vendor: r.vendor_name || null,
    request_id: r.request_id || null,
    pin: r.pin || null,
  };
}

// Join OCP award rows to a City Record notice.
//
// Preference order:
//   1. exact request_id match (City Record and OCP share the same notice id)
//   2. exact PIN match (solicitation notice → later OCP award)
//
// lookupStatus: "ok" | "error" — when error, status is unknown (reach failure).
export function joinOcpAward(noticeRow, ocpRows, opts = {}) {
  const lookupStatus = opts.lookupStatus || "ok";
  if (lookupStatus === "error") {
    return {
      status: "unknown",
      source: OCP_SOURCE,
      join_key: null,
      detail: null,
      corroboration: null,
      candidates: null,
    };
  }

  const rows = Array.isArray(ocpRows) ? ocpRows.map(normalizeOcpAward).filter(Boolean) : [];
  const notice = noticeRow || {};
  const requestId = notice.request_id ? String(notice.request_id) : null;
  const pin = notice.pin ? String(notice.pin).trim() : null;

  let matched = [];
  let joinKey = null;

  if (requestId) {
    matched = rows.filter((r) => r.request_id === requestId);
    if (matched.length) joinKey = "request_id";
  }
  if (!matched.length && pin) {
    matched = rows.filter((r) => r.pin && r.pin === pin);
    if (matched.length) joinKey = "pin";
  }

  if (matched.length === 0) {
    return {
      status: "unmatched",
      source: OCP_SOURCE,
      join_key: null,
      detail: null,
      corroboration: null,
      candidates: null,
    };
  }

  if (matched.length > 1) {
    // Prefer an Award-typed row when several share a PIN.
    const awardsOnly = matched.filter((r) => !r.type || r.type === "Award");
    const pool = awardsOnly.length ? awardsOnly : matched;
    if (pool.length > 1) {
      return {
        status: "ambiguous",
        source: OCP_SOURCE,
        join_key: joinKey,
        detail: null,
        corroboration: null,
        candidates: pool.map((r) => ({
          request_id: r.request_id,
          pin: r.pin,
          date: r.date,
          amount: r.amount,
          vendor: r.vendor,
        })),
      };
    }
    matched = pool;
  }

  const detail = matched[0];
  const cityFields = cityAwardFieldsFromNotice(notice);
  // Corroboration only when the City Record notice itself is an Award (or carries amount/date).
  // A solicitation matched by PIN still surfaces the OCP row without claiming City Record agreement.
  const isAwardNotice = String(notice.type_of_notice_description || "") === "Award";
  const hasCityAwardFields =
    isAwardNotice || cityFields.amount != null || cityFields.date != null;
  const corroboration =
    hasCityAwardFields && isAwardNotice
      ? corroborateAward(cityFields, detail)
      : null;

  return {
    status: "matched",
    source: OCP_SOURCE,
    join_key: joinKey,
    detail,
    corroboration,
    candidates: null,
  };
}

// Attach OCP side-car onto an assembleLifecycle result. Pure and idempotent.
export function attachOcpAward(lifecycle, ocpSideCar) {
  if (!lifecycle || typeof lifecycle !== "object") return lifecycle;
  return {
    ...lifecycle,
    ocp_award: ocpSideCar || {
      status: "unknown",
      source: OCP_SOURCE,
      join_key: null,
      detail: null,
      corroboration: null,
      candidates: null,
    },
  };
}
