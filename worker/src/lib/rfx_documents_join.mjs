// PASSPort Public RFx package-document join recon.
//
// Measured 2026-07-30 (see site/data/passport_sources/ and
// site/data/source_contracts.json join_measurement on passport-public-rfx):
//
//   Kill-criterion universe (50 open Solicitation notices with PIN, most recent
//   start_date ≥ 2025-01-01):
//     EPIN↔PIN join 38% (19/50) — joining key works.
//     RFx document URL join **0%** (0/50) — public_rfx_data has no URL/document columns.
//
//   Full modern solicitation+PIN universe (start_date ≥ 2025-01-01):
//     EPIN↔PIN join 44.4% (653/1470).
//     RFx document URL join **0%** (0/1470).
//
// Companion public fills for package documents (same date):
//   OCP Current Solicitations (3khw-qi8f) document_links, start_date ≥ 2025-01-01: 0/1550.
//   City Record Online (dg92-zbpx) Solicitation document_links, same window: 0/1550.
//   Historical GetFile attachments exist on pre-2025 rows only.
//
// Verdict: below usefulness threshold (~30%) for RFx package-document URLs.
// Do not edge-materialize package docs from the RFx dump. Gap
// procurement-solicitation-documents is class (b) not_published, pointing at
// City Record GetFile as the logical home if the city releases attachments again.
//
// RFx metadata (due date, method, status, commodity) remains edge-materialized
// via passport_rfx / passport_join — this module is documents-only.

import { buildEpinIndex, joinPinToEpin } from "./passport_join.mjs";

/** Columns present on public_rfx_data rows after mapRfxRow (no document URLs). */
export const RFX_PUBLIC_COLUMNS = Object.freeze([
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
]);

export const CITY_RECORD_GETFILE_HOST = "a856-cityrecord.nyc.gov";
export const CITY_RECORD_GETFILE_PATH = "/Search/GetFile";
export const CITY_RECORD_GETFILE_URL = `https://${CITY_RECORD_GETFILE_HOST}${CITY_RECORD_GETFILE_PATH}`;
export const USEFULNESS_THRESHOLD = 0.3;

/**
 * Extract public document URLs from a parsed PASSPort RFx row.
 * Always empty on the public dataJs dump — kept pure so tests pin the schema gap.
 * @param {Record<string, unknown>|null|undefined} row
 * @returns {string[]}
 */
export function extractRfxDocumentUrls(row) {
  if (!row || typeof row !== "object") return [];
  const out = [];
  for (const value of Object.values(row)) {
    if (typeof value === "string" && /^https?:\/\//i.test(value.trim())) {
      out.push(value.trim());
    }
  }
  return out;
}

/**
 * True when a joined RFx row would fill the package-documents sub-slot.
 * @param {Record<string, unknown>|null|undefined} row
 */
export function rfxRowHasPackageDocuments(row) {
  return extractRfxDocumentUrls(row).length > 0;
}

/**
 * Build the package-document contract for one RFx row.
 *
 * The public RFx dump currently contains metadata but no package-document
 * columns. That is a meaningful not-published result, not an empty success:
 * callers get a stable status plus the historical City Record attachment home
 * without inventing a document URL. A future URL-bearing dump automatically
 * takes the matched branch and remains covered by the same contract.
 */
export function buildRfxPackageDocumentSurface(row, { requestId = null } = {}) {
  const urls = extractRfxDocumentUrls(row);
  if (urls.length) {
    return {
      status: "matched",
      source: "passport-public-rfx",
      urls,
      count: urls.length,
      city_record_getfile: CITY_RECORD_GETFILE_URL,
    };
  }
  return {
    status: "not_published",
    source: "city-record-getfile",
    urls: [],
    count: 0,
    reason: "public_rfx_data_has_no_document_urls",
    city_record_getfile: CITY_RECORD_GETFILE_URL,
    request_id: requestId ? String(requestId) : null,
  };
}

/**
 * Measure EPIN join and document-URL join for a notice universe against RFx rows.
 *
 * @param {Array<{ pin?: string }>} notices
 * @param {Array<{ epin?: string, epin_norm?: string } & Record<string, unknown>>} rfxRows
 * @returns {{
 *   total: number,
 *   epin_joined: number,
 *   epin_join_rate: number,
 *   document_url_joined: number,
 *   document_url_join_rate: number,
 *   usefulness_threshold: number,
 *   document_urls_useful: boolean,
 * }}
 */
export function measureRfxDocumentJoin(notices, rfxRows) {
  const list = Array.isArray(notices) ? notices : [];
  const rows = Array.isArray(rfxRows) ? rfxRows : [];
  const index = buildEpinIndex(rows.map((r) => r.epin_norm || r.epin));
  const byEpin = new Map();
  for (const r of rows) {
    const key = String(r.epin_norm || r.epin || "").toUpperCase();
    if (!key) continue;
    if (!byEpin.has(key)) byEpin.set(key, []);
    byEpin.get(key).push(r);
  }

  let epinJoined = 0;
  let docJoined = 0;
  for (const notice of list) {
    const join = joinPinToEpin(notice?.pin, index);
    if (!join) continue;
    epinJoined += 1;
    const matched = byEpin.get(join.epin) || [];
    if (matched.some(rfxRowHasPackageDocuments)) docJoined += 1;
  }

  const total = list.length;
  const epinRate = total ? epinJoined / total : 0;
  const docRate = total ? docJoined / total : 0;
  return {
    total,
    epin_joined: epinJoined,
    epin_join_rate: epinRate,
    document_url_joined: docJoined,
    document_url_join_rate: docRate,
    usefulness_threshold: USEFULNESS_THRESHOLD,
    document_urls_useful: docRate >= USEFULNESS_THRESHOLD,
  };
}

/**
 * Whether a URL is a City Record GetFile attachment (the historical package-doc home).
 * @param {string} url
 */
export function isCityRecordGetFileUrl(url) {
  try {
    const u = new URL(String(url || ""));
    return (
      u.hostname === CITY_RECORD_GETFILE_HOST
      && u.pathname.startsWith(CITY_RECORD_GETFILE_PATH)
    );
  } catch {
    return false;
  }
}
