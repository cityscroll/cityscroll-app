import { createHash } from "node:crypto";

export const CHECKBOOK_NYCHA_SOURCE_SYSTEM = "checkbook_nycha_contracts";
export const CHECKBOOK_NYCHA_DATASET = "Contracts_NYCHA";
export const CHECKBOOK_NYCHA_ENDPOINT = "https://www.checkbooknyc.com/api";
export const CHECKBOOK_NYCHA_LANDING_PAGE = "https://www.checkbooknyc.com/contract-api";
export const CHECKBOOK_NYCHA_AGENCY_CODE = "162";
export const CHECKBOOK_NYCHA_AGENCY_ID = "agency:id:housing-authority";
export const CHECKBOOK_NYCHA_AGENCY_LABEL = "NYCHA";
export const CHECKBOOK_NYCHA_MIN_DELAY_MS = 1_100;

const text = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const xmlEscape = (value) => String(value ?? "").replace(/[<>&'\"]/g, (c) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;",
}[c]));

export function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

export function contractsNychaRequestXml({ from = 1, maxRecords = 999, contractId = null } = {}) {
  const criteria = contractId
    ? `<criteria><name>contract_id</name><type>value</type><value>${xmlEscape(contractId)}</value></criteria>`
    : "";
  return `<request><type_of_data>${CHECKBOOK_NYCHA_DATASET}</type_of_data><records_from>${from}</records_from>`
    + `<max_records>${maxRecords}</max_records><search_criteria>${criteria}</search_criteria></request>`;
}

export function checkbookNychaSuccess(xml) {
  return /<status>[\s\S]*?<result>\s*success\s*<\/result>[\s\S]*?<\/status>/i.test(String(xml || ""));
}

function decodeXml(value) {
  return String(value || "").replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity) => {
    const lower = entity.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return '"';
    if (lower === "apos") return "'";
    const point = lower.startsWith("#x") ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
    return Number.isFinite(point) ? String.fromCodePoint(point) : match;
  });
}

export function xmlField(xml, name) {
  const match = String(xml || "").match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i"));
  return match ? text(decodeXml(match[1].replace(/<[^>]+>/g, ""))) : "";
}

export function parseNychaTransactions(xml) {
  return [...String(xml || "").matchAll(/<transaction>([\s\S]*?)<\/transaction>/gi)].map((match) => {
    const raw = match[1];
    return {
      raw,
      contract_id: xmlField(raw, "contract_id"),
      record_type: xmlField(raw, "record_type"),
      purchase_order_type: xmlField(raw, "purchase_order_type"),
      vendor: xmlField(raw, "vendor"),
      pin: xmlField(raw, "pin"),
      purpose: xmlField(raw, "purpose"),
      contract_type: xmlField(raw, "contract_type"),
      award_method: xmlField(raw, "award_method"),
      industry: xmlField(raw, "industry"),
      start_date: xmlField(raw, "contract_start_date") || xmlField(raw, "start_date"),
      end_date: xmlField(raw, "contract_end_date") || xmlField(raw, "end_date"),
      approved_date: xmlField(raw, "approved_date"),
      current_amount: xmlField(raw, "contract_current_amount"),
      original_amount: xmlField(raw, "contract_original_amount"),
      invoiced_amount: xmlField(raw, "contract_invoiced_amount"),
      number_of_releases: xmlField(raw, "number_of_releases"),
      release_number: xmlField(raw, "release_number"),
      line_number: xmlField(raw, "line_number"),
    };
  });
}

function amount(value) {
  const number = Number(String(value || "").replace(/[$,]/g, ""));
  return Number.isFinite(number) ? number : null;
}

export function nychaOfficialUrl(contractId) {
  return `https://www.checkbooknyc.com/nycha_contract_details/agency/${CHECKBOOK_NYCHA_AGENCY_CODE}/datasource/checkbook_nycha/contract/${encodeURIComponent(contractId)}`;
}

export function normalizeNychaObservation(row, { rawResponse, retrievedAt, page = null } = {}) {
  const contractId = text(row?.contract_id);
  if (!contractId) throw new Error("Contracts_NYCHA observation requires contract_id");
  const rawHash = sha256(rawResponse || row?.raw || "");
  const sourceRecordId = [contractId, row.record_type || "Agreement", row.release_number, row.line_number]
    .filter(Boolean).join(":");
  const sourceValues = { ...row };
  delete sourceValues.raw;
  const normalized = {
    id: contractId,
    contract_id: contractId,
    pin: text(row.pin) || null,
    title: text(row.purpose) || null,
    vendor: text(row.vendor) || null,
    vendor_code: null,
    agency: CHECKBOOK_NYCHA_AGENCY_LABEL,
    agency_id: CHECKBOOK_NYCHA_AGENCY_ID,
    current: amount(row.current_amount),
    original: amount(row.original_amount),
    invoiced: amount(row.invoiced_amount),
    start: text(row.start_date) || null,
    end: text(row.end_date) || null,
    approved: text(row.approved_date) || null,
    contract_type: text(row.contract_type) || null,
    award_method: text(row.award_method) || null,
    industry: text(row.industry) || null,
    record_type: text(row.record_type) || null,
    observation_type: "contract",
    source_system: CHECKBOOK_NYCHA_SOURCE_SYSTEM,
    source_dataset: CHECKBOOK_NYCHA_DATASET,
    source_record_id: sourceRecordId,
    publisher_institution_id: "checkbooknyc",
    procuring_institution_id: CHECKBOOK_NYCHA_AGENCY_ID,
    source_agency_code: CHECKBOOK_NYCHA_AGENCY_CODE,
    source_agency_label: CHECKBOOK_NYCHA_AGENCY_LABEL,
    source_vendor_name: text(row.vendor) || null,
    source_vendor_code: null,
    identifiers: {
      contract_id: contractId,
      pin: text(row.pin) || null,
      release_number: text(row.release_number) || null,
      line_number: text(row.line_number) || null,
    },
    purpose: text(row.purpose) || null,
    amount: { value: amount(row.current_amount), currency: "USD", source_field: "contract_current_amount" },
    relevant_dates: {
      start_date: text(row.start_date) || null,
      end_date: text(row.end_date) || null,
      approved_date: text(row.approved_date) || null,
    },
    official_url: nychaOfficialUrl(contractId),
    retrieval_timestamp: retrievedAt || null,
    raw_response_hash: rawHash,
    raw_page: page,
    source_values: sourceValues,
  };
  return {
    ...normalized,
    raw_observation: {
      source_system: CHECKBOOK_NYCHA_SOURCE_SYSTEM,
      source_dataset: CHECKBOOK_NYCHA_DATASET,
      source_record_id: sourceRecordId,
      retrieved_at: retrievedAt || null,
      raw_response_hash: rawHash,
      raw_row: sourceValues,
    },
  };
}

export function checkDelay(previousAt, nextAt, minimumMs = CHECKBOOK_NYCHA_MIN_DELAY_MS) {
  if (previousAt == null || nextAt == null) return true;
  return Number(nextAt) - Number(previousAt) >= minimumMs;
}
