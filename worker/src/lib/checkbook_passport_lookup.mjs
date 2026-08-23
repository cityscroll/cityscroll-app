/**
 * Checkbook NYC XML lookup for PASSPort-only corroboration.
 *
 * Contracts domain is keyed by PIN; Spending is keyed by contract_id.
 * Parsing stays on the existing Contracts/Spending parsers. The classifier
 * decides whether a hit is evidence, a related instrument, or unknown.
 */

import {
  checkbookSuccess,
  parseContractTransactions,
  parseSpendingTransactions,
} from "./checkbook_lifecycle.mjs";
import { classifyCheckbookPassportCorroboration } from "../../../site/checkbook_passport_corroboration.mjs";

const CHECKBOOK = "https://www.checkbooknyc.com/api";

function escXml(value) {
  return String(value).replace(/[<>&'"]/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;",
  }[char]));
}

export function checkbookContractsByPinRequestXml(pin, {
  status = "registered",
  from = 1,
  maxRecords = 25,
} = {}) {
  return `<request><type_of_data>Contracts</type_of_data><records_from>${from}</records_from><max_records>${maxRecords}</max_records><search_criteria>`
    + `<criteria><name>status</name><type>value</type><value>${escXml(status)}</value></criteria>`
    + `<criteria><name>category</name><type>value</type><value>expense</value></criteria>`
    + `<criteria><name>pin</name><type>value</type><value>${escXml(pin)}</value></criteria>`
    + `</search_criteria></request>`;
}

export function checkbookSpendingByContractIdRequestXml(contractId, {
  from = 1,
  maxRecords = 25,
} = {}) {
  return `<request><type_of_data>Spending</type_of_data><records_from>${from}</records_from><max_records>${maxRecords}</max_records><search_criteria>`
    + `<criteria><name>contract_id</name><type>value</type><value>${escXml(contractId)}</value></criteria>`
    + `</search_criteria></request>`;
}

export function parseCheckbookContractsLookup(xml) {
  if (!checkbookSuccess(xml)) return { ok: false, records: [] };
  return { ok: true, records: parseContractTransactions(xml) };
}

export function parseCheckbookSpendingLookup(xml) {
  if (!checkbookSuccess(xml)) return { ok: false, records: [] };
  return { ok: true, records: parseSpendingTransactions(xml) };
}

export function classifyPassportCheckbookXml(passport, xml) {
  const parsed = parseCheckbookContractsLookup(xml);
  if (!parsed.ok) {
    return classifyCheckbookPassportCorroboration({ passport, checkbookRows: [] });
  }
  return classifyCheckbookPassportCorroboration({
    passport,
    checkbookRows: parsed.records,
  });
}

export const CHECKBOOK_API_URL = CHECKBOOK;
