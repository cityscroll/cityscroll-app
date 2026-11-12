// IRS Exempt Organizations Business Master File extract, New York (bulk CSV on irs.gov).
// The only register in this slice that carries an EIN and an NTEE code.

import { parseCsvRecords } from "./csv.mjs";
import { addressFrom, makeRecord } from "./read_contract.mjs";

export const IRS_REGISTER = "irs_eo_bmf_ny";
export const IRS_FILE_URL = "https://www.irs.gov/pub/irs-soi/eo_ny.csv";
export const IRS_LANDING_URL = "https://www.irs.gov/charities-non-profits/exempt-organizations-business-master-file-extract-eo-bmf";
export const IRS_INFO_SHEET_URL = "https://www.irs.gov/pub/foia/ig/tege/eo-info.pdf";

export const IRS_COLUMNS = Object.freeze([
  "EIN", "NAME", "ICO", "STREET", "CITY", "STATE", "ZIP", "GROUP", "SUBSECTION", "AFFILIATION",
  "CLASSIFICATION", "RULING", "DEDUCTIBILITY", "FOUNDATION", "ACTIVITY", "ORGANIZATION", "STATUS",
  "TAX_PERIOD", "ASSET_CD", "INCOME_CD", "FILING_REQ_CD", "PF_FILING_REQ_CD", "ACCT_PD",
  "ASSET_AMT", "INCOME_AMT", "REVENUE_AMT", "NTEE_CD", "SORT_NAME",
]);

// From the EO BMF information sheet (eo-info.pdf, "EXEMPT ORGANIZATION STATUS CODE").
export const IRS_STATUS_LABELS = Object.freeze({
  "01": "Unconditional Exemption",
  "02": "Conditional Exemption",
  "12": "Trust described in section 4947(a)(2) of the Internal Revenue Code",
  "25": "Organization terminating its private foundation status under section 507(b)(1)(B) of the Code",
});

const EIN_RE = /^\d{9}$/;

export function normalizeIrsRecord(values, { collected_at, ragged = false, row_index = null } = {}) {
  const raw = {};
  for (const c of IRS_COLUMNS) raw[c] = values[c] ?? "";
  const flags = [];
  if (ragged) flags.push("ragged_row");
  const ein = raw.EIN.trim();
  if (ein && !EIN_RE.test(ein)) flags.push("missing_record_id"); // an EIN that is not 9 digits is not usable as an id
  const status = raw.STATUS.trim();
  const label = IRS_STATUS_LABELS[status] ?? null;
  const rec = makeRecord({
    register: IRS_REGISTER,
    register_record_id: EIN_RE.test(ein) ? ein : "",
    name: raw.NAME,
    entity_class: status === "12" ? "other" : "not_for_profit",
    entity_type: raw.SUBSECTION.trim() ? `SUBSECTION ${raw.SUBSECTION.trim()}` : null,
    address: addressFrom({ street: raw.STREET, city: raw.CITY, state: raw.STATE, zip: raw.ZIP }),
    status: status || null,
    status_basis: label ? `EO status code ${status}: ${label}` : "EO status code as published",
    source_url: IRS_FILE_URL,
    collected_at,
    flags,
    published: {
      ein_as_published: ein,
      in_care_of: raw.ICO.trim() || null,
      group_exemption: raw.GROUP.trim() || null,
      subsection: raw.SUBSECTION.trim() || null,
      affiliation: raw.AFFILIATION.trim() || null,
      classification: raw.CLASSIFICATION.trim() || null,
      ruling: raw.RULING.trim() || null,
      deductibility: raw.DEDUCTIBILITY.trim() || null,
      foundation: raw.FOUNDATION.trim() || null,
      activity: raw.ACTIVITY.trim() || null,
      organization: raw.ORGANIZATION.trim() || null,
      status_label: label,
      tax_period: raw.TAX_PERIOD.trim() || null,
      asset_cd: raw.ASSET_CD.trim() || null,
      income_cd: raw.INCOME_CD.trim() || null,
      filing_req_cd: raw.FILING_REQ_CD.trim() || null,
      pf_filing_req_cd: raw.PF_FILING_REQ_CD.trim() || null,
      acct_pd: raw.ACCT_PD.trim() || null,
      asset_amt: raw.ASSET_AMT.trim() || null,
      income_amt: raw.INCOME_AMT.trim() || null,
      revenue_amt: raw.REVENUE_AMT.trim() || null,
      ntee_cd: raw.NTEE_CD.trim() || null,
      sort_name: raw.SORT_NAME.trim() || null,
    },
    raw,
  });
  if (row_index != null) rec.published.csv_row_index = row_index;
  return rec;
}

/** Parse the whole CSV. Fails closed on a header that is not the 28 documented columns. */
export function normalizeIrsCsv(text, { collected_at }) {
  const { header, records } = parseCsvRecords(text);
  const problems = [];
  if (header.length !== IRS_COLUMNS.length || header.some((h, i) => h !== IRS_COLUMNS[i])) {
    problems.push(`header is not the 28 documented columns: ${header.join(",").slice(0, 200)}`);
    return { ok: false, problems, records: [], row_count: 0, ragged_rows: 0 };
  }
  const out = records.map((r) => normalizeIrsRecord(r.values, { collected_at, ragged: r.ragged, row_index: r.row_index }));
  return { ok: true, problems, records: out, row_count: out.length, ragged_rows: records.filter((r) => r.ragged).length };
}

/** Per-field non-null (non-empty) counts over the raw CSV rows, for the receipt. */
export function nonNullCounts(records) {
  const counts = Object.fromEntries(IRS_COLUMNS.map((c) => [c, 0]));
  for (const r of records) for (const c of IRS_COLUMNS) if (String(r.raw[c] ?? "").trim() !== "") counts[c]++;
  return counts;
}
