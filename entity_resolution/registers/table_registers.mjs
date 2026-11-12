// Normalizers for the two Socrata table registers: NYS Department of Labor Contractor Registry
// (data.ny.gov i4jv-zkey) and NYC School Construction Authority Prequalified Firms (NYC Open
// Data szkz-syh6). Every published field is kept in `raw`; malformed rows are flagged and kept.

import { addressFrom, makeRecord } from "./read_contract.mjs";

export const DOL_REGISTER = "nys_dol_contractor_registry";
export const DOL_DATASET_ID = "i4jv-zkey";
export const DOL_SOURCE_URL = "https://data.ny.gov/d/i4jv-zkey";
export const DOL_RESOURCE_URL = "https://data.ny.gov/resource/i4jv-zkey.json";

export const SCA_REGISTER = "nyc_sca_prequalified_firms";
export const SCA_DATASET_ID = "szkz-syh6";
export const SCA_SOURCE_URL = "https://data.cityofnewyork.us/d/szkz-syh6";
export const SCA_RESOURCE_URL = "https://data.cityofnewyork.us/resource/szkz-syh6.json";

const s = (v) => (v == null ? "" : String(v));

// --- DOL -----------------------------------------------------------------------------------

const DOL_CLASS = { Corporation: "business_corporation", LLC: "llc", LLP: "llp" };

/** Socrata-computed region columns (":@computed_region_...") are not agency fields. */
export function stripComputed(row) {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) if (!k.startsWith(":")) out[k] = v;
  return out;
}

export function normalizeDolRow(row, { collected_at }) {
  const raw = stripComputed(row);
  const flags = [];
  for (const d of ["issued_date", "expiration_date", "debarment_start_date", "debarment_end_date"]) {
    if (s(raw[d]).trim() && Number.isNaN(Date.parse(raw[d]))) flags.push("invalid_date");
  }
  const type = s(raw.business_type).trim();
  const aliases = s(raw.dba_name).trim() ? [s(raw.dba_name).trim()] : [];
  return makeRecord({
    register: DOL_REGISTER,
    register_record_id: s(raw.certificate_number).trim(),
    name: s(raw.business_name),
    entity_class: type ? (DOL_CLASS[type] ?? "other") : null,
    entity_type: type || null,
    address: addressFrom({ street: raw.address, street_2: raw.address_2, city: raw.city, state: raw.state, zip: raw.zip_code }),
    status: s(raw.status).trim() || null,
    status_basis: "published status of the contractor registry certificate",
    source_url: DOL_SOURCE_URL,
    collected_at,
    flags,
    published: {
      aliases,
      phone: s(raw.phone).trim() || null,
      issued_date: raw.issued_date ?? null,
      expiration_date: raw.expiration_date ?? null,
      business_is_mwbe_owned: raw.business_is_mwbe_owned ?? null,
      business_is_publicly_traded: raw.business_is_publicly_traded ?? null,
      business_officers: raw.business_officers ?? null,
      business_has_been_debarred: raw.business_has_been_debarred ?? null,
      debarment_start_date: raw.debarment_start_date ?? null,
      debarment_end_date: raw.debarment_end_date ?? null,
    },
    raw,
  });
}

// --- SCA -----------------------------------------------------------------------------------

export const SCA_FIELDS = Object.freeze([
  "prequalified_vendor_master_trade_code", "prequalified_vendor_trade_description", "prequalified_vendor_name",
  "prequalified_vendor_address", "prequalified_vendor_city_name", "prequalified_vendor_state_code",
  "prequalified_vendor_zip_code", "prequalified_vendor_phone_number", "prequalified_vendor_fax_number",
  "prequalified_vendor_contact_person", "prequalified_vendor_minority_business_indicator",
  "prequalified_vendor_women_business_indicator", "prequalified_vendor_local_business_indicator",
  "prequalified_vendor_over_million_dollar_revenue_indicator", "prequalified_vendor_date",
]);

/**
 * The list has one row per firm and trade. The contract record is one per firm: rows are grouped
 * by published firm name (unique in the data on 2026-11-11: 2,178 names, 6,092 rows, firm-level
 * fields identical across a firm's rows). The record id is derived from the name, since the list
 * publishes no identifier; published.id_basis says so. A row with an empty name is kept as its own
 * flagged record keyed by row position.
 */
export function normalizeScaRows(rows, { collected_at }) {
  const groups = new Map();
  rows.forEach((row, i) => {
    const key = s(row.prequalified_vendor_name).trim().toUpperCase() || `__row_${i}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  const out = [];
  for (const [key, rs] of groups) {
    const first = rs[0];
    const flags = [];
    const firmFields = SCA_FIELDS.filter((f) => !["prequalified_vendor_master_trade_code", "prequalified_vendor_trade_description", "prequalified_vendor_date"].includes(f));
    if (rs.some((r) => firmFields.some((f) => s(r[f]) !== s(first[f])))) flags.push("ragged_row");
    const trades = rs.map((r) => ({
      trade_code: r.prequalified_vendor_master_trade_code ?? null,
      trade_description: r.prequalified_vendor_trade_description ?? null,
      prequalified_to: r.prequalified_vendor_date ?? null,
    }));
    for (const r of rs) if (s(r.prequalified_vendor_date).trim() && Number.isNaN(Date.parse(r.prequalified_vendor_date))) flags.push("invalid_date");
    const latest = trades.map((t) => s(t.prequalified_to)).filter(Boolean).sort().at(-1) ?? null;
    const isRowKey = key.startsWith("__row_");
    out.push(makeRecord({
      register: SCA_REGISTER,
      register_record_id: isRowKey ? "" : key,
      name: s(first.prequalified_vendor_name),
      entity_class: null,
      entity_type: null,
      address: addressFrom({ street: first.prequalified_vendor_address, city: first.prequalified_vendor_city_name, state: first.prequalified_vendor_state_code, zip: first.prequalified_vendor_zip_code }),
      status: "PREQUALIFIED",
      status_basis: "list membership; prequalified_vendor_date is the date the firm is prequalified to",
      source_url: SCA_SOURCE_URL,
      collected_at,
      flags,
      published: {
        id_basis: "derived: upper-cased published firm name (the list publishes no identifier)",
        phone: s(first.prequalified_vendor_phone_number).trim() || null,
        fax: s(first.prequalified_vendor_fax_number).trim() || null,
        contact_person: s(first.prequalified_vendor_contact_person).trim() || null,
        minority_business_indicator: first.prequalified_vendor_minority_business_indicator ?? null,
        women_business_indicator: first.prequalified_vendor_women_business_indicator ?? null,
        local_business_indicator: first.prequalified_vendor_local_business_indicator ?? null,
        over_million_dollar_revenue_indicator: first.prequalified_vendor_over_million_dollar_revenue_indicator ?? null,
        prequalified_to_latest: latest,
        trades,
      },
      raw: { rows: rs.map((r) => stripComputed(r)) },
    }));
  }
  return out;
}
