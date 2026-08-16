/** Pure adapter from canonical procurement SearchDocuments to Contracts Browse rows. */

import { admitSearchDocument } from "./search_document_contract.mjs";

const cleanContractSearchValue = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

function requestIdFromRefs(refs) {
  for (const ref of Array.isArray(refs) ? refs : []) {
    const match = cleanContractSearchValue(ref, 240).match(/^(?:notice|ocp_award):([A-Za-z0-9_-]{1,80})$/);
    if (match) return match[1];
  }
  return null;
}

function pinFromDocument(document) {
  const pin = cleanContractSearchValue(document?.object_ref, 320).replace(/^procurement:/, "");
  if (!pin || `procurement:${pin}` !== document?.object_ref) return null;
  try {
    const route = new URL(document.canonical_href, "https://cityscroll.org");
    return route.pathname === "/browse/contracts/"
      && route.searchParams.get("mode") === "award"
      && route.searchParams.get("q") === pin
      ? pin
      : null;
  } catch {
    return null;
  }
}

/** Recover the safe row shape already consumed by the Contracts list. */
export function contractSearchDocumentToMoneyRow(candidate = {}) {
  if (
    candidate?.outcome !== "indexed"
    || candidate?.object_type !== "procurement"
    || candidate?.domain !== "contracts"
    || candidate?.process_role !== "award"
  ) return null;
  const admitted = admitSearchDocument(candidate, { outcome: "indexed" });
  if (!admitted.document) return null;
  const document = admitted.document;
  const pin = pinFromDocument(document);
  const fallbackRequestId = requestIdFromRefs(document.source_observation_refs);
  if (!pin || !fallbackRequestId) return null;

  const carried = document.provenance?.browse_record;
  if (carried != null && (!carried || typeof carried !== "object" || Array.isArray(carried))) return null;
  const carriedPin = carried ? cleanContractSearchValue(carried.pin, 160) : pin;
  const carriedRequestId = carried ? cleanContractSearchValue(carried.request_id, 100) : fallbackRequestId;
  const validRefs = new Set(document.source_observation_refs.map((ref) => cleanContractSearchValue(ref, 240)));
  if (
    carriedPin !== pin
    || !/^[A-Za-z0-9_-]{1,80}$/.test(carriedRequestId)
    || (!validRefs.has(`notice:${carriedRequestId}`) && !validRefs.has(`ocp_award:${carriedRequestId}`))
  ) return null;

  return Object.freeze({
    request_id: carriedRequestId,
    start_date: cleanContractSearchValue(carried?.start_date, 40) || null,
    agency_name: cleanContractSearchValue(carried?.agency_name, 240) || null,
    type_of_notice_description: "Award",
    short_title: cleanContractSearchValue(carried?.short_title, 500) || document.title,
    pin,
    contract_amount: cleanContractSearchValue(carried?.contract_amount, 80) || null,
    vendor_name: cleanContractSearchValue(carried?.vendor_name, 240) || null,
    additional_description_1: document.summary,
    source_system: cleanContractSearchValue(carried?.source_system, 120) || document.source_family,
    search_document: document,
  });
}

/** Add query hits without replacing richer rows already carried by the resident snapshot. */
export function mergeContractSearchRows(baseRows = [], documents = []) {
  const rows = Array.isArray(baseRows) ? [...baseRows] : [];
  const seenRequestIds = new Set(rows.map((row) => cleanContractSearchValue(row?.request_id, 100)).filter(Boolean));
  for (const document of Array.isArray(documents) ? documents : []) {
    const row = contractSearchDocumentToMoneyRow(document);
    if (!row || seenRequestIds.has(row.request_id)) continue;
    seenRequestIds.add(row.request_id);
    rows.push(row);
  }
  return Object.freeze(rows);
}
