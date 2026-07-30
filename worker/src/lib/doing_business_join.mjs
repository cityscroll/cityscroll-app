// Strict City Record vendor_name ↔ Doing Business Search Entities (72mk-a8z7) join.
//
// Measured 2026-07-30 (see site/data/doing_business_sources/ and
// site/data/source_contracts.json join_measurement for doing-business-entities):
//
//   Modern awards (Procurement Award notices with vendor_name, start_date >= 2025-01-01):
//     notice-level vendor_stem join 70.42% (3,643 / 5,173)
//     distinct-vendor stem join 61.62% (1,567 / 2,543)
//   Exact uppercase name (no stem): 30.24% of distinct modern award vendors.
//
// Accepted strategies (strict only):
//   vendor_stem — product vendorStem() on organization_name equals vendorStem(vendor_name)
//
// Rejected as weak:
//   substring / token-overlap name matches (false positives across unrelated entities)
//   phone-only joins (phones are shared across related orgs)
//
// Verdict: above usefulness threshold (≥30%). Ship edge materialization onto vendor profiles.
//
// Dataset columns (only four): organization_name, ownership_structure_code,
// organization_phone, doing_business_start_date. No EIN/BIN/EPIN.

import { vendorStem } from "./compile.mjs";

export const DOING_BUSINESS_DATASET = "72mk-a8z7";
export const DOING_BUSINESS_SODA =
  "https://data.cityofnewyork.us/resource/72mk-a8z7.json";
export const DOING_BUSINESS_SOURCE = "doing-business-entities";

/** Ownership structure codes observed in 72mk-a8z7 (uppercased). */
export const OWNERSHIP_STRUCTURE_LABELS = Object.freeze({
  COR: "Corporation",
  LLC: "Limited liability company",
  PAR: "Partnership",
  IND: "Individual",
  JNT: "Joint venture",
  PRO: "Professional corporation",
  OTH: "Other",
  GOV: "Government",
});

/**
 * Normalize publisher doing_business_start_date values.
 * Open Data publishes year as 00YY (e.g. 0009-05-16 for 2009-05-16).
 * @returns {string|null} YYYY-MM-DD or null
 */
export function normalizeDoingBusinessDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  // ISO with optional time: 0009-05-16T00:00:00.000 or 2009-05-16
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  let year = Number(m[1]);
  const month = m[2];
  const day = m[3];
  if (!Number.isFinite(year) || year < 1) return null;
  // Truncated century: 0008–0099 → 2008–2099 (law era; publisher freeze pattern).
  if (year < 100) year += 2000;
  if (year < 1900 || year > 2100) return null;
  return `${String(year).padStart(4, "0")}-${month}-${day}`;
}

export function normalizeOwnershipCode(value) {
  const code = String(value || "").trim().toUpperCase();
  return code || null;
}

export function ownershipStructureLabel(code) {
  const c = normalizeOwnershipCode(code);
  if (!c) return null;
  return OWNERSHIP_STRUCTURE_LABELS[c] || c;
}

export function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10) {
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  const raw = String(value || "").trim();
  return raw || null;
}

/**
 * Normalize one Open Data entity row for product use.
 * @returns {{
 *   organization_name: string,
 *   ownership_structure_code: string|null,
 *   ownership_structure: string|null,
 *   organization_phone: string|null,
 *   doing_business_start_date: string|null,
 *   stem: string,
 * } | null}
 */
export function normalizeDoingBusinessEntity(row) {
  const organization_name = String(row?.organization_name || "").trim();
  if (!organization_name) return null;
  const stem = vendorStem(organization_name);
  if (!stem || stem.length < 3) return null;
  const ownership_structure_code = normalizeOwnershipCode(row?.ownership_structure_code);
  return {
    organization_name,
    ownership_structure_code,
    ownership_structure: ownershipStructureLabel(ownership_structure_code),
    organization_phone: normalizePhone(row?.organization_phone),
    doing_business_start_date: normalizeDoingBusinessDate(row?.doing_business_start_date),
    stem,
  };
}

/**
 * Build a stem → entity index. When multiple rows share a stem, keep the
 * alphabetically first organization_name (stable, deterministic).
 * @param {Iterable<object>} rows
 * @returns {Map<string, ReturnType<typeof normalizeDoingBusinessEntity>>}
 */
export function buildDoingBusinessIndex(rows) {
  const index = new Map();
  for (const row of rows || []) {
    const entity = normalizeDoingBusinessEntity(row);
    if (!entity) continue;
    const prev = index.get(entity.stem);
    if (!prev || entity.organization_name.localeCompare(prev.organization_name) < 0) {
      index.set(entity.stem, entity);
    }
  }
  return index;
}

/**
 * Join a City Record vendor name to the Doing Business index via vendorStem only.
 * @returns {{ method: "vendor_stem", entity: object } | null}
 */
export function joinVendorToDoingBusiness(vendorName, index) {
  if (!index || typeof index.get !== "function") return null;
  const stem = vendorStem(vendorName);
  if (!stem || stem.length < 3) return null;
  const entity = index.get(stem);
  if (!entity) return null;
  return { method: "vendor_stem", entity };
}

/**
 * Public attach payload for vendor profiles (no internal stem field).
 */
export function doingBusinessProfilePayload(match) {
  if (!match?.entity) return null;
  const e = match.entity;
  return {
    source: DOING_BUSINESS_SOURCE,
    method: match.method,
    organization_name: e.organization_name,
    ownership_structure_code: e.ownership_structure_code,
    ownership_structure: e.ownership_structure,
    organization_phone: e.organization_phone,
    doing_business_start_date: e.doing_business_start_date,
    catalog: "https://data.cityofnewyork.us/d/72mk-a8z7",
  };
}
