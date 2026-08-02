// Pure parsers for PASSPort Public machine dumps
// (https://a0333-passportpublic.nyc.gov/dataJs/contractData.js and rfxData.js).
//
// The portal is a static S3/CloudFront site. Tabular data is published as JavaScript
// arrays (`var public_ctr_data = [...]` / `var public_rfx_data = [...]`), not Socrata.
// Rows are string arrays aligned to the DataTables column titles in contracts.js / rfx.js.

import { normId } from "./passport_join.mjs";

export const CONTRACT_COLUMNS = [
  "ctr_id",
  "epin",
  "contract_id",
  "title",
  "agency",
  "vendor",
  "program",
  "procurement_method",
  "contract_type",
  "status",
  "award_amount",
  "current_amount",
  "encumbered_amount",
  "paid_amount",
  "start_date",
  "end_date",
  "registration_date",
  "industry",
  "old_certification_type",
  "ethnicity",
  "certification_type",
  "corporate_structure",
];

export const RFX_COLUMNS = [
  "rfp_id",
  "bpm_id",
  "program",
  "industry",
  "epin",
  "procurement_name",
  "agency",
  "rfx_status",
  "release_date",
  "due_date",
  "main_commodity",
  "procurement_method",
];

export const CONTRACT_DATA_URL = "https://a0333-passportpublic.nyc.gov/dataJs/contractData.js";
export const RFX_DATA_URL = "https://a0333-passportpublic.nyc.gov/dataJs/rfxData.js";
export const CONTRACTS_PORTAL = "https://a0333-passportpublic.nyc.gov/contracts.html";
export const RFX_PORTAL = "https://a0333-passportpublic.nyc.gov/rfx.html";
// Same authenticated extranet path the PASSPort Public RFx table uses for procurement names.
// Scripted GETs land on login with ReturnUrl to this path; after login the vendor opens that RFx.
export const PASSPORT_RFX_EXTRANET_BASE =
  "https://passport.cityofnewyork.us/page.aspx/en/bpm/process_manage_extranet";

/**
 * Normalize a PASSPort Public rfp_id (strip BOM/whitespace). Numeric ids only.
 * @param {unknown} value
 * @returns {string|null}
 */
export function cleanPassportRfpId(value) {
  const id = String(value ?? "").replace(/^\uFEFF/, "").trim();
  return /^\d{3,}$/.test(id) ? id : null;
}

/**
 * Deep RFx handoff URL when rfp_id is known (publisher pattern from public rfx.js).
 * Falls back to the public browse list when no id is available.
 * @param {unknown} rfpId
 * @param {string} [browseFallback]
 * @returns {string}
 */
export function passportRfxHandoffUrl(rfpId, browseFallback = RFX_PORTAL) {
  const id = cleanPassportRfpId(rfpId);
  if (id) return `${PASSPORT_RFX_EXTRANET_BASE}/${encodeURIComponent(id)}`;
  return browseFallback || RFX_PORTAL;
}

function cleanCell(value) {
  return String(value ?? "").replace(/^\uFEFF/, "").trim();
}

function parseMoney(s) {
  const n = parseFloat(String(s || "").replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Extract row arrays from a PASSPort dataJs file body.
 * Tolerates invalid JSON escapes by parsing line-by-line.
 */
export function parseJsDataArray(text, varname) {
  const src = String(text || "").replace(/^\uFEFF/, "");
  const re = new RegExp(`var\\s+${varname}\\s*=\\s*\\[`);
  const m = src.match(re);
  if (!m) return [];
  const start = m.index + m[0].length - 1;
  const body = src.slice(start);
  const end = body.lastIndexOf("];");
  if (end < 0) return [];
  const arrText = body.slice(0, end + 1);

  try {
    const parsed = JSON.parse(arrText.replace(/\uFEFF/g, ""));
    if (Array.isArray(parsed)) return parsed;
  } catch {
    /* fall through to line parser */
  }

  const rows = [];
  for (const line of arrText.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/,$/, "");
    if (!trimmed || trimmed === "[" || trimmed === "]") continue;
    try {
      rows.push(JSON.parse(trimmed.replace(/^\uFEFF/, "")));
    } catch {
      /* skip corrupt rows */
    }
  }
  return rows;
}

export function mapContractRow(cells) {
  if (!Array.isArray(cells) || cells.length < 10) return null;
  const get = (i) => cleanCell(cells[i]);
  const epin = get(1);
  if (!epin) return null;
  return {
    ctr_id: get(0),
    epin,
    epin_norm: normId(epin),
    contract_id: get(2) || null,
    title: get(3) || null,
    agency: get(4) || null,
    vendor: get(5) || null,
    program: get(6) || null,
    procurement_method: get(7) || null,
    contract_type: get(8) || null,
    status: get(9) || null,
    award_amount: parseMoney(get(10)),
    current_amount: parseMoney(get(11)),
    encumbered_amount: parseMoney(get(12)),
    paid_amount: parseMoney(get(13)),
    start_date: get(14) || null,
    end_date: get(15) || null,
    registration_date: get(16) || null,
    industry: get(17) || null,
  };
}

export function mapRfxRow(cells) {
  if (!Array.isArray(cells) || cells.length < 8) return null;
  const get = (i) => cleanCell(cells[i]);
  const epin = get(4);
  if (!epin) return null;
  return {
    rfp_id: get(0),
    bpm_id: get(1) || null,
    program: get(2) || null,
    industry: get(3) || null,
    epin,
    epin_norm: normId(epin),
    procurement_name: get(5) || null,
    agency: get(6) || null,
    rfx_status: get(7) || null,
    release_date: get(8) || null,
    due_date: get(9) || null,
    main_commodity: get(10) || null,
    procurement_method: get(11) || null,
  };
}

export function parseContractsDump(text) {
  return parseJsDataArray(text, "public_ctr_data")
    .map(mapContractRow)
    .filter(Boolean);
}

export function parseRfxDump(text) {
  return parseJsDataArray(text, "public_rfx_data")
    .map(mapRfxRow)
    .filter(Boolean);
}
